use super::*;

pub(in crate::patch) fn collect_xlsx_merges(patch: &PatchBatch) -> HashMap<String, XlsxMerge> {
    patch
        .operations
        .iter()
        .filter_map(|operation| {
            let PatchOperation::XlsxMerge {
                node_id,
                sheet_id,
                start_row,
                start_column,
                end_row,
                end_column,
                precondition,
            } = operation
            else {
                return None;
            };
            Some((
                node_id.clone(),
                XlsxMerge {
                    sheet_id: sheet_id.clone(),
                    start_row: *start_row,
                    start_column: *start_column,
                    end_row: *end_row,
                    end_column: *end_column,
                    node_hash: precondition.node_hash.clone(),
                },
            ))
        })
        .collect()
}

pub(in crate::patch) fn collect_xlsx_blank_merge(patch: &PatchBatch) -> Option<XlsxMerge> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::XlsxMergeBlank {
            sheet_id,
            start_row,
            start_column,
            end_row,
            end_column,
        } = operation
        else {
            return None;
        };
        Some(XlsxMerge {
            sheet_id: sheet_id.clone(),
            start_row: *start_row,
            start_column: *start_column,
            end_row: *end_row,
            end_column: *end_column,
            node_hash: hash_bytes(b""),
        })
    })
}

pub(in crate::patch) fn collect_xlsx_unmerges(patch: &PatchBatch) -> HashMap<String, XlsxMerge> {
    patch
        .operations
        .iter()
        .filter_map(|operation| {
            let PatchOperation::XlsxUnmerge {
                node_id,
                sheet_id,
                start_row,
                start_column,
                end_row,
                end_column,
                precondition,
            } = operation
            else {
                return None;
            };
            Some((
                node_id.clone(),
                XlsxMerge {
                    sheet_id: sheet_id.clone(),
                    start_row: *start_row,
                    start_column: *start_column,
                    end_row: *end_row,
                    end_column: *end_column,
                    node_hash: precondition.node_hash.clone(),
                },
            ))
        })
        .collect()
}

pub(in crate::patch) fn collect_xlsx_row_append(patch: &PatchBatch) -> Option<XlsxRowAppend> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::XlsxRowAppend {
            sheet_id,
            after_row,
        } = operation
        else {
            return None;
        };
        Some(XlsxRowAppend {
            sheet_id: sheet_id.clone(),
            after_row: *after_row,
        })
    })
}

pub(in crate::patch) fn collect_xlsx_row_insert(patch: &PatchBatch) -> Option<XlsxRowInsert> {
    patch.operations.iter().find_map(|operation| {
        if let PatchOperation::XlsxGridRange {
            sheet_id,
            axis: XlsxGridAxis::Row,
            action: XlsxGridAction::Insert,
            start,
            count,
        } = operation
        {
            return Some(XlsxRowInsert {
                sheet_id: sheet_id.clone(),
                before_row: *start,
                count: *count,
            });
        }
        let PatchOperation::XlsxRowInsert {
            sheet_id,
            before_row,
        } = operation
        else {
            return None;
        };
        Some(XlsxRowInsert {
            sheet_id: sheet_id.clone(),
            before_row: *before_row,
            count: 1,
        })
    })
}

pub(in crate::patch) fn collect_xlsx_row_delete(patch: &PatchBatch) -> Option<XlsxRowDelete> {
    patch.operations.iter().find_map(|operation| {
        if let PatchOperation::XlsxGridRange {
            sheet_id,
            axis: XlsxGridAxis::Row,
            action: XlsxGridAction::Delete,
            start,
            count,
        } = operation
        {
            return Some(XlsxRowDelete {
                sheet_id: sheet_id.clone(),
                row: *start,
                count: *count,
            });
        }
        let PatchOperation::XlsxRowDelete { sheet_id, row } = operation else {
            return None;
        };
        Some(XlsxRowDelete {
            sheet_id: sheet_id.clone(),
            row: *row,
            count: 1,
        })
    })
}

pub(in crate::patch) fn collect_xlsx_column_insert(patch: &PatchBatch) -> Option<XlsxColumnInsert> {
    patch.operations.iter().find_map(|operation| {
        if let PatchOperation::XlsxGridRange {
            sheet_id,
            axis: XlsxGridAxis::Column,
            action: XlsxGridAction::Insert,
            start,
            count,
        } = operation
        {
            return Some(XlsxColumnInsert {
                sheet_id: sheet_id.clone(),
                before_column: *start,
                count: *count,
            });
        }
        let PatchOperation::XlsxColumnInsert {
            sheet_id,
            before_column,
        } = operation
        else {
            return None;
        };
        Some(XlsxColumnInsert {
            sheet_id: sheet_id.clone(),
            before_column: *before_column,
            count: 1,
        })
    })
}

pub(in crate::patch) fn collect_xlsx_column_delete(patch: &PatchBatch) -> Option<XlsxColumnDelete> {
    patch.operations.iter().find_map(|operation| {
        if let PatchOperation::XlsxGridRange {
            sheet_id,
            axis: XlsxGridAxis::Column,
            action: XlsxGridAction::Delete,
            start,
            count,
        } = operation
        {
            return Some(XlsxColumnDelete {
                sheet_id: sheet_id.clone(),
                column: *start,
                count: *count,
            });
        }
        let PatchOperation::XlsxColumnDelete { sheet_id, column } = operation else {
            return None;
        };
        Some(XlsxColumnDelete {
            sheet_id: sheet_id.clone(),
            column: *column,
            count: 1,
        })
    })
}

pub(in crate::patch) fn collect_xlsx_row_removal(patch: &PatchBatch) -> Option<XlsxRowRemoval> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::XlsxRowRemoveLast { sheet_id, row } = operation else {
            return None;
        };
        Some(XlsxRowRemoval {
            sheet_id: sheet_id.clone(),
            row: *row,
        })
    })
}

pub(in crate::patch) fn collect_xlsx_column_width(patch: &PatchBatch) -> Option<XlsxColumnWidth> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::XlsxColumnWidth {
            sheet_id,
            column,
            width_chars,
        } = operation
        else {
            return None;
        };
        Some(XlsxColumnWidth {
            sheet_id: sheet_id.clone(),
            column: *column,
            width_chars: *width_chars,
        })
    })
}

pub(in crate::patch) fn collect_xlsx_row_height(patch: &PatchBatch) -> Option<XlsxRowHeight> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::XlsxRowHeight {
            sheet_id,
            row,
            height_points,
        } = operation
        else {
            return None;
        };
        Some(XlsxRowHeight {
            sheet_id: sheet_id.clone(),
            row: *row,
            height_points: *height_points,
        })
    })
}

pub(in crate::patch) fn set_xlsx_row_height(
    html: &mut String,
    row: u32,
    height: f64,
) -> Result<(), HcdError> {
    let marker = format!("<tr data-hcd-row=\"{row}\"");
    let start = html.find(&marker).ok_or_else(|| {
        HcdError::Unsupported("XLSX row height requires a materialized row".to_string())
    })?;
    let end = html[start..]
        .find('>')
        .map(|offset| start + offset)
        .ok_or_else(|| HcdError::InvalidBundle("XLSX row tag is not closed".to_string()))?;
    if xlsx_attribute(&html[start..=end], "data-hcd-hidden") == Some("true") {
        return Err(HcdError::Unsupported(
            "XLSX hidden row cannot be resized before it is shown".to_string(),
        ));
    }
    update_start_tag_style(
        html,
        &marker,
        &BTreeMap::from([("height".to_string(), format!("{height:.2}pt"))]),
        false,
    )?;
    let end = html[start..]
        .find('>')
        .map(|offset| start + offset)
        .ok_or_else(|| HcdError::InvalidBundle("XLSX row tag is not closed".to_string()))?;
    set_attribute_in_range(
        html,
        start,
        end,
        "data-hcd-height-points",
        &format!("{height:.2}"),
    )?;
    let end = html[start..]
        .find('>')
        .map(|offset| start + offset)
        .ok_or_else(|| HcdError::InvalidBundle("XLSX row tag is not closed".to_string()))?;
    set_attribute_in_range(html, start, end, "data-hcd-height-edited", "true")?;
    Ok(())
}

