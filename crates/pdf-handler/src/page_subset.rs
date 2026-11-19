use handler_common::HandlerError;
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId};
use std::collections::{BTreeMap, HashSet};
use std::ops::RangeInclusive;

const INHERITABLE: &[&[u8]] = &[b"Resources", b"MediaBox", b"CropBox", b"Rotate"];
const PAGE_ENTRIES: &[&[u8]] = &[
    b"Contents",
    b"BleedBox",
    b"TrimBox",
    b"ArtBox",
    b"Group",
    b"UserUnit",
];
const ANNOTATION_ENTRIES: &[&[u8]] = &[
    b"Subtype",
    b"Rect",
    b"Contents",
    b"NM",
    b"M",
    b"F",
    b"AP",
    b"AS",
    b"Border",
    b"C",
    b"CA",
    b"BS",
    b"BE",
    b"T",
    b"Subj",
    b"CreationDate",
    b"RC",
    b"Name",
    b"Open",
    b"DA",
    b"Q",
    b"DS",
    b"CL",
    b"IT",
    b"RD",
    b"QuadPoints",
    b"InkList",
    b"Vertices",
    b"LE",
    b"L",
    b"LL",
    b"LLE",
    b"LLO",
    b"Cap",
    b"CP",
    b"CO",
    b"IC",
    b"OC",
    b"H",
];

pub enum PdfPageSelection {
    Source {
        page: u32,
        rotation: u16,
    },
    Blank {
        width: f32,
        height: f32,
        rotation: u16,
    },
}

/// Keep the original catalog for a complete layout. When extracting a subset,
/// write a standalone page tree and omit unreachable source objects.
pub(crate) fn organize_pages(
    document: &mut Document,
    layout: &[PdfPageSelection],
    extract: bool,
) -> Result<(), HandlerError> {
    if document.is_encrypted() {
        return Err(unsupported("page organization requires an unencrypted PDF"));
    }
    let source: Vec<_> = document.page_iter().collect();
    if layout.is_empty() || source.is_empty() {
        return Err(unsupported(
            "PDF page organization requires at least one retained or blank page",
        ));
    }
    let root = document
        .catalog()
        .and_then(|catalog| catalog.get(b"Pages"))
        .and_then(Object::as_reference)
        .map_err(unsupported)?;
    let order_changed = layout.len() != source.len() || layout.iter().enumerate().any(|(index, item)| {
        !matches!(item, PdfPageSelection::Source { page, .. } if *page as usize == index + 1)
    });
    let mut pages = Vec::with_capacity(layout.len());
    let mut seen = HashSet::new();
    let mut next_id = document.max_id;
    for entry in layout {
        match *entry {
            PdfPageSelection::Source { page, rotation } => {
                let id = page
                    .checked_sub(1)
                    .and_then(|index| source.get(index as usize))
                    .copied()
                    .ok_or_else(|| unsupported("PDF layout source page is out of range"))?;
                if !seen.insert(id) {
                    return Err(unsupported("PDF layout contains a duplicate source page"));
                }
                let mut page = document.get_dictionary(id).map_err(unsupported)?.clone();
                if order_changed || extract || rotation != 0 {
                    inherit_page_entries(document, id, &mut page)?;
                }
                apply_rotation(document, &mut page, rotation)?;
                pages.push((id, page));
            }
            PdfPageSelection::Blank {
                width,
                height,
                rotation,
            } => {
                if ![width, height]
                    .iter()
                    .all(|value| value.is_finite() && (1.0..=14_400.0).contains(value))
                {
                    return Err(unsupported("blank PDF page dimensions are invalid"));
                }
                next_id = next_id
                    .checked_add(1)
                    .ok_or_else(|| unsupported("PDF object numbers exceed the export limit"))?;
                let mut page = dictionary! {
                    "Type" => "Page", "Resources" => Dictionary::new(), "Rotate" => 0,
                    "MediaBox" => vec![0.into(), 0.into(), width.into(), height.into()],
                };
                // Give the blank page its own crop box when its parent is a source page tree.
                page.set(
                    "CropBox",
                    page.get(b"MediaBox").map_err(unsupported)?.clone(),
                );
                apply_rotation(document, &mut page, rotation)?;
                pages.push(((next_id, 0), page));
            }
        }
    }
    if extract || seen.len() != source.len() {
        return retain_pages(document, pages, next_id);
    }
    if order_changed {
        for (_, page) in &mut pages {
            page.set("Parent", root);
        }
        let root = document
            .get_object_mut(root)
            .and_then(Object::as_dict_mut)
            .map_err(unsupported)?;
        root.set(
            "Kids",
            pages
                .iter()
                .map(|(id, _)| Object::Reference(*id))
                .collect::<Vec<_>>(),
        );
        root.set("Count", pages.len() as i64);
    }
    document.max_id = next_id;
    document.objects.extend(
        pages
            .into_iter()
            .map(|(id, page)| (id, Object::Dictionary(page))),
    );
    Ok(())
}

