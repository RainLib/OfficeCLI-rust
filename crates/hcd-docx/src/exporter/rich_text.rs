//! Splits only the affected source runs, retaining their original properties,
//! paragraph XML and every non-text child exactly once and in source order.
use super::*;

pub(super) fn rewrite(
    source: &mut dyn Read,
    output: impl Write,
    updates: &BTreeMap<u64, TextUpdate>,
) -> Result<(), HcdError> {
    let mut reader = Reader::from_reader(BufReader::new(source));
    reader.config_mut().check_end_names = true;
    let mut writer = Writer::new(output);
    let mut buffer = Vec::new();
    let mut ordinal = 0u64;
    let mut seen = BTreeSet::new();
    let mut run: Vec<Event<'static>> = Vec::new();
    let mut depth = 0usize;
    let mut bytes = 0usize;
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|e| HcdError::InvalidBundle(e.to_string()))?
            .into_owned();
        if depth > 0 {
            if matches!(event, Event::Eof) {
                return Err(HcdError::InvalidBundle(
                    "source XML ends inside an unclosed run".into(),
                ));
            }
            bytes += event.as_ref().len();
            if bytes > 16 * 1024 * 1024 || run.len() >= MAX_RUN_EVENTS {
                return Err(HcdError::ResourceLimit(
                    "Word rich text source run exceeds rewrite budget".into(),
                ));
            }
            if matches!(event, Event::Start(_)) {
                depth += 1;
            }
            if matches!(event, Event::End(_)) {
                depth -= 1;
            }
            run.push(event);
            if depth == 0 {
                flush(
                    &mut writer,
                    std::mem::take(&mut run),
                    updates,
                    &mut ordinal,
                    &mut seen,
                )?;
            }
        } else {
            match &event {
                Event::Start(start) if is_word_run(start.name().as_ref()) => {
                    run.push(event);
                    depth = 1;
                    bytes = 0;
                }
                Event::Start(start) | Event::Empty(start)
                    if local_name(start.name().as_ref()) == "t" =>
                {
                    ordinal += 1;
                    if updates.contains_key(&ordinal) {
                        return Err(HcdError::Unsupported(
                            "Word inline update has no writable source run".into(),
                        ));
                    }
                    writer.write_event(event)?;
                }
                Event::Eof => break,
                _ => writer.write_event(event)?,
            }
        }
        buffer.clear();
    }
    if seen.len() != updates.len() {
        return Err(HcdError::InvalidBundle(
            "source XML is missing mapped text ordinals".into(),
        ));
    }
    Ok(())
}

