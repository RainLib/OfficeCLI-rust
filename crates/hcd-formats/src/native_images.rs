//! Native media for versioned, HCD-created images. Original package parts stay intact.
use crate::common::{attribute, highest_control_id, local_name, package_error};
use base64::Engine;
use hcd_core::{Bundle, HcdError, ImageGeometry};
use oxml::{StreamingOxmlArchive, StreamingOxmlRewriter};
use quick_xml::{events::Event, Reader};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

struct Picture {
    id: String,
    part: String,
    page: usize,
    page_height: f64,
    geometry: ImageGeometry,
    file: PathBuf,
    alt: String,
    slide_position: (usize, usize),
    later_shapes: usize,
}
fn pictures(bundle: &Bundle, revision: Option<u64>) -> Result<Vec<Picture>, HcdError> {
    let (manifest, _) = hcd_core::manifest_at_revision(bundle, &bundle.manifest()?, revision)?;
    let pptx = manifest.source.format == "pptx";
    let assets: HashMap<_, _> = bundle
        .read_asset_index_for_revision(manifest.revision)?
        .into_iter()
        .map(|asset| (asset.hash.clone(), asset))
        .collect();
    let mut output = vec![];
    let mut slide_shapes: HashMap<String, Vec<(usize, usize)>> = HashMap::new();
    for page in 0..manifest.index_page_count {
        for chunk in bundle.read_index_page(&manifest, page)?.chunks {
            let map = bundle.read_map_verified(&chunk)?;
            let added: Vec<_> = map
                .entries
                .iter()
                .filter(|entry| entry.source.created_in_hcd && entry.source.node_kind == "image")
                .collect();
            if added.is_empty() && !pptx {
                continue;
            }
            let html = bundle.read_chunk_verified(&chunk)?;
            if pptx {
                let authored = crate::pptx::authored_shape_positions(&html, &map);
                if !authored.is_empty() {
                    let part = html
                        .split_once("data-hcd-source-part=\"")
                        .and_then(|(_, value)| value.split_once('"'))
                        .map(|(part, _)| part)
                        .ok_or_else(|| HcdError::InvalidBundle("slide part missing".into()))?;
                    slide_shapes.entry(part.into()).or_default().extend(
                        authored
                            .into_iter()
                            .map(|(_, offset)| (chunk.sequence, offset)),
                    );
                }
            }
            if added.is_empty() {
                continue;
            }
            let nodes = hcd_core::extract_html_image_nodes(&html)?;
            let page_height = html
                .split_once("height:")
                .and_then(|(_, s)| s.split_once("pt"))
                .and_then(|(s, _)| s.parse().ok())
                .unwrap_or(792.0);
            for entry in added {
                let image = nodes
                    .get(&entry.node_id)
                    .ok_or_else(|| HcdError::InvalidBundle("created image is missing".into()))?;
                let hash = image
                    .asset_hash
                    .as_ref()
                    .ok_or_else(|| HcdError::InvalidBundle("created image has no asset".into()))?;
                let asset = assets.get(hash).ok_or_else(|| {
                    HcdError::InvalidBundle("created image asset is missing".into())
                })?;
                let file = bundle.resolve_href(&asset.href)?;
                if hcd_core::hash_file(&file)? != *hash {
                    return Err(HcdError::InvalidBundle(
                        "image asset checksum differs".into(),
                    ));
                }
                output.push(Picture {
                    id: entry.node_id.clone(),
                    part: entry.source.part.clone(),
                    page: entry
                        .source
                        .part
                        .strip_prefix("pdf/pages/")
                        .and_then(|v| v.split('/').next())
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(chunk.sequence + 1),
                    page_height,
                    geometry: image
                        .geometry
                        .clone()
                        .ok_or_else(|| HcdError::InvalidBundle("image has no rectangle".into()))?,
                    file,
                    alt: image_alt(&html, &entry.node_id).unwrap_or_default(),
                    slide_position: (
                        chunk.sequence,
                        html.find(&format!(" data-hcd-id=\"{}\"", entry.node_id))
                            .unwrap_or_default(),
                    ),
                    later_shapes: 0,
                });
            }
        }
    }
    if pptx {
        output.sort_by_key(|picture| picture.slide_position);
        for picture in &mut output {
            picture.later_shapes = slide_shapes.get(&picture.part).map_or(0, |list| {
                list.iter()
                    .filter(|&&shape| shape > picture.slide_position)
                    .count()
            });
        }
    }
    Ok(output)
}

