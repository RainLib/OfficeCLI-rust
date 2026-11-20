use super::*;

pub(in crate::patch) fn collect_xlsx_sheet_freeze(patch: &PatchBatch) -> Option<XlsxSheetFreeze> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::XlsxSheetFreeze {
            sheet_id,
            rows,
            columns,
        } = operation
        else {
            return None;
        };
        Some(XlsxSheetFreeze {
            sheet_id: sheet_id.clone(),
            rows: *rows,
            columns: *columns,
        })
    })
}

/// Write the frozen pane every worksheet window in this chunk names, so the
/// sheet shows the same split whichever window it is read in. `0`/`0` takes the
/// pane out instead of putting one in. Returns how many window tags this rewrote
/// and how many windows it read, which is what lets a request that would change
/// nothing be refused instead of recorded as a revision.
pub(in crate::patch) fn freeze_xlsx_sheet_sections(
    html: &mut String,
    rows: u32,
    columns: u32,
) -> Result<(usize, usize), HcdError> {
    const MARKER: &str = "<section class=\"hcd-sheet\"";
    let mut output = String::with_capacity(html.len());
    let mut cursor = 0usize;
    let mut rewritten = 0usize;
    let mut seen = 0usize;
    while let Some(offset) = html[cursor..].find(MARKER) {
        let start = cursor + offset;
        let gap = html[start..].find('>').ok_or_else(|| {
            HcdError::InvalidBundle("XLSX worksheet window is not closed".to_string())
        })?;
        let end = start + gap;
        let tag = &html[start..=end];
        output.push_str(&html[cursor..start]);
        seen += 1;
        let rewritten_tag = rewrite_pane_attributes(tag, rows, columns)?;
        if rewritten_tag != tag {
            rewritten += 1;
        }
        output.push_str(&rewritten_tag);
        cursor = end + 1;
    }
    output.push_str(&html[cursor..]);
    *html = output;
    Ok((rewritten, seen))
}

/// One worksheet window's pane attributes, rebuilt for the requested split. A
/// frozen pane writes the split as row and column counts, the cell the scrolling
/// corner starts at, and the corner itself; releasing it leaves none of those
/// behind. A split pane the source workbook scrolled by hand is described in
/// twips, and a freeze replaces it rather than carrying it along.
pub(in crate::patch) fn rewrite_pane_attributes(
    tag: &str,
    rows: u32,
    columns: u32,
) -> Result<String, HcdError> {
    let mut pane = tag.to_string();
    for name in [
        "data-hcd-pane-state",
        "data-hcd-pane-top-left-cell",
        "data-hcd-active-pane",
        "data-hcd-frozen-rows",
        "data-hcd-frozen-columns",
        "data-hcd-split-x-twips",
        "data-hcd-split-y-twips",
    ] {
        drop_tag_attribute(&mut pane, name)?;
    }
    // The marker is what tells a source-backed export that this window speaks for
    // its worksheet: a pane the source workbook wrote is left alone until a patch
    // rewrites it, and a release has to be written too, not just left blank.
    set_tag_attribute(&mut pane, "data-hcd-pane-edited", "true");
    if rows == 0 && columns == 0 {
        return Ok(pane);
    }
    set_tag_attribute(&mut pane, "data-hcd-pane-state", "frozen");
    set_tag_attribute(
        &mut pane,
        "data-hcd-pane-top-left-cell",
        &format!("{}{}", xlsx_column_name(columns + 1), u64::from(rows) + 1),
    );
    set_tag_attribute(
        &mut pane,
        "data-hcd-active-pane",
        match (rows, columns) {
            (0, _) => "top-right",
            (_, 0) => "bottom-left",
            _ => "bottom-right",
        },
    );
    // Excel names only the split it makes, so a freeze that holds the first row
    // writes no column count. Reading it back the same way keeps the window
    // attributes a patch writes the same as the ones an import collected.
    if columns > 0 {
        set_tag_attribute(&mut pane, "data-hcd-frozen-columns", &columns.to_string());
    }
    if rows > 0 {
        set_tag_attribute(&mut pane, "data-hcd-frozen-rows", &rows.to_string());
    }
    Ok(pane)
}

