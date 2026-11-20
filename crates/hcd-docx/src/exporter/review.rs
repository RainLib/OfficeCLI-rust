//! Materialize the review layer after the source-backed body has been edited.
//! Review anchors use canonical paragraph IDs and Unicode scalar offsets.

use super::{package_error, prepare_native_parts, tracked};
use docx_handler::mutations::{add_comment_part_aware, list_comments, set_comment_on_part};
use hcd_core::docx_review::{
    self, AddedComment, CommentAttachment, DocxReview, TrackedChange, TrackedDecision, TrackedEdit,
};
use hcd_core::{
    editor_projection, hash_bytes, hash_file, manifest_at_revision, ApplyResult, Bundle,
    EditorBlockView, HcdError, HcdManifest,
};
use oxml::{OxmlPackage, StreamingOxmlArchive};
use quick_xml::escape::escape;
use roxmltree::{Document, Node};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::Range;
use std::path::{Path, PathBuf};

const WORD: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const WORD_2010: &str = "http://schemas.microsoft.com/office/word/2010/wordml";
const BODY: &str = "word/document.xml";
const COMMENTS: &str = "word/comments.xml";
const COMMENTS_EXTENDED: &str = "word/commentsExtended.xml";
const RELS: &str = "word/_rels/document.xml.rels";
const PARTS: [&str; 5] = [
    BODY,
    COMMENTS,
    COMMENTS_EXTENDED,
    RELS,
    "[Content_Types].xml",
];
const MAX_NEW_COMMENTS: usize = 2048;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WordReviewEdit {
    pub base_revision: u64,
    pub patch_id: String,
    pub action: ReviewAction,
}