fn children(events: &[Event<'static>]) -> Result<Vec<std::ops::Range<usize>>, HcdError> {
    let mut result = Vec::new();
    let mut index = 1;
    while index + 1 < events.len() {
        let start = index;
        let mut depth = usize::from(matches!(events[index], Event::Start(_)));
        index += 1;
        while depth > 0 && index < events.len() - 1 {
            if matches!(events[index], Event::Start(_)) {
                depth += 1;
            }
            if matches!(events[index], Event::End(_)) {
                depth -= 1;
            }
            index += 1;
        }
        if depth > 0 {
            return Err(HcdError::InvalidBundle("unclosed Word run child".into()));
        }
        result.push(start..index);
    }
    Ok(result)
}

fn flush<W: Write>(
    writer: &mut Writer<W>,
    events: Vec<Event<'static>>,
    updates: &BTreeMap<u64, TextUpdate>,
    ordinal: &mut u64,
    seen: &mut BTreeSet<u64>,
) -> Result<(), HcdError> {
    let ranges = children(&events)?;
    let base = *ordinal;
    let count = events.iter().filter(|event| matches!(event, Event::Start(start) | Event::Empty(start) if local_name(start.name().as_ref()) == "t")).count() as u64;
    if !(1..=count).any(|offset| updates.contains_key(&(base + offset))) {
        *ordinal += count;
        return write_events(writer, events);
    }
    let properties = ranges.iter().find(|range| matches!(&events[range.start], Event::Start(start) | Event::Empty(start) if start.name().as_ref() == b"w:rPr"));
    let original_properties = properties
        .map(|range| events[range.clone()].to_vec())
        .unwrap_or_default();
    let mut first = true;
    for range in &ranges {
        if properties == Some(range) {
            continue;
        }
        let child = &events[range.clone()];
        let text_start = match &child[0] {
            Event::Start(start) | Event::Empty(start) if start.name().as_ref() == b"w:t" => {
                Some(start)
            }
            _ => None,
        };
        if let Some(start) = text_start {
            *ordinal += 1;
            let update = updates.get(ordinal);
            if let Some(update) = update {
                seen.insert(*ordinal);
                if let Some(runs) = &update.runs {
                    for run in runs {
                        let props = marked_properties(
                            &original_properties,
                            run.bold,
                            run.italic,
                            update.font.as_ref(),
                        )?;
                        write_run(
                            writer,
                            &events[0],
                            props,
                            text_events(start, &run.text),
                            &mut first,
                        )?;
                    }
                } else {
                    let props = font_properties(&original_properties, update.font.as_ref())?;
                    write_run(
                        writer,
                        &events[0],
                        props,
                        text_events(start, &update.text),
                        &mut first,
                    )?;
                }
            } else {
                write_run(
                    writer,
                    &events[0],
                    original_properties.clone(),
                    child.to_vec(),
                    &mut first,
                )?;
            }
        } else {
            if child.iter().all(|event| matches!(event, Event::Text(text) if text.as_ref().iter().all(u8::is_ascii_whitespace))) {
                write_events(writer, child.to_vec())?;
                continue;
            }
            if child.iter().any(|event| matches!(event, Event::Start(start) | Event::Empty(start) if local_name(start.name().as_ref()) == "t")) {
                return Err(HcdError::Unsupported("nested source text cannot be split into Word inline runs".into()));
            }
            write_run(
                writer,
                &events[0],
                original_properties.clone(),
                child.to_vec(),
                &mut first,
            )?;
        }
    }
    Ok(())
}

fn text_events(start: &BytesStart<'_>, text: &str) -> Vec<Event<'static>> {
    vec![
        Event::Start(start_with_space_preservation(start, text)),
        Event::Text(BytesText::new(text).into_owned()),
        Event::End(BytesEnd::new("w:t")),
    ]
}

fn write_run<W: Write>(
    writer: &mut Writer<W>,
    opening: &Event<'static>,
    props: Vec<Event<'static>>,
    content: Vec<Event<'static>>,
    first: &mut bool,
) -> Result<(), HcdError> {
    let Event::Start(start) = opening else {
        return Err(HcdError::InvalidBundle("missing Word run".into()));
    };
    let mut copy = BytesStart::new("w:r");
    for attr in start.attributes() {
        let attr = attr.map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
        if *first || local_name(attr.key.as_ref()) != "textId" {
            copy.push_attribute(attr);
        }
    }
    writer.write_event(Event::Start(copy))?;
    write_events(writer, props)?;
    write_events(writer, content)?;
    writer.write_event(Event::End(BytesEnd::new("w:r")))?;
    *first = false;
    Ok(())
}

fn font_properties(
    original: &[Event<'static>],
    font: Option<&HtmlFontNode>,
) -> Result<Vec<Event<'static>>, HcdError> {
    let mut events = vec![Event::Start(BytesStart::new("w:r"))];
    events.extend_from_slice(original);
    if let Some(font) = font {
        pin_run_fonts(&mut events, "w", font)?;
    }
    events.remove(0);
    Ok(events)
}

fn marked_properties(
    original: &[Event<'static>],
    bold: bool,
    italic: bool,
    font: Option<&HtmlFontNode>,
) -> Result<Vec<Event<'static>>, HcdError> {
    let props = font_properties(original, font)?;
    let opening = match props.first() {
        Some(Event::Start(start) | Event::Empty(start)) => start.clone(),
        _ => BytesStart::new("w:rPr"),
    };
    let mut output = vec![Event::Start(opening)];
    let mut remainder = Vec::new();
    if matches!(props.first(), Some(Event::Start(_))) {
        for range in children(&props)? {
            let child = &props[range];
            if matches!(&child[0], Event::Start(start) | Event::Empty(start) if matches!(start.name().as_ref(), b"w:b" | b"w:bCs" | b"w:i" | b"w:iCs"))
            {
                continue;
            }
            if matches!(&child[0], Event::Start(start) | Event::Empty(start) if matches!(start.name().as_ref(), b"w:rStyle" | b"w:rFonts"))
            {
                output.extend_from_slice(child);
            } else {
                remainder.extend_from_slice(child);
            }
        }
    }
    for (name, value) in [
        ("w:b", bold),
        ("w:bCs", bold),
        ("w:i", italic),
        ("w:iCs", italic),
    ] {
        let mut start = BytesStart::new(name);
        start.push_attribute(("w:val", if value { "1" } else { "0" }));
        output.push(Event::Empty(start));
    }
    output.extend(remainder);
    output.push(Event::End(BytesEnd::new("w:rPr")));
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixed_marks_clone_source_properties_without_duplicating_drawings_breaks_or_run_ids() {
        let source = r#"<w:document xmlns:w="x" xmlns:w14="y"><w:body><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="1200"/></w:pPr><w:r w14:textId="ABCD"><w:rPr><w:b></w:b><w:i/><w:color w:val="2463EB"/><w:sz w:val="68"/></w:rPr><w:t>标题</w:t><w:tab/><w:drawing/><w:t>尾</w:t></w:r><w:r><w:t>other</w:t></w:r></w:p></w:body></w:document>"#;
        let updates = BTreeMap::from([
            (
                1,
                TextUpdate {
                    text: "标题 普通😀".into(),
                    font: Some(HtmlFontNode {
                        latin: Some("Brand".into()),
                        ..Default::default()
                    }),
                    runs: Some(vec![
                        hcd_core::DocxInlineRun {
                            text: "标题".into(),
                            bold: true,
                            italic: false,
                        },
                        hcd_core::DocxInlineRun {
                            text: " 普通😀".into(),
                            bold: false,
                            italic: false,
                        },
                    ]),
                },
            ),
            (
                2,
                TextUpdate {
                    text: "尾改".into(),
                    font: None,
                    runs: None,
                },
            ),
        ]);
        let mut output = Vec::new();
        rewrite(&mut source.as_bytes(), &mut output, &updates).unwrap();
        let xml = String::from_utf8(output).unwrap();
        assert_eq!(xml.matches("w14:textId=\"ABCD\"").count(), 1, "{xml}");
        assert_eq!(xml.matches("<w:drawing/>").count(), 1, "{xml}");
        assert_eq!(xml.matches("<w:tab/>").count(), 1, "{xml}");
        assert_eq!(xml.matches("<w:sz w:val=\"68\"/>").count(), 5, "{xml}");
        assert_eq!(
            xml.matches("<w:color w:val=\"2463EB\"/>").count(),
            5,
            "{xml}"
        );
        assert!(
            xml.contains("<w:pPr><w:jc w:val=\"center\"/><w:spacing w:before=\"1200\"/></w:pPr>")
        );
        assert!(xml.contains("w:b w:val=\"0\""));
        assert!(xml.contains("xml:space=\"preserve\"> 普通😀"));
        assert!(xml.contains("w:ascii=\"Brand\""));
        assert!(xml.contains("<w:r><w:t>other</w:t></w:r>"));
        let mut reader = Reader::from_str(&xml);
        reader.config_mut().check_end_names = true;
        while !matches!(reader.read_event().unwrap(), Event::Eof) {}
    }
}