/// The frozen band one worksheet keeps, moved along with a row or column the
/// history put through it, in every window the sheet is read in. Excel freezes
/// the rows and columns that stand inside the band, so a row inserted at or above
/// the last frozen row is frozen from then on and a row deleted inside the band
/// leaves it; a move below the band says nothing about it. The rule is the one the
/// export follows when it shifts a pane the source workbook wrote, so the window
/// attributes a shift leaves behind still describe the freeze the worksheet part
/// carries. Returns whether any window tag changed.
pub(in crate::patch) fn shift_xlsx_pane_band(
    html: &mut String,
    shift: XlsxPaneBandShift,
) -> Result<bool, HcdError> {
    const MARKER: &str = "<section class=\"hcd-sheet\"";
    let mut output = String::with_capacity(html.len());
    let mut cursor = 0usize;
    let mut changed = false;
    while let Some(offset) = html[cursor..].find(MARKER) {
        let start = cursor + offset;
        let gap = html[start..].find('>').ok_or_else(|| {
            HcdError::InvalidBundle("XLSX worksheet window is not closed".to_string())
        })?;
        let end = start + gap;
        let tag = &html[start..=end];
        output.push_str(&html[cursor..start]);
        match shift_one_xlsx_pane_band(tag, shift)? {
            Some(shifted) => {
                changed = true;
                output.push_str(&shifted);
            }
            None => output.push_str(tag),
        }
        cursor = end + 1;
    }
    output.push_str(&html[cursor..]);
    if changed {
        *html = output;
    }
    Ok(changed)
}

/// One window's band after one row or column moved through it. `None` means the
/// window names no band, or this move says nothing about the one it names, so its
/// tag is left exactly as it arrived. A window whose pane HCD wrote is rebuilt
/// from the moved counts the way a freeze writes it; a window the importer filled
/// in from the source workbook has only its counts moved, because the export
/// shifts that pane itself and which corner or which pane it names is not HCD's to
/// recompute.
pub(in crate::patch) fn shift_one_xlsx_pane_band(
    tag: &str,
    shift: XlsxPaneBandShift,
) -> Result<Option<String>, HcdError> {
    let Some((held_rows, held_columns)) = xlsx_frozen_band(tag) else {
        return Ok(None);
    };
    let (rows, columns) = match shift {
        XlsxPaneBandShift::InsertRow(at) if held_rows >= at => (
            widened_xlsx_pane_band(held_rows, XLSX_FROZEN_ROW_LIMIT)?,
            held_columns,
        ),
        XlsxPaneBandShift::DeleteRow(at) if held_rows >= at && held_rows > 0 => {
            (held_rows - 1, held_columns)
        }
        XlsxPaneBandShift::InsertColumn(at) if held_columns >= at => (
            held_rows,
            widened_xlsx_pane_band(held_columns, XLSX_FROZEN_COLUMN_LIMIT)?,
        ),
        XlsxPaneBandShift::DeleteColumn(at) if held_columns >= at && held_columns > 0 => {
            (held_rows, held_columns - 1)
        }
        _ => return Ok(None),
    };
    if xlsx_attribute(tag, "data-hcd-pane-edited") == Some("true") {
        return Ok(Some(rewrite_pane_attributes(tag, rows, columns)?));
    }
    let mut pane = tag.to_string();
    for (name, count) in [
        ("data-hcd-frozen-rows", rows),
        ("data-hcd-frozen-columns", columns),
    ] {
        drop_tag_attribute(&mut pane, name)?;
        // Excel names only the side it splits, and a reader that finds no count
        // reads the band as empty on that side, which is what a narrowed split
        // that ran out of rows or columns now is.
        if count > 0 {
            set_tag_attribute(&mut pane, name, &count.to_string());
        }
    }
    Ok(Some(pane))
}

/// One row or column added inside the band. The last row or column of a sheet
/// stays out of reach because a frozen pane must leave something to scroll.
pub(in crate::patch) fn widened_xlsx_pane_band(count: u32, maximum: u32) -> Result<u32, HcdError> {
    if count >= maximum {
        return Err(HcdError::ResourceLimit(
            "XLSX frozen band grows past the worksheet it freezes".to_string(),
        ));
    }
    Ok(count + 1)
}