fn apply_rotation(
    document: &Document,
    page: &mut Dictionary,
    rotation: u16,
) -> Result<(), HandlerError> {
    if rotation == 0 {
        return Ok(());
    }
    if !matches!(rotation, 90 | 180 | 270) {
        return Err(unsupported("PDF layout rotation must be a multiple of 90"));
    }
    let inherited = match page.get(b"Rotate") {
        Ok(value) => resolve(document, value)
            .and_then(Object::as_i64)
            .map_err(unsupported)?,
        Err(_) => 0,
    };
    if inherited % 90 != 0 {
        return Err(unsupported(
            "source PDF page rotation is not a multiple of 90",
        ));
    }
    page.set(
        "Rotate",
        (inherited.rem_euclid(360) + i64::from(rotation)).rem_euclid(360),
    );
    Ok(())
}

pub(crate) fn retain_page_range(
    document: &mut Document,
    range: RangeInclusive<usize>,
) -> Result<(), HandlerError> {
    let all_pages: Vec<_> = document.page_iter().collect();
    let start = *range.start();
    let end = *range.end();
    if start == 0 || start > end || end > all_pages.len() {
        return Err(HandlerError::InvalidArgument(format!(
            "PDF page range {start}-{end} is outside the {}-page document",
            all_pages.len()
        )));
    }
    if document.is_encrypted() {
        return Err(unsupported(
            "native page extraction requires an unencrypted PDF",
        ));
    }
    let pages = all_pages[start - 1..end]
        .iter()
        .map(|&id| {
            let mut page = document.get_dictionary(id).map_err(unsupported)?.clone();
            inherit_page_entries(document, id, &mut page)?;
            Ok((id, page))
        })
        .collect::<Result<Vec<_>, HandlerError>>()?;
    retain_pages(document, pages, document.max_id)
}

