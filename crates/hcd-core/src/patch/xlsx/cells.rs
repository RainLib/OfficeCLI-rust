use super::*;

pub(in crate::patch) fn collect_xlsx_formats(
    patch: &PatchBatch,
) -> HashMap<String, XlsxFormatChange> {
    patch
        .operations
        .iter()
        .filter_map(|operation| {
            let PatchOperation::XlsxCellFormat {
                node_id,
                format,
                precondition,
            } = operation
            else {
                return None;
            };
            Some((
                node_id.clone(),
                XlsxFormatChange {
                    format: format.clone(),
                    node_hash: precondition.node_hash.clone(),
                },
            ))
        })
        .collect()
}

pub(in crate::patch) fn collect_xlsx_layouts(
    patch: &PatchBatch,
) -> HashMap<String, XlsxLayoutChange> {
    patch
        .operations
        .iter()
        .filter_map(|operation| {
            let PatchOperation::XlsxCellLayout {
                node_id,
                layout,
                precondition,
            } = operation
            else {
                return None;
            };
            Some((
                node_id.clone(),
                XlsxLayoutChange {
                    layout: layout.clone(),
                    node_hash: precondition.node_hash.clone(),
                },
            ))
        })
        .collect()
}

pub(in crate::patch) fn validate_xlsx_cell_format(
    format: &XlsxCellFormatPatch,
) -> Result<(), HcdError> {
    if format.bold.is_none()
        && format.italic.is_none()
        && format.underline.is_none()
        && format.font_size_pt.is_none()
        && format.color.is_none()
        && format.fill.is_none()
    {
        return Err(HcdError::InvalidPatch(
            "XLSX cell format must set bold, italic, underline, font size, color, or fill"
                .to_string(),
        ));
    }
    if let Some(size) = format.font_size_pt {
        if !size.is_finite() || !(1.0..=409.0).contains(&size) {
            return Err(HcdError::InvalidPatch(
                "XLSX font size must be from 1 to 409 points".to_string(),
            ));
        }
    }
    if let Some(color) = &format.color {
        validate_hex_color("color", color)?;
    }
    if let Some(fill) = &format.fill {
        validate_hex_color("fill", fill)?;
    }
    Ok(())
}

pub(in crate::patch) fn validate_xlsx_cell_layout(
    layout: &XlsxCellLayoutPatch,
) -> Result<(), HcdError> {
    if layout.horizontal.is_none()
        && layout.vertical.is_none()
        && layout.wrap.is_none()
        && layout.border.is_none()
    {
        return Err(HcdError::InvalidPatch(
            "XLSX cell layout must set alignment, wrap, or a border".to_string(),
        ));
    }
    if let Some(value) = &layout.horizontal {
        if !matches!(value.as_str(), "left" | "center" | "right") {
            return Err(HcdError::InvalidPatch(
                "XLSX horizontal alignment must be left, center, or right".to_string(),
            ));
        }
    }
    if let Some(value) = &layout.vertical {
        if !matches!(value.as_str(), "top" | "center" | "bottom") {
            return Err(HcdError::InvalidPatch(
                "XLSX vertical alignment must be top, center, or bottom".to_string(),
            ));
        }
    }
    if let Some(value) = &layout.border {
        if !matches!(value.as_str(), "none" | "thin") {
            return Err(HcdError::InvalidPatch(
                "XLSX border must be none or thin".to_string(),
            ));
        }
    }
    Ok(())
}

pub(in crate::patch) fn collect_xlsx_number_formats(
    patch: &PatchBatch,
) -> HashMap<String, XlsxNumberFormatChange> {
    patch
        .operations
        .iter()
        .filter_map(|operation| {
            let PatchOperation::XlsxCellNumberFormat {
                node_id,
                number_format,
                precondition,
            } = operation
            else {
                return None;
            };
            Some((
                node_id.clone(),
                XlsxNumberFormatChange {
                    number_format: number_format.clone(),
                    node_hash: precondition.node_hash.clone(),
                },
            ))
        })
        .collect()
}

pub(in crate::patch) fn validate_xlsx_number_format(
    format: &XlsxCellNumberFormatPatch,
) -> Result<(), HcdError> {
    let code = &format.format_code;
    if code.is_empty() || code.len() > 1024 || code.chars().any(is_forbidden_xml_character) {
        return Err(HcdError::InvalidPatch(
            "XLSX number format must be 1 to 1024 characters without control characters"
                .to_string(),
        ));
    }
    Ok(())
}

pub(in crate::patch) fn validate_xlsx_rich_runs(
    runs: &[crate::XlsxInlineRun],
) -> Result<usize, HcdError> {
    if runs.is_empty() || runs.len() > 4096 {
        return Err(HcdError::ResourceLimit(
            "rich text requires 1..4096 runs".into(),
        ));
    }
    let mut units = 0;
    let mut bytes = 0;
    for run in runs {
        crate::validate_xlsx_run_properties(&run.properties)?;
        if runs.len() > 1 && run.text.is_empty()
            || run.text.chars().any(|ch| {
                is_forbidden_xml_character(ch)
                    || ch.is_control() && !matches!(ch, '\n' | '\t' | '\r')
            })
        {
            return Err(HcdError::InvalidPatch(
                "invalid empty run or control character in rich text".into(),
            ));
        }
        units += run.text.encode_utf16().count();
        bytes += run.text.len();
        if units > 32767 {
            return Err(HcdError::ResourceLimit(
                "Excel strings cannot exceed 32767 UTF-16 units".into(),
            ));
        }
    }
    Ok(bytes)
}

pub(in crate::patch) fn collect_xlsx_cell_set(
    patch: &PatchBatch,
) -> Result<BTreeMap<(String, u32, u32), XlsxCellInsertion>, HcdError> {
    let mut insertions = BTreeMap::new();
    for operation in &patch.operations {
        let (sheet_id, row, column, text, formula, runs) = match operation {
            PatchOperation::XlsxCellSet {
                sheet_id,
                row,
                column,
                text,
            } => (sheet_id, row, column, text.clone(), false, None),
            PatchOperation::XlsxFormulaCreate {
                sheet_id,
                row,
                column,
                formula,
            } => (sheet_id, row, column, formula.clone(), true, None),
            PatchOperation::XlsxRichTextCreate {
                sheet_id,
                row,
                column,
                runs,
            } => (
                sheet_id,
                row,
                column,
                runs.iter().map(|run| run.text.as_str()).collect(),
                false,
                Some(runs.clone()),
            ),
            _ => continue,
        };
        let key = (sheet_id.clone(), *row, *column);
        if insertions
            .insert(
                key,
                XlsxCellInsertion {
                    sheet_id: sheet_id.clone(),
                    row: *row,
                    column: *column,
                    text,
                    formula,
                    runs,
                },
            )
            .is_some()
        {
            return Err(HcdError::InvalidPatch(
                "XLSX batch contains duplicate cell addresses".to_string(),
            ));
        }
    }
    Ok(insertions)
}

