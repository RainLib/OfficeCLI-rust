use hcd_core::{
    editor_projection, manifest_at_revision, Bundle, EditorInline, HcdError, HcdManifest,
    NodeMapEntry, WordTableUpdate,
};
use std::collections::{BTreeMap, HashMap};

#[derive(Default)]
pub(super) struct SourceEdits {
    pub text: HashMap<String, BTreeMap<u64, String>>,
    pub tables: Vec<(Option<u64>, WordTableUpdate)>,
}

fn unsupported(reason: &str) -> HcdError {
    HcdError::Unsupported(format!(
        "{reason}. Use the editable DOCX rebuild for this revision"
    ))
}

fn same_marks(left: &EditorInline, right: &EditorInline, compare_format: bool) -> bool {
    left.bold == right.bold
        && left.italic == right.italic
        && left.link == right.link
        && (!compare_format || left.format == right.format)
}

pub(super) fn replacements(
    bundle: &Bundle,
    head: &HcdManifest,
    revision: u64,
) -> Result<SourceEdits, HcdError> {
    let before = editor_projection(bundle, Some(0))?;
    let after = editor_projection(bundle, Some(revision))?;
    if before.blocks.len() != after.blocks.len() {
        return Err(unsupported("The DOCX contains added or removed blocks"));
    }
    let mut updates = HashMap::new();
    let mut tables = HashMap::new();
    let mut unanchored = Vec::new();
    for (old, new) in before.blocks.into_iter().zip(after.blocks) {
        if old.region != new.region
            || old.content.kind != new.content.kind
            || old.content.level != new.content.level
            || old.read_only != new.read_only
            || ((!old.read_only
                || old.editable_table_layout
                || !old.editable_text_node_ids.is_empty())
                && old.block_id != new.block_id)
        {
            return Err(unsupported("The DOCX block order or structure changed"));
        }
        if old.block_hash == new.block_hash {
            continue;
        }
        if old.read_only {
            if old.editable_table_layout || !old.editable_text_node_ids.is_empty() {
                if let Some(plan) = hcd_core::word_table_layout_update(&old, &new)? {
                    let originals: HashMap<_, _> = old
                        .content
                        .inlines
                        .iter()
                        .filter_map(|inline| inline.node_id.as_deref().map(|id| (id, inline)))
                        .collect();
                    for inline in &new.content.inlines {
                        let Some(source) =
                            inline.node_id.as_deref().and_then(|id| originals.get(id))
                        else {
                            continue;
                        };
                        update(&mut updates, source, inline.text.clone())?;
                    }
                    if plan.filled_empty_cells.is_empty()
                        && plan
                            .layout
                            .rows
                            .iter()
                            .copied()
                            .eq((0..plan.original_rows).map(Some))
                        && plan
                            .layout
                            .columns
                            .iter()
                            .copied()
                            .eq((0..plan.original_columns).map(Some))
                    {
                        continue;
                    }
                    if let Some(anchor) = &plan.anchor {
                        tables.insert(anchor.clone(), plan);
                    } else {
                        unanchored.push((None, plan));
                    }
                    continue;
                }
                for inline in hcd_core::word_table_text_changes(&old, &new)
                    .map_err(|error| unsupported(&error.to_string()))?
                {
                    let id = inline.node_id.as_ref().ok_or_else(|| {
                        unsupported("A changed Word table cell has no source text run")
                    })?;
                    if updates.insert(id.clone(), inline.text.clone()).is_some() {
                        return Err(HcdError::InvalidBundle(
                            "Duplicate Word table text node".into(),
                        ));
                    }
                }
                continue;
            }
            return Err(unsupported("A protected DOCX block changed"));
        }
        if new.format_edited && old.content.alignment != new.content.alignment {
            return Err(unsupported("DOCX paragraph alignment changed"));
        }
        let old_inlines: Vec<_> = old
            .content
            .inlines
            .iter()
            .filter(|inline| !inline.text.is_empty())
            .collect();
        let new_inlines: Vec<_> = new
            .content
            .inlines
            .iter()
            .filter(|inline| !inline.text.is_empty())
            .collect();
        // Older checkpoint HTML did not carry run formatting. Keep exporting
        // those text edits against the original runs.
        let compare_format =
            new.format_edited || new_inlines.iter().any(|inline| !inline.format.is_empty());
        if new_inlines.is_empty() {
            for inline in old_inlines {
                update(&mut updates, inline, String::new())?;
            }
            continue;
        }
        let old_groups: Vec<_> = old_inlines
            .chunk_by(|left, right| same_marks(left, right, compare_format))
            .collect();
        let new_groups: Vec<_> = new_inlines
            .chunk_by(|left, right| same_marks(left, right, compare_format))
            .collect();
        if old_groups.len() != new_groups.len()
            || old_groups
                .iter()
                .zip(&new_groups)
                .any(|(left, right)| !same_marks(left[0], right[0], compare_format))
        {
            return Err(unsupported(
                "Inline styling, hyperlinks, or source text anchors changed",
            ));
        }
        for (old, new) in old_groups.into_iter().zip(new_groups) {
            let text: String = new.iter().map(|inline| inline.text.as_str()).collect();
            if text.contains(['\n', '\r', '\t'])
                && old
                    .iter()
                    .map(|inline| inline.text.as_str())
                    .collect::<String>()
                    != text
            {
                return Err(unsupported(
                    "Adding line breaks or tabs requires a structural DOCX edit",
                ));
            }
            for (inline, rendered) in old.iter().zip(rewrite_runs(old, &text)?) {
                update(&mut updates, inline, rendered)?;
            }
        }
    }
    let mut output = SourceEdits {
        tables: unanchored,
        ..SourceEdits::default()
    };
    if updates.is_empty() && tables.is_empty() {
        return Ok(output);
    }
    let (original, _) = manifest_at_revision(bundle, head, Some(0))?;
    for page in 0..original.index_page_count {
        for descriptor in bundle.read_index_page(&original, page)?.chunks {
            for entry in bundle.read_map(&descriptor)?.entries {
                let NodeMapEntry {
                    node_id, source, ..
                } = entry;
                if let Some(table) = tables.remove(&node_id) {
                    if source.part != "word/document.xml"
                        || source.node_kind != "text"
                        || source.created_in_hcd
                    {
                        return Err(unsupported(
                            "A Word table is missing its original source anchor",
                        ));
                    }
                    output.tables.push((Some(source.text_ordinal), table));
                }
                let Some(text) = updates.remove(&node_id) else {
                    continue;
                };
                if !source.editable || source.node_kind != "text" || source.created_in_hcd {
                    return Err(unsupported(
                        "A changed DOCX span has no editable source text run",
                    ));
                }
                let part = output.text.entry(source.part).or_default();
                if part.insert(source.text_ordinal, text).is_some() {
                    return Err(HcdError::InvalidBundle(
                        "Duplicate DOCX source text ordinal".into(),
                    ));
                }
            }
        }
    }
    if !updates.is_empty() || !tables.is_empty() {
        return Err(unsupported(
            "A changed DOCX span has no original source mapping",
        ));
    }
    Ok(output)
}