fn retain_pages(
    document: &mut Document,
    pages: Vec<(ObjectId, Dictionary)>,
    mut next_id: u32,
) -> Result<(), HandlerError> {
    let kept: HashSet<_> = pages.iter().map(|(id, _)| *id).collect();
    if kept.len() != pages.len() {
        return Err(unsupported(
            "the selected PDF pages contain repeated page objects",
        ));
    }
    let mut selected = Vec::with_capacity(pages.len());
    let mut new_objects = 3u32; // Page tree, catalog, and cross-reference stream if needed.
    for (id, original) in pages {
        let mut page = copy_entries(&original, PAGE_ENTRIES);
        for &key in INHERITABLE {
            if let Ok(value) = original.get(key) {
                page.set(key, value.clone());
            }
        }
        let annotations = retained_annotations(document, &original, &kept)?;
        new_objects = u32::try_from(annotations.len())
            .ok()
            .and_then(|count| new_objects.checked_add(count))
            .ok_or_else(|| unsupported("too many PDF annotations to extract"))?;
        selected.push((id, page, annotations));
    }
    next_id
        .checked_add(new_objects)
        .ok_or_else(|| unsupported("PDF object numbers exceed the export limit"))?;
    let mut replacements = BTreeMap::new();
    let mut allocate = |dictionary: Dictionary| {
        next_id += 1;
        let id = (next_id, 0);
        replacements.insert(id, Object::Dictionary(dictionary));
        id
    };
    let page_tree = allocate(dictionary! {
        "Type" => "Pages", "Kids" => selected.iter().map(|(id, _, _)| Object::Reference(*id)).collect::<Vec<_>>(),
        "Count" => selected.len() as i64,
    });
    let mut page_objects = Vec::with_capacity(selected.len());
    for (id, mut page, annotations) in selected {
        page.set("Type", "Page");
        page.set("Parent", page_tree);
        if !annotations.is_empty() {
            let references = annotations
                .into_iter()
                .map(|mut annotation| {
                    annotation.set("Type", "Annot");
                    annotation.set("P", id);
                    Object::Reference(allocate(annotation))
                })
                .collect::<Vec<_>>();
            page.set("Annots", references);
        }
        page_objects.push((id, Object::Dictionary(page)));
    }
    let mut catalog = copy_entries(
        document.catalog().map_err(unsupported)?,
        &[b"Version", b"Extensions", b"OCProperties", b"OutputIntents"],
    );
    catalog.set("Type", "Catalog");
    catalog.set("Pages", page_tree);
    let catalog = allocate(catalog);
    replacements.extend(page_objects);
    let reachable = reachable_objects(document, &replacements, catalog, page_tree, &kept)?;
    document.max_id = next_id;
    document.trailer = dictionary! { "Root" => catalog };
    document.objects.append(&mut replacements);
    document.objects.retain(|id, _| reachable.contains(id));
    // lopdf's writer scans through max_id, including every unused number.
    if u64::from(document.max_id) > (reachable.len() as u64 * 8).max(100_000) {
        document.renumber_objects();
    }
    Ok(())
}

fn copy_entries(source: &Dictionary, keys: &[&[u8]]) -> Dictionary {
    let mut result = Dictionary::new();
    for &key in keys {
        if let Ok(value) = source.get(key) {
            if !matches!(value, Object::Null) {
                result.set(key, value.clone());
            }
        }
    }
    result
}

fn inherit_page_entries(
    document: &Document,
    id: ObjectId,
    page: &mut Dictionary,
) -> Result<(), HandlerError> {
    let mut visited = HashSet::new();
    let mut current = Some(id);
    while let Some(id) = current {
        if !visited.insert(id) || visited.len() > 128 {
            return Err(unsupported("invalid PDF page ancestry"));
        }
        let ancestor = document.get_dictionary(id).map_err(unsupported)?;
        for &key in INHERITABLE {
            if !page.has(key) {
                if let Ok(value) = ancestor.get(key) {
                    if !matches!(value, Object::Null) {
                        page.set(key, value.clone());
                    }
                }
            }
        }
        current = match ancestor.get(b"Parent") {
            Ok(Object::Null) | Err(_) => None,
            Ok(parent) => Some(parent.as_reference().map_err(unsupported)?),
        };
    }
    if !page.has(b"MediaBox") {
        return Err(unsupported("selected PDF page has no MediaBox"));
    }
    Ok(())
}

fn resolve<'a>(document: &'a Document, value: &'a Object) -> lopdf::Result<&'a Object> {
    match value {
        Object::Reference(id) => document.get_object(*id),
        value => Ok(value),
    }
}

