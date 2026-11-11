//! Write a pinned theme into an exported Office or PDF file.
//!
//! Embedding copies TrueType or OpenType bytes only when the license allows it
//! and the face is at most 8 MiB. Otherwise the family name is registered and
//! the reason is returned for the fidelity report. Excel never receives font
//! bytes.

use hcd_core::{FontStyle, HcdError, ThemeFontAction, ThemeFontDecision};
use oxml::{OxmlPackage, PackageError};
use std::path::Path;

#[derive(Debug, Default)]
pub struct ThemeFontApplication {
    pub preserved: Vec<String>,
    pub warnings: Vec<String>,
}

pub fn apply_theme_fonts(
    target: &Path,
    format: &str,
    plan: &[ThemeFontDecision],
) -> Result<ThemeFontApplication, HcdError> {
    if plan.is_empty() {
        return Ok(ThemeFontApplication::default());
    }
    match format {
        "docx" => apply_ooxml(target, plan, OfficeKind::Word),
        "pptx" => apply_ooxml(target, plan, OfficeKind::PowerPoint),
        "xlsx" => apply_ooxml(target, plan, OfficeKind::Excel),
        "pdf" => apply_pdf(target, plan),
        _ => Ok(ThemeFontApplication::default()),
    }
}

#[derive(Clone, Copy)]
enum OfficeKind {
    Word,
    PowerPoint,
    Excel,
}

fn apply_pdf(target: &Path, plan: &[ThemeFontDecision]) -> Result<ThemeFontApplication, HcdError> {
    let mut report = ThemeFontApplication::default();
    let mut index = 0;
    for decision in plan {
        match &decision.action {
            ThemeFontAction::RegisterOnly { reason } => report.warnings.push(reason.clone()),
            ThemeFontAction::Embed { bytes, .. } => {
                index += 1;
                let name =
                    pdf_resource_name(&decision.family, decision.weight, decision.style, index);
                match pdf_handler::font_embedder::embed_font_file(target, &name, bytes) {
                    Ok(()) => report.preserved.push(format!(
                        "embedded theme font {} {} in the PDF; existing text keeps its original font encoding",
                        decision.family, decision.subfamily
                    )),
                    Err(error) => report.warnings.push(format!(
                        "{} {} was not embedded because {error}; the PDF text keeps its original fonts",
                        decision.family, decision.subfamily
                    )),
                }
            }
        }
    }
    Ok(report)
}

fn apply_ooxml(
    target: &Path,
    plan: &[ThemeFontDecision],
    kind: OfficeKind,
) -> Result<ThemeFontApplication, HcdError> {
    let path = target
        .to_str()
        .ok_or_else(|| HcdError::InvalidBundle("export path is not UTF-8".to_string()))?;
    let mut package = OxmlPackage::open(path, true).map_err(package_error)?;
    let mut report = ThemeFontApplication::default();
    let theme_prefix = match kind {
        OfficeKind::Word => "word/theme/theme",
        OfficeKind::PowerPoint => "ppt/theme/theme",
        OfficeKind::Excel => "xl/theme/theme",
    };
    if let Some(theme_part) = first_part(package.list_parts(), theme_prefix, ".xml") {
        let xml = package.read_part_xml(&theme_part).map_err(package_error)?;
        let updated = rewrite_theme_typefaces(&xml, plan);
        package
            .write_part_xml(&theme_part, &updated)
            .map_err(package_error)?;
    } else {
        report.warnings.push(
            "the package has no theme part, so the font family was not written into the theme"
                .to_string(),
        );
    }
    match kind {
        OfficeKind::Excel => register_workbook_fonts(&mut package, plan, &mut report)?,
        OfficeKind::Word => {
            update_word_doc_defaults(&mut package, plan, &mut report)?;
            embed_word_fonts(&mut package, plan, &mut report)?;
        }
        OfficeKind::PowerPoint => {
            update_presentation_defaults(&mut package, plan, &mut report)?;
            embed_powerpoint_fonts(&mut package, plan, &mut report)?;
        }
    }
    package.save().map_err(package_error)?;
    Ok(report)
}

fn register_workbook_fonts(
    package: &mut OxmlPackage,
    plan: &[ThemeFontDecision],
    report: &mut ThemeFontApplication,
) -> Result<(), HcdError> {
    let Some(styles_xml) = package.read_part_xml("xl/styles.xml").ok() else {
        report.warnings.push(
            "the workbook has no stylesheet, so the font name was not registered".to_string(),
        );
        return Ok(());
    };
    let mut xml = styles_xml;
    let mut seen = Vec::new();
    for decision in plan {
        if let ThemeFontAction::RegisterOnly { reason } = &decision.action {
            report.warnings.push(reason.clone());
        }
        if seen.contains(&decision.family) {
            continue;
        }
        seen.push(decision.family.clone());
        xml = insert_workbook_font(&xml, &decision.family);
        report.preserved.push(format!(
            "registered theme font {} in the workbook",
            decision.family
        ));
    }
    package
        .write_part_xml("xl/styles.xml", &xml)
        .map_err(package_error)?;
    Ok(())
}