pub(in crate::patch) fn find_xlsx_blank_merge_target(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    merge: &XlsxMerge,
) -> Result<String, HcdError> {
    let mut target = None;
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.kind != crate::GridChunkKind::Cells || grid.sheet_id != merge.sheet_id {
                continue;
            }
            let contains_range = grid
                .row_start
                .is_some_and(|start| u64::from(merge.start_row) >= start)
                && grid
                    .row_end
                    .is_some_and(|end| u64::from(merge.end_row) <= end);
            if !contains_range {
                continue;
            }
            if target.replace(descriptor.chunk_id.clone()).is_some() {
                return Err(HcdError::InvalidBundle(
                    "XLSX merge is present in multiple windows".to_string(),
                ));
            }
        }
    }
    target.ok_or_else(|| {
        HcdError::Unsupported(
            "XLSX blank merge must stay within one materialized cell window".to_string(),
        )
    })
}

pub(in crate::patch) fn hcd_column_tag(
    start: u32,
    end: u32,
    width: Option<f64>,
    hidden: bool,
    edited: bool,
) -> String {
    let mut tag = format!(
        "<col span=\"{}\" data-hcd-column-start=\"{start}\" data-hcd-column-end=\"{end}\"",
        end - start + 1
    );
    if let Some(width) = width {
        tag.push_str(&format!(" data-hcd-width=\"{width:.2}\""));
    }
    if edited {
        tag.push_str(" data-hcd-width-edited=\"true\"");
    }
    if hidden {
        tag.push_str(" data-hcd-hidden=\"true\" style=\"display:none\"");
    } else if let Some(width) = width {
        tag.push_str(&format!(" style=\"width:{:.2}px\"", width * 7.5));
    }
    tag.push_str("/>");
    tag
}

pub(in crate::patch) fn set_xlsx_column_width(
    html: &mut String,
    column: u32,
    width: f64,
) -> Result<(), HcdError> {
    let group_start = html.find("<colgroup>").ok_or_else(|| {
        HcdError::InvalidBundle("XLSX grid is missing its column group".to_string())
    })?;
    let group_end = html[group_start..]
        .find("</colgroup>")
        .map(|offset| group_start + offset)
        .ok_or_else(|| HcdError::InvalidBundle("XLSX column group is not closed".to_string()))?;
    let mut cursor = group_start + "<colgroup>".len();
    let mut insert_at = group_end;
    while let Some(offset) = html[cursor..group_end].find("<col ") {
        let tag_start = cursor + offset;
        let tag_end = html[tag_start..group_end]
            .find("/>")
            .map(|offset| tag_start + offset + 2)
            .ok_or_else(|| HcdError::InvalidBundle("XLSX column tag is not closed".to_string()))?;
        let tag = &html[tag_start..tag_end];
        let start = xlsx_attribute(tag, "data-hcd-column-start")
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or_else(|| HcdError::InvalidBundle("XLSX column start is invalid".to_string()))?;
        let end = xlsx_attribute(tag, "data-hcd-column-end")
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or_else(|| HcdError::InvalidBundle("XLSX column end is invalid".to_string()))?;
        if start == 0 || end < start || end > 16_384 {
            return Err(HcdError::InvalidBundle(
                "XLSX column range is invalid".to_string(),
            ));
        }
        if column < start {
            insert_at = tag_start;
            break;
        }
        if column <= end {
            let old_width =
                xlsx_attribute(tag, "data-hcd-width").and_then(|value| value.parse().ok());
            let hidden = xlsx_attribute(tag, "data-hcd-hidden") == Some("true");
            let mut replacement = String::new();
            if start < column {
                replacement.push_str(&hcd_column_tag(start, column - 1, old_width, hidden, false));
            }
            replacement.push_str(&hcd_column_tag(column, column, Some(width), hidden, true));
            if column < end {
                replacement.push_str(&hcd_column_tag(column + 1, end, old_width, hidden, false));
            }
            html.replace_range(tag_start..tag_end, &replacement);
            return Ok(());
        }
        cursor = tag_end;
    }
    html.insert_str(
        insert_at,
        &hcd_column_tag(column, column, Some(width), false, true),
    );
    Ok(())
}

pub(in crate::patch) fn find_xlsx_row_tail(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    append: &XlsxRowAppend,
) -> Result<String, HcdError> {
    let (last_row, tail) = last_xlsx_row(bundle, manifest, &append.sheet_id)?;
    if last_row != u64::from(append.after_row) {
        return Err(HcdError::PreconditionFailed(format!(
            "XLSX current last row is {last_row}, expected {}",
            append.after_row
        )));
    }
    Ok(tail)
}

pub(in crate::patch) fn find_xlsx_row_insert_target(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    insert: &XlsxRowInsert,
) -> Result<(String, String), HcdError> {
    let (last_row, tail) = last_xlsx_row(bundle, manifest, &insert.sheet_id)?;
    if last_row + u64::from(insert.count) > 1_048_576 {
        return Err(HcdError::ResourceLimit(
            "XLSX row insertion exceeds the last worksheet row".to_string(),
        ));
    }
    if u64::from(insert.before_row) > last_row + 1 {
        return Err(HcdError::Unsupported(
            "insert at or before the next XLSX row".to_string(),
        ));
    }
    let mut target = None;
    // A row the source never wrote is not in any window, but it is still a row
    // of the sheet: its number sits inside a window that stops short of it. That
    // window owns the insertion, so keep it apart from the row that is present.
    let mut gap_target = None;
    let mut part = None;
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if matches!(
                grid.kind,
                crate::GridChunkKind::Picture | crate::GridChunkKind::Chart
            ) && grid.sheet_id == insert.sheet_id
            {
                let mut html = bundle.read_chunk(&descriptor)?;
                let mut preview = descriptor.clone();
                shift_xlsx_visual_anchor(
                    &mut html,
                    &mut preview,
                    XlsxVisualShift::InsertRow(insert.before_row),
                )?;
            }
            if grid.kind != crate::GridChunkKind::Cells {
                continue;
            }
            let html = bundle.read_chunk(&descriptor)?;
            if grid.sheet_id != insert.sheet_id {
                continue;
            }
            rewrite_xlsx_inserted_formula_references(
                &mut html.clone(),
                crate::FormulaInsertion::Row(insert.before_row),
            )?;
            check_xlsx_merge_shift(&html, XlsxMergeShift::InsertRow(insert.before_row))?;
            if part.is_none() {
                part = bundle
                    .read_map(&descriptor)?
                    .entries
                    .into_iter()
                    .find(|entry| entry.source.node_kind == "cell")
                    .map(|entry| entry.source.part);
            }
            let covers = grid
                .row_start
                .is_some_and(|start| start <= u64::from(insert.before_row))
                && grid
                    .row_end
                    .is_some_and(|end| end >= u64::from(insert.before_row));
            if covers {
                let slot = if html.contains(&format!("<tr data-hcd-row=\"{}\"", insert.before_row))
                {
                    &mut target
                } else {
                    &mut gap_target
                };
                if slot.replace(descriptor.chunk_id.clone()).is_some() {
                    return Err(HcdError::InvalidBundle(
                        "duplicate XLSX row insertion target".to_string(),
                    ));
                }
            }
        }
    }
    let target = target
        .or(gap_target)
        .or_else(|| (u64::from(insert.before_row) == last_row + 1).then_some(tail))
        .ok_or_else(|| {
            HcdError::Unsupported("insert before a materialized XLSX row".to_string())
        })?;
    let part = part.ok_or_else(|| {
        HcdError::Unsupported("XLSX worksheet has no mapped source cells".to_string())
    })?;
    Ok((target, part))
}

pub(in crate::patch) fn find_xlsx_row_delete_target(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    delete: &XlsxRowDelete,
) -> Result<(String, String), HcdError> {
    let (last_row, _) = last_xlsx_row(bundle, manifest, &delete.sheet_id)?;
    if u64::from(delete.row) + u64::from(delete.count) - 1 > last_row {
        return Err(HcdError::Unsupported(
            "XLSX row selection extends beyond the materialized sheet".to_string(),
        ));
    }
    let mut target = None;
    // The same gap the insertion above looks through: a row the source never
    // wrote still occupies its number, and deleting it moves everything below
    // it up one, so the window that covers it owns the deletion.
    let mut gap_target = None;
    let mut part = None;
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.sheet_id != delete.sheet_id {
                continue;
            }
            if grid.kind != crate::GridChunkKind::Cells {
                continue;
            }
            let html = bundle.read_chunk(&descriptor)?;
            rewrite_xlsx_formula_references(
                &mut html.clone(),
                crate::FormulaDeletion::Row(delete.row),
            )?;
            check_xlsx_merge_shift(&html, XlsxMergeShift::DeleteRow(delete.row))?;
            if part.is_none() {
                part = bundle
                    .read_map(&descriptor)?
                    .entries
                    .into_iter()
                    .find(|entry| entry.source.node_kind == "cell")
                    .map(|entry| entry.source.part);
            }
            let covers = grid
                .row_start
                .is_some_and(|start| start <= u64::from(delete.row))
                && grid.row_end.is_some_and(|end| end >= u64::from(delete.row));
            if covers {
                let slot = if html.contains(&format!("<tr data-hcd-row=\"{}\"", delete.row)) {
                    &mut target
                } else {
                    &mut gap_target
                };
                if slot.replace(descriptor.chunk_id.clone()).is_some() {
                    return Err(HcdError::InvalidBundle(
                        "duplicate XLSX row deletion target".to_string(),
                    ));
                }
            }
        }
    }
    Ok((
        part.ok_or_else(|| {
            HcdError::Unsupported("XLSX sheet has no mapped source cells".to_string())
        })?,
        target
            .or(gap_target)
            .ok_or_else(|| HcdError::Unsupported("delete an existing XLSX row".to_string()))?,
    ))
}

