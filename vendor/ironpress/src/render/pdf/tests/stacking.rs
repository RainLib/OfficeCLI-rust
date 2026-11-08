fn paint_position(pdf: &[u8], color: &str) -> usize {
    String::from_utf8_lossy(pdf)
        .find(color)
        .unwrap_or_else(|| panic!("missing PDF paint operator {color}"))
}

fn first_image_paint_position(pdf: &[u8]) -> usize {
    let content = String::from_utf8_lossy(pdf);
    content
        .match_indices("/Im")
        .find_map(|(position, _)| {
            content[position..]
                .lines()
                .next()
                .is_some_and(|line| line.ends_with(" Do"))
                .then_some(position)
        })
        .expect("missing filtered image paint operator")
}

#[test]
fn positive_descendant_escapes_a_non_stacking_ancestor() {
    let html = r#"
        <style>
          @page { size: 180px 140px; margin: 0; }
          * { box-sizing: border-box; margin: 0; }
          .stage { position: relative; width: 160px; height: 120px; }
          .ordinary { width: 120px; height: 90px; }
          .high-child {
            position: absolute;
            z-index: 10;
            top: 20px;
            left: 20px;
            width: 90px;
            height: 70px;
            background: rgb(255, 0, 0);
          }
          .zero-sibling {
            position: relative;
            margin-top: -70px;
            margin-left: 50px;
            width: 90px;
            height: 70px;
            background: rgb(0, 0, 255);
          }
        </style>
        <div class="stage">
          <div class="ordinary"><div class="high-child"></div></div>
          <div class="zero-sibling"></div>
        </div>
    "#;
    let pdf = crate::HtmlConverter::new()
        .sanitize(false)
        .compress(false)
        .convert(html)
        .unwrap();

    let blue = paint_position(&pdf, "0 0 1 rg");
    let red = paint_position(&pdf, "1 0 0 rg");
    assert!(
        blue < red,
        "the positive descendant participates in the stage stacking context"
    );
}

#[test]
fn explicit_zero_stacking_context_contains_a_positive_descendant() {
    let html = r#"
        <style>
          @page { size: 180px 140px; margin: 0; }
          * { box-sizing: border-box; margin: 0; }
          .stage { position: relative; width: 160px; height: 120px; }
          .zero-context { position: relative; z-index: 0; width: 120px; height: 90px; }
          .high-child {
            position: absolute;
            z-index: 10;
            top: 20px;
            left: 20px;
            width: 90px;
            height: 70px;
            background: rgb(255, 0, 0);
          }
          .one-sibling {
            position: absolute;
            z-index: 1;
            top: 30px;
            left: 50px;
            width: 90px;
            height: 70px;
            background: rgb(0, 0, 255);
          }
        </style>
        <div class="stage">
          <div class="zero-context"><div class="high-child"></div></div>
          <div class="one-sibling"></div>
        </div>
    "#;
    let pdf = crate::HtmlConverter::new()
        .sanitize(false)
        .compress(false)
        .convert(html)
        .unwrap();

    let red = paint_position(&pdf, "1 0 0 rg");
    let blue = paint_position(&pdf, "0 0 1 rg");
    assert!(
        red < blue,
        "the z-index:0 ancestor keeps its positive descendant below z-index:1 siblings"
    );
}

#[test]
fn fixed_auto_stacking_context_contains_a_positive_descendant() {
    let html = r#"
        <style>
          @page { size: 180px 140px; margin: 0; }
          * { box-sizing: border-box; margin: 0; }
          .fixed-context { position: fixed; width: 120px; height: 90px; }
          .high-child {
            position: absolute;
            z-index: 10;
            top: 20px;
            left: 20px;
            width: 90px;
            height: 70px;
            background: rgb(255, 0, 0);
          }
          .one-sibling {
            position: absolute;
            z-index: 1;
            top: 30px;
            left: 50px;
            width: 90px;
            height: 70px;
            background: rgb(0, 0, 255);
          }
        </style>
        <div class="fixed-context"><div class="high-child"></div></div>
        <div class="one-sibling"></div>
    "#;
    let pdf = crate::HtmlConverter::new()
        .sanitize(false)
        .compress(false)
        .convert(html)
        .unwrap();

    let red = paint_position(&pdf, "1 0 0 rg");
    let blue = paint_position(&pdf, "0 0 1 rg");
    assert!(
        red < blue,
        "the fixed auto context keeps its positive descendant below z-index:1 siblings"
    );
}

