//! Native section layout, linked TOC fields and anchored footnotes.
use crate::exporter::review::{body_pairs, insert_inline_reference};
use hcd_core::{
    editor_projection, hash_bytes, office_features::*, Bundle, EditorBlockKind, EditorBlockView,
    HcdError,
};
use oxml::{
    xml_util::{apply_xml_edits, replace_direct_child},
    OxmlPackage, StreamingOxmlArchive,
};
use quick_xml::escape::escape;
use roxmltree::{Document, Node};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    ops::Range,
    path::Path,
};
const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const BODY: &str = "word/document.xml";
const NOTES: &str = "word/footnotes.xml";
fn bad(e: impl std::fmt::Display) -> HcdError {
    HcdError::InvalidBundle(e.to_string())
}
fn parse(xml: &str) -> Result<Document<'_>, HcdError> {
    Document::parse(xml).map_err(bad)
}
fn word(n: Node<'_, '_>, name: &str) -> bool {
    n.has_tag_name((W, name))
}
fn attr<'a>(n: Node<'a, '_>, name: &str) -> Option<&'a str> {
    n.attribute((W, name))
}
fn number(n: Option<Node<'_, '_>>, name: &str, default: u32) -> u32 {
    n.and_then(|n| attr(n, name))
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}
fn plain(n: Node<'_, '_>) -> String {
    n.descendants()
        .filter(|n| word(*n, "t") && !n.ancestors().any(|p| word(p, "del")))
        .filter_map(|n| n.text())
        .collect()
}
fn block_text(b: &EditorBlockView) -> String {
    b.content.inlines.iter().map(|i| i.text.as_str()).collect()
}
fn child<'a, 'b>(n: Node<'a, 'b>, name: &str) -> Option<Node<'a, 'b>> {
    n.children().find(|n| word(*n, name))
}
pub fn source_part(source: &Path, part: &str) -> Result<Option<String>, HcdError> {
    let mut zip = StreamingOxmlArchive::open(source).map_err(bad)?;
    if !zip.contains(part) {
        return Ok(None);
    }
    let bytes = zip.read_control_part(part, 32 * 1024 * 1024).map_err(bad)?;
    String::from_utf8(bytes).map(Some).map_err(bad)
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordSectionView {
    pub index: u32,
    pub layout: WordPageLayout,
    pub block_ids: Vec<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingView {
    pub block_id: String,
    pub level: u8,
    pub text: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FootnoteView {
    pub id: String,
    pub number: usize,
    pub text: String,
    pub anchor: Option<WordAnchor>,
    pub anchor_changed: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordOfficeSnapshot {
    pub sections: Vec<WordSectionView>,
    pub toc: Option<WordToc>,
    pub toc_block_ids: Vec<String>,
    pub headings: Vec<HeadingView>,
    pub footnotes: Vec<FootnoteView>,
}
fn layout(section: Node<'_, '_>) -> WordPageLayout {
    let p = WordPageLayout::default();
    let size = child(section, "pgSz");
    let m = child(section, "pgMar");
    WordPageLayout {
        width_twips: number(size, "w", p.width_twips),
        height_twips: number(size, "h", p.height_twips),
        top_twips: number(m, "top", p.top_twips),
        right_twips: number(m, "right", p.right_twips),
        bottom_twips: number(m, "bottom", p.bottom_twips),
        left_twips: number(m, "left", p.left_twips),
        header_twips: number(m, "header", p.header_twips),
        footer_twips: number(m, "footer", p.footer_twips),
        gutter_twips: number(m, "gutter", 0),
    }
}
fn native_heading_level(paragraph: Node<'_, '_>, styles: Option<&Document<'_>>) -> Option<u8> {
    let properties = child(paragraph, "pPr");
    if let Some(value) = properties
        .and_then(|p| child(p, "outlineLvl"))
        .and_then(|n| attr(n, "val"))
        .and_then(|v| v.parse::<u8>().ok())
    {
        return (value < 9).then_some(value + 1);
    }
    let mut id = properties
        .and_then(|p| child(p, "pStyle"))
        .and_then(|n| attr(n, "val"))
        .unwrap_or_default()
        .to_string();
    let mut seen = HashSet::new();
    while !id.is_empty() && seen.insert(id.clone()) {
        let style = styles.and_then(|d| {
            d.descendants()
                .find(|n| word(*n, "style") && attr(*n, "styleId") == Some(id.as_str()))
        });
        if let Some(level) = style
            .and_then(|s| child(s, "pPr"))
            .and_then(|p| child(p, "outlineLvl"))
            .and_then(|n| attr(n, "val"))
            .and_then(|v| v.parse::<u8>().ok())
        {
            return (level < 9).then_some(level + 1);
        }
        let level = |value: &str| {
            let name = value.to_lowercase().replace(' ', "");
            name.strip_prefix("heading")
                .or_else(|| name.strip_prefix("标题"))
                .and_then(|v| v.parse::<u8>().ok())
                .filter(|v| (1..=9).contains(v))
        };
        if let Some(value) = level(&id).or_else(|| {
            style
                .and_then(|s| child(s, "name"))
                .and_then(|n| attr(n, "val"))
                .and_then(level)
        }) {
            return Some(value);
        }
        id = style
            .and_then(|s| child(s, "basedOn"))
            .and_then(|n| attr(n, "val"))
            .unwrap_or_default()
            .to_string();
    }
    None
}
fn native_sections<'a>(doc: &'a Document<'a>) -> Vec<Node<'a, 'a>> {
    doc.descendants()
        .filter(|n| word(*n, "sectPr") && !n.ancestors().any(|p| word(p, "sectPrChange")))
        .collect()
}
fn toc_ranges(doc: &Document<'_>) -> Vec<Range<usize>> {
    let Some(body) = doc.descendants().find(|n| word(*n, "body")) else {
        return vec![];
    };
    let mut found = vec![];
    let mut active = false;
    let mut depth = 0usize;
    let mut candidate = vec![];
    for p in body.children().filter(|n| n.is_element()) {
        let instruction: String = p
            .descendants()
            .filter(|n| word(*n, "instrText"))
            .filter_map(|n| n.text())
            .collect();
        let simple = p.descendants().any(|n| {
            word(n, "fldSimple")
                && attr(n, "instr").is_some_and(|i| i.trim_start().starts_with("TOC "))
        });
        let tagged = p
            .descendants()
            .any(|n| word(n, "bookmarkStart") && attr(n, "name") == Some("_OfficeCLI_TOC"));
        let style = child(p, "pPr")
            .and_then(|p| child(p, "pStyle"))
            .and_then(|n| attr(n, "val"))
            .unwrap_or_default();
        if simple {
            found.push(p.range());
            continue;
        }
        if instruction.trim_start().starts_with("TOC ") || tagged {
            active = true;
            candidate.clear();
        }
        if active {
            candidate.push(p.range());
            for n in p.descendants().filter(|n| word(*n, "fldChar")) {
                match attr(n, "fldCharType") {
                    Some("begin") => depth += 1,
                    Some("end") => depth = depth.saturating_sub(1),
                    _ => {}
                }
            }
            if depth == 0 && !candidate.is_empty() {
                found.append(&mut candidate);
                active = false;
            }
        } else if style == "OfficeCLITOCHeading" {
            found.push(p.range());
        }
    }
    found
}
fn context(b: &EditorBlockView, offset: usize) -> WordAnchor {
    let text = block_text(b);
    let chars: Vec<_> = text.chars().collect();
    let at = offset.min(chars.len());
    WordAnchor {
        block_id: b.block_id.clone(),
        offset: at,
        paragraph_hash: hash_bytes(text.as_bytes()),
        before: chars[at.saturating_sub(32)..at].iter().collect(),
        after: chars[at..(at + 32).min(chars.len())].iter().collect(),
    }
}
pub fn resolve_anchor(anchor: &WordAnchor, blocks: &[EditorBlockView]) -> Option<WordAnchor> {
    let block = blocks
        .iter()
        .find(|b| b.block_id == anchor.block_id && !b.read_only)?;
    let text = block_text(block);
    if hash_bytes(text.as_bytes()) == anchor.paragraph_hash && anchor.offset <= text.chars().count()
    {
        return Some(context(block, anchor.offset));
    }
    if anchor.offset == 0 {
        return Some(context(block, 0));
    }
    if anchor.after.is_empty() {
        return Some(context(block, text.chars().count()));
    }
    let unique = |needle: &str| -> Option<usize> {
        if needle.is_empty() {
            return None;
        }
        let at = text.find(needle)?;
        let next = at + text[at..].chars().next()?.len_utf8();
        if text[next..].contains(needle) {
            None
        } else {
            Some(at)
        }
    };
    let needle = format!("{}{}", anchor.before, anchor.after);
    let byte_offset = if let Some(at) = unique(&needle) {
        at + anchor.before.len()
    } else {
        let before = unique(&anchor.before).map(|at| at + anchor.before.len());
        let after = unique(&anchor.after);
        match (before, after) {
            (Some(a), Some(b)) if a <= b => a,
            (Some(a), None) => a,
            (None, Some(b)) => b,
            _ => return None,
        }
    };
    Some(context(block, text[..byte_offset].chars().count()))
}

pub fn read_word_features(
    bundle: &Bundle,
    source: &Path,
    state: &OfficeFeatures,
    revision: u64,
) -> Result<WordOfficeSnapshot, HcdError> {
    let xml = source_part(source, BODY)?.ok_or_else(|| bad("Word body is missing"))?;
    let doc = parse(&xml)?;
    let original = editor_projection(bundle, Some(0))?;
    let current = editor_projection(bundle, Some(revision))?;
    let pairs = body_pairs(&doc, &original.blocks);
    let natives = native_sections(&doc);
    let mut sections = vec![];
    for (i, section) in natives.iter().enumerate() {
        let start = if i == 0 {
            0
        } else {
            natives[i - 1].range().end
        };
        let ids = pairs
            .iter()
            .filter(|(p, _)| p.range().start >= start && p.range().start <= section.range().start)
            .map(|(_, b)| b.block_id.clone())
            .collect();
        sections.push(WordSectionView {
            index: i as u32 + 1,
            layout: state
                .word_pages
                .get(&(i as u32 + 1))
                .cloned()
                .unwrap_or_else(|| layout(*section)),
            block_ids: ids,
        });
    }
    if sections.is_empty() {
        sections.push(WordSectionView {
            index: 1,
            layout: state.word_pages.get(&1).cloned().unwrap_or_default(),
            block_ids: current
                .blocks
                .iter()
                .filter(|b| b.region == "body")
                .map(|b| b.block_id.clone())
                .collect(),
        })
    }
    let ranges = toc_ranges(&doc);
    let toc_block_ids: Vec<_> = pairs
        .iter()
        .filter(|(p, _)| ranges.contains(&p.range()))
        .map(|(_, b)| b.block_id.clone())
        .collect();
    let instruction: String = doc
        .descendants()
        .filter(|n| word(*n, "instrText"))
        .filter_map(|n| n.text())
        .find(|s| s.trim_start().starts_with("TOC "))
        .unwrap_or_default()
        .into();
    let bounds: Vec<u8> = instruction
        .split("\\o")
        .nth(1)
        .unwrap_or_default()
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|s| s.parse().ok())
        .take(2)
        .collect();
    let native_toc = (!ranges.is_empty()).then(|| WordToc {
        title: pairs
            .iter()
            .find(|(p, _)| {
                child(*p, "pPr")
                    .and_then(|p| child(p, "pStyle"))
                    .and_then(|n| attr(n, "val"))
                    .is_some_and(|v| v == "OfficeCLITOCHeading" || v == "TOCHeading")
            })
            .map(|(p, _)| plain(*p))
            .unwrap_or_else(|| "目录".into()),
        first_level: bounds.first().copied().unwrap_or(1),
        last_level: bounds.get(1).copied().unwrap_or(3),
    });
    let toc = if state.toc_changed {
        state.toc.clone()
    } else {
        native_toc
    };
    let style_xml = source_part(source, "word/styles.xml")?;
    let style_doc = style_xml.as_deref().map(parse).transpose()?;
    let levels: HashMap<_, _> = pairs
        .iter()
        .filter_map(|(p, b)| {
            native_heading_level(*p, style_doc.as_ref()).map(|level| (b.block_id.as_str(), level))
        })
        .collect();
    let headings = current
        .blocks
        .iter()
        .filter_map(|b| {
            if toc_block_ids.contains(&b.block_id) {
                return None;
            }
            let level = if b.content.kind == EditorBlockKind::Heading {
                b.content.level
            } else {
                levels.get(b.block_id.as_str()).copied()
            }?;
            let text = block_text(b);
            (!text.trim().is_empty()).then(|| HeadingView {
                block_id: b.block_id.clone(),
                level,
                text,
            })
        })
        .collect();
    let referenced: HashSet<_> = doc
        .descendants()
        .filter(|n| word(*n, "footnoteReference"))
        .filter_map(|n| attr(n, "id").and_then(|v| v.parse::<i32>().ok()))
        .collect();
    let mut notes = BTreeMap::new();
    if let Some(note_xml) = source_part(source, NOTES)? {
        for note in parse(&note_xml)?
            .root_element()
            .children()
            .filter(|n| word(*n, "footnote"))
        {
            if let Some(id) = attr(note, "id")
                .and_then(|v| v.parse::<i32>().ok())
                .filter(|v| *v > 0 && referenced.contains(v))
            {
                notes.insert(
                    format!("native:{id}"),
                    WordFootnote {
                        text: Some(
                            note.children()
                                .filter(|n| word(*n, "p"))
                                .map(plain)
                                .collect::<Vec<_>>()
                                .join("\n"),
                        ),
                        anchor: None,
                    },
                );
            }
        }
    }
    for (p, block) in &pairs {
        if !word(*p, "p") {
            continue;
        }
        let mut offset = 0;
        for n in p.descendants() {
            if word(n, "t") && !n.ancestors().any(|a| word(a, "del")) {
                offset += n.text().unwrap_or_default().chars().count();
            }
            if word(n, "footnoteReference") {
                if let Some(id) = attr(n, "id") {
                    if let Some(note) = notes.get_mut(&format!("native:{id}")) {
                        note.anchor = Some(context(block, offset));
                    }
                }
            }
        }
    }
    for (id, note) in &state.footnotes {
        let old = notes.get(id).cloned();
        notes.insert(
            id.clone(),
            WordFootnote {
                text: note.text.clone(),
                anchor: note.anchor.clone().or_else(|| old.and_then(|v| v.anchor)),
            },
        );
    }
    let order: HashMap<_, _> = current
        .blocks
        .iter()
        .enumerate()
        .map(|(i, b)| (b.block_id.as_str(), i))
        .collect();
    let mut footnotes: Vec<_> = notes
        .into_iter()
        .filter_map(|(id, n)| {
            let text = n.text?;
            if n.anchor
                .as_ref()
                .is_some_and(|a| !current.blocks.iter().any(|b| b.block_id == a.block_id))
            {
                return None;
            }
            let anchor = n
                .anchor
                .as_ref()
                .and_then(|a| resolve_anchor(a, &current.blocks));
            let anchor_changed = anchor.is_none();
            Some(FootnoteView {
                id,
                number: 0,
                text,
                anchor,
                anchor_changed,
            })
        })
        .collect();
    footnotes.sort_by_key(|n| {
        n.anchor
            .as_ref()
            .map(|a| {
                (
                    *order.get(a.block_id.as_str()).unwrap_or(&usize::MAX),
                    a.offset,
                )
            })
            .unwrap_or((usize::MAX, 0))
    });
    for (i, n) in footnotes.iter_mut().enumerate() {
        n.number = i + 1;
    }
    Ok(WordOfficeSnapshot {
        sections,
        toc,
        toc_block_ids,
        headings,
        footnotes,
    })
}
fn set_child(
    xml: &str,
    parent: Range<usize>,
    name: &str,
    value: &str,
    order: &[&str],
) -> Result<String, HcdError> {
    replace_direct_child(xml, parent, W, name, value, order).map_err(bad)
}
const SECTIONS: &[&str] = &[
    "headerReference",
    "footerReference",
    "footnotePr",
    "endnotePr",
    "type",
    "pgSz",
    "pgMar",
    "paperSrc",
    "pgBorders",
    "lnNumType",
    "pgNumType",
    "cols",
    "formProt",
    "vAlign",
    "noEndnote",
    "titlePg",
    "textDirection",
    "bidi",
    "rtlGutter",
    "docGrid",
    "printerSettings",
    "sectPrChange",
];
fn apply_pages(mut xml: String, state: &OfficeFeatures) -> Result<String, HcdError> {
    for (index, p) in &state.word_pages {
        for (name, value) in [
            (
                "pgSz",
                format!(
                    r#"<w:pgSz xmlns:w="{W}" w:w="{}" w:h="{}" w:orient="{}"/>"#,
                    p.width_twips,
                    p.height_twips,
                    if p.width_twips > p.height_twips {
                        "landscape"
                    } else {
                        "portrait"
                    }
                ),
            ),
            (
                "pgMar",
                format!(
                    r#"<w:pgMar xmlns:w="{W}" w:top="{}" w:right="{}" w:bottom="{}" w:left="{}" w:header="{}" w:footer="{}" w:gutter="{}"/>"#,
                    p.top_twips,
                    p.right_twips,
                    p.bottom_twips,
                    p.left_twips,
                    p.header_twips,
                    p.footer_twips,
                    p.gutter_twips
                ),
            ),
        ] {
            let doc = parse(&xml)?;
            let sections = native_sections(&doc);
            let section = sections
                .get(*index as usize - 1)
                .ok_or_else(|| {
                    HcdError::PreconditionFailed(
                        "The selected Word section no longer exists".into(),
                    )
                })?
                .range();
            xml = set_child(&xml, section, name, &value, SECTIONS)?;
        }
    }
    Ok(xml)
}
fn ensure_part(
    package: &mut OxmlPackage,
    part: &str,
    content_type: &str,
    relationship: &str,
    target: &str,
) -> Result<(), HcdError> {
    let content = package.read_part_xml("[Content_Types].xml").map_err(bad)?;
    let doc = parse(&content)?;
    let exists = doc.descendants().any(|n| {
        n.is_element()
            && n.tag_name().name() == "Override"
            && n.attribute("PartName") == Some(&format!("/{part}"))
    });
    if !exists {
        let root = doc.root_element();
        let at = root.range().end
            - content[root.range()]
                .rfind("</")
                .map(|i| content[root.range()].len() - i)
                .unwrap_or(0);
        let mut next = content.clone();
        next.insert_str(at,&format!(r#"<Override xmlns="http://schemas.openxmlformats.org/package/2006/content-types" PartName="/{part}" ContentType="{content_type}"/>"#));
        package
            .write_part_xml("[Content_Types].xml", &next)
            .map_err(bad)?;
    }
    let rels = "word/_rels/document.xml.rels";
    let content=package.read_part_xml(rels).unwrap_or_else(|_|r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>"#.into());
    let doc = parse(&content)?;
    if !doc
        .descendants()
        .any(|n| n.is_element() && n.attribute("Type") == Some(relationship))
    {
        let used: HashSet<_> = doc
            .descendants()
            .filter_map(|n| n.attribute("Id"))
            .collect();
        let id = (1..100000)
            .map(|i| format!("rIdOffice{i}"))
            .find(|s| !used.contains(s.as_str()))
            .ok_or_else(|| bad("too many Word relationships"))?;
        let at = content
            .rfind("</")
            .ok_or_else(|| bad("invalid Word relationships"))?;
        let mut next = content;
        next.insert_str(at,&format!(r#"<Relationship xmlns="http://schemas.openxmlformats.org/package/2006/relationships" Id="{id}" Type="{relationship}" Target="{target}"/>"#));
        package.write_part_xml(rels, &next).map_err(bad)?;
    }
    Ok(())
}
fn note_xml(id: i32, text: &str) -> String {
    let mut result = format!(r#"<w:footnote xmlns:w="{W}" w:id="{id}">"#);
    for (i, line) in text.split('\n').enumerate() {
        result.push_str(r#"<w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>"#);
        if i == 0 {
            result.push_str(r#"<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>"#);
        }
        result.push_str(&format!(
            r#"<w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
            escape(line)
        ));
    }
    result.push_str("</w:footnote>");
    result
}
fn apply_notes(
    bundle: &Bundle,
    package: &mut OxmlPackage,
    mut xml: String,
    revision: u64,
    state: &OfficeFeatures,
) -> Result<String, HcdError> {
    if state.footnotes.is_empty() {
        return Ok(xml);
    }
    let projection = editor_projection(bundle, Some(revision))?;
    let mut notes=package.read_part_xml(NOTES).unwrap_or_else(|_|format!(r#"<w:footnotes xmlns:w="{W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote></w:footnotes>"#));
    let mut next_id = parse(&notes)?
        .descendants()
        .filter(|n| word(*n, "footnote"))
        .filter_map(|n| attr(n, "id").and_then(|v| v.parse::<i32>().ok()))
        .max()
        .unwrap_or(0)
        .max(0)
        .checked_add(1)
        .ok_or_else(|| bad("footnote ID limit"))?;
    for (id, note) in &state.footnotes {
        if note
            .anchor
            .as_ref()
            .is_some_and(|a| !projection.blocks.iter().any(|b| b.block_id == a.block_id))
        {
            continue;
        }
        let native = id
            .strip_prefix("native:")
            .and_then(|v| v.parse::<i32>().ok())
            .filter(|v| *v > 0);
        let number = if let Some(id) = native {
            id
        } else {
            let id = next_id;
            next_id = next_id
                .checked_add(1)
                .ok_or_else(|| bad("footnote ID limit"))?;
            id
        };
        let doc = parse(&notes)?;
        let range = doc
            .root_element()
            .children()
            .find(|n| {
                word(*n, "footnote")
                    && attr(*n, "id").and_then(|v| v.parse::<i32>().ok()) == Some(number)
            })
            .map(|n| n.range());
        if let Some(text) = &note.text {
            let markup = note_xml(number, text);
            if let Some(range) = range {
                notes = apply_xml_edits(&notes, vec![(range, markup)]).map_err(bad)?;
            } else {
                let at = notes
                    .rfind("</")
                    .ok_or_else(|| bad("footnote part has no root"))?;
                notes.insert_str(at, &markup);
            }
            if native.is_none() || note.anchor.is_some() {
                if native.is_some() {
                    let doc = parse(&xml)?;
                    let edits = doc
                        .descendants()
                        .filter(|n| {
                            word(*n, "footnoteReference")
                                && attr(*n, "id").and_then(|v| v.parse::<i32>().ok())
                                    == Some(number)
                        })
                        .map(|n| (n.range(), String::new()))
                        .collect();
                    xml = apply_xml_edits(&xml, edits).map_err(bad)?;
                }
                let anchor = note
                    .anchor
                    .as_ref()
                    .and_then(|a| resolve_anchor(a, &projection.blocks))
                    .ok_or_else(|| {
                        HcdError::PreconditionFailed(
                            "The footnote anchor changed; select its location again".into(),
                        )
                    })?;
                let block = projection
                    .blocks
                    .iter()
                    .find(|b| b.block_id == anchor.block_id)
                    .ok_or_else(|| bad("missing footnote block"))?;
                let marker = format!(
                    r#"<w:r xmlns:w="{W}"><w:rPr><w:rStyle w:val="FootnoteReference"/><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="{number}"/></w:r>"#
                );
                xml = insert_inline_reference(
                    &xml,
                    block,
                    &projection.blocks,
                    anchor.offset,
                    &marker,
                )?;
            }
        } else {
            if let Some(range) = range {
                notes = apply_xml_edits(&notes, vec![(range, String::new())]).map_err(bad)?;
            }
            let doc = parse(&xml)?;
            let removals = doc
                .descendants()
                .filter(|n| {
                    word(*n, "footnoteReference")
                        && attr(*n, "id").and_then(|v| v.parse::<i32>().ok()) == Some(number)
                })
                .map(|n| (n.range(), String::new()))
                .collect();
            xml = apply_xml_edits(&xml, removals).map_err(bad)?;
        }
    }
    package.write_part_xml(NOTES, &notes).map_err(bad)?;
    ensure_part(
        package,
        NOTES,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes",
        "footnotes.xml",
    )?;
    Ok(xml)
}
fn apply_toc(
    bundle: &Bundle,
    mut xml: String,
    revision: u64,
    state: &OfficeFeatures,
    styles: Option<&str>,
) -> Result<String, HcdError> {
    if !state.toc_changed {
        return Ok(xml);
    }
    let projection = editor_projection(bundle, Some(revision))?;
    let doc = parse(&xml)?;
    let ranges = toc_ranges(&doc);
    let pairs = body_pairs(&doc, &projection.blocks);
    let mut edits: Vec<_> = ranges.iter().cloned().map(|r| (r, String::new())).collect();
    if let Some(settings) = &state.toc {
        let mut used = doc
            .descendants()
            .filter(|n| word(*n, "bookmarkStart"))
            .filter_map(|n| attr(n, "id").and_then(|v| v.parse::<u32>().ok()))
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| bad("bookmark ID limit"))?;
        let mut entries = vec![];
        let style_doc = styles.map(parse).transpose()?;
        for (node, block) in pairs {
            let level = if block.content.kind == EditorBlockKind::Heading {
                block.content.level
            } else {
                native_heading_level(node, style_doc.as_ref())
            };
            let Some(level) = level else { continue };
            if level < settings.first_level
                || level > settings.last_level
                || ranges.contains(&node.range())
            {
                continue;
            }
            let name = format!(
                "_OfficeCLI_{}",
                &hash_bytes(block.block_id.as_bytes())[..16]
            );
            let old = node
                .descendants()
                .any(|n| word(n, "bookmarkStart") && attr(n, "name") == Some(name.as_str()));
            if !old {
                let at = child(node, "pPr")
                    .map(|n| n.range().end)
                    .unwrap_or_else(|| {
                        node.range().start + xml[node.range()].find('>').unwrap_or(0) + 1
                    });
                edits.push((at..at,format!(r#"<w:bookmarkStart xmlns:w="{W}" w:id="{used}" w:name="{name}"/><w:bookmarkEnd xmlns:w="{W}" w:id="{used}"/>"#)));
                used = used
                    .checked_add(1)
                    .ok_or_else(|| bad("bookmark ID limit"))?;
            }
            entries.push((name, level, block_text(block)));
        }
        let body = doc
            .descendants()
            .find(|n| word(*n, "body"))
            .ok_or_else(|| bad("missing Word body"))?;
        let at = body.range().start + xml[body.range()].find('>').unwrap_or(0) + 1;
        let mut toc = format!(
            r#"<w:p xmlns:w="{W}"><w:pPr><w:pStyle w:val="OfficeCLITOCHeading"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>{}</w:t></w:r></w:p>"#,
            escape(&settings.title)
        );
        let instruction = format!(
            r#" TOC \o "{}-{}" \h \n "{}-{}" "#,
            settings.first_level, settings.last_level, settings.first_level, settings.last_level
        );
        if entries.is_empty() {
            entries.push((
                String::new(),
                settings.first_level,
                "请在正文中设置标题后更新目录".into(),
            ));
        }
        for (i, (name, level, label)) in entries.iter().enumerate() {
            toc.push_str(&format!(r#"<w:p xmlns:w="{W}"><w:pPr><w:pStyle w:val="TOC{level}"/><w:ind w:left="{}"/></w:pPr>"#,u32::from(level-settings.first_level)*360));
            if i == 0 {
                toc.push_str(&format!(r#"<w:bookmarkStart w:id="{used}" w:name="_OfficeCLI_TOC"/><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve">{}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>"#,escape(&instruction)));
            }
            toc.push_str(&format!(r#"<w:hyperlink w:anchor="{name}" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>{}</w:t></w:r></w:hyperlink>"#,escape(label)));
            if i + 1 == entries.len() {
                toc.push_str(&format!(
                    r#"<w:r><w:fldChar w:fldCharType="end"/></w:r><w:bookmarkEnd w:id="{used}"/>"#
                ));
            }
            toc.push_str("</w:p>");
        }
        edits.push((at..at, toc));
    }
    // A TOC replacement may begin exactly where an old cached field starts.
    edits.sort_by_key(|(r, _)| (r.start, r.end));
    xml = apply_xml_edits(&xml, edits).map_err(bad)?;
    Ok(xml)
}
fn managed_toc(xml: &str) -> Result<Option<WordToc>, HcdError> {
    if !xml.contains("_OfficeCLI_TOC") {
        return Ok(None);
    }
    let doc = parse(xml)?;
    let instruction = doc
        .descendants()
        .filter(|n| word(*n, "instrText"))
        .filter_map(|n| n.text())
        .find(|s| s.trim_start().starts_with("TOC "))
        .unwrap_or_default();
    let levels: Vec<u8> = instruction
        .split("\\o")
        .nth(1)
        .unwrap_or_default()
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|v| v.parse().ok())
        .take(2)
        .collect();
    let title = doc
        .descendants()
        .find(|n| {
            word(*n, "p")
                && child(*n, "pPr")
                    .and_then(|p| child(p, "pStyle"))
                    .and_then(|n| attr(n, "val"))
                    == Some("OfficeCLITOCHeading")
        })
        .map(plain)
        .unwrap_or_else(|| "目录".into());
    Ok(Some(WordToc {
        title,
        first_level: levels.first().copied().unwrap_or(1),
        last_level: levels.get(1).copied().unwrap_or(3),
    }))
}
pub fn apply_word_features(
    bundle: &Bundle,
    package: &mut OxmlPackage,
    revision: u64,
    state: &OfficeFeatures,
) -> Result<(), HcdError> {
    let xml = package.read_part_xml(BODY).map_err(bad)?;
    let mut state = state.clone();
    if !state.toc_changed {
        if let Some(toc) = managed_toc(&xml)? {
            state.toc_changed = true;
            state.toc = Some(toc);
        }
    }
    let state = &state;
    if state.word_pages.is_empty() && !state.toc_changed && state.footnotes.is_empty() {
        return Ok(());
    }
    let xml = apply_pages(xml, state)?;
    let xml = apply_notes(bundle, package, xml, revision, state)?;
    let styles = package.read_part_xml("word/styles.xml").ok();
    let xml = apply_toc(bundle, xml, revision, state, styles.as_deref())?;
    package.write_part_xml(BODY, &xml).map_err(bad)?;
    Ok(())
}