/// The band a grid shift moves through, from whichever grid operation this patch
/// carries. A patch holds one operation, so at most one of these can name a sheet.
pub(in crate::patch) fn xlsx_pane_band_move(
    row_insert: Option<&XlsxRowInsert>,
    row_delete: Option<&XlsxRowDelete>,
    column_insert: Option<&XlsxColumnInsert>,
    column_delete: Option<&XlsxColumnDelete>,
) -> Option<XlsxPaneBandMove> {
    if let Some(insert) = row_insert {
        return Some(XlsxPaneBandMove {
            sheet_id: insert.sheet_id.clone(),
            shift: XlsxPaneBandShift::InsertRow(insert.before_row),
            count: insert.count,
        });
    }
    if let Some(delete) = row_delete {
        return Some(XlsxPaneBandMove {
            sheet_id: delete.sheet_id.clone(),
            shift: XlsxPaneBandShift::DeleteRow(delete.row),
            count: delete.count,
        });
    }
    if let Some(insert) = column_insert {
        return Some(XlsxPaneBandMove {
            sheet_id: insert.sheet_id.clone(),
            shift: XlsxPaneBandShift::InsertColumn(insert.before_column),
            count: insert.count,
        });
    }
    column_delete.map(|delete| XlsxPaneBandMove {
        sheet_id: delete.sheet_id.clone(),
        shift: XlsxPaneBandShift::DeleteColumn(delete.column),
        count: delete.count,
    })
}

pub(in crate::patch) fn validate_xlsx_sheet_name(name: &str) -> Result<(), HcdError> {
    if name.is_empty()
        || name.chars().count() > 31
        || name.contains(['/', '\\', '?', '*', '[', ']', ':'])
        || name.starts_with('\'')
        || name.ends_with('\'')
        || name.chars().any(|character| character.is_control())
    {
        return Err(HcdError::InvalidPatch(
            "invalid XLSX worksheet name".to_string(),
        ));
    }
    Ok(())
}

pub(in crate::patch) fn collect_xlsx_sheet_rename(
    patch: &PatchBatch,
) -> Option<XlsxSheetRenameTarget> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::XlsxSheetRename { sheet_id, name } = operation else {
            return None;
        };
        Some(XlsxSheetRenameTarget {
            sheet_id: sheet_id.clone(),
            old_name: String::new(),
            new_name: name.clone(),
            sheet_part: String::new(),
        })
    })
}

/// Resolve the tab name a worksheet carries now, its source worksheet part,
/// and reject a name another worksheet already uses. Excel treats tab names as
/// case-insensitive but allows a case-only rename of the same worksheet.
pub(in crate::patch) fn resolve_xlsx_sheet_rename(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    rename: &XlsxSheetRenameTarget,
) -> Result<XlsxSheetRenameTarget, HcdError> {
    let mut resolved = rename.clone();
    let mut part = None;
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.sheet_id == rename.sheet_id {
                if resolved.old_name.is_empty() {
                    resolved.old_name = grid.sheet_name.clone();
                } else if resolved.old_name != grid.sheet_name {
                    return Err(HcdError::InvalidBundle(
                        "XLSX worksheet chunks disagree on the sheet name".to_string(),
                    ));
                }
                if part.is_none() && grid.kind == crate::GridChunkKind::Cells {
                    part = bundle
                        .read_map(&descriptor)?
                        .entries
                        .iter()
                        .find(|entry| entry.source.node_kind == "cell")
                        .map(|entry| entry.source.part.clone());
                }
                continue;
            }
            if grid.sheet_name.eq_ignore_ascii_case(&rename.new_name) {
                return Err(HcdError::InvalidPatch(
                    "XLSX worksheet names must be unique".to_string(),
                ));
            }
        }
    }
    if resolved.old_name.is_empty() {
        return Err(HcdError::Unsupported(
            "XLSX worksheet is not in the HCD grid".to_string(),
        ));
    }
    if resolved.old_name == rename.new_name {
        return Err(HcdError::InvalidPatch(
            "XLSX worksheet rename does not change the name".to_string(),
        ));
    }
    resolved.sheet_part = part.ok_or_else(|| {
        HcdError::Unsupported(
            "XLSX worksheet rename requires a worksheet with a mapped cell".to_string(),
        )
    })?;
    Ok(resolved)
}

