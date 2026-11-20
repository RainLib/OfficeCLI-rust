use crate::common::{effective_source_revisions, escape_attribute, package_error};
use hcd_core::{
    pptx_group::{
        DrawingTransform, GroupEdit, ObjectLocator, EDITED_ATTRIBUTE, GROUP_SOURCE,
        TRANSFORM_ATTRIBUTE,
    },
    Bundle, HcdError,
};
use oxml::{StreamingOxmlArchive, StreamingOxmlRewriter};
use roxmltree::{Document, Node};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fmt::Write,
    path::Path,
};

const P_NS: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const A16_NS: &str = "http://schemas.microsoft.com/office/drawing/2014/main";
const MAX_SLIDE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct GroupExport {
    slides: BTreeMap<String, SlideEdit>,
    removed: HashSet<String>,
}

#[derive(Default)]
struct SlideEdit {
    topology: Vec<GroupEdit>,
    transforms: HashMap<ObjectLocator, DrawingTransform>,
}

impl GroupExport {
    pub(crate) fn prepare(bundle: &Bundle, revision: Option<u64>) -> Result<Self, HcdError> {
        let head = bundle.manifest()?;
        let (manifest, _) = hcd_core::manifest_at_revision(bundle, &head, revision)?;
        let mut export = Self::default();
        let mut removed_slides = HashSet::new();
        let mut dirty_chunks = HashSet::new();
        let mut topology: HashMap<String, Vec<GroupEdit>> = HashMap::new();
        for revision in effective_source_revisions(bundle, manifest.revision)? {
            let record = bundle.revision(revision)?;
            for copy in &record.slide_copies {
                let edits = topology
                    .get(&copy.source_slide_part)
                    .into_iter()
                    .flatten()
                    .cloned()
                    .map(|edit| remap_group_edit(edit, &manifest.document_id, &copy.slide_part))
                    .collect();
                topology.insert(copy.slide_part.clone(), edits);
            }
            if record.pptx_scene_changed {
                dirty_chunks.extend(record.dirty_chunk_ids);
                for part in record.dirty_source_parts {
                    if valid_slide_part(&part) {
                        export.slides.entry(part).or_default();
                    }
                }
            }
            if let Some(edit) = record.slide_group_edit {
                if !valid_slide_part(&edit.slide_part) {
                    return Err(invalid("invalid group slide part"));
                }
                topology.entry(edit.slide_part).or_default().push(edit.edit);
            }
            export.removed.extend(record.removed_node_ids);
            removed_slides.extend(
                record
                    .slide_removals
                    .into_iter()
                    .map(|slide| slide.slide_part),
            );
        }
        for (part, edits) in topology {
            if !edits.is_empty() {
                export.slides.entry(part).or_default().topology = edits;
            }
        }
        export
            .slides
            .retain(|part, _| !removed_slides.contains(part));
        if export.slides.is_empty() {
            return Ok(export);
        }
        for number in 0..manifest.index_page_count {
            for chunk in bundle.read_index_page(&manifest, number)?.chunks {
                if chunk.region != "slide" || !dirty_chunks.contains(&chunk.chunk_id) {
                    continue;
                }
                let html = bundle.read_chunk_verified(&chunk)?;
                if !html.contains(EDITED_ATTRIBUTE) {
                    continue;
                }
                let doc = Document::parse(&html).map_err(xml_error)?;
                let section = doc.root_element();
                let Some(slide) = section
                    .attribute("data-hcd-source-part")
                    .and_then(|part| export.slides.get_mut(part))
                else {
                    continue;
                };
                for element in section
                    .descendants()
                    .filter(|node| node.attribute(EDITED_ATTRIBUTE) == Some("true"))
                {
                    let target = canonical_target(element)?;
                    let transform = DrawingTransform::decode(
                        element
                            .attribute(TRANSFORM_ATTRIBUTE)
                            .ok_or_else(|| invalid("missing group transform"))?,
                    )?;
                    if slide.transforms.insert(target, transform).is_some() {
                        return Err(invalid("duplicate edited drawing transform"));
                    }
                }
            }
        }
        export
            .slides
            .retain(|_, slide| !slide.topology.is_empty() || !slide.transforms.is_empty());
        Ok(export)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.slides.is_empty()
    }