fn image_alt(html: &str, node_id: &str) -> Option<String> {
    let mut reader = Reader::from_str(html);
    let mut found = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e) | Event::Empty(e)) => {
                if attribute(&e, "data-hcd-id").as_deref() == Some(node_id) {
                    found = true;
                }
                if found && local_name(e.name().as_ref()) == "img" {
                    return attribute(&e, "alt");
                }
            }
            Ok(Event::Eof) | Err(_) => return None,
            _ => {}
        }
    }
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
pub(crate) fn insert(xml: &mut String, before: &str, child: &str) -> Result<(), HcdError> {
    // Match local container names and expand empty containers without assuming
    // a package's namespace prefixes or whitespace conventions.
    let closing = before.starts_with("</");
    let wanted = before
        .trim_start_matches("</")
        .trim_start_matches('<')
        .trim_end_matches('>')
        .rsplit(':')
        .next()
        .unwrap();
    let offset = if xml.starts_with('\u{feff}') { 3 } else { 0 };
    let mut reader = Reader::from_str(xml);
    let mut candidate = None;
    loop {
        let start = reader.buffer_position() as usize + offset;
        match reader.read_event() {
            Ok(Event::End(e)) if closing && local_name(e.name().as_ref()) == wanted => {
                candidate = Some((start, start, String::new()))
            }
            Ok(Event::Start(e)) if !closing && local_name(e.name().as_ref()) == wanted => {
                candidate = Some((start, start, String::new()))
            }
            Ok(Event::Empty(e)) if local_name(e.name().as_ref()) == wanted => {
                if closing {
                    candidate = Some((
                        start,
                        reader.buffer_position() as usize + offset,
                        String::from_utf8_lossy(e.name().as_ref()).into_owned(),
                    ));
                } else {
                    candidate = Some((start, start, String::new()));
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(HcdError::InvalidBundle(error.to_string())),
            _ => {}
        }
    }
    drop(reader);
    let (start, end, name) = candidate
        .ok_or_else(|| HcdError::InvalidBundle(format!("missing native container {before}")))?;
    if start == end {
        xml.insert_str(start, child);
    } else {
        let opening = xml[start..end]
            .trim_end()
            .trim_end_matches("/>")
            .to_string();
        xml.replace_range(start..end, &format!("{opening}>{child}</{name}>"));
    }
    Ok(())
}

// The slide writer already inserted its new shapes in scene order. Insert each
// picture before the remaining authored shapes above it in that same order.
fn insert_slide_picture(
    xml: &mut String,
    child: &str,
    later_shapes: usize,
) -> Result<(), HcdError> {
    let bom = if xml.starts_with('\u{feff}') { 3 } else { 0 };
    let mut reader = Reader::from_str(xml);
    let mut depth = 0usize;
    let mut tree = None;
    let mut trailer = None;
    let mut shapes = Vec::new();
    let at = loop {
        let offset = reader.buffer_position() as usize + bom;
        match reader
            .read_event()
            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
        {
            Event::Start(start) => {
                match local_name(start.name().as_ref()) {
                    "spTree" if tree.is_none() => tree = Some(depth + 1),
                    "sp" if tree == Some(depth) => shapes.push(offset),
                    "extLst" if tree == Some(depth) => trailer = Some(offset),
                    _ => {}
                }
                depth += 1;
            }
            Event::Empty(start)
                if tree == Some(depth) && local_name(start.name().as_ref()) == "extLst" =>
            {
                trailer = Some(offset);
            }
            Event::End(end) => {
                if tree == Some(depth) && local_name(end.name().as_ref()) == "spTree" {
                    if later_shapes == 0 {
                        break Some(trailer.unwrap_or(offset));
                    }
                    let index = shapes.len().checked_sub(later_shapes).ok_or_else(|| {
                        HcdError::InvalidBundle("slide image has missing shape siblings".into())
                    })?;
                    break Some(shapes[index]);
                }
                depth = depth.saturating_sub(1);
            }
            Event::Eof => break None,
            _ => {}
        }
    };
    if let Some(at) = at {
        xml.insert_str(at, child);
        Ok(())
    } else if later_shapes == 0 {
        insert(xml, "</p:spTree>", child)
    } else {
        Err(HcdError::InvalidBundle(
            "slide image has no shape tree".into(),
        ))
    }
}
pub(crate) fn rels(part: &str) -> String {
    let (dir, file) = part.rsplit_once('/').unwrap_or(("", part));
    format!("{dir}/_rels/{file}.rels")
}
pub(crate) fn read(
    archive: &mut StreamingOxmlArchive,
    changes: &HashMap<String, Vec<u8>>,
    part: &str,
    empty: &str,
) -> Result<String, HcdError> {
    let bytes = if let Some(value) = changes.get(part) {
        value.clone()
    } else if archive.contains(part) {
        archive
            .read_control_part(part, 16 * 1024 * 1024)
            .map_err(package_error)?
    } else {
        empty.as_bytes().to_vec()
    };
    String::from_utf8(bytes).map_err(|error| HcdError::InvalidBundle(error.to_string()))
}
const RELS:&str="<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>";
pub(crate) fn relationship(
    archive: &mut StreamingOxmlArchive,
    changes: &mut HashMap<String, Vec<u8>>,
    part: &str,
    id: &str,
    kind: &str,
    target: &str,
) -> Result<(), HcdError> {
    let path = rels(part);
    let mut xml = read(archive, changes, &path, RELS)?;
    if xml.contains(&format!("Id=\"{id}\"")) {
        return Err(HcdError::InvalidBundle(
            "generated relationship already exists".into(),
        ));
    }

    insert(&mut xml,"</Relationships>",&format!("<Relationship xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\" Id=\"{id}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}\" Target=\"{}\"/>",escape(target)))?;
    changes.insert(path, xml.into_bytes());
    Ok(())
}
fn find_attr(xml: &str, element: &str, key: &str) -> Option<String> {
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e) | Event::Empty(e)) if local_name(e.name().as_ref()) == element => {
                return attribute(&e, key)
            }
            Ok(Event::Eof) | Err(_) => return None,
            _ => {}
        }
    }
}
fn target_by_id(xml: &str, id: &str) -> Option<String> {
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e) | Event::Empty(e)) if attribute(&e, "Id").as_deref() == Some(id) => {
                return attribute(&e, "Target")
            }
            Ok(Event::Eof) | Err(_) => return None,
            _ => {}
        }
    }
}
fn resolve_part(base: &str, target: &str) -> Result<String, HcdError> {
    let mut segments: Vec<_> = if target.starts_with('/') {
        vec![]
    } else {
        let mut parts: Vec<_> = base.split('/').collect();
        parts.pop();
        parts
    };
    for segment in target.split('/') {
        match segment {
            ".." => {
                if segments.pop().is_none() {
                    return Err(HcdError::InvalidBundle(
                        "relationship escapes package".into(),
                    ));
                }
            }
            "." | "" => {}
            other => segments.push(other),
        }
    }
    Ok(segments.join("/"))
}
fn pic(
    id: u64,
    rid: &str,
    alt: &str,
    prefix: &str,
    rect: (i64, i64, i64, i64),
    stable_id: &str,
) -> String {
    let (x, y, w, h) = rect;
    let id_markup = if prefix == "p" {
        let creation_id = crate::pptx::animations::creation_id_xml(stable_id);
        format!(">{creation_id}</p:cNvPr>")
    } else {
        "/>".to_string()
    };
    format!("<{prefix}:pic xmlns:{prefix}=\"http://schemas.openxmlformats.org/{namespace}/2006/{suffix}\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><{prefix}:nvPicPr><{prefix}:cNvPr id=\"{id}\" name=\"HCD image {id}\" descr=\"{alt}\"{id_markup}<{prefix}:cNvPicPr/>{nv}</{prefix}:nvPicPr><{prefix}:blipFill><a:blip r:embed=\"{rid}\"/><a:stretch><a:fillRect/></a:stretch></{prefix}:blipFill><{prefix}:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{w}\" cy=\"{h}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></{prefix}:spPr></{prefix}:pic>",namespace=if prefix=="p"{"presentationml"}else{"drawingml"},suffix=if prefix=="p"{"main"}else if prefix=="xdr"{"spreadsheetDrawing"}else{"picture"},nv=if prefix=="p"{"<p:nvPr/>"}else{""})
}

