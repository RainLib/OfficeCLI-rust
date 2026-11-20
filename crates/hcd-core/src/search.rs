use crate::{extract_html_text_nodes, manifest_at_revision, Bundle, HcdError, INDEX_PAGE_SIZE};
use serde::Serialize;
use std::collections::HashMap;

pub const MAX_SEARCH_HITS: usize = 200;
const MAX_QUERY_CHARS: usize = 128;
const MAX_SEARCH_CHUNKS: usize = 10_000;
const MAX_SEARCH_HTML_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub chunk_sequence: usize,
    pub region: String,
    pub node_id: String,
    pub offset: usize,
    pub preview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_number: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub revision: u64,
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
}

/// Search canonical text nodes without loading assets or exporting a whole HTML document.
/// Every accessed index, map, and HTML object is checked by the bundle reader.
pub fn search_bundle(
    bundle: &Bundle,
    revision: Option<u64>,
    query: &str,
) -> Result<SearchResult, HcdError> {
    let needle = query.trim();
    let count = needle.chars().count();
    if count == 0 || count > MAX_QUERY_CHARS {
        return Err(HcdError::InvalidPatch(format!(
            "search query must contain 1-{MAX_QUERY_CHARS} characters"
        )));
    }
    let head = bundle.manifest()?;
    let (manifest, revision) = manifest_at_revision(bundle, &head, revision)?;
    let layout = crate::pdf_page_layout(bundle, &manifest)?;
    let page_positions: HashMap<_, _> = layout
        .iter()
        .enumerate()
        .filter_map(|(position, page)| page.source_page.map(|number| (number, position + 1)))
        .collect();
    let mut result = SearchResult {
        revision,
        hits: Vec::new(),
        truncated: false,
    };
    let mut scanned_chunks = 0usize;
    let mut scanned_bytes = 0u64;
    let mut source_page = 0u32;
    'scan: for page_number in 0..manifest.index_page_count {
        let page = bundle.read_index_page(&manifest, page_number)?;
        for descriptor in page.chunks {
            if descriptor.sequence >= manifest.chunk_count
                || descriptor.sequence / INDEX_PAGE_SIZE != page_number
            {
                return Err(HcdError::InvalidBundle(
                    "invalid search index sequence".to_string(),
                ));
            }
            if !descriptor.continuation {
                source_page += 1;
            }
            let page_position = page_positions.get(&source_page).copied();
            if !layout.is_empty() && page_position.is_none() {
                continue;
            }
            if descriptor.text_chars == 0 {
                continue;
            }
            if scanned_chunks == MAX_SEARCH_CHUNKS
                || scanned_bytes.saturating_add(descriptor.byte_length) > MAX_SEARCH_HTML_BYTES
            {
                result.truncated = true;
                break 'scan;
            }
            scanned_chunks += 1;
            scanned_bytes += descriptor.byte_length;
            let html = bundle.read_chunk_verified(&descriptor)?;
            let nodes = extract_html_text_nodes(&html)?;
            let source_map = bundle.read_map_verified(&descriptor)?;
            if source_map.chunk_id != descriptor.chunk_id {
                return Err(HcdError::InvalidBundle(
                    "search source map ID mismatch".to_string(),
                ));
            }
            for entry in source_map.entries {
                let Some(text) = nodes.get(&entry.node_id) else {
                    continue;
                };
                let page_number = page_position.or_else(|| {
                    entry
                        .source
                        .part
                        .strip_prefix("pdf/pages/")
                        .and_then(|number| number.parse::<usize>().ok())
                        .filter(|&number| number > 0)
                });
                for (offset, preview) in matching_previews(text, needle) {
                    if result.hits.len() == MAX_SEARCH_HITS {
                        result.truncated = true;
                        break 'scan;
                    }
                    result.hits.push(SearchHit {
                        chunk_sequence: descriptor.sequence,
                        region: descriptor.region.clone(),
                        node_id: entry.node_id.clone(),
                        offset,
                        preview,
                        sheet_id: descriptor.grid.as_ref().map(|grid| grid.sheet_id.clone()),
                        sheet_name: descriptor.grid.as_ref().map(|grid| grid.sheet_name.clone()),
                        page_number,
                        block_id: None,
                        element_id: None,
                    });
                }
            }
        }
    }
    if !layout.is_empty() {
        result
            .hits
            .sort_by_key(|hit| (hit.page_number, hit.chunk_sequence));
    }
    Ok(result)
}