    pub(crate) fn write(self, target: &Path) -> Result<usize, HcdError> {
        if self.is_empty() {
            return Ok(0);
        }
        let scratch = tempfile::tempdir()?;
        let mut archive = StreamingOxmlArchive::open(target).map_err(package_error)?;
        let mut paths = HashMap::new();
        for (index, (part, scene)) in self.slides.into_iter().enumerate() {
            let xml = archive
                .read_control_part(&part, MAX_SLIDE_BYTES)
                .map_err(package_error)?;
            let source =
                std::str::from_utf8(&xml).map_err(|_| invalid("slide XML is not UTF-8"))?;
            let rewritten = rewrite(source, scene, &self.removed)?;
            if rewritten != source {
                let path = scratch.path().join(format!("slide-{index}.xml"));
                std::fs::write(&path, rewritten)?;
                paths.insert(part, path);
            }
        }
        drop(archive);
        if paths.is_empty() {
            return Ok(0);
        }
        let rewritten = scratch.path().join("presentation.pptx");
        StreamingOxmlRewriter::rewrite(target, &rewritten, &paths, "ppt/presentation.xml")
            .map_err(package_error)?;
        std::fs::copy(rewritten, target)?;
        Ok(paths.len())
    }
}

fn remap_group_edit(edit: GroupEdit, document: &str, part: &str) -> GroupEdit {
    fn remap(locator: ObjectLocator, document: &str, part: &str) -> ObjectLocator {
        match locator {
            ObjectLocator::Created(id) => ObjectLocator::Created(hcd_core::stable_node_id(&[
                document,
                part,
                "slide-copy-node",
                &id,
            ])),
            native => native,
        }
    }
    match edit {
        GroupEdit::Create {
            id,
            members,
            transform,
        } => GroupEdit::Create {
            id: hcd_core::stable_node_id(&[document, part, "slide-copy-node", &id]),
            members: members
                .into_iter()
                .map(|item| remap(item, document, part))
                .collect(),
            transform,
        },
        GroupEdit::Ungroup { group } => GroupEdit::Ungroup {
            group: remap(group, document, part),
        },
    }
}

fn valid_slide_part(part: &str) -> bool {
    part.strip_prefix("ppt/slides/")
        .and_then(|part| part.strip_suffix(".xml"))
        .is_some_and(|name| {
            !name.is_empty() && !name.contains(['/', '\\']) && name != "." && name != ".."
        })
}

fn canonical_target(element: Node<'_, '_>) -> Result<ObjectLocator, HcdError> {
    if let Some(id) = [GROUP_SOURCE, "data-hcd-shape-id", "data-hcd-picture-id"]
        .iter()
        .find_map(|&attribute| element.attribute(attribute))
    {
        return id
            .parse::<u32>()
            .ok()
            .filter(|id| *id > 0)
            .map(ObjectLocator::Native)
            .ok_or_else(|| invalid("invalid source drawing ID"));
    }
    let id = element
        .attribute("data-hcd-id")
        .or_else(|| {
            element
                .descendants()
                .find_map(|child| child.attribute("data-hcd-id"))
        })
        .filter(|id| hcd_core::pptx_animation::valid_authored_target(id))
        .ok_or_else(|| invalid("missing authored drawing ID"))?;
    Ok(ObjectLocator::Created(id.into()))
}

struct Item<'a> {
    source: Option<Node<'a, 'a>>,
    native_id: Option<u32>,
    authored_id: Option<String>,
    group: Option<Group<'a>>,
    moved: bool,
}

struct Group<'a> {
    children: Vec<Item<'a>>,
    created_transform: Option<DrawingTransform>,
}

