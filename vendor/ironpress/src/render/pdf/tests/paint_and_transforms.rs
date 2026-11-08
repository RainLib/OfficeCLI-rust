#[test]
fn render_all_12_fonts_registered() {
    let html = "<p>Test</p>";
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    // All 12 standard font variants should be registered as font objects
    for name in &[
        "Helvetica",
        "Helvetica-Bold",
        "Helvetica-Oblique",
        "Helvetica-BoldOblique",
        "Times-Roman",
        "Times-Bold",
        "Times-Italic",
        "Times-BoldItalic",
        "Courier",
        "Courier-Bold",
        "Courier-Oblique",
        "Courier-BoldOblique",
    ] {
        assert!(
            content.contains(&format!("/BaseFont /{name}")),
            "PDF should register font {name}"
        );
    }
}

#[test]
fn render_opacity_produces_extgstate() {
    let html = r#"<div style="opacity: 0.5">Semi-transparent</div>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    assert!(
        content.contains("/ca 0.5"),
        "PDF should contain fill opacity /ca 0.5"
    );
    assert!(
        content.contains("/CA 0.5"),
        "PDF should contain stroke opacity /CA 0.5"
    );
    assert!(
        content.contains("/ExtGState"),
        "PDF should contain ExtGState resource"
    );
    assert!(content.contains("gs\n"), "PDF should use gs operator");
}

#[test]
fn render_full_opacity_no_extgstate() {
    let html = r#"<div>Fully opaque</div>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    assert!(
        !content.contains("/ExtGState"),
        "PDF should not contain ExtGState for full opacity"
    );
}

#[test]
fn render_width_constrains_background() {
    let html = r#"<div style="width: 200pt; background-color: red">Narrow</div>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    assert!(
        content.contains("200"),
        "the 200pt box must retain its 200pt paint width"
    );
}

#[test]
fn mask_image_gradient_emits_luminosity_smask() {
    // A box with a CSS gradient mask must emit a soft-mask graphics state
    // (a /Luminosity transparency group) and apply it via `gs` so the box's
    // paint fades through the mask coverage (css-masking-1 §3).
    let html = r#"<div style="width:120px;height:80px;background:#2e7d32;
            mask-image:linear-gradient(to right,#000,rgba(0,0,0,0))"></div>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    assert!(
        content.contains("/S /Luminosity"),
        "gradient mask must emit a luminosity soft-mask group"
    );
    assert!(
        content.contains("/SMask <<"),
        "gradient mask must register an /SMask ExtGState"
    );
    assert!(
        content.contains("GSmask"),
        "gradient mask must apply its soft-mask gstate via `gs`"
    );
}