fn update(
    updates: &mut HashMap<String, String>,
    inline: &EditorInline,
    text: String,
) -> Result<(), HcdError> {
    if inline.text != text {
        let id = inline
            .node_id
            .clone()
            .ok_or_else(|| unsupported("A changed DOCX span has no source node"))?;
        if updates.insert(id, text).is_some() {
            return Err(HcdError::InvalidBundle(
                "Duplicate DOCX text node in the editor projection".into(),
            ));
        }
    }
    Ok(())
}

/// Align text within an equally marked span so unchanged characters keep their native run.
fn rewrite_runs(runs: &[&EditorInline], text: &str) -> Result<Vec<String>, HcdError> {
    if runs.len() == 1 {
        return Ok(vec![text.to_string()]);
    }
    let old: Vec<_> = runs
        .iter()
        .enumerate()
        .flat_map(|(run, inline)| inline.text.chars().map(move |ch| (ch, run)))
        .collect();
    let new: Vec<_> = text.chars().collect();
    let prefix = old
        .iter()
        .zip(&new)
        .take_while(|((a, _), b)| a == *b)
        .count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|((a, _), b)| a == *b)
        .count();
    let left = &old[prefix..old.len() - suffix];
    let right = &new[prefix..new.len() - suffix];
    let stride = right.len() + 1;
    let cells = (left.len() + 1).saturating_mul(stride);
    if cells > 2_000_000 {
        return Err(unsupported(
            "The changed text is too large to preserve the original run boundaries",
        ));
    }
    let mut lcs = vec![0u32; cells];
    for i in (0..left.len()).rev() {
        for j in (0..right.len()).rev() {
            let base = i * stride + j;
            lcs[base] = if left[i].0 == right[j] {
                1 + lcs[base + stride + 1]
            } else {
                lcs[base + stride].max(lcs[base + 1])
            };
        }
    }
    let mut result = vec![String::new(); runs.len()];
    for &(ch, run) in &old[..prefix] {
        result[run].push(ch);
    }
    let (mut i, mut j) = (0, 0);
    while j < right.len() {
        if i < left.len() && left[i].0 == right[j] {
            result[left[i].1].push(right[j]);
            i += 1;
            j += 1;
        } else if i == left.len() || lcs[i * stride + j + 1] >= lcs[(i + 1) * stride + j] {
            let position = (prefix + i).min(old.len() - 1);
            result[old[position].1].push(right[j]);
            j += 1;
        } else {
            i += 1;
        }
    }
    for &(ch, run) in &old[old.len() - suffix..] {
        result[run].push(ch);
    }
    Ok(result)
}
