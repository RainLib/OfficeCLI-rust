use super::{is_forbidden_xml_character, xlsx_attribute, xlsx_cells};
use crate::{
    extract_html_text_nodes, Bundle, GridAutoFilter, GridChunkKind, HcdError, HcdManifest,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashSet};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridFilterView {
    pub filter: GridAutoFilter,
    pub hidden_rows: Vec<u32>,
    pub total: usize,
}

impl GridAutoFilter {
    pub fn criteria(&self) -> impl Iterator<Item = (u32, &str)> {
        std::iter::once((self.column, self.query.as_str())).chain(
            self.additional_criteria
                .iter()
                .map(|criterion| (criterion.column, criterion.query.as_str())),
        )
    }

    pub fn validate(&self) -> Result<(), HcdError> {
        if self.start_row == 0
            || self.start_row >= self.end_row
            || self.end_row > 1_048_576
            || self.end_row - self.start_row >= 500
            || self.start_column == 0
            || self.start_column > self.end_column
            || self.end_column > 16_384
            || self.end_column - self.start_column >= 100
        {
            return Err(HcdError::InvalidPatch(
                "AutoFilter requires a header, 1–499 data rows, and up to 100 columns".into(),
            ));
        }
        let mut columns = HashSet::new();
        for (column, query) in self.criteria() {
            if !(self.start_column..=self.end_column).contains(&column) || !columns.insert(column) {
                return Err(HcdError::InvalidPatch(
                    "AutoFilter requires distinct criteria columns within the range".into(),
                ));
            }
            if query.is_empty()
                || query.trim() != query
                || query
                    .chars()
                    .any(|ch| is_forbidden_xml_character(ch) || ch.is_control())
                || Self::excel_pattern(query).encode_utf16().count() > 255
            {
                return Err(HcdError::InvalidPatch(
                    "AutoFilter requires a valid text keyword for each column".into(),
                ));
            }
        }
        Ok(())
    }

    pub fn excel_pattern(query: &str) -> String {
        let mut pattern = String::from("*");
        for character in query.chars() {
            if matches!(character, '~' | '*' | '?') {
                pattern.push('~');
            }
            pattern.push(character);
        }
        pattern.push('*');
        pattern
    }
}

pub fn worksheet_filter(
    bundle: &Bundle,
    manifest: &HcdManifest,
    sheet_id: &str,
) -> Result<Option<GridFilterView>, HcdError> {
    for page in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page)?.chunks {
            if let Some(grid) = descriptor.grid.filter(|grid| grid.sheet_id == sheet_id) {
                if let Some(filter) = grid.auto_filter {
                    return evaluate_grid_filter(bundle, manifest, sheet_id, &filter, false)
                        .map(Some);
                }
            }
        }
    }
    Ok(None)
}

pub(super) fn evaluate_grid_filter(
    bundle: &Bundle,
    manifest: &HcdManifest,
    sheet_id: &str,
    filter: &GridAutoFilter,
    checking_new_filter: bool,
) -> Result<GridFilterView, HcdError> {
    filter.validate()?;
    let mut rows = BTreeMap::new();
    let mut bytes = 0;
    let needles: BTreeMap<_, _> = filter
        .criteria()
        .map(|(column, query)| (column, query.to_lowercase()))
        .collect();
    let mut matched = BTreeSet::new();
    for page in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.sheet_id != sheet_id
                || grid.kind != GridChunkKind::Cells
                || grid
                    .row_end
                    .is_none_or(|row| row < u64::from(filter.start_row))
                || grid
                    .row_start
                    .is_none_or(|row| row > u64::from(filter.end_row))
            {
                continue;
            }
            bytes += descriptor.byte_length;
            if bytes > 32 * 1024 * 1024 {
                return Err(HcdError::ResourceLimit(
                    "Filter range spans too much worksheet data".into(),
                ));
            }
            let html = bundle.read_chunk_verified(&descriptor)?;
            for (offset, _) in html.match_indices("<tr ") {
                let Some((tag, _)) = html[offset..].split_once('>') else {
                    continue;
                };
                if let Some(row) =
                    xlsx_attribute(tag, "data-hcd-row").and_then(|row| row.parse::<u32>().ok())
                {
                    if (filter.start_row..=filter.end_row).contains(&row) {
                        rows.insert(row, xlsx_attribute(tag, "data-hcd-hidden") == Some("true"));
                    }
                }
            }
            let texts = extract_html_text_nodes(&html)?;
            let source_map = bundle.read_map(&descriptor)?;
            let created = source_map
                .entries
                .iter()
                .filter(|entry| entry.source.created_in_hcd)
                .map(|entry| entry.node_id.as_str())
                .collect::<HashSet<_>>();
            for cell in xlsx_cells(&html)? {
                if checking_new_filter
                    && cell
                        .merged_range
                        .is_some_and(|(row, col, end_row, end_col)| {
                            row <= filter.end_row
                                && end_row >= filter.start_row
                                && col <= filter.end_column
                                && end_col >= filter.start_column
                        })
                {
                    return Err(HcdError::Unsupported(
                        "AutoFilter range intersects merged cells".into(),
                    ));
                }
                let Some(needle) = needles.get(&cell.column) else {
                    continue;
                };
                if !cell.has_node || !(filter.start_row..=filter.end_row).contains(&cell.row) {
                    continue;
                }
                let tag = &html[cell.start..=cell.tag_end];
                let raw = xlsx_attribute(tag, "data-hcd-raw-value");
                let sortable = xlsx_attribute(tag, "data-hcd-sortable");
                let node_id = xlsx_attribute(&html[cell.tag_end + 1..cell.end], "data-hcd-id");
                let is_text = xlsx_attribute(tag, "data-hcd-formula") != Some("true")
                    && raw.is_none_or(str::is_empty)
                    && sortable != Some("false")
                    && (sortable == Some("true")
                        || raw == Some("")
                        || node_id.is_some_and(|node| created.contains(node)));
                let value = node_id.and_then(|node| texts.get(node));
                if cell.row == filter.start_row {
                    if value.is_some_and(|value| !value.trim().is_empty()) {
                        matched.insert((cell.row, cell.column));
                    }
                } else if is_text {
                    if value.is_some_and(|value| value.to_lowercase().contains(needle)) {
                        matched.insert((cell.row, cell.column));
                    }
                } else if checking_new_filter {
                    return Err(HcdError::Unsupported(
                        "Saved text filters require a plain text column. Reimport older XLSX bundles without cell type metadata".into(),
                    ));
                }
            }
        }
    }
    if rows.len() != (filter.end_row - filter.start_row + 1) as usize
        || (checking_new_filter
            && needles
                .keys()
                .any(|column| !matched.contains(&(filter.start_row, *column))))
    {
        return Err(HcdError::Unsupported(
            "AutoFilter needs an existing header and contiguous worksheet rows".into(),
        ));
    }
    let mut view = GridFilterView {
        filter: filter.clone(),
        hidden_rows: Vec::new(),
        total: 0,
    };
    for (row, originally_hidden) in rows.range((filter.start_row + 1)..) {
        if *originally_hidden {
            continue;
        }
        view.total += 1;
        if needles
            .keys()
            .any(|column| !matched.contains(&(*row, *column)))
        {
            view.hidden_rows.push(*row);
        }
    }
    Ok(view)
}