pub(in crate::patch) fn find_xlsx_column_insert_part(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    insert: &XlsxColumnInsert,
) -> Result<String, HcdError> {
    let mut part = None;
    let mut last_column = 0u32;
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if matches!(
                grid.kind,
                crate::GridChunkKind::Picture | crate::GridChunkKind::Chart
            ) && grid.sheet_id == insert.sheet_id
            {
                let mut html = bundle.read_chunk(&descriptor)?;
                let mut preview = descriptor.clone();
                shift_xlsx_visual_anchor(
                    &mut html,
                    &mut preview,
                    XlsxVisualShift::InsertColumn(insert.before_column),
                )?;
            }
            if grid.kind != crate::GridChunkKind::Cells {
                continue;
            }
            let html = bundle.read_chunk(&descriptor)?;
            if grid.sheet_id != insert.sheet_id {
                continue;
            }
            rewrite_xlsx_inserted_formula_references(
                &mut html.clone(),
                crate::FormulaInsertion::Column(insert.before_column),
            )?;
            check_xlsx_merge_shift(&html, XlsxMergeShift::InsertColumn(insert.before_column))?;
            shift_xlsx_column_widths(&mut html.clone(), insert.before_column)?;
            last_column = last_column.max(grid.column_end.unwrap_or(0));
            if part.is_none() {
                part = bundle
                    .read_map(&descriptor)?
                    .entries
                    .into_iter()
                    .find(|entry| entry.source.node_kind == "cell")
                    .map(|entry| entry.source.part);
            }
        }
    }
    if u64::from(last_column) + u64::from(insert.count) > 16_384 {
        return Err(HcdError::ResourceLimit(
            "XLSX column insertion exceeds the last worksheet column".to_string(),
        ));
    }
    if insert.before_column > last_column.saturating_add(1) {
        return Err(HcdError::Unsupported(
            "insert at or before the next XLSX column".to_string(),
        ));
    }
    part.ok_or_else(|| {
        HcdError::Unsupported("XLSX worksheet has no mapped source cells".to_string())
    })
}

pub(in crate::patch) fn find_xlsx_column_delete_part(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    delete: &XlsxColumnDelete,
) -> Result<String, HcdError> {
    let mut part = None;
    let mut last_column = 0u32;
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.sheet_id != delete.sheet_id {
                continue;
            }
            if grid.kind != crate::GridChunkKind::Cells {
                continue;
            }
            let html = bundle.read_chunk(&descriptor)?;
            rewrite_xlsx_formula_references(
                &mut html.clone(),
                crate::FormulaDeletion::Column(delete.column),
            )?;
            check_xlsx_merge_shift(&html, XlsxMergeShift::DeleteColumn(delete.column))?;
            last_column = last_column.max(grid.column_end.unwrap_or(0));
            if part.is_none() {
                part = bundle
                    .read_map(&descriptor)?
                    .entries
                    .into_iter()
                    .find(|entry| entry.source.node_kind == "cell")
                    .map(|entry| entry.source.part);
            }
        }
    }
    if u64::from(delete.column) + u64::from(delete.count) - 1 > u64::from(last_column) {
        return Err(HcdError::Unsupported(
            "XLSX column selection extends beyond the materialized sheet".to_string(),
        ));
    }
    if delete.column > last_column {
        return Err(HcdError::Unsupported(
            "delete an existing XLSX column".to_string(),
        ));
    }
    if part.is_none() {
        let (original, _) = crate::manifest_at_revision(bundle, manifest, Some(0))?;
        for page_number in 0..original.index_page_count {
            for descriptor in bundle.read_index_page(&original, page_number)?.chunks {
                if descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind == crate::GridChunkKind::Cells && grid.sheet_id == delete.sheet_id
                }) {
                    part = bundle
                        .read_map(&descriptor)?
                        .entries
                        .into_iter()
                        .find(|entry| entry.source.node_kind == "cell")
                        .map(|entry| entry.source.part);
                    if part.is_some() {
                        break;
                    }
                }
            }
        }
    }
    part.ok_or_else(|| {
        HcdError::Unsupported("XLSX worksheet has no mapped source cells".to_string())
    })
}

pub(in crate::patch) fn find_xlsx_row_removal_target(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    removal: &XlsxRowRemoval,
) -> Result<String, HcdError> {
    let (last_row, tail) = last_xlsx_row(bundle, manifest, &removal.sheet_id)?;
    if last_row != u64::from(removal.row) {
        return Err(HcdError::PreconditionFailed(format!(
            "XLSX current last row is {last_row}, expected {}",
            removal.row
        )));
    }
    let (original, _) = crate::manifest_at_revision(bundle, manifest, Some(0))?;
    let (original_last_row, _) = last_xlsx_row(bundle, &original, &removal.sheet_id)?;
    if last_row <= original_last_row {
        return Err(HcdError::PreconditionFailed(
            "XLSX source rows cannot be removed with this operation".to_string(),
        ));
    }
    Ok(tail)
}

pub(in crate::patch) fn last_xlsx_row(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    sheet_id: &str,
) -> Result<(u64, String), HcdError> {
    let mut tail = None;
    let mut last_row = 0u64;
    // A worksheet the source stores without any row element keeps one cell
    // window with no row bounds. It is the tail of a sheet whose last row is
    // zero, so its first row can be created by a cell write or a row append.
    let mut empty_tail: Option<String> = None;
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.kind != crate::GridChunkKind::Cells || grid.sheet_id != sheet_id {
                continue;
            }
            let Some(end) = grid.row_end else {
                if empty_tail.replace(descriptor.chunk_id).is_some() {
                    return Err(HcdError::InvalidBundle(
                        "XLSX empty worksheet appears in multiple cell windows".to_string(),
                    ));
                }
                continue;
            };
            if end > last_row {
                last_row = end;
                tail = Some(descriptor.chunk_id);
            } else if end == last_row {
                return Err(HcdError::InvalidBundle(
                    "XLSX last row appears in multiple cell windows".to_string(),
                ));
            }
        }
    }
    if tail.is_none() {
        tail = empty_tail;
    }
    tail.map(|tail| (last_row, tail)).ok_or_else(|| {
        HcdError::Unsupported(
            "XLSX row operation requires an existing nonempty worksheet".to_string(),
        )
    })
}

