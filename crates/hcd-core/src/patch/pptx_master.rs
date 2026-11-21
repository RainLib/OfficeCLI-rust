use super::*;
use crate::pptx_design::*;

/// Update derived presentation only. These values must not become direct native
/// run edits: the exporter writes the shared master and retains run inheritance.
pub(super) fn update_master_text(
    html: &mut String,
    part: &str,
    update: &PptxMasterTextStyle,
) -> Result<bool, HcdError> {
    let Some(mut design) = read_pptx_design(html)? else {
        return Ok(false);
    };
    if design.master_part != part {
        return Ok(false);
    }
    if design.master_text_styles.is_empty() {
        return Err(HcdError::Unsupported(
            "re-import the native PPTX to obtain master text inheritance metadata".into(),
        ));
    }
    let marker = format!(" data-hcd-master-kind=\"{}\"", update.kind.as_str());
    let mut cursor = 0;
    while let Some(at) = html[cursor..].find(&marker).map(|at| cursor + at) {
        let start = html[..at]
            .rfind('<')
            .ok_or_else(|| HcdError::InvalidBundle("master run tag is missing".into()))?;
        let end = at
            + html[at..]
                .find('>')
                .ok_or_else(|| HcdError::InvalidBundle("master run tag is incomplete".into()))?;
        let mut tag = html[start..=end].to_owned();
        cursor = end + 1;
        if xlsx_attribute(&tag, "data-hcd-master-level").and_then(|s| s.parse::<u8>().ok())
            != Some(update.level)
        {
            continue;
        }
        let mask = xlsx_attribute(&tag, "data-hcd-master-mask")
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(0);
        let close = matching_html_close(html, end, "span")?;
        let inside = &html[end + 1..close];
        // Imported a:r has one a:t. Only explicitly edited attributes block
        // later master changes; an unchanged inherited value is not an override.
        let direct = if let Some(at) = inside.find("data-hcd-run-edited=\"true\"") {
            let begin = inside[..at].rfind('<').unwrap_or(0);
            let finish = at + inside[at..].find('>').unwrap_or(0);
            pptx::pptx_format_from_tag(&inside[begin..=finish])?
        } else {
            PptxRunFormat::default()
        };
        let applies = |bit, overridden: bool| mask & bit != 0 && !overridden;
        let format = PptxRunFormat {
            bold: update
                .format
                .bold
                .filter(|_| applies(MASTER_BOLD, direct.bold.is_some())),
            italic: update
                .format
                .italic
                .filter(|_| applies(MASTER_ITALIC, direct.italic.is_some())),
            underline: update
                .format
                .underline
                .filter(|_| applies(MASTER_UNDERLINE, direct.underline.is_some())),
            font_size_pt: update
                .format
                .font_size_pt
                .filter(|_| applies(MASTER_SIZE, direct.font_size_pt.is_some())),
            color: update
                .format
                .color
                .clone()
                .filter(|_| applies(MASTER_COLOR, direct.color.is_some())),
        };
        pptx::apply_run_css(&mut tag, &format)?;
        if let Some(font) = &update.font {
            for (name, value, bit) in [
                ("latin", &font.latin, MASTER_LATIN),
                ("ea", &font.east_asia, MASTER_EAST_ASIA),
                ("cs", &font.bidi, MASTER_BIDI),
            ] {
                if let Some(value) = value.as_deref().filter(|_| mask & bit != 0) {
                    set_tag_attribute(&mut tag, &format!("data-hcd-master-font-{name}"), value);
                }
            }
            let fonts = ["latin", "ea", "cs"]
                .into_iter()
                .filter_map(|name| {
                    xlsx_attribute(&tag, &format!("data-hcd-master-font-{name}"))
                        .map(unescape_attribute)
                        .filter(|font| safe_font_family(font).is_some())
                        .map(|font| format!("'{font}'"))
                })
                .collect::<Vec<_>>();
            if !fonts.is_empty() {
                update_start_tag_style(
                    &mut tag,
                    "class=\"hcd-ppt-run\"",
                    &BTreeMap::from([(
                        "font-family".into(),
                        format!("{},Arial,sans-serif", fonts.join(",")),
                    )]),
                    false,
                )?;
            }
        }
        html.replace_range(start..=end, &tag);
        cursor = start + tag.len();
    }
    upsert_master_text(&mut design.master_text_styles, update);
    write_pptx_design(html, &design)?;
    Ok(true)
}
