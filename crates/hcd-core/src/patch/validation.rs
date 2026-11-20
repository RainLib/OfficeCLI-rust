//! Shared patch identity, resource and operation validation.
use super::*;

pub(super) fn validate_patch_identity(
    manifest: &crate::HcdManifest,
    patch: &PatchBatch,
) -> Result<(), HcdError> {
    if patch.schema_version != HCD_PATCH_SCHEMA_VERSION
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_2
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_3
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_5
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_6
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_7
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_8
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_9
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_10
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_11
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_12
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_13
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_14
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_15
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_16
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_17
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_18
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_19
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_20
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_21
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_22
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_23
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_24
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_25
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_26
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_27
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_28
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_29
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_30
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_31
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_32
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_33
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_34
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_35
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_36
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_41
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_42
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_43
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_44
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_45
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_49
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_50
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_48
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_47
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_46
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_37
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_51
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_52
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_53
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_54
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_55
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_56
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_57
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_58
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_59
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_60
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_61
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_62
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_63
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_64
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_65
        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_66
    {
        return Err(HcdError::InvalidPatch(format!(
            "unsupported schema version {}",
            patch.schema_version
        )));
    }
    validate_identifier("documentId", &patch.document_id)?;
    if patch.document_id != manifest.document_id {
        return Err(HcdError::InvalidPatch(
            "documentId does not match the bundle manifest".to_string(),
        ));
    }
    if patch.patch_id.trim().is_empty() {
        return Err(HcdError::InvalidPatch("patchId is required".to_string()));
    }
    if patch.patch_id.len() > MAX_IDENTIFIER_BYTES {
        return Err(HcdError::ResourceLimit(format!(
            "patchId exceeds {MAX_IDENTIFIER_BYTES} bytes"
        )));
    }
    if patch.operations.is_empty() || patch.operations.len() > MAX_PATCH_OPERATIONS {
        return Err(HcdError::ResourceLimit(format!(
            "patch operation count must be between 1 and {MAX_PATCH_OPERATIONS}"
        )));
    }
    validate_xlsx_schema(manifest, patch)?;
    validate_pptx_schema(manifest, patch)?;
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_56
        && !matches!(
            patch.operations.as_slice(),
            [PatchOperation::XlsxChartSet { .. }]
        )
    {
        return Err(HcdError::InvalidPatch(
            "hcd-patch/56 accepts one worksheet chart operation".into(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_57
        && !matches!(
            patch.operations.as_slice(),
            [PatchOperation::DocxPictureLayoutSet { .. }]
        )
    {
        return Err(HcdError::InvalidPatch(
            "hcd-patch/57 accepts one Word picture layout operation".into(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_58
        && !matches!(
            patch.operations.as_slice(),
            [PatchOperation::XlsxConditionSet { .. }]
        )
    {
        return Err(HcdError::InvalidPatch(
            "hcd-patch/58 accepts one worksheet condition operation".into(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_59
        && !matches!(
            patch.operations.as_slice(),
            [PatchOperation::XlsxPivotSet { .. }]
        )
    {
        return Err(HcdError::InvalidPatch(
            "hcd-patch/59 accepts one pivot operation".into(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_60
        && !matches!(
            patch.operations.as_slice(),
            [PatchOperation::PptxAnimationsSet { .. }]
        )
    {
        return Err(HcdError::InvalidPatch(
            "hcd-patch/60 accepts one animation operation".into(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_61
        && !matches!(
            patch.operations.as_slice(),
            [PatchOperation::PptxMasterBackgroundSet { .. }]
        )
    {
        return Err(HcdError::InvalidPatch(
            "hcd-patch/61 accepts one master background operation".into(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_66
        && !matches!(
            patch.operations.as_slice(),
            [PatchOperation::PptxMasterTextStyleSet { .. }]
        )
    {
        return Err(HcdError::InvalidPatch(
            "hcd-patch/66 accepts one master text style operation".into(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_62
        && !matches!(
            patch.operations.as_slice(),
            [PatchOperation::PdfOcrApply { .. }]
        )
    {
        return Err(HcdError::InvalidPatch(
            "hcd-patch/62 accepts one PDF OCR operation".into(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_63
        && !matches!(
            patch.operations.as_slice(),
            [PatchOperation::ImageLayersSet { .. }]
        )
    {
        return Err(HcdError::InvalidPatch(
            "hcd-patch/63 accepts one image layer operation".into(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_64
        && !matches!(
            patch.operations.as_slice(),
            [PatchOperation::PptxGroupCreate { .. } | PatchOperation::PptxGroupUngroup { .. }]
        )
    {
        return Err(HcdError::InvalidPatch(
            "hcd-patch/64 accepts one slide group operation".into(),
        ));
    }
    validate_pdf_schema(manifest, patch)?;
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_47
        && patch
            .operations
            .iter()
            .any(|op| !matches!(op, PatchOperation::ImageInsert { .. }))
    {
        return Err(HcdError::InvalidPatch(
            "hcd-patch/47 accepts image.insert operations only".into(),
        ));
    }
    validate_string_map("actor", &patch.actor, MAX_ACTOR_ENTRIES, MAX_ACTOR_BYTES)?;
    validate_string_map(
        "metadata",
        &patch.metadata,
        MAX_METADATA_ENTRIES,
        MAX_METADATA_BYTES,
    )?;
    let mut inserted = 0usize;
    for operation in &patch.operations {
        match operation {
            PatchOperation::TextSplice {
                node_id,
                insert_text,
                precondition,
                ..
            } => {
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
                if insert_text.len() > MAX_PATCH_INSERT_BYTES {
                    return Err(HcdError::ResourceLimit(format!(
                        "one text.splice inserts {} bytes; maximum is {MAX_PATCH_INSERT_BYTES}",
                        insert_text.len()
                    )));
                }
                inserted = inserted.checked_add(insert_text.len()).ok_or_else(|| {
                    HcdError::ResourceLimit("patch insert byte count overflowed".to_string())
                })?;
            }
            PatchOperation::TextFont {
                node_id,
                font,
                precondition,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_37 {
                    return Err(HcdError::InvalidPatch(
                        "text.font requires schemaVersion hcd-patch/37".to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
                validate_font_patch(font)?;
            }
            PatchOperation::TextFontClear {
                node_id,
                precondition,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_37 {
                    return Err(HcdError::InvalidPatch(
                        "text.font.clear requires schemaVersion hcd-patch/37".to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
            }
            PatchOperation::PdfOcrApply { pages } => {
                if manifest.source.format != "pdf"
                    || patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_62
                {
                    return Err(HcdError::Unsupported(
                        "positioned OCR requires a PDF and hcd-patch/62".into(),
                    ));
                }
                crate::pdf_ocr::validate_ocr_pages(pages)?;
            }
            PatchOperation::PdfTextInsert {
                page,
                x_pt,
                y_pt,
                width_pt,
                height_pt,
                font_size_pt,
                text,
            } => {
                if patch.schema_version != HCD_PATCH_SCHEMA_VERSION_5
                    || manifest.source.format != "pdf"
                {
                    return Err(HcdError::Unsupported(
                        "pdf.text.insert requires a PDF bundle and hcd-patch/5".to_string(),
                    ));
                }
                if *page == 0 || *page > manifest.chunk_count {
                    return Err(HcdError::InvalidPatch(
                        "PDF page is outside the document".to_string(),
                    ));
                }
                if !x_pt.is_finite()
                    || !y_pt.is_finite()
                    || !width_pt.is_finite()
                    || !height_pt.is_finite()
                    || !font_size_pt.is_finite()
                    || *x_pt < 0.0
                    || *y_pt < 0.0
                    || *width_pt <= 0.0
                    || *height_pt <= 0.0
                    || *x_pt > 14_400.0
                    || *y_pt > 14_400.0
                    || *width_pt > 14_400.0
                    || *height_pt > 14_400.0
                    || !(1.0..=256.0).contains(font_size_pt)
                {
                    return Err(HcdError::InvalidPatch(
                        "PDF text box geometry is invalid".to_string(),
                    ));
                }
                if text.trim().is_empty()
                    || text.chars().count() > 10_000
                    || text.contains(['\r', '\n'])
                    || text.chars().any(is_forbidden_xml_character)
                {
                    return Err(HcdError::InvalidPatch(
                        "PDF text box is empty or contains unsupported text".to_string(),
                    ));
                }
                inserted = inserted.checked_add(text.len()).ok_or_else(|| {
                    HcdError::ResourceLimit("patch insert byte count overflowed".to_string())
                })?;
            }
            PatchOperation::PptxTextInsert {
                chunk_id,
                slide_part,
                x_emu,
                y_emu,
                width_emu,
                height_emu,
                font_size_pt,
                text,
            } => {
                if patch.schema_version != HCD_PATCH_SCHEMA_VERSION_16
                    || manifest.source.format != "pptx"
                {
                    return Err(HcdError::Unsupported(
                        "pptx.text.insert requires a PPTX bundle and hcd-patch/16".to_string(),
                    ));
                }
                if !chunk_id.starts_with("c_")
                    || chunk_id.len() != 34
                    || !chunk_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return Err(HcdError::InvalidPatch(
                        "PPTX chunk ID is invalid".to_string(),
                    ));
                }
                let number = slide_part
                    .strip_prefix("ppt/slides/slide")
                    .and_then(|part| part.strip_suffix(".xml"));
                if !number.is_some_and(|part| {
                    !part.starts_with('0') && part.parse::<u32>().is_ok_and(|value| value > 0)
                }) {
                    return Err(HcdError::InvalidPatch(
                        "PPTX slide part is invalid".to_string(),
                    ));
                }
                if *x_emu > 100_000_000
                    || *y_emu > 100_000_000
                    || !(1..=100_000_000).contains(width_emu)
                    || !(1..=100_000_000).contains(height_emu)
                    || !font_size_pt.is_finite()
                    || !(1.0..=256.0).contains(font_size_pt)
                {
                    return Err(HcdError::InvalidPatch(
                        "PPTX text box geometry is invalid".to_string(),
                    ));
                }
                if text.trim().is_empty()
                    || text.chars().count() > 10_000
                    || text.contains(['\r', '\n'])
                    || text.chars().any(is_forbidden_xml_character)
                {
                    return Err(HcdError::InvalidPatch(
                        "PPTX text box is empty or contains unsupported text".to_string(),
                    ));
                }
                inserted = inserted.checked_add(text.len()).ok_or_else(|| {
                    HcdError::ResourceLimit("patch insert byte count overflowed".to_string())
                })?;
            }
            PatchOperation::PptxShapeGeometry {
                node_id,
                geometry,
                precondition,
            } => {
                if patch.schema_version != HCD_PATCH_SCHEMA_VERSION_17
                    || manifest.source.format != "pptx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "pptx.shape.geometry requires one operation on a PPTX bundle with hcd-patch/17"
                            .to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
                if !valid_pptx_geometry(*geometry)
                    || !valid_pptx_geometry(precondition.geometry)
                    || *geometry == precondition.geometry
                {
                    return Err(HcdError::InvalidPatch(
                        "PPTX shape geometry is invalid or unchanged".to_string(),
                    ));
                }
            }
            PatchOperation::PptxShapeInsert {
                chunk_id,
                geometry,
                fill,
                stroke,
                ..
            } => {
                require_pptx_object_patch(manifest, patch, chunk_id)?;
                validate_hex_color("fill", fill)?;
                validate_hex_color("stroke", stroke)?;
                if !valid_pptx_geometry(*geometry) {
                    return Err(HcdError::InvalidPatch("invalid PPTX shape bounds".into()));
                }
            }
            PatchOperation::PptxObjectsTransform { chunk_id, objects } => {
                require_pptx_object_patch(manifest, patch, chunk_id)?;
                let mut ids = HashSet::new();
                if objects.is_empty() || objects.len() > 64 {
                    return Err(HcdError::InvalidPatch(
                        "select between 1 and 64 PPTX objects".into(),
                    ));
                }
                for object in objects {
                    validate_node_id(&object.node_id)?;
                    if !ids.insert(&object.node_id)
                        || !valid_pptx_geometry(object.before)
                        || !valid_pptx_geometry(object.geometry)
                        || object.geometry == object.before
                    {
                        return Err(HcdError::InvalidPatch(
                            "invalid, repeated, or unchanged PPTX object bounds".into(),
                        ));
                    }
                }
            }
            PatchOperation::PptxGroupCreate { chunk_id, node_ids } => {
                require_pptx_group_patch(manifest, patch, chunk_id)?;
                let unique: HashSet<_> = node_ids.iter().collect();
                if !(2..=64).contains(&node_ids.len()) || unique.len() != node_ids.len() {
                    return Err(HcdError::InvalidPatch(
                        "select 2 to 64 distinct objects to group".into(),
                    ));
                }
                for node_id in node_ids {
                    validate_node_id(node_id)?;
                }
            }
            PatchOperation::PptxGroupUngroup { chunk_id, group_id } => {
                require_pptx_group_patch(manifest, patch, chunk_id)?;
                validate_node_id(group_id)?;
            }
            PatchOperation::PptxAnimationsSet { chunk_id, effects } => {
                if manifest.source.format != "pptx"
                    || patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_60
                {
                    return Err(HcdError::Unsupported(
                        "slide animations require PPTX and hcd-patch/60".into(),
                    ));
                }
                validate_identifier("chunkId", chunk_id)?;
                crate::pptx_animation::validate_pptx_animations(effects)?;
            }
            PatchOperation::PptxMasterBackgroundSet { chunk_id, color } => {
                if manifest.source.format != "pptx"
                    || patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_61
                {
                    return Err(HcdError::Unsupported(
                        "master backgrounds require PPTX and hcd-patch/61".into(),
                    ));
                }
                validate_identifier("chunkId", chunk_id)?;
                if !crate::pptx_design::valid_pptx_background(color) {
                    return Err(HcdError::InvalidPatch(
                        "expected a six-digit RGB master background".into(),
                    ));
                }
            }
            PatchOperation::PptxMasterTextStyleSet { chunk_id, style } => {
                if manifest.source.format != "pptx"
                    || patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_66
                {
                    return Err(HcdError::Unsupported(
                        "master text styles require PPTX and hcd-patch/66".into(),
                    ));
                }
                validate_identifier("chunkId", chunk_id)?;
                crate::pptx_design::validate_master_text_style(style)?;
            }
            PatchOperation::XlsxChartSet {
                sheet_id,
                chart_id,
                config,
            } => {
                if manifest.source.format != "xlsx"
                    || patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_56
                {
                    return Err(HcdError::Unsupported(
                        "worksheet charts require XLSX and hcd-patch/56".into(),
                    ));
                }
                validate_identifier("sheetId", sheet_id)?;
                if !valid_worksheet_chart_id(chart_id) {
                    return Err(HcdError::InvalidPatch("invalid worksheet chart ID".into()));
                }
                if let Some(config) = config {
                    validate_worksheet_chart(config)?;
                }
            }
            PatchOperation::XlsxPivotSet {
                sheet_id,
                pivot_id,
                config,
            } => {
                if manifest.source.format != "xlsx"
                    || patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_59
                {
                    return Err(HcdError::Unsupported(
                        "worksheet pivots require XLSX and hcd-patch/59".into(),
                    ));
                }
                validate_identifier("sheetId", sheet_id)?;
                if !valid_worksheet_chart_id(pivot_id) {
                    return Err(HcdError::InvalidPatch("invalid worksheet pivot ID".into()));
                }
                if let Some(config) = config {
                    validate_worksheet_pivot(config)?;
                }
            }
            PatchOperation::XlsxConditionSet {
                sheet_id,
                condition_id,
                config,
            } => {
                if manifest.source.format != "xlsx"
                    || patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_58
                {
                    return Err(HcdError::Unsupported(
                        "worksheet conditions require XLSX and hcd-patch/58".into(),
                    ));
                }
                validate_identifier("sheetId", sheet_id)?;
                if !valid_worksheet_chart_id(condition_id) {
                    return Err(HcdError::InvalidPatch(
                        "invalid worksheet condition ID".into(),
                    ));
                }
                if let Some(config) = config {
                    validate_worksheet_condition(config)?;
                }
            }
            PatchOperation::PdfTextGeometry {
                node_id,
                geometry,
                precondition,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_23
                    || manifest.source.format != "pdf"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "pdf.text.geometry requires one PDF operation with hcd-patch/23"
                            .to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
                if !valid_pdf_text_geometry(*geometry)
                    || !valid_pdf_text_geometry(precondition.geometry)
                    || *geometry == precondition.geometry
                {
                    return Err(HcdError::InvalidPatch(
                        "PDF text-box geometry is invalid or unchanged".to_string(),
                    ));
                }
            }
            PatchOperation::PdfTextDelete {
                node_id,
                precondition,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_24
                    || manifest.source.format != "pdf"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "pdf.text.delete requires one PDF operation with hcd-patch/24".to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
            }
            PatchOperation::PptxTextDelete {
                node_id,
                precondition,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_27
                    || manifest.source.format != "pptx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "pptx.text.delete requires one PPTX operation with hcd-patch/27"
                            .to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
            }
            PatchOperation::PptxRunFormat {
                node_id,
                format,
                precondition,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_30
                    || manifest.source.format != "pptx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "pptx.run.format requires one PPTX operation with hcd-patch/30".to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
                validate_pptx_run_format(format)?;
            }
            PatchOperation::PptxShapeAlign {
                node_id,
                align,
                precondition,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_46
                    || manifest.source.format != "pptx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "pptx.shape.align requires one PPTX operation with hcd-patch/46"
                            .to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
                validate_pptx_shape_align(align)?;
            }
            PatchOperation::XlsxRichTextSet {
                node_id,
                runs,
                precondition,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_49
                    && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_50
                    && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_65
                    && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_66
                    || manifest.source.format != "xlsx"
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.richText.set requires XLSX hcd-patch/49, /50 or /65".into(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
                inserted += validate_xlsx_rich_runs(runs)?;
            }
            PatchOperation::XlsxRichTextCreate {
                sheet_id,
                row,
                column,
                runs,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_50
                    || manifest.source.format != "xlsx"
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.richText.create requires XLSX hcd-patch/50".into(),
                    ));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                    || !(1..=1_048_576).contains(row)
                    || !(1..=16_384).contains(column)
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX rich-text creation address".into(),
                    ));
                }
                inserted += validate_xlsx_rich_runs(runs)?;
            }
            PatchOperation::XlsxCellFormat {
                node_id,
                format,
                precondition,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_31
                    || manifest.source.format != "xlsx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.cell.format requires one XLSX operation with hcd-patch/31"
                            .to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
                validate_xlsx_cell_format(format)?;
            }
            PatchOperation::XlsxCellLayout {
                node_id,
                layout,
                precondition,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_32
                    || manifest.source.format != "xlsx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.cell.layout requires one XLSX operation with hcd-patch/32"
                            .to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
                validate_xlsx_cell_layout(layout)?;
            }
            PatchOperation::XlsxCellNumberFormat {
                node_id,
                number_format,
                precondition,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_33
                    || manifest.source.format != "xlsx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.cell.numberFormat requires one XLSX operation with hcd-patch/33"
                            .to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
                validate_xlsx_number_format(number_format)?;
            }
            PatchOperation::XlsxSheetRename { sheet_id, name } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_34
                    || manifest.source.format != "xlsx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.sheet.rename requires one XLSX operation with hcd-patch/34"
                            .to_string(),
                    ));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX worksheet rename target".to_string(),
                    ));
                }
                validate_xlsx_sheet_name(name)?;
            }
            PatchOperation::XlsxSheetAdd { name } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_35
                    || manifest.source.format != "xlsx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.sheet.add requires one XLSX operation with hcd-patch/35".to_string(),
                    ));
                }
                validate_xlsx_sheet_name(name)?;
            }
            PatchOperation::XlsxSheetDelete { sheet_id } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_36
                    || manifest.source.format != "xlsx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.sheet.delete requires one XLSX operation with hcd-patch/36"
                            .to_string(),
                    ));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX worksheet deletion target".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxSheetFreeze {
                sheet_id,
                rows,
                columns,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_45
                    || manifest.source.format != "xlsx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.sheet.freeze requires one XLSX operation with hcd-patch/45"
                            .to_string(),
                    ));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX worksheet freeze target".to_string(),
                    ));
                }
                // A frozen pane always leaves a scrolling corner, so the last row
                // and the last column can never be frozen away.
                if *rows > 1_048_575 || *columns > 16_383 {
                    return Err(HcdError::InvalidPatch(
                        "XLSX freeze panes must leave at least one row and one column free"
                            .to_string(),
                    ));
                }
            }
            PatchOperation::PptxSlideAdd {} => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_41
                    || manifest.source.format != "pptx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "pptx.slide.add requires one PPTX operation with hcd-patch/41".to_string(),
                    ));
                }
            }
            PatchOperation::PptxSlideDelete { chunk_id } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_42
                    || manifest.source.format != "pptx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "pptx.slide.delete requires one PPTX operation with hcd-patch/42"
                            .to_string(),
                    ));
                }
                if chunk_id.len() != 34
                    || !chunk_id.starts_with("c_")
                    || !chunk_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid PPTX slide deletion target".to_string(),
                    ));
                }
            }
            PatchOperation::PptxSlideReorder {
                chunk_id,
                direction,
                target_index,
            } => {
                if (patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_43
                    && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_48)
                    || manifest.source.format != "pptx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "pptx.slide.reorder requires one PPTX operation with hcd-patch/43 or hcd-patch/48"
                            .to_string(),
                    ));
                }
                if chunk_id.len() != 34
                    || !chunk_id.starts_with("c_")
                    || !chunk_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid PPTX slide reorder target".to_string(),
                    ));
                }
                let valid_position = if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_48 {
                    direction.is_empty() && target_index.is_some_and(|index| index <= 100_000)
                } else {
                    target_index.is_none() && (direction == "up" || direction == "down")
                };
                if !valid_position {
                    return Err(HcdError::InvalidPatch(
                        "pptx.slide.reorder needs a direction in version 43 or a targetIndex in version 48".to_string(),
                    ));
                }
            }
            PatchOperation::PptxSlideCopy { chunk_id } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_44
                    || manifest.source.format != "pptx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "pptx.slide.copy requires one PPTX operation with hcd-patch/44".to_string(),
                    ));
                }
                if chunk_id.len() != 34
                    || !chunk_id.starts_with("c_")
                    || !chunk_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid PPTX slide copy target".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxMerge {
                node_id,
                sheet_id,
                start_row,
                start_column,
                end_row,
                end_column,
                precondition,
            } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_6
                        | HCD_PATCH_SCHEMA_VERSION_7
                        | HCD_PATCH_SCHEMA_VERSION_8
                        | HCD_PATCH_SCHEMA_VERSION_9
                        | HCD_PATCH_SCHEMA_VERSION_10
                        | HCD_PATCH_SCHEMA_VERSION_11
                        | HCD_PATCH_SCHEMA_VERSION_12
                        | HCD_PATCH_SCHEMA_VERSION_13
                        | HCD_PATCH_SCHEMA_VERSION_14
                        | HCD_PATCH_SCHEMA_VERSION_15
                ) || !manifest.source.is_spreadsheet()
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.merge requires one operation on an XLSX bundle with hcd-patch/6"
                            .to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                {
                    return Err(HcdError::InvalidPatch("invalid XLSX sheetId".to_string()));
                }
                validate_sha256("nodeHash", &precondition.node_hash)?;
                let rows = end_row.saturating_sub(*start_row).saturating_add(1);
                let columns = end_column.saturating_sub(*start_column).saturating_add(1);
                if *start_row == 0
                    || *start_column == 0
                    || *end_row > 1_048_576
                    || *end_column > 16_384
                    || *end_row < *start_row
                    || *end_column < *start_column
                    || rows.saturating_mul(columns) < 2
                    || rows.saturating_mul(columns) > 10_000
                {
                    return Err(HcdError::InvalidPatch(
                        "XLSX merge range must contain 2 to 10000 valid cells".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxMergeBlank {
                sheet_id,
                start_row,
                start_column,
                end_row,
                end_column,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_26
                    || !manifest.source.is_spreadsheet()
                    || patch.operations.len() != 1
                    || sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX blank merge target".to_string(),
                    ));
                }
                let rows = end_row.saturating_sub(*start_row).saturating_add(1);
                let columns = end_column.saturating_sub(*start_column).saturating_add(1);
                if *start_row == 0
                    || *start_column == 0
                    || *end_row > 1_048_576
                    || *end_column > 16_384
                    || *end_row < *start_row
                    || *end_column < *start_column
                    || rows.saturating_mul(columns) < 2
                    || rows.saturating_mul(columns) > 10_000
                {
                    return Err(HcdError::InvalidPatch(
                        "XLSX blank merge range must contain 2 to 10000 valid cells".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxCellSet {
                sheet_id,
                row,
                column,
                text,
            } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_7
                        | HCD_PATCH_SCHEMA_VERSION_8
                        | HCD_PATCH_SCHEMA_VERSION_9
                        | HCD_PATCH_SCHEMA_VERSION_10
                        | HCD_PATCH_SCHEMA_VERSION_11
                        | HCD_PATCH_SCHEMA_VERSION_12
                        | HCD_PATCH_SCHEMA_VERSION_13
                        | HCD_PATCH_SCHEMA_VERSION_14
                        | HCD_PATCH_SCHEMA_VERSION_15
                        | HCD_PATCH_SCHEMA_VERSION_19
                        | crate::HCD_PATCH_SCHEMA_VERSION_22
                        | crate::HCD_PATCH_SCHEMA_VERSION_28
                        | crate::HCD_PATCH_SCHEMA_VERSION_29
                        | crate::HCD_PATCH_SCHEMA_VERSION_50
                ) || !manifest.source.is_spreadsheet()
                    || (patch.schema_version != HCD_PATCH_SCHEMA_VERSION_19
                        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_22
                        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_28
                        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_29
                        && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_50
                        && patch.operations.len() != 1)
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.cell.set requires one operation with hcd-patch/7-15 or an XLSX range batch with hcd-patch/19, /22, or /28"
                            .to_string(),
                    ));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(1..=1_048_576).contains(row)
                    || !(1..=16_384).contains(column)
                    || text.is_empty()
                    || text.chars().count() > 32_767
                    || text.chars().any(is_forbidden_xml_character)
                {
                    return Err(HcdError::InvalidPatch(
                        "XLSX cell insertion has an invalid sheet, address, or text".to_string(),
                    ));
                }
                inserted = inserted.checked_add(text.len()).ok_or_else(|| {
                    HcdError::ResourceLimit("patch insert byte count overflowed".to_string())
                })?;
            }
            PatchOperation::XlsxFormulaSet {
                node_id,
                sheet_id,
                formula,
                precondition,
            } => {
                if (patch.schema_version != HCD_PATCH_SCHEMA_VERSION_20
                    && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_22
                    && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_28
                    && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_29
                    && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_50)
                    || !manifest.source.is_spreadsheet()
                    || (patch.schema_version == HCD_PATCH_SCHEMA_VERSION_20
                        && patch.operations.len() != 1)
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.formula.set requires one XLSX operation with hcd-patch/20 or a batch with /22 or /28"
                            .to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !formula.starts_with('=')
                    || formula.len() < 2
                    || formula.len() > 8192
                    || formula.chars().any(is_forbidden_xml_character)
                    || formula.contains(['\r', '\n'])
                {
                    return Err(HcdError::InvalidPatch(
                        "XLSX formula has an invalid sheet, length, or XML character".to_string(),
                    ));
                }
                inserted = inserted.checked_add(formula.len()).ok_or_else(|| {
                    HcdError::ResourceLimit("patch insert byte count overflowed".to_string())
                })?;
            }
            PatchOperation::XlsxFormulaToValue {
                node_id,
                sheet_id,
                text,
                precondition,
            } => {
                if (patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_28
                    && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_29
                    && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_50)
                    || !manifest.source.is_spreadsheet()
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.formula.to-value requires an XLSX hcd-patch/28 batch".to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || text.chars().count() > 32_767
                    || text.chars().any(is_forbidden_xml_character)
                {
                    return Err(HcdError::InvalidPatch(
                        "XLSX formula conversion has an invalid sheet or value".to_string(),
                    ));
                }
                inserted = inserted.checked_add(text.len()).ok_or_else(|| {
                    HcdError::ResourceLimit("patch insert byte count overflowed".to_string())
                })?;
            }
            PatchOperation::XlsxCellClear {
                node_id,
                sheet_id,
                created_revision,
                precondition,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_54
                    && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_65
                    && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_66
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.cell.clear requires hcd-patch/54 or /65".into(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_identifier("sheetId", sheet_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
                if *created_revision == 0 || *created_revision > patch.base_revision {
                    return Err(HcdError::InvalidPatch(
                        "XLSX cell creation revision must precede the clear".into(),
                    ));
                }
            }
            PatchOperation::XlsxFormulaToNumber {
                node_id,
                sheet_id,
                value,
                precondition,
            }
            | PatchOperation::XlsxNumberSet {
                node_id,
                sheet_id,
                value,
                precondition,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_29
                    && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_50
                    && !(matches!(
                        patch.schema_version.as_str(),
                        crate::HCD_PATCH_SCHEMA_VERSION_54 | crate::HCD_PATCH_SCHEMA_VERSION_65
                    ) && matches!(operation, PatchOperation::XlsxNumberSet { .. }))
                    || !manifest.source.is_spreadsheet()
                {
                    return Err(HcdError::Unsupported(
                        "numeric XLSX cell edits require an XLSX hcd-patch/29 batch".to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !valid_xlsx_number(value)
                {
                    return Err(HcdError::InvalidPatch(
                        "XLSX numeric cell edit requires a finite numeric value".to_string(),
                    ));
                }
                inserted = inserted.checked_add(value.len()).ok_or_else(|| {
                    HcdError::ResourceLimit("patch insert byte count overflowed".to_string())
                })?;
            }
            PatchOperation::XlsxFormulaCreate {
                sheet_id,
                row,
                column,
                formula,
            } => {
                if (patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_21
                    && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_22
                    && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_28
                    && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_29
                    && patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_50)
                    || !manifest.source.is_spreadsheet()
                    || sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(1..=1_048_576).contains(row)
                    || !(1..=16_384).contains(column)
                    || !formula.starts_with('=')
                    || formula.len() < 2
                    || formula.len() > 8192
                    || formula.chars().any(is_forbidden_xml_character)
                    || formula.contains(['\r', '\n'])
                {
                    return Err(HcdError::InvalidPatch(
                        "XLSX formula creation has an invalid sheet, address, or formula"
                            .to_string(),
                    ));
                }
                inserted = inserted.checked_add(formula.len()).ok_or_else(|| {
                    HcdError::ResourceLimit("patch insert byte count overflowed".to_string())
                })?;
            }
            PatchOperation::XlsxUnmerge {
                node_id,
                sheet_id,
                start_row,
                start_column,
                end_row,
                end_column,
                precondition,
            } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_11
                        | HCD_PATCH_SCHEMA_VERSION_12
                        | HCD_PATCH_SCHEMA_VERSION_13
                        | HCD_PATCH_SCHEMA_VERSION_14
                        | HCD_PATCH_SCHEMA_VERSION_15
                ) || !manifest.source.is_spreadsheet()
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.unmerge requires one operation on an XLSX bundle with hcd-patch/11"
                            .to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || *start_row == 0
                    || *start_column == 0
                    || *end_row > 1_048_576
                    || *end_column > 16_384
                    || *end_row < *start_row
                    || *end_column < *start_column
                    || end_row
                        .saturating_sub(*start_row)
                        .saturating_add(1)
                        .saturating_mul(end_column.saturating_sub(*start_column).saturating_add(1))
                        < 2
                    || end_row
                        .saturating_sub(*start_row)
                        .saturating_add(1)
                        .saturating_mul(end_column.saturating_sub(*start_column).saturating_add(1))
                        > 10_000
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX unmerge range".to_string(),
                    ));
                }
                validate_sha256("nodeHash", &precondition.node_hash)?;
            }
            PatchOperation::XlsxRowAppend {
                sheet_id,
                after_row,
            } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_8
                        | HCD_PATCH_SCHEMA_VERSION_9
                        | HCD_PATCH_SCHEMA_VERSION_10
                        | HCD_PATCH_SCHEMA_VERSION_11
                        | HCD_PATCH_SCHEMA_VERSION_12
                        | HCD_PATCH_SCHEMA_VERSION_13
                        | HCD_PATCH_SCHEMA_VERSION_14
                        | HCD_PATCH_SCHEMA_VERSION_15
                ) || !manifest.source.is_spreadsheet()
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.row.append requires one operation on an XLSX bundle with hcd-patch/8"
                            .to_string(),
                    ));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(1..1_048_576).contains(after_row)
                {
                    return Err(HcdError::InvalidPatch(
                        "XLSX row append has an invalid sheet or last row".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxRowInsert {
                sheet_id,
                before_row,
            } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_12
                        | HCD_PATCH_SCHEMA_VERSION_13
                        | HCD_PATCH_SCHEMA_VERSION_14
                        | HCD_PATCH_SCHEMA_VERSION_15
                ) || !manifest.source.is_spreadsheet()
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported("xlsx.row.insert requires one operation on an XLSX bundle with hcd-patch/12".to_string()));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(1..=1_048_575).contains(before_row)
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX middle row insertion target".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxRowDelete { sheet_id, row } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_14 | HCD_PATCH_SCHEMA_VERSION_15
                ) || !manifest.source.is_spreadsheet()
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported("xlsx.row.delete requires one operation on an XLSX bundle with hcd-patch/14".to_string()));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(1..=1_048_576).contains(row)
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX row deletion target".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxColumnInsert {
                sheet_id,
                before_column,
            } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_13
                        | HCD_PATCH_SCHEMA_VERSION_14
                        | HCD_PATCH_SCHEMA_VERSION_15
                ) || !manifest.source.is_spreadsheet()
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported("xlsx.column.insert requires one operation on an XLSX bundle with hcd-patch/13".to_string()));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(1..=16_384).contains(before_column)
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX middle column insertion target".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxColumnDelete { sheet_id, column } => {
                if patch.schema_version != HCD_PATCH_SCHEMA_VERSION_15
                    || !manifest.source.is_spreadsheet()
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported("xlsx.column.delete requires one operation on an XLSX bundle with hcd-patch/15".to_string()));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(1..=16_384).contains(column)
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX column deletion target".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxGridRange {
                sheet_id,
                axis,
                action,
                start,
                count,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_25
                    || !manifest.source.is_spreadsheet()
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.grid.range requires hcd-patch/25".to_string(),
                    ));
                }
                let maximum = if *axis == XlsxGridAxis::Row {
                    1_048_576u32
                } else {
                    16_384u32
                };
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(2..=100).contains(count)
                    || *start == 0
                    || start
                        .checked_add(*count - 1)
                        .is_none_or(|last| last > maximum)
                    || (*action == XlsxGridAction::Insert
                        && start.checked_add(*count).is_none_or(|last| last > maximum))
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX grid selection".to_string(),
                    ));
                }
            }
            PatchOperation::PdfPageLayoutSet { .. } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    crate::HCD_PATCH_SCHEMA_VERSION_52 | crate::HCD_PATCH_SCHEMA_VERSION_53
                ) || manifest.schema_version != crate::HCD_SCHEMA_VERSION
                    || manifest.source.format != "pdf"
                {
                    return Err(HcdError::Unsupported(
                        "Page organization requires a PDF and a PDF layout patch schema".into(),
                    ));
                }
            }
            PatchOperation::XlsxAutoFilterSet { sheet_id, filter } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_51
                    || manifest.schema_version != crate::HCD_SCHEMA_VERSION
                    || manifest.source.format != "xlsx"
                {
                    return Err(HcdError::Unsupported(
                        "Saved AutoFilter requires XLSX and hcd-patch/51".into(),
                    ));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid AutoFilter worksheet ID".into(),
                    ));
                }
                if let Some(filter) = filter {
                    filter.validate()?;
                }
            }
            PatchOperation::XlsxColumnWidth {
                sheet_id,
                column,
                width_chars,
            } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_9
                        | HCD_PATCH_SCHEMA_VERSION_10
                        | HCD_PATCH_SCHEMA_VERSION_11
                        | HCD_PATCH_SCHEMA_VERSION_12
                        | HCD_PATCH_SCHEMA_VERSION_13
                        | HCD_PATCH_SCHEMA_VERSION_14
                        | HCD_PATCH_SCHEMA_VERSION_15
                ) || !manifest.source.is_spreadsheet()
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.column.width requires one operation on an XLSX bundle with hcd-patch/9".to_string(),
                    ));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(1..=16_384).contains(column)
                    || !width_chars.is_finite()
                    || !(1.0..=255.0).contains(width_chars)
                    || ((width_chars * 100.0).round() - width_chars * 100.0).abs() > 1e-7
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX column width target or value".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxRowHeight {
                sheet_id,
                row,
                height_points,
            } => {
                if patch.schema_version != HCD_PATCH_SCHEMA_VERSION_18
                    || !manifest.source.is_spreadsheet()
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.row.height requires one operation on an XLSX bundle with hcd-patch/18".to_string(),
                    ));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(1..=1_048_576).contains(row)
                    || !height_points.is_finite()
                    || !(1.0..=409.0).contains(height_points)
                    || ((height_points * 100.0).round() - height_points * 100.0).abs() > 1e-7
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX row height target or value".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxRowRemoveLast { sheet_id, row } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_10
                        | HCD_PATCH_SCHEMA_VERSION_11
                        | HCD_PATCH_SCHEMA_VERSION_12
                        | HCD_PATCH_SCHEMA_VERSION_13
                        | HCD_PATCH_SCHEMA_VERSION_14
                        | HCD_PATCH_SCHEMA_VERSION_15
                ) || !manifest.source.is_spreadsheet()
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.row.remove-last requires one operation on an XLSX bundle with hcd-patch/10".to_string(),
                    ));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(2..=1_048_576).contains(row)
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX last row removal target".to_string(),
                    ));
                }
            }
            PatchOperation::NodeStyle {
                node_id,
                style,
                precondition,
            } => {
                if patch.schema_version == HCD_PATCH_SCHEMA_VERSION {
                    return Err(HcdError::InvalidPatch(
                        "node.style requires schemaVersion hcd-patch/2".to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
                validate_node_style(style)?;
            }
            PatchOperation::ImageInsert {
                chunk_id,
                asset_hash,
                geometry,
                alt,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_47
                    || !matches!(
                        manifest.source.format.as_str(),
                        "pptx" | "pdf" | "xlsx" | "docx" | "md" | "html"
                    )
                {
                    return Err(HcdError::Unsupported(
                        "image.insert requires hcd-patch/47 and a visual document format".into(),
                    ));
                }
                validate_identifier("chunkId", chunk_id)?;
                validate_sha256("assetHash", asset_hash)?;
                crate::html::validate_image_geometry(geometry)?;
                if alt.chars().count() > 2000 || alt.chars().any(is_forbidden_xml_character) {
                    return Err(HcdError::InvalidPatch(
                        "image description is invalid".into(),
                    ));
                }
                let emu = matches!(manifest.source.format.as_str(), "pptx" | "xlsx");
                if emu != (geometry.unit == ImageGeometryUnit::Emu) {
                    return Err(HcdError::InvalidPatch("image geometry must use EMU for slides/sheets and points for PDF/flow documents".into()));
                }
            }
            PatchOperation::ImageReplace {
                node_id,
                asset_hash,
                precondition,
            } => {
                if patch.schema_version != HCD_PATCH_SCHEMA_VERSION_3
                    && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_5
                {
                    return Err(HcdError::InvalidPatch(
                        "image.replace requires schemaVersion hcd-patch/3".to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("assetHash", asset_hash)?;
                validate_sha256("visualHash", &precondition.visual_hash)?;
            }
            PatchOperation::ImageGeometry {
                node_id,
                geometry,
                precondition,
            } => {
                if patch.schema_version != HCD_PATCH_SCHEMA_VERSION_3
                    && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_5
                {
                    return Err(HcdError::InvalidPatch(
                        "image.geometry requires schemaVersion hcd-patch/3".to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("visualHash", &precondition.visual_hash)?;
                crate::html::validate_image_geometry(geometry)?;
            }
            PatchOperation::ImageLayersSet {
                node_id,
                stack,
                precondition,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_63
                    || !crate::image_layers::standalone(&manifest.source.format)
                {
                    return Err(HcdError::InvalidPatch(
                        "image.layers.set requires a raster document and hcd-patch/63".into(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("visualHash", &precondition.visual_hash)?;
                stack.validate()?;
            }
            PatchOperation::DocxPictureLayoutSet {
                node_id,
                layout,
                precondition,
            } => {
                if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_57
                    || manifest.source.format != "docx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::InvalidPatch(
                        "Word picture layout requires one DOCX operation with hcd-patch/57".into(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("visualHash", &precondition.visual_hash)?;
                if let Some(layout) = layout {
                    crate::validate_docx_picture_layout(layout)?;
                }
            }
            PatchOperation::AnnotationUpsert { annotation } => {
                validate_annotation(annotation)?;
            }
            PatchOperation::AnnotationRemove { annotation_id } => {
                validate_identifier("annotationId", annotation_id)?;
            }
        }
    }
    if inserted > MAX_PATCH_INSERT_BYTES {
        return Err(HcdError::ResourceLimit(format!(
            "patch inserts {inserted} bytes; maximum is {MAX_PATCH_INSERT_BYTES}"
        )));
    }
    Ok(())
}