pub(in crate::patch) fn append_xlsx_row(html: &mut String, after_row: u32) -> Result<(), HcdError> {
    let section_end = html
        .find('>')
        .ok_or_else(|| HcdError::InvalidBundle("XLSX sheet section is not closed".to_string()))?;
    if after_row == 0 {
        // The first row of a worksheet the source stored with no rows at all:
        // its section carries neither row bound and its table body is empty.
        // Row bounds go right after the sheet state, the same order an imported
        // worksheet window uses, so a re-import hashes to the same chunk.
        if html[..section_end].contains(" data-hcd-row-start=") {
            return Err(HcdError::InvalidBundle(
                "XLSX worksheet already has a row window".to_string(),
            ));
        }
        let body_start = html
            .find("<tbody>")
            .ok_or_else(|| HcdError::InvalidBundle("XLSX sheet has no table body".to_string()))?;
        if !html[body_start..].starts_with("<tbody></tbody>") {
            return Err(HcdError::InvalidBundle(
                "XLSX empty worksheet already has rows".to_string(),
            ));
        }
        let state = html[..section_end]
            .find(" data-hcd-sheet-state=\"")
            .ok_or_else(|| HcdError::InvalidBundle("XLSX sheet state is missing".to_string()))?
            + " data-hcd-sheet-state=\"".len();
        let insert_at = state
            + html[state..section_end].find('"').ok_or_else(|| {
                HcdError::InvalidBundle("XLSX sheet state is unclosed".to_string())
            })?
            + 1;
        html.insert_str(body_start + "<tbody>".len(), "<tr data-hcd-row=\"1\"></tr>");
        html.insert_str(
            insert_at,
            " data-hcd-row-start=\"1\" data-hcd-row-end=\"1\"",
        );
        return Ok(());
    }
    let old_end = format!(" data-hcd-row-end=\"{after_row}\"");
    let marker = html[..section_end].find(&old_end).ok_or_else(|| {
        HcdError::InvalidBundle("XLSX sheet row end disagrees with its descriptor".to_string())
    })?;
    let body_end = html
        .find("</tbody>")
        .ok_or_else(|| HcdError::InvalidBundle("XLSX sheet has no table body".to_string()))?;
    let last_row_start = html[..body_end]
        .rfind("<tr ")
        .ok_or_else(|| HcdError::InvalidBundle("XLSX sheet has no last row".to_string()))?;
    let last_tag_end = html[last_row_start..body_end]
        .find('>')
        .map(|offset| last_row_start + offset)
        .ok_or_else(|| HcdError::InvalidBundle("XLSX last row tag is unclosed".to_string()))?;
    if !html[last_row_start..last_tag_end].contains(&format!(" data-hcd-row=\"{after_row}\""))
        || !html[last_tag_end..body_end].ends_with("</tr>")
    {
        return Err(HcdError::InvalidBundle(
            "XLSX last row does not match the append precondition".to_string(),
        ));
    }
    html.insert_str(
        body_end,
        &format!("<tr data-hcd-row=\"{}\"></tr>", after_row + 1),
    );
    html.replace_range(
        marker..marker + old_end.len(),
        &format!(" data-hcd-row-end=\"{}\"", after_row + 1),
    );
    Ok(())
}

pub(in crate::patch) fn shift_xlsx_row_window(
    html: &mut String,
    source_map: &mut crate::ChunkSourceMap,
    descriptor: &mut crate::ChunkDescriptor,
    before_row: u32,
    insert_here: bool,
) -> Result<(), HcdError> {
    rewrite_xlsx_merge_refs(html, XlsxMergeShift::InsertRow(before_row))?;
    let grid = descriptor.grid.as_mut().ok_or_else(|| {
        HcdError::InvalidBundle("XLSX row window has no grid address".to_string())
    })?;
    let old_start = grid
        .row_start
        .ok_or_else(|| HcdError::InvalidBundle("XLSX row window has no start".to_string()))?;
    let old_end = grid
        .row_end
        .ok_or_else(|| HcdError::InvalidBundle("XLSX row window has no end".to_string()))?;
    if insert_here && u64::from(before_row) == old_end + 1 {
        append_xlsx_row(html, old_end as u32)?;
        grid.row_end = Some(old_end + 1);
        descriptor.block_count += 1;
        return Ok(());
    }
    let mut rows = BTreeSet::new();
    let cells = xlsx_cells(html)?;
    let mut cursor = 0usize;
    while let Some(offset) = html[cursor..].find("<tr data-hcd-row=\"") {
        let start = cursor + offset + "<tr data-hcd-row=\"".len();
        let end = html[start..]
            .find('"')
            .map(|offset| start + offset)
            .ok_or_else(|| HcdError::InvalidBundle("XLSX row label is unclosed".to_string()))?;
        let row: u32 = html[start..end]
            .parse()
            .map_err(|_| HcdError::InvalidBundle("XLSX row label is invalid".to_string()))?;
        if row >= before_row {
            rows.insert(row);
        }
        cursor = end + 1;
    }
    // The row the new one goes in front of is the lowest one at or after the
    // insertion point, present or not: a gap row has no row of its own, so its
    // successor is the first row further down the sheet, and that is where the
    // new row lands.
    let successor = insert_here.then(|| rows.first().copied()).flatten();
    for row in rows.into_iter().rev() {
        let next = row
            .checked_add(1)
            .filter(|next| *next <= 1_048_576)
            .ok_or_else(|| {
                HcdError::ResourceLimit("XLSX row exceeds the worksheet limit".to_string())
            })?;
        for cell in cells.iter().filter(|cell| cell.row == row) {
            let old = format!("{}{}", xlsx_column_name(cell.column), row);
            let new = format!("{}{}", xlsx_column_name(cell.column), next);
            *html = html.replace(
                &format!(" data-hcd-cell=\"{old}\""),
                &format!(" data-hcd-cell=\"{new}\""),
            );
        }
        *html = html.replace(
            &format!("<tr data-hcd-row=\"{row}\""),
            &format!("<tr data-hcd-row=\"{next}\""),
        );
    }
    for entry in &mut source_map.entries {
        if entry.source.node_kind != "cell" {
            continue;
        }
        let Some(reference) = entry.source.paragraph_id.clone() else {
            continue;
        };
        let Some((row, column)) = xlsx_cell_coordinates(&reference) else {
            return Err(HcdError::InvalidBundle(
                "XLSX mapped cell has invalid address".to_string(),
            ));
        };
        if row < before_row {
            continue;
        }
        if !entry.source.created_in_hcd && entry.source.source_cell_ref.is_none() {
            entry.source.source_cell_ref = Some(reference);
        }
        entry.source.paragraph_id = Some(format!("{}{}", xlsx_column_name(column), row + 1));
    }
    let new_start = if old_start >= u64::from(before_row) && !insert_here {
        old_start + 1
    } else {
        old_start
    };
    let new_end = old_end + 1;
    for (name, old, new) in [
        ("data-hcd-row-start", old_start, new_start),
        ("data-hcd-row-end", old_end, new_end),
    ] {
        let before = format!(" {name}=\"{old}\"");
        if !html.contains(&before) {
            return Err(HcdError::InvalidBundle(format!(
                "XLSX window is missing {name}"
            )));
        }
        *html = html.replacen(&before, &format!(" {name}=\"{new}\""), 1);
    }
    if insert_here {
        // In front of the successor the gap row now sits, or at the bottom of
        // the window when the source stopped writing rows above its own end.
        let position = match successor {
            Some(successor) => {
                let marker = format!("<tr data-hcd-row=\"{}\"", successor + 1);
                html.find(&marker).ok_or_else(|| {
                    HcdError::InvalidBundle("shifted XLSX insertion row is missing".to_string())
                })?
            }
            None => html.find("</tbody>").ok_or_else(|| {
                HcdError::InvalidBundle("XLSX sheet has no table body".to_string())
            })?,
        };
        html.insert_str(
            position,
            &format!("<tr data-hcd-row=\"{before_row}\"></tr>"),
        );
        descriptor.block_count += 1;
    }
    grid.row_start = Some(new_start);
    grid.row_end = Some(new_end);
    Ok(())
}