impl WordReviewEdit {
    pub fn changes_body(&self) -> bool {
        matches!(self.action, ReviewAction::Decide { .. })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReviewAction {
    Comment {
        block_id: String,
        start: usize,
        end: usize,
        text_hash: String,
        text: String,
    },
    Reply {
        thread_id: i32,
        text: String,
    },
    Resolve {
        thread_id: i32,
        resolved: bool,
    },
    Decide {
        change: TrackedChange,
        accept: bool,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordReviewSnapshot {
    pub revision: u64,
    pub comments: Vec<CommentView>,
    pub tracked: Vec<tracked::TrackedView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentView {
    pub id: i32,
    pub parent_id: Option<i32>,
    pub author: Option<String>,
    pub date: Option<String>,
    pub text: String,
    pub resolved: bool,
    pub location: Option<CommentLocation>,
    pub quote: Option<String>,
    pub original_range_changed: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentLocation {
    pub block_id: String,
    pub start: usize,
    pub end: usize,
}

pub(super) struct MaterializedReview {
    before: HashMap<&'static str, String>,
    package: OxmlPackage,
    snapshot: WordReviewSnapshot,
}

impl MaterializedReview {
    pub(super) fn changed_parts(self) -> Result<Vec<(&'static str, bool, String)>, HcdError> {
        let mut changes = Vec::new();
        for part in PARTS.into_iter().filter(|part| self.package.has_part(part)) {
            let xml = self.package.read_part_xml(part).map_err(package_error)?;
            if self.before.get(part) != Some(&xml) {
                parse(&xml)?;
                changes.push((part, self.before.contains_key(part), xml));
            }
        }
        Ok(changes)
    }
}

pub fn read_word_review(
    bundle: &Bundle,
    source: &Path,
    revision: Option<u64>,
) -> Result<WordReviewSnapshot, HcdError> {
    let head = bundle.manifest()?;
    check_source(&head, source)?;
    let (manifest, revision) = manifest_at_revision(bundle, &head, revision)?;
    let review = docx_review::read(bundle, &manifest)?;
    let temp = tempfile::tempdir()?;
    let (parts, _) = prepare_native_parts(bundle, source, &manifest, &review, temp.path())?;
    Ok(materialize(bundle, source, revision, &parts, &review)?.snapshot)
}

pub fn edit_word_review(
    bundle: &Bundle,
    source: &Path,
    request: &WordReviewEdit,
    user_id: &str,
    author: &str,
) -> Result<ApplyResult, HcdError> {
    let hash = hash_bytes(&serde_json::to_vec(&("docx-review", user_id, request))?);
    docx_review::edit(
        bundle,
        request.base_revision,
        &format!("docx-review-{}", request.patch_id),
        &hash,
        |manifest, state| {
            check_source(manifest, source)?;
            let temp = tempfile::tempdir()?;
            let (parts, _) = prepare_native_parts(bundle, source, manifest, state, temp.path())?;
            let revision = manifest.revision;
            let stage = materialize(bundle, source, revision, &parts, state)?;
            let snapshot = &stage.snapshot;
            if let ReviewAction::Decide { change, accept } = request.action {
                let location = snapshot
                    .tracked
                    .iter()
                    .find(|entry| entry.change == Some(change))
                    .and_then(|entry| entry.location.as_ref())
                    .ok_or_else(|| {
                        HcdError::PreconditionFailed(
                            "这条修订已处理或没有可用的独立正文锚点。".into(),
                        )
                    })?;
                let xml = stage
                    .before
                    .get(BODY)
                    .ok_or_else(|| invalid("missing Word body"))?;
                let decision = TrackedDecision { change, accept };
                let deleted_text = tracked::verify_action(xml, decision)?;
                return Ok(Some(TrackedEdit {
                    decision,
                    block_id: location.block_id.clone(),
                    deleted_text,
                }));
            }
            if let ReviewAction::Resolve {
                thread_id,
                resolved,
            } = request.action
            {
                let thread = thread(snapshot, thread_id)?;
                if thread.resolved == resolved {
                    return Err(HcdError::PreconditionFailed(
                        "批注的解决状态已经更新。".into(),
                    ));
                }
                state.resolved.insert(thread_id, resolved);
                materialize(bundle, source, revision, &parts, state)?.changed_parts()?;
                return Ok(None);
            }
            if state.comments.len() >= MAX_NEW_COMMENTS {
                return Err(HcdError::ResourceLimit(
                    "Word review comment limit reached".into(),
                ));
            }
            let id = next_comment_id(&stage)?;
            let (text, attachment) = match &request.action {
                ReviewAction::Comment {
                    block_id,
                    start,
                    end,
                    text_hash,
                    text,
                } => {
                    let projection = editor_projection(bundle, Some(revision))?;
                    let block = projection
                        .blocks
                        .iter()
                        .find(|block| {
                            block.block_id == *block_id
                                && block.region == "body"
                                && !block.read_only
                        })
                        .ok_or_else(|| {
                            HcdError::PreconditionFailed("选区所在的 Word 段落已变化。".into())
                        })?;
                    let paragraph = block_text(block);
                    let quote = slice(&paragraph, *start, *end)
                        .filter(|quote| !quote.trim().is_empty())
                        .ok_or_else(|| {
                            HcdError::InvalidPatch("请选择一处有文字的正文选区。".into())
                        })?;
                    if quote.len() > 16_384 || hash_bytes(quote.as_bytes()) != *text_hash {
                        return Err(HcdError::PreconditionFailed(
                            "选区文字已变化，或选区过长。".into(),
                        ));
                    }
                    (
                        text,
                        CommentAttachment::Range {
                            block_id: block_id.clone(),
                            start: *start,
                            quote,
                            paragraph_hash: hash_bytes(paragraph.as_bytes()),
                        },
                    )
                }
                ReviewAction::Reply { thread_id, text } => {
                    if thread(snapshot, *thread_id)?.resolved {
                        return Err(HcdError::PreconditionFailed(
                            "请重新打开这条批注后再回复。".into(),
                        ));
                    }
                    (
                        text,
                        CommentAttachment::Reply {
                            parent_id: *thread_id,
                        },
                    )
                }
                ReviewAction::Resolve { .. } | ReviewAction::Decide { .. } => {
                    unreachable!("handled above")
                }
            };
            let text = text.trim();
            if text.is_empty() || text.len() > 16_384 || !xml_text(text) {
                return Err(HcdError::InvalidPatch(
                    "请输入有效的批注内容，最多 16 KiB。".into(),
                ));
            }
            let author: String = author
                .chars()
                .filter(|c| !c.is_control() && xml_char(*c))
                .take(128)
                .collect();
            let date = time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .map_err(|error| invalid(error.to_string()))?;
            let anchored = matches!(attachment, CommentAttachment::Range { .. });
            state.comments.push(AddedComment {
                id,
                author,
                date,
                text: text.into(),
                attachment,
            });
            let changed = materialize(bundle, source, revision, &parts, state)?;
            if anchored
                && changed
                    .snapshot
                    .comments
                    .iter()
                    .find(|comment| comment.id == id)
                    .is_none_or(|comment| {
                        comment.location.is_none() || comment.original_range_changed
                    })
            {
                return Err(HcdError::Unsupported(
                    "这处选区无法精确写入原生 Word 批注。请在普通正文文字中选取一个范围。".into(),
                ));
            }
            changed.changed_parts()?;
            Ok(None)
        },
    )
}

fn check_source(manifest: &HcdManifest, source: &Path) -> Result<(), HcdError> {
    if manifest.source.format != "docx" {
        return Err(HcdError::Unsupported(
            "review requires a Word document".into(),
        ));
    }
    if hash_file(source)? != manifest.source.sha256 {
        return Err(HcdError::SourceMismatch(
            "immutable DOCX source does not match".into(),
        ));
    }
    Ok(())
}

fn thread(snapshot: &WordReviewSnapshot, id: i32) -> Result<&CommentView, HcdError> {
    snapshot
        .comments
        .iter()
        .find(|comment| comment.id == id && comment.parent_id.is_none())
        .ok_or_else(|| HcdError::PreconditionFailed("这条批注已变化，请刷新审阅面板。".into()))
}

fn next_comment_id(stage: &MaterializedReview) -> Result<i32, HcdError> {
    let xml = stage.package.read_part_xml(BODY).map_err(package_error)?;
    let document = parse(&xml)?;
    let markers = document
        .descendants()
        .filter(|node| comment_marker(*node))
        .filter_map(native_id);
    stage
        .snapshot
        .comments
        .iter()
        .map(|comment| comment.id)
        .chain(markers)
        .max()
        .unwrap_or(-1)
        .max(-1)
        .checked_add(1)
        .ok_or_else(|| HcdError::ResourceLimit("Word comment identifier limit reached".into()))
}

pub(super) fn materialize(
    bundle: &Bundle,
    source: &Path,
    revision: u64,
    replacements: &HashMap<String, PathBuf>,
    state: &DocxReview,
) -> Result<MaterializedReview, HcdError> {
    let mut archive = StreamingOxmlArchive::open(source).map_err(package_error)?;
    let mut package = OxmlPackage::create("");
    let mut before = HashMap::new();
    for part in PARTS {
        if archive.contains(part) {
            let bytes = if let Some(path) = replacements.get(part) {
                std::fs::read(path)?
            } else {
                archive
                    .read_control_part(part, 32 * 1024 * 1024)
                    .map_err(package_error)?
            };
            let xml = String::from_utf8(bytes).map_err(|error| invalid(error.to_string()))?;
            package.write_part_xml(part, &xml).map_err(package_error)?;
            before.insert(part, xml);
        }
    }
    check_comment_parts(before.get(RELS).map(String::as_str))?;
    let xml = before
        .get(BODY)
        .ok_or_else(|| invalid("missing Word document body"))?;
    let doc = parse(xml)?;
    let projection = editor_projection(bundle, Some(revision))?;
    let revisions = tracked::inspect(&doc, &projection)?;
    let pairs = body_pairs(&doc, &projection.blocks);
    let by_block: HashMap<_, _> = pairs
        .iter()
        .map(|(node, block)| (block.block_id.as_str(), (*node, *block)))
        .collect();
    let mut locations = original_locations(&pairs);
    let mut quotes = HashMap::new();
    let mut changed_ranges = HashSet::new();
    if !state.comments.is_empty() || !state.resolved.is_empty() {
        if doc.root_element().lookup_namespace_uri(Some("w")) != Some(WORD) {
            return Err(HcdError::Unsupported(
                "原生审阅需要 Word 正文的标准 w 命名空间。".into(),
            ));
        }
        let mut marker_plan = MarkerPlan::default();
        let mut used_para_ids: HashSet<_> = paragraph_ids(&doc).collect();
        if let Some(original) = before.get(COMMENTS) {
            used_para_ids.extend(paragraph_ids(&parse(original)?));
        }
        for comment in &state.comments {
            let parent = match &comment.attachment {
                CommentAttachment::Reply { parent_id } => {
                    ensure_paragraph_id(&mut package, *parent_id, &mut used_para_ids)?;
                    Some(parent_id.to_string())
                }
                CommentAttachment::Range {
                    block_id, quote, ..
                } => {
                    quotes.insert(comment.id, quote.clone());
                    let position = by_block.get(block_id.as_str()).and_then(|(node, view)| {
                        marker_plan.attach(*node, view, xml, comment.id, &comment.attachment)
                    });
                    if let Some((location, exact)) = position {
                        locations.insert(comment.id, location);
                        if !exact {
                            changed_ranges.insert(comment.id);
                        }
                    } else {
                        changed_ranges.insert(comment.id);
                    }
                    None
                }
            };
            let mut properties = HashMap::from([
                ("range".into(), "none".into()),
                ("commentId".into(), comment.id.to_string()),
                (
                    "commentParaId".into(),
                    reserve_para_id(&mut used_para_ids, comment.id)?,
                ),
                ("author".into(), comment.author.clone()),
                ("date".into(), comment.date.clone()),
                ("text".into(), comment.text.clone()),
            ]);
            if let Some(parent) = parent {
                properties.insert("parentId".into(), parent);
            }
            add_comment_part_aware(&mut package, "/comments", &properties)
                .map_err(handler_error)?;
        }
        for (id, done) in &state.resolved {
            ensure_paragraph_id(&mut package, *id, &mut used_para_ids)?;
            set_comment_on_part(
                &mut package,
                COMMENTS,
                &format!("/comments/comment[@commentId={id}]"),
                &HashMap::from([("resolved".into(), done.to_string())]),
            )
            .map_err(handler_error)?;
        }
        if !marker_plan.is_empty() {
            package
                .write_part_xml(BODY, &marker_plan.finish(xml)?)
                .map_err(package_error)?;
        }
    }
    let comments = list_comments(&package)
        .map_err(handler_error)?
        .into_iter()
        .map(|comment| {
            let id = comment
                .id
                .parse::<i32>()
                .map_err(|_| invalid("invalid Word comment ID"))?;
            let location = locations.remove(&id);
            let quote = quotes.remove(&id).or_else(|| {
                let range = location.as_ref()?;
                let (_, block) = by_block.get(range.block_id.as_str())?;
                slice(&block_text(block), range.start, range.end)
            });
            Ok(CommentView {
                id,
                parent_id: comment.parent_id.and_then(|id| id.parse().ok()),
                author: comment.author,
                date: comment.date,
                text: comment.text,
                resolved: comment.done,
                location,
                quote,
                original_range_changed: changed_ranges.contains(&id),
            })
        })
        .collect::<Result<Vec<_>, HcdError>>()?;
    Ok(MaterializedReview {
        before,
        package,
        snapshot: WordReviewSnapshot {
            revision,
            comments,
            tracked: revisions,
        },
    })
}

fn check_comment_parts(rels: Option<&str>) -> Result<(), HcdError> {
    if let Some(xml) = rels {
        for entry in parse(xml)?
            .root_element()
            .children()
            .filter(Node::is_element)
        {
            let expected = match entry
                .attribute("Type")
                .and_then(|uri| uri.rsplit('/').next())
            {
                Some("comments") => "comments.xml",
                Some("commentsExtended") => "commentsExtended.xml",
                _ => continue,
            };
            let target = entry.attribute("Target").unwrap_or_default();
            if entry.attribute("TargetMode") == Some("External")
                || target != expected
                    && target.strip_prefix("./") != Some(expected)
                    && target.strip_prefix("/word/") != Some(expected)
            {
                return Err(HcdError::Unsupported(
                    "此 Word 文件使用无法安全写入的批注部件位置。".into(),
                ));
            }
        }
    }
    Ok(())
}

// Word identifies a threaded comment by the ID of its last paragraph.
fn ensure_paragraph_id(
    package: &mut OxmlPackage,
    id: i32,
    used: &mut HashSet<String>,
) -> Result<(), HcdError> {
    let xml = package.read_part_xml(COMMENTS).map_err(package_error)?;
    let doc = parse(&xml)?;
    let paragraph = doc
        .root_element()
        .children()
        .find(|node| word(*node, "comment") && native_id(*node) == Some(id))
        .and_then(|comment| comment.children().rfind(|node| word(*node, "p")))
        .ok_or_else(|| invalid("Word comment has no paragraph"))?;
    if paragraph.attribute((WORD_2010, "paraId")).is_some() {
        return Ok(());
    }
    let para_id = reserve_para_id(used, id)?;
    let at = paragraph.range().start
        + xml[paragraph.range()]
            .find([' ', '>', '/', '\n', '\r', '\t'])
            .ok_or_else(|| invalid("invalid Word comment paragraph"))?;
    let namespace = if paragraph.lookup_namespace_uri(Some("w14")) == Some(WORD_2010) {
        String::new()
    } else {
        format!(r#" xmlns:w14="{WORD_2010}""#)
    };
    let mut output = xml;
    output.insert_str(at, &format!(r#"{namespace} w14:paraId="{para_id}""#));
    package
        .write_part_xml(COMMENTS, &output)
        .map_err(package_error)
}

fn paragraph_ids<'a>(doc: &'a Document<'_>) -> impl Iterator<Item = String> + 'a {
    doc.descendants().filter_map(|node| {
        node.attribute((WORD_2010, "paraId"))
            .map(str::to_ascii_uppercase)
    })
}

fn reserve_para_id(used: &mut HashSet<String>, id: i32) -> Result<String, HcdError> {
    let candidate = (id as u32).wrapping_mul(2_654_435_761) & 0x7FFF_FFFF;
    let next = (0..=used.len())
        .map(|i| {
            format!(
                "{:08X}",
                (candidate.wrapping_add(i as u32) % 0x7FFF_FFFF) + 1
            )
        })
        .find(|id| !used.contains(id))
        .ok_or_else(|| HcdError::ResourceLimit("Word comment paragraph ID limit reached".into()))?;
    used.insert(next.clone());
    Ok(next)
}

fn body_pairs<'a, 'b>(
    doc: &'a Document<'a>,
    blocks: &'b [EditorBlockView],
) -> Vec<(Node<'a, 'a>, &'b EditorBlockView)> {
    let native: Vec<_> = doc
        .root_element()
        .children()
        .find(|node| word(*node, "body"))
        .into_iter()
        .flat_map(|body| body.children())
        .filter(|node| word(*node, "p") || word(*node, "tbl"))
        .collect();
    let body: Vec<_> = blocks
        .iter()
        .filter(|block| block.region == "body")
        .collect();
    if native.len() != body.len()
        || native.iter().zip(&body).any(|(node, block)| {
            word(*node, "tbl")
                != block
                    .read_only_html
                    .as_deref()
                    .is_some_and(|html| html.starts_with("<table"))
        })
    {
        return Vec::new();
    }
    native.into_iter().zip(body).collect()
}

fn original_locations(pairs: &[(Node<'_, '_>, &EditorBlockView)]) -> HashMap<i32, CommentLocation> {
    let mut locations = HashMap::new();
    for (node, block) in pairs {
        if !node.descendants().any(comment_marker) {
            continue;
        }
        let exact =
            word(*node, "p") && !block.read_only && native_text(*node, *node) == block_text(block);
        let mut scalar = 0;
        for child in node.descendants() {
            if visible_text(child, *node) {
                scalar += child.text().unwrap_or_default().chars().count();
            } else if comment_marker(child) {
                let Some(id) = native_id(child) else { continue };
                let offset = if exact { scalar } else { 0 };
                let location = locations.entry(id).or_insert_with(|| CommentLocation {
                    block_id: block.block_id.clone(),
                    start: offset,
                    end: offset,
                });
                if location.block_id == block.block_id && word(child, "commentRangeEnd") {
                    location.end = offset;
                }
            }
        }
    }
    locations
}

#[derive(Default)]
struct MarkerPlan<'a, 'b> {
    points: BTreeMap<usize, String>,
    splits: BTreeMap<usize, (Node<'a, 'b>, BTreeMap<usize, String>)>,
}

enum Boundary<'a, 'b> {
    Between(usize),
    Inside(Node<'a, 'b>, usize),
}

impl<'a, 'b> MarkerPlan<'a, 'b> {
    fn is_empty(&self) -> bool {
        self.points.is_empty() && self.splits.is_empty()
    }

    fn attach(
        &mut self,
        paragraph: Node<'a, 'b>,
        block: &EditorBlockView,
        xml: &str,
        id: i32,
        attachment: &CommentAttachment,
    ) -> Option<(CommentLocation, bool)> {
        let CommentAttachment::Range {
            start: original_start,
            quote,
            paragraph_hash,
            ..
        } = attachment
        else {
            return None;
        };
        if !word(paragraph, "p") {
            return None;
        }
        let plain = block_text(block);
        let native = native_text(paragraph, paragraph);
        let exact = (native == plain && !block.read_only)
            .then(|| {
                let start = relocate(&plain, quote, *original_start, paragraph_hash)?;
                let end = start + quote.chars().count();
                Some((
                    start,
                    end,
                    boundary(paragraph, start)?,
                    boundary(paragraph, end)?,
                ))
            })
            .flatten();
        let reference = format!(
            r#"<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="{id}"/></w:r>"#
        );
        let (start, end, exact) = if let Some((start, end, first, last)) = exact {
            self.place(first, &format!(r#"<w:commentRangeStart w:id="{id}"/>"#));
            self.place(
                last,
                &format!(r#"<w:commentRangeEnd w:id="{id}"/>{reference}"#),
            );
            (start, end, true)
        } else {
            let range = paragraph.range();
            let end = range.start + xml[range].rfind("</")?;
            self.place(Boundary::Between(end), &reference);
            let length = plain.chars().count();
            (length, length, false)
        };
        Some((
            CommentLocation {
                block_id: block.block_id.clone(),
                start,
                end,
            },
            exact,
        ))
    }

    fn place(&mut self, boundary: Boundary<'a, 'b>, marker: &str) {
        match boundary {
            Boundary::Between(offset) => self.points.entry(offset).or_default().push_str(marker),
            Boundary::Inside(run, offset) => self
                .splits
                .entry(run.range().start)
                .or_insert_with(|| (run, BTreeMap::new()))
                .1
                .entry(offset)
                .or_default()
                .push_str(marker),
        }
    }

    fn finish(self, xml: &str) -> Result<String, HcdError> {
        let mut edits: Vec<(Range<usize>, String)> = self
            .points
            .into_iter()
            .map(|(offset, value)| (offset..offset, value))
            .collect();
        for (_, (run, markers)) in self.splits {
            let text = simple_run(run).ok_or_else(|| invalid("unmappable Word comment range"))?;
            let plain: Vec<_> = text.text().unwrap_or_default().chars().collect();
            let open = &xml[run.range().start..text.range().start];
            let close = &xml[text.range().end..run.range().end];
            let mut output = String::new();
            let mut start = 0;
            for (end, marker) in markers.into_iter().chain([(plain.len(), String::new())]) {
                output.push_str(open);
                output.push_str("<w:t xml:space=\"preserve\">");
                output.push_str(&escape(plain[start..end].iter().collect::<String>()));
                output.push_str("</w:t>");
                output.push_str(close);
                output.push_str(&marker);
                start = end;
            }
            edits.push((run.range(), output));
        }
        edits.sort_unstable_by_key(|(range, _)| (range.start, range.end));
        let mut result = String::with_capacity(xml.len());
        let mut at = 0;
        for (range, replacement) in edits {
            if range.start < at {
                return Err(invalid("overlapping Word comment rewrites"));
            }
            result.push_str(&xml[at..range.start]);
            result.push_str(&replacement);
            at = range.end;
        }
        result.push_str(&xml[at..]);
        Ok(result)
    }
}

fn boundary<'a, 'b>(paragraph: Node<'a, 'b>, offset: usize) -> Option<Boundary<'a, 'b>> {
    let mut start = 0;
    for child in paragraph.children().filter(Node::is_element) {
        let length = native_text(child, paragraph).chars().count();
        let end = start + length;
        if length > 0 && (start..=end).contains(&offset) {
            if offset == start {
                return Some(Boundary::Between(child.range().start));
            }
            if offset == end {
                return Some(Boundary::Between(child.range().end));
            }
            return simple_run(child).map(|_| Boundary::Inside(child, offset - start));
        }
        start = end;
    }
    None
}

fn simple_run<'a, 'b>(run: Node<'a, 'b>) -> Option<Node<'a, 'b>> {
    if !word(run, "r")
        || run.attributes().iter().any(|attr| {
            attr.namespace() != Some(WORD)
                || !matches!(attr.name(), "rsidR" | "rsidRPr" | "rsidDel")
        })
    {
        return None;
    }
    let mut text = None;
    for child in run.children().filter(Node::is_element) {
        if word(child, "t") && text.is_none() {
            text = Some(child);
        } else if !word(child, "rPr") || child.descendants().any(|node| word(node, "rPrChange")) {
            return None;
        }
    }
    text
}

fn relocate(plain: &str, quote: &str, start: usize, paragraph_hash: &str) -> Option<usize> {
    if hash_bytes(plain.as_bytes()) == paragraph_hash
        && slice(plain, start, start + quote.chars().count()).as_deref() == Some(quote)
    {
        return Some(start);
    }
    let first = plain.find(quote)?;
    let after_first_scalar = first + plain[first..].chars().next()?.len_utf8();
    if plain[after_first_scalar..].contains(quote) {
        return None;
    }
    Some(plain[..first].chars().count())
}

fn slice(value: &str, start: usize, end: usize) -> Option<String> {
    if end <= start || end > value.chars().count() {
        return None;
    }
    Some(value.chars().skip(start).take(end - start).collect())
}

fn block_text(block: &EditorBlockView) -> String {
    block
        .content
        .inlines
        .iter()
        .map(|inline| inline.text.as_str())
        .collect()
}

fn native_text(node: Node<'_, '_>, paragraph: Node<'_, '_>) -> String {
    node.descendants()
        .filter(|child| visible_text(*child, paragraph))
        .filter_map(|child| child.text())
        .collect()
}

fn visible_text(node: Node<'_, '_>, scope: Node<'_, '_>) -> bool {
    word(node, "t")
        && !node
            .ancestors()
            .take_while(|ancestor| *ancestor != scope)
            .any(|ancestor| {
                ["del", "moveFrom", "txbxContent"]
                    .iter()
                    .any(|tag| word(ancestor, tag))
            })
}

fn comment_marker(node: Node<'_, '_>) -> bool {
    ["commentRangeStart", "commentRangeEnd", "commentReference"]
        .iter()
        .any(|tag| word(node, tag))
}

fn native_id(node: Node<'_, '_>) -> Option<i32> {
    node.attribute((WORD, "id"))?.parse().ok()
}

fn word(node: Node<'_, '_>, local: &str) -> bool {
    node.has_tag_name((WORD, local))
}

fn parse(xml: &str) -> Result<Document<'_>, HcdError> {
    Document::parse(xml).map_err(|error| invalid(error.to_string()))
}

fn xml_char(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r' | '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}')
}

fn xml_text(text: &str) -> bool {
    text.chars().all(xml_char)
}

fn invalid(error: impl Into<String>) -> HcdError {
    HcdError::InvalidBundle(error.into())
}

fn handler_error(error: impl std::fmt::Display) -> HcdError {
    invalid(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{export_docx, import_docx, ExportOptions, ImportOptions};

    #[test]
    fn word_run_decisions_round_trip_without_losing_pending_changes_or_later_edits() {
        use crate::exporter::pictures;
        use hcd_core::docx_review::TrackedKind::{Delete, Insert};
        use hcd_core::{
            apply_structure_patch, project_editor, restore_revision, BlockPrecondition,
            StructureOperation, StructurePatchBatch, TableEditAction, HCD_PATCH_SCHEMA_VERSION_4,
        };
        let temp = tempfile::tempdir().unwrap();
        let original = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/word/numbering-showcase.docx");
        let source = temp.path().join("tracked.docx");
        let mut package = OxmlPackage::open(original.to_str().unwrap(), true).unwrap();
        let mut xml = package.read_part_xml(BODY).unwrap();
        let source_markup = concat!(
            r#"<w:p><w:r><w:t>Review: </w:t></w:r>"#,
            r#"<w:ins w:id="100" w:author="Amy"><w:r><w:t>Proposed</w:t></w:r></w:ins>"#,
            r#"<w:del w:id="101" w:author="Bo"><w:r><w:rPr><w:b/></w:rPr><w:delText>Earlier 🙂</w:delText></w:r></w:del>"#,
            r#"<w:ins w:id="102" w:author="Amy"><w:r><w:t>Discard this</w:t></w:r></w:ins>"#,
            r#"<w:del w:id="103" w:author="Bo"><w:r><w:delText>Remove this</w:delText></w:r></w:del>"#,
            r#"<w:ins w:id="104" w:author="Cy"><w:r><w:t>Pending</w:t></w:r></w:ins>"#,
            r#"<w:r><w:rPr><w:i/><w:rPrChange w:id="105" w:author="Cy"><w:rPr><w:b/></w:rPr></w:rPrChange></w:rPr><w:t>Formatting</w:t></w:r></w:p>"#,
            r#"<w:tbl><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r>"#,
            r#"<w:del w:id="106" w:author="Bo"><w:r><delText:delText xmlns:delText="http://schemas.openxmlformats.org/wordprocessingml/2006/main">Restored in cell</delText:delText></w:r></w:del></w:p></w:tc></w:tr></w:tbl>"#,
        );
        let position = xml.rfind("<w:sectPr").unwrap();
        xml.insert_str(position, source_markup);
        package.write_part_xml(BODY, &xml).unwrap();
        package.save_as(source.to_str().unwrap()).unwrap();
        let root = temp.path().join("tracked.hcd");
        import_docx(
            &source,
            &root,
            &ImportOptions::new("tracked-review"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&root).unwrap();
        let pending = read_word_review(&bundle, &source, None).unwrap();
        assert_eq!(pending.tracked.len(), 7);
        assert_eq!(
            pending
                .tracked
                .iter()
                .filter(|item| item.change.is_some())
                .count(),
            6
        );

        let edit_text = |old: &str, new: &str| {
            let projection = editor_projection(&bundle, None).unwrap();
            let node = projection
                .blocks
                .iter()
                .flat_map(|block| &block.content.inlines)
                .find(|inline| inline.text == old)
                .and_then(|inline| inline.node_id.as_ref())
                .unwrap();
            let info = hcd_core::get_text_node(&bundle, node).unwrap();
            let patch = serde_json::from_value(serde_json::json!({
                "schemaVersion": "hcd-patch/1", "documentId": "tracked-review",
                "patchId": format!("typing-{}", projection.revision), "baseRevision": projection.revision,
                "operations": [{
                    "op": "text.splice", "nodeId": node, "start": 0, "deleteCount": old.chars().count(),
                    "insertText": new, "precondition": {"nodeHash": info.node.node_hash}
                }]
            })).unwrap();
            hcd_core::apply_patch(&bundle, &patch, projection.revision).unwrap();
            node.clone()
        };
        let decide = |id, kind, accept| {
            let base = bundle.manifest().unwrap().revision;
            let request = WordReviewEdit {
                base_revision: base,
                patch_id: format!("decision-{id}"),
                action: ReviewAction::Decide {
                    change: TrackedChange { id, kind },
                    accept,
                },
            };
            let receipt = edit_word_review(&bundle, &source, &request, "amy", "Amy").unwrap();
            assert_eq!(receipt.revision, base + 1);
            assert!(
                edit_word_review(&bundle, &source, &request, "amy", "Amy")
                    .unwrap()
                    .idempotent_replay
            );
        };
        let insertion = edit_text("Proposed", "Approved");
        decide(100, Insert, true);
        assert_eq!(
            hcd_core::get_text_node(&bundle, &insertion)
                .unwrap()
                .node
                .text,
            "Approved"
        );
        decide(101, Delete, false);
        let restored = edit_text("Earlier 🙂", "Earlier notes 🙂");
        let rejected = edit_text("Discard this", "Edited before review");
        decide(102, Insert, false);
        assert!(hcd_core::get_text_node(&bundle, &rejected).is_err());
        decide(103, Delete, true);
        decide(106, Delete, false);
        edit_text("Restored in cell", "Confirmed in cell");

        let manifest = bundle.manifest().unwrap();
        project_editor(&bundle, manifest.revision).unwrap();
        let state = editor_projection(&bundle, None).unwrap();
        let table = state
            .blocks
            .iter()
            .find(|block| {
                block
                    .read_only_html
                    .as_ref()
                    .is_some_and(|html| html.contains("Confirmed in cell"))
            })
            .unwrap();
        apply_structure_patch(
            &bundle,
            &StructurePatchBatch {
                schema_version: HCD_PATCH_SCHEMA_VERSION_4.into(),
                document_id: state.document_id,
                patch_id: "table-after-review".into(),
                base_revision: state.revision,
                operations: vec![StructureOperation::TableEdit {
                    block_id: table.block_id.clone(),
                    table_index: 0,
                    action: TableEditAction::InsertRow,
                    index: 1,
                    precondition: BlockPrecondition {
                        block_hash: table.block_hash.clone(),
                    },
                }],
            },
            state.revision,
        )
        .unwrap();

        let projection = editor_projection(&bundle, None).unwrap();
        let restored_view = projection
            .blocks
            .iter()
            .flat_map(|block| &block.content.inlines)
            .find(|inline| inline.node_id.as_deref() == Some(&restored))
            .unwrap();
        assert!(restored_view.bold && restored_view.text == "Earlier notes 🙂");
        assert_eq!(
            read_word_review(&bundle, &source, None)
                .unwrap()
                .tracked
                .len(),
            2
        );
        assert_eq!(
            read_word_review(&bundle, &source, Some(0))
                .unwrap()
                .tracked
                .len(),
            7
        );
        let path = temp.path().join("decided.docx");
        export_docx(&root, &source, &path, &ExportOptions::default()).unwrap();
        let mut archive = StreamingOxmlArchive::open(&path).unwrap();
        let native =
            String::from_utf8(archive.read_control_part(BODY, 2_000_000).unwrap()).unwrap();
        for proof in [
            "Approved",
            "Earlier notes 🙂",
            ">Confirmed in cell</delText:t>",
            "<w:b/>",
            r#"w:id="104""#,
            r#"w:id="105""#,
        ] {
            assert!(native.contains(proof), "{proof}");
        }
        for removed in [
            r#"w:id="100""#,
            r#"w:id="101""#,
            r#"w:id="102""#,
            r#"w:id="103""#,
            r#"w:id="106""#,
            "Edited before review",
            "Remove this",
        ] {
            assert!(!native.contains(removed), "{removed}");
        }
        let again = temp.path().join("again.hcd");
        import_docx(&path, &again, &ImportOptions::new("again"), |_| Ok(())).unwrap();
        let reopened = read_word_review(&Bundle::open(again).unwrap(), &path, None).unwrap();
        assert_eq!(reopened.tracked.len(), 2);
        assert_eq!(reopened.tracked[0].text, "Pending");
        let sheet = parse(&native).unwrap();
        let rows = sheet
            .descendants()
            .find(|node| {
                word(*node, "tbl")
                    && node
                        .descendants()
                        .any(|child| child.text() == Some("Confirmed in cell"))
            })
            .unwrap()
            .children()
            .filter(|child| word(*child, "tr"))
            .count();
        assert_eq!(rows, 2);

        let prior = temp.path().join("history-r0.docx");
        export_docx(
            &root,
            &source,
            &prior,
            &ExportOptions {
                revision: Some(0),
                ..ExportOptions::default()
            },
        )
        .unwrap();
        assert_eq!(pictures::read_body(&prior).unwrap(), xml);

        restore_revision(&bundle, 0, projection.revision).unwrap();
        assert_eq!(
            read_word_review(&bundle, &source, None)
                .unwrap()
                .tracked
                .len(),
            7
        );
        let restored_source = temp.path().join("restored.docx");
        export_docx(&root, &source, &restored_source, &ExportOptions::default()).unwrap();
        let restored_xml = pictures::read_body(&restored_source).unwrap();
        assert!(restored_xml.contains(source_markup));
    }

    #[test]
    fn native_word_thread_tracks_the_quote_and_round_trips_with_history() {
        let sample = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/word/numbering-showcase.docx");
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.docx");
        let mut package = OxmlPackage::open(sample.to_str().unwrap(), true).unwrap();
        let mut xml = package.read_part_xml(BODY).unwrap();
        let after = {
            let document = parse(&xml).unwrap();
            let paragraph = document
                .descendants()
                .find(|node| {
                    word(*node, "p")
                        && native_text(*node, *node).starts_with("Generated by officecli")
                })
                .unwrap();
            paragraph.range().end - "</w:p>".len()
        };
        let pending_changes = r#"<w:del w:id="10" w:author="原审阅者"><w:r><w:delText>Old wording</w:delText></w:r></w:del><w:ins w:id="11" w:author="原审阅者"><w:r><w:t> Pending addition</w:t></w:r></w:ins>"#;
        xml.insert_str(after, pending_changes);
        package.write_part_xml(BODY, &xml).unwrap();
        package.save_as(source.to_str().unwrap()).unwrap();
        let root = temp.path().join("review.hcd");
        import_docx(&source, &root, &ImportOptions::new("word-review"), |_| {
            Ok(())
        })
        .unwrap();
        let bundle = Bundle::open(&root).unwrap();
        let body_root = bundle.manifest().unwrap().root_hash;
        let projection = editor_projection(&bundle, None).unwrap();
        let target = projection
            .blocks
            .iter()
            .find(|block| block_text(block) == "Numbering & List Showcase")
            .unwrap();
        let quote = "List Showcase";
        let create = WordReviewEdit {
            base_revision: 0,
            patch_id: "comment".into(),
            action: ReviewAction::Comment {
                block_id: target.block_id.clone(),
                start: 12,
                end: 25,
                text_hash: hash_bytes(quote.as_bytes()),
                text: "请保留示例名。".into(),
            },
        };
        let r1 = edit_word_review(&bundle, &source, &create, "alice", "审核者甲").unwrap();
        assert_eq!(r1.revision, 1);
        assert_eq!(body_root, r1.root_hash);
        let snapshot = read_word_review(&bundle, &source, None).unwrap();
        assert_eq!(snapshot.comments.len(), 1);
        let id = snapshot.comments[0].id;
        assert_eq!(snapshot.comments[0].location.as_ref().unwrap().start, 12);
        assert_eq!(snapshot.comments[0].author.as_deref(), Some("审核者甲"));
        assert!(read_word_review(&bundle, &source, Some(0))
            .unwrap()
            .comments
            .is_empty());
        assert!(
            edit_word_review(&bundle, &source, &create, "alice", "审核者甲")
                .unwrap()
                .idempotent_replay
        );
        assert!(edit_word_review(&bundle, &source, &create, "bob", "审核者乙").is_err());
        let target_node = target.content.inlines[0].node_id.as_ref().unwrap();
        let node = hcd_core::get_text_node(&bundle, target_node).unwrap();
        let patch: hcd_core::PatchBatch = serde_json::from_value(serde_json::json!({
            "schemaVersion": "hcd-patch/1", "documentId": "word-review", "patchId": "later-edit",
            "baseRevision": 1, "operations": [{
                "op": "text.splice", "nodeId": target_node, "start": 0,
                "deleteCount": 0, "insertText": "新🙂 ",
                "precondition": {"nodeHash": node.node.node_hash}
            }]
        }))
        .unwrap();
        hcd_core::apply_patch(&bundle, &patch, 1).unwrap();
        let reply = WordReviewEdit {
            base_revision: 1,
            patch_id: "reply".into(),
            action: ReviewAction::Reply {
                thread_id: id,
                text: "已确认。".into(),
            },
        };
        assert!(matches!(
            edit_word_review(&bundle, &source, &reply, "bob", "审核者乙"),
            Err(HcdError::RevisionConflict(_))
        ));
        let reply = WordReviewEdit {
            base_revision: 2,
            ..reply
        };
        edit_word_review(&bundle, &source, &reply, "bob", "审核者乙").unwrap();
        edit_word_review(
            &bundle,
            &source,
            &WordReviewEdit {
                base_revision: 3,
                patch_id: "resolve".into(),
                action: ReviewAction::Resolve {
                    thread_id: id,
                    resolved: true,
                },
            },
            "alice",
            "审核者甲",
        )
        .unwrap();
        assert!(
            !read_word_review(&bundle, &source, Some(3))
                .unwrap()
                .comments[0]
                .resolved
        );
        let exported = temp.path().join("reviewed.docx");
        export_docx(&root, &source, &exported, &ExportOptions::default()).unwrap();
        let mut archive = StreamingOxmlArchive::open(&exported).unwrap();
        let mut original = StreamingOxmlArchive::open(&source).unwrap();
        assert_eq!(
            archive
                .read_control_part("word/numbering.xml", 1_000_000)
                .unwrap(),
            original
                .read_control_part("word/numbering.xml", 1_000_000)
                .unwrap()
        );
        let xml = String::from_utf8(archive.read_control_part(BODY, 1_000_000).unwrap()).unwrap();
        assert!(xml.contains(pending_changes));
        let doc = parse(&xml).unwrap();
        let start = doc
            .descendants()
            .find(|node| word(*node, "commentRangeStart"))
            .unwrap();
        let end = doc
            .descendants()
            .find(|node| word(*node, "commentRangeEnd"))
            .unwrap();
        assert_eq!(native_id(start), Some(id));
        assert_eq!(native_id(end), Some(id));
        let range: String = doc
            .descendants()
            .filter(|node| {
                word(*node, "t")
                    && node.range().start > start.range().end
                    && node.range().end <= end.range().start
            })
            .filter_map(|node| node.text())
            .collect();
        assert_eq!(range, quote);
        let new_root = temp.path().join("reopened.hcd");
        import_docx(
            &exported,
            &new_root,
            &ImportOptions::new("reopened"),
            |_| Ok(()),
        )
        .unwrap();
        let reopened =
            read_word_review(&Bundle::open(&new_root).unwrap(), &exported, None).unwrap();
        assert_eq!(reopened.comments.len(), 2);
        assert!(reopened.comments[0].resolved);
        assert_eq!(reopened.comments[0].location.as_ref().unwrap().start, 15);
        assert_eq!(reopened.comments[1].parent_id, Some(id));
        assert_eq!(reopened.comments[1].author.as_deref(), Some("审核者乙"));
    }
}