pub(in crate::patch) fn collect_xlsx_formula_set(
    patch: &PatchBatch,
) -> Result<HashMap<String, XlsxFormulaChange>, HcdError> {
    let mut changes = HashMap::new();
    for operation in &patch.operations {
        let change = match operation {
            PatchOperation::XlsxFormulaSet {
                node_id,
                sheet_id,
                formula,
                precondition,
            } => Some((
                node_id,
                sheet_id,
                XlsxFormulaReplacement::Formula(formula.clone()),
                precondition,
            )),
            PatchOperation::XlsxFormulaToValue {
                node_id,
                sheet_id,
                text,
                precondition,
            } => Some((
                node_id,
                sheet_id,
                XlsxFormulaReplacement::Value(text.clone()),
                precondition,
            )),
            PatchOperation::XlsxFormulaToNumber {
                node_id,
                sheet_id,
                value,
                precondition,
            } => Some((
                node_id,
                sheet_id,
                XlsxFormulaReplacement::Number(value.clone()),
                precondition,
            )),
            PatchOperation::XlsxNumberSet {
                node_id,
                sheet_id,
                value,
                precondition,
            } => Some((
                node_id,
                sheet_id,
                XlsxFormulaReplacement::NumberUpdate(value.clone()),
                precondition,
            )),
            _ => None,
        };
        if let Some((node_id, sheet_id, replacement, precondition)) = change {
            if changes
                .insert(
                    node_id.clone(),
                    XlsxFormulaChange {
                        sheet_id: sheet_id.clone(),
                        replacement,
                        node_hash: precondition.node_hash.clone(),
                    },
                )
                .is_some()
            {
                return Err(HcdError::InvalidPatch(
                    "XLSX batch contains duplicate formula targets".to_string(),
                ));
            }
        }
    }
    Ok(changes)
}

/// The band one window keeps: how many of its rows and its columns stay put.
/// `None` means this window has no band for a shift to speak about, either because
/// it names no count at all or because a count it does name is not one a band can
/// hold. The bound is the same one the export reads these attributes with; a
/// number past it came out of a workbook that froze more of its sheet than a sheet
/// has, and that pane is the export's to shift and to refuse, not one to guess at
/// here.
pub(in crate::patch) fn xlsx_frozen_band(tag: &str) -> Option<(u32, u32)> {
    let rows = xlsx_frozen_band_side(tag, "data-hcd-frozen-rows", XLSX_FROZEN_ROW_LIMIT);
    let columns = xlsx_frozen_band_side(tag, "data-hcd-frozen-columns", XLSX_FROZEN_COLUMN_LIMIT);
    match (rows, columns) {
        // No count on either side: the window keeps no split to move.
        (None, None) => None,
        // A count that is not a band this shift could leave a sane number for.
        (Some(None), _) | (_, Some(None)) => None,
        (rows, columns) => Some((
            rows.flatten().unwrap_or_default(),
            columns.flatten().unwrap_or_default(),
        )),
    }
}

/// One side of a window's band, where the outer `None` is a side the window names
/// no count for — nothing frozen on that side, which is how a freeze of the first
/// row alone reads — and the inner one a count that cannot be read as a band.
pub(in crate::patch) fn xlsx_frozen_band_side(
    tag: &str,
    name: &str,
    maximum: u32,
) -> Option<Option<u32>> {
    let value = xlsx_attribute(tag, name)?;
    Some(
        value
            .trim()
            .parse::<u32>()
            .ok()
            .filter(|count| *count <= maximum),
    )
}

/// Rewrite cross-worksheet references inside stored formula expressions so an
/// edited cell keeps naming the worksheet it pointed at.
pub(in crate::patch) fn rename_xlsx_formula_references(
    html: &mut String,
    old_name: &str,
    new_name: &str,
) -> Result<bool, HcdError> {
    const MARKER: &str = "data-hcd-formula-expression=\"";
    let mut cursor = 0usize;
    let mut changed = false;
    while let Some(offset) = html[cursor..].find(MARKER) {
        let start = cursor + offset + MARKER.len();
        let Some(value_end) = html[start..].find('"') else {
            return Err(HcdError::InvalidBundle(
                "XLSX formula expression is not closed".to_string(),
            ));
        };
        let end = start + value_end;
        let expression = unescape_attribute(&html[start..end]);
        let renamed = rename_formula_sheet_references(&expression, &[(old_name, new_name)]);
        if renamed != expression {
            let escaped = escape_attribute(&renamed);
            html.replace_range(start..end, &escaped);
            changed = true;
            cursor = start + escaped.len();
        } else {
            cursor = end;
        }
    }
    Ok(changed)
}

/// Collapse the cross-worksheet references in stored formula expressions that
/// named a worksheet this patch deletes, the way Excel collapses an address whose
/// sheet is gone: the reference becomes `#REF!` and stays in the cell.
pub(in crate::patch) fn drop_xlsx_formula_references(
    html: &mut String,
    deleted_name: &str,
) -> Result<bool, HcdError> {
    const MARKER: &str = "data-hcd-formula-expression=\"";
    let mut cursor = 0usize;
    let mut changed = false;
    while let Some(offset) = html[cursor..].find(MARKER) {
        let start = cursor + offset + MARKER.len();
        let Some(value_end) = html[start..].find('"') else {
            return Err(HcdError::InvalidBundle(
                "XLSX formula expression is not closed".to_string(),
            ));
        };
        let end = start + value_end;
        let expression = unescape_attribute(&html[start..end]);
        let dropped = drop_formula_sheet_references(&expression, deleted_name);
        if dropped != expression {
            let escaped = escape_attribute(&dropped);
            html.replace_range(start..end, &escaped);
            changed = true;
            cursor = start + escaped.len();
        } else {
            cursor = end;
        }
    }
    Ok(changed)
}

pub(in crate::patch) fn xlsx_cell_coordinates(reference: &str) -> Option<(u32, u32)> {
    let mut row = 0u32;
    let mut column = 0u32;
    let mut saw_row = false;
    for byte in reference.bytes() {
        if byte.is_ascii_uppercase() && !saw_row {
            column = column
                .checked_mul(26)?
                .checked_add(u32::from(byte - b'A' + 1))?;
        } else if byte.is_ascii_digit() && column > 0 {
            saw_row = true;
            row = row.checked_mul(10)?.checked_add(u32::from(byte - b'0'))?;
        } else {
            return None;
        }
    }
    (saw_row && (1..=1_048_576).contains(&row) && (1..=16_384).contains(&column))
        .then_some((row, column))
}