#[test]
fn initial_radial_mask_uses_native_pdf_shading() {
    let html = r#"<style>
            @page { size: 280px 200px; margin: 0; }
            * { margin: 0; box-sizing: border-box; }
            .box { width:200px; height:200px; background:#1565c0;
                mask-image:radial-gradient(circle at 100px 100px,
                    #000 0%, #000 50%, transparent 75%); }
            </style><div class="box"></div>"#;
    let pdf = crate::HtmlConverter::new().convert(html).unwrap();
    let content = String::from_utf8_lossy(&pdf);

    assert!(
        content.contains("/ShadingType 3"),
        "the full-box radial mask must remain a native PDF radial shading"
    );
    assert!(
        !content.contains("/Subtype /Image"),
        "the initial repeat mode does not require a bitmap when its one tile fills the mask clip"
    );
}

#[test]
fn edge_centered_radial_mask_does_not_add_opaque_edge_strips() {
    let html = r#"<div style="width:180px;height:140px;background:#2e7d32;
            mask-image:radial-gradient(circle 34px at 0 0,#000 0 34px,transparent 35px);
            mask-size:80px 80px;mask-repeat:no-repeat;mask-position:0 0"></div>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);

    assert!(content.contains("GSmask"));
    assert!(
        !content.contains("0 0 0 rg\n"),
        "a radial mask is defined by its shading and tile clip; synthetic opaque strips alter the authored mask"
    );
}

#[test]
fn content_box_background_keeps_the_browser_device_clip_then_css_paint_structure() {
    let html = r#"<style>@page { size: 184px 136px; margin: 0; }
            * { margin: 0; box-sizing: border-box; }
            .box { width:140px; height:90px; margin:20px; padding:25px;
                border:4px solid #111; background:#e53935; background-clip:content-box; }
            </style><div class="box"></div>"#;
    let pdf = crate::HtmlConverter::new().convert(html).unwrap();
    let content = String::from_utf8_lossy(&pdf);

    assert!(
        content.contains("3.125 0 0 3.125 0 0 cm"),
        "content-box color must paint in CSS pixel coordinates after its device clip"
    );
    assert!(
        content.contains("W* n"),
        "the outer content-box clip must be established in print-device coordinates"
    );
}

#[test]
fn text_block_content_background_keeps_the_browser_device_clip_then_css_paint_structure() {
    let html = r#"<style>@page { size: 184px 136px; margin: 0; }
            * { margin: 0; box-sizing: border-box; }
            p { width:140px; margin:20px; padding:25px; border:4px solid #111;
                background:#e53935; background-clip:content-box; }
            </style><p>content</p>"#;
    let pdf = crate::HtmlConverter::new().convert(html).unwrap();
    let content = String::from_utf8_lossy(&pdf);

    assert!(
        content.contains("3.125 0 0 3.125 0 0 cm"),
        "text-block content backgrounds must paint in CSS pixel coordinates after the device clip"
    );
    assert!(
        content.contains("W* n"),
        "text-block content backgrounds must establish their clip in print-device coordinates"
    );
}

#[test]
fn border_box_background_fills_directly_when_clip_equals_paint_at_the_page_edge() {
    let html = r#"<style>@page { size: 184px 136px; margin: 0; }
            * { margin: 0; box-sizing: border-box; }
            .box { width:184px; height:64px; background:#e53935; }
            </style><div class="box"></div>"#;
    let pdf = crate::HtmlConverter::new().convert(html).unwrap();
    let content = String::from_utf8_lossy(&pdf);

    assert!(
        !content.contains("W* n"),
        "an identical border-box clip is redundant and changes Poppler edge coverage"
    );
    assert!(
        content.contains("0.898 0.2235 0.2078 rg\n"),
        "the page-edge background must retain its authored direct fill"
    );
}

#[test]
fn masked_bordered_container_emits_only_authored_box_paint() {
    let html = r#"<div style="width:120px;height:80px;padding:12px;
            border:8px solid #010203;background:#abcdef;
            mask-image:linear-gradient(#000,#000)"></div>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);

    let mask_apply = content
        .match_indices("/GSmask")
        .find_map(|(offset, _)| {
            content[offset..]
                .lines()
                .next()
                .is_some_and(|line| line.ends_with(" gs"))
                .then_some(offset)
        })
        .expect("the container must apply its authored soft mask");
    let mut application = content[mask_apply..].lines();
    let mask_line = application.next().expect("the mask state line");
    let form_line = application.next().expect("the isolated element form line");
    assert!(mask_line.ends_with(" gs"));
    form_line
        .strip_prefix("/Fm")
        .and_then(|line| line.strip_suffix(" Do"))
        .expect("the mask must paint one isolated element form");

    assert!(
        !content.contains("/ca 0.13"),
        "masking must not synthesize a translucent seam-cover graphics state"
    );
    assert!(
        content[mask_apply..].starts_with(&format!("{mask_line}\n{form_line}\nQ\n")),
        "the mask must apply once to the already-composited box form"
    );
}

#[test]
fn no_mask_emits_no_softmask_gstate() {
    // A plain box (no mask-image) must not emit any GSmask soft-mask state.
    let html = r#"<div style="width:120px;height:80px;background:#2e7d32"></div>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    assert!(
        !content.contains("GSmask"),
        "a box without mask-image must not emit a soft-mask gstate"
    );
}

#[test]
fn render_justify_produces_tw_operator() {
    // Use enough words to force line wrapping so a non-last line exists
    let words = "word ".repeat(80);
    let html = format!(r#"<p style="text-align: justify">{words}</p>"#,);
    let nodes = parse_html(&html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    assert!(
        content.contains("Tw\n"),
        "Justified text should produce Tw operator in PDF"
    );
}

#[test]
fn render_justify_last_line_no_tw() {
    // A single short line (which is the last line) should not have Tw
    let html = r#"<p style="text-align: justify">Short line</p>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    // The single line is the last line, so no Tw should be applied
    assert!(
        !content.contains("Tw\n"),
        "Last line of justified paragraph should not have Tw"
    );
}

#[test]
fn render_justify_resets_tw() {
    let words = "word ".repeat(80);
    let html = format!(r#"<p style="text-align: justify">{words}</p>"#,);
    let nodes = parse_html(&html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    // Tw should be reset to 0 after each justified line
    assert!(
        content.contains("0 Tw\n"),
        "Tw should be reset to 0 after justified lines"
    );
}

// --- Overflow / Visibility / Transform PDF rendering tests ---

#[test]
fn render_visibility_hidden_skips_content() {
    let html = r#"<div style="visibility: hidden">Hidden text</div><p>Visible text</p>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    assert!(
        !content.contains("Hidden text"),
        "visibility: hidden should not render text content"
    );
    assert!(
        content.contains("Visible"),
        "Other text should still render"
    );
}

#[test]
fn render_overflow_hidden_produces_clip_path() {
    let html =
        r#"<div style="overflow: hidden; width: 200pt; height: 100pt">Clipped content</div>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    assert!(
        content.contains("re W n"),
        "overflow: hidden should produce clipping path (re W n)"
    );
    assert!(
        content.contains("Clipped"),
        "Content should still be rendered inside clip"
    );
}

#[test]
fn render_transform_rotate_produces_cm() {
    let html = r#"<div style="transform: rotate(45deg)">Rotated text</div>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    // rotate(45deg) should produce cos/sin values in a cm operator
    assert!(
        content.contains("cm\n"),
        "transform: rotate should produce cm operator"
    );
    assert!(
        content.contains("q\n"),
        "transform should save graphics state with q"
    );
    assert!(
        content.contains("Q\n"),
        "transform should restore graphics state with Q"
    );
    // cos(45) ~= 0.7071, sin(45) ~= 0.7071
    assert!(
        content.contains("0.707"),
        "rotate(45deg) should contain cos/sin values ~0.707"
    );
}

#[test]
fn render_transform_scale_produces_cm() {
    let html = r#"<div style="transform: scale(2)">Scaled text</div>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    // scale(2) produces "2 0 0 2 tx ty cm" where tx,ty are the centre-offset
    // translation terms (non-zero because the block is not at the page origin).
    assert!(
        content.contains("2 0 0 2 "),
        "transform: scale(2) should produce '2 0 0 2 ...' cm operator"
    );
    assert!(
        content.contains(" cm\n"),
        "transform: scale(2) should produce a cm operator"
    );
}

#[test]
fn render_transform_translate_produces_cm() {
    let html = r#"<div style="transform: translate(10pt, 20pt)">Translated text</div>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    assert!(
        content.contains("1 0 0 1 10 -20 cm"),
        "transform: translate(10pt, 20pt) should produce '1 0 0 1 10 -20 cm' (Y negated for PDF)"
    );
}

#[test]
fn every_paintable_leaf_uses_the_shared_transform_group() {
    for html in [
        r#"<hr style="transform:translate(7pt,5pt)">"#,
        r#"<progress value="1" max="2" style="transform:translate(7pt,5pt)"></progress>"#,
        r#"<div data-math="x+y" class="math-display" style="transform:translate(7pt,5pt)"></div>"#,
    ] {
        let nodes = parse_html(html).unwrap();
        let pages = layout(&nodes, PageSize::A4, Margin::default());
        let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
        let content = String::from_utf8_lossy(&pdf);
        assert!(
            content.contains("1 0 0 1 7 -5 cm\n"),
            "paintable leaf bypassed the shared paint-group transform: {html}"
        );
    }
}

#[test]
fn ancestor_transform_wraps_the_subtree_once_instead_of_copying_to_children() {
    let html = r#"
        <div style="transform:translate(7pt,5pt)">
            <hr>
            <progress value="1" max="2"></progress>
            <div data-math="x+y" class="math-display"></div>
        </div>
    "#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    assert_eq!(
        content.matches("1 0 0 1 7 -5 cm\n").count(),
        1,
        "the ancestor coordinate system must wrap the complete subtree exactly once"
    );
}

/// BUG P2-2: rotate/scale transforms must be applied around the element
/// centre (CSS `transform-origin: 50% 50%`), not the page origin.
/// Previously the translation terms in the `cm` matrix were always 0,
/// which displaced the element off-page.
#[test]
fn render_transform_scale_centered_on_element() {
    // A block with explicit 100pt × 20pt size, positioned at the top of
    // the content area.  The rendered PDF matrix must be
    //   scale_x 0 0 scale_y tx ty
    // where tx = cx*(1-sx) and ty = cy*(1-sy) (non-zero when the element
    // is not at the page origin).
    let html = r#"<div style="transform: scale(2); width: 100pt; height: 20pt; background-color: blue">Box</div>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);

    // The matrix scale values are correct.
    assert!(
        content.contains("2 0 0 2 "),
        "scale(2) should produce '2 0 0 2 tx ty cm'"
    );
    // The translation terms must NOT both be zero — the element is not
    // at the page origin, so the centre-based offset is non-zero.
    assert!(
        !content.contains("2 0 0 2 0 0 cm"),
        "scale(2) on a non-origin element must have non-zero tx/ty in the cm matrix"
    );
}

/// BUG P2-2: a rotate transform must include non-zero translation terms
/// so the element stays in its section instead of being displaced.
#[test]
fn render_transform_rotate_includes_translation_terms() {
    let html = r#"<div style="transform: rotate(45deg); width: 100pt; height: 20pt; background-color: red">Rotated</div>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);

    // cos/sin values of 45 deg must be present.
    assert!(
        content.contains("0.707"),
        "rotate(45deg) must contain cos/sin ~0.707"
    );
    // The matrix must NOT have zero translation — the element centre
    // is not at (0, 0) in PDF coordinates.
    assert!(
        !content.contains("0.70710677 0.70710677 -0.70710677 0.70710677 0 0 cm"),
        "rotate on a non-origin element must have non-zero tx/ty in the cm matrix"
    );
}

#[test]
fn render_overflow_visible_no_clip() {
    let html = r#"<div style="width: 200pt">Normal content</div>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    assert!(
        !content.contains("re W n"),
        "No overflow should not produce clipping path"
    );
}

#[test]
fn render_border_radius_produces_bezier_curves() {
    let html = r#"<div style="border: 1px solid black; border-radius: 10pt; background-color: red">Rounded</div>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    // Bezier curves use 'c' operator; rounded rects should have them
    assert!(
        content.contains(" c\n"),
        "Border-radius should produce Bezier curve commands"
    );
    // Should also have 'h' to close the path
    assert!(
        content.contains("h\n"),
        "Rounded rect path should be closed with 'h'"
    );
}

#[test]
fn translucent_elliptical_border_is_an_exact_ring_not_a_centerline_stroke() {
    let html = r#"<style>@page { size: 224px 152px; margin: 0; }
            * { margin: 0; box-sizing: border-box; }
            .box { width:170px; height:95px; margin:25px; padding:10px;
                border:16px solid rgb(17 17 17 / 50%); border-radius:50% / 30%;
                background:#e53935; background-clip:padding-box; }
            </style><div class="box"></div>"#;
    let pdf = crate::HtmlConverter::new()
        .compress(false)
        .convert(html)
        .unwrap();
    let content = String::from_utf8_lossy(&pdf);

    assert!(
        content.contains("f*\n"),
        "a rounded solid border must fill its outer-minus-inner even-odd ring"
    );
    assert!(
        !content.contains("12 w\n"),
        "a 16px rounded border must not use an inexact 12pt centerline stroke"
    );
}

#[test]
fn render_outline_draws_outside_element() {
    let html = r#"<div style="outline: 2px solid red; width: 100pt">Outlined</div>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    // Outline should produce a stroke command (S) with outline color
    assert!(
        content.contains("1 0 0 RG"),
        "Outline should set red stroke color"
    );
    assert!(
        content.contains("S\n"),
        "Outline should produce a stroke command"
    );
}

#[test]
fn render_border_radius_zero_uses_rectangle() {
    let html = r#"<div style="border: 1px solid black; background-color: blue">Square</div>"#;
    let nodes = parse_html(html).unwrap();
    let pages = layout(&nodes, PageSize::A4, Margin::default());
    let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
    let content = String::from_utf8_lossy(&pdf);
    // Without border-radius, should use 're' (rectangle) not Bezier curves
    assert!(
        content.contains("re\n"),
        "Zero border-radius should use rectangle operator"
    );
}