pub(in crate::patch) fn delete_xlsx_row_window(
    html: &mut String,
    source_map: &mut crate::ChunkSourceMap,
    descriptor: &mut crate::ChunkDescriptor,
    deleted_row: u32,
) -> Result<Vec<String>, HcdError> {
    rewrite_xlsx_formula_references(html, crate::FormulaDeletion::Row(deleted_row))?;
    rewrite_xlsx_merge_refs(html, XlsxMergeShift::DeleteRow(deleted_row))?;
    let grid = descriptor.grid.as_mut().ok_or_else(|| {
        HcdError::InvalidBundle("XLSX row window has no grid address".to_string())
    })?;
    let old_start = grid
        .row_start
        .ok_or_else(|| HcdError::InvalidBundle("XLSX row window has no start".to_string()))?;
    let old_end = grid
        .row_end
        .ok_or_else(|| HcdError::InvalidBundle("XLSX row window has no end".to_string()))?;
    let promoted_merges: Vec<_> = xlsx_cells(html)?
        .into_iter()
        .filter(|cell| cell.row == deleted_row)
        .filter_map(|cell| cell.merged_range)
        .filter(|range| range.0 == deleted_row)
        .collect();
    let mut rebuilt = String::with_capacity(html.len());
    let mut cursor = 0;
    let mut removed_row = false;
    while let Some(offset) = html[cursor..].find("<tr data-hcd-row=\"") {
        let start = cursor + offset;
        rebuilt.push_str(&html[cursor..start]);
        let label_start = start + "<tr data-hcd-row=\"".len();
        let label_end = html[label_start..]
            .find('"')
            .map(|offset| label_start + offset)
            .ok_or_else(|| HcdError::InvalidBundle("XLSX row label is unclosed".to_string()))?;
        let row: u32 = html[label_start..label_end]
            .parse()
            .map_err(|_| HcdError::InvalidBundle("XLSX row label is invalid".to_string()))?;
        let end = html[label_end..]
            .find("</tr>")
            .map(|offset| label_end + offset + 5)
            .ok_or_else(|| HcdError::InvalidBundle("XLSX row is unclosed".to_string()))?;
        if row == deleted_row {
            removed_row = true;
        } else if row > deleted_row {
            let mut fragment = html[start..end].replacen(
                &format!("data-hcd-row=\"{row}\""),
                &format!("data-hcd-row=\"{}\"", row - 1),
                1,
            );
            for cell in xlsx_cells(&fragment)? {
                let old = format!("{}{}", xlsx_column_name(cell.column), row);
                let new = format!("{}{}", xlsx_column_name(cell.column), row - 1);
                fragment = fragment.replace(
                    &format!("data-hcd-cell=\"{old}\""),
                    &format!("data-hcd-cell=\"{new}\""),
                );
            }
            if row == deleted_row + 1 {
                for &(start_row, start_column, end_row, end_column) in promoted_merges.iter().rev()
                {
                    let cells = xlsx_cells(&fragment)?;
                    if cells.iter().any(|cell| cell.column == start_column) {
                        return Err(HcdError::InvalidBundle(
                            "XLSX merged row anchor overlaps an existing cell".to_string(),
                        ));
                    }
                    let insert_at = cells
                        .iter()
                        .find(|cell| cell.column > start_column)
                        .map(|cell| cell.start)
                        .or_else(|| fragment.find("</tr>"))
                        .ok_or_else(|| {
                            HcdError::InvalidBundle("XLSX row is unclosed".to_string())
                        })?;
                    let range = format!(
                        "{}{}:{}{}",
                        xlsx_column_name(start_column),
                        start_row,
                        xlsx_column_name(end_column),
                        end_row
                    );
                    fragment.insert_str(insert_at, &format!(
                        "<td class=\"hcd-cell hcd-empty\" data-hcd-column=\"{start_column}\" data-hcd-merge=\"{range}\" colspan=\"{}\" rowspan=\"{}\"></td>",
                        end_column - start_column + 1, end_row - start_row + 1));
                }
            }
            rebuilt.push_str(&fragment);
        } else {
            rebuilt.push_str(&html[start..end]);
        }
        cursor = end;
    }
    rebuilt.push_str(&html[cursor..]);
    // A window that covers the deleted row without carrying it is the source
    // having skipped that row, not a bundle that disagrees with itself: the
    // rows below still move up one, which is the whole of the deletion. The
    // window bounds rewritten just below are what a disagreement trips on.
    let mut removed = Vec::new();
    source_map.entries.retain_mut(|entry| {
        if entry.source.node_kind != "cell" {
            return true;
        }
        let Some(reference) = entry.source.paragraph_id.clone() else {
            return true;
        };
        let Some((row, column)) = xlsx_cell_coordinates(&reference) else {
            return true;
        };
        if row == deleted_row {
            removed.push(entry.node_id.clone());
            return false;
        }
        if row > deleted_row {
            if !entry.source.created_in_hcd && entry.source.source_cell_ref.is_none() {
                entry.source.source_cell_ref = Some(reference);
            }
            entry.source.paragraph_id = Some(format!("{}{}", xlsx_column_name(column), row - 1));
        }
        true
    });
    let (new_start, new_end) = if old_start == old_end && old_start == u64::from(deleted_row) {
        (None, None)
    } else {
        (
            Some(if old_start > u64::from(deleted_row) {
                old_start - 1
            } else {
                old_start
            }),
            Some(old_end - 1),
        )
    };
    for (name, old, new) in [
        ("data-hcd-row-start", old_start, new_start),
        ("data-hcd-row-end", old_end, new_end),
    ] {
        let before = format!(" {name}=\"{old}\"");
        if !rebuilt.contains(&before) {
            return Err(HcdError::InvalidBundle(format!(
                "XLSX window is missing {name}"
            )));
        }
        rebuilt = rebuilt.replacen(
            &before,
            &new.map_or_else(String::new, |value| format!(" {name}=\"{value}\"")),
            1,
        );
    }
    *html = rebuilt;
    grid.row_start = new_start;
    grid.row_end = new_end;
    descriptor.block_count = descriptor
        .block_count
        .saturating_sub(usize::from(removed_row))
        .max(1);
    descriptor.node_count = source_map.entries.len();
    descriptor.first_node_id = source_map
        .entries
        .first()
        .map(|entry| entry.node_id.clone());
    descriptor.last_node_id = source_map.entries.last().map(|entry| entry.node_id.clone());
    descriptor.node_bloom = node_bloom(
        source_map
            .entries
            .iter()
            .map(|entry| entry.node_id.as_str()),
    );
    Ok(removed)
}

pub(in crate::patch) fn shift_xlsx_column_window(
    html: &mut String,
    source_map: &mut crate::ChunkSourceMap,
    descriptor: &mut crate::ChunkDescriptor,
    before_column: u32,
) -> Result<(), HcdError> {
    rewrite_xlsx_merge_refs(html, XlsxMergeShift::InsertColumn(before_column))?;
    let grid = descriptor.grid.as_mut().ok_or_else(|| {
        HcdError::InvalidBundle("XLSX column window has no grid address".to_string())
    })?;
    let old_start = grid
        .column_start
        .ok_or_else(|| HcdError::InvalidBundle("XLSX column window has no start".to_string()))?;
    let old_end = grid
        .column_end
        .ok_or_else(|| HcdError::InvalidBundle("XLSX column window has no end".to_string()))?;
    let cells = xlsx_cells(html)?;
    let mut first_shifted_column = BTreeMap::new();
    for cell in cells.iter().filter(|cell| cell.column >= before_column) {
        first_shifted_column
            .entry(cell.row)
            .and_modify(|column: &mut u32| *column = (*column).min(cell.column))
            .or_insert(cell.column);
    }
    let mut rewritten = String::with_capacity(html.len() + first_shifted_column.len() * 80);
    let mut cursor = 0usize;
    for cell in cells.iter().filter(|cell| cell.column >= before_column) {
        if cell.start < cursor {
            return Err(HcdError::InvalidBundle(
                "XLSX cell spans overlap".to_string(),
            ));
        }
        rewritten.push_str(&html[cursor..cell.start]);
        let original = &html[cell.start..cell.end];
        let old_column = format!(" data-hcd-column=\"{}\"", cell.column);
        let new_column = format!(" data-hcd-column=\"{}\"", cell.column + 1);
        if !original.contains(&old_column) {
            return Err(HcdError::InvalidBundle(
                "XLSX cell column differs from its address".to_string(),
            ));
        }
        let mut updated = original.replacen(&old_column, &new_column, 1);
        let old_ref = format!(
            " data-hcd-cell=\"{}{}\"",
            xlsx_column_name(cell.column),
            cell.row
        );
        let new_ref = format!(
            " data-hcd-cell=\"{}{}\"",
            xlsx_column_name(cell.column + 1),
            cell.row
        );
        updated = updated.replacen(&old_ref, &new_ref, 1);
        if first_shifted_column.get(&cell.row) == Some(&cell.column) {
            rewritten.push_str(&format!(
                "<td class=\"hcd-cell hcd-empty\" data-hcd-column=\"{before_column}\"></td>"
            ));
        }
        rewritten.push_str(&updated);
        cursor = cell.end;
    }
    rewritten.push_str(&html[cursor..]);
    *html = rewritten;
    for entry in &mut source_map.entries {
        if entry.source.node_kind != "cell" {
            continue;
        }
        let Some(reference) = entry.source.paragraph_id.clone() else {
            continue;
        };
        let Some((row, column)) = xlsx_cell_coordinates(&reference) else {
            return Err(HcdError::InvalidBundle(
                "XLSX mapped cell has invalid address".to_string(),
            ));
        };
        if column < before_column {
            continue;
        }
        if !entry.source.created_in_hcd && entry.source.source_cell_ref.is_none() {
            entry.source.source_cell_ref = Some(reference);
        }
        entry.source.paragraph_id = Some(format!("{}{}", xlsx_column_name(column + 1), row));
    }
    grid.column_start = Some(if old_start >= before_column {
        old_start + 1
    } else {
        old_start
    });
    grid.column_end = Some(old_end + 1);
    Ok(())
}

