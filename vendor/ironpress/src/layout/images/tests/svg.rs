use super::*;

#[test]
fn svg_size_percent_attrs_do_not_override_intrinsic_image_size() {
    let tree = SvgTree {
        width: 300.0,
        height: 150.0,
        width_attr: Some("100%".to_string()),
        height_attr: Some("50%".to_string()),
        preserve_aspect_ratio: crate::parser::svg::SvgPreserveAspectRatio::default(),
        view_box: None,
        defs: Default::default(),
        children: vec![],
        text_ctx: crate::parser::svg::SvgTextContext::default(),
        source_markup: None,
    };

    assert_eq!(
        resolve_svg_size(&tree, 400.0, 400.0, false, false),
        (300.0, 150.0)
    );
}

#[test]
fn svg_size_absolute_width_only_preserves_aspect_ratio() {
    let tree = SvgTree {
        width: 300.0,
        height: 150.0,
        width_attr: Some("120".to_string()),
        height_attr: None,
        preserve_aspect_ratio: crate::parser::svg::SvgPreserveAspectRatio::default(),
        view_box: Some(ViewBox {
            min_x: 0.0,
            min_y: 0.0,
            width: 20.0,
            height: 10.0,
        }),
        defs: Default::default(),
        children: vec![],
        text_ctx: crate::parser::svg::SvgTextContext::default(),
        source_markup: None,
    };

    assert_eq!(
        resolve_svg_size(&tree, 400.0, 400.0, false, false),
        (90.0, 45.0)
    );
}

#[test]
fn svg_size_absolute_height_only_preserves_aspect_ratio() {
    let tree = SvgTree {
        width: 300.0,
        height: 150.0,
        width_attr: None,
        height_attr: Some("60".to_string()),
        preserve_aspect_ratio: crate::parser::svg::SvgPreserveAspectRatio::default(),
        view_box: Some(ViewBox {
            min_x: 0.0,
            min_y: 0.0,
            width: 20.0,
            height: 10.0,
        }),
        defs: Default::default(),
        children: vec![],
        text_ctx: crate::parser::svg::SvgTextContext::default(),
        source_markup: None,
    };

    assert_eq!(
        resolve_svg_size(&tree, 400.0, 400.0, false, false),
        (90.0, 45.0)
    );
}

#[test]
fn css_image_svg_with_only_a_ratio_contains_within_its_default_object_size() {
    let tree = crate::parser::svg::parse_svg_from_string(
        r#"<svg viewBox="0 0 2 1"><rect width="2" height="1"/></svg>"#,
    )
    .expect("valid SVG image");

    assert_eq!(
        resolve_svg_image_size(&tree, Size::new(120.0, 120.0)),
        Size::new(120.0, 60.0)
    );
}

#[test]
fn css_image_svg_without_natural_dimensions_uses_its_default_object_size() {
    let tree = crate::parser::svg::parse_svg_from_string(
        r#"<svg><rect width="100%" height="100%"/></svg>"#,
    )
    .expect("valid SVG image");

    assert_eq!(
        resolve_svg_image_size(&tree, Size::new(120.0, 80.0)),
        Size::new(120.0, 80.0)
    );
}

#[test]
fn svg_size_absolute_width_ignores_disallowed_percent_height() {
    let tree = SvgTree {
        width: 300.0,
        height: 150.0,
        width_attr: Some("120".to_string()),
        height_attr: Some("50%".to_string()),
        preserve_aspect_ratio: crate::parser::svg::SvgPreserveAspectRatio::default(),
        view_box: Some(ViewBox {
            min_x: 0.0,
            min_y: 0.0,
            width: 20.0,
            height: 10.0,
        }),
        defs: Default::default(),
        children: vec![],
        text_ctx: crate::parser::svg::SvgTextContext::default(),
        source_markup: None,
    };

    assert_eq!(
        resolve_svg_size(&tree, 400.0, 400.0, false, false),
        (90.0, 45.0)
    );
}

#[test]
fn svg_size_absolute_height_ignores_disallowed_percent_width() {
    let tree = SvgTree {
        width: 300.0,
        height: 150.0,
        width_attr: Some("50%".to_string()),
        height_attr: Some("60".to_string()),
        preserve_aspect_ratio: crate::parser::svg::SvgPreserveAspectRatio::default(),
        view_box: Some(ViewBox {
            min_x: 0.0,
            min_y: 0.0,
            width: 20.0,
            height: 10.0,
        }),
        defs: Default::default(),
        children: vec![],
        text_ctx: crate::parser::svg::SvgTextContext::default(),
        source_markup: None,
    };

    assert_eq!(
        resolve_svg_size(&tree, 400.0, 400.0, false, false),
        (90.0, 45.0)
    );
}

#[test]
fn svg_size_intrinsic_is_not_clamped_to_available_width() {
    let tree = SvgTree {
        width: 300.0,
        height: 150.0,
        width_attr: None,
        height_attr: None,
        preserve_aspect_ratio: crate::parser::svg::SvgPreserveAspectRatio::default(),
        view_box: None,
        defs: Default::default(),
        children: vec![],
        text_ctx: crate::parser::svg::SvgTextContext::default(),
        source_markup: None,
    };

    assert_eq!(
        resolve_svg_size(&tree, 200.0, 400.0, false, false),
        (300.0, 150.0)
    );
}

#[test]
fn svg_size_negative_percent_falls_back_to_intrinsic_size() {
    let tree = SvgTree {
        width: 120.0,
        height: 60.0,
        width_attr: Some("-10%".to_string()),
        height_attr: None,
        preserve_aspect_ratio: crate::parser::svg::SvgPreserveAspectRatio::default(),
        view_box: None,
        defs: Default::default(),
        children: vec![],
        text_ctx: crate::parser::svg::SvgTextContext::default(),
        source_markup: None,
    };

    assert_eq!(
        resolve_svg_size(&tree, 400.0, 400.0, true, false),
        (120.0, 60.0) // falls back to intrinsic size (already in pt)
    );
}

#[test]
fn svg_natural_ratio_from_viewbox() {
    let vb = crate::parser::svg::ViewBox {
        min_x: 0.0,
        min_y: 0.0,
        width: 200.0,
        height: 100.0,
    };
    let ratio = svg_natural_ratio(None, None, None, None, Some(vb));
    assert!((ratio.unwrap() - 0.5).abs() < 0.001);
}

#[test]
fn svg_natural_ratio_from_explicit_dimensions() {
    let ratio = svg_natural_ratio(Some(100.0), Some(50.0), None, None, None);
    assert!((ratio.unwrap() - 0.5).abs() < 0.001);
}

#[test]
fn contain_default_object_size_tall_ratio() {
    // ratio > default_ratio (0.5): height-constrained
    let (w, h) = contain_object_size(2.0, Size::new(300.0, 150.0));
    assert!((h - 150.0).abs() < 0.01);
    assert!((w - 75.0).abs() < 0.01);
}

#[test]
fn contain_default_object_size_wide_ratio() {
    // ratio < default_ratio (0.5): width-constrained
    let (w, h) = contain_object_size(0.25, Size::new(300.0, 150.0));
    assert!((w - 300.0).abs() < 0.01);
    assert!((h - 75.0).abs() < 0.01);
}