#[test]
fn sticky_auto_stacking_context_contains_a_positive_descendant() {
    let html = r#"
        <style>
          @page { size: 180px 140px; margin: 0; }
          * { box-sizing: border-box; margin: 0; }
          .stage { position: relative; width: 160px; height: 120px; }
          .sticky-context { position: sticky; width: 120px; height: 90px; }
          .high-child {
            position: absolute;
            z-index: 10;
            top: 20px;
            left: 20px;
            width: 90px;
            height: 70px;
            background: rgb(255, 0, 0);
          }
          .one-sibling {
            position: absolute;
            z-index: 1;
            top: 30px;
            left: 50px;
            width: 90px;
            height: 70px;
            background: rgb(0, 0, 255);
          }
        </style>
        <div class="stage">
          <div class="sticky-context"><div class="high-child"></div></div>
          <div class="one-sibling"></div>
        </div>
    "#;
    let pdf = crate::HtmlConverter::new()
        .sanitize(false)
        .compress(false)
        .convert(html)
        .unwrap();

    let red = paint_position(&pdf, "1 0 0 rg");
    let blue = paint_position(&pdf, "0 0 1 rg");
    assert!(
        red < blue,
        "the sticky auto context keeps its positive descendant below z-index:1 siblings"
    );
}

#[test]
fn non_positioning_stacking_contexts_remain_atomic() {
    for declaration in [
        "transform: translate(0)",
        "perspective: 400px",
        "isolation: isolate",
        "filter: brightness(1)",
    ] {
        let html = format!(
            r#"
            <style>
              @page {{ size: 180px 140px; margin: 0; }}
              * {{ box-sizing: border-box; margin: 0; }}
              .stage {{ position: relative; width: 160px; height: 120px; }}
              .context {{ {declaration}; width: 120px; height: 90px; }}
              .high-child {{
                position: absolute; z-index: 10; top: 20px; left: 20px;
                width: 90px; height: 70px; background: rgb(255, 0, 0);
              }}
              .one-sibling {{
                position: absolute; z-index: 1; top: 30px; left: 50px;
                width: 90px; height: 70px; background: rgb(0, 0, 255);
              }}
            </style>
            <div class="stage">
              <div class="context"><div class="high-child"></div></div>
              <div class="one-sibling"></div>
            </div>
            "#,
        );
        let pdf = crate::HtmlConverter::new()
            .sanitize(false)
            .compress(false)
            .convert(&html)
            .unwrap();

        let context = if declaration.starts_with("filter:") {
            first_image_paint_position(&pdf)
        } else {
            paint_position(&pdf, "1 0 0 rg")
        };
        let blue = paint_position(&pdf, "0 0 1 rg");
        assert!(
            context < blue,
            "{declaration} must keep its positive descendant below a z-index:1 sibling"
        );
    }
}

#[test]
fn positive_descendant_escapes_non_stacking_flex_container_and_item() {
    let html = r#"
        <style>
          @page { size: 180px 140px; margin: 0; }
          * { box-sizing: border-box; margin: 0; }
          .stage { position: relative; width: 160px; height: 120px; }
          .flex { display: flex; width: 120px; height: 90px; }
          .item { position: relative; width: 120px; height: 90px; }
          .high-child {
            position: absolute;
            z-index: 10;
            top: 20px;
            left: 20px;
            width: 90px;
            height: 70px;
            background: rgb(255, 0, 0);
          }
          .zero-sibling {
            position: absolute;
            top: 30px;
            left: 50px;
            width: 90px;
            height: 70px;
            background: rgb(0, 0, 255);
          }
        </style>
        <div class="stage">
          <div class="flex"><div class="item"><div class="high-child"></div></div></div>
          <div class="zero-sibling"></div>
        </div>
    "#;
    let pdf = crate::HtmlConverter::new()
        .sanitize(false)
        .compress(false)
        .convert(html)
        .unwrap();

    let blue = paint_position(&pdf, "0 0 1 rg");
    let red = paint_position(&pdf, "1 0 0 rg");
    assert!(
        blue < red,
        "the flex wrappers do not trap a positive positioned descendant"
    );
}

