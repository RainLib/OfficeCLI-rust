use super::{resolve_part, slide_layout_part};
use crate::common::{package_error, MAX_CONTROL_BYTES};
use hcd_core::{
    pptx_design::{valid_master_part, valid_pptx_background, PptxSlideDesign},
    HcdError,
};
use oxml::StreamingOxmlArchive;
use roxmltree::{Document, Node};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
};

const PML: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DML: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";

#[derive(Default)]
pub(super) struct DesignCache {
    layouts: HashMap<String, Option<PptxSlideDesign>>,
    inheritance: HashMap<
        (String, super::inheritance::SlideColorMap),
        std::sync::Arc<super::inheritance::LayoutInheritance>,
    >,
}

pub(super) fn xml_part(
    archive: &mut StreamingOxmlArchive,
    name: &str,
) -> Result<Option<String>, HcdError> {
    if archive
        .entry(name)
        .is_none_or(|entry| entry.uncompressed_size > MAX_CONTROL_BYTES)
    {
        return Ok(None);
    }
    let bytes = archive
        .read_control_part(name, MAX_CONTROL_BYTES)
        .map_err(package_error)?;
    Ok(String::from_utf8(bytes).ok())
}

pub(super) fn related_part(
    archive: &mut StreamingOxmlArchive,
    owner: &str,
    relation: &str,
) -> Result<Option<String>, HcdError> {
    let Some((directory, name)) = owner.rsplit_once('/') else {
        return Ok(None);
    };
    let rels = format!("{directory}/_rels/{name}.rels");
    let Some(xml) = xml_part(archive, &rels)? else {
        return Ok(None);
    };
    let Ok(doc) = Document::parse(&xml) else {
        return Ok(None);
    };
    let Some(target) = doc
        .root_element()
        .children()
        .find(|node| {
            node.has_tag_name("Relationship")
                && node
                    .attribute("Type")
                    .is_some_and(|kind| kind.ends_with(relation))
                && node.attribute("TargetMode") != Some("External")
        })
        .and_then(|node| node.attribute("Target"))
    else {
        return Ok(None);
    };
    resolve_part(owner, target).map(Some)
}

fn child<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    node.children().find(|child| child.has_tag_name(name))
}

fn background<'a, 'input>(root: Node<'a, 'input>) -> Option<Node<'a, 'input>> {
    child(child(root, "cSld")?, "bg")
}

fn display_name(root: Node<'_, '_>, part: &str) -> String {
    child(root, "cSld")
        .and_then(|node| node.attribute("name"))
        .filter(|name| !name.is_empty())
        .or_else(|| {
            root.attribute("matchingName")
                .filter(|name| !name.is_empty())
        })
        .unwrap_or_else(|| {
            part.rsplit('/')
                .next()
                .unwrap_or(part)
                .trim_end_matches(".xml")
        })
        .chars()
        .take(160)
        .collect()
}

pub(super) fn color_of(
    color: Node<'_, '_>,
    theme: Option<Node<'_, '_>>,
    map: Option<Node<'_, '_>>,
    placeholder: Option<&str>,
) -> Option<String> {
    if color.children().any(|child| child.is_element()) {
        return None;
    }
    let rgb = match color.tag_name().name() {
        "srgbClr" => color.attribute("val")?,
        "sysClr" => color.attribute("lastClr")?,
        "schemeClr" => {
            let slot = color.attribute("val")?;
            if slot == "phClr" {
                return placeholder.map(str::to_owned);
            }
            let slot = map
                .and_then(|map| map.attribute(slot))
                .unwrap_or(match slot {
                    "bg1" => "lt1",
                    "bg2" => "lt2",
                    "tx1" => "dk1",
                    "tx2" => "dk2",
                    _ => slot,
                });
            let scheme = child(child(theme?, "themeElements")?, "clrScheme")?;
            let actual = child(scheme, slot)?
                .children()
                .find(|node| node.is_element())?;
            if actual.has_tag_name("schemeClr") {
                return None;
            }
            return color_of(actual, None, None, None);
        }
        _ => return None,
    };
    let color = format!("#{rgb}");
    valid_pptx_background(&color).then(|| color.to_ascii_lowercase())
}

