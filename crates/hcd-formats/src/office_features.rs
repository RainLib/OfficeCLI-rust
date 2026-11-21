//! Read, validate and materialize the same Office settings for UI, MCP and export.
use hcd_core::{
    manifest_at_revision, office_features::*, ApplyResult, Bundle, GridChunkKind, HcdError,
    HcdManifest,
};
use oxml::{
    xml_util::{apply_xml_edits, replace_direct_child},
    OxmlPackage, StreamingOxmlArchive,
};
use quick_xml::escape::escape;
use roxmltree::{Document, Node};
use serde::Serialize;
use std::{collections::BTreeMap, path::Path};
const S: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const P14: &str = "http://schemas.microsoft.com/office/powerpoint/2010/main";
fn bad(e: impl std::fmt::Display) -> HcdError {
    HcdError::InvalidBundle(e.to_string())
}
fn parse(xml: &str) -> Result<Document<'_>, HcdError> {
    Document::parse(xml).map_err(bad)
}
fn control(source: &Path, part: &str) -> Result<Option<String>, HcdError> {
    let mut zip = StreamingOxmlArchive::open(source).map_err(bad)?;
    if !zip.contains(part) {
        return Ok(None);
    }
    let bytes = zip.read_control_part(part, 32 * 1024 * 1024).map_err(bad)?;
    String::from_utf8(bytes).map(Some).map_err(bad)
}
fn float(n: Option<Node<'_, '_>>, name: &str, default: f64) -> f64 {
    n.and_then(|n| n.attribute(name))
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}
fn uint(n: Option<Node<'_, '_>>, name: &str, default: u32) -> u32 {
    n.and_then(|n| n.attribute(name))
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}
fn yes(n: Option<Node<'_, '_>>, name: &str) -> bool {
    n.and_then(|n| n.attribute(name))
        .is_some_and(|v| v == "1" || v == "true")
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetPrintView {
    pub sheet_id: String,
    pub sheet_name: String,
    pub sheet_index: usize,
    pub part: String,
    pub layout: SheetPrintLayout,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideTransitionView {
    pub chunk_id: String,
    pub index: usize,
    pub part: String,
    pub transition: SlideTransition,
    pub unsupported_native: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeSnapshot {
    pub protocol_version: &'static str,
    pub revision: u64,
    pub word: Option<hcd_docx::WordOfficeSnapshot>,
    pub sheets: Vec<SheetPrintView>,
    pub slides: Vec<SlideTransitionView>,
}
fn sheet_addresses(
    bundle: &Bundle,
    manifest: &HcdManifest,
) -> Result<Vec<SheetPrintView>, HcdError> {
    let mut all = BTreeMap::new();
    for page in 0..manifest.index_page_count {
        for chunk in bundle.read_index_page(manifest, page)?.chunks {
            if let Some(g) = chunk.grid {
                if g.kind == GridChunkKind::Cells {
                    all.entry(g.sheet_id.clone()).or_insert(SheetPrintView {
                        sheet_id: g.sheet_id,
                        sheet_name: g.sheet_name,
                        sheet_index: g.sheet_index,
                        part: g.sheet_part.unwrap_or_default(),
                        layout: Default::default(),
                    });
                }
            }
        }
    }
    let mut all: Vec<_> = all.into_values().collect();
    all.sort_by_key(|s| s.sheet_index);
    Ok(all)
}
fn slide_addresses(
    bundle: &Bundle,
    manifest: &HcdManifest,
) -> Result<Vec<SlideTransitionView>, HcdError> {
    let mut all = vec![];
    for page in 0..manifest.index_page_count {
        for chunk in bundle.read_index_page(manifest, page)?.chunks {
            if chunk.region != "slide" || chunk.continuation {
                continue;
            }
            let html = bundle.read_chunk_verified(&chunk)?;
            let part = html
                .split_once(" data-hcd-source-part=\"")
                .and_then(|(_, s)| s.split_once('"'))
                .map(|(s, _)| s.to_string())
                .ok_or_else(|| bad("slide source identity is missing"))?;
            all.push(SlideTransitionView {
                chunk_id: chunk.chunk_id,
                index: all.len() + 1,
                part,
                transition: Default::default(),
                unsupported_native: false,
            });
        }
    }
    Ok(all)
}
fn print_references(value: &str) -> Vec<&str> {
    let (mut quoted, mut start, mut parts) = (false, 0, vec![]);
    for (at, ch) in value.char_indices() {
        if ch == '\'' {
            quoted = !quoted;
        } else if ch == ',' && !quoted {
            parts.push(&value[start..at]);
            start = at + 1;
        }
    }
    parts.push(&value[start..]);
    parts
}
fn read_print(
    xml: &str,
    workbook: Option<&str>,
    index: usize,
) -> Result<SheetPrintLayout, HcdError> {
    let doc = parse(xml)?;
    let root = doc.root_element();
    let child = |name| root.children().find(|n| n.has_tag_name((S, name)));
    let setup = child("pageSetup");
    let margin = child("pageMargins");
    let print = child("printOptions");
    let fit =
        child("sheetPr").and_then(|p| p.children().find(|n| n.has_tag_name((S, "pageSetUpPr"))));
    let d = SheetPrintLayout::default();
    let mut layout = SheetPrintLayout {
        paper_size: uint(setup, "paperSize", 9) as u16,
        landscape: setup.and_then(|n| n.attribute("orientation")) == Some("landscape"),
        scale: if yes(fit, "fitToPage") {
            None
        } else {
            setup
                .and_then(|n| n.attribute("scale"))
                .and_then(|s| s.parse().ok())
        },
        fit_width: uint(setup, "fitToWidth", 1) as u16,
        fit_height: uint(setup, "fitToHeight", 0) as u16,
        left_inches: float(margin, "left", d.left_inches),
        right_inches: float(margin, "right", d.right_inches),
        top_inches: float(margin, "top", d.top_inches),
        bottom_inches: float(margin, "bottom", d.bottom_inches),
        header_inches: float(margin, "header", d.header_inches),
        footer_inches: float(margin, "footer", d.footer_inches),
        print_area: None,
        repeat_rows: None,
        repeat_columns: None,
        gridlines: yes(print, "gridLines"),
        headings: yes(print, "headings"),
        center_horizontal: yes(print, "horizontalCentered"),
        center_vertical: yes(print, "verticalCentered"),
    };
    if let Some(workbook) = workbook {
        for name in parse(workbook)?.descendants().filter(|n| {
            n.has_tag_name((S, "definedName"))
                && n.attribute("localSheetId")
                    .and_then(|s| s.parse::<usize>().ok())
                    == Some(index)
        }) {
            let value = name.text().unwrap_or_default();
            match name.attribute("name") {
                Some("_xlnm.Print_Area") => {
                    layout.print_area = value
                        .rsplit('!')
                        .next()
                        .filter(|r| range(r).is_some())
                        .map(|s| s.replace('$', ""));
                }
                Some("_xlnm.Print_Titles") => {
                    for part in print_references(value) {
                        if let Some((a, b)) = part
                            .rsplit('!')
                            .next()
                            .unwrap_or_default()
                            .replace('$', "")
                            .split_once(':')
                        {
                            if let (Ok(a), Ok(b)) = (a.parse::<u32>(), b.parse::<u32>()) {
                                layout.repeat_rows = Some((a, b));
                            } else if let (Some((_, a)), Some((_, b))) =
                                (cell(&format!("{a}1")), cell(&format!("{b}1")))
                            {
                                layout.repeat_columns = Some((a as u16, b as u16));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    Ok(layout)
}
fn read_transition(xml: &str) -> Result<(SlideTransition, bool), HcdError> {
    let doc = parse(xml)?;
    let Some(t) = doc
        .root_element()
        .children()
        .find(|n| n.has_tag_name((P, "transition")))
    else {
        return Ok((
            Default::default(),
            doc.descendants()
                .any(|n| n.is_element() && n.tag_name().name() == "transition"),
        ));
    };
    let effect = t.children().find(Node::is_element);
    let kind = match effect.map(|n| n.tag_name().name()) {
        Some("fade") => TransitionKind::Fade,
        Some("push") => TransitionKind::Push,
        Some("wipe") => TransitionKind::Wipe,
        Some("cut") => TransitionKind::Cut,
        None => TransitionKind::None,
        _ => return Ok((Default::default(), true)),
    };
    let direction = match effect.and_then(|n| n.attribute("dir")) {
        Some("r") => TransitionDirection::Right,
        Some("u") => TransitionDirection::Up,
        Some("d") => TransitionDirection::Down,
        _ => TransitionDirection::Left,
    };
    let duration_ms = t
        .attribute((P14, "dur"))
        .and_then(|s| s.parse().ok())
        .unwrap_or(match t.attribute("spd") {
            Some("slow") => 1000,
            Some("med") => 750,
            _ => 500,
        });
    Ok((
        SlideTransition {
            kind,
            direction,
            duration_ms,
            advance_on_click: t
                .attribute("advClick")
                .is_none_or(|s| s != "0" && s != "false"),
            advance_after_ms: t.attribute("advTm").and_then(|s| s.parse().ok()),
        },
        false,
    ))
}
pub fn read_office_features(
    bundle: &Bundle,
    source: &Path,
    revision: Option<u64>,
) -> Result<OfficeSnapshot, HcdError> {
    let (manifest, _) = manifest_at_revision(bundle, &bundle.manifest()?, revision)?;
    if hcd_core::hash_file(source)? != manifest.source.sha256 {
        return Err(HcdError::SourceMismatch(
            "immutable Office source does not match".into(),
        ));
    }
    let state = hcd_core::office_features::read(bundle, &manifest)?;
    let mut snapshot = OfficeSnapshot {
        protocol_version: PROTOCOL,
        revision: manifest.revision,
        word: None,
        sheets: vec![],
        slides: vec![],
    };
    match manifest.source.format.as_str() {
        "docx" => {
            snapshot.word = Some(hcd_docx::read_word_features(
                bundle,
                source,
                &state,
                manifest.revision,
            )?)
        }
        "xlsx" => {
            let workbook = control(source, "xl/workbook.xml")?;
            for mut sheet in sheet_addresses(bundle, &manifest)? {
                if let Some(xml) = control(source, &sheet.part)? {
                    sheet.layout = read_print(&xml, workbook.as_deref(), sheet.sheet_index)?;
                }
                if let Some(layout) = state.sheet_print.get(&sheet.sheet_id) {
                    sheet.layout = layout.clone();
                }
                snapshot.sheets.push(sheet);
            }
        }
        "pptx" => {
            for mut slide in slide_addresses(bundle, &manifest)? {
                if let Some(xml) = control(source, &slide.part)? {
                    let (layout, unsupported) = read_transition(&xml)?;
                    slide.transition = layout;
                    slide.unsupported_native = unsupported;
                }
                if let Some(layout) = state.slide_transitions.get(&slide.chunk_id) {
                    slide.transition = layout.clone();
                    slide.unsupported_native = false;
                }
                snapshot.slides.push(slide);
            }
        }
        _ => {
            return Err(HcdError::Unsupported(
                "Office settings require DOCX, XLSX or PPTX".into(),
            ))
        }
    }
    Ok(snapshot)
}
pub fn edit_office_features(
    bundle: &Bundle,
    source: &Path,
    request: &OfficeEdit,
) -> Result<ApplyResult, HcdError> {
    hcd_core::office_features::edit(bundle, request, |manifest, state| {
        let snapshot = read_office_features(bundle, source, Some(manifest.revision))?;
        match &request.action {
            OfficeAction::WordPage { sections, .. } => {
                if sections.iter().any(|id| {
                    !snapshot
                        .word
                        .as_ref()
                        .is_some_and(|w| w.sections.iter().any(|s| s.index == *id))
                }) {
                    return Err(HcdError::PreconditionFailed(
                        "Word section no longer exists".into(),
                    ));
                }
            }
            OfficeAction::WordFootnote { id, note } => {
                let word = snapshot.word.as_ref().ok_or_else(|| bad("not Word"))?;
                let existing = word.footnotes.iter().any(|n| n.id == *id);
                if note.text.is_none() && !existing {
                    return Err(HcdError::PreconditionFailed(
                        "Footnote no longer exists".into(),
                    ));
                }
                if id.starts_with("native:") && !existing {
                    return Err(HcdError::PreconditionFailed(
                        "Native footnote no longer exists".into(),
                    ));
                }
                if let Some(anchor) = &note.anchor {
                    let blocks =
                        hcd_core::editor_projection(bundle, Some(manifest.revision))?.blocks;
                    let block = blocks
                        .iter()
                        .find(|b| {
                            b.block_id == anchor.block_id && !b.read_only && b.region == "body"
                        })
                        .ok_or_else(|| {
                            HcdError::PreconditionFailed(
                                "Select ordinary Word body text for the footnote".into(),
                            )
                        })?;
                    let text: String = block
                        .content
                        .inlines
                        .iter()
                        .map(|i| i.text.as_str())
                        .collect();
                    let chars: Vec<_> = text.chars().collect();
                    let before: String = chars[..anchor.offset.min(chars.len())].iter().collect();
                    let after: String = chars[anchor.offset.min(chars.len())..].iter().collect();
                    if hcd_core::hash_bytes(text.as_bytes()) != anchor.paragraph_hash
                        || anchor.offset > chars.len()
                        || before
                            .chars()
                            .rev()
                            .take(32)
                            .collect::<Vec<_>>()
                            .into_iter()
                            .rev()
                            .collect::<String>()
                            != anchor.before
                        || after.chars().take(32).collect::<String>() != anchor.after
                    {
                        return Err(HcdError::PreconditionFailed(
                            "The footnote paragraph changed; reread and reselect".into(),
                        ));
                    }
                } else if !existing && !state.footnotes.contains_key(id) {
                    return Err(HcdError::InvalidPatch(
                        "A new footnote requires an exact body anchor".into(),
                    ));
                }
            }
            OfficeAction::SheetPrint { sheet_id, .. } => {
                if !snapshot.sheets.iter().any(|s| s.sheet_id == *sheet_id) {
                    return Err(HcdError::PreconditionFailed(
                        "Worksheet no longer exists".into(),
                    ));
                }
            }
            OfficeAction::SlideTransition { chunk_ids, .. }
                if chunk_ids
                    .iter()
                    .any(|id| !snapshot.slides.iter().any(|s| s.chunk_id == *id)) =>
            {
                return Err(HcdError::PreconditionFailed(
                    "Slide no longer exists".into(),
                ));
            }
            _ => {}
        }
        Ok(())
    })
}
const SHEET_ORDER: &[&str] = &[
    "sheetPr",
    "dimension",
    "sheetViews",
    "sheetFormatPr",
    "cols",
    "sheetData",
    "sheetCalcPr",
    "sheetProtection",
    "protectedRanges",
    "scenarios",
    "autoFilter",
    "sortState",
    "dataConsolidate",
    "customSheetViews",
    "mergeCells",
    "phoneticPr",
    "conditionalFormatting",
    "dataValidations",
    "hyperlinks",
    "printOptions",
    "pageMargins",
    "pageSetup",
    "headerFooter",
    "rowBreaks",
    "colBreaks",
    "customProperties",
    "cellWatches",
    "ignoredErrors",
    "smartTags",
    "drawing",
    "legacyDrawing",
    "legacyDrawingHF",
    "picture",
    "oleObjects",
    "controls",
    "webPublishItems",
    "tableParts",
    "extLst",
];
fn root_child(
    xml: &str,
    ns: &str,
    name: &str,
    value: &str,
    order: &[&str],
) -> Result<String, HcdError> {
    let doc = parse(xml)?;
    replace_direct_child(xml, doc.root_element().range(), ns, name, value, order).map_err(bad)
}
fn column(mut n: u32) -> String {
    let mut value = vec![];
    while n > 0 {
        n -= 1;
        value.push((b'A' + (n % 26) as u8) as char);
        n /= 26;
    }
    value.iter().rev().collect()
}
fn native_area(value: &str) -> Result<String, HcdError> {
    let (a, b) = range(value).ok_or_else(|| bad("invalid print area"))?;
    Ok(format!("${}${}:${}${}", column(a.1), a.0, column(b.1), b.0))
}
fn write_defined(
    xml: &str,
    index: usize,
    name: &str,
    value: Option<&str>,
) -> Result<String, HcdError> {
    let mut next = xml.to_string();
    if !parse(&next)?
        .root_element()
        .children()
        .any(|n| n.has_tag_name((S, "definedNames")))
    {
        if value.is_none() {
            return Ok(next);
        }
        next = root_child(
            &next,
            S,
            "definedNames",
            &format!(r#"<definedNames xmlns="{S}"></definedNames>"#),
            &[
                "fileVersion",
                "fileSharing",
                "workbookPr",
                "workbookProtection",
                "bookViews",
                "sheets",
                "functionGroups",
                "externalReferences",
                "definedNames",
                "calcPr",
                "oleSize",
                "customWorkbookViews",
                "pivotCaches",
                "smartTagPr",
                "smartTagTypes",
                "webPublishing",
                "fileRecoveryPr",
                "webPublishObjects",
                "extLst",
            ],
        )?;
    }
    let doc = parse(&next)?;
    let root = doc
        .root_element()
        .children()
        .find(|n| n.has_tag_name((S, "definedNames")))
        .ok_or_else(|| bad("missing defined names"))?;
    if next[root.range()].trim_end().ends_with("/>") {
        let name = next[root.range()]
            .trim_start_matches('<')
            .split(|c: char| c.is_whitespace() || c == '/' || c == '>')
            .next()
            .unwrap_or("definedNames");
        let prefix = next[root.range()]
            .split('>')
            .next()
            .unwrap_or_default()
            .trim_end_matches('/');
        let replacement = format!("{prefix}></{name}>");
        next = apply_xml_edits(&next, vec![(root.range(), replacement)]).map_err(bad)?;
    }
    let doc = parse(&next)?;
    let root = doc
        .root_element()
        .children()
        .find(|n| n.has_tag_name((S, "definedNames")))
        .ok_or_else(|| bad("missing defined names"))?;
    let existing: Vec<_> = root
        .children()
        .filter(|n| {
            n.has_tag_name((S, "definedName"))
                && n.attribute("name") == Some(name)
                && n.attribute("localSheetId")
                    .and_then(|s| s.parse::<usize>().ok())
                    == Some(index)
        })
        .map(|n| (n.range(), String::new()))
        .collect();
    let at = root.range().start + next[root.range()].find('>').unwrap_or(0) + 1;
    let mut edits = existing;
    if let Some(value) = value {
        edits.push((
            at..at,
            format!(
                r#"<definedName xmlns="{S}" name="{name}" localSheetId="{index}">{}</definedName>"#,
                escape(value)
            ),
        ));
    }
    apply_xml_edits(&next, edits).map_err(bad)
}
fn native_workbook_sheets(package: &OxmlPackage) -> Result<Vec<(String, String)>, HcdError> {
    let xml = package.read_part_xml("xl/workbook.xml").map_err(bad)?;
    let doc = parse(&xml)?;
    let rels = package.part_rels("xl/workbook.xml").map_err(bad)?;
    doc.descendants()
        .filter(|n| n.has_tag_name((S, "sheet")))
        .map(|n| {
            let id = n
                .attribute((R, "id"))
                .ok_or_else(|| bad("worksheet relation is missing"))?;
            let rel = rels
                .get(id)
                .ok_or_else(|| bad("worksheet relation is missing"))?;
            let target = if rel.target.starts_with('/') {
                rel.target.trim_start_matches('/').to_string()
            } else if rel.target.starts_with("xl/") {
                rel.target.clone()
            } else {
                format!("xl/{}", rel.target.trim_start_matches("./"))
            };
            if target.contains("..") {
                return Err(bad("unsafe worksheet target"));
            }
            Ok((n.attribute("name").unwrap_or_default().to_string(), target))
        })
        .collect()
}
/// Keep native printer flags and relationship IDs outside the edited controls.
fn preserve_setup_attributes(xml: &str, replacement: String) -> Result<String, HcdError> {
    let doc = parse(xml)?;
    let Some(node) = doc
        .root_element()
        .children()
        .find(|n| n.has_tag_name((S, "pageSetup")))
    else {
        return Ok(replacement);
    };
    let mut reader = quick_xml::Reader::from_str(&xml[node.range()]);
    let element = match reader.read_event().map_err(bad)? {
        quick_xml::events::Event::Start(e) | quick_xml::events::Event::Empty(e) => e,
        _ => return Err(bad("invalid worksheet page setup")),
    };
    let mut retained = String::new();
    for attribute in element.attributes() {
        let attribute = attribute.map_err(bad)?;
        let key = std::str::from_utf8(attribute.key.as_ref()).map_err(bad)?;
        if [
            "xmlns",
            "paperSize",
            "orientation",
            "scale",
            "fitToWidth",
            "fitToHeight",
        ]
        .contains(&key)
        {
            continue;
        }
        let value = attribute
            .decode_and_unescape_value(reader.decoder())
            .map_err(bad)?;
        retained.push_str(&format!(" {key}=\"{}\"", escape(value.as_ref())));
    }
    Ok(replacement.replacen("/>", &format!("{retained}/>"), 1))
}
fn apply_print(
    bundle: &Bundle,
    manifest: &HcdManifest,
    package: &mut OxmlPackage,
    state: &OfficeFeatures,
) -> Result<(), HcdError> {
    if state.sheet_print.is_empty() {
        return Ok(());
    }
    let sheets = sheet_addresses(bundle, manifest)?;
    let native = native_workbook_sheets(package)?;
    let mut workbook = package.read_part_xml("xl/workbook.xml").map_err(bad)?;
    for (id, p) in &state.sheet_print {
        // Deleted resources keep history metadata for undo, but have no native output.
        let Some(sheet) = sheets.iter().find(|s| s.sheet_id == *id) else {
            continue;
        };
        let (index, (name, part)) = native
            .iter()
            .enumerate()
            .find(|(_, (_, part))| *part == sheet.part)
            .or_else(|| {
                native
                    .iter()
                    .enumerate()
                    .find(|(_, (name, _))| *name == sheet.sheet_name)
            })
            .ok_or_else(|| bad("Print worksheet cannot be mapped to the native package"))?;
        let mut xml = package.read_part_xml(part).map_err(bad)?;
        xml = root_child(
            &xml,
            S,
            "printOptions",
            &format!(
                r#"<printOptions xmlns="{S}" headings="{}" gridLines="{}" gridLinesSet="1" horizontalCentered="{}" verticalCentered="{}"/>"#,
                u8::from(p.headings),
                u8::from(p.gridlines),
                u8::from(p.center_horizontal),
                u8::from(p.center_vertical)
            ),
            SHEET_ORDER,
        )?;
        xml = root_child(
            &xml,
            S,
            "pageMargins",
            &format!(
                r#"<pageMargins xmlns="{S}" left="{}" right="{}" top="{}" bottom="{}" header="{}" footer="{}"/>"#,
                p.left_inches,
                p.right_inches,
                p.top_inches,
                p.bottom_inches,
                p.header_inches,
                p.footer_inches
            ),
            SHEET_ORDER,
        )?;
        let scaling = p
            .scale
            .map(|v| {
                format!(
                    " scale=\"{v}\" fitToWidth=\"{}\" fitToHeight=\"{}\"",
                    p.fit_width, p.fit_height
                )
            })
            .unwrap_or_else(|| {
                format!(
                    " fitToWidth=\"{}\" fitToHeight=\"{}\"",
                    p.fit_width, p.fit_height
                )
            });
        let setup = preserve_setup_attributes(
            &xml,
            format!(
                r#"<pageSetup xmlns="{S}" paperSize="{}" orientation="{}"{scaling}/>"#,
                p.paper_size,
                if p.landscape { "landscape" } else { "portrait" }
            ),
        )?;
        xml = root_child(&xml, S, "pageSetup", &setup, SHEET_ORDER)?;
        if !parse(&xml)?
            .root_element()
            .children()
            .any(|n| n.has_tag_name((S, "sheetPr")))
        {
            xml = root_child(
                &xml,
                S,
                "sheetPr",
                &format!(r#"<sheetPr xmlns="{S}"></sheetPr>"#),
                SHEET_ORDER,
            )?;
        }
        let doc = parse(&xml)?;
        let pr = doc
            .root_element()
            .children()
            .find(|n| n.has_tag_name((S, "sheetPr")))
            .ok_or_else(|| bad("sheet properties missing"))?
            .range();
        xml = replace_direct_child(
            &xml,
            pr,
            S,
            "pageSetUpPr",
            &format!(
                r#"<pageSetUpPr xmlns="{S}" fitToPage="{}"/>"#,
                u8::from(p.scale.is_none())
            ),
            &["tabColor", "outlinePr", "pageSetUpPr"],
        )
        .map_err(bad)?;
        package.write_part_xml(part, &xml).map_err(bad)?;
        let quote = format!("'{}'!", name.replace('\'', "''"));
        let area = p
            .print_area
            .as_ref()
            .map(|a| native_area(a).map(|r| format!("{quote}{r}")))
            .transpose()?;
        workbook = write_defined(&workbook, index, "_xlnm.Print_Area", area.as_deref())?;
        let mut titles = vec![];
        if let Some((a, b)) = p.repeat_rows {
            titles.push(format!("{quote}${a}:${b}"));
        }
        if let Some((a, b)) = p.repeat_columns {
            titles.push(format!(
                "{quote}${}:${}",
                column(u32::from(a)),
                column(u32::from(b))
            ));
        }
        workbook = write_defined(
            &workbook,
            index,
            "_xlnm.Print_Titles",
            (!titles.is_empty()).then(|| titles.join(",")).as_deref(),
        )?;
    }
    package
        .write_part_xml("xl/workbook.xml", &workbook)
        .map_err(bad)?;
    Ok(())
}
fn transition_xml(t: &SlideTransition) -> String {
    let dir = match t.direction {
        TransitionDirection::Left => "l",
        TransitionDirection::Right => "r",
        TransitionDirection::Up => "u",
        TransitionDirection::Down => "d",
    };
    let effect = match t.kind {
        TransitionKind::None => String::new(),
        TransitionKind::Fade => "<p:fade/>".into(),
        TransitionKind::Cut => "<p:cut/>".into(),
        TransitionKind::Push => format!("<p:push dir=\"{dir}\"/>"),
        TransitionKind::Wipe => format!("<p:wipe dir=\"{dir}\"/>"),
    };
    let auto = t
        .advance_after_ms
        .map(|v| format!(" advTm=\"{v}\""))
        .unwrap_or_default();
    format!(
        r#"<p:transition xmlns:p="{P}" xmlns:p14="{P14}" p14:dur="{}" spd="{}" advClick="{}"{auto}>{effect}</p:transition>"#,
        t.duration_ms,
        if t.duration_ms >= 1000 {
            "slow"
        } else if t.duration_ms >= 700 {
            "med"
        } else {
            "fast"
        },
        u8::from(t.advance_on_click)
    )
}
fn apply_transitions(
    bundle: &Bundle,
    manifest: &HcdManifest,
    package: &mut OxmlPackage,
    state: &OfficeFeatures,
) -> Result<(), HcdError> {
    let slides = slide_addresses(bundle, manifest)?;
    for (id, t) in &state.slide_transitions {
        let Some(slide) = slides.iter().find(|s| s.chunk_id == *id) else {
            continue;
        };
        let mut xml = package.read_part_xml(&slide.part).map_err(bad)?;
        // Explicit replacement removes an advanced fallback together, rather than
        // leaving two conflicting transitions in one native slide.
        let doc = parse(&xml)?;
        let remove = doc
            .root_element()
            .children()
            .filter(|n| {
                n.is_element()
                    && n.tag_name().name() == "AlternateContent"
                    && n.descendants()
                        .any(|n| n.is_element() && n.tag_name().name() == "transition")
            })
            .map(|n| (n.range(), String::new()))
            .collect();
        xml = apply_xml_edits(&xml, remove).map_err(bad)?;
        xml = root_child(
            &xml,
            P,
            "transition",
            &transition_xml(t),
            &["cSld", "clrMapOvr", "transition", "timing", "extLst"],
        )?;
        package.write_part_xml(&slide.part, &xml).map_err(bad)?;
    }
    Ok(())
}
pub(crate) fn has_managed_toc(source: &Path) -> Result<bool, HcdError> {
    Ok(control(source, "word/document.xml")?.is_some_and(|xml| xml.contains("_OfficeCLI_TOC")))
}
pub fn apply_office_features(
    bundle: &Bundle,
    target: &Path,
    revision: Option<u64>,
) -> Result<(), HcdError> {
    let (manifest, _) = manifest_at_revision(bundle, &bundle.manifest()?, revision)?;
    let state = hcd_core::office_features::read(bundle, &manifest)?;
    if state.is_empty() && !(manifest.source.format == "docx" && has_managed_toc(target)?) {
        return Ok(());
    }
    let suffix = target
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or_default();
    if !suffix.eq_ignore_ascii_case(&manifest.source.format) {
        return Ok(());
    }
    let mut package = OxmlPackage::open(
        target
            .to_str()
            .ok_or_else(|| bad("invalid native export path"))?,
        true,
    )
    .map_err(bad)?;
    match manifest.source.format.as_str() {
        "docx" => hcd_docx::apply_word_features(bundle, &mut package, manifest.revision, &state)?,
        "xlsx" => apply_print(bundle, &manifest, &mut package, &state)?,
        "pptx" => apply_transitions(bundle, &manifest, &mut package, &state)?,
        _ => return Ok(()),
    }
    package.save().map_err(bad)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(relative: &str, format: &str) -> (tempfile::TempDir, std::path::PathBuf, Bundle) {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join(format!("original.{format}"));
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join(relative),
            &source,
        )
        .unwrap();
        if format == "docx" {
            let mut package = OxmlPackage::open(source.to_str().unwrap(), true).unwrap();
            let mut xml = package.read_part_xml("word/document.xml").unwrap();
            let doc = parse(&xml).unwrap();
            let paragraph = doc
                .descendants()
                .find(|n| {
                    n.has_tag_name((
                        "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
                        "p",
                    ))
                })
                .unwrap();
            let ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
            let pr = paragraph.children().find(|n| n.has_tag_name((ns, "pPr")));
            let properties = pr.map(|n| n.range());
            if let Some(range) = properties {
                xml = replace_direct_child(
                    &xml,
                    range,
                    ns,
                    "outlineLvl",
                    &format!(r#"<w:outlineLvl xmlns:w="{ns}" w:val="0"/>"#),
                    &["pStyle", "outlineLvl"],
                )
                .unwrap();
            } else {
                let at = paragraph.range().start + xml[paragraph.range()].find('>').unwrap() + 1;
                xml.insert_str(
                    at,
                    &format!(r#"<w:pPr xmlns:w="{ns}"><w:outlineLvl w:val="0"/></w:pPr>"#),
                );
            }
            xml = xml.replacen(
                "Numbering &amp; List Showcase",
                "读📚书 &amp; List Showcase",
                1,
            );
            package.write_part_xml("word/document.xml", &xml).unwrap();
            package.save().unwrap();
        }
        let root = temp.path().join("document.hcd");
        crate::import_document(
            &source,
            &root,
            &crate::ImportOptions::new("office-features-proof"),
            |_| Ok(()),
        )
        .unwrap();
        (temp, source, Bundle::open(root).unwrap())
    }
    fn edit(bundle: &Bundle, source: &Path, action: OfficeAction) -> ApplyResult {
        let revision = bundle.manifest().unwrap().revision;
        let request = OfficeEdit {
            protocol_version: PROTOCOL.into(),
            base_revision: revision,
            patch_id: format!("office-{revision}"),
            action,
        };
        let result = edit_office_features(bundle, source, &request).unwrap();
        assert_eq!(result.revision, revision + 1);
        assert!(
            edit_office_features(bundle, source, &request)
                .unwrap()
                .idempotent_replay
        );
        let mut stale = request;
        stale.patch_id.push_str("-stale");
        assert!(matches!(
            edit_office_features(bundle, source, &stale),
            Err(HcdError::RevisionConflict(_))
        ));
        result
    }
    fn reopen(
        bundle: &Bundle,
        source: &Path,
        temp: &Path,
        name: &str,
    ) -> (std::path::PathBuf, Bundle) {
        let target = temp.join(name);
        crate::export_document(bundle.root(), source, &target, &Default::default()).unwrap();
        let root = temp.join(format!("{name}.hcd"));
        crate::import_document(
            &target,
            &root,
            &crate::ImportOptions::new("reopened-office"),
            |_| Ok(()),
        )
        .unwrap();
        (target, Bundle::open(root).unwrap())
    }
    #[test]
    fn word_margin_toc_and_unicode_footnotes_survive_native_export_and_reopen() {
        let (temp, source, bundle) = fixture("examples/word/numbering-showcase.docx", "docx");
        let initial = read_office_features(&bundle, &source, None).unwrap();
        let word = initial.word.unwrap();
        let pages = WordPageLayout {
            top_twips: 720,
            left_twips: 1080,
            right_twips: 1080,
            bottom_twips: 1008,
            ..word.sections[0].layout.clone()
        };
        edit(
            &bundle,
            &source,
            OfficeAction::WordPage {
                sections: word.sections.iter().map(|s| s.index).collect(),
                layout: pages.clone(),
            },
        );
        edit(
            &bundle,
            &source,
            OfficeAction::WordToc {
                settings: Some(WordToc {
                    title: "内容导航".into(),
                    first_level: 1,
                    last_level: 3,
                }),
            },
        );
        let projection = hcd_core::editor_projection(&bundle, None).unwrap();
        let block = projection
            .blocks
            .iter()
            .find(|b| !b.read_only && b.region == "body" && !b.content.inlines.is_empty())
            .unwrap();
        let text: String = block
            .content
            .inlines
            .iter()
            .map(|i| i.text.as_str())
            .collect();
        let chars: Vec<_> = text.chars().collect();
        let at = chars.len().min(3);
        let anchor = WordAnchor {
            block_id: block.block_id.clone(),
            offset: at,
            paragraph_hash: hcd_core::hash_bytes(text.as_bytes()),
            before: chars[..at].iter().collect(),
            after: chars[at..(at + 32).min(chars.len())].iter().collect(),
        };
        edit(
            &bundle,
            &source,
            OfficeAction::WordFootnote {
                id: "note-one".into(),
                note: WordFootnote {
                    text: Some("原生脚注 🧭\n第二行 & 引用".into()),
                    anchor: Some(anchor),
                },
            },
        );
        // A later text-only footnote edit must retain the anchor from insertion.
        edit(
            &bundle,
            &source,
            OfficeAction::WordFootnote {
                id: "note-one".into(),
                note: WordFootnote {
                    text: Some("更新脚注 🧭\n保留换行".into()),
                    anchor: None,
                },
            },
        );
        let (target, reopened) = reopen(&bundle, &source, temp.path(), "word-roundtrip.DOCX");
        let saved = read_office_features(&reopened, &target, None)
            .unwrap()
            .word
            .unwrap();
        assert_eq!(saved.sections[0].layout, pages);
        assert_eq!(saved.toc.unwrap().title, "内容导航");
        assert!(!saved.headings.is_empty());
        assert!(!saved.toc_block_ids.is_empty());
        assert_eq!(saved.footnotes.len(), 1);
        assert_eq!(saved.footnotes[0].text, "更新脚注 🧭\n保留换行");
        assert!(saved.footnotes[0].anchor.is_some());
        let xml = control(&target, "word/document.xml").unwrap().unwrap();
        assert!(xml.contains(" TOC "));
        assert!(xml.contains("footnoteReference"));
        assert_eq!(
            control(&source, "word/styles.xml").unwrap(),
            control(&target, "word/styles.xml").unwrap()
        );
        let historical = read_office_features(&bundle, &source, Some(initial.revision))
            .unwrap()
            .word
            .unwrap();
        assert_eq!(historical.sections[0].layout, word.sections[0].layout);
        assert!(historical.footnotes.is_empty());
        edit(
            &reopened,
            &target,
            OfficeAction::WordFootnote {
                id: saved.footnotes[0].id.clone(),
                note: WordFootnote {
                    text: None,
                    anchor: None,
                },
            },
        );
        edit(&reopened, &target, OfficeAction::WordToc { settings: None });
        let (removed, again) = reopen(&reopened, &target, temp.path(), "word-without-notes.docx");
        let saved = read_office_features(&again, &removed, None)
            .unwrap()
            .word
            .unwrap();
        assert!(saved.toc.is_none());
        assert!(saved.footnotes.is_empty());
    }
    #[test]
    fn worksheet_print_layout_and_titles_survive_native_export_and_reopen() {
        let (temp, source, bundle) = fixture("examples/excel/charts.xlsx", "xlsx");
        let original = read_office_features(&bundle, &source, None).unwrap();
        let sheet = &original.sheets[0];
        let layout = SheetPrintLayout {
            landscape: true,
            paper_size: 8,
            fit_width: 1,
            fit_height: 2,
            print_area: Some("A1:F22".into()),
            repeat_rows: Some((1, 2)),
            repeat_columns: Some((1, 2)),
            gridlines: true,
            headings: true,
            center_horizontal: true,
            top_inches: 0.5,
            ..Default::default()
        };
        edit(
            &bundle,
            &source,
            OfficeAction::SheetPrint {
                sheet_id: sheet.sheet_id.clone(),
                layout: layout.clone(),
            },
        );
        let (target, reopened) = reopen(&bundle, &source, temp.path(), "print-roundtrip.xlsx");
        let saved = read_office_features(&reopened, &target, None).unwrap();
        assert_eq!(saved.sheets[0].layout, layout);
        let xml = control(&target, &saved.sheets[0].part).unwrap().unwrap();
        let doc = parse(&xml).unwrap();
        let names: Vec<_> = doc
            .root_element()
            .children()
            .filter(Node::is_element)
            .map(|n| n.tag_name().name())
            .collect();
        assert!(
            names.iter().position(|n| *n == "sheetData").unwrap()
                < names.iter().position(|n| *n == "pageSetup").unwrap()
        );
        assert!(control(&target, "xl/workbook.xml")
            .unwrap()
            .unwrap()
            .contains("_xlnm.Print_Titles"));
        let scale = SheetPrintLayout {
            scale: Some(85),
            print_area: None,
            repeat_rows: None,
            repeat_columns: None,
            ..layout
        };
        edit(
            &reopened,
            &target,
            OfficeAction::SheetPrint {
                sheet_id: saved.sheets[0].sheet_id.clone(),
                layout: scale.clone(),
            },
        );
        let (target, again) = reopen(&reopened, &target, temp.path(), "print-scale.xlsx");
        assert_eq!(
            read_office_features(&again, &target, None).unwrap().sheets[0].layout,
            scale
        );
    }
    #[test]
    fn slide_transitions_keep_animation_and_reopen_with_timing() {
        let (temp, source, bundle) = fixture("examples/ppt/animations.pptx", "pptx");
        let original = read_office_features(&bundle, &source, None).unwrap();
        assert!(!original.slides.is_empty());
        let transition = SlideTransition {
            kind: TransitionKind::Push,
            direction: TransitionDirection::Up,
            duration_ms: 850,
            advance_on_click: false,
            advance_after_ms: Some(3200),
        };
        edit(
            &bundle,
            &source,
            OfficeAction::SlideTransition {
                chunk_ids: original.slides.iter().map(|s| s.chunk_id.clone()).collect(),
                transition: transition.clone(),
            },
        );
        let (target, reopened) = reopen(&bundle, &source, temp.path(), "transition-roundtrip.pptx");
        let saved = read_office_features(&reopened, &target, None).unwrap();
        for slide in &saved.slides {
            assert_eq!(slide.transition, transition);
            let before = control(&source, &slide.part).unwrap().unwrap();
            let after = control(&target, &slide.part).unwrap().unwrap();
            let a = parse(&before).unwrap();
            let b = parse(&after).unwrap();
            let timing = |d: &Document<'_>, xml: &str| {
                d.root_element()
                    .children()
                    .find(|n| n.has_tag_name((P, "timing")))
                    .map(|n| hcd_core::hash_bytes(xml[n.range()].as_bytes()))
            };
            assert_eq!(timing(&a, &before), timing(&b, &after));
        }
    }
    #[test]
    fn deleted_slides_and_sheets_do_not_leave_export_blocking_settings() {
        use serde_json::json;
        for format in ["pptx", "xlsx"] {
            let file = if format == "pptx" {
                "examples/ppt/textboxes/textboxes-basic.pptx"
            } else {
                "examples/excel/charts.xlsx"
            };
            let (temp, source, bundle) = fixture(file, format);
            if format == "xlsx" {
                let patch:hcd_core::PatchBatch=serde_json::from_value(json!({"schemaVersion":"hcd-patch/35","documentId":bundle.manifest().unwrap().document_id,"patchId":"add-print-sheet","baseRevision":0,"operations":[{"op":"xlsx.sheet.add","name":"Temporary print"}]})).unwrap();
                hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
            }
            let snapshot = read_office_features(&bundle, &source, None).unwrap();
            let (action, operation, schema) = if format == "pptx" {
                let slide = &snapshot.slides[0];
                (
                    OfficeAction::SlideTransition {
                        chunk_ids: vec![slide.chunk_id.clone()],
                        transition: SlideTransition {
                            kind: TransitionKind::Fade,
                            ..Default::default()
                        },
                    },
                    json!({"op":"pptx.slide.delete","chunkId":slide.chunk_id}),
                    "hcd-patch/42",
                )
            } else {
                let sheet = snapshot.sheets.last().unwrap();
                (
                    OfficeAction::SheetPrint {
                        sheet_id: sheet.sheet_id.clone(),
                        layout: Default::default(),
                    },
                    json!({"op":"xlsx.sheet.delete","sheetId":sheet.sheet_id}),
                    "hcd-patch/36",
                )
            };
            edit(&bundle, &source, action);
            let base = bundle.manifest().unwrap().revision;
            let patch:hcd_core::PatchBatch=serde_json::from_value(json!({"schemaVersion":schema,"documentId":bundle.manifest().unwrap().document_id,"patchId":"delete-configured-resource","baseRevision":base,"operations":[operation]})).unwrap();
            hcd_core::apply_patch(&bundle, &patch, base).unwrap();
            let (target, again) = reopen(
                &bundle,
                &source,
                temp.path(),
                &format!("deleted-settings.{format}"),
            );
            let actual = read_office_features(&again, &target, None).unwrap();
            assert_eq!(
                actual.slides.len() + actual.sheets.len(),
                snapshot.slides.len() + snapshot.sheets.len() - 1
            );
        }
    }
    #[test]
    fn removing_a_paragraph_removes_its_footnote_without_breaking_export() {
        use serde_json::json;
        let (temp, source, bundle) = fixture("examples/word/numbering-showcase.docx", "docx");
        hcd_core::project_editor(&bundle, 0).unwrap();
        let projection = hcd_core::editor_projection(&bundle, None).unwrap();
        let block = projection
            .blocks
            .iter()
            .find(|b| b.region == "body" && !b.read_only && !b.content.inlines.is_empty())
            .unwrap();
        let text: String = block
            .content
            .inlines
            .iter()
            .map(|i| i.text.as_str())
            .collect();
        let anchor = WordAnchor {
            block_id: block.block_id.clone(),
            offset: 0,
            paragraph_hash: hcd_core::hash_bytes(text.as_bytes()),
            before: String::new(),
            after: text.chars().take(32).collect(),
        };
        edit(
            &bundle,
            &source,
            OfficeAction::WordFootnote {
                id: "removed-note".into(),
                note: WordFootnote {
                    text: Some("Remove with paragraph".into()),
                    anchor: Some(anchor),
                },
            },
        );
        let base = bundle.manifest().unwrap().revision;
        let patch:hcd_core::StructurePatchBatch=serde_json::from_value(json!({"schemaVersion":"hcd-patch/4","documentId":bundle.manifest().unwrap().document_id,"patchId":"delete-note-paragraph","baseRevision":base,"operations":[{"op":"block.delete","blockId":block.block_id,"precondition":{"blockHash":block.block_hash}}]})).unwrap();
        hcd_core::apply_structure_patch(&bundle, &patch, base).unwrap();
        assert!(read_office_features(&bundle, &source, None)
            .unwrap()
            .word
            .unwrap()
            .footnotes
            .is_empty());
        let (target, again) = reopen(&bundle, &source, temp.path(), "removed-note.docx");
        assert!(read_office_features(&again, &target, None)
            .unwrap()
            .word
            .unwrap()
            .footnotes
            .is_empty());
    }
    #[test]
    fn print_setup_preserves_native_printer_flags_and_relationships() {
        let xml = format!(
            r#"<worksheet xmlns="{S}" xmlns:r="{R}"><pageSetup copies="3" blackAndWhite="1" r:id="rIdPrinter" scale="60"/></worksheet>"#
        );
        let next=preserve_setup_attributes(&xml,format!(r#"<pageSetup xmlns="{S}" paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>"#)).unwrap();
        let wrapped = format!(r#"<worksheet xmlns="{S}" xmlns:r="{R}">{next}</worksheet>"#);
        let doc = parse(&wrapped).unwrap();
        let setup = doc
            .root_element()
            .children()
            .find(Node::is_element)
            .unwrap();
        assert_eq!(setup.attribute("copies"), Some("3"));
        assert_eq!(setup.attribute("blackAndWhite"), Some("1"));
        assert_eq!(setup.attribute((R, "id")), Some("rIdPrinter"));
        assert!(setup.attribute("scale").is_none());
        let workbook =
            format!(r#"<s:workbook xmlns:s="{S}"><s:sheets/><s:definedNames/></s:workbook>"#);
        assert!(parse(
            &write_defined(&workbook, 0, "_xlnm.Print_Area", Some("'Sheet1'!$A$1:$B$2")).unwrap()
        )
        .is_ok());
    }
    #[test]
    fn print_defined_names_expand_empty_nodes_and_keep_quoted_sheet_names() {
        let xml = format!(r#"<workbook xmlns="{S}"><sheets/><definedNames/><calcPr/></workbook>"#);
        let next = write_defined(&xml, 0, "_xlnm.Print_Area", Some("'A, B''s'!$A$1:$D$7")).unwrap();
        assert!(parse(&next).is_ok());
        let layout = read_print(&format!(r#"<worksheet xmlns="{S}"/>"#), Some(&next), 0).unwrap();
        assert_eq!(layout.print_area.as_deref(), Some("A1:D7"));
        let next = write_defined(
            &next,
            0,
            "_xlnm.Print_Titles",
            Some("'A, B''s'!$1:$2,'A, B''s'!$A:$C"),
        )
        .unwrap();
        let layout = read_print(&format!(r#"<worksheet xmlns="{S}"/>"#), Some(&next), 0).unwrap();
        assert_eq!(layout.repeat_rows, Some((1, 2)));
        assert_eq!(layout.repeat_columns, Some((1, 3)));
    }
}