fn embed_word_fonts(
    package: &mut OxmlPackage,
    plan: &[ThemeFontDecision],
    report: &mut ThemeFontApplication,
) -> Result<(), HcdError> {
    if !plan
        .iter()
        .any(|decision| matches!(decision.action, ThemeFontAction::Embed { .. }))
    {
        for decision in plan {
            if let ThemeFontAction::RegisterOnly { reason } = &decision.action {
                report.warnings.push(reason.clone());
            }
        }
        return Ok(());
    }
    let mut font_table = package
        .read_part_xml("word/fontTable.xml")
        .unwrap_or_else(|_| font_table_shell());
    font_table = ensure_xmlns_r(&font_table, "w:fonts");
    let mut rels = package
        .read_part_xml("word/_rels/fontTable.xml.rels")
        .unwrap_or_else(|_| rels_shell());
    let mut content_types = package
        .read_part_xml("[Content_Types].xml")
        .map_err(package_error)?;
    ensure_part(
        &mut content_types,
        "/word/fontTable.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml",
    );
    ensure_document_font_table(package)?;
    let mut sequence = 1;
    for decision in plan {
        match &decision.action {
            ThemeFontAction::RegisterOnly { reason } => report.warnings.push(reason.clone()),
            ThemeFontAction::Embed { bytes, .. } => {
                let tag = word_embed_tag(decision.weight, decision.style);
                let key = font_key(bytes);
                let part = format!("word/fonts/font{sequence}.odttf");
                let relation = format!("rIdHcdFont{sequence}");
                package
                    .write_part(&part, obfuscate_font(bytes, &key))
                    .map_err(package_error)?;
                ensure_part(
                    &mut content_types,
                    &format!("/{part}"),
                    "application/vnd.openxmlformats-officedocument.obfuscatedFont",
                );
                rels = insert_relationship(
                    &rels,
                    &relation,
                    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font",
                    &format!("fonts/font{sequence}.odttf"),
                );
                font_table = insert_word_embed(&font_table, &decision.family, tag, &relation, &key);
                report.preserved.push(format!(
                    "embedded theme font {} {} in the Word font table",
                    decision.family, decision.subfamily
                ));
                sequence += 1;
            }
        }
    }
    package
        .write_part_xml("word/fontTable.xml", &font_table)
        .map_err(package_error)?;
    package
        .write_part_xml("word/_rels/fontTable.xml.rels", &rels)
        .map_err(package_error)?;
    package
        .write_part_xml("[Content_Types].xml", &content_types)
        .map_err(package_error)?;
    Ok(())
}

fn embed_powerpoint_fonts(
    package: &mut OxmlPackage,
    plan: &[ThemeFontDecision],
    report: &mut ThemeFontApplication,
) -> Result<(), HcdError> {
    if !plan
        .iter()
        .any(|decision| matches!(decision.action, ThemeFontAction::Embed { .. }))
    {
        for decision in plan {
            if let ThemeFontAction::RegisterOnly { reason } = &decision.action {
                report.warnings.push(reason.clone());
            }
        }
        return Ok(());
    }
    let mut presentation = package
        .read_part_xml("ppt/presentation.xml")
        .map_err(package_error)?;
    let mut rels = package
        .read_part_xml("ppt/_rels/presentation.xml.rels")
        .unwrap_or_else(|_| rels_shell());
    let mut content_types = package
        .read_part_xml("[Content_Types].xml")
        .map_err(package_error)?;
    ensure_default(&mut content_types, "fntdata", "application/x-fontdata");
    let mut sequence = 1;
    for decision in plan {
        match &decision.action {
            ThemeFontAction::RegisterOnly { reason } => report.warnings.push(reason.clone()),
            ThemeFontAction::Embed { bytes, .. } => {
                let tag = powerpoint_embed_tag(decision.weight, decision.style);
                let part = format!("ppt/fonts/font{sequence}.fntdata");
                let relation = format!("rIdHcdFont{sequence}");
                package
                    .write_part(&part, bytes.clone())
                    .map_err(package_error)?;
                rels = insert_relationship(
                    &rels,
                    &relation,
                    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font",
                    &format!("fonts/font{sequence}.fntdata"),
                );
                presentation =
                    insert_powerpoint_embed(&presentation, &decision.family, tag, &relation);
                report.preserved.push(format!(
                    "embedded theme font {} {} in the presentation",
                    decision.family, decision.subfamily
                ));
                sequence += 1;
            }
        }
    }
    package
        .write_part_xml("ppt/presentation.xml", &presentation)
        .map_err(package_error)?;
    package
        .write_part_xml("ppt/_rels/presentation.xml.rels", &rels)
        .map_err(package_error)?;
    package
        .write_part_xml("[Content_Types].xml", &content_types)
        .map_err(package_error)?;
    Ok(())
}

