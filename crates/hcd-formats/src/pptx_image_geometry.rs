//! Bounded source-slide picture geometry rewriting. This does not authorize an
//! export: callers must first verify the source, revision and picture identity.
use hcd_core::HcdError;
use quick_xml::{
    events::{BytesStart, Event},
    Reader, Writer,
};
use std::io::Read;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourcePictureGeometry {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

/// Change one picture's embedded relationship after the ordinary source
/// identity checks. The caller must create and validate the new relationship
/// and media part and ensure that the new ID is unique in the slide.
pub fn rewrite_checked_source_picture_with_relationship(
    source: impl Read,
    picture_id: &str,
    old_relationship: &str,
    new_relationship: &str,
    expected: SourcePictureGeometry,
    geometry: SourcePictureGeometry,
) -> Result<Vec<u8>, HcdError> {
    let mut chars = new_relationship.bytes();
    if !chars
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        || !chars.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    {
        return Err(HcdError::InvalidPatch(
            "invalid PPTX relationship ID".into(),
        ));
    }
    let candidate = rewrite_checked_source_picture_geometry(
        source,
        picture_id,
        old_relationship,
        expected,
        geometry,
    )?;
    let mut reader = Reader::from_reader(candidate.as_slice());
    reader.config_mut().check_end_names = true;
    let mut buffer = Vec::new();
    let mut stack: Vec<Vec<u8>> = Vec::new();
    let mut selected = false;
    let mut picture_depth = None;
    let mut blip = None;
    let mut target = None;
    let mut events = Vec::new();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|e| HcdError::InvalidBundle(format!("slide XML: {e}")))?
            .into_owned();
        match &event {
            Event::Start(node) | Event::Empty(node) => {
                let empty = matches!(&event, Event::Empty(_));
                let name = node.name().as_ref().to_vec();
                if name == b"p:pic" && !empty {
                    picture_depth = Some(stack.len());
                    selected = false;
                    blip = None;
                }
                if let Some(depth) = picture_depth {
                    let relative = &stack[depth..];
                    if name == b"p:cNvPr"
                        && relative
                            .iter()
                            .map(Vec::as_slice)
                            .eq([b"p:pic".as_slice(), b"p:nvPicPr".as_slice()])
                        && attribute_value(node, b"id")?.as_deref() == Some(picture_id.as_bytes())
                    {
                        selected = true;
                    }
                    if name == b"a:blip"
                        && relative
                            .iter()
                            .map(Vec::as_slice)
                            .eq([b"p:pic".as_slice(), b"p:blipFill".as_slice()])
                    {
                        if blip.replace(events.len()).is_some() {
                            return Err(HcdError::Unsupported("multiple picture blips".into()));
                        }
                    }
                }
                if !empty {
                    stack.push(name);
                }
            }
            Event::End(node) => {
                if node.name().as_ref() == b"p:pic" {
                    if selected {
                        target = blip;
                    }
                    picture_depth = None;
                }
                stack.pop();
            }
            Event::Eof => {
                events.push(event);
                break;
            }
            _ => {}
        }
        events.push(event);
        buffer.clear();
    }
    let target = target.ok_or_else(|| HcdError::Unsupported("picture blip missing".into()))?;
    let mut writer = Writer::new(Vec::new());
    for (index, event) in events.into_iter().enumerate() {
        if index != target {
            writer.write_event(event)?;
            continue;
        }
        let (old, empty) = match event {
            Event::Empty(node) => (node, true),
            Event::Start(node) => (node, false),
            _ => return Err(HcdError::InvalidBundle("invalid picture blip".into())),
        };
        let name = String::from_utf8(old.name().as_ref().to_vec())
            .map_err(|_| HcdError::InvalidBundle("invalid blip name".into()))?;
        let mut new = BytesStart::new(name);
        let mut replaced = false;
        for attr in old.attributes().with_checks(true) {
            let attr = attr.map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
            if attr.key.as_ref() == b"r:embed" {
                if attr.value.as_ref() != old_relationship.as_bytes() {
                    return Err(HcdError::SourceMismatch(
                        "picture relationship changed".into(),
                    ));
                }
                new.push_attribute((attr.key.as_ref(), new_relationship.as_bytes()));
                replaced = true;
            } else {
                new.push_attribute((attr.key.as_ref(), attr.value.as_ref()));
            }
        }
        if !replaced {
            return Err(HcdError::Unsupported(
                "picture embedded relationship missing".into(),
            ));
        }
        writer.write_event(if empty {
            Event::Empty(new.into_owned())
        } else {
            Event::Start(new.into_owned())
        })?;
    }
    Ok(writer.into_inner())
}