fn solid_fill(
    fill: Node<'_, '_>,
    theme: Option<Node<'_, '_>>,
    map: Option<Node<'_, '_>>,
    placeholder: Option<&str>,
) -> Option<String> {
    if !fill.has_tag_name("solidFill") {
        return None;
    }
    let color = fill.children().find(|node| node.is_element())?;
    color_of(color, theme, map, placeholder)
}

fn background_color(
    bg: Node<'_, '_>,
    theme: Option<Node<'_, '_>>,
    map: Option<Node<'_, '_>>,
) -> Option<String> {
    if let Some(fill) = child(child(bg, "bgPr").unwrap_or(bg), "solidFill") {
        return solid_fill(fill, theme, map, None);
    }
    let reference = child(bg, "bgRef")?;
    let index = reference.attribute("idx")?.parse::<usize>().ok()?;
    let color = reference
        .children()
        .find(|node| node.is_element())
        .and_then(|value| color_of(value, theme, map, None));
    let style = child(child(theme?, "themeElements")?, "fmtScheme")?;
    let (list, offset) = if index >= 1001 {
        ("bgFillStyleLst", index - 1001)
    } else {
        ("fillStyleLst", index.checked_sub(1)?)
    };
    let fill = child(style, list)?
        .children()
        .filter(Node::is_element)
        .nth(offset)?;
    solid_fill(fill, theme, map, color.as_deref())
}

impl DesignCache {
    pub(super) fn inheritance(
        &mut self,
        archive: &mut StreamingOxmlArchive,
        design: &PptxSlideDesign,
        part: &str,
    ) -> Result<std::sync::Arc<super::inheritance::LayoutInheritance>, HcdError> {
        let slide_map = super::inheritance::SlideColorMap::read(archive, part)?;
        let key = (design.layout_part.clone(), slide_map);
        if let Some(cached) = self.inheritance.get(&key) {
            return Ok(cached.clone());
        }
        let data = std::sync::Arc::new(super::inheritance::LayoutInheritance::read(
            archive, design, &key.1,
        )?);
        // Retain a small working set even when a deck uses many custom layouts.
        if self.inheritance.len() >= 8 {
            self.inheritance.clear();
        }
        self.inheritance.insert(key, data.clone());
        Ok(data)
    }
    pub(super) fn slide(
        &mut self,
        archive: &mut StreamingOxmlArchive,
        part: &str,
    ) -> Result<Option<PptxSlideDesign>, HcdError> {
        let Some(layout) = slide_layout_part(archive, part)? else {
            return Ok(None);
        };
        if !self.layouts.contains_key(&layout) {
            self.layouts
                .insert(layout.clone(), read_layout(archive, &layout)?);
        }
        Ok(self.layouts.get(&layout).cloned().flatten())
    }
}