fn ensure_document_font_table(package: &mut OxmlPackage) -> Result<(), HcdError> {
    let Some(rels_xml) = package.read_part_xml("word/_rels/document.xml.rels").ok() else {
        return Ok(());
    };
    if rels_xml.contains("relationships/fontTable") {
        return Ok(());
    }
    let updated = insert_relationship(
        &rels_xml,
        "rIdHcdFontTable",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable",
        "fontTable.xml",
    );
    package
        .write_part_xml("word/_rels/document.xml.rels", &updated)
        .map_err(package_error)?;
    Ok(())
}

fn rewrite_theme_typefaces(xml: &str, plan: &[ThemeFontDecision]) -> String {
    let mut xml = xml.to_string();
    for decision in plan {
        for slot in &decision.slots {
            let Some((major, tag)) = theme_slot(slot) else {
                continue;
            };
            xml = set_typeface(&xml, major, tag, &decision.family);
        }
    }
    xml
}

fn theme_slot(slot: &str) -> Option<(bool, &'static str)> {
    let (group, script) = slot.split_once('-')?;
    let major = match group {
        "major" => true,
        "minor" => false,
        _ => return None,
    };
    let tag = match script {
        "latin" => "a:latin",
        "east-asia" => "a:ea",
        "bidi" => "a:cs",
        _ => return None,
    };
    Some((major, tag))
}

const EAST_ASIA_SCRIPTS: &[&str] = &["Hans", "Hant", "Jpan", "Hang"];
const BIDI_SCRIPTS: &[&str] = &[
    "Arab", "Hebr", "Thai", "Deva", "Beng", "Gujr", "Guru", "Khmr", "Knda", "Mlym", "Orya", "Taml",
    "Telu", "Sinh", "Laoo", "Mymr", "Ethi", "Yiii", "Tibt", "Thaa", "Syrc", "Mong",
];

fn set_typeface(xml: &str, major: bool, tag: &str, family: &str) -> String {
    let open = if major {
        "<a:majorFont"
    } else {
        "<a:minorFont"
    };
    let close = if major {
        "</a:majorFont>"
    } else {
        "</a:minorFont>"
    };
    let Some(start) = xml.find(open) else {
        return xml.to_string();
    };
    let after = &xml[start..];
    let (end, mut block) = if let Some(relative_end) = after.find(close) {
        let end = start + relative_end + close.len();
        (end, xml[start..end].to_string())
    } else if let Some(tag_end) = after.find('>') {
        let element = &after[..=tag_end];
        if !element.ends_with("/>") {
            return xml.to_string();
        }
        let expanded = format!(
            "{}></{open_name}>",
            &element[..element.len() - 2],
            open_name = if major { "a:majorFont" } else { "a:minorFont" }
        );
        (start + tag_end + 1, expanded)
    } else {
        return xml.to_string();
    };
    let escaped = xml_escape(family);
    block = set_child_typeface(&block, &format!("<{tag}"), &escaped, close);
    let scripts: &[&str] = match tag {
        "a:ea" => EAST_ASIA_SCRIPTS,
        "a:cs" => BIDI_SCRIPTS,
        "a:latin" => &["Latn"],
        _ => &[],
    };
    block = rewrite_script_typefaces(&block, scripts, &escaped);
    let mut updated = String::new();
    updated.push_str(&xml[..start]);
    updated.push_str(&block);
    updated.push_str(&xml[end..]);
    updated
}

fn set_child_typeface(block: &str, marker: &str, family: &str, close: &str) -> String {
    if let Some(tag_at) = block.find(marker) {
        if let Some(element_end) = block[tag_at..].find('>').map(|offset| tag_at + offset) {
            let element = &block[tag_at..=element_end];
            if element.contains("typeface=\"") {
                return replace_once(block, tag_at, element, "typeface", family);
            }
        }
    }
    let insertion = format!("{marker} typeface=\"{family}\"/>");
    insert_before(block, close, &insertion)
}

fn rewrite_script_typefaces(block: &str, scripts: &[&str], family: &str) -> String {
    if scripts.is_empty() {
        return block.to_string();
    }
    let mut result = String::new();
    let mut rest = block;
    while let Some(start) = rest.find("<a:font ") {
        result.push_str(&rest[..start]);
        let after = &rest[start..];
        let Some(end_rel) = after.find('>') else {
            result.push_str(after);
            return result;
        };
        let mut element = after[..=end_rel].to_string();
        if attr_value(&element, "script").is_some_and(|script| scripts.contains(&script.as_str())) {
            element = set_element_attr(&element, "typeface", family);
        }
        result.push_str(&element);
        rest = &after[end_rel + 1..];
    }
    result.push_str(rest);
    result
}