impl<'a> Item<'a> {
    fn read(node: Node<'a, 'a>) -> Self {
        let properties = node
            .children()
            .find(|child| {
                child.is_element()
                    && matches!(
                        child.tag_name().name(),
                        "nvSpPr" | "nvPicPr" | "nvGrpSpPr" | "nvGraphicFramePr" | "nvCxnSpPr"
                    )
            })
            .and_then(|non_visual| child(non_visual, "cNvPr"));
        let native_id = properties
            .and_then(|property| property.attribute("id"))
            .and_then(|id| id.parse().ok());
        let authored_id = properties
            .and_then(|property| {
                property
                    .descendants()
                    .find(|element| element.has_tag_name((A16_NS, "creationId")))
            })
            .and_then(|node| node.attribute("id"))
            .map(|guid| {
                format!(
                    "n_{}",
                    guid.trim_matches(['{', '}'])
                        .replace('-', "")
                        .to_ascii_lowercase()
                )
            });
        let group = node.has_tag_name("grpSp").then(|| Group {
            children: drawables(node).map(Self::read).collect(),
            created_transform: None,
        });
        Self {
            source: Some(node),
            native_id,
            authored_id,
            group,
            moved: false,
        }
    }

    fn matches(&self, target: &ObjectLocator) -> bool {
        match target {
            ObjectLocator::Native(id) => self.native_id == Some(*id),
            ObjectLocator::Created(id) => self.authored_id.as_ref() == Some(id),
        }
    }

    fn take_transform(
        &self,
        transforms: &mut HashMap<ObjectLocator, DrawingTransform>,
    ) -> Option<DrawingTransform> {
        self.native_id
            .and_then(|id| transforms.remove(&ObjectLocator::Native(id)))
            .or_else(|| {
                self.authored_id
                    .as_ref()
                    .and_then(|id| transforms.remove(&ObjectLocator::Created(id.clone())))
            })
    }

    fn render(
        &self,
        xml: &str,
        out: &mut String,
        transforms: &mut HashMap<ObjectLocator, DrawingTransform>,
        shape_tree: Node<'a, 'a>,
    ) -> Result<(), HcdError> {
        let transform = self.take_transform(transforms);
        match (&self.group, self.source) {
            (Some(group), Some(source)) => {
                if let Some((first, last)) = drawable_range(source) {
                    let prefix =
                        patched_drawing(xml, source, source.range().start..first, transform)?;
                    append_element(out, &prefix, self.moved.then_some(source), shape_tree);
                    let mut previous = first;
                    for item in &group.children {
                        let range = item
                            .source
                            .ok_or_else(|| invalid("original group member has no source"))?
                            .range();
                        out.push_str(&xml[previous..range.start]);
                        item.render(xml, out, transforms, shape_tree)?;
                        previous = range.end;
                    }
                    out.push_str(&xml[last..source.range().end]);
                } else {
                    let markup = patched_drawing(xml, source, source.range(), transform)?;
                    append_element(out, &markup, self.moved.then_some(source), shape_tree);
                }
            }
            (Some(group), None) => {
                let numeric = self
                    .native_id
                    .ok_or_else(|| invalid("missing group drawing ID"))?;
                let id = self
                    .authored_id
                    .as_deref()
                    .ok_or_else(|| invalid("missing authored group identity"))?;
                let pose = transform
                    .or(group.created_transform)
                    .ok_or_else(|| invalid("missing authored group transform"))?;
                let xmlns = shape_tree.tag_name().namespace().unwrap_or(P_NS);
                let creation = super::animations::creation_id_xml(id);
                let xfrm = write_transform(pose, A_NS);
                write!(out, "<p:grpSp xmlns:p=\"{xmlns}\"><p:nvGrpSpPr><p:cNvPr id=\"{numeric}\" name=\"Group {numeric}\">{creation}</p:cNvPr><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>{xfrm}</p:grpSpPr>").expect("string formatter");
                for item in &group.children {
                    item.render(xml, out, transforms, shape_tree)?;
                }
                out.push_str("</p:grpSp>");
            }
            (None, Some(source)) => {
                let markup = patched_drawing(xml, source, source.range(), transform)?;
                append_element(out, &markup, self.moved.then_some(source), shape_tree);
            }
            (None, None) => return Err(invalid("drawing has no native element")),
        }
        Ok(())
    }
}

