#[test]
fn opaque_conic_uses_exact_function_shading_without_wedges() {
    let gradient = test_conic_gradient(
        [
            gradient_stop(0.0, crate::types::Color::rgba8(255, 0, 0, 255)),
            gradient_stop(1.0, crate::types::Color::rgba8(0, 0, 255, 255)),
        ],
        false,
    );
    let mut content = String::new();
    let mut writer = PdfWriter::new();
    assert!(render_conic_gradient_tile(
        &mut content,
        &gradient,
        PdfRect::new(0.0, 0.0, 100.0, 100.0),
        &mut writer,
    ));

    assert!(content.contains("/ShConic0 sh"));
    assert!(!content.lines().any(|line| line.ends_with(" l")));
    let function = &writer.conic_shadings[0].function.calculator;
    assert_eq!(function.matches("atan").count(), 1);
}

#[test]
fn conic_hint_uses_the_shared_nine_stop_backend_expansion() {
    let mut first = gradient_stop(0.0, crate::types::Color::rgb(255, 0, 0));
    first.hint_after = Some(crate::style::computed::GradientPosition::fraction(0.25));
    let gradient = test_conic_gradient(
        [
            first,
            gradient_stop(1.0, crate::types::Color::rgb(0, 0, 255)),
        ],
        false,
    );

    let function = build_conic_shading_function(&gradient, PdfPoint::new(50.0, 50.0))
        .unwrap()
        .calculator;
    assert_eq!(function.matches(" le {").count(), 30);
    assert!(!function.contains(" exp"));
}

#[test]
fn oklab_conic_uses_the_color_managed_raster_path() {
    use crate::style::computed::{
        GradientColor, GradientColorProvenance, GradientInterpolation, GradientPosition,
        GradientStop,
    };
    let stop = |position, color| {
        GradientStop::new(
            GradientColor::new(color, GradientColorProvenance::Modern),
            Some(GradientPosition::fraction(position)),
        )
    };
    let gradient = ConicGradient {
        ramp: GradientRamp {
            stops: vec![
                stop(0.0, crate::types::Color::rgb(255, 0, 0)),
                stop(1.0, crate::types::Color::rgb(0, 0, 255)),
            ],
            interpolation: GradientInterpolation::Oklab,
            ..Default::default()
        },
        ..test_conic_gradient([], false)
    };
    let mut content = String::new();
    let mut writer = PdfWriter::new();
    let mut images = Vec::new();

    render_conic_gradient_layer_tile(
        &mut content,
        &gradient,
        PdfRect::new(0.0, 0.0, 20.0, 20.0),
        &mut writer,
        &mut images,
    );

    assert!(writer.conic_shadings.is_empty());
    assert_eq!(images.len(), 1);
    assert!(content.contains(" Do\n"));
}

#[test]
fn uniform_alpha_conic_stays_vector_with_an_ext_gstate() {
    let pdf = crate::HtmlConverter::new()
            .compress(false)
            .convert(
                r#"<div style="width:100pt;height:100pt;background:conic-gradient(#ff000080, #0000ff80)"></div>"#,
            )
            .unwrap();
    let content = String::from_utf8_lossy(&pdf);
    assert!(content.contains("/ShadingType 1"));
    assert!(content.contains("/GSShConic0 gs"));
    assert!(content.contains("/ca 0.5019608 /CA 0.5019608"));
    assert!(!content.contains("/Subtype /Image"));
}

#[test]
fn variable_alpha_conic_uses_the_premultiplied_raster_fallback() {
    let pdf = crate::HtmlConverter::new()
            .compress(false)
            .convert(
                r#"<div style="width:20pt;height:20pt;background:conic-gradient(transparent, red)"></div>"#,
            )
            .unwrap();
    let content = String::from_utf8_lossy(&pdf);
    assert!(!content.contains("/ShadingType 1"));
    assert!(content.contains("/Subtype /Image"));
    assert!(content.contains("/SMask"));
}

#[test]
fn exact_conic_shading_preserves_subdegree_transition() {
    // The red-to-blue transition spans 1/4096 turns (0.088 degrees). A
    // fixed one-degree fan collapses this into a single midpoint colour.
    let start = 0.25_f32;
    let span = 1.0 / 4096.0;
    let end = start + span;
    let gradient = test_conic_gradient(
        [
            gradient_stop(0.2, crate::types::Color::rgba8(255, 0, 0, 255)),
            gradient_stop(start, crate::types::Color::rgba8(255, 0, 0, 255)),
            gradient_stop(end, crate::types::Color::rgba8(0, 0, 255, 255)),
            gradient_stop(0.4, crate::types::Color::rgba8(0, 0, 255, 255)),
        ],
        false,
    );
    let ramp = gradient.ramp.resolve(1.0).unwrap();
    assert_rgba_close(ramp.sample(start + span * 0.5), (0.5, 0.0, 0.5, 1.0));

    let function = build_conic_shading_function(&gradient, PdfPoint::new(50.0, 50.0))
        .unwrap()
        .calculator;
    assert!(function.contains("dup 0.25024414 le"));
    assert!(function.contains("0.25 sub 4096 mul"));
}

