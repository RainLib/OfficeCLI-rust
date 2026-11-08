//! Restricted streaming removal of verified section references. Caller writes
//! into disposable staging; output must be discarded on any error.
use hcd_core::{FlowStoryKind, FlowStoryVariant, HcdError, WORD_MAIN_NS, WORD_STRICT_NS};
use quick_xml::{
    events::{BytesStart, Event},
    name::ResolveResult,
    NsReader, Writer,
};
use std::{
    collections::{BTreeMap, HashSet},
    io::{BufRead, BufReader, Read, Write},
};

const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const STRICT_REL: &str = "http://purl.oclc.org/ooxml/officeDocument/relationships";
const MAX_DOCUMENT_XML_BYTES: u64 = 256 * 1024 * 1024;
const MAX_XML_EVENTS: usize = 3_000_000;
const MAX_XML_DEPTH: usize = 256;

struct BoundedRead<R> {
    inner: R,
    remaining: u64,
}
impl<R: Read> Read for BoundedRead<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let limit = buffer.len().min(self.remaining.saturating_add(1) as usize);
        let count = self.inner.read(&mut buffer[..limit])?;
        if count as u64 > self.remaining {
            return Err(std::io::Error::other("Word source XML exceeds byte limit"));
        }
        self.remaining -= count as u64;
        Ok(count)
    }
}
#[derive(Debug, Clone)]
pub struct SourceStoryReferenceRemoval {
    pub section: usize,
    pub kind: FlowStoryKind,
    pub variant: FlowStoryVariant,
    pub relationship_id: String,
}

/// Resolve a single link change against an independently captured source
/// archive. This validates layout and relationship identity only; callers
/// must also verify source hash, revision history and unchanged content.
pub fn plan_source_story_link_reference(
    archive: &mut oxml::StreamingOxmlArchive,
    document_id: &str,
    before: &hcd_core::FlowDocumentLayout,
    after: &hcd_core::FlowDocumentLayout,
) -> Result<SourceStoryReferenceRemoval, HcdError> {
    let source_layout = crate::flow_layout::load_flow_layout(archive, document_id)?;
    let relationships = crate::flow_layout::relationships(archive)?;
    plan_source_story_link_reference_from_base(
        &relationships,
        &source_layout,
        before,
        before,
        after,
    )
}

