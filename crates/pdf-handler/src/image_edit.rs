//! Rewrite individual page-level image/Form placements without erasing the page
//! beneath them or changing other uses of a shared XObject.
use crate::content_stream::parse_page_content_stream_text_only_bounded;
use crate::reader::page_content_bounded;
use handler_common::HandlerError;
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use std::collections::{BTreeMap, HashSet};

const CONTENT_LIMIT: usize = 16 * 1024 * 1024;
const AUX_LIMIT: usize = 8 * 1024 * 1024;
const PIXEL_LIMIT: usize = 32 * 1024 * 1024;
type Matrix = [f64; 6];
const IDENTITY: Matrix = [1., 0., 0., 1., 0., 0.];

pub struct ReplacementImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

pub struct ImagePlacementEdit {
    /// One-based placement index, matching /page[n]/image[m].
    pub index: usize,
    /// Unrotated PDF page coordinates: bottom-left x/y, width, height.
    pub rectangle: [f64; 4],
    pub replacement: Option<ReplacementImage>,
}

fn invalid(message: impl Into<String>) -> HandlerError {
    HandlerError::InvalidArgument(message.into())
}

fn multiply(a: Matrix, b: Matrix) -> Matrix {
    [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ]
}

fn inverse(m: Matrix) -> Result<Matrix, HandlerError> {
    let d = m[0] * m[3] - m[1] * m[2];
    if !d.is_finite() || d.abs() < 1e-12 {
        return Err(invalid("image placement has a singular transform"));
    }
    Ok([
        m[3] / d,
        -m[1] / d,
        -m[2] / d,
        m[0] / d,
        (m[2] * m[5] - m[3] * m[4]) / d,
        (m[1] * m[4] - m[0] * m[5]) / d,
    ])
}

// PDF resources are inherited as a whole. Clone the nearest dictionary and its
// XObject category so replacements cannot modify another page's resources.
fn resources(doc: &Document, page: ObjectId) -> Result<Dictionary, HandlerError> {
    let mut current = page;
    let mut seen = HashSet::new();
    while seen.insert(current) {
        let dictionary = doc
            .get_dictionary(current)
            .map_err(|e| invalid(e.to_string()))?;
        if let Ok(value) = dictionary.get(b"Resources") {
            return doc
                .dereference(value)
                .and_then(|(_, value)| value.as_dict())
                .cloned()
                .map_err(|e| invalid(e.to_string()));
        }
        current = match dictionary.get(b"Parent").and_then(Object::as_reference) {
            Ok(parent) => parent,
            Err(_) => return Ok(Dictionary::new()),
        };
    }
    Err(invalid("cycle in PDF page resources"))
}

fn embed_image(doc: &mut Document, image: &ReplacementImage) -> Result<ObjectId, HandlerError> {
    let pixels = (image.width as usize)
        .checked_mul(image.height as usize)
        .filter(|count| *count > 0 && *count <= PIXEL_LIMIT)
        .ok_or_else(|| invalid("replacement image dimensions exceed the pixel limit"))?;
    if image.rgba.len() != pixels * 4 {
        return Err(invalid("replacement image has an invalid RGBA payload"));
    }
    let mut rgb = Vec::with_capacity(pixels * 3);
    let mut alpha = Vec::with_capacity(pixels);
    for pixel in image.rgba.chunks_exact(4) {
        rgb.extend_from_slice(&pixel[..3]);
        alpha.push(pixel[3]);
    }
    let mut dictionary = dictionary! {
        "Type" => "XObject", "Subtype" => "Image", "Width" => image.width as i64,
        "Height" => image.height as i64, "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
    };
    if alpha.iter().any(|value| *value != 255) {
        let mut mask = Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => image.width as i64,
                "Height" => image.height as i64, "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
            },
            alpha,
        );
        mask.compress().map_err(|e| invalid(e.to_string()))?;
        dictionary.set("SMask", doc.add_object(mask));
    }
    let mut stream = Stream::new(dictionary, rgb);
    stream.compress().map_err(|e| invalid(e.to_string()))?;
    Ok(doc.add_object(stream))
}

