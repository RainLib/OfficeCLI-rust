//! PDF text planning and presentation mutations.
use super::*;

#[derive(Clone)]
pub(super) struct PdfTextInsertion {
    pub(super) page: usize,
    pub(super) node_id: String,
    pub(super) x_pt: f32,
    pub(super) y_pt: f32,
    pub(super) width_pt: f32,
    pub(super) height_pt: f32,
    pub(super) font_size_pt: f32,
    pub(super) text: String,
}

#[derive(Clone)]
pub(super) struct PdfGeometryChange {
    pub(super) geometry: PdfTextGeometry,
    pub(super) expected: PdfTextGeometry,
    pub(super) node_hash: String,
}

pub(super) fn collect_pdf_insertions(patch: &PatchBatch) -> HashMap<String, Vec<PdfTextInsertion>> {
    let mut grouped: HashMap<String, Vec<PdfTextInsertion>> = HashMap::new();
    for (index, operation) in patch.operations.iter().enumerate() {
        let PatchOperation::PdfTextInsert {
            page,
            x_pt,
            y_pt,
            width_pt,
            height_pt,
            font_size_pt,
            text,
        } = operation
        else {
            continue;
        };
        let part = format!("pdf/pages/{page}");
        let chunk_id =
            stable_node_id(&[&patch.document_id, &part, "page-chunk", "0"]).replacen("n_", "c_", 1);
        let node_id = stable_node_id(&[
            &patch.document_id,
            &patch.patch_id,
            &index.to_string(),
            "pdf-text-insert",
        ]);
        grouped.entry(chunk_id).or_default().push(PdfTextInsertion {
            page: *page,
            node_id,
            x_pt: *x_pt,
            y_pt: *y_pt,
            width_pt: *width_pt,
            height_pt: *height_pt,
            font_size_pt: *font_size_pt,
            text: text.clone(),
        });
    }
    grouped
}

pub(super) fn collect_pdf_geometry(patch: &PatchBatch) -> HashMap<String, PdfGeometryChange> {
    patch
        .operations
        .iter()
        .filter_map(|operation| {
            let PatchOperation::PdfTextGeometry {
                node_id,
                geometry,
                precondition,
            } = operation
            else {
                return None;
            };
            Some((
                node_id.clone(),
                PdfGeometryChange {
                    geometry: *geometry,
                    expected: precondition.geometry,
                    node_hash: precondition.node_hash.clone(),
                },
            ))
        })
        .collect()
}

pub(super) fn collect_pdf_deletions(patch: &PatchBatch) -> HashMap<String, String> {
    patch
        .operations
        .iter()
        .filter_map(|operation| {
            let PatchOperation::PdfTextDelete {
                node_id,
                precondition,
            } = operation
            else {
                return None;
            };
            Some((node_id.clone(), precondition.node_hash.clone()))
        })
        .collect()
}

pub(super) fn valid_pdf_text_geometry(geometry: PdfTextGeometry) -> bool {
    [
        geometry.x_pt,
        geometry.y_pt,
        geometry.width_pt,
        geometry.height_pt,
    ]
    .into_iter()
    .all(f32::is_finite)
        && geometry.x_pt >= 0.0
        && geometry.y_pt >= 0.0
        && geometry.width_pt >= 1.0
        && geometry.height_pt >= 1.0
        && geometry.x_pt + geometry.width_pt <= 14_400.0
        && geometry.y_pt + geometry.height_pt <= 14_400.0
}

