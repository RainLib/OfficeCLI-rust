use super::*;

#[test]
fn nested_flex_cell_paints_both_shadow_phases() {
    use crate::parser::css::parse_stylesheet;

    let document = crate::parser::html::parse_html_with_styles(
        r#"
        <style>
            .host { width: 160px; height: 100px; background: white; }
            .row { display: flex; width: 120px; height: 60px; }
            .item {
                width: 80px;
                height: 40px;
                background: white;
                box-shadow: 7px 5px 0 #ef476f, inset 0 0 0 2px #ffd166;
            }
        </style>
        <div class="host"><div class="row"><div class="item">shadow</div></div></div>
        "#,
    )
    .unwrap();
    let rules = document
        .stylesheets
        .iter()
        .flat_map(|stylesheet| parse_stylesheet(stylesheet))
        .collect::<Vec<_>>();
    let pages = crate::layout::engine::layout_with_rules(
        &document.nodes,
        PageSize::A4,
        Margin::uniform(0.0),
        &rules,
    );
    let pdf = render_pdf(&pages, PageSize::A4, Margin::uniform(0.0)).unwrap();
    let content = String::from_utf8_lossy(&pdf);

    assert!(
        content.contains("0.9372549 0.2784314 0.43529412 rg"),
        "nested flex item must paint its outset shadow"
    );
    assert!(
        content.contains("1 0.81960785 0.4 rg"),
        "nested flex item must paint its inset shadow"
    );
}