fn rewrite(xml: &str, mut slide: SlideEdit, removed: &HashSet<String>) -> Result<String, HcdError> {
    let doc = Document::parse(xml).map_err(xml_error)?;
    let root = doc.root_element();
    let tree = child(root, "cSld")
        .and_then(|slide| child(slide, "spTree"))
        .ok_or_else(|| invalid("slide has no native shape tree"))?;
    let mut max_id = root
        .descendants()
        .filter(|node| node.has_tag_name("cNvPr"))
        .filter_map(|node| node.attribute("id")?.parse::<u32>().ok())
        .max()
        .unwrap_or(1);
    let mut items: Vec<_> = drawables(tree).map(Item::read).collect();
    for edit in slide.topology {
        match edit {
            GroupEdit::Create {
                id,
                members,
                transform,
            } => {
                if !hcd_core::pptx_animation::valid_authored_target(&id)
                    || !(2..=64).contains(&members.len())
                    || items
                        .iter()
                        .any(|item| item.authored_id.as_ref() == Some(&id))
                {
                    return Err(invalid("invalid authored group identity or membership"));
                }
                let slots = members
                    .iter()
                    .map(|member| {
                        if let Some(index) = items.iter().position(|item| item.matches(member)) {
                            return Ok(Some(index));
                        }
                        if let ObjectLocator::Created(id) = member {
                            if removed.contains(id) {
                                return Ok(None);
                            }
                        }
                        Err(invalid("group member is missing from the native slide"))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let slot_set: HashSet<_> = slots.iter().flatten().copied().collect();
                if slot_set.len() != slots.iter().flatten().count()
                    || !transform.valid()
                    || transform.children.is_none()
                {
                    return Err(invalid("invalid native group membership"));
                }
                let highest = slot_set.iter().copied().max().unwrap_or(items.len());
                let insertion = highest - slot_set.iter().filter(|&&slot| slot < highest).count();
                let mut children = HashMap::new();
                let mut remaining = Vec::new();
                for (index, item) in items.into_iter().enumerate() {
                    if slot_set.contains(&index) {
                        children.insert(index, item);
                    } else {
                        remaining.push(item);
                    }
                }
                let children = slots
                    .into_iter()
                    .flatten()
                    .filter_map(|index| children.remove(&index))
                    .collect();
                max_id = max_id
                    .checked_add(1)
                    .ok_or_else(|| invalid("native drawing IDs exhausted"))?;
                let group = Item {
                    source: None,
                    native_id: Some(max_id),
                    authored_id: Some(id),
                    group: Some(Group {
                        children,
                        created_transform: Some(transform),
                    }),
                    moved: false,
                };
                remaining.insert(insertion, group);
                items = remaining;
            }
            GroupEdit::Ungroup { group } => {
                let index = items
                    .iter()
                    .position(|item| item.matches(&group))
                    .ok_or_else(|| invalid("group is missing from native slide"))?;
                let item = items.remove(index);
                if item.source.is_some() && item.native_id.is_some_and(|id| referenced(root, id)) {
                    return Err(HcdError::Unsupported(
                        "the native group is targeted by an animation or connector".into(),
                    ));
                }
                let group = item
                    .group
                    .ok_or_else(|| invalid("ungroup target is not a native group"))?;
                items.splice(
                    index..index,
                    group.children.into_iter().map(|mut child| {
                        child.moved = true;
                        child
                    }),
                );
            }
        }
    }
    let Some((first, last)) = drawable_range(tree) else {
        return Err(invalid("group source slide has no drawing objects"));
    };
    let mut output = String::with_capacity(xml.len());
    output.push_str(&xml[..first]);
    for item in items {
        item.render(xml, &mut output, &mut slide.transforms, tree)?;
    }
    output.push_str(&xml[last..]);
    if !slide.transforms.is_empty() {
        return Err(invalid("edited transform has no matching native drawing"));
    }
    Document::parse(&output).map_err(xml_error)?;
    Ok(output)
}

fn referenced(slide: Node<'_, '_>, id: u32) -> bool {
    slide.descendants().any(|node| {
        let attr = match node.tag_name().name() {
            "spTgt" | "bldP" | "bldGraphic" | "bldDgm" | "bldOleChart" => "spid",
            "stCxn" | "endCxn" => "id",
            _ => return false,
        };
        node.attribute(attr).and_then(|value| value.parse().ok()) == Some(id)
    })
}

fn child<'a>(parent: Node<'a, 'a>, name: &str) -> Option<Node<'a, 'a>> {
    parent.children().find(|child| child.has_tag_name(name))
}

fn drawables<'a>(node: Node<'a, 'a>) -> impl Iterator<Item = Node<'a, 'a>> {
    node.children().filter(|node| {
        node.is_element() && !matches!(node.tag_name().name(), "nvGrpSpPr" | "grpSpPr" | "extLst")
    })
}