pub(super) fn pdf_page_dimensions(html: &str, page: usize) -> Result<(f32, f32), HcdError> {
    let tag_end = html
        .find('>')
        .ok_or_else(|| HcdError::InvalidBundle("PDF page tag is missing".to_string()))?;
    let tag = &html[..tag_end];
    if !tag.starts_with("<section class=\"hcd-pdf-page\"")
        || !tag.contains(&format!("data-hcd-page=\"{page}\""))
        || !tag.contains("data-hcd-continuation=\"false\"")
        || !tag.contains("data-hcd-source-raster=\"true\"")
    {
        return Err(HcdError::InvalidBundle(format!(
            "PDF page {page} has no primary raster chunk"
        )));
    }
    let style = tag
        .split_once("style=\"")
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(value, _)| value)
        .ok_or_else(|| HcdError::InvalidBundle("PDF page style is missing".to_string()))?;
    let dimension = |name: &str| -> Result<f32, HcdError> {
        let value = style
            .split(';')
            .find_map(|property| property.trim().strip_prefix(name))
            .and_then(|value| value.strip_suffix("pt"))
            .ok_or_else(|| HcdError::InvalidBundle(format!("PDF page {name} is missing")))?;
        let parsed: f32 = value
            .parse()
            .map_err(|_| HcdError::InvalidBundle(format!("PDF page {name} is invalid")))?;
        if !parsed.is_finite() || parsed <= 0.0 || parsed > 14_400.0 {
            return Err(HcdError::InvalidBundle(format!(
                "PDF page {name} exceeds safe limits"
            )));
        }
        Ok(parsed)
    };
    Ok((dimension("width:")?, dimension("height:")?))
}

pub(super) fn insert_pdf_text(
    html: &mut String,
    source_map: &mut crate::ChunkSourceMap,
    insertion: &PdfTextInsertion,
) -> Result<(), HcdError> {
    let (page_width, page_height) = pdf_page_dimensions(html, insertion.page)?;
    if insertion.x_pt + insertion.width_pt > page_width
        || insertion.y_pt + insertion.height_pt > page_height
    {
        return Err(HcdError::InvalidPatch(format!(
            "PDF text box is outside page {}",
            insertion.page
        )));
    }
    if source_map
        .entries
        .iter()
        .any(|entry| entry.node_id == insertion.node_id)
    {
        return Err(HcdError::InvalidPatch(
            "PDF text node ID already exists".to_string(),
        ));
    }
    let ordinal = source_map
        .entries
        .iter()
        .map(|entry| entry.source.text_ordinal)
        .max()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| HcdError::ResourceLimit("PDF text ordinal overflowed".to_string()))?;
    let source_path = format!("/page[{}]/hcd-text[{}]", insertion.page, insertion.node_id);
    let node_hash = hash_bytes(insertion.text.as_bytes());
    let top = page_height - insertion.y_pt - insertion.height_pt;
    let block = format!(
        "<p class=\"hcd-pdf-text\" data-hcd-text-node=\"{}\" data-hcd-source-path=\"{source_path}\" data-hcd-source-order=\"{ordinal}\" data-hcd-mapping=\"hcd-overlay\" data-hcd-bbox=\"{},{},{},{}\" data-hcd-x=\"{}\" data-hcd-y=\"{}\" data-hcd-width=\"{}\" data-hcd-height=\"{}\" style=\"position:absolute;left:{}pt;top:{top}pt;width:{}pt;height:{}pt;font-family:Arial, Helvetica, sans-serif;font-size:{}pt;font-weight:normal;font-style:normal;color:black;line-height:{}pt\"><span data-hcd-id=\"{}\" data-hcd-node-hash=\"{node_hash}\" data-hcd-patched=\"true\">{}</span></p>",
        insertion.node_id,
        insertion.x_pt, insertion.y_pt, insertion.width_pt, insertion.height_pt,
        insertion.x_pt, insertion.y_pt, insertion.width_pt, insertion.height_pt,
        insertion.x_pt, insertion.width_pt, insertion.height_pt,
        insertion.font_size_pt, insertion.font_size_pt,
        insertion.node_id, escape_text(&insertion.text),
    );
    let end = html
        .rfind("</section>")
        .ok_or_else(|| HcdError::InvalidBundle("PDF page closing tag is missing".to_string()))?;
    html.insert_str(end, &block);
    source_map.entries.push(NodeMapEntry {
        node_id: insertion.node_id.clone(),
        node_hash,
        source: SourceAnchor {
            source_cell_ref: None,
            created_in_hcd: false,
            part: format!("pdf/pages/{}", insertion.page),
            text_ordinal: ordinal,
            paragraph_id: Some(source_path),
            text_id: None,
            node_kind: "pdf-text".to_string(),
            editable: true,
        },
    });
    Ok(())
}