pub(crate) fn apply(
    bundle: &Bundle,
    target: &Path,
    revision: Option<u64>,
) -> Result<usize, HcdError> {
    let pictures = pictures(bundle, revision)?;
    let count = pictures.len();
    if pictures.is_empty() {
        return Ok(0);
    }
    let format = bundle.manifest()?.source.format;
    if format == "pdf" {
        use handler_common::{DocumentHandler, InsertPosition};
        let handler = pdf_handler::PdfHandler::open(
            target
                .to_str()
                .ok_or_else(|| HcdError::Unsupported("non-UTF8 PDF path".into()))?,
            true,
        )
        .map_err(|e| HcdError::Unsupported(e.to_string()))?;
        for picture in pictures {
            let g = picture.geometry;
            let props = HashMap::from([
                ("src".into(), picture.file.to_string_lossy().to_string()),
                ("x".into(), g.x.to_string()),
                (
                    "y".into(),
                    (picture.page_height - g.y - g.height).to_string(),
                ),
                ("width".into(), g.width.to_string()),
                ("height".into(), g.height.to_string()),
            ]);
            handler
                .add(
                    &format!("/page[{}]", picture.page),
                    "image",
                    InsertPosition::Append,
                    &props,
                    None,
                )
                .map_err(|e| HcdError::Unsupported(e.to_string()))?;
        }
        handler
            .save()
            .map_err(|e| HcdError::Unsupported(e.to_string()))?;
        return Ok(count);
    }
    if matches!(format.as_str(), "md" | "html") {
        let mut text = std::fs::read_to_string(target)?;
        let mut media = String::new();
        for picture in pictures {
            let bytes = std::fs::read(&picture.file)?;
            let mime = if bytes.starts_with(b"\x89PNG") {
                "image/png"
            } else {
                "image/jpeg"
            };
            let href = format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            );
            media.push_str(&format!(
                "\n<figure><img src=\"{}\" alt=\"{}\" width=\"{}\" height=\"{}\" /></figure>\n",
                href,
                escape(&picture.alt),
                picture.geometry.width * 96.0 / 72.0,
                picture.geometry.height * 96.0 / 72.0
            ));
        }
        if format == "html" && text.contains("</body>") {
            insert(&mut text, "</body>", &media)?;
        } else {
            text.push_str(&media);
        }
        std::fs::write(target, text)?;
        return Ok(count);
    }
    let mut archive = StreamingOxmlArchive::open(target).map_err(package_error)?;
    let mut changes: HashMap<String, Vec<u8>> = HashMap::new();
    let mut media = HashMap::new();
    for (index, picture) in pictures.iter().enumerate() {
        let extension = picture
            .file
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("png");
        if !matches!(extension, "png" | "jpg" | "jpeg") {
            return Err(HcdError::Unsupported(
                "native generated images require PNG or JPEG".into(),
            ));
        }
        let rid = format!("rIdHcdImage{}", picture.id.trim_start_matches("n_"));
        let g = &picture.geometry;
        let (x, y, w, h) = if format == "docx" {
            (
                0,
                0,
                (g.width * 12700.0).round() as i64,
                (g.height * 12700.0).round() as i64,
            )
        } else {
            (
                g.x.round() as i64,
                g.y.round() as i64,
                g.width.round() as i64,
                g.height.round() as i64,
            )
        };
        let prefix = if format == "pptx" {
            "ppt"
        } else if format == "xlsx" {
            "xl"
        } else {
            "word"
        };
        let filename = format!("hcd-{}.{}", picture.id, extension);
        media.insert(format!("{prefix}/media/{filename}"), picture.file.clone());
        let mut part = picture.part.clone();
        let mut xml = read(&mut archive, &changes, &part, "")?;
        if format == "xlsx" {
            let drawing_id = find_attr(&xml, "drawing", "id");
            let drawing = if let Some(id) = drawing_id {
                let relationship_xml = read(&mut archive, &changes, &rels(&part), RELS)?;
                let target = target_by_id(&relationship_xml, &id).ok_or_else(|| {
                    HcdError::InvalidBundle("sheet drawing relationship missing".into())
                })?;
                resolve_part(&part, &target)?
            } else {
                let drawing = format!(
                    "xl/drawings/hcd-{}.xml",
                    part.rsplit('/').next().unwrap_or("sheet")
                );
                let id = format!("rIdHcdDrawing{index}");
                relationship(
                    &mut archive,
                    &mut changes,
                    &part,
                    &id,
                    "drawing",
                    &format!("../drawings/{}", drawing.rsplit('/').next().unwrap()),
                )?;
                insert(&mut xml,"</worksheet>",&format!("<drawing xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" r:id=\"{id}\"/>"))?;
                changes.insert(part.clone(), xml.into_bytes());
                drawing
            };
            part = drawing;
            xml=read(&mut archive,&changes,&part,"<xdr:wsDr xmlns:xdr=\"http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing\"></xdr:wsDr>")?;
        }
        let id = highest_control_id(
            xml.as_bytes(),
            if format == "docx" { "docPr" } else { "cNvPr" },
            "id",
        )? + 1;
        let picture_xml = pic(
            id,
            &rid,
            &escape(&picture.alt),
            if format == "pptx" {
                "p"
            } else if format == "xlsx" {
                "xdr"
            } else {
                "pic"
            },
            (x, y, w, h),
            &picture.id,
        );
        if format == "pptx" {
            insert_slide_picture(&mut xml, &picture_xml, picture.later_shapes)?;
        } else if format == "xlsx" {
            insert(&mut xml,"</xdr:wsDr>",&format!("<xdr:absoluteAnchor xmlns:xdr=\"http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing\"><xdr:pos x=\"{x}\" y=\"{y}\"/><xdr:ext cx=\"{w}\" cy=\"{h}\"/>{picture_xml}<xdr:clientData/></xdr:absoluteAnchor>"))?;
        } else {
            let drawing=format!("<w:p xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:r><w:drawing><wp:inline xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\"><wp:extent cx=\"{w}\" cy=\"{h}\"/><wp:docPr id=\"{id}\" name=\"HCD image {id}\"/><a:graphic xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">{picture_xml}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>");
            let closing = if xml.contains("<w:sectPr") {
                "<w:sectPr"
            } else {
                "</w:body>"
            };
            insert(&mut xml, closing, &drawing)?;
        }
        changes.insert(part.clone(), xml.into_bytes());
        relationship(
            &mut archive,
            &mut changes,
            &part,
            &rid,
            "image",
            &format!(
                "{}media/{filename}",
                if format == "docx" { "" } else { "../" }
            ),
        )?;
    }
    let mut types = read(&mut archive, &changes, "[Content_Types].xml", "")?;
    for extension in ["png", "jpg", "jpeg"] {
        if !types.contains(&format!("Extension=\"{extension}\"")) {
            insert(&mut types,"</Types>",&format!("<Default xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\" Extension=\"{extension}\" ContentType=\"image/{}\"/>",if extension=="png"{"png"}else{"jpeg"}))?;
        }
    }
    for part in changes
        .keys()
        .filter(|p| p.starts_with("xl/drawings/") && p.ends_with(".xml"))
    {
        if !types.contains(&format!("PartName=\"/{part}\"")) {
            insert(&mut types,"</Types>",&format!("<Override xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\" PartName=\"/{part}\" ContentType=\"application/vnd.openxmlformats-officedocument.drawing+xml\"/>"))?;
        }
    }
    changes.insert("[Content_Types].xml".into(), types.into_bytes());
    let temp = tempfile::tempdir()?;
    let mut replacements = HashMap::new();
    let mut additions = HashMap::new();
    for (index, (part, bytes)) in changes.into_iter().enumerate() {
        let path = temp.path().join(format!("part-{index}"));
        std::fs::write(&path, bytes)?;
        if archive.contains(&part) {
            replacements.insert(part, path);
        } else {
            additions.insert(part, path);
        }
    }
    additions.extend(media);
    let output = temp.path().join("images.zip");
    let main = if format == "pptx" {
        "ppt/presentation.xml"
    } else if format == "xlsx" {
        "xl/workbook.xml"
    } else {
        "word/document.xml"
    };
    StreamingOxmlRewriter::rewrite_with_additions(target, &output, &replacements, &additions, main)
        .map_err(package_error)?;
    std::fs::copy(output, target)?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn appends_media_to_prefixed_and_empty_native_containers() {
        for input in [
            "<Types></Types>",
            "<ct:Types xmlns:ct=\"urn:types\"></ct:Types>",
            "<Types />\n",
            "\u{feff}<?xml version=\"1.0\"?><Types><Default Extension=\"jpg\" /></Types>",
        ] {
            let mut xml = input.to_string();
            insert(
                &mut xml,
                "</Types>",
                "<Default xmlns=\"urn:types\" Extension=\"png\"/>",
            )
            .unwrap();
            assert!(xml.contains("Extension=\"png\""));
            let mut reader = Reader::from_str(&xml);
            loop {
                match reader.read_event() {
                    Ok(Event::Eof) => break,
                    Err(error) => panic!("{error}"),
                    _ => {}
                }
            }
        }
        let mut slide = "<slide><shapes/></slide>".to_string();
        insert(
            &mut slide,
            "</p:shapes>",
            "<p:pic xmlns:p=\"urn:picture\"/>",
        )
        .unwrap();
        assert!(slide.contains("<shapes><p:pic"));
        assert_eq!(
            resolve_part("xl/worksheets/sheet1.xml", "/xl/drawings/drawing1.xml").unwrap(),
            "xl/drawings/drawing1.xml"
        );
        assert!(resolve_part("xl/worksheets/sheet1.xml", "../../../escape").is_err());
    }
}