fn replace_once(block: &str, tag_at: usize, element: &str, name: &str, value: &str) -> String {
    let key = format!("{name}=\"");
    let Some(attr) = element.find(&key) else {
        return block.to_string();
    };
    let value_start = tag_at + attr + key.len();
    let Some(value_end) = block[value_start..]
        .find('"')
        .map(|offset| value_start + offset)
    else {
        return block.to_string();
    };
    let mut updated = String::new();
    updated.push_str(&block[..value_start]);
    updated.push_str(value);
    updated.push_str(&block[value_end..]);
    updated
}

fn set_element_attr(element: &str, name: &str, value: &str) -> String {
    let key = format!("{name}=\"");
    if let Some(attr) = element.find(&key) {
        let value_start = attr + key.len();
        if let Some(value_end) = element[value_start..]
            .find('"')
            .map(|offset| value_start + offset)
        {
            let mut updated = String::new();
            updated.push_str(&element[..value_start]);
            updated.push_str(value);
            updated.push_str(&element[value_end..]);
            return updated;
        }
    }
    if let Some(end) = element.rfind("/>") {
        let mut updated = String::new();
        updated.push_str(&element[..end]);
        updated.push_str(&format!(" {name}=\"{value}\""));
        updated.push_str(&element[end..]);
        return updated;
    }
    element.to_string()
}

fn attr_value(element: &str, name: &str) -> Option<String> {
    let key = format!("{name}=\"");
    let start = element.find(&key)? + key.len();
    let end = start + element[start..].find('"')?;
    Some(element[start..end].to_string())
}

fn update_word_doc_defaults(
    package: &mut OxmlPackage,
    plan: &[ThemeFontDecision],
    report: &mut ThemeFontApplication,
) -> Result<(), HcdError> {
    let Some(styles) = package.read_part_xml("word/styles.xml").ok() else {
        return Ok(());
    };
    let mut styles = styles;
    let mut changed = false;
    if let Some(family) = slot_family(plan, "latin") {
        let next = set_doc_default_font(&styles, &["w:ascii", "w:hAnsi"], &family);
        changed |= next != styles;
        styles = next;
    }
    if let Some(family) = slot_family(plan, "east-asia") {
        let next = set_doc_default_font(&styles, &["w:eastAsia"], &family);
        changed |= next != styles;
        styles = next;
    }
    if let Some(family) = slot_family(plan, "bidi") {
        let next = set_doc_default_font(&styles, &["w:cs"], &family);
        changed |= next != styles;
        styles = next;
    }
    if changed {
        package
            .write_part_xml("word/styles.xml", &styles)
            .map_err(package_error)?;
        report
            .preserved
            .push("updated the Word document default font to the pinned theme".to_string());
    }
    Ok(())
}

fn update_presentation_defaults(
    package: &mut OxmlPackage,
    plan: &[ThemeFontDecision],
    report: &mut ThemeFontApplication,
) -> Result<(), HcdError> {
    let Some(presentation) = package.read_part_xml("ppt/presentation.xml").ok() else {
        return Ok(());
    };
    let Some(updated) = rewrite_default_text_style(&presentation, plan) else {
        return Ok(());
    };
    if updated != presentation {
        package
            .write_part_xml("ppt/presentation.xml", &updated)
            .map_err(package_error)?;
        report
            .preserved
            .push("pointed the presentation default text style at the pinned theme".to_string());
    }
    Ok(())
}

fn slot_family(plan: &[ThemeFontDecision], script: &str) -> Option<String> {
    let minor = format!("minor-{script}");
    let major = format!("major-{script}");
    plan.iter()
        .find(|decision| decision.slots.iter().any(|slot| slot == &minor))
        .or_else(|| {
            plan.iter()
                .find(|decision| decision.slots.iter().any(|slot| slot == &major))
        })
        .map(|decision| decision.family.clone())
}

fn theme_reference(plan: &[ThemeFontDecision], script: &str) -> Option<&'static str> {
    let minor = format!("minor-{script}");
    let major = format!("major-{script}");
    let has = |name: &str| {
        plan.iter()
            .any(|decision| decision.slots.iter().any(|slot| slot == name))
    };
    match script {
        "latin" if has(&minor) => Some("+mn-lt"),
        "latin" if has(&major) => Some("+mj-lt"),
        "east-asia" if has(&minor) => Some("+mn-ea"),
        "east-asia" if has(&major) => Some("+mj-ea"),
        "bidi" if has(&minor) => Some("+mn-cs"),
        "bidi" if has(&major) => Some("+mj-cs"),
        _ => None,
    }
}