/// Resolve a later link against the original source layout. The caller must
/// validate every preceding transition from that base separately.
pub(crate) fn plan_source_story_link_reference_from_base(
    relationships: &BTreeMap<String, (FlowStoryKind, String)>,
    source_layout: &hcd_core::FlowDocumentLayout,
    baseline: &hcd_core::FlowDocumentLayout,
    before: &hcd_core::FlowDocumentLayout,
    after: &hcd_core::FlowDocumentLayout,
) -> Result<SourceStoryReferenceRemoval, HcdError> {
    hcd_core::validate_flow_story_link_transition(before, after)?;
    let mut normalized = baseline.clone();
    normalized.schema_version = hcd_core::FLOW_LAYOUT_SCHEMA.into();
    for section in &mut normalized.sections {
        section.canonical_end_block_id = None;
    }
    if &normalized != source_layout {
        return Err(bad("source layout does not match the transaction base"));
    }
    for (index, (old, new)) in before.sections.iter().zip(&after.sections).enumerate() {
        for kind in [FlowStoryKind::Header, FlowStoryKind::Footer] {
            let (a, b) = match kind {
                FlowStoryKind::Header => (&old.headers, &new.headers),
                FlowStoryKind::Footer => (&old.footers, &new.footers),
            };
            for variant in [
                FlowStoryVariant::Default,
                FlowStoryVariant::First,
                FlowStoryVariant::Even,
            ] {
                if a.get(variant) == b.get(variant) {
                    continue;
                }
                let story_id = a
                    .get(variant)
                    .ok_or_else(|| bad("missing original story"))?;
                let original = baseline
                    .sections
                    .get(index)
                    .ok_or_else(|| bad("missing source section"))?;
                let original_bindings = match kind {
                    FlowStoryKind::Header => &original.headers,
                    FlowStoryKind::Footer => &original.footers,
                };
                if original.id != old.id || original_bindings.get(variant) != Some(story_id) {
                    return Err(bad("story binding does not match the original source"));
                }
                let story = before
                    .stories
                    .iter()
                    .find(|story| story.id == story_id && story.kind == kind)
                    .ok_or_else(|| bad("unknown original story"))?;
                let xml = old
                    .source
                    .original_properties_xml
                    .as_deref()
                    .ok_or_else(|| bad("missing original section properties"))?;
                let doc = roxmltree::Document::parse(xml)
                    .map_err(|_| bad("invalid original section properties"))?;
                let root = doc.root_element();
                let expected_name = if kind == FlowStoryKind::Header {
                    "headerReference"
                } else {
                    "footerReference"
                };
                let expected_variant = match variant {
                    FlowStoryVariant::Default => "default",
                    FlowStoryVariant::First => "first",
                    FlowStoryVariant::Even => "even",
                };
                let mut references = root.children().filter(|node| {
                    node.is_element()
                        && node.tag_name().name() == expected_name
                        && matches!(
                            node.tag_name().namespace(),
                            Some(WORD_MAIN_NS | WORD_STRICT_NS)
                        )
                        && node.attribute((node.tag_name().namespace().unwrap(), "type"))
                            == Some(expected_variant)
                });
                let node = references
                    .next()
                    .ok_or_else(|| bad("source reference missing"))?;
                if references.next().is_some() {
                    return Err(bad("duplicate source reference"));
                }
                let relationship_id = node
                    .attribute((REL, "id"))
                    .or_else(|| node.attribute((STRICT_REL, "id")))
                    .ok_or_else(|| bad("source relationship missing"))?;
                if relationships.get(relationship_id) != Some(&(kind, story.source_part.clone())) {
                    return Err(bad("source relationship does not match story"));
                }
                return Ok(SourceStoryReferenceRemoval {
                    section: index,
                    kind,
                    variant,
                    relationship_id: relationship_id.to_string(),
                });
            }
        }
    }
    Err(bad("no source link change"))
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Element {
    Document,
    Body,
    Paragraph,
    Properties,
    Section,
    Change,
    Other,
}
fn bad(reason: &str) -> HcdError {
    HcdError::InvalidBundle(format!("Word source story link: {reason}"))
}
fn is_word(ns: ResolveResult<'_>) -> bool {
    matches!(ns,ResolveResult::Bound(uri) if uri.as_ref()==WORD_MAIN_NS.as_bytes()||uri.as_ref()==WORD_STRICT_NS.as_bytes())
}
fn attributes<B: BufRead>(
    reader: &NsReader<B>,
    element: &BytesStart<'_>,
) -> Result<(Option<String>, Option<String>, bool), HcdError> {
    let mut kind = None;
    let mut id = None;
    let mut opaque = false;
    for item in element.attributes() {
        let item = item.map_err(|_| bad("invalid reference attribute"))?;
        let (ns, local) = reader.resolve_attribute(item.key);
        let target = if local.as_ref() == b"type" && is_word(ns.clone()) {
            Some(&mut kind)
        } else if local.as_ref() == b"id"
            && matches!(ns,ResolveResult::Bound(uri) if uri.as_ref()==REL.as_bytes()||uri.as_ref()==STRICT_REL.as_bytes())
        {
            Some(&mut id)
        } else {
            if item.key.as_ref() != b"xmlns" && !item.key.as_ref().starts_with(b"xmlns:") {
                opaque = true;
            }
            None
        };
        if let Some(slot) = target {
            if slot.is_some() {
                return Err(bad("duplicate reference attribute"));
            }
            *slot = Some(
                item.unescape_value()
                    .map_err(|_| bad("invalid reference attribute value"))?
                    .into_owned(),
            )
        }
    }
    Ok((kind, id, opaque))
}
/// Remove exact, preverified direct references from source document.xml.
/// `section_count` and every relationship ID must come from an independently
/// verified source layout, not from user input. Unsupported section placement,
/// missing, duplicate or changed targets fail; only self-closing references are
/// supported. Other source parts are not read or rewritten by this function.
pub fn rewrite_story_link_references(
    source: impl Read,
    output: impl Write,
    section_count: usize,
    removals: &[SourceStoryReferenceRemoval],
) -> Result<(), HcdError> {
    if section_count == 0 || section_count > 4096 || removals.is_empty() || removals.len() > 4096 {
        return Err(bad("invalid section or removal count"));
    }
    let mut unique = HashSet::new();
    for edit in removals {
        if edit.section >= section_count
            || edit.relationship_id.is_empty()
            || edit.relationship_id.len() > 256
            || !unique.insert((edit.section, format!("{:?}:{:?}", edit.kind, edit.variant)))
        {
            return Err(bad("invalid or duplicate removal"));
        }
    }
    let mut reader = NsReader::from_reader(BufReader::new(BoundedRead {
        inner: source,
        remaining: MAX_DOCUMENT_XML_BYTES,
    }));
    reader.config_mut().check_end_names = true;
    let mut writer = Writer::new(output);
    let mut stack = Vec::new();
    let mut buffer = Vec::new();
    let mut sections = 0usize;
    let mut active: Option<(usize, usize)> = None;
    let mut seen = vec![false; removals.len()];
    let mut events = 0usize;
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|_| bad("invalid document XML"))?;
        events = events
            .checked_add(1)
            .ok_or_else(|| bad("XML event limit exceeded"))?;
        if events > MAX_XML_EVENTS {
            return Err(bad("XML event limit exceeded"));
        }
        let mut suppress = false;
        match &event {
            Event::Start(e) | Event::Empty(e) => {
                let empty = matches!(&event, Event::Empty(_));
                let (ns, local) = reader.resolve_element(e.name());
                let isword = is_word(ns);
                let name = local.as_ref();
                let element = if !isword {
                    Element::Other
                } else {
                    match name {
                        b"document" => Element::Document,
                        b"body" => Element::Body,
                        b"p" => Element::Paragraph,
                        b"pPr" => Element::Properties,
                        b"sectPr" => Element::Section,
                        b"sectPrChange" | b"pPrChange" => Element::Change,
                        _ => Element::Other,
                    }
                };
                if element == Element::Section && !stack.contains(&Element::Change) {
                    if stack.as_slice() != [Element::Document, Element::Body]
                        && stack.as_slice()
                            != [
                                Element::Document,
                                Element::Body,
                                Element::Paragraph,
                                Element::Properties,
                            ]
                    {
                        return Err(bad("unsupported section placement"));
                    }
                    if sections >= section_count {
                        return Err(bad("source has unexpected sections"));
                    }
                    let index = sections;
                    sections += 1;
                    if !empty {
                        active = Some((index, stack.len()))
                    }
                }
                if isword && (name == b"headerReference" || name == b"footerReference") {
                    if let Some((index, _depth)) =
                        active.filter(|(_, depth)| stack.len() == depth + 1)
                    {
                        let (variant, id, opaque) = attributes(&reader, e)?;
                        let kind = if name == b"headerReference" {
                            FlowStoryKind::Header
                        } else {
                            FlowStoryKind::Footer
                        };
                        for (i, edit) in removals
                            .iter()
                            .enumerate()
                            .filter(|(_, edit)| edit.section == index && edit.kind == kind)
                        {
                            let expected = match edit.variant {
                                FlowStoryVariant::Default => "default",
                                FlowStoryVariant::First => "first",
                                FlowStoryVariant::Even => "even",
                            };
                            if variant.as_deref() == Some(expected) {
                                if seen[i]
                                    || opaque
                                    || !empty
                                    || id.as_deref() != Some(edit.relationship_id.as_str())
                                {
                                    return Err(bad(
                                        "reference changed, duplicated or unsupported",
                                    ));
                                }
                                seen[i] = true;
                                suppress = true
                            }
                        }
                    }
                }
                if !empty {
                    if stack.len() >= MAX_XML_DEPTH {
                        return Err(bad("XML nesting limit exceeded"));
                    }
                    stack.push(element)
                }
            }
            Event::End(_) => {
                let element = stack.pop().ok_or_else(|| bad("invalid XML nesting"))?;
                if element == Element::Section
                    && active.is_some_and(|(_, depth)| depth == stack.len())
                {
                    active = None
                }
            }
            Event::DocType(_) => return Err(bad("document type is not supported")),
            Event::Eof => {
                if !stack.is_empty()
                    || sections != section_count
                    || seen.iter().any(|value| !*value)
                {
                    return Err(bad("section or reference missing"));
                }
                break;
            }
            _ => {}
        }
        if !suppress {
            writer.write_event(event).map_err(HcdError::from)?
        }
        buffer.clear();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn xml() -> String {
        format!(
            r#"<w:document xmlns:w="{WORD_MAIN_NS}" xmlns:r="{REL}"><w:body><w:p><w:pPr><w:sectPr><w:headerReference w:type="even" r:id="old"/><w:sectPrChange><w:sectPr><w:headerReference w:type="even" r:id="historic"/></w:sectPr></w:sectPrChange></w:sectPr></w:pPr></w:p><w:sectPr><w:headerReference w:type="default" r:id="keep"/><w:headerReference w:type="even" r:id="target"/><w:footerReference w:type="even" r:id="foot"/></w:sectPr></w:body></w:document>"#
        )
    }
    fn edit() -> SourceStoryReferenceRemoval {
        SourceStoryReferenceRemoval {
            section: 1,
            kind: FlowStoryKind::Header,
            variant: FlowStoryVariant::Even,
            relationship_id: "target".into(),
        }
    }
    #[test]
    fn removes_only_exact_reference_and_preserves_history() {
        let input = xml();
        let mut out = Vec::new();
        rewrite_story_link_references(input.as_bytes(), &mut out, 2, &[edit()]).unwrap();
        let out = String::from_utf8(out).unwrap();
        assert!(!out.contains("r:id=\"target\""));
        for id in ["old", "historic", "keep", "foot"] {
            assert!(out.contains(&format!("r:id=\"{id}\"")))
        }
        assert!(roxmltree::Document::parse(&out).is_ok())
    }
    #[test]
    fn rejects_changed_missing_and_ambiguous_references() {
        let input = xml();
        let mut wrong = edit();
        wrong.relationship_id = "wrong".into();
        assert!(rewrite_story_link_references(input.as_bytes(), Vec::new(), 2, &[wrong]).is_err());
        assert!(rewrite_story_link_references(input.as_bytes(), Vec::new(), 3, &[edit()]).is_err());
        let duplicate = input.replace(
            "<w:footerReference",
            "<w:headerReference w:type=\"even\" r:id=\"target\"/><w:footerReference",
        );
        assert!(
            rewrite_story_link_references(duplicate.as_bytes(), Vec::new(), 2, &[edit()]).is_err()
        );
        assert!(
            rewrite_story_link_references(input.as_bytes(), Vec::new(), 2, &[edit(), edit()])
                .is_err()
        )
    }
    #[test]
    fn rejects_unsupported_nested_sections() {
        let input = xml()
            .replace("<w:p><w:pPr>", "<w:sdt><w:p><w:pPr>")
            .replace("</w:pPr></w:p>", "</w:pPr></w:p></w:sdt>");
        assert!(rewrite_story_link_references(input.as_bytes(), Vec::new(), 2, &[edit()]).is_err())
    }

    #[test]
    fn accepts_alternate_word_prefix_and_refuses_opaque_target_attributes() {
        let renamed = xml().replace("xmlns:w=", "xmlns:q=").replace("w:", "q:");
        let mut output = Vec::new();
        rewrite_story_link_references(renamed.as_bytes(), &mut output, 2, &[edit()]).unwrap();
        let output = String::from_utf8(output).unwrap();
        assert!(!output.contains("r:id=\"target\""));
        assert!(output.contains("r:id=\"historic\""));
        let strict = xml()
            .replace(WORD_MAIN_NS, WORD_STRICT_NS)
            .replace(REL, STRICT_REL);
        let mut strict_output = Vec::new();
        rewrite_story_link_references(strict.as_bytes(), &mut strict_output, 2, &[edit()]).unwrap();
        assert!(!String::from_utf8(strict_output)
            .unwrap()
            .contains("r:id=\"target\""));
        let opaque = xml().replace("r:id=\"target\"/>", "r:id=\"target\" custom=\"retained\"/>");
        assert!(
            rewrite_story_link_references(opaque.as_bytes(), Vec::new(), 2, &[edit()]).is_err()
        );
        let nonempty = xml().replace("r:id=\"target\"/>", "r:id=\"target\"></w:headerReference>");
        assert!(
            rewrite_story_link_references(nonempty.as_bytes(), Vec::new(), 2, &[edit()]).is_err()
        );
    }

    #[test]
    fn source_fixture_changes_only_the_selected_reference_bytes() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-regions-2026-10-26/image-source.docx");
        let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
        let mut original = String::new();
        archive
            .by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut original)
            .unwrap();
        let target = "<w:headerReference w:type=\"even\" r:id=\"he\"/>";
        assert_eq!(original.matches(target).count(), 1);
        let mut request = edit();
        request.relationship_id = "he".into();
        let mut result = Vec::new();
        rewrite_story_link_references(original.as_bytes(), &mut result, 2, &[request]).unwrap();
        assert_eq!(
            String::from_utf8(result).unwrap(),
            original.replacen(target, "", 1)
        );
    }

    #[test]
    fn source_plan_checks_layout_and_resolves_relationship_from_archive() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-regions-2026-10-26/image-source.docx");
        let mut archive = oxml::StreamingOxmlArchive::open(path).unwrap();
        let mut before = crate::flow_layout::load_flow_layout(&mut archive, "doc").unwrap();
        before.schema_version = hcd_core::FLOW_REGION_LAYOUT_SCHEMA.into();
        before.sections[0].canonical_end_block_id = Some(format!("n_{:032x}", 123));
        let request = hcd_core::FlowStoryLinkRequest {
            base_layout_hash: hcd_core::flow_layout_hash(&before).unwrap(),
            section_id: before.sections[1].id.clone(),
            kind: FlowStoryKind::Header,
            variant: FlowStoryVariant::Even,
            expected_direct_story_id: before.sections[1].headers.even.clone().unwrap(),
        };
        let after = hcd_core::plan_flow_story_link(&before, &request)
            .unwrap()
            .layout;
        let removal =
            plan_source_story_link_reference(&mut archive, "doc", &before, &after).unwrap();
        assert_eq!(removal.section, 1);
        assert_eq!(removal.relationship_id, "he");
        let mut changed = before.clone();
        changed.sections[0].page.width_twips = Some(9999);
        let mut changed_request = request;
        changed_request.base_layout_hash = hcd_core::flow_layout_hash(&changed).unwrap();
        let changed_after = hcd_core::plan_flow_story_link(&changed, &changed_request)
            .unwrap()
            .layout;
        assert!(
            plan_source_story_link_reference(&mut archive, "doc", &changed, &changed_after)
                .is_err()
        );
        let mut forged_after = after.clone();
        forged_after.sections[0].page.width_twips = Some(9999);
        assert!(
            plan_source_story_link_reference(&mut archive, "doc", &before, &forged_after).is_err()
        );
    }

    #[test]
    fn bounded_reader_rejects_extra_bytes() {
        let mut exact = BoundedRead {
            inner: &b"ab"[..],
            remaining: 2,
        };
        let mut bytes = Vec::new();
        exact.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"ab");
        let mut oversized = BoundedRead {
            inner: &b"abc"[..],
            remaining: 2,
        };
        assert!(oversized.read_to_end(&mut Vec::new()).is_err());
    }
}
