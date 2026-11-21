//! Source-backed placement of mapped DrawingML picture objects.
use super::*;
use hcd_core::{DocxPictureLayout, DocxPictureWrap, DocxPictureWrapSide};
use roxmltree::{Document, Node};

const WP: &str = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC: &str = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
pub(super) const BODY_PART: &str = "word/document.xml";
const DISTANCES: [&str; 4] = ["distT", "distR", "distB", "distL"];

pub(super) fn layouts(
    bundle: &Bundle,
    manifest: &HcdManifest,
) -> Result<BTreeMap<u32, DocxPictureLayout>, HcdError> {
    let mut layouts = BTreeMap::new();
    if manifest.revision == 0 {
        return Ok(layouts);
    }
    for page in 0..manifest.index_page_count {
        for chunk in bundle.read_index_page(manifest, page)?.chunks {
            let map = bundle.read_map(&chunk)?;
            if !map
                .entries
                .iter()
                .any(|entry| entry.source.part == BODY_PART && entry.source.node_kind == "image")
            {
                continue;
            }
            let html = bundle.read_chunk(&chunk)?;
            if !html.contains("data-hcd-docx-picture-layout=") {
                continue;
            }
            let images = hcd_core::extract_html_image_nodes(&html)?;
            for entry in &map.entries {
                let Some(image) = images.get(&entry.node_id) else {
                    continue;
                };
                let Some(layout) = image.docx_picture_layout.clone() else {
                    continue;
                };
                let id = image.docx_drawing_id.ok_or_else(|| {
                    HcdError::InvalidBundle("Word picture layout is missing its drawing ID".into())
                })?;
                if entry.source.part != BODY_PART
                    || entry.source.node_kind != "image"
                    || entry.source.created_in_hcd
                    || layouts.insert(id, layout).is_some()
                {
                    return Err(HcdError::InvalidBundle(
                        "Word picture layout has an ambiguous source".into(),
                    ));
                }
            }
        }
    }
    Ok(layouts)
}

pub(super) fn read_body(source: &Path) -> Result<String, HcdError> {
    let mut archive = StreamingOxmlArchive::open(source).map_err(package_error)?;
    let bytes = archive
        .read_control_part(BODY_PART, 64 * 1024 * 1024)
        .map_err(package_error)?;
    String::from_utf8(bytes).map_err(|error| HcdError::InvalidBundle(error.to_string()))
}

fn parse(xml: &str) -> Result<Document<'_>, HcdError> {
    Document::parse(xml)
        .map_err(|error| HcdError::InvalidBundle(format!("Word drawing XML: {error}")))
}

fn picture<'a, 'input>(doc: &'a Document<'input>, id: u32) -> Result<Node<'a, 'input>, HcdError> {
    let mut matches = doc.root().descendants().filter(|node| {
        node.has_tag_name((WP, "docPr"))
            && node
                .attribute("id")
                .and_then(|value| value.parse::<u32>().ok())
                == Some(id)
    });
    let result = matches
        .next()
        .and_then(|node| node.parent())
        .filter(|parent| {
            (parent.has_tag_name((WP, "inline")) || parent.has_tag_name((WP, "anchor")))
                && parent
                    .parent()
                    .is_some_and(|drawing| drawing.has_tag_name((W, "drawing")))
                && parent
                    .ancestors()
                    .any(|ancestor| ancestor.has_tag_name((W, "body")))
        })
        .filter(|parent| {
            let raster = parent
                .children()
                .find(|child| child.has_tag_name((A, "graphic")))
                .and_then(|graphic| {
                    graphic
                        .children()
                        .find(|child| child.has_tag_name((A, "graphicData")))
                })
                .filter(|data| data.attribute("uri") == Some(PIC))
                .and_then(|data| {
                    data.children()
                        .find(|child| child.has_tag_name((PIC, "pic")))
                });
            raster.is_some_and(|image| {
                let blips: Vec<_> = image
                    .descendants()
                    .filter(|child| child.has_tag_name((A, "blip")))
                    .collect();
                matches!(blips.as_slice(), [blip] if blip.attribute((REL, "embed")).is_some())
            }) && wp_child(*parent, "extent").is_some()
        });
    if result.is_none() || matches.next().is_some() {
        return Err(HcdError::Unsupported(format!(
            "Word drawing {id} is not a uniquely mapped embedded body picture"
        )));
    }
    Ok(result.expect("picture has been checked"))
}