/// Verify the imported source identity and original geometry before proposing
/// a rewrite. This verifies only the slide XML, not the relationship target,
/// asset hash, revision, or source archive; callers must verify those too.
pub fn rewrite_checked_source_picture_geometry(
    mut source: impl Read,
    picture_id: &str,
    relationship_id: &str,
    expected: SourcePictureGeometry,
    geometry: SourcePictureGeometry,
) -> Result<Vec<u8>, HcdError> {
    const LIMIT: u64 = 32 * 1024 * 1024;
    let mut bytes = Vec::new();
    source.by_ref().take(LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LIMIT {
        return Err(HcdError::ResourceLimit(
            "slide XML exceeds geometry rewrite limit".into(),
        ));
    }
    // First apply all structural and namespace checks. The result remains a
    // private candidate until the source identity checks below also pass.
    let candidate = rewrite_source_picture_geometry(bytes.as_slice(), picture_id, geometry)?;
    let mut reader = Reader::from_reader(bytes.as_slice());
    let mut buffer = Vec::new();
    let mut stack: Vec<Vec<u8>> = Vec::new();
    let mut ids = 0usize;
    let mut in_picture = false;
    let mut selected = false;
    let mut relationship = None;
    let mut relationship_count = 0;
    let mut original_offset = None;
    let mut original_extent = None;
    let mut selected_result = None;
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|e| HcdError::InvalidBundle(format!("slide XML: {e}")))?;
        match event {
            Event::Start(ref node) | Event::Empty(ref node) => {
                let empty = matches!(event, Event::Empty(_));
                let name = node.name().as_ref().to_vec();
                if name == b"p:pic" && !empty {
                    in_picture = true;
                    selected = false;
                    relationship = None;
                    relationship_count = 0;
                    original_offset = None;
                    original_extent = None;
                }
                if name == b"p:cNvPr" {
                    let id = attribute_value(node, b"id")?;
                    if id.as_deref() == Some(picture_id.as_bytes()) {
                        ids += 1;
                        if in_picture && stack.last().map(Vec::as_slice) == Some(b"p:nvPicPr") {
                            selected = true;
                        }
                    }
                }
                if in_picture
                    && name == b"a:blip"
                    && stack.last().map(Vec::as_slice) == Some(b"p:blipFill")
                {
                    relationship_count += 1;
                    if relationship_count > 1 {
                        return Err(HcdError::Unsupported(
                            "multiple picture relationships".into(),
                        ));
                    }
                    relationship = attribute_value(node, b"r:embed")?;
                }
                if in_picture
                    && stack.len() >= 3
                    && stack[stack.len() - 3..].iter().map(Vec::as_slice).eq([
                        b"p:pic".as_slice(),
                        b"p:spPr".as_slice(),
                        b"a:xfrm".as_slice(),
                    ])
                {
                    if name == b"a:off" {
                        original_offset = Some((
                            numeric_attribute(node, b"x")?,
                            numeric_attribute(node, b"y")?,
                        ));
                    }
                    if name == b"a:ext" {
                        original_extent = Some((
                            numeric_attribute(node, b"cx")?,
                            numeric_attribute(node, b"cy")?,
                        ));
                    }
                }
                if !empty {
                    stack.push(name);
                }
            }
            Event::End(ref node) => {
                if node.name().as_ref() == b"p:pic" {
                    if selected {
                        selected_result =
                            Some((relationship.clone(), original_offset, original_extent));
                    }
                    in_picture = false;
                }
                stack.pop();
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    if ids != 1
        || relationship_id.is_empty()
        || selected_result
            != Some((
                Some(relationship_id.as_bytes().to_vec()),
                Some((expected.x, expected.y)),
                Some((expected.width, expected.height)),
            ))
    {
        return Err(HcdError::SourceMismatch(
            "PPT picture identity, relationship or original geometry differs from imported source"
                .into(),
        ));
    }
    Ok(candidate)
}

fn attribute_value(node: &BytesStart<'_>, name: &[u8]) -> Result<Option<Vec<u8>>, HcdError> {
    for attribute in node.attributes().with_checks(true) {
        let attribute = attribute.map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
        if attribute.key.as_ref() == name {
            return Ok(Some(attribute.value.into_owned()));
        }
    }
    Ok(None)
}

fn numeric_attribute(node: &BytesStart<'_>, name: &[u8]) -> Result<i64, HcdError> {
    let value = attribute_value(node, name)?
        .ok_or_else(|| HcdError::Unsupported("missing picture coordinate".into()))?;
    std::str::from_utf8(&value)
        .ok()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| HcdError::Unsupported("invalid picture coordinate".into()))
}

/// Return a candidate XML document only when the picture and both geometry
/// elements are unique. Grouped pictures are deliberately not rewritten.
pub fn rewrite_source_picture_geometry(
    mut source: impl Read,
    picture_id: &str,
    geometry: SourcePictureGeometry,
) -> Result<Vec<u8>, HcdError> {
    const LIMIT: u64 = 32 * 1024 * 1024;
    if picture_id.is_empty()
        || !picture_id.bytes().all(|b| b.is_ascii_digit())
        || geometry.width <= 0
        || geometry.height <= 0
    {
        return Err(HcdError::InvalidPatch(
            "invalid PPT picture geometry request".into(),
        ));
    }
    let mut bytes = Vec::new();
    source.by_ref().take(LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LIMIT {
        return Err(HcdError::ResourceLimit(
            "slide XML exceeds geometry rewrite limit".into(),
        ));
    }
    validate_document_namespaces(&bytes)?;
    let mut reader = Reader::from_reader(bytes.as_slice());
    reader.config_mut().check_end_names = true;
    let mut events = Vec::new();
    let mut buffer = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut inside: Option<(usize, bool)> = None;
    let mut picture_matches = 0;
    let mut found = false;
    let mut identity_count = 0;
    let mut root_count = 0;
    let mut target: Option<(usize, usize)> = None;
    let mut off = None;
    let mut ext = None;
    loop {
        if events.len() >= 1_000_000 {
            return Err(HcdError::ResourceLimit(
                "slide XML event limit exceeded".into(),
            ));
        }
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|e| HcdError::InvalidBundle(format!("slide XML: {e}")))?
            .into_owned();
        match &event {
            Event::Start(node) => {
                if stack.is_empty() {
                    root_count += 1;
                    if root_count != 1 {
                        return Err(HcdError::InvalidBundle("multiple slide roots".into()));
                    }
                }
                let name = String::from_utf8_lossy(node.name().as_ref()).into_owned();
                if name == "p:pic" {
                    if inside.is_some() {
                        return Err(HcdError::Unsupported("nested PPT picture".into()));
                    }
                    inside = Some((stack.len(), stack.iter().any(|x| x == "p:grpSp")));
                    found = false;
                    identity_count = 0;
                    off = None;
                    ext = None
                }
                stack.push(name);
                if stack.len() > 128 {
                    return Err(HcdError::ResourceLimit(
                        "slide XML nesting exceeds limit".into(),
                    ));
                }
                if let Some((base, _)) = inside {
                    inspect(
                        node,
                        &stack[base..],
                        events.len(),
                        picture_id,
                        &mut found,
                        &mut identity_count,
                        &mut off,
                        &mut ext,
                    )?
                }
            }
            Event::Empty(node) => {
                if stack.is_empty() {
                    return Err(HcdError::InvalidBundle(
                        "unexpected empty slide root".into(),
                    ));
                }
                if let Some((base, _)) = inside {
                    let mut path = stack[base..].to_vec();
                    path.push(String::from_utf8_lossy(node.name().as_ref()).into_owned());
                    inspect(
                        node,
                        &path,
                        events.len(),
                        picture_id,
                        &mut found,
                        &mut identity_count,
                        &mut off,
                        &mut ext,
                    )?
                }
            }
            Event::End(node) => {
                if node.name().as_ref() == b"p:pic" {
                    let (_, grouped) = inside
                        .take()
                        .ok_or_else(|| HcdError::InvalidBundle("unbalanced PPT picture".into()))?;
                    if found {
                        if identity_count != 1 {
                            return Err(HcdError::Unsupported(
                                "ambiguous picture identity structure".into(),
                            ));
                        }
                        picture_matches += 1;
                        if grouped {
                            return Err(HcdError::Unsupported(
                                "grouped PPT pictures require transform-aware export".into(),
                            ));
                        }
                        target = Some((
                            off.ok_or_else(|| {
                                HcdError::Unsupported("picture offset missing".into())
                            })?,
                            ext.ok_or_else(|| {
                                HcdError::Unsupported("picture extent missing".into())
                            })?,
                        ))
                    }
                }
                stack
                    .pop()
                    .ok_or_else(|| HcdError::InvalidBundle("unbalanced slide XML".into()))?;
            }
            Event::Eof => {
                if !stack.is_empty() || root_count != 1 {
                    return Err(HcdError::InvalidBundle("incomplete slide XML".into()));
                }
                events.push(event);
                break;
            }
            _ => {}
        }
        events.push(event);
        buffer.clear();
    }
    if picture_matches != 1 {
        return Err(HcdError::Unsupported(
            "PPT picture identity missing or ambiguous".into(),
        ));
    }
    let (offset, extent) = target.unwrap();
    let mut writer = Writer::new(Vec::new());
    for (index, event) in events.into_iter().enumerate() {
        let event = if index == offset {
            replace_pair(event, b"x", geometry.x, b"y", geometry.y)?
        } else if index == extent {
            replace_pair(event, b"cx", geometry.width, b"cy", geometry.height)?
        } else {
            event
        };
        writer.write_event(event)?;
    }
    Ok(writer.into_inner())
}

fn validate_document_namespaces(xml: &[u8]) -> Result<(), HcdError> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().check_end_names = true;
    let mut buffer = Vec::new();
    let mut scopes: Vec<[bool; 3]> = Vec::new();
    let mut roots = 0usize;
    let mut events = 0usize;
    loop {
        events += 1;
        if events > 1_000_000 {
            return Err(HcdError::ResourceLimit(
                "slide XML event limit exceeded".into(),
            ));
        }
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|e| HcdError::InvalidBundle(format!("slide XML: {e}")))?;
        match event {
            Event::Start(ref node) | Event::Empty(ref node) => {
                let empty = matches!(event, Event::Empty(_));
                let mut scope = scopes.last().copied().unwrap_or([false; 3]);
                if scopes.is_empty() {
                    roots += 1;
                    if roots != 1 || empty || node.name().as_ref() != b"p:sld" {
                        return Err(HcdError::Unsupported("unsupported slide root".into()));
                    }
                }
                for attr in node.attributes().with_checks(true) {
                    let attr = attr
                        .map_err(|e| HcdError::InvalidBundle(format!("slide attributes: {e}")))?;
                    let expected: Option<(usize, &[u8])> = match attr.key.as_ref() {
                        b"xmlns:p" => Some((
                            0,
                            b"http://schemas.openxmlformats.org/presentationml/2006/main",
                        )),
                        b"xmlns:a" => {
                            Some((1, b"http://schemas.openxmlformats.org/drawingml/2006/main"))
                        }
                        b"xmlns:r" => Some((
                            2,
                            b"http://schemas.openxmlformats.org/officeDocument/2006/relationships",
                        )),
                        _ => None,
                    };
                    if let Some((index, uri)) = expected {
                        if attr.value.as_ref() != uri {
                            return Err(HcdError::Unsupported(
                                "unsupported slide namespace rebinding".into(),
                            ));
                        }
                        scope[index] = true;
                    }
                }
                let name = node.name();
                let prefix = name.as_ref();
                if (prefix.starts_with(b"p:") && !scope[0])
                    || (prefix.starts_with(b"a:") && !scope[1])
                {
                    return Err(HcdError::Unsupported("unbound slide namespace".into()));
                }
                for attr in node.attributes().with_checks(true) {
                    let attr = attr.map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
                    let key = attr.key.as_ref();
                    if (key.starts_with(b"r:") && !scope[2])
                        || (key.starts_with(b"a:") && !scope[1])
                        || (key.starts_with(b"p:") && !scope[0])
                    {
                        return Err(HcdError::Unsupported(
                            "unbound slide attribute namespace".into(),
                        ));
                    }
                }
                if !empty {
                    scopes.push(scope);
                    if scopes.len() > 128 {
                        return Err(HcdError::ResourceLimit(
                            "slide XML nesting exceeds limit".into(),
                        ));
                    }
                }
            }
            Event::End(_) => {
                scopes
                    .pop()
                    .ok_or_else(|| HcdError::InvalidBundle("unbalanced slide XML".into()))?;
            }
            Event::DocType(_) => return Err(HcdError::Unsupported("slide XML DTD".into())),
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    if !scopes.is_empty() || roots != 1 {
        return Err(HcdError::InvalidBundle("incomplete slide XML".into()));
    }
    Ok(())
}

fn inspect(
    node: &BytesStart<'_>,
    path: &[String],
    index: usize,
    id: &str,
    found: &mut bool,
    identity_count: &mut usize,
    off: &mut Option<usize>,
    ext: &mut Option<usize>,
) -> Result<(), HcdError> {
    let path: Vec<&str> = path.iter().map(String::as_str).collect();
    if path == ["p:pic", "p:nvPicPr", "p:cNvPr"] {
        *identity_count += 1;
        let mut value = None;
        for attr in node.attributes().with_checks(true) {
            let a =
                attr.map_err(|e| HcdError::InvalidBundle(format!("picture attributes: {e}")))?;
            if a.key.as_ref() == b"id" {
                value = Some(String::from_utf8_lossy(a.value.as_ref()).into_owned())
            }
        }
        if value.as_deref() == Some(id) {
            if *found {
                return Err(HcdError::Unsupported("duplicate picture identity".into()));
            }
            *found = true
        }
    }
    for (expected, slot) in [
        (["p:pic", "p:spPr", "a:xfrm", "a:off"], off),
        (["p:pic", "p:spPr", "a:xfrm", "a:ext"], ext),
    ] {
        if path == expected {
            if slot.replace(index).is_some() {
                return Err(HcdError::Unsupported("duplicate picture geometry".into()));
            }
        }
    }
    Ok(())
}

fn replace_pair(
    event: Event<'static>,
    first: &[u8],
    a: i64,
    second: &[u8],
    b: i64,
) -> Result<Event<'static>, HcdError> {
    let old = match event {
        Event::Empty(v) => v,
        _ => {
            return Err(HcdError::Unsupported(
                "picture geometry must use empty elements".into(),
            ))
        }
    };
    let name = String::from_utf8(old.name().as_ref().to_vec())
        .map_err(|_| HcdError::InvalidBundle("invalid picture element name".into()))?;
    let mut next = BytesStart::new(name);
    let av = a.to_string();
    let bv = b.to_string();
    let mut seen = [false, false];
    for attr in old.attributes().with_checks(true) {
        let attr = attr.map_err(|e| HcdError::InvalidBundle(format!("picture attributes: {e}")))?;
        let key = attr.key.as_ref();
        if key == first {
            seen[0] = true;
            next.push_attribute((key, av.as_bytes()))
        } else if key == second {
            seen[1] = true;
            next.push_attribute((key, bv.as_bytes()))
        } else {
            next.push_attribute((key, attr.value.as_ref()))
        }
    }
    if !seen.iter().all(|v| *v) {
        return Err(HcdError::Unsupported(
            "picture geometry attributes missing".into(),
        ));
    }
    Ok(Event::Empty(next.into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn xml() -> String {
        r#"<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:spTree><p:pic><p:nvPicPr><p:cNvPr id="7" name="Image"/></p:nvPicPr><p:spPr><a:xfrm rot="20"><a:off x="10" y="20"/><a:ext cx="30" cy="40"/></a:xfrm></p:spPr></p:pic><p:pic><p:nvPicPr><p:cNvPr id="8"/></p:nvPicPr><p:spPr><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm></p:spPr></p:pic></p:spTree></p:sld>"#.into()
    }
    fn geometry() -> SourcePictureGeometry {
        SourcePictureGeometry {
            x: -11,
            y: 22,
            width: 1397000,
            height: 635000,
        }
    }
    #[test]
    fn rewrites_only_the_target_picture() {
        let input = xml();
        let output = String::from_utf8(
            rewrite_source_picture_geometry(input.as_bytes(), "7", geometry()).unwrap(),
        )
        .unwrap();
        assert_eq!(
            output,
            input
                .replace("x=\"10\" y=\"20\"", "x=\"-11\" y=\"22\"")
                .replace("cx=\"30\" cy=\"40\"", "cx=\"1397000\" cy=\"635000\"")
        );
    }
    #[test]
    fn rewrites_real_slide_fixture_without_changing_other_xml() {
        let input = include_str!("../testdata/picture-slide.xml");
        let output = String::from_utf8(
            rewrite_source_picture_geometry(input.as_bytes(), "3", geometry()).unwrap(),
        )
        .unwrap();
        assert_eq!(
            output,
            input
                .replace("x=\"127000\" y=\"1270000\"", "x=\"-11\" y=\"22\"")
                .replace(
                    "cx=\"1270000\" cy=\"635000\"",
                    "cx=\"1397000\" cy=\"635000\""
                )
        );
    }
    #[test]
    fn checked_rewrite_verifies_original_identity_relationship_and_geometry() {
        let input = include_str!("../testdata/picture-slide.xml");
        let original = SourcePictureGeometry {
            x: 127000,
            y: 1270000,
            width: 1270000,
            height: 635000,
        };
        let checked = |xml: &str, relationship: &str, baseline| {
            rewrite_checked_source_picture_geometry(
                xml.as_bytes(),
                "3",
                relationship,
                baseline,
                geometry(),
            )
        };
        assert!(checked(input, "rId1", original).is_ok());
        assert!(checked(input, "rId2", original).is_err());
        assert!(checked(input, "rId1", SourcePictureGeometry { x: 1, ..original }).is_err());
        assert!(checked(&input.replace("id=\"2\"", "id=\"3\""), "rId1", original).is_err());
        assert!(checked(
            &input.replace(
                "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"",
                "xmlns:r=\"wrong\""
            ),
            "rId1",
            original
        )
        .is_err());
        assert!(checked(
            &input.replace(
                "<a:blip r:embed=\"rId1\"/>",
                "<a:blip r:embed=\"rId1\"/><a:blip r:embed=\"rId2\"/>"
            ),
            "rId1",
            original
        )
        .is_err());
    }

    #[test]
    fn relationship_rewrite_changes_only_selected_picture_reference() {
        let input = include_str!("../testdata/picture-slide.xml");
        let original = SourcePictureGeometry {
            x: 127000,
            y: 1270000,
            width: 1270000,
            height: 635000,
        };
        let output = rewrite_checked_source_picture_with_relationship(
            input.as_bytes(),
            "3",
            "rId1",
            "hcdImage1",
            original,
            geometry(),
        )
        .unwrap();
        let text = String::from_utf8(output).unwrap();
        assert_eq!(
            text,
            input
                .replace("r:embed=\"rId1\"", "r:embed=\"hcdImage1\"")
                .replace("x=\"127000\" y=\"1270000\"", "x=\"-11\" y=\"22\"")
                .replace(
                    "cx=\"1270000\" cy=\"635000\"",
                    "cx=\"1397000\" cy=\"635000\""
                )
        );
        assert!(rewrite_checked_source_picture_with_relationship(
            input.as_bytes(),
            "3",
            "wrong",
            "hcdImage1",
            original,
            geometry()
        )
        .is_err());
        let start = input.find("<p:pic>").unwrap();
        let end = input[start..].find("</p:pic>").unwrap() + start + "</p:pic>".len();
        let second = input[start..end].replace("id=\"3\"", "id=\"4\"");
        let shared = format!("{}{}{}", &input[..end], second, &input[end..]);
        let output = rewrite_checked_source_picture_with_relationship(
            shared.as_bytes(),
            "3",
            "rId1",
            "hcdImage1",
            original,
            geometry(),
        )
        .unwrap();
        let output = String::from_utf8(output).unwrap();
        assert_eq!(output.matches("r:embed=\"hcdImage1\"").count(), 1);
        assert_eq!(output.matches("r:embed=\"rId1\"").count(), 1);
        assert!(rewrite_checked_source_picture_with_relationship(
            input.as_bytes(),
            "3",
            "rId1",
            "invalid id",
            original,
            geometry()
        )
        .is_err());
    }
    #[test]
    fn rejects_missing_duplicate_and_grouped_targets() {
        let input = xml();
        assert!(rewrite_source_picture_geometry(input.as_bytes(), "9", geometry()).is_err());
        assert!(rewrite_source_picture_geometry(
            input.replace("id=\"8\"", "id=\"7\"").as_bytes(),
            "7",
            geometry()
        )
        .is_err());
        assert!(rewrite_source_picture_geometry(
            input
                .replace(
                    "<p:cNvPr id=\"7\" name=\"Image\"/>",
                    "<p:cNvPr id=\"7\"/><p:cNvPr id=\"99\"/>"
                )
                .as_bytes(),
            "7",
            geometry()
        )
        .is_err());
        assert!(rewrite_source_picture_geometry(
            input.trim_end_matches("</p:sld>").as_bytes(),
            "7",
            geometry()
        )
        .is_err());
        assert!(rewrite_source_picture_geometry(
            input
                .replace("<p:spTree>", "<p:spTree><p:grpSp>")
                .replace("</p:spTree>", "</p:grpSp></p:spTree>")
                .as_bytes(),
            "7",
            geometry()
        )
        .is_err());
    }
    #[test]
    fn rejects_incomplete_and_invalid_geometry() {
        let input = xml();
        assert!(rewrite_source_picture_geometry(
            input.replace("y=\"20\"", "").as_bytes(),
            "7",
            geometry()
        )
        .is_err());
        assert!(rewrite_source_picture_geometry(
            input
                .replace(
                    "<a:ext cx=\"30\" cy=\"40\"/>",
                    "<a:ext cx=\"30\" cy=\"40\"></a:ext>"
                )
                .as_bytes(),
            "7",
            geometry()
        )
        .is_err());
        assert!(rewrite_source_picture_geometry(
            input.as_bytes(),
            "7",
            SourcePictureGeometry {
                width: 0,
                ..geometry()
            }
        )
        .is_err());
    }

    #[test]
    fn rejects_rebound_or_unrecognized_namespaces() {
        let input = xml();
        assert!(rewrite_source_picture_geometry(
            input
                .replace("presentationml/2006/main", "wrong")
                .as_bytes(),
            "7",
            geometry()
        )
        .is_err());
        assert!(rewrite_source_picture_geometry(
            input
                .replace("<p:pic>", "<p:pic xmlns:p=\"other\">")
                .as_bytes(),
            "7",
            geometry()
        )
        .is_err());
        assert!(rewrite_source_picture_geometry(
            input.replace("<a:off", "<b:off").as_bytes(),
            "7",
            geometry()
        )
        .is_err());
    }
}