fn read_layout(
    archive: &mut StreamingOxmlArchive,
    layout_part: &str,
) -> Result<Option<PptxSlideDesign>, HcdError> {
    let Some(master_part) =
        related_part(archive, layout_part, "/slideMaster")?.filter(|part| valid_master_part(part))
    else {
        return Ok(None);
    };
    let Some(layout_xml) = xml_part(archive, layout_part)? else {
        return Ok(None);
    };
    let Some(master_xml) = xml_part(archive, &master_part)? else {
        return Ok(None);
    };
    let (Ok(layout), Ok(master)) = (Document::parse(&layout_xml), Document::parse(&master_xml))
    else {
        return Ok(None);
    };
    let layout = layout.root_element();
    let master = master.root_element();
    if !layout.has_tag_name((PML, "sldLayout")) || !master.has_tag_name((PML, "sldMaster")) {
        return Ok(None);
    }
    let theme_xml = if let Some(theme) = related_part(archive, &master_part, "/theme")? {
        xml_part(archive, &theme)?
    } else {
        None
    };
    let theme = theme_xml
        .as_deref()
        .and_then(|xml| Document::parse(xml).ok());
    let theme = theme.as_ref().map(Document::root_element);
    let master_map = child(master, "clrMap");
    let layout_map = child(layout, "clrMapOvr")
        .and_then(|node| child(node, "overrideClrMapping"))
        .or(master_map);
    let layout_background = background(layout);
    let master_color = match background(master) {
        Some(bg) => background_color(bg, theme, master_map),
        None => Some("#ffffff".into()),
    };
    let text_styles = super::inheritance::LayoutInheritance::from_roots(
        layout,
        master,
        theme,
        &super::inheritance::SlideColorMap::Master,
    )?
    .master_text_styles();
    Ok(Some(PptxSlideDesign {
        layout_part: layout_part.into(),
        layout_name: display_name(layout, layout_part),
        master_name: display_name(master, &master_part),
        master_part,
        master_color,
        layout_color: layout_background.and_then(|bg| background_color(bg, theme, layout_map)),
        layout_background: layout_background.is_some(),
        slide_background: false,
        master_text_styles: text_styles,
    }))
}

fn replace_background(xml: &mut String, color: &str) -> Result<(), HcdError> {
    let doc = Document::parse(xml).map_err(|cause| HcdError::InvalidBundle(cause.to_string()))?;
    let root = doc.root_element();
    if !root.has_tag_name((PML, "sldMaster")) || !valid_pptx_background(color) {
        return Err(HcdError::InvalidBundle(
            "invalid native slide master or RGB color".into(),
        ));
    }
    let common = child(root, "cSld")
        .filter(|node| node.tag_name().namespace() == Some(PML))
        .ok_or_else(|| HcdError::InvalidBundle("slide master common content is missing".into()))?;
    let replacing = if let Some(old) = child(common, "bg") {
        old.range()
    } else {
        let start = child(common, "spTree")
            .map(|node| node.range().start)
            .ok_or_else(|| HcdError::InvalidBundle("slide master shape tree is missing".into()))?;
        start..start
    };
    let rgb = &color[1..];
    let background = format!(
        r#"<p:bg xmlns:p="{PML}" xmlns:a="{DML}"><p:bgPr><a:solidFill><a:srgbClr val="{rgb}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>"#
    );
    xml.replace_range(replacing, &background);
    Ok(())
}

pub(super) fn write_masters(
    archive: &mut StreamingOxmlArchive,
    scratch: &Path,
    parts: &mut HashMap<String, PathBuf>,
    backgrounds: &BTreeMap<String, String>,
    text_styles: &hcd_core::pptx_design::PptxMasterTextStyles,
) -> Result<(), HcdError> {
    let masters = backgrounds
        .keys()
        .chain(text_styles.keys())
        .collect::<std::collections::BTreeSet<_>>();
    for (index, part) in masters.into_iter().enumerate() {
        if !valid_master_part(part) {
            return Err(HcdError::InvalidBundle("invalid native master path".into()));
        }
        let input = if let Some(previous) = parts.get(part) {
            Some(std::fs::read_to_string(previous)?)
        } else {
            xml_part(archive, part)?
        };
        let mut xml = input
            .ok_or_else(|| HcdError::InvalidBundle("native slide master is missing".into()))?;
        if let Some(color) = backgrounds.get(part) {
            replace_background(&mut xml, color)?;
        }
        if let Some(styles) = text_styles.get(part) {
            super::master_text::write_styles(&mut xml, styles)?;
        }
        let path = scratch.join(format!("master-background-{index}.xml"));
        std::fs::write(&path, xml)?;
        parts.insert(part.clone(), path);
    }
    Ok(())
}
