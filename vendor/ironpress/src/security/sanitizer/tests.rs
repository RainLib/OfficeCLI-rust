use super::*;

#[test]
fn removes_script_tags() {
    let result = sanitize_html("<p>Hello</p><script>alert('xss')</script><p>World</p>").unwrap();
    assert!(!result.contains("script"));
    assert!(!result.contains("alert"));
    assert!(result.contains("Hello"));
    assert!(result.contains("World"));
}

#[test]
fn removes_iframe() {
    let result = sanitize_html(r#"<p>Hi</p><iframe src="evil.com"></iframe>"#).unwrap();
    assert!(!result.contains("iframe"));
}

#[test]
fn removes_event_handlers() {
    let result = sanitize_html(r#"<p onclick="alert('xss')">Hello</p>"#).unwrap();
    assert!(!result.contains("onclick"));
    assert!(!result.contains("alert"));
}

#[test]
fn preserves_attribute_value_token_starting_with_on() {
    // Regression: the onXXX stripper must not treat a class token that
    // happens to start with "on" (e.g. `one`, preceded by a space inside a
    // quoted value) as an event handler. Doing so deleted the token and its
    // closing quote, corrupting every following tag.
    let result =
        sanitize_html(r#"<span class="chip one"></span><span class="chip two"></span>"#).unwrap();
    assert!(result.contains(r#"class="chip one""#), "got: {result}");
    assert!(result.contains(r#"class="chip two""#), "got: {result}");
}

#[test]
fn preserves_single_quoted_on_token() {
    let result = sanitize_html(r#"<span class='chip one'>x</span>"#).unwrap();
    assert!(result.contains("class='chip one'"), "got: {result}");
}

#[test]
fn still_removes_event_handler_among_other_attributes() {
    let result = sanitize_html(r#"<div class="one" onclick="bad()" id="x">Hi</div>"#).unwrap();
    assert!(!result.contains("onclick"));
    assert!(!result.contains("bad()"));
    assert!(result.contains(r#"class="one""#), "got: {result}");
    assert!(result.contains(r#"id="x""#), "got: {result}");
}

#[test]
fn removes_javascript_urls() {
    let result = sanitize_html(r#"<a href="javascript:alert('xss')">Click</a>"#).unwrap();
    assert!(!result.contains("javascript:"));
}

#[test]
fn preserves_safe_html() {
    let html = "<h1>Title</h1><p>Hello <strong>World</strong></p>";
    let result = sanitize_html(html).unwrap();
    assert_eq!(result, html);
}

#[test]
fn rejects_oversized_input() {
    let huge = "x".repeat(MAX_INPUT_SIZE + 1);
    assert!(sanitize_html(&huge).is_err());
}

#[test]
fn nesting_depth_check() {
    assert_eq!(check_nesting_depth("<a><b><c></c></b></a>"), 3);
    assert_eq!(check_nesting_depth("<p>Hello</p>"), 1);
}

#[test]
fn rejects_excessive_nesting() {
    let html = "<div>".repeat(501) + &"</div>".repeat(501);
    let result = sanitize_html(&html);
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("nesting depth"));
}

#[test]
fn removes_self_closing_embed() {
    let result = sanitize_html(r#"<p>Hi</p><embed src="evil.swf" />"#).unwrap();
    assert!(!result.contains("embed"));
}

#[test]
fn removes_unclosed_object_tag() {
    let result = sanitize_html(r#"<p>Hi</p><object data="evil.swf"><p>inner</p>"#).unwrap();
    assert!(!result.contains("object"));
}

#[test]
fn removes_unquoted_event_handler() {
    let result = sanitize_html(r#"<p onclick=alert(1)>Hello</p>"#).unwrap();
    assert!(!result.contains("onclick"));
    assert!(result.contains("Hello"));
}

#[test]
fn removes_form_tag() {
    let result = sanitize_html(r#"<form action="/submit"><input></form>"#).unwrap();
    assert!(!result.contains("form"));
}

#[test]
fn sanitizes_style_tag() {
    let result = sanitize_html(r#"<style>body { color: red }</style><p>Hi</p>"#).unwrap();
    // Style tags are preserved but sanitized
    assert!(result.contains("<style>"));
    assert!(result.contains("color: red"));
    assert!(result.contains("Hi"));
}

#[test]
fn sanitizes_dangerous_css() {
    let result = sanitize_html(
            r#"<style>body { background: url(http://evil.com/track.png); } @import "evil.css";</style>"#,
        )
        .unwrap();
    assert!(!result.contains("@import"));
    assert!(!result.contains("url(http"));
}

#[test]
fn unclosed_tag_no_gt() {
    // Tag with no closing > — hits the break in the else branch
    let result = sanitize_html("<p>Hi</p><embed src=x").unwrap();
    // Should handle gracefully
    assert!(result.contains("Hi"));
}

#[test]
fn event_handler_with_whitespace_before_value() {
    let result = sanitize_html(r#"<div onmouseover = "alert(1)">Hi</div>"#).unwrap();
    assert!(!result.contains("onmouseover"));
    assert!(result.contains("Hi"));
}

#[test]
fn style_tag_unclosed_opening() {
    // Lines 105-106: style tag with no closing '>'
    let result = sanitize_html("<style body { color: red ").unwrap();
    // Should handle gracefully without panicking
    assert!(result.contains("style"));
}

#[test]
fn dangerous_url_without_close_paren() {
    // Lines 128-129, 135: url() without closing paren
    let result =
        sanitize_html(r#"<style>body { background: url(http://evil.com }</style>"#).unwrap();
    assert!(!result.contains("url(http"));
}

#[test]
fn data_uri_preserved() {
    // Line 128-129: data: URIs are safe and preserved
    let css = r#"<style>body { background: url(data:image/png;base64,abc) }</style>"#;
    let result = sanitize_html(css).unwrap();
    assert!(result.contains("data:image/png;base64,abc"));
}

#[test]
fn fragment_url_reference_preserved() {
    // Same-document fragment references `url(#id)` are safe and preserved so
    // `filter: url(#id)` (css-filter-effects-1 §3) can resolve to an inline
    // SVG <filter>. Quoted and external forms still behave as before.
    let css = r#"<style>.b { filter: url(#sat); }</style>"#;
    assert!(sanitize_html(css).unwrap().contains("#sat"));
    let quoted = r##"<style>.b { filter: url("#sat"); }</style>"##;
    assert!(sanitize_html(quoted).unwrap().contains("url(\"#sat\")"));
    let external = r#"<style>.b { background: url(http://evil.com/x.png); }</style>"#;
    assert!(!sanitize_html(external).unwrap().contains("url(http"));
}

#[test]
fn local_relative_font_face_url_requires_an_authorized_root() {
    let css = r#"<style>@font-face { font-family: F; src: url('../fonts/F.ttf'); }</style>"#;
    assert!(sanitize_html(css).unwrap().contains(r#"url("")"#));

    let bare = r#"<style>@font-face { font-family: F; src: url(fonts/F.ttf); }</style>"#;
    assert!(sanitize_html(bare).unwrap().contains(r#"url("")"#));

    let remote = r#"<style>@font-face { src: url(https://evil.com/F.ttf); }</style>"#;
    assert!(!sanitize_html(remote).unwrap().contains("url(http"));
    let proto_rel = r#"<style>@font-face { src: url(//evil.com/F.ttf); }</style>"#;
    assert!(!sanitize_html(proto_rel).unwrap().contains("url(//"));
}

#[test]
fn authorized_local_font_face_url_is_canonicalized() {
    let directory = tempfile::tempdir().expect("temporary resource root");
    let font = directory.path().join("F.ttf");
    std::fs::write(&font, b"font").expect("font fixture");
    let resources = DocumentResources::new(Some(directory.path()), None, NetworkPolicy::default());
    let css = r#"<style>@font-face { font-family: F; src: url("F.ttf"); }</style>"#;
    let sanitized = sanitize_html_with_resources(css, &resources).expect("sanitized HTML");
    assert!(
        sanitized.contains(&font.to_string_lossy().replace('\\', "\\\\")),
        "got: {sanitized}"
    );
}

#[test]
fn parsed_resource_attributes_share_the_authorized_root_boundary() {
    fn collect_attributes<'a>(
        nodes: &'a [DomNode],
        raw_tag_name: &str,
        out: &mut Vec<&'a std::collections::HashMap<String, String>>,
    ) {
        for node in nodes {
            let DomNode::Element(element) = node else {
                continue;
            };
            if element.raw_tag_name == raw_tag_name {
                out.push(&element.attributes);
            }
            collect_attributes(&element.children, raw_tag_name, out);
        }
    }

    let directory = tempfile::tempdir().expect("temporary resource root");
    std::fs::write(directory.path().join("allowed.png"), b"png").expect("allowed fixture");
    let outside = tempfile::tempdir().expect("outside directory");
    std::fs::write(outside.path().join("private.png"), b"private").expect("private fixture");
    let resources = DocumentResources::new(Some(directory.path()), None, NetworkPolicy::default());
    let html = format!(
        r#"<img id="allowed" src="allowed.png" style="background:url(allowed.png)">
                <img id="denied" src="{}" style="mask-image:url('{}')">
                <svg><image id="svg-denied" href="{}"/></svg>"#,
        outside.path().join("private.png").display(),
        outside.path().join("private.png").display(),
        outside.path().join("private.png").display(),
    );
    let mut parsed =
        crate::parser::html::parse_html_with_styles(&html).expect("resource fixture HTML");
    sanitize_dom_resources(&mut parsed.nodes, &resources);

    let mut images = Vec::new();
    collect_attributes(&parsed.nodes, "img", &mut images);
    let allowed = images
        .iter()
        .find(|attributes| attributes.get("id").is_some_and(|id| id == "allowed"))
        .expect("allowed image");
    assert!(std::path::Path::new(allowed.get("src").expect("authorized source")).is_absolute());
    assert!(
        allowed
            .get("style")
            .is_some_and(|style| style.contains("allowed.png"))
    );

    let denied = images
        .iter()
        .find(|attributes| attributes.get("id").is_some_and(|id| id == "denied"))
        .expect("denied image");
    assert!(!denied.contains_key("src"));
    assert_eq!(
        denied.get("style").map(String::as_str),
        Some(r#"mask-image:url("")"#)
    );

    let mut svg_images = Vec::new();
    collect_attributes(&parsed.nodes, "image", &mut svg_images);
    assert_eq!(svg_images.len(), 1);
    assert!(!svg_images[0].contains_key("href"));
}

#[test]
fn event_handler_single_quoted_value() {
    // Lines 189, 191-196: event handler with single-quoted value
    let result = sanitize_html(r#"<p onclick='alert(1)'>Hello</p>"#).unwrap();
    assert!(!result.contains("onclick"));
    assert!(result.contains("Hello"));
}

#[test]
fn expression_css_removed() {
    // Sanitizer removes expression() in CSS
    let result = sanitize_html(r#"<style>body { width: expression(alert(1)) }</style>"#).unwrap();
    assert!(!result.contains("expression("));
}

#[test]
fn expression_with_space_removed() {
    let result = sanitize_html(r#"<style>body { width: expression (alert(1)) }</style>"#).unwrap();
    assert!(!result.contains("expression ("));
}

#[test]
fn quoted_external_url_is_left_for_the_network_policy() {
    let result =
        sanitize_html(r#"<style>body { background: url("http://evil.com/img.png") }</style>"#)
            .unwrap();
    assert!(result.contains("evil.com"));
}

#[test]
fn event_handler_at_start_of_tag() {
    // The prev-char check: 'o' at position after '<' or space
    let result = sanitize_html(r#"<div onclick="bad()">Hi</div>"#).unwrap();
    assert!(!result.contains("onclick"));
}

#[test]
fn event_handler_with_spaces_around_equals() {
    let result = sanitize_html(r#"<p onload = "bad()">Safe</p>"#).unwrap();
    assert!(!result.contains("onload"));
}