pub fn validate_picture_target(
    bundle: &Bundle,
    source: &Path,
    node_id: &str,
    layout: Option<&DocxPictureLayout>,
) -> Result<(), HcdError> {
    let manifest = bundle.manifest()?;
    if manifest.source.format != "docx" || hash_file(source)? != manifest.source.sha256 {
        return Err(HcdError::SourceMismatch(
            "Word picture needs its original DOCX".into(),
        ));
    }
    let image = hcd_core::get_image_node(bundle, node_id)?;
    let id = image
        .node
        .docx_drawing_id
        .filter(|_| image.node.source.part == BODY_PART && !image.node.source.created_in_hcd)
        .ok_or_else(|| HcdError::Unsupported("Word picture needs an original drawing ID".into()))?;
    let xml = read_body(source)?;
    let doc = parse(&xml)?;
    let node = picture(&doc, id)?;
    if let Some(layout) = layout {
        hcd_core::validate_docx_picture_layout(layout)?;
        placement_xml(&xml, node, layout)?;
    }
    Ok(())
}

fn wp_child<'a, 'input>(node: Node<'a, 'input>, local: &str) -> Option<Node<'a, 'input>> {
    node.children()
        .find(|child| child.has_tag_name((WP, local)))
}

fn wrap_child<'a, 'input>(node: Node<'a, 'input>) -> Option<Node<'a, 'input>> {
    node.children().find(|child| {
        child.is_element()
            && child.tag_name().namespace() == Some(WP)
            && matches!(
                child.tag_name().name(),
                "wrapNone" | "wrapSquare" | "wrapTopAndBottom" | "wrapTight" | "wrapThrough"
            )
    })
}

fn opening(raw: &str) -> Result<BytesStart<'_>, HcdError> {
    let mut reader = Reader::from_str(raw);
    match reader
        .read_event()
        .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
    {
        Event::Start(start) | Event::Empty(start) => Ok(start),
        _ => Err(HcdError::InvalidBundle(
            "Word drawing has no start tag".into(),
        )),
    }
}

fn replace_start(
    start: &BytesStart<'_>,
    name: &str,
    omit: impl Fn(&[u8]) -> bool,
    attributes: &[(String, String)],
) -> Result<String, HcdError> {
    let mut result = BytesStart::new(name);
    for attr in start.attributes() {
        let attr = attr.map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
        if !omit(attr.key.as_ref()) {
            result.push_attribute(attr);
        }
    }
    for (key, value) in attributes {
        result.push_attribute((key.as_str(), value.as_str()));
    }
    let text = std::str::from_utf8(result.as_ref())
        .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
    Ok(format!("<{text}>"))
}

