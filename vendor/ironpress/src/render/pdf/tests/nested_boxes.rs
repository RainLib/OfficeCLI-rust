/// render_nested_text_block: background_color + border_radius in nested block
#[test]
fn layout_elements_nested_text_block_background_with_border_radius() {
    let custom_fonts = HashMap::new();
    let prepared_custom_fonts = PreparedCustomFonts::new();
    let mut pdf_writer = PdfWriter::new();
    let mut page_images = Vec::new();
    let mut shadings = Vec::new();
    let mut shading_counter = 0usize;
    let mut page_ext_gstates = Vec::new();
    let mut bg_alpha_counter = 0usize;
    let mut annotations = Vec::new();
    let mut ctx = PageRenderContext::new(
        &mut pdf_writer,
        &mut page_images,
        &custom_fonts,
        &prepared_custom_fonts,
        &mut shadings,
        &mut shading_counter,
        &mut page_ext_gstates,
        &mut bg_alpha_counter,
        &mut annotations,
        TEST_PAGE_PAINT_BOX,
        TEST_PAGE_PAINT_BOX.height,
    );
    let lines = vec![test_text_line(vec![test_text_run("BgRound")])];
    let mut content = String::new();
    render_nested_text_block(
        &mut content,
        NestedTextBlock {
            lines: &lines,
            clips: false,
            text_align: TextAlign::Left,
            padding: EdgeSizes::uniform(4.0),
            border: LayoutBorder::default(),
            block_width: Some(100.0),
            block_height: None,
            background_color: Some(Color::rgb(0, 255, 0)),
            background_svg: None,
            background_blur_radius: 0.0,
            background_size: BackgroundSize::Auto,
            background_position: BackgroundPosition::default(),
            background_repeat: BackgroundRepeat::Repeat,
            background_origin: BackgroundOrigin::Padding,
            background_clip: BackgroundClip::Border,
            background_blur_canvas_box: None,
            border_radii: CornerRadii::circular(8.0),
            text_indent: 0.0,
        },
        NestedLayoutFrame::new(
            PdfPoint::new(10.0, 100.0),
            PdfPoint::new(10.0, 100.0),
            100.0,
        ),
        &mut ctx,
    );
    // Green background
    assert!(
        content.contains("0 1 0 rg"),
        "Should have green background color"
    );
    // Rounded rect uses Bezier curves
    assert!(
        content.contains(" c\n"),
        "Should have Bezier curves for border-radius"
    );
    assert!(content.contains("f\n"), "Should fill the rounded rect");
}

/// render_nested_text_block: border rendering (all 4 sides)
#[test]
fn layout_elements_nested_text_block_all_four_borders() {
    let custom_fonts = HashMap::new();
    let prepared_custom_fonts = PreparedCustomFonts::new();
    let mut pdf_writer = PdfWriter::new();
    let mut page_images = Vec::new();
    let mut shadings = Vec::new();
    let mut shading_counter = 0usize;
    let mut page_ext_gstates = Vec::new();
    let mut bg_alpha_counter = 0usize;
    let mut annotations = Vec::new();
    let mut ctx = PageRenderContext::new(
        &mut pdf_writer,
        &mut page_images,
        &custom_fonts,
        &prepared_custom_fonts,
        &mut shadings,
        &mut shading_counter,
        &mut page_ext_gstates,
        &mut bg_alpha_counter,
        &mut annotations,
        TEST_PAGE_PAINT_BOX,
        TEST_PAGE_PAINT_BOX.height,
    );
    let lines = vec![test_text_line(vec![test_text_run("Bordered")])];
    let mut content = String::new();
    let mut border = LayoutBorder::default();
    border.top = crate::layout::engine::LayoutBorderSide {
        width: 1.0,
        color: Color::rgb(255, 0, 0),
        style: crate::style::computed::BorderStyle::Solid,
        ..Default::default()
    };
    border.right = crate::layout::engine::LayoutBorderSide {
        width: 1.0,
        color: Color::rgb(0, 255, 0),
        style: crate::style::computed::BorderStyle::Solid,
        ..Default::default()
    };
    border.bottom = crate::layout::engine::LayoutBorderSide {
        width: 1.0,
        color: Color::rgb(0, 0, 255),
        style: crate::style::computed::BorderStyle::Solid,
        ..Default::default()
    };
    border.left = crate::layout::engine::LayoutBorderSide {
        width: 1.0,
        color: Color::BLACK,
        style: crate::style::computed::BorderStyle::Solid,
        ..Default::default()
    };
    render_nested_text_block(
        &mut content,
        NestedTextBlock {
            lines: &lines,
            clips: false,
            text_align: TextAlign::Left,
            padding: EdgeSizes::uniform(2.0),
            border,
            block_width: Some(100.0),
            block_height: None,
            background_color: None,
            background_svg: None,
            background_blur_radius: 0.0,
            background_size: BackgroundSize::Auto,
            background_position: BackgroundPosition::default(),
            background_repeat: BackgroundRepeat::Repeat,
            background_origin: BackgroundOrigin::Padding,
            background_clip: BackgroundClip::Border,
            background_blur_canvas_box: None,
            border_radii: CornerRadii::ZERO,
            text_indent: 0.0,
        },
        NestedLayoutFrame::new(
            PdfPoint::new(10.0, 100.0),
            PdfPoint::new(10.0, 100.0),
            100.0,
        ),
        &mut ctx,
    );
    // Non-uniform solid sides are exclusive filled regions of one border ring.
    assert!(content.contains("1 0 0 rg"), "Should have red top border");
    assert!(
        content.contains("0 1 0 rg"),
        "Should have green right border"
    );
    assert!(
        content.contains("0 0 1 rg"),
        "Should have blue bottom border"
    );
    assert!(
        content.contains("0 0 0 rg"),
        "Should have black left border"
    );
    let fill_count = content.matches("f\n").count();
    assert!(
        fill_count >= 4,
        "Should have at least 4 exclusive side fills, got {fill_count}"
    );
}