fn set_doc_default_font(xml: &str, attributes: &[&str], family: &str) -> String {
    let Some(start) = xml.find("<w:docDefaults") else {
        return xml.to_string();
    };
    let Some(relative_end) = xml[start..].find("</w:docDefaults>") else {
        return xml.to_string();
    };
    let end = start + relative_end + "</w:docDefaults>".len();
    let mut block = xml[start..end].to_string();
    let escaped = xml_escape(family);
    if block.contains("<w:rFonts") {
        for attribute in attributes {
            block = set_rfonts_attribute(&block, attribute, &escaped);
        }
    } else if let Some(close_at) = block.find("</w:rPr>") {
        let mut tag = String::from("<w:rFonts");
        for attribute in attributes {
            tag.push_str(&format!(" {attribute}=\"{escaped}\""));
        }
        tag.push_str("/>");
        block.insert_str(close_at, &tag);
    } else {
        return xml.to_string();
    }
    let mut updated = String::new();
    updated.push_str(&xml[..start]);
    updated.push_str(&block);
    updated.push_str(&xml[end..]);
    updated
}

fn set_rfonts_attribute(block: &str, attribute: &str, family: &str) -> String {
    let Some(tag_at) = block.find("<w:rFonts") else {
        return block.to_string();
    };
    let Some(tag_end) = block[tag_at..].find('>').map(|offset| tag_at + offset) else {
        return block.to_string();
    };
    let element = block[tag_at..=tag_end].to_string();
    let updated = set_element_attr(&element, attribute, family);
    let mut result = String::new();
    result.push_str(&block[..tag_at]);
    result.push_str(&updated);
    result.push_str(&block[tag_end + 1..]);
    result
}

fn rewrite_default_text_style(xml: &str, plan: &[ThemeFontDecision]) -> Option<String> {
    let start = xml.find("<p:defaultTextStyle")?;
    let relative_end = xml[start..].find("</p:defaultTextStyle>")?;
    let end = start + relative_end + "</p:defaultTextStyle>".len();
    let mut block = xml[start..end].to_string();
    for (tag, script) in [
        ("a:latin", "latin"),
        ("a:ea", "east-asia"),
        ("a:cs", "bidi"),
    ] {
        let Some(reference) = theme_reference(plan, script) else {
            continue;
        };
        block = retarget_explicit_typefaces(&block, tag, reference);
    }
    let mut updated = String::new();
    updated.push_str(&xml[..start]);
    updated.push_str(&block);
    updated.push_str(&xml[end..]);
    Some(updated)
}

fn retarget_explicit_typefaces(block: &str, tag: &str, reference: &str) -> String {
    let marker = format!("<{tag}");
    let mut result = String::new();
    let mut rest = block;
    while let Some(start) = rest.find(&marker) {
        result.push_str(&rest[..start]);
        let after = &rest[start..];
        let Some(end_rel) = after.find('>') else {
            result.push_str(after);
            return result;
        };
        let element = &after[..=end_rel];
        let typeface = attr_value(element, "typeface").unwrap_or_default();
        if typeface.starts_with('+') {
            result.push_str(element);
        } else {
            result.push_str(&set_element_attr(element, "typeface", reference));
        }
        rest = &after[end_rel + 1..];
    }
    result.push_str(rest);
    result
}

fn insert_workbook_font(xml: &str, family: &str) -> String {
    let Some(fonts_at) = xml.find("<fonts") else {
        return xml.to_string();
    };
    let Some(close_at) = xml[fonts_at..]
        .find("</fonts>")
        .map(|offset| fonts_at + offset)
    else {
        return xml.to_string();
    };
    let escaped = xml_escape(family);
    if xml[fonts_at..close_at].contains(&format!("val=\"{escaped}\"")) {
        return xml.to_string();
    }
    let mut xml = xml.to_string();
    let element = format!("<font><name val=\"{escaped}\"/></font>");
    let close_at = xml[fonts_at..]
        .find("</fonts>")
        .map(|offset| fonts_at + offset);
    if let Some(close_at) = close_at {
        xml.insert_str(close_at, &element);
    }
    bump_count(&mut xml, "<fonts", 1);
    xml
}

fn bump_count(xml: &mut String, tag: &str, amount: i64) {
    let Some(tag_at) = xml.find(tag) else {
        return;
    };
    let Some(end) = xml[tag_at..].find('>').map(|offset| tag_at + offset) else {
        return;
    };
    let head = &xml[tag_at..end];
    let Some(count_at) = head.find("count=\"") else {
        return;
    };
    let value_start = tag_at + count_at + "count=\"".len();
    let Some(value_end) = xml[value_start..]
        .find('"')
        .map(|offset| value_start + offset)
    else {
        return;
    };
    if let Ok(count) = xml[value_start..value_end].parse::<i64>() {
        xml.replace_range(value_start..value_end, &(count + amount).to_string());
    }
}