pub(in crate::patch) fn rewrite_xlsx_formula_references(
    html: &mut String,
    deletion: crate::FormulaDeletion,
) -> Result<(), HcdError> {
    for cell in xlsx_cells(html)?.into_iter().rev() {
        let tag = &html[cell.start..=cell.tag_end];
        if xlsx_attribute(tag, "data-hcd-formula") != Some("true") {
            continue;
        }
        let expression = xlsx_attribute(tag, "data-hcd-formula-expression")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                HcdError::Unsupported(
                    "XLSX structural deletion requires a safely parsed formula expression"
                        .to_string(),
                )
            })?;
        let decoded = quick_xml::escape::unescape(expression).map_err(|error| {
            HcdError::InvalidBundle(format!("XLSX formula HTML entity: {error}"))
        })?;
        let shifted = crate::delete_formula_references(&decoded, deletion)?;
        if shifted != decoded {
            set_attribute_in_range(
                html,
                cell.start,
                cell.tag_end,
                "data-hcd-formula-expression",
                &shifted,
            )?;
            let new_end = html[cell.start..]
                .find('>')
                .map(|offset| cell.start + offset)
                .ok_or_else(|| {
                    HcdError::InvalidBundle("XLSX formula cell is not closed".to_string())
                })?;
            set_attribute_in_range(html, cell.start, new_end, "data-hcd-formula-edited", "true")?;
        }
    }
    Ok(())
}

pub(in crate::patch) fn rewrite_xlsx_inserted_formula_references(
    html: &mut String,
    insertion: crate::FormulaInsertion,
) -> Result<(), HcdError> {
    for cell in xlsx_cells(html)?.into_iter().rev() {
        let tag = &html[cell.start..=cell.tag_end];
        if xlsx_attribute(tag, "data-hcd-formula") != Some("true") {
            continue;
        }
        let expression = xlsx_attribute(tag, "data-hcd-formula-expression")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                HcdError::Unsupported(
                    "XLSX structural insertion requires a safely parsed formula expression"
                        .to_string(),
                )
            })?;
        let decoded = quick_xml::escape::unescape(expression).map_err(|error| {
            HcdError::InvalidBundle(format!("XLSX formula HTML entity: {error}"))
        })?;
        let shifted = crate::insert_formula_references(&decoded, insertion)?;
        if shifted != decoded {
            set_attribute_in_range(
                html,
                cell.start,
                cell.tag_end,
                "data-hcd-formula-expression",
                &shifted,
            )?;
            let new_end = html[cell.start..]
                .find('>')
                .map(|offset| cell.start + offset)
                .ok_or_else(|| {
                    HcdError::InvalidBundle("XLSX formula cell is not closed".to_string())
                })?;
            set_attribute_in_range(html, cell.start, new_end, "data-hcd-formula-edited", "true")?;
        }
    }
    Ok(())
}

pub(in crate::patch) fn xlsx_attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let marker = format!(" {name}=\"");
    let start = tag.find(&marker)? + marker.len();
    let end = tag[start..].find('"')? + start;
    Some(&tag[start..end])
}

pub(in crate::patch) fn set_xlsx_formula(
    html: &mut String,
    node_id: &str,
    formula: &str,
    literal_editable: bool,
) -> Result<(), HcdError> {
    let marker = format!("data-hcd-id=\"{node_id}\"");
    let node_start = html.find(&marker).ok_or_else(|| {
        HcdError::InvalidBundle(format!("XLSX formula node {node_id} is missing"))
    })?;
    let cell_start = html[..node_start].rfind("<td ").ok_or_else(|| {
        HcdError::InvalidBundle("XLSX formula node has no containing cell".to_string())
    })?;
    let cell_end = html[cell_start..]
        .find('>')
        .map(|offset| cell_start + offset)
        .ok_or_else(|| {
            HcdError::InvalidBundle("XLSX formula cell tag is not closed".to_string())
        })?;
    let tag = &html[cell_start..=cell_end];
    let existing_formula = xlsx_attribute(tag, "data-hcd-formula") == Some("true");
    if cell_end > node_start
        || (existing_formula && xlsx_attribute(tag, "data-hcd-formula-editable") != Some("true"))
        || (!existing_formula && !literal_editable)
    {
        return Err(HcdError::Unsupported(
            "XLSX cell is shared, array based, or otherwise read-only".to_string(),
        ));
    }
    if !existing_formula {
        for (name, value) in [
            ("data-hcd-formula", "true"),
            ("data-hcd-formula-editable", "true"),
            ("data-hcd-raw-value", ""),
        ] {
            let cell_end = html[cell_start..]
                .find('>')
                .map(|offset| cell_start + offset)
                .ok_or_else(|| {
                    HcdError::InvalidBundle("XLSX formula cell tag is not closed".to_string())
                })?;
            set_attribute_in_range(html, cell_start, cell_end, name, value)?;
        }
    }
    let cell_end = html[cell_start..]
        .find('>')
        .map(|offset| cell_start + offset)
        .ok_or_else(|| {
            HcdError::InvalidBundle("XLSX formula cell tag is not closed".to_string())
        })?;
    set_attribute_in_range(
        html,
        cell_start,
        cell_end,
        "data-hcd-formula-expression",
        formula,
    )?;
    let cell_end = html[cell_start..]
        .find('>')
        .map(|offset| cell_start + offset)
        .ok_or_else(|| {
            HcdError::InvalidBundle("XLSX formula cell tag is not closed".to_string())
        })?;
    set_attribute_in_range(
        html,
        cell_start,
        cell_end,
        "data-hcd-formula-edited",
        "true",
    )?;
    Ok(())
}

pub(in crate::patch) fn set_xlsx_formula_value(
    html: &mut String,
    node_id: &str,
) -> Result<(), HcdError> {
    let marker = format!("data-hcd-id=\"{node_id}\"");
    let node_start = html.find(&marker).ok_or_else(|| {
        HcdError::InvalidBundle(format!("XLSX formula node {node_id} is missing"))
    })?;
    let cell_start = html[..node_start].rfind("<td ").ok_or_else(|| {
        HcdError::InvalidBundle("XLSX formula node has no containing cell".to_string())
    })?;
    let cell_end = html[cell_start..]
        .find('>')
        .map(|offset| cell_start + offset)
        .ok_or_else(|| {
            HcdError::InvalidBundle("XLSX formula cell tag is not closed".to_string())
        })?;
    let tag = &html[cell_start..=cell_end];
    if cell_end > node_start
        || xlsx_attribute(tag, "data-hcd-formula") != Some("true")
        || xlsx_attribute(tag, "data-hcd-formula-editable") != Some("true")
    {
        return Err(HcdError::Unsupported(
            "XLSX formula is shared, array based, or otherwise read-only".to_string(),
        ));
    }
    for (name, value) in [
        ("data-hcd-formula", "false"),
        ("data-hcd-formula-editable", "false"),
        ("data-hcd-formula-expression", ""),
        ("data-hcd-formula-edited", "false"),
        ("data-hcd-raw-value", ""),
        ("data-hcd-value-type", "string"),
    ] {
        let cell_end = html[cell_start..]
            .find('>')
            .map(|offset| cell_start + offset)
            .ok_or_else(|| {
                HcdError::InvalidBundle("XLSX formula cell tag is not closed".to_string())
            })?;
        set_attribute_in_range(html, cell_start, cell_end, name, value)?;
    }
    Ok(())
}