fn retained_annotations(
    document: &Document,
    page: &Dictionary,
    kept: &HashSet<ObjectId>,
) -> Result<Vec<Dictionary>, HandlerError> {
    let Ok(annotations) = page.get(b"Annots") else {
        return Ok(Vec::new());
    };
    let annotations = resolve(document, annotations).map_err(unsupported)?;
    if matches!(annotations, Object::Null) {
        return Ok(Vec::new());
    }
    let annotations = annotations.as_array().map_err(unsupported)?;
    let mut output = Vec::new();
    for annotation in annotations {
        let annotation = resolve(document, annotation).map_err(unsupported)?;
        if matches!(annotation, Object::Null) {
            continue;
        }
        let annotation = annotation.as_dict().map_err(unsupported)?;
        let subtype = annotation
            .get(b"Subtype")
            .and_then(Object::as_name)
            .map_err(unsupported)?;
        let mut copied = copy_entries(annotation, ANNOTATION_ENTRIES);
        match subtype {
            b"Widget" => {
                return Err(unsupported(
                    "selected pages contain PDF form widgets; choose visual export for these pages",
                ))
            }
            b"Link" => {
                if let Some(destination) = annotation
                    .get(b"Dest")
                    .ok()
                    .and_then(|value| local_destination(document, value, kept))
                {
                    copied.set("Dest", destination);
                } else if let Some(action) = document
                    .get_dict_in_dict(annotation, b"A")
                    .ok()
                    .and_then(|action| link_action(document, action, kept))
                {
                    copied.set("A", action);
                } else {
                    continue;
                }
            }
            b"Text" | b"FreeText" | b"Highlight" | b"Underline" | b"Squiggly" | b"StrikeOut"
            | b"Square" | b"Circle" | b"Line" | b"Polygon" | b"PolyLine" | b"Ink" | b"Stamp"
            | b"Caret" => {}
            _ => continue,
        }
        output.push(copied);
    }
    Ok(output)
}

fn local_destination(
    document: &Document,
    value: &Object,
    kept: &HashSet<ObjectId>,
) -> Option<Object> {
    let destination = resolve(document, value).ok()?.as_array().ok()?;
    let target = destination.first()?.as_reference().ok()?;
    if !kept.contains(&target)
        || destination.len() < 2
        || !destination[1..].iter().all(|argument| {
            matches!(
                argument,
                Object::Name(_) | Object::Integer(_) | Object::Real(_) | Object::Null
            )
        })
    {
        return None;
    }
    Some(Object::Array(destination.clone()))
}

fn link_action(
    document: &Document,
    action: &Dictionary,
    kept: &HashSet<ObjectId>,
) -> Option<Dictionary> {
    match action.get(b"S").ok()?.as_name().ok()? {
        b"GoTo" => Some(
            dictionary! { "S" => "GoTo", "D" => local_destination(document, action.get(b"D").ok()?, kept)? },
        ),
        b"URI" => {
            let uri = resolve(document, action.get(b"URI").ok()?)
                .ok()?
                .as_str()
                .ok()?;
            let allowed = [b"https://".as_slice(), b"http://", b"mailto:"]
                .iter()
                .any(|prefix| {
                    uri.get(..prefix.len())
                        .is_some_and(|value| value.eq_ignore_ascii_case(prefix))
                });
            if !allowed || uri.iter().any(u8::is_ascii_control) {
                return None;
            }
            Some(dictionary! { "S" => "URI", "URI" => Object::string_literal(uri) })
        }
        _ => None,
    }
}