#[test]
fn positive_descendant_escapes_non_stacking_grid_container_and_item() {
    let html = r#"
        <style>
          @page { size: 180px 140px; margin: 0; }
          * { box-sizing: border-box; margin: 0; }
          .stage { position: relative; width: 160px; height: 120px; }
          .grid { display: grid; grid-template-columns: 120px; width: 120px; height: 90px; }
          .item { position: relative; width: 120px; height: 90px; }
          .high-child {
            position: absolute;
            z-index: 10;
            top: 20px;
            left: 20px;
            width: 90px;
            height: 70px;
            background: rgb(255, 0, 0);
          }
          .zero-sibling {
            position: absolute;
            top: 30px;
            left: 50px;
            width: 90px;
            height: 70px;
            background: rgb(0, 0, 255);
          }
        </style>
        <div class="stage">
          <div class="grid"><div class="item"><div class="high-child"></div></div></div>
          <div class="zero-sibling"></div>
        </div>
    "#;
    let pdf = crate::HtmlConverter::new()
        .sanitize(false)
        .compress(false)
        .convert(html)
        .unwrap();

    let blue = paint_position(&pdf, "0 0 1 rg");
    let red = paint_position(&pdf, "1 0 0 rg");
    assert!(
        blue < red,
        "the grid wrappers do not trap a positive positioned descendant"
    );
}

#[test]
fn positive_descendant_escapes_non_stacking_table_content() {
    let html = r#"
        <style>
          @page { size: 180px 140px; margin: 0; }
          * { box-sizing: border-box; margin: 0; border-spacing: 0; }
          .stage { position: relative; width: 160px; height: 120px; }
          table, td, .item { width: 120px; height: 90px; padding: 0; }
          .item { position: relative; }
          .high-child {
            position: absolute;
            z-index: 10;
            top: 20px;
            left: 20px;
            width: 90px;
            height: 70px;
            background: rgb(255, 0, 0);
          }
          .zero-sibling {
            position: absolute;
            top: 30px;
            left: 50px;
            width: 90px;
            height: 70px;
            background: rgb(0, 0, 255);
          }
        </style>
        <div class="stage">
          <table><tr><td><div class="item"><div class="high-child"></div></div></td></tr></table>
          <div class="zero-sibling"></div>
        </div>
    "#;
    let pdf = crate::HtmlConverter::new()
        .sanitize(false)
        .compress(false)
        .convert(html)
        .unwrap();

    let blue = paint_position(&pdf, "0 0 1 rg");
    let red = paint_position(&pdf, "1 0 0 rg");
    assert!(
        blue < red,
        "table formatting wrappers do not trap a positive positioned descendant"
    );
}

#[test]
fn escaped_descendant_retains_non_stacking_ancestor_clip() {
    let html = r#"
        <style>
          @page { size: 180px 140px; margin: 0; }
          * { box-sizing: border-box; margin: 0; }
          .stage { position: relative; width: 160px; height: 120px; }
          .clipper {
            position: relative;
            overflow: hidden;
            width: 40px;
            height: 40px;
          }
          .high-child {
            position: absolute;
            z-index: 10;
            width: 90px;
            height: 70px;
            background: rgb(255, 0, 0);
          }
          .zero-sibling {
            position: absolute;
            top: 20px;
            left: 20px;
            width: 90px;
            height: 70px;
            background: rgb(0, 0, 255);
          }
        </style>
        <div class="stage">
          <div class="clipper"><div class="high-child"></div></div>
          <div class="zero-sibling"></div>
        </div>
    "#;
    let pdf = crate::HtmlConverter::new()
        .sanitize(false)
        .compress(false)
        .convert(html)
        .unwrap();
    let text = String::from_utf8_lossy(&pdf);

    let blue = paint_position(&pdf, "0 0 1 rg");
    let red = paint_position(&pdf, "1 0 0 rg");
    let clip = text[..red]
        .rfind("W n")
        .unwrap_or_else(|| panic!("escaped descendant lost its overflow clip"));
    assert!(
        blue < clip && clip < red,
        "the ancestor clip is reapplied around the deferred positive fragment"
    );
}
