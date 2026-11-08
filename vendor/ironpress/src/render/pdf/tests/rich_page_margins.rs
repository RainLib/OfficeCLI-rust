const RED_PIXEL: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

fn has_repeated_text_show(syntax: &str) -> bool {
    syntax
        .lines()
        .filter(|line| line.trim_end().ends_with("TJ"))
        .any(|command| syntax.lines().filter(|line| *line == command).count() >= 2)
}

/// CSS GCPM §1.2 requires `element()` to place the captured element complete
/// with its descendants in the page-margin box. Images and tables are layout
/// descendants, not a request to flatten the fragment to plain text.
#[test]
fn render_running_margin_container_with_image_and_table_on_each_page() {
    let html = format!(
        r#"<html><head><style>
            @page {{ size: 240pt 180pt; margin: 54pt 18pt 18pt;
                @top-center {{ content: element(issue245header) }} }}
            * {{ box-sizing: border-box }}
            .header {{ position: running(issue245header); width: 180pt; height: 36pt }}
            .header img {{ width: 12pt; height: 12pt }}
            .header table {{ display: inline-table; border-collapse: collapse }}
            .header td {{ border: 1pt solid #000; padding: 2pt }}
            .page {{ height: 100pt }}
        </style></head><body>
            <div class="header">
                <img src="{RED_PIXEL}" alt="">
                <table><tr><td>ISSUE245</td></tr></table>
            </div>
            <div class="page">First page</div>
            <div style="break-before: page" class="page">Second page</div>
        </body></html>"#
    );

    let pdf = crate::HtmlConverter::new()
        .compress(false)
        .convert(&html)
        .expect("rich running header PDF");
    let syntax = String::from_utf8_lossy(&pdf);

    assert_eq!(syntax.matches("/Type /Page ").count(), 2);
    assert!(
        has_repeated_text_show(&syntax),
        "the table's text-show command must repeat on both pages"
    );
    assert!(
        syntax.matches(" Do\n").count() >= 2,
        "the header image must paint on both pages"
    );
    assert!(syntax.contains("/Subtype /Image"), "header image object");
}

/// Issue #245's public contract: callers can provide an HTML fragment without
/// authoring GCPM rules themselves, while the converter still uses that shared
/// standards-based path internally.
#[test]
fn header_html_paints_an_image_and_table_on_each_page() {
    let header = format!(
        r#"<style>
            .issue245-header {{ display: flex; gap: 6pt; width: 180pt; height: 30pt }}
            .issue245-header img {{ width: 12pt; height: 12pt }}
            .issue245-header table {{ border-collapse: collapse }}
            .issue245-header td {{ border: 1pt solid #000; padding: 2pt }}
        </style>
        <div class="issue245-header">
            <img src="{RED_PIXEL}" alt="">
            <table><tr><td>ISSUE245-API</td></tr></table>
        </div>"#
    );
    let html = r#"
        <div style="height: 100pt">First page</div>
        <div style="break-before: page; height: 100pt">Second page</div>
    "#;

    let pdf = crate::HtmlConverter::new()
        .page_size(crate::PageSize::new(240.0, 180.0))
        .margin(crate::Margin::new(54.0, 18.0, 18.0, 18.0))
        .header_html(header)
        .compress(false)
        .convert(html)
        .expect("public rich header PDF");
    let syntax = String::from_utf8_lossy(&pdf);

    assert_eq!(syntax.matches("/Type /Page ").count(), 2);
    assert!(has_repeated_text_show(&syntax), "table text on both pages");
    assert!(syntax.matches(" Do\n").count() >= 2, "image on both pages");
}

#[test]
fn footer_html_paints_styled_nested_content_on_each_page() {
    let html = r#"
        <div style="height: 100pt">First page</div>
        <div style="break-before: page; height: 100pt">Second page</div>
    "#;
    let pdf = crate::HtmlConverter::new()
        .page_size(crate::PageSize::new(240.0, 180.0))
        .margin(crate::Margin::new(18.0, 18.0, 54.0, 18.0))
        .footer_html(
            r#"<div style="width:180pt;height:30pt;background:#e8edff">
                <strong style="color:#1736a4">ISSUE245-FOOTER</strong>
            </div>"#,
        )
        .compress(false)
        .convert(html)
        .expect("public rich footer PDF");
    let syntax = String::from_utf8_lossy(&pdf);

    assert_eq!(syntax.matches("/Type /Page ").count(), 2);
    assert!(
        has_repeated_text_show(&syntax),
        "nested footer text on both pages"
    );
    assert!(
        syntax.matches("0.9098 0.9294 1 rg\n").count() >= 2,
        "styled footer background on both pages"
    );
}
