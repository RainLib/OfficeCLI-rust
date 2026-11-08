//! Print-only adaptation of transparent OfficeCLI-owned inline media wrappers.
//! Styled/authored wrappers and canonical HTML are left intact.
use super::{html_tag_end, parse_tag, update_raw_text_element};

pub(super) struct PrintMedia {
    pub html: String,
    pub image_sources: Vec<String>,
}
struct Span {
    start: usize,
    end: usize,
    transparent: bool,
    media: bool,
}
impl PrintMedia {
    pub(super) fn prepare(source: &str) -> Self {
        let mut spans: Vec<Span> = Vec::new();
        let mut removed = Vec::new();
        let mut images = Vec::new();
        let mut cursor = 0;
        let mut raw = None;
        while let Some(relative) = source[cursor..].find('<') {
            let start = cursor + relative;
            if source[start..].starts_with("<!--") {
                cursor = source[start..]
                    .find("-->")
                    .map_or(source.len(), |end| start + end + 3);
                continue;
            }
            let end = html_tag_end(source, start).unwrap_or(source.len());
            let token = &source[start..end];
            if raw.is_none() && token.ends_with('>') && token.len() >= 2 {
                if let Some(tag) = parse_tag(&token[1..token.len() - 1]) {
                    match (tag.name.as_str(), tag.closing, tag.self_closing) {
                        ("span", false, false) => {
                            let transparent = tag.attributes.get("class").is_some_and(|classes| {
                                !classes.trim().is_empty()
                                    && classes.split_ascii_whitespace().all(|c| {
                                        matches!(c, "hcd-run" | "hcd-extension-export-media")
                                    })
                            }) && !tag.attributes.contains_key("hidden")
                                && tag
                                    .attributes
                                    .get("style")
                                    .is_none_or(|s| s.trim().is_empty());
                            spans.push(Span {
                                start,
                                end,
                                transparent,
                                media: false,
                            });
                        }
                        ("span", true, _) => {
                            if let Some(span) = spans.pop() {
                                if span.transparent && span.media {
                                    removed.push((span.start, span.end));
                                    removed.push((start, end));
                                }
                            }
                        }
                        ("img", false, _) => {
                            if let Some(src) = tag.attributes.get("src") {
                                images.push(src.clone());
                            }
                            for span in &mut spans {
                                span.media = true;
                            }
                        }
                        _ => {}
                    }
                }
            }
            if token.len() >= 2 {
                update_raw_text_element(token, &mut raw);
            }
            cursor = end;
        }
        removed.sort_unstable();
        let mut html = String::with_capacity(source.len());
        cursor = 0;
        for (start, end) in removed {
            html.push_str(&source[cursor..start]);
            cursor = end;
        }
        html.push_str(&source[cursor..]);
        Self {
            html,
            image_sources: images,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_transparent_owned_media_wrappers_are_adapted() {
        let input="<p><span class='hcd-run'>text</span><span class=\"hcd-run\"><img src=\"asset://one\"/></span><span class=\"other\"><img src=\"two\"/></span><span class=\"hcd-run\" style=\"display:none\"><img src=\"hidden\"/></span></p>";
        let prepared = PrintMedia::prepare(input);
        assert_eq!(prepared.html,"<p><span class='hcd-run'>text</span><img src=\"asset://one\"/><span class=\"other\"><img src=\"two\"/></span><span class=\"hcd-run\" style=\"display:none\"><img src=\"hidden\"/></span></p>");
        assert_eq!(prepared.image_sources.len(), 3);
        let malformed = "<p>trailing <";
        assert_eq!(PrintMedia::prepare(malformed).html, malformed);
        let truncated_unicode = "<p>trailing <中";
        assert_eq!(
            PrintMedia::prepare(truncated_unicode).html,
            truncated_unicode
        );
        let styled = "<span class='hcd-run authored'><img src='x'/></span>";
        assert_eq!(PrintMedia::prepare(styled).html, styled);
        let empty_class = "<span class=''><img src='x'/></span>";
        assert_eq!(PrintMedia::prepare(empty_class).html, empty_class);
        let raw = "<script>\"<span class='hcd-run'><img src='fake'/></span>\"</script>";
        assert_eq!(PrintMedia::prepare(raw).html, raw);
    }
}