/// Apply to a disposable candidate document. On failure callers must discard
/// that candidate; no output file is published by this function.
pub fn rewrite_image_placements(
    doc: &mut Document,
    page: u32,
    edits: &[ImagePlacementEdit],
) -> Result<(), HandlerError> {
    if edits.is_empty() {
        return Ok(());
    }
    let page_id = *doc
        .get_pages()
        .get(&page)
        .ok_or_else(|| invalid("PDF page does not exist"))?;
    let bytes = page_content_bounded(doc, page_id, CONTENT_LIMIT)?;
    let parsed = parse_page_content_stream_text_only_bounded(&bytes, page_id, doc, AUX_LIMIT)?;
    let mut content = Content::decode(&bytes)
        .map_err(|e| invalid(format!("cannot decode PDF page operations: {e}")))?;
    // Inline image data cannot safely roundtrip through lopdf's generic encoder.
    if content
        .operations
        .iter()
        .any(|op| matches!(op.operator.as_str(), "BI" | "ID" | "EI"))
    {
        return Err(invalid(
            "image placement rewrite does not support inline-image streams",
        ));
    }
    let mut requested = BTreeMap::new();
    for edit in edits {
        let [x, y, w, h] = edit.rectangle;
        if ![x, y, w, h].iter().all(|v| v.is_finite() && v.abs() <= 1e8) || w <= 0. || h <= 0. {
            return Err(invalid(
                "image rectangle must be finite with positive dimensions",
            ));
        }
        if edit.index == 0
            || edit.index > parsed.image_blocks.len()
            || requested.insert(edit.index, edit).is_some()
        {
            return Err(invalid("image placement index is missing or duplicated"));
        }
    }
    let mut page_resources = resources(doc, page_id)?;
    let mut xobjects = match page_resources.get(b"XObject") {
        Ok(value) => doc
            .dereference(value)
            .and_then(|(_, v)| v.as_dict())
            .cloned()
            .map_err(|e| invalid(e.to_string()))?,
        Err(_) => Dictionary::new(),
    };
    let mut matrix = IDENTITY;
    let mut stack = Vec::new();
    let mut placement = 0;
    let mut output = Vec::with_capacity(content.operations.len() + edits.len() * 4);
    for mut operation in content.operations.drain(..) {
        match operation.operator.as_str() {
            "q" => stack.push(matrix),
            "Q" => {
                matrix = stack
                    .pop()
                    .ok_or_else(|| invalid("unbalanced PDF graphics state"))?
            }
            "cm" => {
                if operation.operands.len() != 6 {
                    return Err(invalid("invalid PDF transform"));
                }
                let mut rhs = IDENTITY;
                for (to, from) in rhs.iter_mut().zip(&operation.operands) {
                    *to = from.as_float().map_err(|e| invalid(e.to_string()))? as f64;
                }
                matrix = multiply(matrix, rhs);
            }
            "Do" => {
                let name = operation
                    .operands
                    .first()
                    .and_then(|value| value.as_name().ok())
                    .ok_or_else(|| invalid("PDF Do operation has no resource name"))?;
                // Count only the same Image/Form resources recognized by import.
                let kind = xobjects
                    .get(name)
                    .ok()
                    .and_then(|value| doc.dereference(value).ok())
                    .and_then(|(_, value)| value.as_stream().ok())
                    .and_then(|stream| stream.dict.get(b"Subtype").ok())
                    .and_then(|value| value.as_name().ok());
                if matches!(kind, Some(b"Image" | b"Form")) {
                    placement += 1;
                    let original = parsed.image_blocks.get(placement - 1).ok_or_else(|| {
                        invalid("PDF image placement map differs from decoded operations")
                    })?;
                    if original.xobject_name.as_bytes() != name {
                        return Err(invalid(
                            "PDF image resource name differs from source mapping",
                        ));
                    }
                    if let Some(edit) = requested.get(&placement) {
                        if original.transform.iter().zip(matrix).any(|(old, current)| {
                            (*old as f64 - current).abs() > 1e-3 * current.abs().max(1.)
                        }) {
                            return Err(invalid("PDF image transform differs from source mapping"));
                        }
                        let [x, y, w, h] = edit.rectangle;
                        let local = if let Some(image) = &edit.replacement {
                            let id = embed_image(doc, image)?;
                            let mut name = format!("HcdImage{}", id.0).into_bytes();
                            while xobjects.has(&name) {
                                name.push(b'_');
                            }
                            xobjects.set(name.clone(), id);
                            operation.operands = vec![Object::Name(name)];
                            multiply(inverse(matrix)?, [w, 0., 0., h, x, y])
                        } else {
                            let b = &original.bbox;
                            if b.width <= 0. || b.height <= 0. {
                                return Err(invalid("image has no editable bounding box"));
                            }
                            let sx = w / b.width as f64;
                            let sy = h / b.height as f64;
                            let delta = [sx, 0., 0., sy, x - sx * b.x as f64, y - sy * b.y as f64];
                            multiply(multiply(inverse(matrix)?, delta), matrix)
                        };
                        if !local.iter().all(|v| v.is_finite() && v.abs() <= 1e10) {
                            return Err(invalid("image transform is outside the supported range"));
                        }
                        output.push(Operation::new("q", vec![]));
                        output.push(Operation::new(
                            "cm",
                            local.into_iter().map(|v| Object::Real(v as f32)).collect(),
                        ));
                        output.push(operation);
                        output.push(Operation::new("Q", vec![]));
                        continue;
                    }
                }
            }
            _ => {}
        }
        output.push(operation);
    }
    if placement != parsed.image_blocks.len() || !stack.is_empty() {
        return Err(invalid("PDF graphics/image map is inconsistent"));
    }
    let bytes = Content { operations: output }
        .encode()
        .map_err(|e| invalid(e.to_string()))?;
    if bytes.len() > CONTENT_LIMIT {
        return Err(invalid("rewritten PDF page exceeds content limit"));
    }
    let mut stream = Stream::new(Dictionary::new(), bytes);
    stream.compress().map_err(|e| invalid(e.to_string()))?;
    let contents = doc.add_object(stream);
    page_resources.set("XObject", xobjects);
    let page = doc
        .get_object_mut(page_id)
        .and_then(Object::as_dict_mut)
        .map_err(|e| invalid(e.to_string()))?;
    page.set("Contents", contents);
    page.set("Resources", page_resources);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Document, ObjectId, ObjectId) {
        let mut doc = Document::with_version("1.5");
        let pages = doc.new_object_id();
        let image = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
                "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
            },
            vec![255, 0, 0],
        ));
        let shared = doc.add_object(dictionary! {
            "XObject" => dictionary! { "Im" => image },
            "Font" => dictionary! { "F1" => dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" } },
        });
        let stream = doc.add_object(Stream::new(Dictionary::new(),
            b"q\n20 0 0 30 10 20 cm\n/Im Do\nQ\nq\n20 0 0 30 60 20 cm\n/Im Do\nQ\nBT\n/F1 10 Tf\n<80FF00> Tj\nET".to_vec()));
        let first = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages, "MediaBox" => vec![0.into(),0.into(),100.into(),100.into()], "Contents" => stream });
        let second = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages, "MediaBox" => vec![0.into(),0.into(),100.into(),100.into()], "Contents" => stream });
        doc.objects.insert(pages, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![first.into(),second.into()], "Count" => 2, "Resources" => shared }));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        (doc, first, second)
    }

    #[test]
    fn moving_one_shared_placement_preserves_other_placement_page_and_binary_text() {
        let (mut doc, first, second) = fixture();
        let untouched = doc.get_page_content(second).unwrap();
        rewrite_image_placements(
            &mut doc,
            1,
            &[ImagePlacementEdit {
                index: 1,
                rectangle: [5., 55., 40., 15.],
                replacement: None,
            }],
        )
        .unwrap();
        let bytes = doc.get_page_content(first).unwrap();
        let parsed =
            parse_page_content_stream_text_only_bounded(&bytes, first, &doc, AUX_LIMIT).unwrap();
        assert!((parsed.image_blocks[0].bbox.x - 5.).abs() < 0.001);
        assert!((parsed.image_blocks[0].bbox.y - 55.).abs() < 0.001);
        assert!((parsed.image_blocks[0].bbox.width - 40.).abs() < 0.001);
        assert!((parsed.image_blocks[0].bbox.height - 15.).abs() < 0.001);
        assert!((parsed.image_blocks[1].bbox.x - 60.).abs() < 0.001);
        assert_eq!(doc.get_page_content(second).unwrap(), untouched);
        let operations = Content::decode(&bytes).unwrap().operations;
        let text = operations.iter().find(|op| op.operator == "Tj").unwrap();
        assert_eq!(text.operands[0].as_str().unwrap(), &[0x80, 0xff, 0]);
    }

    #[test]
    fn transparent_replacement_clones_inherited_resources_and_keeps_fonts() {
        let (mut doc, first, second) = fixture();
        let original_resources = resources(&doc, second).unwrap();
        rewrite_image_placements(
            &mut doc,
            1,
            &[ImagePlacementEdit {
                index: 2,
                rectangle: [60., 20., 20., 30.],
                replacement: Some(ReplacementImage {
                    width: 2,
                    height: 1,
                    rgba: vec![0, 0, 255, 0, 0, 255, 0, 128],
                }),
            }],
        )
        .unwrap();
        let page_resources = resources(&doc, first).unwrap();
        assert!(page_resources.has(b"Font"));
        assert_eq!(resources(&doc, second).unwrap(), original_resources);
        let objects = page_resources.get(b"XObject").unwrap().as_dict().unwrap();
        assert_eq!(objects.len(), 2);
        let image = objects
            .iter()
            .find(|(name, _)| name.starts_with(b"HcdImage"))
            .unwrap()
            .1;
        let stream = doc.dereference(image).unwrap().1.as_stream().unwrap();
        let mask = doc
            .dereference(stream.dict.get(b"SMask").unwrap())
            .unwrap()
            .1
            .as_stream()
            .unwrap();
        assert_eq!(mask.get_plain_content().unwrap(), [0, 128]);
    }

    #[test]
    fn form_bbox_and_local_rotation_are_preserved_when_resizing_a_placement() {
        let (mut doc, first, _) = fixture();
        let resources = resources(&doc, first).unwrap();
        let xobjects = resources.get(b"XObject").unwrap().as_dict().unwrap();
        let original_id = xobjects.get(b"Im").unwrap().as_reference().unwrap();
        doc.objects.insert(original_id, Object::Stream(Stream::new(dictionary! {
            "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![(-10).into(),5.into(),10.into(),15.into()],
            "Matrix" => vec![0.into(),1.into(),(-1).into(),0.into(),20.into(),0.into()],
            "Resources" => Dictionary::new(),
        }, b"0 1 0 rg -10 5 20 10 re f".to_vec())));
        rewrite_image_placements(
            &mut doc,
            1,
            &[ImagePlacementEdit {
                index: 1,
                rectangle: [5., 55., 40., 15.],
                replacement: None,
            }],
        )
        .unwrap();
        let parsed = parse_page_content_stream_text_only_bounded(
            &doc.get_page_content(first).unwrap(),
            first,
            &doc,
            AUX_LIMIT,
        )
        .unwrap();
        let bbox = &parsed.image_blocks[0].bbox;
        for (actual, expected) in [bbox.x, bbox.y, bbox.width, bbox.height]
            .into_iter()
            .zip([5., 55., 40., 15.])
        {
            assert!((actual - expected).abs() < 0.001, "{bbox:?}");
        }
        assert_eq!(
            parsed.image_blocks[0].xobject_kind,
            crate::content_stream::PdfXObjectKind::Form
        );
    }

    #[test]
    fn escaped_resource_names_match_the_source_placement() {
        let (mut doc, first, _) = fixture();
        let bytes = doc.get_page_content(first).unwrap();
        let bytes = String::from_utf8(bytes)
            .unwrap()
            .replace("/Im Do", "/I#6d Do");
        let stream = doc.add_object(Stream::new(Dictionary::new(), bytes.into_bytes()));
        doc.get_object_mut(first)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("Contents", stream);
        rewrite_image_placements(
            &mut doc,
            1,
            &[ImagePlacementEdit {
                index: 1,
                rectangle: [5., 55., 40., 15.],
                replacement: None,
            }],
        )
        .unwrap();
        let parsed = parse_page_content_stream_text_only_bounded(
            &doc.get_page_content(first).unwrap(),
            first,
            &doc,
            AUX_LIMIT,
        )
        .unwrap();
        assert!((parsed.image_blocks[0].bbox.x - 5.).abs() < 0.001);
    }

    #[test]
    fn invalid_index_and_singular_transform_fail_before_publication() {
        let (mut doc, _, _) = fixture();
        assert!(rewrite_image_placements(
            &mut doc,
            1,
            &[ImagePlacementEdit {
                index: 3,
                rectangle: [1., 1., 2., 2.],
                replacement: None,
            }]
        )
        .is_err());
        assert!(inverse([0., 0., 0., 1., 0., 0.]).is_err());
    }
}