fn drawable_range(node: Node<'_, '_>) -> Option<(usize, usize)> {
    let mut children = drawables(node);
    let first = children.next()?.range();
    let last = children
        .last()
        .map(|node| node.range().end)
        .unwrap_or(first.end);
    Some((first.start, last))
}

fn patched_drawing(
    xml: &str,
    node: Node<'_, '_>,
    range: std::ops::Range<usize>,
    transform: Option<DrawingTransform>,
) -> Result<String, HcdError> {
    let Some(transform) = transform else {
        return Ok(xml[range].into());
    };
    let properties = child(
        node,
        if transform.children.is_some() {
            "grpSpPr"
        } else {
            "spPr"
        },
    )
    .ok_or_else(|| invalid("native drawing has no geometry properties"))?;
    let xfrm =
        child(properties, "xfrm").ok_or_else(|| invalid("native drawing has no transform"))?;
    let coordinates = xfrm.range();
    if coordinates.start < range.start || coordinates.end > range.end {
        return Err(invalid("native drawing geometry is outside its properties"));
    }
    let namespace = xfrm.tag_name().namespace().unwrap_or(A_NS);
    Ok(format!(
        "{}{}{}",
        &xml[range.start..coordinates.start],
        write_transform(transform, namespace),
        &xml[coordinates.end..range.end]
    ))
}

fn write_transform(transform: DrawingTransform, namespace: &str) -> String {
    let rect = transform.frame;
    let mut xml = format!("<a:xfrm xmlns:a=\"{namespace}\" rot=\"{}\" flipH=\"{}\" flipV=\"{}\"><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/>", transform.rotation, u8::from(transform.flip_h), u8::from(transform.flip_v), rect.x, rect.y, rect.width, rect.height);
    if let Some(rect) = transform.children {
        write!(
            xml,
            "<a:chOff x=\"{}\" y=\"{}\"/><a:chExt cx=\"{}\" cy=\"{}\"/>",
            rect.x, rect.y, rect.width, rect.height
        )
        .expect("string formatter");
    }
    xml.push_str("</a:xfrm>");
    xml
}

fn append_element(
    output: &mut String,
    markup: &str,
    moved: Option<Node<'_, '_>>,
    tree: Node<'_, '_>,
) {
    let Some(source) = moved else {
        output.push_str(markup);
        return;
    };
    let end = markup
        .find(|character: char| character.is_whitespace() || character == '>' || character == '/')
        .unwrap_or(markup.len());
    let opening = markup
        .split_once('>')
        .map_or(markup, |(opening, _)| opening);
    output.push_str(&markup[..end]);
    for namespace in source.namespaces() {
        let prefix = namespace.name();
        if prefix == Some("xml")
            || tree
                .namespaces()
                .iter()
                .any(|known| known.name() == prefix && known.uri() == namespace.uri())
        {
            continue;
        }
        let attribute =
            prefix.map_or_else(|| "xmlns".to_string(), |prefix| format!("xmlns:{prefix}"));
        if !opening
            .split_ascii_whitespace()
            .any(|part| part.starts_with(&format!("{attribute}=")))
        {
            write!(
                output,
                " {attribute}=\"{}\"",
                escape_attribute(namespace.uri())
            )
            .expect("string formatter");
        }
    }
    output.push_str(&markup[end..]);
}

fn invalid(message: &str) -> HcdError {
    HcdError::InvalidBundle(message.into())
}
fn xml_error(error: roxmltree::Error) -> HcdError {
    HcdError::InvalidBundle(format!("slide drawing XML: {error}"))
}