/// render_nested_text_block: background_svg with BackgroundOrigin::Border
#[test]
fn layout_elements_nested_text_block_svg_background_border_origin() {
    let custom_fonts = HashMap::new();
    let prepared_custom_fonts = PreparedCustomFonts::new();
    let mut pdf_writer = PdfWriter::new();
    let mut page_images = Vec::new();
    let mut shadings = Vec::new();
    let mut shading_counter = 0usize;
    let mut page_ext_gstates = Vec::new();
    let mut bg_alpha_counter = 0usize;
    let mut annotations = Vec::new();
    let mut ctx = PageRenderContext::new(
        &mut pdf_writer,
        &mut page_images,
        &custom_fonts,
        &prepared_custom_fonts,
        &mut shadings,
        &mut shading_counter,
        &mut page_ext_gstates,
        &mut bg_alpha_counter,
        &mut annotations,
        TEST_PAGE_PAINT_BOX,
        TEST_PAGE_PAINT_BOX.height,
    );
    let svg_tree = crate::parser::svg::SvgTree {
        width: 10.0,
        height: 10.0,
        width_attr: None,
        height_attr: None,
        preserve_aspect_ratio: crate::parser::svg::SvgPreserveAspectRatio::default(),
        view_box: None,
        defs: Default::default(),
        children: vec![crate::parser::svg::SvgNode::Rect {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
            rx: 0.0,
            ry: 0.0,
            style: crate::parser::svg::SvgStyle {
                fill: crate::parser::svg::SvgPaint::Color(crate::types::Color::rgb(255, 0, 0)),
                ..Default::default()
            },
        }],
        text_ctx: crate::parser::svg::SvgTextContext::default(),
        source_markup: None,
    };
    let mut border = LayoutBorder::default();
    border.top = crate::layout::engine::LayoutBorderSide {
        width: 2.0,
        color: Color::BLACK,
        style: crate::style::computed::BorderStyle::Solid,
        ..Default::default()
    };
    border.bottom = crate::layout::engine::LayoutBorderSide {
        width: 2.0,
        color: Color::BLACK,
        style: crate::style::computed::BorderStyle::Solid,
        ..Default::default()
    };
    border.left = crate::layout::engine::LayoutBorderSide {
        width: 2.0,
        color: Color::BLACK,
        style: crate::style::computed::BorderStyle::Solid,
        ..Default::default()
    };
    border.right = crate::layout::engine::LayoutBorderSide {
        width: 2.0,
        color: Color::BLACK,
        style: crate::style::computed::BorderStyle::Solid,
        ..Default::default()
    };
    let lines = vec![test_text_line(vec![test_text_run("SvgBorder")])];
    let mut content = String::new();
    render_nested_text_block(
        &mut content,
        NestedTextBlock {
            lines: &lines,
            clips: false,
            text_align: TextAlign::Left,
            padding: EdgeSizes::ZERO,
            border,
            block_width: Some(100.0),
            block_height: None,
            background_color: None,
            background_svg: Some(&svg_tree),
            background_blur_radius: 0.0,
            background_size: BackgroundSize::Cover,
            background_position: BackgroundPosition::default(),
            background_repeat: BackgroundRepeat::NoRepeat,
            // Border origin expands ref box by border widths
            background_origin: BackgroundOrigin::Border,
            background_clip: BackgroundClip::Border,
            background_blur_canvas_box: None,
            border_radii: CornerRadii::ZERO,
            text_indent: 0.0,
        },
        NestedLayoutFrame::new(
            PdfPoint::new(10.0, 100.0),
            PdfPoint::new(10.0, 100.0),
            100.0,
        ),
        &mut ctx,
    );
    // SVG rect should produce fill output
    assert!(
        content.contains("1 0 0 rg"),
        "Should have red fill from SVG rect"
    );
    assert!(content.contains("(SvgBorder)"), "Should render block text");
}