pub(in crate::patch) fn valid_xlsx_number(value: &str) -> bool {
    let Some(number) = value
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
    else {
        return false;
    };
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().any(|byte| byte.is_ascii_digit())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'.' | b'e' | b'E'))
        && (number.fract() != 0.0 || number.abs() <= 9_007_199_254_740_991.0)
}

pub(in crate::patch) fn set_xlsx_raw_value(
    html: &mut String,
    node_id: &str,
    value: &str,
) -> Result<(), HcdError> {
    let marker = format!("data-hcd-id=\"{node_id}\"");
    let node_start = html
        .find(&marker)
        .ok_or_else(|| HcdError::InvalidBundle(format!("XLSX cell node {node_id} is missing")))?;
    let cell_start = html[..node_start].rfind("<td ").ok_or_else(|| {
        HcdError::InvalidBundle("XLSX cell node has no containing cell".to_string())
    })?;
    let cell_end = html[cell_start..]
        .find('>')
        .map(|offset| cell_start + offset)
        .ok_or_else(|| HcdError::InvalidBundle("XLSX cell tag is not closed".to_string()))?;
    if cell_end > node_start {
        return Err(HcdError::InvalidBundle(
            "XLSX cell tag overlaps node".to_string(),
        ));
    }
    if xlsx_attribute(&html[cell_start..=cell_end], "data-hcd-formula") == Some("true") {
        return Err(HcdError::Unsupported(
            "XLSX formula must use a formula conversion operation".to_string(),
        ));
    }
    set_attribute_in_range(html, cell_start, cell_end, "data-hcd-raw-value", value)?;
    let cell_end = html[cell_start..]
        .find('>')
        .map(|offset| cell_start + offset)
        .ok_or_else(|| HcdError::InvalidBundle("XLSX cell tag is not closed".to_string()))?;
    set_attribute_in_range(
        html,
        cell_start,
        cell_end,
        "data-hcd-value-type",
        if value.is_empty() { "string" } else { "number" },
    )
}

pub(in crate::patch) fn xlsx_cells(html: &str) -> Result<Vec<XlsxCellSpan>, HcdError> {
    let mut result = Vec::new();
    let mut cursor = 0usize;
    while let Some(relative) = html[cursor..].find("<tr ") {
        let row_start = cursor + relative;
        let tag_end = html[row_start..]
            .find('>')
            .map(|offset| row_start + offset)
            .ok_or_else(|| HcdError::InvalidBundle("XLSX row tag is not closed".to_string()))?;
        let row = xlsx_attribute(&html[row_start..=tag_end], "data-hcd-row")
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or_else(|| HcdError::InvalidBundle("XLSX row has no row number".to_string()))?;
        let row_end = html[tag_end + 1..]
            .find("</tr>")
            .map(|offset| tag_end + 1 + offset)
            .ok_or_else(|| HcdError::InvalidBundle("XLSX row is not closed".to_string()))?;
        let mut cell_cursor = tag_end + 1;
        while let Some(relative) = html[cell_cursor..row_end].find("<td ") {
            let start = cell_cursor + relative;
            let tag_end = html[start..row_end]
                .find('>')
                .map(|offset| start + offset)
                .ok_or_else(|| {
                    HcdError::InvalidBundle("XLSX cell tag is not closed".to_string())
                })?;
            let end = html[tag_end + 1..row_end]
                .find("</td>")
                .map(|offset| tag_end + 1 + offset + "</td>".len())
                .ok_or_else(|| HcdError::InvalidBundle("XLSX cell is not closed".to_string()))?;
            let tag = &html[start..=tag_end];
            let column = xlsx_attribute(tag, "data-hcd-column")
                .and_then(|value| value.parse::<u32>().ok())
                .ok_or_else(|| HcdError::InvalidBundle("XLSX cell has no column".to_string()))?;
            let merged_range = xlsx_attribute(tag, "data-hcd-merge")
                .map(|value| {
                    xlsx_merge_coordinates(value).ok_or_else(|| {
                        HcdError::InvalidBundle(format!("invalid XLSX merge range {value}"))
                    })
                })
                .transpose()?;
            result.push(XlsxCellSpan {
                start,
                end,
                tag_end,
                row,
                column,
                has_node: html[start..end].contains("data-hcd-id=\""),
                merged_range,
            });
            cell_cursor = end;
        }
        cursor = row_end + "</tr>".len();
    }
    Ok(result)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxAddedLiteral {
    pub id: String,
    pub hash: String,
    pub sheet_id: String,
    pub row: u32,
    pub column: u32,
}

/// Identify editable literals that first appeared in a committed write.
pub fn xlsx_added_literals(
    bundle: &Bundle,
    record: &RevisionRecord,
) -> Result<Vec<XlsxAddedLiteral>, HcdError> {
    let head = bundle.manifest()?;
    let Some(parent) = record.parent_revision else {
        return Ok(Vec::new());
    };
    if !head.source.is_spreadsheet() || record.dirty_node_ids.is_empty() {
        return Ok(Vec::new());
    }
    let (after, _) = crate::manifest_at_revision(bundle, &head, Some(record.revision))?;
    let chunks: HashSet<_> = record.dirty_chunk_ids.iter().map(String::as_str).collect();
    let dirty: HashSet<_> = record.dirty_node_ids.iter().map(String::as_str).collect();
    let mut candidates = HashMap::new();
    for page in 0..after.index_page_count {
        for descriptor in bundle.read_index_page(&after, page)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.kind != crate::GridChunkKind::Cells
                || !chunks.contains(descriptor.chunk_id.as_str())
            {
                continue;
            }
            for entry in bundle.read_map_verified(&descriptor)?.entries {
                if entry.source.node_kind != "cell"
                    || !entry.source.editable
                    || !entry.source.created_in_hcd
                    || !dirty.contains(entry.node_id.as_str())
                {
                    continue;
                }
                let Some(address) = entry.source.paragraph_id.as_deref() else {
                    continue;
                };
                let Some((row, column)) = xlsx_cell_coordinates(address) else {
                    continue;
                };
                candidates.insert(
                    (grid.sheet_id.clone(), row, column),
                    (entry.node_id, entry.node_hash),
                );
            }
        }
    }
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    // A shifted or rewritten HCD-owned cell is already present in the parent.
    let candidates_ids: HashSet<_> = candidates.values().map(|(id, _)| id.clone()).collect();
    let sheets: HashSet<_> = candidates
        .keys()
        .map(|(sheet, _, _)| sheet.clone())
        .collect();
    let mut previous_ids = HashSet::new();
    let (before, _) = crate::manifest_at_revision(bundle, &head, Some(parent))?;
    for page in 0..before.index_page_count {
        for descriptor in bundle.read_index_page(&before, page)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.kind != crate::GridChunkKind::Cells || !sheets.contains(&grid.sheet_id) {
                continue;
            }
            for entry in bundle.read_map_verified(&descriptor)?.entries {
                if candidates_ids.contains(entry.node_id.as_str()) {
                    previous_ids.insert(entry.node_id);
                }
                if let Some((row, column)) = entry
                    .source
                    .paragraph_id
                    .as_deref()
                    .and_then(xlsx_cell_coordinates)
                {
                    candidates.remove(&(grid.sheet_id.clone(), row, column));
                }
            }
        }
    }
    let mut added: Vec<_> = candidates
        .into_iter()
        .filter(|(_, (id, _))| !previous_ids.contains(id))
        .map(|((sheet_id, row, column), (id, hash))| XlsxAddedLiteral {
            id,
            hash,
            sheet_id,
            row,
            column,
        })
        .collect();
    added.sort_unstable_by(|a, b| {
        (&a.sheet_id, a.row, a.column).cmp(&(&b.sheet_id, b.row, b.column))
    });
    Ok(added)
}

