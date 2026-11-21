use hcd_core::{pptx_design::PptxMasterTextStyle, HcdError};
use quick_xml::{events::Event, Reader, Writer};
use roxmltree::{Document, Node};

const PML: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DML: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
type Step<'a> = (&'a str, &'a str);

fn find<'a, 'i>(root: Node<'a, 'i>, path: &[Step<'_>]) -> Result<Node<'a, 'i>, HcdError> {
    path.iter().try_fold(root, |parent, (ns, name)| {
        parent
            .children()
            .find(|n| n.has_tag_name((*ns, *name)))
            .ok_or_else(|| {
                HcdError::InvalidBundle(format!("master style element {name} is missing"))
            })
    })
}

fn parse(xml: &str) -> Result<Document<'_>, HcdError> {
    Document::parse(xml).map_err(|error| HcdError::InvalidBundle(error.to_string()))
}

/// Change a single child, retaining all untouched source XML byte for byte.
fn set_child(
    xml: &mut String,
    path: &[Step<'_>],
    name: Step<'_>,
    child: &str,
    order: &[&str],
) -> Result<(), HcdError> {
    let doc = parse(xml)?;
    let parent = find(doc.root_element(), path)?;
    if let Some(old) = parent.children().find(|n| n.has_tag_name(name)) {
        let range = old.range();
        xml.replace_range(range, child);
        return Ok(());
    }
    let range = parent.range();
    let original = &xml[range.clone()];
    let insert = order
        .iter()
        .position(|n| *n == name.1)
        .unwrap_or(order.len());
    let before = parent.children().filter(Node::is_element).find(|n| {
        n.tag_name().namespace() == Some(name.0)
            && order
                .iter()
                .position(|name| *name == n.tag_name().name())
                .unwrap_or(order.len())
                > insert
    });
    if let Some(before) = before {
        let at = before.range().start;
        xml.insert_str(at, child);
    } else if original.trim_end().ends_with("/>") {
        let closing = range.start + original.rfind("/>").unwrap();
        let qualified = original[1..]
            .split(|c: char| c.is_whitespace() || c == '/' || c == '>')
            .next()
            .unwrap();
        let replacement = format!(">{child}</{qualified}>");
        xml.replace_range(closing..range.end, &replacement);
    } else {
        let closing = range.start
            + original
                .rfind("</")
                .ok_or_else(|| HcdError::InvalidBundle("master style is incomplete".into()))?;
        xml.insert_str(closing, child);
    }
    Ok(())
}

fn ensure_child(
    xml: &mut String,
    path: &[Step<'_>],
    name: Step<'_>,
    order: &[&str],
) -> Result<(), HcdError> {
    let doc = parse(xml)?;
    if find(doc.root_element(), path)?
        .children()
        .any(|n| n.has_tag_name(name))
    {
        return Ok(());
    }
    let prefix = if name.0 == PML { "p" } else { "a" };
    set_child(
        xml,
        path,
        name,
        &format!("<{prefix}:{} xmlns:{prefix}=\"{}\"/>", name.1, name.0),
        order,
    )
}

pub(super) fn write_styles(
    xml: &mut String,
    styles: &[PptxMasterTextStyle],
) -> Result<(), HcdError> {
    const GROUPS: &[&str] = &["titleStyle", "bodyStyle", "otherStyle", "extLst"];
    const LEVELS: &[&str] = &[
        "defPPr", "lvl1pPr", "lvl2pPr", "lvl3pPr", "lvl4pPr", "lvl5pPr", "lvl6pPr", "lvl7pPr",
        "lvl8pPr", "lvl9pPr", "extLst",
    ];
    const PARAGRAPH: &[&str] = &[
        "lnSpc",
        "spcBef",
        "spcAft",
        "buClrTx",
        "buClr",
        "buSzTx",
        "buSzPct",
        "buSzPts",
        "buFontTx",
        "buFont",
        "buNone",
        "buAutoNum",
        "buChar",
        "buBlip",
        "tabLst",
        "defRPr",
        "extLst",
    ];
    const CHARACTER: &[&str] = &[
        "ln",
        "noFill",
        "solidFill",
        "gradFill",
        "blipFill",
        "pattFill",
        "grpFill",
        "effectLst",
        "effectDag",
        "highlight",
        "uLnTx",
        "uLn",
        "uFillTx",
        "uFill",
        "latin",
        "ea",
        "cs",
        "sym",
        "hlinkClick",
        "hlinkMouseOver",
        "rtl",
        "extLst",
    ];
    ensure_child(
        xml,
        &[],
        (PML, "txStyles"),
        &[
            "cSld",
            "clrMap",
            "sldLayoutIdLst",
            "transition",
            "timing",
            "hf",
            "txStyles",
            "extLst",
        ],
    )?;
    for style in styles {
        let group = format!("{}Style", style.kind.as_str());
        let level = format!("lvl{}pPr", style.level);
        ensure_child(xml, &[(PML, "txStyles")], (PML, &group), GROUPS)?;
        let group_path = [(PML, "txStyles"), (PML, &group)];
        ensure_child(xml, &group_path, (DML, &level), LEVELS)?;
        let path = [(PML, "txStyles"), (PML, &group), (DML, &level)];
        ensure_child(xml, &path, (DML, "defRPr"), PARAGRAPH)?;
        let run_path = [
            (PML, "txStyles"),
            (PML, &group),
            (DML, &level),
            (DML, "defRPr"),
        ];
        let fragment = {
            let doc = parse(xml)?;
            xml[find(doc.root_element(), &run_path)?.range()].to_string()
        };
        let mut reader = Reader::from_str(&fragment);
        let mut events = Vec::new();
        loop {
            let event = reader
                .read_event()
                .map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
            if matches!(event, Event::Eof) {
                break;
            }
            events.push(event.into_owned());
        }
        let start = match &events[0] {
            Event::Start(s) | Event::Empty(s) => s,
            _ => {
                return Err(HcdError::InvalidBundle(
                    "master run properties are missing".into(),
                ))
            }
        };
        let mut writer = Writer::new(Vec::new());
        super::write_formatted_run_properties(
            &mut writer,
            start,
            &style.format,
            matches!(events[0], Event::Empty(_)),
            &events[1..],
        )?;
        let formatted = String::from_utf8(writer.into_inner())
            .map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
        set_child(xml, &path, (DML, "defRPr"), &formatted, PARAGRAPH)?;
        if let Some(fonts) = &style.font {
            for (name, font) in [
                ("latin", &fonts.latin),
                ("ea", &fonts.east_asia),
                ("cs", &fonts.bidi),
            ] {
                let Some(font) = font else { continue };
                let existing = {
                    let doc = parse(xml)?;
                    find(doc.root_element(), &run_path)?
                        .children()
                        .find(|n| n.has_tag_name((DML, name)))
                        .map(|n| xml[n.range()].to_string())
                };
                let replacement = if let Some(existing) = existing {
                    let mut reader = Reader::from_str(&existing);
                    let first = reader
                        .read_event()
                        .map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
                    let (Event::Start(start) | Event::Empty(start)) = first else {
                        return Err(HcdError::InvalidBundle(
                            "master font element is invalid".into(),
                        ));
                    };
                    let mut writer = Writer::new(Vec::new());
                    writer.write_event(Event::Empty(super::set_element_attribute(
                        &start, "typeface", font,
                    )))?;
                    String::from_utf8(writer.into_inner())
                        .map_err(|e| HcdError::InvalidBundle(e.to_string()))?
                } else {
                    format!("<a:{name} xmlns:a=\"{DML}\" typeface=\"{font}\"/>")
                };
                set_child(xml, &run_path, (DML, name), &replacement, CHARACTER)?;
            }
        }
    }
    Ok(())
}