#[test]
fn exact_repeating_conic_preserves_narrow_hard_stop_bands() {
    // Each band is 0.0005 turns (0.18 degrees), narrower than one wedge in
    // the removed 360-sector approximation.
    let boundary = 0.0005_f32;
    let period = 0.001_f32;
    let gradient = test_conic_gradient(
        [
            gradient_stop(0.0, crate::types::Color::rgba8(255, 0, 0, 255)),
            gradient_stop(boundary, crate::types::Color::rgba8(255, 0, 0, 255)),
            gradient_stop(boundary, crate::types::Color::rgba8(0, 0, 255, 255)),
            gradient_stop(period, crate::types::Color::rgba8(0, 0, 255, 255)),
        ],
        true,
    );
    let ramp = gradient.ramp.resolve(1.0).unwrap();
    for (position, expected) in [
        (boundary * 0.5, (1.0, 0.0, 0.0, 1.0)),
        (boundary, (0.0, 0.0, 1.0, 1.0)),
        ((boundary + period) * 0.5, (0.0, 0.0, 1.0, 1.0)),
        (period + boundary * 0.5, (1.0, 0.0, 0.0, 1.0)),
    ] {
        assert_rgba_close(ramp.sample(position), expected);
    }

    let function = build_conic_shading_function(&gradient, PdfPoint::new(50.0, 50.0))
        .unwrap()
        .calculator;
    let repetition = format!(
        "0 sub {} div dup floor sub {} mul 0 add",
        format_pdf_number(period),
        format_pdf_number(period),
    );
    assert!(function.contains(&repetition));
    assert!(function.contains(&format!("dup {} le", format_pdf_number(boundary))));
}

#[test]
fn finished_pdf_embeds_conic_type_1_shading() {
    let pdf = crate::HtmlConverter::new()
        .compress(false)
        .convert(
            r#"<div style="width:100pt;height:100pt;background:conic-gradient(red, blue)"></div>"#,
        )
        .unwrap();
    let content = String::from_utf8_lossy(&pdf);
    assert!(content.contains("/ShadingType 1"));
    assert_eq!(content.matches("/FunctionType 4").count(), 1);
    assert!(content.contains("/Range [0 1 0 1 0 1]"));
    assert!(content.contains(" atan "));
}

#[test]
fn simple_text_filter_uses_the_authored_blur_radius() {
    let blurred = blurred_simple_text_block(
        20.0,
        20.0,
        Some(Color::rgb(255, 0, 0)),
        &[],
        EdgeSizes::ZERO,
        &LayoutBorder::default(),
        TextAlign::Left,
        0.0,
        10.0,
        96.0,
        &HashMap::new(),
    )
    .expect("blurred text block");

    // sigma = 10pt / 0.75pt-per-CSS-px at 96 DPI; 3-sigma padding is
    // exactly 40 pixels = 30pt. The former 0.9 multiplier produced 27pt.
    assert!((blurred.overflow_pt - 30.0).abs() < f32::EPSILON);
}

#[test]
fn blurred_inset_shadow_uses_grayscale_coverage_and_native_alpha() {
    let pdf = crate::HtmlConverter::new()
            .compress(false)
            .filter_dpi(96.0)
            .convert(
                r#"<div style="width:40pt;height:30pt;background:white;box-shadow:inset 0 0 8pt rgba(0,0,0,.5)"></div>"#,
            )
            .unwrap();
    let content = String::from_utf8_lossy(&pdf);
    assert!(
        content.contains(" Do\n"),
        "blurred shadow should be an image XObject"
    );
    assert!(
        content.contains("/ColorSpace /DeviceGray")
            && content.contains("/Filter /DCTDecode")
            && content.contains("/SMask << /Type /Mask /S /Luminosity"),
        "blurred shadow coverage should be a grayscale soft mask"
    );
    assert!(
        content.contains("/ca 0.501961 /CA 0.501961"),
        "authored shadow alpha should remain native graphics state"
    );
}

#[test]
fn blurred_shadow_coverage_can_be_kept_lossless() {
    let pdf = crate::HtmlConverter::new()
            .compress(false)
            .raster_quality(crate::RasterQuality {
                filter_dpi: 96.0,
                blurred_coverage_compression: crate::CoverageCompression::Lossless,
                ..Default::default()
            })
            .convert(
                r#"<div style="width:40pt;height:30pt;background:white;box-shadow:inset 0 0 8pt black"></div>"#,
            )
            .unwrap();
    let content = String::from_utf8_lossy(&pdf);

    assert!(content.contains("/ColorSpace /DeviceGray"));
    assert!(content.contains("/Filter /FlateDecode"));
    assert!(!content.contains("/Filter /DCTDecode"));
}

fn first_td_y(content: &str) -> Option<f32> {
    for line in content.lines() {
        if let Some(coords) = line.strip_suffix(" Td") {
            let mut parts = coords.split_whitespace();
            let _x = parts.next()?;
            return parts.next()?.parse().ok();
        }
    }
    None
}