/// Rewrite the worksheet tab name on the sheet sections stored in this chunk.
/// The name a patch wants for a worksheet that does not exist yet.
pub(in crate::patch) fn collect_xlsx_sheet_add(patch: &PatchBatch) -> Option<String> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::XlsxSheetAdd { name } = operation else {
            return None;
        };
        Some(name.clone())
    })
}

/// Trailing number of a worksheet part such as `xl/worksheets/sheet12.xml`.
pub(in crate::patch) fn worksheet_part_number(part: &str) -> Option<usize> {
    let stem = part.rsplit('/').next()?.strip_suffix(".xml")?;
    stem.strip_prefix("sheet")?.parse().ok()
}

/// Work out where a new tab lands: the worksheet part it will need in the
/// package, the tab position after every worksheet the bundle knows, and the
/// grid identity the importer derives for that part, so re-importing an export
/// of this workbook keeps the same `sheetId`.
///
/// A part name is only free for as long as the bundle can see. A bundle
/// imported before worksheets carried their part and holding nothing but empty
/// tabs hides one, and the package rewrite then refuses to shadow the part it
/// collides with instead of overwriting it.
pub(in crate::patch) fn resolve_xlsx_sheet_add(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    name: &str,
) -> Result<XlsxSheetAddTarget, HcdError> {
    let mut known_parts: HashSet<String> = HashSet::new();
    let mut highest_index: Option<usize> = None;
    let mut highest_number: usize = 0;
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.kind == crate::GridChunkKind::Cells {
                let mut part = grid.sheet_part.clone();
                if part.is_none() {
                    // Older windows name their part through a mapped cell.
                    part = bundle
                        .read_map(&descriptor)?
                        .entries
                        .iter()
                        .find(|entry| entry.source.node_kind == "cell")
                        .map(|entry| entry.source.part.clone());
                }
                if let Some(part) = part {
                    if known_parts.insert(part.clone()) {
                        highest_index = Some(
                            highest_index
                                .map_or(grid.sheet_index, |seen| seen.max(grid.sheet_index)),
                        );
                        highest_number =
                            highest_number.max(worksheet_part_number(&part).unwrap_or_default());
                    }
                }
            }
            if grid.sheet_name.eq_ignore_ascii_case(name) {
                return Err(HcdError::InvalidPatch(
                    "XLSX worksheet names must be unique".to_string(),
                ));
            }
        }
    }
    let sheet_index = highest_index.map_or(0, |seen| seen + 1);
    // Number the new part past the highest one already in the workbook so a tab
    // an earlier export deleted, or one the source numbered irregularly, cannot
    // be stepped on.
    let sheet_part = format!(
        "xl/worksheets/sheet{}.xml",
        highest_number.max(known_parts.len()) + 1
    );
    Ok(XlsxSheetAddTarget {
        name: name.to_string(),
        sheet_id: sheet_grid_id(&manifest.document_id, &sheet_part),
        sheet_part,
        sheet_index,
    })
}