pub(in crate::patch) fn collect_xlsx_cell_clears<'a>(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    patch: &'a PatchBatch,
) -> Result<HashMap<&'a str, (&'a str, &'a str)>, HcdError> {
    let mut clears = HashMap::new();
    let mut creations = HashMap::new();
    for operation in &patch.operations {
        if let PatchOperation::XlsxCellClear {
            node_id,
            sheet_id,
            created_revision,
            precondition,
        } = operation
        {
            clears.insert(
                node_id.as_str(),
                (sheet_id.as_str(), precondition.node_hash.as_str()),
            );
            creations.insert(node_id.as_str(), *created_revision);
        }
    }
    let Some(first) = creations.values().min().copied() else {
        return Ok(clears);
    };
    let mut revisions = BTreeMap::<u64, Vec<&str>>::new();
    for (&id, &revision) in &creations {
        revisions.entry(revision).or_default().push(id);
    }
    for (revision, ids) in revisions {
        let record = bundle.revision(revision)?;
        let added: HashMap<_, _> = xlsx_added_literals(bundle, &record)?
            .into_iter()
            .map(|row| (row.id, (row.sheet_id, row.hash)))
            .collect();
        for id in ids {
            let (sheet, hash) = clears[id];
            if !added.get(id).is_some_and(|(s, h)| s == sheet && h == hash) {
                return Err(HcdError::PreconditionFailed(
                    "XLSX cell was not created by this revision".into(),
                ));
            }
        }
    }
    for revision in first + 1..=manifest.revision {
        let record = bundle.revision(revision)?;
        if (record.structural_change
            && record
                .patch_id
                .as_deref()
                .is_some_and(|id| id.starts_with("restore-")))
            || record
                .dirty_node_ids
                .iter()
                .chain(&record.removed_node_ids)
                .any(|id| {
                    creations
                        .get(id.as_str())
                        .is_some_and(|created| revision > *created)
                })
        {
            return Err(HcdError::PreconditionFailed(
                "XLSX cell has been edited since the original write".into(),
            ));
        }
    }
    if let Some(href) = &manifest.annotation_href {
        let set: AnnotationSet = read_json_bounded(
            &bundle.resolve_href(href)?,
            MAX_CONTROL_PART_BYTES,
            "annotation set",
        )?;
        if set
            .annotations
            .iter()
            .any(|entry| clears.contains_key(entry.node_id.as_str()))
        {
            return Err(HcdError::PreconditionFailed(
                "XLSX cell has a linked annotation".into(),
            ));
        }
    }
    Ok(clears)
}

pub(in crate::patch) fn clear_xlsx_cell(
    html: &mut String,
    entry: &NodeMapEntry,
) -> Result<(), HcdError> {
    let (row, column) = entry
        .source
        .paragraph_id
        .as_deref()
        .and_then(xlsx_cell_coordinates)
        .ok_or_else(|| HcdError::InvalidBundle("XLSX cell has no valid address".into()))?;
    let marker = format!("data-hcd-id=\"{}\"", entry.node_id);
    let cell = xlsx_cells(html)?
        .into_iter()
        .find(|cell| cell.row == row && cell.column == column)
        .ok_or_else(|| {
            HcdError::InvalidBundle("XLSX cell is missing from canonical HTML".into())
        })?;
    let tag = &html[cell.start..=cell.tag_end];
    if !html[cell.start..cell.end].contains(&marker)
        || cell.merged_range.is_some()
        || xlsx_attribute(tag, "data-hcd-formula") == Some("true")
        || xlsx_attribute(tag, "data-hcd-value-type") != Some("string")
    {
        return Err(HcdError::PreconditionFailed(
            "XLSX cell is no longer an independent literal".into(),
        ));
    }
    html.replace_range(
        cell.start..cell.end,
        &format!("<td class=\"hcd-cell hcd-empty\" data-hcd-column=\"{column}\"></td>"),
    );
    Ok(())
}