pub(in crate::patch) fn delete_xlsx_column_window(
    html: &mut String,
    source_map: &mut crate::ChunkSourceMap,
    descriptor: &mut crate::ChunkDescriptor,
    deleted_column: u32,
) -> Result<Vec<String>, HcdError> {
    rewrite_xlsx_formula_references(html, crate::FormulaDeletion::Column(deleted_column))?;
    rewrite_xlsx_merge_refs(html, XlsxMergeShift::DeleteColumn(deleted_column))?;
    delete_xlsx_column_widths(html, deleted_column)?;
    let grid = descriptor.grid.as_mut().ok_or_else(|| {
        HcdError::InvalidBundle("XLSX column window has no grid address".to_string())
    })?;
    let old_start = grid
        .column_start
        .ok_or_else(|| HcdError::InvalidBundle("XLSX column window has no start".to_string()))?;
    let old_end = grid
        .column_end
        .ok_or_else(|| HcdError::InvalidBundle("XLSX column window has no end".to_string()))?;
    if old_start > old_end || old_end < deleted_column {
        return Err(HcdError::InvalidBundle(
            "XLSX column window range is invalid".to_string(),
        ));
    }
    let mut rewritten = String::with_capacity(html.len());
    let mut cursor = 0usize;
    for cell in xlsx_cells(html)? {
        if cell.start < cursor {
            return Err(HcdError::InvalidBundle(
                "XLSX cell spans overlap".to_string(),
            ));
        }
        rewritten.push_str(&html[cursor..cell.start]);
        if cell.column < deleted_column {
            rewritten.push_str(&html[cell.start..cell.end]);
        } else if cell.column == deleted_column {
            if let Some((start_row, start_column, end_row, end_column)) = cell.merged_range {
                if start_column == deleted_column {
                    let range = format!(
                        "{}{}:{}{}",
                        xlsx_column_name(start_column),
                        start_row,
                        xlsx_column_name(end_column),
                        end_row
                    );
                    let colspan = end_column - start_column + 1;
                    let rowspan = end_row - start_row + 1;
                    rewritten.push_str(&format!(
                        "<td class=\"hcd-cell hcd-empty\" data-hcd-column=\"{start_column}\" data-hcd-merge=\"{range}\" colspan=\"{colspan}\" rowspan=\"{rowspan}\"></td>"
                    ));
                }
            }
        } else if cell.column > deleted_column {
            let original = &html[cell.start..cell.end];
            let old_column = format!(" data-hcd-column=\"{}\"", cell.column);
            if !original.contains(&old_column) {
                return Err(HcdError::InvalidBundle(
                    "XLSX cell column differs from its address".to_string(),
                ));
            }
            let mut updated = original.replacen(
                &old_column,
                &format!(" data-hcd-column=\"{}\"", cell.column - 1),
                1,
            );
            let old_ref = format!(
                " data-hcd-cell=\"{}{}\"",
                xlsx_column_name(cell.column),
                cell.row
            );
            if original.contains(&old_ref) {
                updated = updated.replacen(
                    &old_ref,
                    &format!(
                        " data-hcd-cell=\"{}{}\"",
                        xlsx_column_name(cell.column - 1),
                        cell.row
                    ),
                    1,
                );
            }
            rewritten.push_str(&updated);
        }
        cursor = cell.end;
    }
    rewritten.push_str(&html[cursor..]);
    *html = rewritten;
    let mut removed = Vec::new();
    source_map.entries.retain_mut(|entry| {
        if entry.source.node_kind != "cell" {
            return true;
        }
        let Some(reference) = entry.source.paragraph_id.clone() else {
            return true;
        };
        let Some((row, column)) = xlsx_cell_coordinates(&reference) else {
            return true;
        };
        if column == deleted_column {
            removed.push(entry.node_id.clone());
            return false;
        }
        if column > deleted_column {
            if !entry.source.created_in_hcd && entry.source.source_cell_ref.is_none() {
                entry.source.source_cell_ref = Some(reference);
            }
            entry.source.paragraph_id = Some(format!("{}{}", xlsx_column_name(column - 1), row));
        }
        true
    });
    let remaining = xlsx_cells(html)?;
    grid.column_start = remaining.iter().map(|cell| cell.column).min();
    grid.column_end = remaining.iter().map(|cell| cell.column).max();
    descriptor.node_count = source_map.entries.len();
    descriptor.first_node_id = source_map
        .entries
        .first()
        .map(|entry| entry.node_id.clone());
    descriptor.last_node_id = source_map.entries.last().map(|entry| entry.node_id.clone());
    descriptor.node_bloom = node_bloom(
        source_map
            .entries
            .iter()
            .map(|entry| entry.node_id.as_str()),
    );
    Ok(removed)
}

pub(in crate::patch) fn shift_xlsx_column_widths(
    html: &mut String,
    before_column: u32,
) -> Result<(), HcdError> {
    let mut spans = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = html[cursor..].find("<col ") {
        let start = cursor + relative;
        let end = html[start..]
            .find("/>")
            .map(|offset| start + offset + 2)
            .ok_or_else(|| {
                HcdError::InvalidBundle("XLSX column width tag is not closed".to_string())
            })?;
        let tag = &html[start..end];
        let first = xlsx_attribute(tag, "data-hcd-column-start")
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or_else(|| {
                HcdError::InvalidBundle("XLSX column width start is invalid".to_string())
            })?;
        let last = xlsx_attribute(tag, "data-hcd-column-end")
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or_else(|| {
                HcdError::InvalidBundle("XLSX column width end is invalid".to_string())
            })?;
        if first == 0 || first > last || last > 16_384 {
            return Err(HcdError::InvalidBundle(
                "XLSX column width range is invalid".to_string(),
            ));
        }
        if xlsx_attribute(tag, "data-hcd-hidden") == Some("true") {
            return Err(HcdError::Unsupported(
                "column insertion with hidden worksheet columns is not supported".to_string(),
            ));
        }
        if last >= before_column {
            if last == 16_384 {
                return Err(HcdError::ResourceLimit(
                    "XLSX column width range exceeds the worksheet".to_string(),
                ));
            }
            let width = xlsx_attribute(tag, "data-hcd-width")
                .map(str::parse::<f64>)
                .transpose()
                .map_err(|_| HcdError::InvalidBundle("XLSX column width is invalid".to_string()))?;
            let hidden = xlsx_attribute(tag, "data-hcd-hidden") == Some("true");
            let edited = xlsx_attribute(tag, "data-hcd-width-edited") == Some("true");
            let replacement = if first >= before_column {
                hcd_column_tag(first + 1, last + 1, width, hidden, edited)
            } else {
                format!(
                    "{}{}",
                    hcd_column_tag(first, before_column - 1, width, hidden, edited),
                    hcd_column_tag(before_column + 1, last + 1, width, hidden, edited)
                )
            };
            spans.push((start, end, replacement));
        }
        cursor = end;
    }
    for (start, end, replacement) in spans.into_iter().rev() {
        html.replace_range(start..end, &replacement);
    }
    Ok(())
}

pub(in crate::patch) fn delete_xlsx_column_widths(
    html: &mut String,
    deleted_column: u32,
) -> Result<(), HcdError> {
    let mut spans = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = html[cursor..].find("<col ") {
        let start = cursor + relative;
        let end = html[start..]
            .find('>')
            .map(|offset| start + offset + 1)
            .ok_or_else(|| {
                HcdError::InvalidBundle("XLSX column width tag is not closed".to_string())
            })?;
        let tag = &html[start..end];
        let first = xlsx_attribute(tag, "data-hcd-column-start")
            .and_then(|value| value.parse::<u32>().ok());
        let last =
            xlsx_attribute(tag, "data-hcd-column-end").and_then(|value| value.parse::<u32>().ok());
        if let (Some(first), Some(last)) = (first, last) {
            if first > last {
                return Err(HcdError::InvalidBundle(
                    "XLSX column width range is reversed".to_string(),
                ));
            }
            let shifted = if deleted_column < first {
                Some((first - 1, last - 1))
            } else if deleted_column > last {
                Some((first, last))
            } else if first == last {
                None
            } else {
                Some((first, last - 1))
            };
            let mut replacement = tag.to_string();
            if let Some((next_first, next_last)) = shifted {
                for (name, old, new) in [
                    ("data-hcd-column-start", first, next_first),
                    ("data-hcd-column-end", last, next_last),
                    ("span", last - first + 1, next_last - next_first + 1),
                ] {
                    replacement = replacement.replacen(
                        &format!(" {name}=\"{old}\""),
                        &format!(" {name}=\"{new}\""),
                        1,
                    );
                }
            } else {
                replacement.clear();
            }
            spans.push((start, end, replacement));
        }
        cursor = end;
    }
    for (start, end, replacement) in spans.into_iter().rev() {
        html.replace_range(start..end, &replacement);
    }
    Ok(())
}