fn placement_xml(
    xml: &str,
    node: Node<'_, '_>,
    layout: &DocxPictureLayout,
) -> Result<String, HcdError> {
    use DocxPictureWrap::*;
    let anchored = node.has_tag_name((WP, "anchor"));
    if !anchored && layout.wrap == Inline {
        return Ok(xml[node.range()].to_owned());
    }
    let raw = opening(&xml[node.range()])?;
    let name = raw.name();
    let prefix = std::str::from_utf8(name.as_ref())
        .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
        .split_once(':')
        .map(|(prefix, _)| format!("{prefix}:"))
        .unwrap_or_default();
    let inline = layout.wrap == Inline;
    let name = format!("{prefix}{}", if inline { "inline" } else { "anchor" });
    let wrap = wrap_child(node);
    let mut attributes = Vec::<(String, String)>::new();
    if !inline {
        let changed_position = layout.horizontal_alignment.is_some()
            || layout.horizontal_offset_emu.is_some()
            || layout.vertical_offset_emu.is_some();
        for (key, fallback) in [
            ("simplePos", "0"),
            ("relativeHeight", "0"),
            ("locked", "0"),
            ("layoutInCell", "1"),
            ("allowOverlap", "1"),
        ] {
            let keep = key != "simplePos" || !changed_position;
            attributes.push((
                key.into(),
                node.attribute(key)
                    .filter(|_| keep)
                    .unwrap_or(fallback)
                    .into(),
            ));
        }
        attributes.push((
            "behindDoc".into(),
            if layout.wrap == Behind { "1" } else { "0" }.into(),
        ));
        for name in DISTANCES {
            if let Some(value) = layout.text_distance_emu.map(|n| n.to_string()).or_else(|| {
                wrap.and_then(|wrap| wrap.attribute(name))
                    .or(node.attribute(name))
                    .map(str::to_owned)
            }) {
                attributes.push((name.into(), value));
            }
        }
    }
    let mut output = replace_start(
        &raw,
        &name,
        |key| {
            matches!(
                key,
                b"simplePos"
                    | b"relativeHeight"
                    | b"locked"
                    | b"layoutInCell"
                    | b"allowOverlap"
                    | b"behindDoc"
            ) || (inline && key == b"hidden")
                || (!inline && DISTANCES.iter().any(|name| key == name.as_bytes()))
        },
        &attributes,
    )?;
    if !inline {
        if let Some(simple) = wp_child(node, "simplePos") {
            output.push_str(&xml[simple.range()]);
        } else {
            output.push_str(&format!("<{prefix}simplePos x=\"0\" y=\"0\"/>"));
        }
        if let Some(align) = layout.horizontal_alignment {
            output.push_str(&format!("<{prefix}positionH relativeFrom=\"column\"><{prefix}align>{}</{prefix}align></{prefix}positionH>", align.as_str()));
        } else if let Some(x) = layout.horizontal_offset_emu {
            output.push_str(&offset_xml(&prefix, "H", "column", x));
        } else if let Some(position) = wp_child(node, "positionH") {
            output.push_str(&xml[position.range()]);
        } else {
            output.push_str(&offset_xml(&prefix, "H", "column", 0));
        }
        if let Some(y) = layout.vertical_offset_emu {
            output.push_str(&offset_xml(&prefix, "V", "paragraph", y));
        } else if let Some(position) = wp_child(node, "positionV") {
            output.push_str(&xml[position.range()]);
        } else {
            output.push_str(&offset_xml(&prefix, "V", "paragraph", 0));
        }
    }
    for label in ["extent", "effectExtent"] {
        if let Some(child) = wp_child(node, label) {
            output.push_str(&xml[child.range()]);
        }
    }
    if !inline {
        let name = match layout.wrap {
            Square => "wrapSquare",
            TopAndBottom => "wrapTopAndBottom",
            _ => "wrapNone",
        };
        let effect = wrap.and_then(|wrap| wp_child(wrap, "effectExtent"));
        let side = layout
            .wrap_side
            .map(DocxPictureWrapSide::as_str)
            .or(wrap
                .and_then(|wrap| wrap.attribute("wrapText"))
                .filter(|side| matches!(*side, "left" | "right" | "bothSides" | "largest")))
            .unwrap_or("bothSides");
        output.push_str(&format!("<{prefix}{name}"));
        if layout.wrap == Square {
            output.push_str(&format!(" wrapText=\"{side}\""));
        }
        if let Some(effect) = effect.filter(|_| matches!(layout.wrap, Square | TopAndBottom)) {
            output.push('>');
            output.push_str(&xml[effect.range()]);
            output.push_str(&format!("</{prefix}{name}>"));
        } else {
            output.push_str("/>");
        }
    }
    for child in node.children().filter(|child| child.is_element()) {
        let tag = child.tag_name();
        if tag.namespace() == Some(WP)
            && matches!(
                tag.name(),
                "simplePos"
                    | "positionH"
                    | "positionV"
                    | "extent"
                    | "effectExtent"
                    | "wrapNone"
                    | "wrapSquare"
                    | "wrapTopAndBottom"
                    | "wrapTight"
                    | "wrapThrough"
            )
            || inline && matches!(tag.name(), "sizeRelH" | "sizeRelV")
        {
            continue;
        }
        output.push_str(&xml[child.range()]);
    }
    output.push_str(&format!("</{name}>"));
    Ok(output)
}