pub(in crate::patch) fn insert_xlsx_cell(
    html: &mut String,
    source_map: &mut crate::ChunkSourceMap,
    sheet_part: Option<&str>,
    document_id: &str,
    insertion: &XlsxCellInsertion,
    grid_generation: Option<u64>,
) -> Result<(String, String), HcdError> {
    let cells = xlsx_cells(html)?;
    let cell = cells
        .iter()
        .find(|cell| cell.row == insertion.row && cell.column == insertion.column);
    if cells
        .iter()
        .filter_map(|cell| cell.merged_range)
        .any(|range| {
            range.0 <= insertion.row
                && range.2 >= insertion.row
                && range.1 <= insertion.column
                && range.3 >= insertion.column
        })
    {
        return Err(HcdError::PreconditionFailed(
            "XLSX cell is inside a merged range".to_string(),
        ));
    }
    if let Some(cell) = cell {
        if cell.has_node || !html[cell.tag_end + 1..cell.end - 5].trim().is_empty() {
            return Err(HcdError::PreconditionFailed(
                "XLSX cell is no longer empty".to_string(),
            ));
        }
    }
    let reference = format!("{}{}", xlsx_column_name(insertion.column), insertion.row);
    if source_map
        .entries
        .iter()
        .any(|entry| entry.source.paragraph_id.as_deref() == Some(reference.as_str()))
    {
        return Err(HcdError::PreconditionFailed(format!(
            "XLSX cell {reference} is already mapped"
        )));
    }
    let part = sheet_part
        .map(str::to_string)
        .or_else(|| {
            source_map
                .entries
                .first()
                .map(|entry| entry.source.part.clone())
        })
        .ok_or_else(|| {
            HcdError::Unsupported(
                "XLSX cell creation requires a worksheet with a known source part".to_string(),
            )
        })?;
    let node_id = if let Some(generation) = grid_generation {
        stable_node_id(&[
            document_id,
            &part,
            "cell-created",
            &reference,
            &generation.to_string(),
        ])
    } else {
        stable_node_id(&[document_id, &part, "cell", &reference])
    };
    if source_map
        .entries
        .iter()
        .any(|entry| entry.node_id == node_id)
    {
        return Err(HcdError::PreconditionFailed(format!(
            "XLSX node {node_id} already exists"
        )));
    }
    let node_hash = hash_bytes(insertion.text.as_bytes());
    let formula_attrs = if insertion.formula {
        format!(" data-hcd-formula=\"true\" data-hcd-formula-editable=\"true\" data-hcd-formula-expression=\"{}\" data-hcd-formula-edited=\"true\"", escape_attribute(&insertion.text))
    } else {
        String::new()
    };
    let content = if let Some(runs) = &insertion.runs {
        crate::render_xlsx_inline_runs(runs)?
    } else {
        escape_text(&insertion.text)
    };
    let replacement = format!(
        "<td class=\"hcd-cell\" data-hcd-cell=\"{reference}\" data-hcd-column=\"{}\"{formula_attrs} data-hcd-value-type=\"string\"><span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\">{}</span></td>",
        insertion.column, content
    );
    if let Some(cell) = cell {
        html.replace_range(cell.start..cell.end, &replacement);
    } else {
        let row_marker = format!("data-hcd-row=\"{}\"", insertion.row);
        let row_tag = html.find(&row_marker).ok_or_else(|| {
            HcdError::Unsupported("XLSX cell requires an existing HCD row".to_string())
        })?;
        let row_start = html[..row_tag].rfind("<tr ").ok_or_else(|| {
            HcdError::InvalidBundle("XLSX row opening tag is missing".to_string())
        })?;
        let row_end = html[row_tag..]
            .find("</tr>")
            .map(|offset| row_tag + offset)
            .ok_or_else(|| {
                HcdError::InvalidBundle("XLSX row closing tag is missing".to_string())
            })?;
        let last_column = cells
            .iter()
            .filter(|cell| cell.row == insertion.row)
            .map(|cell| {
                let tag = &html[cell.start..=cell.tag_end];
                let span = xlsx_attribute(tag, "colspan")
                    .and_then(|value| value.parse::<u32>().ok())
                    .unwrap_or(1);
                cell.column.saturating_add(span.saturating_sub(1))
            })
            .max()
            .unwrap_or(0);
        if insertion.column <= last_column || insertion.column - last_column > 256 {
            return Err(HcdError::Unsupported(
                "XLSX first edit outside the bounded row tail".to_string(),
            ));
        }
        if row_start > row_tag
            || cells
                .iter()
                .any(|cell| cell.row == insertion.row && cell.end > row_end)
        {
            return Err(HcdError::InvalidBundle(
                "XLSX row has invalid cell bounds".to_string(),
            ));
        }
        let mut appended = String::new();
        for column in last_column + 1..insertion.column {
            appended.push_str(&format!(
                "<td class=\"hcd-cell hcd-empty\" data-hcd-column=\"{column}\"></td>"
            ));
        }
        appended.push_str(&replacement);
        html.insert_str(row_end, &appended);
    }
    let ordinal = source_map
        .entries
        .iter()
        .map(|entry| entry.source.text_ordinal)
        .max()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| HcdError::ResourceLimit("XLSX source ordinal overflow".to_string()))?;
    let position = source_map.entries.iter().position(|entry| {
        entry
            .source
            .paragraph_id
            .as_deref()
            .and_then(xlsx_cell_coordinates)
            .is_some_and(|(row, column)| (row, column) > (insertion.row, insertion.column))
    });
    source_map.entries.insert(
        position.unwrap_or(source_map.entries.len()),
        NodeMapEntry {
            node_id: node_id.clone(),
            node_hash,
            source: SourceAnchor {
                source_cell_ref: None,
                created_in_hcd: true,
                part: part.clone(),
                text_ordinal: ordinal,
                paragraph_id: Some(reference),
                text_id: None,
                node_kind: "cell".to_string(),
                editable: !insertion.formula,
            },
        },
    );
    Ok((node_id, part))
}

pub(in crate::patch) fn update_xlsx_cell_format(
    html: &mut String,
    node_id: &str,
    format: &XlsxCellFormatPatch,
) -> Result<bool, HcdError> {
    let mut rich = crate::extract_xlsx_inline_runs(html)?.remove(node_id);
    let mut rich_changed = false;
    if let Some(runs) = &mut rich {
        for run in runs {
            for (key, requested) in [
                ("b", format.bold.is_some()),
                ("i", format.italic.is_some()),
                ("u", format.underline.is_some()),
                ("sz", format.font_size_pt.is_some()),
                ("color", format.color.is_some()),
            ] {
                if requested {
                    rich_changed |= run.properties.remove(key).is_some();
                }
            }
        }
    }
    let marker = format!("data-hcd-id=\"{node_id}\"");
    let marker_at = html
        .find(&marker)
        .ok_or_else(|| HcdError::InvalidBundle(format!("XLSX cell node {node_id} is missing")))?;
    let cell_start = html[..marker_at].rfind("<td ").ok_or_else(|| {
        HcdError::InvalidBundle("XLSX cell node has no containing cell".to_string())
    })?;
    let cell_end = html[cell_start..]
        .find('>')
        .map(|offset| cell_start + offset)
        .ok_or_else(|| HcdError::InvalidBundle("XLSX cell tag is not closed".to_string()))?;
    let mut cell = html[cell_start..=cell_end].to_string();
    if !cell.contains("class=\"hcd-cell") {
        return Err(HcdError::Unsupported(
            "XLSX cell formatting requires a worksheet cell".to_string(),
        ));
    }
    let existing = xlsx_format_from_tag(&cell)?;
    let normalize =
        |color: &String| format!("#{}", color.trim_start_matches('#').to_ascii_uppercase());
    let color = format.color.as_ref().map(normalize);
    let fill = format.fill.as_ref().map(normalize);
    let merged = XlsxCellFormatPatch {
        bold: format.bold.or(existing.bold),
        italic: format.italic.or(existing.italic),
        underline: format.underline.or(existing.underline),
        font_size_pt: format.font_size_pt.or(existing.font_size_pt),
        color: color.or_else(|| existing.color.clone()),
        fill: fill.or_else(|| existing.fill.clone()),
    };
    if merged == existing && !rich_changed {
        return Err(HcdError::InvalidPatch(
            "XLSX cell format is unchanged".to_string(),
        ));
    }
    set_tag_attribute(&mut cell, "data-hcd-format-edited", "true");
    write_xlsx_format_attributes(&mut cell, &merged);
    apply_xlsx_cell_css(&mut cell, &merged)?;
    html.replace_range(cell_start..=cell_end, &cell);
    if let Some(runs) = rich {
        let text: String = runs.iter().map(|run| run.text.as_str()).collect();
        replace_node_content(
            html,
            node_id,
            &crate::render_xlsx_inline_runs(&runs)?,
            &hash_bytes(text.as_bytes()),
        )?;
    }
    Ok(rich_changed)
}