/// Write the new tab's first window and describe it exactly like the importer
/// describes a worksheet that has no rows yet, so the tab renders and takes
/// cells straight away.
pub(in crate::patch) fn mint_xlsx_sheet_chunk(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    addition: &XlsxSheetAddTarget,
) -> Result<crate::ChunkDescriptor, HcdError> {
    let html = XlsxSheetSection {
        sheet_name: &addition.name,
        sheet_index: addition.sheet_index,
        sheet_state: "visible",
        row_start: None,
        row_end: None,
        default_column_width: None,
        default_row_height_points: None,
        view_attributes: "",
        column_markup: "",
    }
    .html("");
    let chunk_id = sheet_window_chunk_id(&manifest.document_id, &addition.sheet_part, 0);
    let source_map = crate::ChunkSourceMap {
        schema_version: manifest.schema_version.clone(),
        chunk_id: chunk_id.clone(),
        entries: Vec::new(),
    };
    let (html_href, html_hash) = bundle.write_chunk_object(&html)?;
    let (map_href, map_hash) = bundle.write_json_object("maps", &source_map)?;
    Ok(crate::ChunkDescriptor {
        sequence: manifest.chunk_count,
        chunk_id,
        region: "sheet".to_string(),
        html_href,
        html_hash,
        map_href,
        map_hash,
        byte_length: html.len() as u64,
        // An empty window is still one block, so the first row a cell edit
        // materialises opens it instead of adding a second block.
        block_count: 1,
        node_count: 0,
        text_chars: 0,
        node_bloom: node_bloom(std::iter::empty::<&str>()),
        first_node_id: None,
        last_node_id: None,
        continuation: false,
        pdf_layout: Vec::new(),
        grid: Some(crate::GridChunkAddress {
            sheet_id: addition.sheet_id.clone(),
            sheet_name: addition.name.clone(),
            sheet_index: addition.sheet_index,
            sheet_state: "visible".to_string(),
            kind: crate::GridChunkKind::Cells,
            row_start: None,
            row_end: None,
            column_start: None,
            column_end: None,
            default_column_width_emu: None,
            default_row_height_emu: None,
            sheet_part: Some(addition.sheet_part.clone()),
            auto_filter: None,
            charts: Vec::new(),
            conditions: Vec::new(),
            pivots: Vec::new(),
        }),
    })
}

/// Worksheet a patch asks to delete.
pub(in crate::patch) fn collect_xlsx_sheet_removal(
    patch: &PatchBatch,
) -> Option<XlsxSheetRemovalTarget> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::XlsxSheetDelete { sheet_id } = operation else {
            return None;
        };
        Some(XlsxSheetRemovalTarget {
            sheet_id: sheet_id.clone(),
            name: String::new(),
            sheet_part: String::new(),
            sheet_index: 0,
        })
    })
}

/// Work out what a deletion names: the tab formulas point at, the worksheet part
/// the package loses, and whether any visible tab survives it. A workbook with no
/// visible worksheet is not a file Excel opens, so the last visible tab cannot be
/// deleted even though HCD would drop it from its own index without complaint.
pub(in crate::patch) fn resolve_xlsx_sheet_removal(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    removal: &XlsxSheetRemovalTarget,
) -> Result<XlsxSheetRemovalTarget, HcdError> {
    let mut resolved = removal.clone();
    let mut part: Option<String> = None;
    let mut sheets: HashSet<String> = HashSet::new();
    let mut visible: HashSet<String> = HashSet::new();
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            sheets.insert(grid.sheet_id.clone());
            if grid.sheet_state == "visible" {
                visible.insert(grid.sheet_id.clone());
            }
            if grid.sheet_id != removal.sheet_id {
                continue;
            }
            if resolved.name.is_empty() {
                resolved.name = grid.sheet_name.clone();
                resolved.sheet_index = grid.sheet_index;
            } else if resolved.name != grid.sheet_name {
                return Err(HcdError::InvalidBundle(
                    "XLSX worksheet chunks disagree on the sheet name".to_string(),
                ));
            } else if resolved.sheet_index != grid.sheet_index {
                return Err(HcdError::InvalidBundle(
                    "XLSX worksheet chunks disagree on the sheet position".to_string(),
                ));
            }
            if part.is_none() && grid.kind == crate::GridChunkKind::Cells {
                part = match grid.sheet_part.clone() {
                    Some(part) => Some(part),
                    None => bundle
                        .read_map(&descriptor)?
                        .entries
                        .iter()
                        .find(|entry| entry.source.node_kind == "cell")
                        .map(|entry| entry.source.part.clone()),
                };
            }
        }
    }
    if !sheets.contains(&removal.sheet_id) {
        return Err(HcdError::Unsupported(
            "XLSX worksheet is not in the HCD grid".to_string(),
        ));
    }
    if visible.contains(&removal.sheet_id) && visible.len() == 1 {
        return Err(HcdError::InvalidPatch(
            "XLSX workbook must keep one visible worksheet".to_string(),
        ));
    }
    resolved.sheet_part = part.ok_or_else(|| {
        HcdError::Unsupported(
            "XLSX worksheet deletion requires a worksheet with a known source part".to_string(),
        )
    })?;
    Ok(resolved)
}