fn reachable_objects(
    document: &Document,
    replacements: &BTreeMap<ObjectId, Object>,
    catalog: ObjectId,
    page_tree: ObjectId,
    pages: &HashSet<ObjectId>,
) -> Result<HashSet<ObjectId>, HandlerError> {
    let root = Object::Reference(catalog);
    let mut pending = vec![&root];
    let mut visited = HashSet::new();
    while let Some(object) = pending.pop() {
        match object {
            Object::Reference(id) if visited.insert(*id) => {
                let object = replacements
                    .get(id)
                    .or_else(|| document.objects.get(id))
                    .ok_or_else(|| {
                        unsupported(format!(
                            "selected PDF objects reference missing object {id:?}"
                        ))
                    })?;
                let external_page_object = match object.type_name() {
                    Ok("Page") => !pages.contains(id),
                    Ok("Pages") => *id != page_tree,
                    Ok("Catalog") => *id != catalog,
                    Ok("ObjStm" | "XRef" | "Linearized") => true,
                    _ => false,
                };
                if external_page_object {
                    return Err(unsupported(
                        "selected PDF objects depend on document structure outside the page range",
                    ));
                }
                pending.push(object);
            }
            Object::Dictionary(dictionary) => {
                pending.extend(dictionary.iter().map(|(_, value)| value))
            }
            Object::Array(values) => pending.extend(values),
            Object::Stream(stream) => pending.extend(stream.dict.iter().map(|(_, value)| value)),
            _ => {}
        }
    }
    Ok(visited)
}