fn offset_xml(prefix: &str, axis: &str, relative: &str, value: i32) -> String {
    format!("<{prefix}position{axis} relativeFrom=\"{relative}\"><{prefix}posOffset>{value}</{prefix}posOffset></{prefix}position{axis}>")
}

pub(super) fn rewrite(
    xml: &str,
    layouts: &BTreeMap<u32, DocxPictureLayout>,
) -> Result<String, HcdError> {
    let doc = parse(xml)?;
    let mut updates = Vec::with_capacity(layouts.len());
    for (&id, layout) in layouts {
        let node = picture(&doc, id)?;
        updates.push((node.range(), placement_xml(xml, node, layout)?));
    }
    updates.sort_unstable_by_key(|(range, _)| std::cmp::Reverse(range.start));
    let mut output = xml.to_owned();
    for (range, replacement) in updates {
        output.replace_range(range, &replacement);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_picture_layout_and_selective_restore_preserve_the_other_drawing() {
        let temp = tempfile::tempdir().unwrap();
        let source =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/word/pdfToWord.docx");
        let canonical = temp.path().join("source.hcd");
        crate::import_docx(
            &source,
            &canonical,
            &crate::ImportOptions::new("picture-test"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&canonical).unwrap();
        let original = read_body(&source).unwrap();
        let tree = parse(&original).unwrap();
        let initial = picture(&tree, 29).unwrap();
        let other = &original[picture(&tree, 1684).unwrap().range()];
        let original_graphic = initial
            .children()
            .find(|child| child.has_tag_name((A, "graphic")))
            .unwrap();
        let image = hcd_core::extract_image_page(&bundle, None, 100)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.node.docx_drawing_id == Some(29))
            .unwrap()
            .node;
        let apply = |revision, hash: &str, layout| {
            let patch = serde_json::from_value(json!({
                "schemaVersion": "hcd-patch/57",
                "documentId": bundle.manifest().unwrap().document_id,
                "patchId": format!("picture-{revision}"),
                "baseRevision": revision,
                "operations": [{"op":"docx.picture.layout", "nodeId":image.node_id, "layout":layout,
                    "precondition":{"visualHash":hash}}],
            }))
            .unwrap();
            hcd_core::apply_patch(&bundle, &patch, revision)
        };
        apply(
            0,
            &image.visual_hash,
            json!({"wrap":"topAndBottom","horizontalAlignment":"center","textDistanceEmu":101600}),
        )
        .unwrap();
        let changed = hcd_core::get_image_node(&bundle, &image.node_id)
            .unwrap()
            .node;
        assert_ne!(changed.visual_hash, image.visual_hash);
        assert!(apply(1, &image.visual_hash, json!({"wrap":"inline"})).is_err());

        let output = temp.path().join("wrapped.docx");
        crate::export_docx(
            &canonical,
            &source,
            &output,
            &crate::ExportOptions::default(),
        )
        .unwrap();
        let exported = read_body(&output).unwrap();
        let tree = parse(&exported).unwrap();
        let placement = picture(&tree, 29).unwrap();
        let graphic = placement
            .children()
            .find(|child| child.has_tag_name((A, "graphic")))
            .unwrap();
        assert_eq!(
            &exported[graphic.range()],
            &original[original_graphic.range()]
        );
        assert_eq!(&exported[picture(&tree, 1684).unwrap().range()], other);
        assert_eq!(placement.attribute("distL"), Some("101600"));
        assert_eq!(
            wp_child(wp_child(placement, "positionH").unwrap(), "align")
                .unwrap()
                .text(),
            Some("center")
        );
        assert!(wp_child(placement, "wrapTopAndBottom").is_some());
        let range = placement.range();
        let mut restored_bytes = exported;
        restored_bytes.replace_range(range, &original[initial.range()]);
        assert_eq!(restored_bytes, original);

        apply(1, &changed.visual_hash, json!(null)).unwrap();
        let restored = temp.path().join("restored.docx");
        crate::export_docx(
            &canonical,
            &source,
            &restored,
            &crate::ExportOptions::default(),
        )
        .unwrap();
        assert_eq!(read_body(&restored).unwrap(), original);
    }
}