pub(in crate::patch) fn rename_xlsx_sheet_sections(
    html: &mut String,
    old_name: &str,
    new_name: &str,
) -> Result<bool, HcdError> {
    const MARKER: &str = "data-hcd-sheet=\"";
    let previous = escape_attribute(old_name);
    let next = escape_attribute(new_name);
    let mut cursor = 0usize;
    let mut changed = false;
    while let Some(offset) = html[cursor..].find(MARKER) {
        let start = cursor + offset + MARKER.len();
        let Some(value_end) = html[start..].find('"') else {
            return Err(HcdError::InvalidBundle(
                "XLSX sheet section name is not closed".to_string(),
            ));
        };
        let end = start + value_end;
        if html[start..end] == previous {
            html.replace_range(start..end, &next);
            changed = true;
            cursor = start + next.len();
        } else {
            cursor = end;
        }
    }
    Ok(changed)
}

/// Move the tab place every surviving worksheet section names. A deletion takes
/// one place out of the list, so each tab behind it is one place nearer the front,
/// and that number is how a chunk reaches its worksheet part in the source
/// workbook — which is why it changes in the stored HTML as well as in the
/// descriptor.
pub(in crate::patch) fn shift_xlsx_sheet_sections(
    html: &mut String,
    deleted_index: usize,
) -> Result<bool, HcdError> {
    const MARKER: &str = "data-hcd-sheet-index=\"";
    let mut cursor = 0usize;
    let mut changed = false;
    while let Some(offset) = html[cursor..].find(MARKER) {
        let start = cursor + offset + MARKER.len();
        let Some(value_end) = html[start..].find('"') else {
            return Err(HcdError::InvalidBundle(
                "XLSX sheet section index is not closed".to_string(),
            ));
        };
        let end = start + value_end;
        let moved = html[start..end]
            .parse::<usize>()
            .ok()
            .filter(|position| *position > deleted_index)
            .map(|position| (position - 1).to_string());
        let Some(moved) = moved else {
            cursor = end;
            continue;
        };
        html.replace_range(start..end, &moved);
        changed = true;
        cursor = start + moved.len();
    }
    Ok(changed)
}

/// Source part backing one worksheet window. The descriptor carries it, and an
/// older bundle that predates that field falls back to its first mapped cell.
/// An empty worksheet has no mapped cells at all, so only the descriptor can
/// name the part a first row has to be written into.
pub(in crate::patch) fn xlsx_chunk_sheet_part(
    descriptor: &crate::ChunkDescriptor,
    source_map: &crate::ChunkSourceMap,
) -> Result<String, HcdError> {
    if let Some(part) = descriptor
        .grid
        .as_ref()
        .and_then(|grid| grid.sheet_part.as_ref())
    {
        return Ok(part.clone());
    }
    source_map
        .entries
        .iter()
        .find(|entry| entry.source.node_kind == "cell")
        .map(|entry| entry.source.part.clone())
        .ok_or_else(|| {
            HcdError::Unsupported(
                "XLSX row operations require a worksheet with a known source part".to_string(),
            )
        })
}

pub(in crate::patch) fn find_xlsx_sheet_part(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    sheet_id: &str,
) -> Result<String, HcdError> {
    let mut found_sheet = false;
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.kind != crate::GridChunkKind::Cells || grid.sheet_id != sheet_id {
                continue;
            }
            found_sheet = true;
            if let Some(part) = grid.sheet_part.clone() {
                return Ok(part);
            }
            if let Some(part) = bundle
                .read_map(&descriptor)?
                .entries
                .iter()
                .find(|entry| entry.source.node_kind == "cell")
                .map(|entry| entry.source.part.clone())
            {
                return Ok(part);
            }
        }
    }
    Err(HcdError::Unsupported(if found_sheet {
        "XLSX column width requires a worksheet with a mapped cell".to_string()
    } else {
        "XLSX worksheet is not in the HCD grid".to_string()
    }))
}