fn insert_word_embed(xml: &str, family: &str, tag: &str, relation: &str, key: &str) -> String {
    let escaped = xml_escape(family);
    let embed = format!("<{tag} r:id=\"{relation}\" w:fontKey=\"{{{key}}}\"/>");
    let marker = format!("w:name=\"{escaped}\"");
    if let Some(name_at) = xml.find(&marker) {
        let Some(end) = xml[name_at..]
            .find("</w:font>")
            .map(|offset| name_at + offset)
        else {
            return xml.to_string();
        };
        if xml[name_at..end].contains(&format!("<{tag} ")) {
            return xml.to_string();
        }
        let mut updated = String::new();
        updated.push_str(&xml[..end]);
        updated.push_str(&embed);
        updated.push_str(&xml[end..]);
        return updated;
    }
    let font = format!("<w:font w:name=\"{escaped}\">{embed}</w:font>");
    insert_before(xml, "</w:fonts>", &font)
}

fn insert_powerpoint_embed(xml: &str, family: &str, tag: &str, relation: &str) -> String {
    let escaped = xml_escape(family);
    let face = format!("<{tag} r:id=\"{relation}\"/>");
    if xml.contains("<p:embeddedFontLst>") {
        let entry =
            format!("<p:embeddedFont><p:font typeface=\"{escaped}\"/>{face}</p:embeddedFont>");
        return insert_before(xml, "</p:embeddedFontLst>", &entry);
    }
    let list = format!(
        "<p:embeddedFontLst><p:embeddedFont><p:font typeface=\"{escaped}\"/>{face}</p:embeddedFont></p:embeddedFontLst>"
    );
    insert_before(xml, "</p:presentation>", &list)
}

fn insert_relationship(xml: &str, id: &str, kind: &str, target: &str) -> String {
    if xml.contains(&format!("Id=\"{id}\"")) {
        return xml.to_string();
    }
    let relationship = format!("<Relationship Id=\"{id}\" Type=\"{kind}\" Target=\"{target}\"/>");
    insert_before(xml, "</Relationships>", &relationship)
}

fn insert_before(xml: &str, marker: &str, insertion: &str) -> String {
    let Some(index) = xml.rfind(marker) else {
        return xml.to_string();
    };
    let mut updated = String::new();
    updated.push_str(&xml[..index]);
    updated.push_str(insertion);
    updated.push_str(&xml[index..]);
    updated
}

fn ensure_part(xml: &mut String, part_name: &str, content_type: &str) {
    if xml.contains(&format!("PartName=\"{part_name}\"")) {
        return;
    }
    let override_part =
        format!("<Override PartName=\"{part_name}\" ContentType=\"{content_type}\"/>");
    *xml = insert_before(xml, "</Types>", &override_part);
}

fn ensure_default(xml: &mut String, extension: &str, content_type: &str) {
    if xml.contains(&format!("Extension=\"{extension}\"")) {
        return;
    }
    let default = format!("<Default Extension=\"{extension}\" ContentType=\"{content_type}\"/>");
    *xml = insert_before(xml, "</Types>", &default);
}

fn ensure_xmlns_r(xml: &str, root: &str) -> String {
    if xml.contains("xmlns:r=") {
        return xml.to_string();
    }
    let needle = format!("<{root}");
    let Some(index) = xml.find(&needle) else {
        return xml.to_string();
    };
    let insert_at = index + needle.len();
    let mut updated = String::new();
    updated.push_str(&xml[..insert_at]);
    updated.push_str(
        " xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"",
    );
    updated.push_str(&xml[insert_at..]);
    updated
}

fn font_table_shell() -> String {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:fonts xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"></w:fonts>".to_string()
}

fn rels_shell() -> String {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>".to_string()
}

fn word_embed_tag(weight: u16, style: FontStyle) -> &'static str {
    embed_tag(
        weight,
        style,
        "w:embedBoldItalic",
        "w:embedBold",
        "w:embedItalic",
        "w:embedRegular",
    )
}

fn powerpoint_embed_tag(weight: u16, style: FontStyle) -> &'static str {
    embed_tag(
        weight,
        style,
        "p:boldItalic",
        "p:bold",
        "p:italic",
        "p:regular",
    )
}

fn embed_tag(
    weight: u16,
    style: FontStyle,
    bold_italic: &'static str,
    bold: &'static str,
    italic: &'static str,
    regular: &'static str,
) -> &'static str {
    let bold_face = weight >= 700;
    let italic_face = matches!(style, FontStyle::Italic | FontStyle::Oblique);
    match (bold_face, italic_face) {
        (true, true) => bold_italic,
        (true, false) => bold,
        (false, true) => italic,
        (false, false) => regular,
    }
}