/// render_nested_text_block: background_svg with BackgroundOrigin::Content
#[test]
fn layout_elements_nested_text_block_svg_background_content_origin() {
    let custom_fonts = HashMap::new();
    let prepared_custom_fonts = PreparedCustomFonts::new();
    let mut pdf_writer = PdfWriter::new();
    let mut page_images = Vec::new();
    let mut shadings = Vec::new();
    let mut shading_counter = 0usize;
    let mut page_ext_gstates = Vec::new();
    let mut bg_alpha_counter = 0usize;
    let mut annotations = Vec::new();
    let mut ctx = PageRenderContext::new(
        &mut pdf_writer,
        &mut page_images,
        &custom_fonts,
        &prepared_custom_fonts,
        &mut shadings,
        &mut shading_counter,
        &mut page_ext_gstates,
        &mut bg_alpha_counter,
        &mut annotations,
        TEST_PAGE_PAINT_BOX,
        TEST_PAGE_PAINT_BOX.height,
    );
    let svg_tree = crate::parser::svg::SvgTree {
        width: 10.0,
        height: 10.0,
        width_attr: None,
        height_attr: None,
        preserve_aspect_ratio: crate::parser::svg::SvgPreserveAspectRatio::default(),
        view_box: None,
        defs: Default::default(),
        children: vec![crate::parser::svg::SvgNode::Rect {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
            rx: 0.0,
            ry: 0.0,
            style: crate::parser::svg::SvgStyle {
                fill: crate::parser::svg::SvgPaint::Color(crate::types::Color::rgb(0, 0, 255)),
                ..Default::default()
            },
        }],
        text_ctx: crate::parser::svg::SvgTextContext::default(),
        source_markup: None,
    };
    let lines = vec![test_text_line(vec![test_text_run("SvgContent")])];
    let mut content = String::new();
    render_nested_text_block(
        &mut content,
        NestedTextBlock {
            lines: &lines,
            clips: false,
            text_align: TextAlign::Left,
            padding: EdgeSizes::uniform(5.0),
            border: LayoutBorder::default(),
            block_width: Some(100.0),
            block_height: None,
            background_color: None,
            background_svg: Some(&svg_tree),
            background_blur_radius: 0.0,
            background_size: BackgroundSize::Cover,
            background_position: BackgroundPosition::default(),
            background_repeat: BackgroundRepeat::NoRepeat,
            // Content origin shrinks ref box by padding
            background_origin: BackgroundOrigin::Content,
            background_clip: BackgroundClip::Border,
            background_blur_canvas_box: None,
            border_radii: CornerRadii::ZERO,
            text_indent: 0.0,
        },
        NestedLayoutFrame::new(
            PdfPoint::new(10.0, 100.0),
            PdfPoint::new(10.0, 100.0),
            100.0,
        ),
        &mut ctx,
    );
    // SVG rect should produce fill output (blue)
    assert!(
        content.contains("0 0 1 rg"),
        "Should have blue fill from SVG rect"
    );
}

/// render_nested_text_block: empty lines (no text) but with background
#[test]
fn layout_elements_nested_text_block_no_lines_with_background() {
    let custom_fonts = HashMap::new();
    let prepared_custom_fonts = PreparedCustomFonts::new();
    let mut pdf_writer = PdfWriter::new();
    let mut page_images = Vec::new();
    let mut shadings = Vec::new();
    let mut shading_counter = 0usize;
    let mut page_ext_gstates = Vec::new();
    let mut bg_alpha_counter = 0usize;
    let mut annotations = Vec::new();
    let mut ctx = PageRenderContext::new(
        &mut pdf_writer,
        &mut page_images,
        &custom_fonts,
        &prepared_custom_fonts,
        &mut shadings,
        &mut shading_counter,
        &mut page_ext_gstates,
        &mut bg_alpha_counter,
        &mut annotations,
        TEST_PAGE_PAINT_BOX,
        TEST_PAGE_PAINT_BOX.height,
    );
    let mut content = String::new();
    render_nested_text_block(
        &mut content,
        NestedTextBlock {
            lines: &[], // No lines
            clips: false,
            text_align: TextAlign::Left,
            padding: EdgeSizes::ZERO,
            border: LayoutBorder::default(),
            block_width: Some(100.0),
            block_height: Some(50.0), // Explicit height keeps the block visible
            background_color: Some(Color::from_srgb(0.5, 0.5, 0.5, 1.0)),
            background_svg: None,
            background_blur_radius: 0.0,
            background_size: BackgroundSize::Auto,
            background_position: BackgroundPosition::default(),
            background_repeat: BackgroundRepeat::Repeat,
            background_origin: BackgroundOrigin::Padding,
            background_clip: BackgroundClip::Border,
            background_blur_canvas_box: None,
            border_radii: CornerRadii::ZERO,
            text_indent: 0.0,
        },
        NestedLayoutFrame::new(
            PdfPoint::new(10.0, 100.0),
            PdfPoint::new(10.0, 100.0),
            100.0,
        ),
        &mut ctx,
    );
    // Background rect fill should be emitted even with no lines
    assert!(
        content.contains("0.5 0.5 0.5 rg"),
        "Should have gray background fill even with no lines"
    );
    assert!(content.contains("re\nf\n"), "Should have rectangle fill");
}
