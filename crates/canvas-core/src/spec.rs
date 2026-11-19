//! The Yjs fragment is authoritative. Plain text remains available to native
//! canvas viewers, search, and export. No browser-supplied HTML is stored.
use crate::CanvasError;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use yrs::{
    types::Attrs,
    updates::{decoder::Decode, encoder::Encode},
    Any, Assoc, Doc, IndexedSequence, OffsetKind, Options, Out, ReadTxn, StateVector, StickyIndex,
    Text, Transact, Update, XmlElementPrelim, XmlElementRef, XmlFragment, XmlFragmentRef, XmlOut,
    XmlTextPrelim, XmlTextRef,
};

const MAX_TEXT: usize = 64_000;
const MAX_DATA: usize = 1_400_000;
const FIELD: &str = "spec";
fn invalid(message: &str) -> CanvasError {
    CanvasError::Invalid(message.into())
}
fn conflict(message: &str) -> CanvasError {
    CanvasError::Conflict(message.into())
}
pub fn is_spec(el: &Value) -> bool {
    let tag = &el["customData"]["officeBoard"];
    el["type"] == "text"
        && tag["kind"] == "spec"
        && tag["root"].is_string()
        && matches!(tag["part"].as_str(), Some("body" | "title"))
}
fn plain(el: &Value) -> &str {
    el["originalText"]
        .as_str()
        .or(el["text"].as_str())
        .filter(|s| *s != " ")
        .unwrap_or("")
}
fn doc(client: Option<u64>) -> Doc {
    let mut opts = client.map(Options::with_client_id).unwrap_or_default();
    opts.offset_kind = OffsetKind::Utf16;
    Doc::with_options(opts)
}
fn integrate(doc: &Doc, bytes: &[u8]) -> Result<(), CanvasError> {
    let update = Update::decode_v1(bytes).map_err(|_| invalid("invalid Spec update"))?;
    let mut txn = doc.transact_mut();
    txn.apply_update(update)
        .map_err(|_| invalid("incompatible Spec update"))?;
    if txn.store().pending_update().is_some() || txn.store().pending_ds().is_some() {
        return Err(conflict("Spec update is missing its causal predecessor"));
    }
    Ok(())
}
fn decode(data: &str) -> Result<Vec<u8>, CanvasError> {
    if data.is_empty() || data.len() > MAX_DATA {
        return Err(CanvasError::Limit("Spec update size".into()));
    }
    STANDARD
        .decode(data)
        .map_err(|_| invalid("invalid Spec base64"))
}
fn load(el: &Value) -> Result<(Doc, XmlFragmentRef), CanvasError> {
    if !is_spec(el) {
        return Err(invalid("expected a Spec text object"));
    }
    let live = doc(None);
    let fragment = live.get_or_insert_xml_fragment(FIELD);
    if let Some(stored) = el["customData"].get("officeSpec") {
        if stored["version"] != 1 {
            return Err(invalid("unsupported Spec version"));
        }
        integrate(
            &live,
            &decode(
                stored["update"]
                    .as_str()
                    .ok_or_else(|| invalid("missing Spec state"))?,
            )?,
        )?;
    } else {
        // Every pre-existing file gets identical item IDs regardless of who opens it first.
        // Client 1 is used only to construct this immutable seed, never for subsequent edits.
        let seed = doc(Some(1));
        let root = seed.get_or_insert_xml_fragment(FIELD);
        let mut txn = seed.transact_mut();
        for line in plain(el).split('\n') {
            let p = root.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            if !line.is_empty() {
                p.push_back(&mut txn, XmlTextPrelim::new(line));
            }
        }
        integrate(
            &live,
            &txn.encode_state_as_update_v1(&StateVector::default()),
        )?;
    }
    Ok((live, fragment))
}
struct Segment {
    node: XmlTextRef,
    text: String,
}
struct Block {
    node: XmlElementRef,
    parts: Vec<Segment>,
    text: String,
}
fn collect<T: ReadTxn, F: XmlFragment>(
    parent: &F,
    txn: &T,
    depth: usize,
    out: &mut Vec<Block>,
) -> Result<(), CanvasError> {
    if depth > 24 {
        return Err(invalid("Spec nesting limit"));
    }
    for child in parent.children(txn) {
        let XmlOut::Element(node) = child else {
            return Err(invalid("invalid Spec block"));
        };
        match node.tag().as_ref() {
            "paragraph" | "heading" | "codeBlock" => {
                if out.len() >= 2048 {
                    return Err(invalid("too many Spec blocks"));
                }
                let mut parts = vec![];
                let mut text = String::new();
                for item in node.children(txn) {
                    let XmlOut::Text(run) = item else {
                        return Err(invalid("unsupported inline Spec node"));
                    };
                    let mut content = String::new();
                    for delta in run.diff(txn, |_| ()) {
                        let Out::Any(Any::String(s)) = delta.insert else {
                            return Err(invalid("unsupported Spec embed"));
                        };
                        if delta.attributes.as_ref().is_some_and(|a| {
                            a.keys().any(|k| {
                                !matches!(
                                    k.as_ref(),
                                    "bold" | "italic" | "strike" | "code" | "underline"
                                )
                            })
                        }) {
                            return Err(invalid("unsupported Spec mark"));
                        }
                        content.push_str(&s);
                    }
                    text.push_str(&content);
                    parts.push(Segment {
                        node: run,
                        text: content,
                    });
                }
                out.push(Block { node, parts, text });
            }
            "blockquote" | "bulletList" | "orderedList" | "listItem" => {
                collect(&node, txn, depth + 1, out)?
            }
            _ => return Err(invalid("unsupported Spec block type")),
        }
    }
    Ok(())
}
fn blocks<T: ReadTxn>(fragment: &XmlFragmentRef, txn: &T) -> Result<Vec<Block>, CanvasError> {
    if txn.root_refs().any(|(name, _)| name != FIELD) {
        return Err(invalid("unexpected Spec root"));
    }
    let mut out = vec![];
    collect(fragment, txn, 0, &mut out)?;
    if out
        .iter()
        .map(|b| b.text.chars().count() + 1)
        .sum::<usize>()
        > MAX_TEXT
    {
        return Err(CanvasError::Limit("Spec text limit".into()));
    }
    Ok(out)
}
fn project(el: &mut Value, doc: &Doc, fragment: &XmlFragmentRef) -> Result<(), CanvasError> {
    let txn = doc.transact();
    let lines: Vec<_> = blocks(fragment, &txn)?
        .into_iter()
        .map(|b| b.text)
        .collect();
    if el["customData"]["officeBoard"]["part"] == "title" && lines.len() > 1 {
        return Err(invalid("Spec title must occupy one paragraph"));
    }
    let text = lines.join("\n");
    let data = STANDARD.encode(txn.encode_state_as_update_v1(&StateVector::default()));
    if data.len() > MAX_DATA {
        return Err(CanvasError::Limit("Spec state size".into()));
    }
    el["customData"]["officeSpec"] = json!({"version":1,"update":data,"blocks":lines});
    el["text"] = json!(if text.is_empty() { " " } else { &text });
    el["originalText"] = el["text"].clone();
    let size = el["fontSize"].as_f64().unwrap_or(17.0);
    el["height"] =
        json!(size * el["lineHeight"].as_f64().unwrap_or(1.25) * text.split('\n').count() as f64);
    Ok(())
}
pub fn merge(el: &mut Value, data: &str) -> Result<(), CanvasError> {
    let (doc, root) = load(el)?;
    integrate(&doc, &decode(data)?)?;
    project(el, &doc, &root)
}
pub fn validate_stored(el: &Value) -> Result<(), CanvasError> {
    if el["customData"].get("officeSpec").is_none() {
        return Ok(());
    }
    let (doc, root) = load(el)?;
    let txn = doc.transact();
    let items: Vec<_> = blocks(&root, &txn)?.into_iter().map(|b| b.text).collect();
    if el["customData"]["officeSpec"]["blocks"] != json!(items)
        || items.join("\n") != plain(el) && !(items.join("\n") == " " && el["originalText"] == " ")
    {
        return Err(invalid("Spec projection differs from collaborative state"));
    }
    Ok(())
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpecCursor {
    pub id: String,
    pub anchor: String,
    pub head: String,
}

#[derive(Debug)]
pub struct RewriteEffect {
    pub cursor: SpecCursor,
    pub inverse: String,
}

fn range_cursor(
    doc: &Doc,
    root: &XmlFragmentRef,
    id: &str,
    block: usize,
    start: usize,
    end: usize,
) -> Result<SpecCursor, CanvasError> {
    let mut txn = doc.transact_mut();
    let rows = blocks(root, &txn)?;
    let row = rows
        .get(block)
        .ok_or_else(|| conflict("Spec paragraph is missing"))?;
    let mut point = |offset: usize, assoc: Assoc| {
        let mut n = offset;
        for seg in &row.parts {
            let count = seg.text.chars().count();
            if n <= count {
                let index = seg.text.chars().take(n).map(char::len_utf16).sum::<usize>() as u32;
                let pos = seg
                    .node
                    .sticky_index(&mut txn, index, assoc)
                    .unwrap_or_else(|| StickyIndex::from_type(&txn, &seg.node, assoc));
                return Ok(STANDARD.encode(pos.encode_v1()));
            }
            n -= count;
        }
        if offset == 0 && row.parts.is_empty() {
            return Ok(STANDARD.encode(StickyIndex::from_type(&txn, &row.node, assoc).encode_v1()));
        }
        Err(conflict("Spec cursor outside paragraph"))
    };
    Ok(SpecCursor {
        id: id.into(),
        anchor: point(start, Assoc::After)?,
        head: point(
            end,
            if start == end {
                Assoc::After
            } else {
                Assoc::Before
            },
        )?,
    })
}

/// Build the AI selection from the same immutable characters the splice will edit.
pub fn cursor_for_selection(
    el: &Value,
    block: usize,
    start: usize,
    end: usize,
) -> Result<SpecCursor, CanvasError> {
    let (doc, root) = load(el)?;
    let id = el["id"]
        .as_str()
        .ok_or_else(|| invalid("missing Spec object id"))?;
    range_cursor(&doc, &root, id, block, start, end)
}

pub struct Splice<'a> {
    pub block: usize,
    pub start: usize,
    pub end: usize,
    pub expected: &'a str,
    pub insert: &'a str,
}
pub fn splice(el: &mut Value, base: &Value, edit: Splice<'_>) -> Result<(), CanvasError> {
    splice_recorded(el, base, edit, false).map(|_| ())
}
pub(crate) fn splice_recorded(
    el: &mut Value,
    base: &Value,
    edit: Splice<'_>,
    record: bool,
) -> Result<Option<RewriteEffect>, CanvasError> {
    if !is_spec(el) || el["customData"]["officeBoard"] != base["customData"]["officeBoard"] {
        return Err(conflict("Spec identity changed"));
    }
    if edit.insert.chars().count() > MAX_TEXT
        || edit.insert.contains('\r')
        || edit.insert.contains('\n')
    {
        return Err(invalid("Spec splice edits one paragraph"));
    }
    let (history, root) = load(base)?;
    let old = blocks(&root, &history.transact())?;
    let target = old
        .get(edit.block)
        .ok_or_else(|| conflict("Spec paragraph is missing"))?;
    let chars: Vec<_> = target.text.chars().collect();
    if edit.end < edit.start
        || edit.end > chars.len()
        || chars[edit.start..edit.end].iter().collect::<String>() != edit.expected
    {
        return Err(conflict("Spec range does not match the read paragraph"));
    }
    let (current, current_root) = load(el)?;
    let latest = blocks(&current_root, &current.transact())?;
    let live = latest
        .iter()
        .find(|b| XmlOut::Element(b.node.clone()).id() == XmlOut::Element(target.node.clone()).id())
        .ok_or_else(|| conflict("Spec paragraph was removed or restructured"))?;
    let mut txn = history.transact_mut();
    let sv = txn.state_vector();
    let mut offset = 0;
    let mut inserted = false;
    for seg in &target.parts {
        let count = seg.text.chars().count();
        let from = edit.start.saturating_sub(offset).min(count);
        let to = edit.end.saturating_sub(offset).min(count);
        let place = !inserted && edit.start <= offset + count;
        if place || from < to {
            if !live
                .parts
                .iter()
                .any(|p| XmlOut::Text(p.node.clone()).id() == XmlOut::Text(seg.node.clone()).id())
            {
                return Err(conflict("Spec text was restructured"));
            }
            let utf16 = |pos| {
                seg.text
                    .chars()
                    .take(pos)
                    .map(char::len_utf16)
                    .sum::<usize>() as u32
            };
            let at = utf16(from);
            // Keep the existing run's marks while inserting into a historical replica.
            let mut n = 0;
            let mut attrs = Attrs::new();
            for d in seg.node.diff(&txn, |_| ()) {
                if let Out::Any(Any::String(v)) = d.insert {
                    n += v.encode_utf16().count() as u32;
                    attrs = d.attributes.map(|m| *m).unwrap_or_default();
                    if at < n {
                        break;
                    }
                }
            }
            if to > from {
                seg.node.remove_range(&mut txn, at, utf16(to) - at);
            }
            if place {
                if !edit.insert.is_empty() {
                    seg.node
                        .insert_with_attributes(&mut txn, at, edit.insert, attrs)
                }
                inserted = true
            }
        }
        offset += count;
    }
    if !inserted && !edit.insert.is_empty() {
        target
            .node
            .push_back(&mut txn, XmlTextPrelim::new(edit.insert));
    }
    // A concurrently inserted character never appears in this transaction's
    // deletion set. If an original item has already been deleted, ask the
    // agent to reread instead of concatenating competing replacements.
    if !txn.delete_set().is_empty() {
        let deleted = current.transact().snapshot().delete_set;
        let overlap = txn.delete_set().iter().any(|(client, target)| {
            deleted.range(client).is_some_and(|live| {
                target
                    .iter()
                    .any(|a| live.iter().any(|b| a.start < b.end && b.start < a.end))
            })
        });
        if overlap {
            return Err(conflict(
                "Spec selection was already edited; read the paragraph again",
            ));
        }
    }
    let delta = txn.encode_diff_v1(&sv);
    drop(txn);
    // Observe precisely this transaction on the pre-commit replica, which
    // already includes any independently committed human edits.
    let mut undo = record.then(|| yrs::undo::UndoManager::<()>::new(&current, &current_root));
    integrate(&current, &delta)?;
    project(el, &current, &current_root)?;
    if let Some(manager) = &mut undo {
        let after = current.transact().state_vector();
        if manager.undo_blocking() {
            let inverse = STANDARD.encode(current.transact().encode_diff_v1(&after));
            let cursor = range_cursor(
                &history,
                &root,
                el["id"].as_str().unwrap_or(""),
                edit.block,
                edit.start,
                edit.start + edit.insert.chars().count(),
            )?;
            return Ok(Some(RewriteEffect { inverse, cursor }));
        }
    }
    Ok(None)
}
/// Keep old plain-text callers working for edits inside one block. Deriving a
/// splice on their original snapshot preserves unobserved human characters.
pub fn replace_plain(
    el: &mut Value,
    base: &Value,
    before: &str,
    after: &str,
) -> Result<(), CanvasError> {
    let (original, root) = load(base)?;
    let rows = blocks(&root, &original.transact())?;
    let text = rows
        .iter()
        .map(|b| b.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if before != text && !(before == " " && text.is_empty()) {
        return Err(conflict("Spec source text changed"));
    }
    let old: Vec<_> = text.chars().collect();
    let new: Vec<_> = after.chars().collect();
    let first = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let last = old[first..]
        .iter()
        .rev()
        .zip(new[first..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let removed: String = old[first..old.len() - last].iter().collect();
    let inserted: String = new[first..new.len() - last].iter().collect();
    let mut at = 0;
    for (i, row) in rows.iter().enumerate() {
        let len = row.text.chars().count();
        if first >= at && old.len() - last <= at + len {
            return splice(
                el,
                base,
                Splice {
                    block: i,
                    start: first - at,
                    end: old.len() - last - at,
                    expected: &removed,
                    insert: &inserted,
                },
            );
        }
        at += len + 1;
    }
    Err(conflict(
        "use the rich text editor for a cross-block replacement",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{apply_with_base, Batch, Scene, Selection};

    fn legacy() -> Value {
        json!({"id":"body","type":"text","x":10,"y":20,"width":420,"height":60,
            "text":"🙂甲春季尾\n下一段","originalText":"🙂甲春季尾\n下一段",
            "customData":{"officeBoard":{"kind":"spec","root":"paper","part":"body"}}})
    }
    fn edit<'a>(start: usize, end: usize, expected: &'a str, insert: &'a str) -> Splice<'a> {
        Splice {
            block: 0,
            start,
            end,
            expected,
            insert,
        }
    }
    #[test]
    fn historical_unicode_edit_preserves_insertions_and_rejects_competing_replacements() {
        let base = legacy();
        let mut current = base.clone();
        splice(&mut current, &base, edit(3, 3, "", "人")).unwrap();
        splice(&mut current, &base, edit(2, 4, "春季", "秋季")).unwrap();
        let text = plain(&current);
        assert!(text == "🙂甲秋季人尾\n下一段" || text == "🙂甲人秋季尾\n下一段");
        let saved = current.clone();
        assert!(matches!(
            splice(&mut current, &base, edit(2, 4, "春季", "冬季")),
            Err(CanvasError::Conflict(_))
        ));
        assert!(splice(&mut current, &base, edit(2, 4, "夏季", "冬季")).is_err());
        assert_eq!(current, saved);
        validate_stored(&current).unwrap();
    }
    #[test]
    fn repeated_binary_updates_converge_in_both_orders_and_keep_blank_paragraphs() {
        let base = legacy();
        let mut a = base.clone();
        let mut b = base.clone();
        splice(&mut a, &base, edit(2, 2, "", "A")).unwrap();
        splice(&mut b, &base, edit(2, 2, "", "B")).unwrap();
        let (one, two) = (a.clone(), b.clone());
        let update = |e: &Value| {
            e["customData"]["officeSpec"]["update"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        merge(&mut a, &update(&two)).unwrap();
        merge(&mut b, &update(&one)).unwrap();
        merge(&mut b, &update(&two)).unwrap();
        assert_eq!(a, b);
        let saved = a.clone();
        assert!(merge(&mut a, "not base64").is_err());
        assert_eq!(a, saved);
        let mut empty = legacy();
        empty["originalText"] = json!("尾\n");
        let (d, f) = load(&empty).unwrap();
        project(&mut empty, &d, &f).unwrap();
        assert_eq!(
            empty["customData"]["officeSpec"]["blocks"],
            json!(["尾", ""])
        );
        assert_eq!(empty["height"], 42.5);
    }
    #[test]
    fn inverse_restores_original_marks_when_the_replacement_has_been_deleted() {
        let mut base = legacy();
        let (doc, root) = load(&base).unwrap();
        let row = blocks(&root, &doc.transact()).unwrap().remove(0);
        let mut marks = Attrs::new();
        marks.insert("bold".into(), Any::Bool(true));
        // The emoji occupies two UTF-16 code units. Mark 春, not 季.
        row.parts[0]
            .node
            .format(&mut doc.transact_mut(), 3, 1, marks);
        project(&mut base, &doc, &root).unwrap();
        let mut live = base.clone();
        let inverse = splice_recorded(&mut live, &base, edit(2, 4, "春季", "秋季"), true)
            .unwrap()
            .unwrap()
            .inverse;
        let seen = live.clone();
        splice(&mut live, &seen, edit(2, 4, "秋季", "人")).unwrap();
        merge(&mut live, &inverse).unwrap();
        assert_eq!(plain(&live).replace('人', ""), plain(&base));
        assert!(plain(&live).contains('人'));
        let (doc, root) = load(&live).unwrap();
        let txn = doc.transact();
        let r = blocks(&root, &txn).unwrap().remove(0);
        let marked: String = r.parts[0]
            .node
            .diff(&txn, |_| ())
            .into_iter()
            .filter(|part| {
                part.attributes
                    .as_ref()
                    .is_some_and(|a| a.contains_key("bold"))
            })
            .filter_map(|part| {
                if let Out::Any(Any::String(s)) = part.insert {
                    Some(s.to_string())
                } else {
                    None
                }
            })
            .collect();
        assert!(marked.contains('春') && !marked.contains('季'), "{marked}");
        let once = live.clone();
        merge(&mut live, &inverse).unwrap();
        assert_eq!(live, once);
    }
    #[test]
    fn removed_blocks_locked_paper_and_other_selections_preserve_the_scene() {
        let base = legacy();
        let (document, fragment) = load(&base).unwrap();
        fragment.remove(&mut document.transact_mut(), 0);
        let mut removed = base.clone();
        project(&mut removed, &document, &fragment).unwrap();
        assert!(matches!(
            splice(&mut removed, &base, edit(0, 1, "🙂", "日")),
            Err(CanvasError::Conflict(_))
        ));
        assert_eq!(plain(&removed), "下一段");
        let mut scene = Scene {
            elements: vec![
                json!({"id":"paper","type":"rectangle","x":0,"y":0,"width":500,"height":400,"customData":{"officeBoard":{"kind":"spec","root":"paper","part":"paper"}}}),
                base,
            ],
            ..Scene::default()
        };
        let batch:Batch=serde_json::from_value(json!({"schemaVersion":crate::PROTOCOL,"documentId":"test","patchId":"write","baseRevision":0,"operations":[{"op":"spec.splice","id":"body","block":0,"start":0,"end":1,"expected":"🙂","insert":"日"}]})).unwrap();
        let scope = Selection {
            element_ids: vec!["paper".into()],
            region: None,
        };
        assert!(apply_with_base(&scene, &batch, Some(&scope), &scene).is_err());
        scene.elements[0]["locked"] = json!(true);
        assert!(apply_with_base(&scene, &batch, None, &scene).is_err());
        assert_eq!(plain(&scene.elements[1]), "🙂甲春季尾\n下一段");
    }
}