fn font_key(bytes: &[u8]) -> String {
    let digest = hcd_core::hash_bytes(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &digest[0..8],
        &digest[8..12],
        &digest[12..16],
        &digest[16..20],
        &digest[20..32]
    )
    .to_ascii_uppercase()
}

fn obfuscate_font(bytes: &[u8], font_key: &str) -> Vec<u8> {
    let key = guid_key(font_key);
    let mut obfuscated = bytes.to_vec();
    for index in 0..32.min(obfuscated.len()) {
        obfuscated[index] ^= key[index % 16];
    }
    obfuscated
}

fn guid_key(font_key: &str) -> [u8; 16] {
    let hex: String = font_key
        .chars()
        .filter(|character| character.is_ascii_hexdigit())
        .collect();
    let mut raw = [0u8; 16];
    for index in 0..16 {
        raw[index] = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).unwrap_or(0);
    }
    let mut key = [0u8; 16];
    for index in 0..16 {
        key[index] = raw[15 - index];
    }
    key
}

fn pdf_resource_name(family: &str, weight: u16, style: FontStyle, index: usize) -> String {
    let mut name = String::from("Hcd");
    for character in family.chars() {
        if character.is_ascii_alphanumeric() {
            name.push(character);
        }
    }
    if weight >= 700 {
        name.push_str("Bold");
    }
    if matches!(style, FontStyle::Italic | FontStyle::Oblique) {
        name.push_str("Italic");
    }
    if name == "Hcd" {
        name.push_str(&index.to_string());
    }
    name
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn first_part(parts: Vec<&String>, prefix: &str, suffix: &str) -> Option<String> {
    let mut names: Vec<&String> = parts
        .into_iter()
        .filter(|part| part.starts_with(prefix) && part.ends_with(suffix))
        .collect();
    names.sort();
    names.first().map(|part| (*part).clone())
}

fn package_error(error: PackageError) -> HcdError {
    HcdError::InvalidBundle(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hcd_core::{FontFileFormat, FontStyle};
    use std::fs::File;
    use std::io::Write;

    fn decision(action: ThemeFontAction) -> ThemeFontDecision {
        ThemeFontDecision {
            slots: vec!["major-latin".to_string(), "minor-east-asia".to_string()],
            family: "Source Han Sans".to_string(),
            subfamily: "Regular".to_string(),
            weight: 400,
            style: FontStyle::Normal,
            action,
        }
    }

    fn write_zip(path: &Path, parts: &[(&str, &str)]) {
        let file = File::create(path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, body) in parts {
            archive.start_file(*name, options).unwrap();
            archive.write_all(body.as_bytes()).unwrap();
        }
        archive.finish().unwrap();
    }

    fn part(path: &Path, name: &str) -> Vec<u8> {
        let file = File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut entry = archive.by_name(name).unwrap();
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut bytes).unwrap();
        bytes
    }

    #[test]
    fn word_embed_obfuscates_the_face_and_registers_a_denied_family() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("demo.docx");
        write_zip(
            &path,
            &[
                (
                    "[Content_Types].xml",
                    r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
                ),
                (
                    "_rels/.rels",
                    r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
                ),
                ("word/document.xml", "<w:document/>"),
                (
                    "word/_rels/document.xml.rels",
                    r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>"#,
                ),
                (
                    "word/theme/theme1.xml",
                    r#"<a:theme><a:themeElements><a:fontScheme><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="等线"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:font script="Hans" typeface="宋体"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>"#,
                ),
                (
                    "word/styles.xml",
                    r#"<w:styles><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Arial"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>"#,
                ),
            ],
        );
        let bytes = b"fake-otf-bold-face-bytes-0123456789";
        let embedded = decision(ThemeFontAction::Embed {
            format: FontFileFormat::Otf,
            bytes: bytes.to_vec(),
        });
        let mut denied = decision(ThemeFontAction::RegisterOnly {
            reason: "Source Han Sans license ooxmlEmbed is false, so the font bytes were not embedded; the family name is still registered".to_string(),
        });
        denied.family = "License Denied".to_string();
        denied.slots = vec!["minor-latin".to_string()];
        let report = apply_theme_fonts(&path, "docx", &[embedded, denied]).unwrap();
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.contains("ooxmlEmbed is false")));
        let theme = String::from_utf8(part(&path, "word/theme/theme1.xml")).unwrap();
        assert!(theme.contains("typeface=\"Source Han Sans\""));
        assert!(theme.contains("typeface=\"License Denied\""));
        assert!(theme.contains("script=\"Hans\" typeface=\"等线\""));
        assert!(theme.contains("script=\"Hans\" typeface=\"Source Han Sans\""));
        let styles = String::from_utf8(part(&path, "word/styles.xml")).unwrap();
        assert!(styles.contains("w:ascii=\"License Denied\""));
        assert!(styles.contains("w:hAnsi=\"License Denied\""));
        assert!(styles.contains("w:eastAsia=\"Source Han Sans\""));
        assert!(styles.contains("w:cs=\"Arial\""));
        let stored = part(&path, "word/fonts/font1.odttf");
        let key = font_key(bytes);
        assert_eq!(obfuscate_font(&stored, &key), bytes);
        assert!(String::from_utf8(part(&path, "word/fontTable.xml"))
            .unwrap()
            .contains(&format!("w:fontKey=\"{{{key}}}\"")));
        assert!(!zip_names(&path).iter().any(|name| name.contains("License")));
    }

    #[test]
    fn powerpoint_stores_raw_font_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("demo.pptx");
        write_zip(
            &path,
            &[
                (
                    "[Content_Types].xml",
                    r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>"#,
                ),
                ("_rels/.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"/>"),
                (
                    "ppt/presentation.xml",
                    r#"<p:presentation><p:defaultTextStyle><a:lvl1pPr><a:defRPr><a:latin typeface="Calibri"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr></p:defaultTextStyle></p:presentation>"#,
                ),
                (
                    "ppt/_rels/presentation.xml.rels",
                    "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>",
                ),
                (
                    "ppt/theme/theme1.xml",
                    "<a:fontScheme><a:majorFont><a:latin typeface=\"Arial\"/><a:font script=\"Hans\" typeface=\"等线\"/></a:majorFont><a:minorFont/></a:fontScheme>",
                ),
            ],
        );
        let bytes = b"pptx-font-bytes";
        apply_theme_fonts(
            &path,
            "pptx",
            &[decision(ThemeFontAction::Embed {
                format: FontFileFormat::Ttf,
                bytes: bytes.to_vec(),
            })],
        )
        .unwrap();
        assert_eq!(part(&path, "ppt/fonts/font1.fntdata"), bytes);
        let presentation = String::from_utf8(part(&path, "ppt/presentation.xml")).unwrap();
        assert!(presentation.contains("p:regular"));
        assert!(presentation.contains("typeface=\"+mj-lt\""));
        assert!(presentation.contains("typeface=\"+mn-ea\""));
        let theme = String::from_utf8(part(&path, "ppt/theme/theme1.xml")).unwrap();
        assert!(theme.contains("typeface=\"Source Han Sans\""));
        assert!(theme.contains("script=\"Hans\" typeface=\"等线\""));
    }

    #[test]
    fn workbook_registers_the_name_without_font_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("demo.xlsx");
        write_zip(
            &path,
            &[
                (
                    "[Content_Types].xml",
                    r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>"#,
                ),
                ("_rels/.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"/>"),
                (
                    "xl/styles.xml",
                    r#"<styleSheet><fonts count="1"><font><name val="Calibri"/></font></fonts></styleSheet>"#,
                ),
                (
                    "xl/theme/theme1.xml",
                    "<a:fontScheme><a:majorFont><a:latin typeface=\"Calibri\"/></a:majorFont><a:minorFont><a:ea typeface=\"\"/></a:minorFont></a:fontScheme>",
                ),
            ],
        );
        let report = apply_theme_fonts(
            &path,
            "xlsx",
            &[decision(ThemeFontAction::RegisterOnly {
                reason: "xlsx export registers the font name and does not embed font bytes"
                    .to_string(),
            })],
        )
        .unwrap();
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.contains("does not embed font bytes")));
        let styles = String::from_utf8(part(&path, "xl/styles.xml")).unwrap();
        assert!(styles.contains("val=\"Source Han Sans\""));
        assert!(styles.contains("count=\"2\""));
        assert!(!zip_names(&path)
            .iter()
            .any(|name| name.ends_with(".fntdata") || name.ends_with(".odttf")));
    }

    fn zip_names(path: &Path) -> Vec<String> {
        let file = File::open(path).unwrap();
        let archive = zip::ZipArchive::new(file).unwrap();
        archive.file_names().map(|name| name.to_string()).collect()
    }

    #[test]
    fn guid_obfuscation_reverses_the_spec_key() {
        let key = guid_key("001B70DC-AA60-4AD5-90EC-18A0948E1EAE");
        assert_eq!(
            key,
            [
                0xAE, 0x1E, 0x8E, 0x94, 0xA0, 0x18, 0xEC, 0x90, 0xD5, 0x4A, 0x60, 0xAA, 0xDC, 0x70,
                0x1B, 0x00
            ]
        );
        let original = b"0123456789abcdef0123456789abcdefTAIL";
        assert_eq!(
            obfuscate_font(
                &obfuscate_font(original, "001B70DC-AA60-4AD5-90EC-18A0948E1EAE"),
                "001B70DC-AA60-4AD5-90EC-18A0948E1EAE"
            ),
            original
        );
    }
}
