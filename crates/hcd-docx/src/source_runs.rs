//! Streaming source rewrite: buffer at most one outer run, preserve its unknown
//! properties and non-text children, and split only where size overrides differ.
use hcd_core::{FontSizeRun, HcdError, MAX_CONTROL_PART_BYTES};
use quick_xml::events::{BytesEnd, BytesStart, BytesText, Event};
use quick_xml::name::ResolveResult;
use quick_xml::{NsReader, Writer};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufReader, Read, Write};

const WORD: &[u8] = b"http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const STRICT_WORD: &[u8] = b"http://purl.oclc.org/ooxml/wordprocessingml/main";

#[derive(Clone)]
enum Child {
    Element(Element),
    Raw(Event<'static>),
}
#[derive(Clone)]
struct Element {
    start: BytesStart<'static>,
    end: Option<BytesEnd<'static>>,
    children: Vec<Child>,
    word: bool,
    ordinal: Option<u64>,
    text_id_attribute: Option<Vec<u8>>,
}

impl Element {
    fn is(&self, name: &[u8]) -> bool {
        self.word && self.start.local_name().as_ref() == name
    }
    fn write(&self, writer: &mut Writer<impl Write>) -> Result<(), HcdError> {
        if let Some(end) = &self.end {
            writer.write_event(Event::Start(self.start.clone()))?;
            for child in &self.children {
                write_child(child, writer)?;
            }
            writer.write_event(Event::End(end.clone()))?;
        } else {
            writer.write_event(Event::Empty(self.start.clone()))?;
        }
        Ok(())
    }
}

fn write_child(child: &Child, writer: &mut Writer<impl Write>) -> Result<(), HcdError> {
    match child {
        Child::Element(element) => element.write(writer),
        Child::Raw(event) => {
            writer.write_event(event.clone())?;
            Ok(())
        }
    }
}

fn text_element(original: &Element, text: &str) -> Element {
    let mut result = original.clone();
    let preserve = text.starts_with(char::is_whitespace) || text.ends_with(char::is_whitespace);
    let attrs: Vec<_> = result
        .start
        .attributes()
        .filter_map(Result::ok)
        .filter(|attribute| !preserve || attribute.key.as_ref() != b"xml:space")
        .map(|attribute| {
            (
                attribute.key.as_ref().to_vec(),
                attribute.value.into_owned(),
            )
        })
        .collect();
    result.start.clear_attributes();
    for (key, value) in attrs {
        result
            .start
            .push_attribute((key.as_slice(), value.as_slice()));
    }
    if preserve {
        result.start.push_attribute(("xml:space", "preserve"));
    }
    result.end = Some(BytesEnd::new(
        String::from_utf8_lossy(result.start.name().as_ref()).into_owned(),
    ));
    result.children = vec![Child::Raw(Event::Text(BytesText::new(text).into_owned()))];
    result
}

fn sized_properties(original: Option<&Element>, size: Option<f32>, namespace: &str) -> Element {
    let mut properties = original.cloned().unwrap_or_else(|| {
        let mut start = BytesStart::new("hcdr:rPr");
        start.push_attribute(("xmlns:hcdr", namespace));
        Element {
            start,
            end: None,
            children: vec![],
            word: true,
            ordinal: None,
            text_id_attribute: None,
        }
    });
    if let Some(size) = size {
        properties.children.retain(|child| !matches!(child, Child::Element(element) if element.is(b"sz") || element.is(b"szCs")));
        let insert = properties.children.iter().position(|child| matches!(child, Child::Element(element) if [b"highlight".as_slice(), b"u", b"effect", b"bdr", b"shd", b"fitText", b"vertAlign", b"rtl", b"cs", b"em", b"lang", b"eastAsianLayout", b"specVanish", b"oMath", b"rPrChange"].iter().any(|name| element.is(name)))).unwrap_or(properties.children.len());
        for (offset, name) in ["sz", "szCs"].iter().enumerate() {
            let mut start = BytesStart::new(format!("hcdr:{name}"));
            start.push_attribute(("xmlns:hcdr", namespace));
            start.push_attribute(("hcdr:val", (size * 2.0).round().to_string().as_str()));
            properties.children.insert(
                insert + offset,
                Child::Element(Element {
                    start,
                    end: None,
                    children: vec![],
                    word: true,
                    ordinal: None,
                    text_id_attribute: None,
                }),
            );
        }
        properties.end = Some(BytesEnd::new(
            String::from_utf8_lossy(properties.start.name().as_ref()).into_owned(),
        ));
    }
    properties
}

fn rewrite_element(
    mut element: Element,
    replacements: &BTreeMap<u64, String>,
    formats: &BTreeMap<u64, Vec<FontSizeRun>>,
    seen: &mut BTreeSet<u64>,
    namespace: &str,
) -> Result<Vec<Element>, HcdError> {
    let is_run = element.is(b"r");
    let mut children = Vec::new();
    let mut changed_direct_text = false;
    for child in element.children {
        match child {
            Child::Element(child)
                if is_run
                    && child.is(b"t")
                    && child
                        .ordinal
                        .is_some_and(|ordinal| replacements.contains_key(&ordinal)) =>
            {
                changed_direct_text = true;
                children.push(Child::Element(child));
            }
            Child::Element(child) => children.extend(
                rewrite_element(child, replacements, formats, seen, namespace)?
                    .into_iter()
                    .map(Child::Element),
            ),
            other => children.push(other),
        }
    }
    element.children = children;
    if !is_run || !changed_direct_text {
        if let Some(ordinal) = element
            .ordinal
            .filter(|ordinal| replacements.contains_key(ordinal))
        {
            if formats.contains_key(&ordinal) {
                return Err(HcdError::Unsupported(
                    "font-size source rewrite requires a direct Word run text child".into(),
                ));
            }
            element = text_element(&element, &replacements[&ordinal]);
            seen.insert(ordinal);
        }
        return Ok(vec![element]);
    }
    let properties: Vec<_> = element
        .children
        .iter()
        .filter_map(|child| match child {
            Child::Element(child) if child.is(b"rPr") => Some(child),
            _ => None,
        })
        .collect();
    if properties.len() > 1 {
        return Err(HcdError::Unsupported(
            "a source run has multiple property blocks".into(),
        ));
    }
    let properties = properties.first().copied().cloned();
    if element.children.iter().any(|child| matches!(child, Child::Element(child) if child.ordinal.is_some_and(|ordinal| formats.contains_key(&ordinal)))) && properties.as_ref().is_some_and(|properties| properties.children.iter().any(|child| matches!(child, Child::Element(child) if child.is(b"rPrChange")))) {
        return Err(HcdError::Unsupported("source font-size splitting with tracked run-property changes needs revision-aware rewriting".into()));
    }
    let mut groups: Vec<(Option<f32>, Vec<Child>)> = vec![];
    fn append(groups: &mut Vec<(Option<f32>, Vec<Child>)>, size: Option<f32>, child: Child) {
        if let Some((_, children)) = groups.last_mut().filter(|(previous, _)| *previous == size) {
            children.push(child);
        } else {
            groups.push((size, vec![child]));
        }
    }
    for child in &element.children {
        if matches!(child, Child::Element(child) if child.is(b"rPr")) {
            continue;
        }
        if let Child::Element(text) = child {
            if text.is(b"t") {
                if let Some(ordinal) = text
                    .ordinal
                    .filter(|ordinal| replacements.contains_key(ordinal))
                {
                    let replacement = &replacements[&ordinal];
                    let inherited = vec![FontSizeRun {
                        chars: replacement.chars().count(),
                        size_pt: None,
                    }];
                    let runs = formats.get(&ordinal).unwrap_or(&inherited);
                    let mut characters = replacement.chars();
                    if runs.is_empty() {
                        append(&mut groups, None, Child::Element(text_element(text, "")));
                    }
                    for run in runs {
                        let part: String = characters.by_ref().take(run.chars).collect();
                        append(
                            &mut groups,
                            run.size_pt,
                            Child::Element(text_element(text, &part)),
                        );
                    }
                    if characters.next().is_some() {
                        return Err(HcdError::InvalidBundle(
                            "source formatting did not cover all text".into(),
                        ));
                    }
                    seen.insert(ordinal);
                    continue;
                }
            }
        }
        // Tabs, breaks, field markers, drawings, and untouched text keep their
        // original formatting and occur exactly once at the original position.
        append(&mut groups, None, child.clone());
    }
    let mut output = Vec::new();
    for (size, children) in groups {
        let mut run = element.clone();
        if !output.is_empty() {
            let attributes: Vec<_> = run
                .start
                .attributes()
                .filter_map(Result::ok)
                .filter(|attribute| {
                    run.text_id_attribute.as_deref() != Some(attribute.key.as_ref())
                })
                .map(|attribute| {
                    (
                        attribute.key.as_ref().to_vec(),
                        attribute.value.into_owned(),
                    )
                })
                .collect();
            run.start.clear_attributes();
            for (key, value) in attributes {
                run.start.push_attribute((key.as_slice(), value.as_slice()));
            }
        }
        run.children = vec![];
        if properties.is_some() || size.is_some() {
            run.children.push(Child::Element(sized_properties(
                properties.as_ref(),
                size,
                namespace,
            )));
        }
        run.children.extend(children);
        output.push(run);
    }
    Ok(output)
}

pub(crate) fn rewrite_formatted_part(
    source: &mut dyn Read,
    output: impl Write,
    replacements: &BTreeMap<u64, String>,
    formats: &BTreeMap<u64, Vec<FontSizeRun>>,
) -> Result<(), HcdError> {
    let mut reader = NsReader::from_reader(BufReader::new(source));
    reader.config_mut().check_end_names = true;
    let mut writer = Writer::new(output);
    let mut buffer = Vec::new();
    let mut stack: Vec<Element> = Vec::new();
    let mut ordinal = 0u64;
    let mut seen = BTreeSet::new();
    let mut bytes = 0usize;
    let mut namespace = String::new();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
        let empty = matches!(&event, Event::Empty(_));
        if !stack.is_empty() {
            bytes += event.as_ref().len();
            if bytes as u64 > MAX_CONTROL_PART_BYTES || stack.len() > 128 {
                return Err(HcdError::ResourceLimit(
                    "source run exceeds rewrite limits".into(),
                ));
            }
        }
        match event {
            Event::Start(start) | Event::Empty(start) => {
                // Use reader's event kind rather than XML prefix spelling.
                let (resolved, _) = reader.resolve_element(start.name());
                let word = matches!(&resolved, ResolveResult::Bound(uri) if uri.as_ref() == WORD || uri.as_ref() == STRICT_WORD);
                let local = start.local_name();
                let text_ordinal = if local.as_ref() == b"t" {
                    ordinal += 1;
                    Some(ordinal)
                } else {
                    None
                };
                let is_run = word && local.as_ref() == b"r";
                if stack.is_empty() && (!is_run || empty) {
                    if text_ordinal.is_some_and(|ordinal| replacements.contains_key(&ordinal)) {
                        return Err(HcdError::Unsupported(
                            "mapped text is outside a Word run".into(),
                        ));
                    }
                    writer.write_event(if empty {
                        Event::Empty(start.into_owned())
                    } else {
                        Event::Start(start.into_owned())
                    })?;
                } else {
                    if stack.is_empty() {
                        bytes = start.len();
                        namespace = match resolved {
                            ResolveResult::Bound(uri) => {
                                String::from_utf8_lossy(uri.as_ref()).into_owned()
                            }
                            _ => String::new(),
                        };
                    }
                    let name = String::from_utf8_lossy(start.name().as_ref()).into_owned();
                    let text_id_attribute = start.attributes().filter_map(Result::ok).find(|attribute| attribute.key.local_name().as_ref() == b"textId" && matches!(reader.resolve_attribute(attribute.key).0, ResolveResult::Bound(uri) if uri.as_ref() == b"http://schemas.microsoft.com/office/word/2010/wordml")).map(|attribute| attribute.key.as_ref().to_vec());
                    let element = Element {
                        start: start.into_owned(),
                        end: if empty {
                            None
                        } else {
                            Some(BytesEnd::new(name))
                        },
                        children: vec![],
                        word,
                        ordinal: text_ordinal,
                        text_id_attribute,
                    };
                    if empty {
                        stack
                            .last_mut()
                            .ok_or_else(|| {
                                HcdError::InvalidBundle("empty outer source run".into())
                            })?
                            .children
                            .push(Child::Element(element));
                    } else {
                        stack.push(element);
                    }
                }
            }
            Event::End(end) if !stack.is_empty() => {
                let element = stack.pop().expect("checked stack");
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(Child::Element(element));
                } else {
                    for rewritten in
                        rewrite_element(element, replacements, formats, &mut seen, &namespace)?
                    {
                        rewritten.write(&mut writer)?;
                    }
                }
                let _ = end;
            }
            Event::Eof => break,
            other => {
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(Child::Raw(other.into_owned()));
                } else {
                    writer.write_event(other)?;
                }
            }
        }
        buffer.clear();
    }
    if !stack.is_empty() || seen.len() != replacements.len() {
        return Err(HcdError::InvalidBundle(
            "source is missing mapped text ordinals".into(),
        ));
    }
    writer.get_mut().flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn size_splits_preserve_unknown_properties_and_nontext_children_once() {
        for namespace in [
            std::str::from_utf8(WORD).unwrap(),
            std::str::from_utf8(STRICT_WORD).unwrap(),
        ] {
            let xml = format!(
                r#"<q:document xmlns:q="{namespace}" xmlns:x="urn:original" xmlns:v="http://schemas.microsoft.com/office/word/2010/wordml"><q:body><q:p><q:pPr><q:keepNext/></q:pPr><q:r x:keep="yes" x:textId="unknown" v:textId="original"><q:rPr><q:rStyle q:val="Custom"/><q:rFonts q:eastAsia="Source CJK"/><q:sz q:val="28"/><q:szCs q:val="32"/><q:spacing q:val="12"/><q:lang q:val="ar-SA"/><x:future x:value="keep"/></q:rPr><q:t xml:space="preserve">A中😀 B</q:t><q:tab/><q:t>after</q:t><q:br/><q:fldChar q:fldCharType="end"/></q:r><q:r/></q:p></q:body></q:document>"#
            );
            let replacements = BTreeMap::from([(1, "A中😀 B".into()), (2, "after!".into())]);
            let formats = BTreeMap::from([(
                1,
                vec![
                    FontSizeRun {
                        chars: 1,
                        size_pt: None,
                    },
                    FontSizeRun {
                        chars: 2,
                        size_pt: Some(28.5),
                    },
                    FontSizeRun {
                        chars: 2,
                        size_pt: None,
                    },
                ],
            )]);
            let mut output = Vec::new();
            rewrite_formatted_part(&mut xml.as_bytes(), &mut output, &replacements, &formats)
                .unwrap();
            let text = String::from_utf8(output).unwrap();
            assert_eq!(text.matches("<q:tab/>").count(), 1);
            assert_eq!(text.matches("<q:br/>").count(), 1);
            assert_eq!(text.matches("<q:fldChar ").count(), 1);
            assert_eq!(text.matches("v:textId=\"original\"").count(), 1);
            assert_eq!(text.matches("x:textId=\"unknown\"").count(), 3);
            assert_eq!(text.matches("<q:rStyle q:val=\"Custom\"/>").count(), 3);
            assert_eq!(text.matches("<q:szCs q:val=\"32\"/>").count(), 2);
            assert_eq!(text.matches("<x:future x:value=\"keep\"/>").count(), 3);
            assert!(text.contains("hcdr:szCs"));
            assert!(text.contains("hcdr:val=\"57\""));
            assert!(text.contains("after!"));
            let mut reader = NsReader::from_str(&text);
            loop {
                match reader.read_event().unwrap() {
                    Event::Start(start) | Event::Empty(start)
                        if start.local_name().as_ref() == b"sz"
                            || start.local_name().as_ref() == b"szCs" =>
                    {
                        assert!(
                            matches!(reader.resolve_element(start.name()).0, ResolveResult::Bound(uri) if uri.as_ref() == namespace.as_bytes())
                        );
                    }
                    Event::Eof => break,
                    _ => {}
                }
            }
        }
    }
}