pub(in crate::patch) fn xlsx_format_from_tag(tag: &str) -> Result<XlsxCellFormatPatch, HcdError> {
    if xlsx_attribute(tag, "data-hcd-format-edited") != Some("true") {
        return Ok(XlsxCellFormatPatch::default());
    }
    let flag = |name: &str| -> Result<Option<bool>, HcdError> {
        match xlsx_attribute(tag, name) {
            Some("1") => Ok(Some(true)),
            Some("0") => Ok(Some(false)),
            Some(_) => Err(HcdError::InvalidBundle(format!("XLSX {name} is invalid"))),
            None => Ok(None),
        }
    };
    let font_size_pt = match xlsx_attribute(tag, "data-hcd-font-size-pt") {
        Some(value) => Some(value.parse::<f32>().map_err(|_| {
            HcdError::InvalidBundle("XLSX stored font size is invalid".to_string())
        })?),
        None => None,
    };
    let color = xlsx_attribute(tag, "data-hcd-color").map(|value| format!("#{value}"));
    let fill = xlsx_attribute(tag, "data-hcd-fill").map(|value| format!("#{value}"));
    Ok(XlsxCellFormatPatch {
        bold: flag("data-hcd-bold")?,
        italic: flag("data-hcd-italic")?,
        underline: flag("data-hcd-underline")?,
        font_size_pt,
        color,
        fill,
    })
}

pub(in crate::patch) fn write_xlsx_format_attributes(
    tag: &mut String,
    format: &XlsxCellFormatPatch,
) {
    if let Some(bold) = format.bold {
        set_tag_attribute(tag, "data-hcd-bold", if bold { "1" } else { "0" });
    }
    if let Some(italic) = format.italic {
        set_tag_attribute(tag, "data-hcd-italic", if italic { "1" } else { "0" });
    }
    if let Some(underline) = format.underline {
        set_tag_attribute(tag, "data-hcd-underline", if underline { "1" } else { "0" });
    }
    if let Some(size) = format.font_size_pt {
        let size = format!("{size:.2}");
        set_tag_attribute(tag, "data-hcd-font-size-pt", &size);
    }
    if let Some(color) = &format.color {
        let color = color.trim_start_matches('#').to_ascii_uppercase();
        set_tag_attribute(tag, "data-hcd-color", &color);
    }
    if let Some(fill) = &format.fill {
        let fill = fill.trim_start_matches('#').to_ascii_uppercase();
        set_tag_attribute(tag, "data-hcd-fill", &fill);
    }
}