/// Workspace hits carry the anchor the corresponding editor can open. A
/// semantic paragraph is searched as a whole, including across inline styles.
pub fn search_workspace(bundle: &Bundle, query: &str) -> Result<SearchResult, HcdError> {
    let query = query.trim();
    if !(1..=MAX_QUERY_CHARS).contains(&query.chars().count()) {
        return Err(HcdError::InvalidPatch(format!(
            "search query must contain 1-{MAX_QUERY_CHARS} characters"
        )));
    }
    let manifest = bundle.manifest()?;
    let revision = manifest.revision;
    let mut hits = Vec::new();
    let mut add_hits =
        |value: &str, node_id: &str, region: &str, block: Option<&str>, element: Option<&str>| {
            for (offset, preview) in matching_previews(value, query) {
                if hits.len() == MAX_SEARCH_HITS {
                    return false;
                }
                hits.push(SearchHit {
                    chunk_sequence: 0,
                    region: region.into(),
                    node_id: node_id.into(),
                    offset,
                    preview,
                    sheet_id: None,
                    sheet_name: None,
                    page_number: None,
                    block_id: block.map(str::to_owned),
                    element_id: element.map(str::to_owned),
                });
            }
            true
        };
    let complete = if manifest.source.format == "excalidraw" {
        let scene = crate::canvas::read_scene(bundle, Some(revision))?;
        scene
            .elements
            .iter()
            .filter(|item| item["isDeleted"] != true)
            .all(|item| {
                let Some(id) = item["id"].as_str() else {
                    return true;
                };
                let node = crate::canvas::node_id(&manifest.document_id, id);
                let value = item["customData"]["officeComment"]
                    .as_str()
                    .or_else(|| item["originalText"].as_str())
                    .or_else(|| item["text"].as_str());
                value.is_none_or(|value| add_hits(value, &node, "canvas", None, Some(id)))
            })
    } else if matches!(
        manifest.source.format.as_str(),
        "docx" | "md" | "txt" | "html"
    ) {
        let projected = match crate::editor_projection(bundle, Some(revision)) {
            Ok(projected) => projected,
            Err(HcdError::Unsupported(_)) => return search_bundle(bundle, None, query),
            Err(err) => return Err(err),
        };
        projected.blocks.iter().all(|block| {
            if block.read_only || block.region != "body" {
                block.content.inlines.iter().all(|run| {
                    add_hits(
                        &run.text,
                        run.node_id.as_deref().unwrap_or(&block.block_id),
                        &block.region,
                        Some(&block.block_id),
                        None,
                    )
                })
            } else {
                let text = block
                    .content
                    .inlines
                    .iter()
                    .map(|run| run.text.as_str())
                    .collect::<String>();
                add_hits(
                    &text,
                    &block.block_id,
                    &block.region,
                    Some(&block.block_id),
                    None,
                )
            }
        })
    } else {
        return search_bundle(bundle, None, query);
    };
    Ok(SearchResult {
        revision,
        hits,
        truncated: !complete,
    })
}

fn matching_previews(text: &str, query: &str) -> Vec<(usize, String)> {
    let haystack: Vec<char> = text.chars().collect();
    let needle: Vec<char> = query.chars().collect();
    if needle.len() > haystack.len() {
        return Vec::new();
    }
    let mut found = Vec::new();
    for start in 0..=haystack.len() - needle.len() {
        if !haystack[start..start + needle.len()]
            .iter()
            .zip(&needle)
            .all(|(left, right)| left.to_lowercase().eq(right.to_lowercase()))
        {
            continue;
        }
        let before = start.saturating_sub(32);
        let after = (start + needle.len() + 48).min(haystack.len());
        let mut preview = String::new();
        if before > 0 {
            preview.push('…');
        }
        preview.extend(&haystack[before..after]);
        if after < haystack.len() {
            preview.push('…');
        }
        found.push((start, preview));
        if found.len() > MAX_SEARCH_HITS {
            break;
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::matching_previews;

    #[test]
    fn finds_unicode_and_case_insensitive_text_at_character_offsets() {
        let hits = matching_previews("证据 Alpha 证据 alpha", "ALPHA");
        assert_eq!(
            hits.iter().map(|(offset, _)| *offset).collect::<Vec<_>>(),
            vec![3, 12]
        );
        assert_eq!(matching_previews("中文内容", "内容")[0].0, 2);
    }
}