pub(in crate::patch) fn shift_xlsx_visual_anchor(
    html: &mut String,
    descriptor: &mut crate::ChunkDescriptor,
    shift: XlsxVisualShift,
) -> Result<(), HcdError> {
    let marker = " data-hcd-anchor-from=\"";
    let offset = html.find(marker).ok_or_else(|| {
        HcdError::Unsupported("XLSX drawing has no editable cell anchor".to_string())
    })?;
    let start = html[..offset]
        .rfind('<')
        .ok_or_else(|| HcdError::InvalidBundle("XLSX drawing anchor has no element".to_string()))?;
    let end = html[offset..]
        .find('>')
        .map(|relative| offset + relative)
        .ok_or_else(|| {
            HcdError::InvalidBundle("XLSX drawing anchor tag is not closed".to_string())
        })?;
    let tag = &html[start..=end];
    let one_cell = xlsx_attribute(tag, "data-hcd-anchor-kind") == Some("one-cell");
    let mut shifted = Vec::new();
    let markers = ["data-hcd-anchor-from", "data-hcd-anchor-to"];
    for &name in &markers[..if one_cell { 1 } else { 2 }] {
        let reference = xlsx_attribute(tag, name).ok_or_else(|| {
            HcdError::Unsupported(
                "XLSX drawing is missing a cell marker required for the grid change".to_string(),
            )
        })?;
        let (row, column) = xlsx_cell_coordinates(reference).ok_or_else(|| {
            HcdError::InvalidBundle("XLSX drawing has an invalid cell marker".to_string())
        })?;
        let next = match shift {
            XlsxVisualShift::InsertRow(at) => (
                if row >= at {
                    row.checked_add(1)
                        .filter(|value| *value <= 1_048_576)
                        .ok_or_else(|| {
                            HcdError::ResourceLimit(
                                "XLSX drawing row exceeds worksheet".to_string(),
                            )
                        })?
                } else {
                    row
                },
                column,
            ),
            XlsxVisualShift::InsertColumn(at) => (
                row,
                if column >= at {
                    column
                        .checked_add(1)
                        .filter(|value| *value <= 16_384)
                        .ok_or_else(|| {
                            HcdError::ResourceLimit(
                                "XLSX drawing column exceeds worksheet".to_string(),
                            )
                        })?
                } else {
                    column
                },
            ),
            XlsxVisualShift::DeleteRow(at) => (if row > at { row - 1 } else { row }, column),
            XlsxVisualShift::DeleteColumn(at) => {
                (row, if column > at { column - 1 } else { column })
            }
        };
        shifted.push((
            name,
            format!("{}{}", xlsx_column_name(next.1), next.0),
            next,
        ));
    }
    for (name, value, _) in &shifted {
        let end = html[start..]
            .find('>')
            .map(|relative| start + relative)
            .ok_or_else(|| {
                HcdError::InvalidBundle("XLSX drawing anchor tag is not closed".to_string())
            })?;
        set_attribute_in_range(html, start, end, name, value)?;
    }
    let grid = descriptor
        .grid
        .as_mut()
        .ok_or_else(|| HcdError::InvalidBundle("XLSX drawing has no grid address".to_string()))?;
    grid.row_start = Some(u64::from(shifted[0].2 .0));
    grid.row_end = shifted.get(1).map(|marker| u64::from(marker.2 .0));
    grid.column_start = Some(shifted[0].2 .1);
    grid.column_end = shifted.get(1).map(|marker| marker.2 .1);
    Ok(())
}

pub(in crate::patch) fn remove_empty_xlsx_tail_row(
    html: &mut String,
    row: u32,
) -> Result<(), HcdError> {
    let old_end = format!(" data-hcd-row-end=\"{row}\"");
    let section_end = html
        .find('>')
        .ok_or_else(|| HcdError::InvalidBundle("XLSX sheet section is not closed".to_string()))?;
    let marker = html[..section_end].find(&old_end).ok_or_else(|| {
        HcdError::InvalidBundle("XLSX sheet row end disagrees with its descriptor".to_string())
    })?;
    let body_end = html
        .find("</tbody>")
        .ok_or_else(|| HcdError::InvalidBundle("XLSX sheet has no table body".to_string()))?;
    let last_row_start = html[..body_end]
        .rfind("<tr ")
        .ok_or_else(|| HcdError::InvalidBundle("XLSX sheet has no last row".to_string()))?;
    if html[last_row_start..body_end] != format!("<tr data-hcd-row=\"{row}\"></tr>") {
        return Err(HcdError::PreconditionFailed(
            "XLSX last row contains cells or formatting; only an empty appended row can be removed"
                .to_string(),
        ));
    }
    html.replace_range(last_row_start..body_end, "");
    html.replace_range(
        marker..marker + old_end.len(),
        &format!(" data-hcd-row-end=\"{}\"", row - 1),
    );
    Ok(())
}

pub(in crate::patch) fn xlsx_column_name(mut column: u32) -> String {
    let mut output = Vec::new();
    while column > 0 {
        column -= 1;
        output.push(b'A' + (column % 26) as u8);
        column /= 26;
    }
    output.reverse();
    String::from_utf8(output).expect("ASCII column name")
}

pub(in crate::patch) fn xlsx_merge_coordinates(reference: &str) -> Option<(u32, u32, u32, u32)> {
    let (first, last) = reference.split_once(':')?;
    let (start_row, start_column) = xlsx_cell_coordinates(first)?;
    let (end_row, end_column) = xlsx_cell_coordinates(last)?;
    (start_row <= end_row && start_column <= end_column).then_some((
        start_row,
        start_column,
        end_row,
        end_column,
    ))
}

pub(in crate::patch) fn shifted_xlsx_merge(
    (start_row, start_column, end_row, end_column): (u32, u32, u32, u32),
    shift: XlsxMergeShift,
) -> Result<Option<(u32, u32, u32, u32)>, HcdError> {
    let crossing = || {
        HcdError::Unsupported(
            "XLSX grid shift intersects a merged range; split that merge first".to_string(),
        )
    };
    let overflow =
        || HcdError::ResourceLimit("XLSX merged range exceeds the worksheet limit".to_string());
    match shift {
        XlsxMergeShift::InsertRow(before) if before > start_row && before <= end_row => {
            Err(crossing())
        }
        XlsxMergeShift::InsertRow(before) if before <= start_row => Ok(Some((
            start_row
                .checked_add(1)
                .filter(|row| *row <= 1_048_576)
                .ok_or_else(overflow)?,
            start_column,
            end_row
                .checked_add(1)
                .filter(|row| *row <= 1_048_576)
                .ok_or_else(overflow)?,
            end_column,
        ))),
        XlsxMergeShift::DeleteRow(row) if (start_row..=end_row).contains(&row) => Ok((end_row
            > start_row
            && (end_row > start_row + 1 || start_column < end_column))
            .then_some((start_row, start_column, end_row - 1, end_column))),
        XlsxMergeShift::DeleteRow(row) if row < start_row => {
            Ok(Some((start_row - 1, start_column, end_row - 1, end_column)))
        }
        XlsxMergeShift::InsertColumn(before) if before > start_column && before <= end_column => {
            Ok(Some((
                start_row,
                start_column,
                end_row,
                end_column
                    .checked_add(1)
                    .filter(|col| *col <= 16_384)
                    .ok_or_else(overflow)?,
            )))
        }
        XlsxMergeShift::InsertColumn(before) if before <= start_column => Ok(Some((
            start_row,
            start_column
                .checked_add(1)
                .filter(|col| *col <= 16_384)
                .ok_or_else(overflow)?,
            end_row,
            end_column
                .checked_add(1)
                .filter(|col| *col <= 16_384)
                .ok_or_else(overflow)?,
        ))),
        XlsxMergeShift::DeleteColumn(column) if (start_column..=end_column).contains(&column) => {
            Ok((end_column > start_column
                && (end_column > start_column + 1 || start_row < end_row))
                .then_some((start_row, start_column, end_row, end_column - 1)))
        }
        XlsxMergeShift::DeleteColumn(column) if column < start_column => {
            Ok(Some((start_row, start_column - 1, end_row, end_column - 1)))
        }
        _ => Ok(Some((start_row, start_column, end_row, end_column))),
    }
}

pub(in crate::patch) fn check_xlsx_merge_shift(
    html: &str,
    shift: XlsxMergeShift,
) -> Result<(), HcdError> {
    for range in xlsx_cells(html)?
        .into_iter()
        .filter_map(|cell| cell.merged_range)
    {
        shifted_xlsx_merge(range, shift)?;
    }
    Ok(())
}