pub(in crate::patch) fn apply_xlsx_cell_css(
    tag: &mut String,
    format: &XlsxCellFormatPatch,
) -> Result<(), HcdError> {
    let style_marker = " style=\"";
    let mut declarations = BTreeMap::new();
    let style_range = tag.find(style_marker).map(|start| {
        let value_start = start + style_marker.len();
        let value_end = tag[value_start..]
            .find('"')
            .map(|offset| value_start + offset)
            .unwrap_or(value_start);
        (value_start, value_end)
    });
    if let Some((value_start, value_end)) = style_range {
        for declaration in tag[value_start..value_end].split(';') {
            let Some((property, value)) = declaration.split_once(':') else {
                continue;
            };
            declarations.insert(
                property.trim().to_ascii_lowercase(),
                value.trim().to_string(),
            );
        }
    }
    if let Some(bold) = format.bold {
        declarations.insert(
            "font-weight".to_string(),
            if bold { "700" } else { "400" }.to_string(),
        );
    }
    if let Some(italic) = format.italic {
        declarations.insert(
            "font-style".to_string(),
            if italic { "italic" } else { "normal" }.to_string(),
        );
    }
    if let Some(underline) = format.underline {
        let mut tokens = declarations
            .get("text-decoration")
            .map(|value| {
                value
                    .split_whitespace()
                    .filter(|token| *token != "underline" && *token != "none")
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if underline {
            tokens.push("underline".to_string());
        }
        declarations.insert(
            "text-decoration".to_string(),
            if tokens.is_empty() {
                "none".to_string()
            } else {
                tokens.join(" ")
            },
        );
    }
    if let Some(size) = format.font_size_pt {
        declarations.insert("font-size".to_string(), format!("{size:.2}pt"));
    }
    if let Some(color) = &format.color {
        declarations.insert(
            "color".to_string(),
            format!("#{}", color.trim_start_matches('#').to_ascii_lowercase()),
        );
    }
    if let Some(fill) = &format.fill {
        declarations.insert(
            "background-color".to_string(),
            format!("#{}", fill.trim_start_matches('#').to_ascii_lowercase()),
        );
    }
    let style_value = declarations
        .iter()
        .map(|(property, value)| format!("{property}:{value}"))
        .collect::<Vec<_>>()
        .join(";");
    if !style_value.is_empty() {
        crate::html::validate_inline_style(&style_value)?;
    }
    if let Some((value_start, value_end)) = style_range {
        if style_value.is_empty() {
            let style_start = tag[..value_start].rfind(" style=\"").unwrap_or(value_start);
            tag.replace_range(style_start..value_end + 1, "");
        } else {
            tag.replace_range(value_start..value_end, &style_value);
        }
    } else if !style_value.is_empty() {
        tag.insert_str(tag.len() - 1, &format!(" style=\"{style_value}\""));
    }
    Ok(())
}

pub(in crate::patch) fn update_xlsx_cell_layout(
    html: &mut String,
    node_id: &str,
    layout: &XlsxCellLayoutPatch,
) -> Result<(), HcdError> {
    let marker = format!("data-hcd-id=\"{node_id}\"");
    let marker_at = html
        .find(&marker)
        .ok_or_else(|| HcdError::InvalidBundle(format!("XLSX cell node {node_id} is missing")))?;
    let cell_start = html[..marker_at].rfind("<td ").ok_or_else(|| {
        HcdError::InvalidBundle("XLSX cell node has no containing cell".to_string())
    })?;
    let cell_end = html[cell_start..]
        .find('>')
        .map(|offset| cell_start + offset)
        .ok_or_else(|| HcdError::InvalidBundle("XLSX cell tag is not closed".to_string()))?;
    let mut cell = html[cell_start..=cell_end].to_string();
    if !cell.contains("class=\"hcd-cell") {
        return Err(HcdError::Unsupported(
            "XLSX cell layout requires a worksheet cell".to_string(),
        ));
    }
    let existing = xlsx_layout_from_tag(&cell)?;
    let merged = XlsxCellLayoutPatch {
        horizontal: layout
            .horizontal
            .clone()
            .or_else(|| existing.horizontal.clone()),
        vertical: layout
            .vertical
            .clone()
            .or_else(|| existing.vertical.clone()),
        wrap: layout.wrap.or(existing.wrap),
        border: layout.border.clone().or_else(|| existing.border.clone()),
    };
    if merged == existing {
        return Err(HcdError::InvalidPatch(
            "XLSX cell layout is unchanged".to_string(),
        ));
    }
    set_tag_attribute(&mut cell, "data-hcd-layout-edited", "true");
    write_xlsx_layout_attributes(&mut cell, &merged);
    apply_xlsx_layout_css(&mut cell, &merged)?;
    html.replace_range(cell_start..=cell_end, &cell);
    Ok(())
}

pub(in crate::patch) fn xlsx_layout_from_tag(tag: &str) -> Result<XlsxCellLayoutPatch, HcdError> {
    if xlsx_attribute(tag, "data-hcd-layout-edited") != Some("true") {
        return Ok(XlsxCellLayoutPatch::default());
    }
    let choice = |name: &str, allowed: &[&str]| -> Result<Option<String>, HcdError> {
        match xlsx_attribute(tag, name) {
            Some(value) if allowed.contains(&value) => Ok(Some(value.to_string())),
            Some(_) => Err(HcdError::InvalidBundle(format!("XLSX {name} is invalid"))),
            None => Ok(None),
        }
    };
    let wrap = match xlsx_attribute(tag, "data-hcd-wrap") {
        Some("1") => Some(true),
        Some("0") => Some(false),
        Some(_) => {
            return Err(HcdError::InvalidBundle(
                "XLSX data-hcd-wrap is invalid".to_string(),
            ))
        }
        None => None,
    };
    Ok(XlsxCellLayoutPatch {
        horizontal: choice("data-hcd-align", &["left", "center", "right"])?,
        vertical: choice("data-hcd-valign", &["top", "center", "bottom"])?,
        wrap,
        border: choice("data-hcd-border", &["none", "thin"])?,
    })
}

pub(in crate::patch) fn write_xlsx_layout_attributes(
    tag: &mut String,
    layout: &XlsxCellLayoutPatch,
) {
    if let Some(horizontal) = &layout.horizontal {
        set_tag_attribute(tag, "data-hcd-align", horizontal);
    }
    if let Some(vertical) = &layout.vertical {
        set_tag_attribute(tag, "data-hcd-valign", vertical);
    }
    if let Some(wrap) = layout.wrap {
        set_tag_attribute(tag, "data-hcd-wrap", if wrap { "1" } else { "0" });
    }
    if let Some(border) = &layout.border {
        set_tag_attribute(tag, "data-hcd-border", border);
    }
}

pub(in crate::patch) fn apply_xlsx_layout_css(
    tag: &mut String,
    layout: &XlsxCellLayoutPatch,
) -> Result<(), HcdError> {
    let style_marker = " style=\"";
    let mut declarations = BTreeMap::new();
    let style_range = tag.find(style_marker).map(|start| {
        let value_start = start + style_marker.len();
        let value_end = tag[value_start..]
            .find('"')
            .map(|offset| value_start + offset)
            .unwrap_or(value_start);
        (value_start, value_end)
    });
    if let Some((value_start, value_end)) = style_range {
        for declaration in tag[value_start..value_end].split(';') {
            let Some((property, value)) = declaration.split_once(':') else {
                continue;
            };
            declarations.insert(
                property.trim().to_ascii_lowercase(),
                value.trim().to_string(),
            );
        }
    }
    if let Some(horizontal) = &layout.horizontal {
        declarations.insert("text-align".to_string(), horizontal.clone());
    }
    if let Some(vertical) = &layout.vertical {
        declarations.insert(
            "vertical-align".to_string(),
            if vertical == "center" {
                "middle".to_string()
            } else {
                vertical.clone()
            },
        );
    }
    if let Some(wrap) = layout.wrap {
        declarations.insert(
            "white-space".to_string(),
            if wrap { "pre-wrap" } else { "nowrap" }.to_string(),
        );
    }
    if let Some(border) = &layout.border {
        let value = if border == "thin" {
            "1px solid #000000".to_string()
        } else {
            "0".to_string()
        };
        for side in ["border-left", "border-right", "border-top", "border-bottom"] {
            declarations.insert(side.to_string(), value.clone());
        }
    }
    let style_value = declarations
        .iter()
        .map(|(property, value)| format!("{property}:{value}"))
        .collect::<Vec<_>>()
        .join(";");
    if !style_value.is_empty() {
        crate::html::validate_inline_style(&style_value)?;
    }
    if let Some((value_start, value_end)) = style_range {
        if style_value.is_empty() {
            let style_start = tag[..value_start].rfind(" style=\"").unwrap_or(value_start);
            tag.replace_range(style_start..value_end + 1, "");
        } else {
            tag.replace_range(value_start..value_end, &style_value);
        }
    } else if !style_value.is_empty() {
        tag.insert_str(tag.len() - 1, &format!(" style=\"{style_value}\""));
    }
    Ok(())
}

pub(in crate::patch) fn update_xlsx_cell_number_format(
    html: &mut String,
    node_id: &str,
    format: &XlsxCellNumberFormatPatch,
) -> Result<(), HcdError> {
    let marker = format!("data-hcd-id=\"{node_id}\"");
    let marker_at = html
        .find(&marker)
        .ok_or_else(|| HcdError::InvalidBundle(format!("XLSX cell node {node_id} is missing")))?;
    let cell_start = html[..marker_at].rfind("<td ").ok_or_else(|| {
        HcdError::InvalidBundle("XLSX cell node has no containing cell".to_string())
    })?;
    let cell_end = html[cell_start..]
        .find('>')
        .map(|offset| cell_start + offset)
        .ok_or_else(|| HcdError::InvalidBundle("XLSX cell tag is not closed".to_string()))?;
    let mut cell = html[cell_start..=cell_end].to_string();
    if !cell.contains("class=\"hcd-cell") {
        return Err(HcdError::Unsupported(
            "XLSX number format requires a worksheet cell".to_string(),
        ));
    }
    if xlsx_number_format_from_tag(&cell)?.as_deref() == Some(format.format_code.as_str()) {
        return Err(HcdError::InvalidPatch(
            "XLSX cell number format is unchanged".to_string(),
        ));
    }
    set_tag_attribute(&mut cell, "data-hcd-num-fmt-edited", "true");
    set_tag_attribute(&mut cell, "data-hcd-num-fmt-code", &format.format_code);
    set_tag_attribute(&mut cell, "data-hcd-num-fmt-pattern", &format.format_code);
    html.replace_range(cell_start..=cell_end, &cell);
    Ok(())
}

pub(in crate::patch) fn xlsx_number_format_from_tag(tag: &str) -> Result<Option<String>, HcdError> {
    let raw = if xlsx_attribute(tag, "data-hcd-num-fmt-edited") == Some("true") {
        xlsx_attribute(tag, "data-hcd-num-fmt-code")
    } else {
        xlsx_attribute(tag, "data-hcd-num-fmt-pattern")
    };
    Ok(raw.map(unescape_attribute))
}