pub(super) fn update_pdf_text_geometry(
    html: &mut String,
    entry: &NodeMapEntry,
    change: &PdfGeometryChange,
) -> Result<(), HcdError> {
    let page = entry
        .source
        .part
        .strip_prefix("pdf/pages/")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|page| *page > 0)
        .ok_or_else(|| {
            HcdError::InvalidBundle("PDF text box page locator is invalid".to_string())
        })?;
    let source_path = format!("/page[{page}]/hcd-text[{}]", entry.node_id);
    if entry.source.paragraph_id.as_deref() != Some(source_path.as_str()) {
        return Err(HcdError::Unsupported(
            "PDF geometry is available only for HCD-created text boxes".to_string(),
        ));
    }
    let (page_width, page_height) = pdf_page_dimensions(html, page)?;
    let geometry = change.geometry;
    if geometry.x_pt + geometry.width_pt > page_width
        || geometry.y_pt + geometry.height_pt > page_height
    {
        return Err(HcdError::InvalidPatch(
            "PDF text box must stay inside its page".to_string(),
        ));
    }
    let marker = format!("data-hcd-text-node=\"{}\"", entry.node_id);
    let location = html.find(&marker).ok_or_else(|| {
        HcdError::InvalidBundle("PDF text box is missing from the page".to_string())
    })?;
    let start = html[..location]
        .rfind("<p class=\"hcd-pdf-text\"")
        .ok_or_else(|| {
            HcdError::Unsupported("PDF text is not inside an editable text box".to_string())
        })?;
    let end = html[location..]
        .find('>')
        .map(|offset| location + offset)
        .ok_or_else(|| HcdError::InvalidBundle("PDF text box tag is not closed".to_string()))?;
    if html[start..location].contains('>') {
        return Err(HcdError::InvalidBundle(
            "PDF text box tag is invalid".to_string(),
        ));
    }
    let tag = &html[start..=end];
    if xlsx_attribute(tag, "data-hcd-mapping") != Some("hcd-overlay")
        || xlsx_attribute(tag, "data-hcd-source-path") != Some(source_path.as_str())
    {
        return Err(HcdError::Unsupported(
            "PDF text is not an HCD overlay".to_string(),
        ));
    }
    let number = |name: &str| -> Result<f32, HcdError> {
        xlsx_attribute(tag, name)
            .and_then(|value| value.parse::<f32>().ok())
            .filter(|value| value.is_finite())
            .ok_or_else(|| HcdError::InvalidBundle(format!("PDF text box {name} is invalid")))
    };
    let current = PdfTextGeometry {
        x_pt: number("data-hcd-x")?,
        y_pt: number("data-hcd-y")?,
        width_pt: number("data-hcd-width")?,
        height_pt: number("data-hcd-height")?,
    };
    if current != change.expected {
        return Err(HcdError::PreconditionFailed(
            "PDF text box moved since it was selected".to_string(),
        ));
    }
    let style = xlsx_attribute(tag, "style")
        .ok_or_else(|| HcdError::InvalidBundle("PDF text box style is missing".to_string()))?;
    let left = format!("{}pt", geometry.x_pt);
    let top = format!("{}pt", page_height - geometry.y_pt - geometry.height_pt);
    let width = format!("{}pt", geometry.width_pt);
    let height = format!("{}pt", geometry.height_pt);
    let mut found = HashSet::new();
    let updated_style = style
        .split(';')
        .map(|property| {
            let (name, _) = property.split_once(':').unwrap_or((property, ""));
            let name = name.trim();
            let replacement = match name {
                "left" => Some(&left),
                "top" => Some(&top),
                "width" => Some(&width),
                "height" => Some(&height),
                _ => None,
            };
            if let Some(value) = replacement {
                found.insert(name);
                format!("{name}:{value}")
            } else {
                property.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(";");
    if found.len() != 4 {
        return Err(HcdError::InvalidBundle(
            "PDF text box lacks positioned style properties".to_string(),
        ));
    }
    let bbox = format!(
        "{},{},{},{}",
        geometry.x_pt, geometry.y_pt, geometry.width_pt, geometry.height_pt
    );
    for (name, value) in [
        ("data-hcd-x", geometry.x_pt.to_string()),
        ("data-hcd-y", geometry.y_pt.to_string()),
        ("data-hcd-width", geometry.width_pt.to_string()),
        ("data-hcd-height", geometry.height_pt.to_string()),
        ("data-hcd-bbox", bbox),
        ("style", updated_style),
    ] {
        let tag_end = html[start..]
            .find('>')
            .map(|offset| start + offset)
            .ok_or_else(|| HcdError::InvalidBundle("PDF text box tag is not closed".to_string()))?;
        set_attribute_in_range(html, start, tag_end, name, &value)?;
    }
    Ok(())
}

pub(super) fn delete_pdf_text(html: &mut String, entry: &NodeMapEntry) -> Result<(), HcdError> {
    let page = entry
        .source
        .part
        .strip_prefix("pdf/pages/")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|page| *page > 0)
        .ok_or_else(|| {
            HcdError::InvalidBundle("PDF text box page locator is invalid".to_string())
        })?;
    let source_path = format!("/page[{page}]/hcd-text[{}]", entry.node_id);
    if entry.source.paragraph_id.as_deref() != Some(source_path.as_str()) {
        return Err(HcdError::Unsupported(
            "PDF deletion is available only for HCD-created text boxes".to_string(),
        ));
    }
    let marker = format!("data-hcd-text-node=\"{}\"", entry.node_id);
    let location = html.find(&marker).ok_or_else(|| {
        HcdError::InvalidBundle("PDF text box is missing from the page".to_string())
    })?;
    let start = html[..location]
        .rfind("<p class=\"hcd-pdf-text\"")
        .ok_or_else(|| HcdError::InvalidBundle("PDF text box tag is missing".to_string()))?;
    let tag_end = html[location..]
        .find('>')
        .map(|offset| location + offset)
        .ok_or_else(|| HcdError::InvalidBundle("PDF text box tag is not closed".to_string()))?;
    if html[start..location].contains('>') {
        return Err(HcdError::InvalidBundle(
            "PDF text box tag is invalid".to_string(),
        ));
    }
    let tag = &html[start..=tag_end];
    if xlsx_attribute(tag, "data-hcd-mapping") != Some("hcd-overlay")
        || xlsx_attribute(tag, "data-hcd-source-path") != Some(source_path.as_str())
    {
        return Err(HcdError::Unsupported(
            "PDF text is not an HCD overlay".to_string(),
        ));
    }
    let close = html[tag_end + 1..]
        .find("</p>")
        .map(|offset| tag_end + 1 + offset + "</p>".len())
        .ok_or_else(|| {
            HcdError::InvalidBundle("PDF text box closing tag is missing".to_string())
        })?;
    if !html[tag_end + 1..close].contains(&format!("data-hcd-id=\"{}\"", entry.node_id)) {
        return Err(HcdError::InvalidBundle(
            "PDF text box does not contain its mapped text node".to_string(),
        ));
    }
    html.replace_range(start..close, "");
    Ok(())
}

pub(super) fn validate_pdf_schema(
    manifest: &crate::HcdManifest,
    patch: &PatchBatch,
) -> Result<(), HcdError> {
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_23
        && (manifest.source.format != "pdf"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::PdfTextGeometry { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/23 accepts one PDF text-box geometry edit only".to_string(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_24
        && (manifest.source.format != "pdf"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::PdfTextDelete { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/24 accepts one PDF text-box deletion only".to_string(),
        ));
    }
    if matches!(
        patch.schema_version.as_str(),
        crate::HCD_PATCH_SCHEMA_VERSION_52 | crate::HCD_PATCH_SCHEMA_VERSION_53
    ) && (patch.operations.len() != 1
        || !matches!(
            patch.operations.first(),
            Some(PatchOperation::PdfPageLayoutSet { .. })
        ))
    {
        return Err(HcdError::Unsupported(
            "PDF page layout patches accept one layout operation".into(),
        ));
    }
    Ok(())
}