pub(in crate::patch) fn rewrite_xlsx_merge_refs(
    html: &mut String,
    shift: XlsxMergeShift,
) -> Result<(), HcdError> {
    for cell in xlsx_cells(html)?.into_iter().rev() {
        let Some(range) = cell.merged_range else {
            continue;
        };
        let shifted = shifted_xlsx_merge(range, shift)?;
        if shifted == Some(range) {
            continue;
        }
        let old = format!(
            "{}{}:{}{}",
            xlsx_column_name(range.1),
            range.0,
            xlsx_column_name(range.3),
            range.2
        );
        let mut tag = html[cell.start..=cell.tag_end].to_string();
        let needle = format!(" data-hcd-merge=\"{old}\"");
        if !tag.contains(&needle) {
            return Err(HcdError::InvalidBundle(
                "XLSX merged cell lost its range attribute".to_string(),
            ));
        }
        if let Some(shifted) = shifted {
            let new = format!(
                "{}{}:{}{}",
                xlsx_column_name(shifted.1),
                shifted.0,
                xlsx_column_name(shifted.3),
                shifted.2
            );
            tag = tag.replacen(&needle, &format!(" data-hcd-merge=\"{new}\""), 1);
            for (name, value) in [
                ("colspan", shifted.3 - shifted.1 + 1),
                ("rowspan", shifted.2 - shifted.0 + 1),
            ] {
                if let Some(old_value) = xlsx_attribute(&tag, name).map(str::to_string) {
                    tag = tag.replacen(
                        &format!(" {name}=\"{old_value}\""),
                        &format!(" {name}=\"{value}\""),
                        1,
                    );
                }
            }
        } else {
            tag = tag.replacen(&needle, "", 1);
            for name in ["colspan", "rowspan"] {
                if let Some(value) = xlsx_attribute(&tag, name).map(str::to_string) {
                    tag = tag.replacen(&format!(" {name}=\"{value}\""), "", 1);
                }
            }
        }
        html.replace_range(cell.start..=cell.tag_end, &tag);
    }
    Ok(())
}

pub(in crate::patch) fn merge_xlsx_cells(
    html: &mut String,
    merge: &XlsxMerge,
) -> Result<(), HcdError> {
    let cells = xlsx_cells(html)?;
    let intersects = |range: (u32, u32, u32, u32)| {
        range.0 <= merge.end_row
            && range.2 >= merge.start_row
            && range.1 <= merge.end_column
            && range.3 >= merge.start_column
    };
    if cells
        .iter()
        .filter_map(|cell| cell.merged_range)
        .any(intersects)
    {
        return Err(HcdError::PreconditionFailed(
            "XLSX merge overlaps an existing merged range".to_string(),
        ));
    }
    let mut replacements = Vec::new();
    for row in merge.start_row..=merge.end_row {
        for column in merge.start_column..=merge.end_column {
            let cell = cells
                .iter()
                .find(|cell| cell.row == row && cell.column == column);
            // Sparse worksheets omit empty td elements. A covered coordinate
            // without a cell is still empty and can be represented by the span.
            let Some(cell) = cell else {
                if row == merge.start_row && column == merge.start_column {
                    return Err(HcdError::InvalidBundle(
                        "XLSX merge anchor was not materialized".to_string(),
                    ));
                }
                continue;
            };
            if row == merge.start_row && column == merge.start_column {
                if !cell.has_node {
                    return Err(HcdError::Unsupported(
                        "XLSX merge anchor must be an existing mapped cell".to_string(),
                    ));
                }
                let reference = format!(
                    "{}{}:{}{}",
                    xlsx_column_name(merge.start_column),
                    merge.start_row,
                    xlsx_column_name(merge.end_column),
                    merge.end_row
                );
                let mut replacement = html[cell.start..cell.end].to_string();
                replacement.insert_str(
                    cell.tag_end - cell.start,
                    &format!(
                        " data-hcd-merge=\"{reference}\" rowspan=\"{}\" colspan=\"{}\"",
                        merge.end_row - merge.start_row + 1,
                        merge.end_column - merge.start_column + 1
                    ),
                );
                replacements.push((cell.start, cell.end, replacement));
            } else {
                if cell.has_node || !html[cell.tag_end + 1..cell.end - 5].trim().is_empty() {
                    return Err(HcdError::Unsupported(format!(
                        "XLSX merge would discard the mapped or nonempty cell {}{row}",
                        xlsx_column_name(column)
                    )));
                }
                replacements.push((cell.start, cell.end, String::new()));
            }
        }
    }
    replacements.sort_unstable_by_key(|(start, _, _)| std::cmp::Reverse(*start));
    for (start, end, replacement) in replacements {
        html.replace_range(start..end, &replacement);
    }
    Ok(())
}

pub(in crate::patch) fn unmerge_xlsx_cells(
    html: &mut String,
    initial_html: &str,
    merge: &XlsxMerge,
) -> Result<(), HcdError> {
    let cells = xlsx_cells(html)?;
    let original_cells = xlsx_cells(initial_html)?;
    let anchor = cells
        .iter()
        .find(|cell| {
            cell.row == merge.start_row && cell.column == merge.start_column && cell.has_node
        })
        .ok_or_else(|| HcdError::PreconditionFailed("XLSX merge anchor is missing".to_string()))?;
    let range = (
        merge.start_row,
        merge.start_column,
        merge.end_row,
        merge.end_column,
    );
    if anchor.merged_range != Some(range) {
        return Err(HcdError::PreconditionFailed(
            "XLSX anchor is not merged across the requested range".to_string(),
        ));
    }
    let count = (merge.end_row - merge.start_row + 1)
        .saturating_mul(merge.end_column - merge.start_column + 1);
    if count > 10_000 {
        return Err(HcdError::ResourceLimit(
            "XLSX unmerge exceeds 10000 cells".to_string(),
        ));
    }
    let reference = format!(
        "{}{}:{}{}",
        xlsx_column_name(merge.start_column),
        merge.start_row,
        xlsx_column_name(merge.end_column),
        merge.end_row
    );
    let mut restored_anchor = html[anchor.start..anchor.end].to_string();
    for attribute in [
        format!(" data-hcd-merge=\"{reference}\""),
        format!(" rowspan=\"{}\"", merge.end_row - merge.start_row + 1),
        format!(" colspan=\"{}\"", merge.end_column - merge.start_column + 1),
    ] {
        if !restored_anchor.contains(&attribute) {
            return Err(HcdError::InvalidBundle(
                "XLSX merge anchor has inconsistent span attributes".to_string(),
            ));
        }
        restored_anchor = restored_anchor.replacen(&attribute, "", 1);
    }
    let mut changes = vec![(anchor.start, anchor.end, restored_anchor, 0u32)];
    for row in merge.start_row..=merge.end_row {
        let marker = format!("<tr data-hcd-row=\"{row}\"");
        let row_start = html.find(&marker).ok_or_else(|| {
            HcdError::Unsupported(format!(
                "XLSX merged row {row} is not present in the HCD window"
            ))
        })?;
        let row_end = html[row_start..]
            .find("</tr>")
            .map(|offset| row_start + offset)
            .ok_or_else(|| HcdError::InvalidBundle("XLSX merged row is not closed".to_string()))?;
        for column in merge.start_column..=merge.end_column {
            if row == merge.start_row && column == merge.start_column {
                continue;
            }
            if cells
                .iter()
                .any(|cell| cell.row == row && cell.column == column)
            {
                return Err(HcdError::PreconditionFailed(
                    "XLSX covered cell already exists".to_string(),
                ));
            }
            let insertion = cells
                .iter()
                .filter(|cell| cell.row == row && cell.column > column)
                .map(|cell| cell.start)
                .min()
                .unwrap_or(row_end);
            let empty = original_cells
                .iter()
                .find(|cell| cell.row == row && cell.column == column)
                .filter(|cell| {
                    !cell.has_node
                        && cell.merged_range.is_none()
                        && initial_html[cell.tag_end + 1..cell.end - 5]
                            .trim()
                            .is_empty()
                })
                .map(|cell| initial_html[cell.start..cell.end].to_string())
                .unwrap_or_else(|| {
                    format!("<td class=\"hcd-cell hcd-empty\" data-hcd-column=\"{column}\"></td>")
                });
            changes.push((insertion, insertion, empty, column));
        }
    }
    changes.sort_unstable_by(|left, right| right.0.cmp(&left.0).then_with(|| right.3.cmp(&left.3)));
    for (start, end, replacement, _) in changes {
        html.replace_range(start..end, &replacement);
    }
    Ok(())
}