fn unsupported(error: impl std::fmt::Display) -> HandlerError {
    HandlerError::UnsupportedMode(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::Stream;

    #[test]
    fn extraction_preserves_inherited_geometry_text_and_links_between_retained_pages() {
        let mut document = Document::with_version("1.5");
        let tree = document.new_object_id();
        let subtree = document.new_object_id();
        let font = document.add_object(
            dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" },
        );
        let pages: Vec<_> = ["omitted words", "retained words", "final words"]
            .into_iter()
            .map(|text| {
                let content = document.add_object(Stream::new(
                    dictionary! {},
                    format!("BT /F1 12 Tf 30 30 Td ({text}) Tj ET").into_bytes(),
                ));
                document.add_object(
                    dictionary! { "Type" => "Page", "Parent" => subtree, "Contents" => content },
                )
            })
            .collect();
        document.set_object(
            subtree,
            dictionary! {
                "Type" => "Pages", "Parent" => tree, "Count" => 3,
                "Kids" => pages.iter().copied().map(Object::Reference).collect::<Vec<_>>(),
                "Rotate" => 90, "CropBox" => vec![0.into(), 0.into(), 280.into(), 380.into()],
            },
        );
        document.set_object(
            tree,
            dictionary! {
                "Type" => "Pages", "Count" => 3, "Kids" => vec![Object::Reference(subtree)],
                "MediaBox" => vec![0.into(), 0.into(), 300.into(), 400.into()],
                "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
            },
        );
        let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => tree });
        document.trailer.set("Root", catalog);
        let link = |page| {
            dictionary! {
                "Subtype" => "Link", "Rect" => vec![0.into(), 0.into(), 30.into(), 30.into()],
                "Dest" => vec![Object::Reference(page), Object::Name(b"Fit".to_vec())],
            }
        };
        let removed_link = document.add_object(link(pages[0]));
        let kept_link = document.add_object(link(pages[2]));
        let note = document.add_object(dictionary! { "Subtype" => "Text", "Rect" => vec![0.into(), 0.into(), 30.into(), 30.into()], "Contents" => Object::string_literal("review note") });
        document.get_dictionary_mut(pages[1]).unwrap().set(
            "Annots",
            [removed_link, kept_link, note]
                .map(Object::Reference)
                .to_vec(),
        );
        let widget = document.add_object(dictionary! { "Subtype" => "Widget" });
        document
            .get_dictionary_mut(pages[0])
            .unwrap()
            .set("Annots", vec![Object::Reference(widget)]);
        let mut organized = document.clone();
        let source = |page, rotation| PdfPageSelection::Source { page, rotation };
        assert!(organize_pages(
            &mut organized,
            &[source(3, 0), source(2, 90), source(2, 0)],
            false
        )
        .is_err());
        assert_eq!(organized.page_iter().collect::<Vec<_>>(), pages);
        organize_pages(
            &mut organized,
            &[source(3, 270), source(1, 0), source(2, 90)],
            false,
        )
        .unwrap();
        assert_eq!(
            organized.page_iter().collect::<Vec<_>>(),
            [pages[2], pages[0], pages[1]]
        );
        assert_eq!(organized.extract_text(&[1]).unwrap().trim(), "final words");
        assert_eq!(
            organized
                .catalog()
                .unwrap()
                .get(b"Pages")
                .unwrap()
                .as_reference()
                .unwrap(),
            tree
        );
        let rotated = organized.get_dictionary(pages[2]).unwrap();
        assert_eq!(rotated.get(b"Rotate").unwrap().as_i64().unwrap(), 0);
        assert_eq!(
            rotated.get(b"CropBox").unwrap().as_array().unwrap()[2]
                .as_i64()
                .unwrap(),
            280
        );
        let link = organized
            .get_dictionary(kept_link)
            .unwrap()
            .get(b"Dest")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(link[0].as_reference().unwrap(), pages[2]);
        let mut edited = document.clone();
        organize_pages(
            &mut edited,
            &[
                source(3, 0),
                PdfPageSelection::Blank {
                    width: 595.2756,
                    height: 841.8898,
                    rotation: 90,
                },
                source(2, 0),
            ],
            false,
        )
        .unwrap();
        assert_eq!(edited.page_iter().count(), 3);
        assert!(edited.extract_text(&[1]).unwrap().contains("final words"));
        assert!(edited
            .extract_text(&[3])
            .unwrap()
            .contains("retained words"));
        let blank = edited.get_dictionary(edited.get_pages()[&2]).unwrap();
        assert!(blank.get(b"Contents").is_err());
        assert_eq!(blank.get(b"Rotate").unwrap().as_i64().unwrap(), 90);
        assert!(!edited.objects.contains_key(&pages[0]));
        assert!(!edited.objects.contains_key(&removed_link));
        let mut edited_bytes = Vec::new();
        edited.save_to(&mut edited_bytes).unwrap();
        assert!(!edited_bytes
            .windows(b"omitted words".len())
            .any(|window| window == b"omitted words"));
        let reopened = Document::load_mem(&edited_bytes).unwrap();
        assert_eq!(reopened.page_iter().count(), 3);
        assert!(retain_page_range(&mut document, 1..=2).is_err());
        assert_eq!(document.page_iter().collect::<Vec<_>>(), pages);

        retain_page_range(&mut document, 2..=3).unwrap();
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();
        assert!(!bytes
            .windows(b"omitted words".len())
            .any(|window| window == b"omitted words"));
        let saved = Document::load_mem(&bytes).unwrap();
        let output_pages = saved.get_pages();
        assert_eq!(output_pages.len(), 2);
        assert!(saved.extract_text(&[1]).unwrap().contains("retained words"));
        assert!(saved.extract_text(&[2]).unwrap().contains("final words"));
        let page = saved.get_dictionary(output_pages[&1]).unwrap();
        assert_eq!(page.get(b"Rotate").unwrap().as_i64().unwrap(), 90);
        assert_eq!(
            page.get(b"MediaBox").unwrap().as_array().unwrap()[3]
                .as_i64()
                .unwrap(),
            400
        );
        assert_eq!(
            page.get(b"CropBox").unwrap().as_array().unwrap()[3]
                .as_i64()
                .unwrap(),
            380
        );
        let annots = page.get(b"Annots").unwrap().as_array().unwrap();
        assert_eq!(annots.len(), 2);
        let link = saved
            .get_dictionary(annots[0].as_reference().unwrap())
            .unwrap();
        let destination = link.get(b"Dest").unwrap().as_array().unwrap()[0]
            .as_reference()
            .unwrap();
        assert_eq!(destination, output_pages[&2]);
        let note = saved
            .get_dictionary(annots[1].as_reference().unwrap())
            .unwrap();
        assert_eq!(
            note.get(b"Contents").unwrap().as_str().unwrap(),
            b"review note"
        );
    }
}
