    // ── unicode_to_symbol ───────────────────────────────────────────────

    #[test]
    fn unicode_to_symbol_greek_lowercase() {
        assert_eq!(unicode_to_symbol('\u{03B1}'), Some(0x61)); // α
        assert_eq!(unicode_to_symbol('\u{03C0}'), Some(0x70)); // π
        assert_eq!(unicode_to_symbol('\u{03C9}'), Some(0x77)); // ω
    }

    #[test]
    fn unicode_to_symbol_greek_uppercase() {
        assert_eq!(unicode_to_symbol('\u{0393}'), Some(0x47)); // Γ
        assert_eq!(unicode_to_symbol('\u{03A9}'), Some(0x57)); // Ω
        assert_eq!(unicode_to_symbol('\u{03A3}'), Some(0x53)); // Σ
    }

    #[test]
    fn unicode_to_symbol_operators() {
        assert_eq!(unicode_to_symbol('\u{2211}'), Some(0xE5)); // ∑
        assert_eq!(unicode_to_symbol('\u{222B}'), Some(0xF2)); // ∫
        assert_eq!(unicode_to_symbol('\u{221E}'), Some(0xA5)); // ∞
    }

    #[test]
    fn unicode_to_symbol_relations() {
        assert_eq!(unicode_to_symbol('\u{2264}'), Some(0xA3)); // ≤
        assert_eq!(unicode_to_symbol('\u{2265}'), Some(0xB3)); // ≥
        assert_eq!(unicode_to_symbol('\u{2260}'), Some(0xB9)); // ≠
        assert_eq!(unicode_to_symbol('\u{2208}'), Some(0xCE)); // ∈
    }

    #[test]
    fn unicode_to_symbol_arrows() {
        assert_eq!(unicode_to_symbol('\u{2192}'), Some(0xAE)); // →
        assert_eq!(unicode_to_symbol('\u{2190}'), Some(0xAC)); // ←
        assert_eq!(unicode_to_symbol('\u{21D2}'), Some(0xDE)); // ⇒
    }

    #[test]
    fn unicode_to_symbol_delimiters() {
        assert_eq!(unicode_to_symbol('\u{27E8}'), Some(0xE1)); // ⟨
        assert_eq!(unicode_to_symbol('\u{27E9}'), Some(0xF1)); // ⟩
        assert_eq!(unicode_to_symbol('\u{230A}'), Some(0xEB)); // ⌊
        assert_eq!(unicode_to_symbol('\u{2309}'), Some(0xF9)); // ⌉
    }

    #[test]
    fn unicode_to_symbol_binary_ops() {
        assert_eq!(unicode_to_symbol('\u{00D7}'), Some(0xB4)); // ×
        assert_eq!(unicode_to_symbol('\u{00F7}'), Some(0xB8)); // ÷
        assert_eq!(unicode_to_symbol('\u{00B1}'), Some(0xB1)); // ±
    }

    #[test]
    fn unicode_to_symbol_misc() {
        assert_eq!(unicode_to_symbol('\u{2202}'), Some(0xB6)); // ∂
        assert_eq!(unicode_to_symbol('\u{2207}'), Some(0xD1)); // ∇
        assert_eq!(unicode_to_symbol('\u{2200}'), Some(0x22)); // ∀
        assert_eq!(unicode_to_symbol('\u{2203}'), Some(0x24)); // ∃
        assert_eq!(unicode_to_symbol('\u{2205}'), Some(0xC6)); // ∅
    }

    #[test]
    fn unicode_to_symbol_returns_none_for_ascii() {
        assert_eq!(unicode_to_symbol('A'), None);
        assert_eq!(unicode_to_symbol('x'), None);
        assert_eq!(unicode_to_symbol('+'), None);
    }

    // ── render_math_glyphs ──────────────────────────────────────────────

    #[test]
    fn render_math_glyphs_char_italic() {
        use crate::layout::math::MathGlyph;
        let glyphs = vec![MathGlyph::Char {
            ch: 'x',
            x: 10.0,
            y: 20.0,
            font_size: 12.0,
            italic: true,
        }];
        let mut content = String::new();
        render_math_glyphs(&glyphs, 0.0, 0.0, &mut content);
        assert!(content.contains("Helvetica-Oblique"));
        assert!(content.contains("12 Tf"));
    }

    #[test]
    fn render_math_glyphs_char_regular() {
        use crate::layout::math::MathGlyph;
        let glyphs = vec![MathGlyph::Char {
            ch: '2',
            x: 0.0,
            y: 0.0,
            font_size: 10.0,
            italic: false,
        }];
        let mut content = String::new();
        render_math_glyphs(&glyphs, 5.0, 5.0, &mut content);
        assert!(content.contains("/Helvetica 10"));
        assert!(content.contains("(2) Tj"));
    }

    #[test]
    fn render_math_glyphs_symbol_char() {
        use crate::layout::math::MathGlyph;
        let glyphs = vec![MathGlyph::Char {
            ch: '\u{03B1}', // α
            x: 0.0,
            y: 0.0,
            font_size: 12.0,
            italic: false,
        }];
        let mut content = String::new();
        render_math_glyphs(&glyphs, 0.0, 0.0, &mut content);
        assert!(content.contains("/Symbol 12 Tf"));
    }

    #[test]
    fn render_math_glyphs_text() {
        use crate::layout::math::MathGlyph;
        let glyphs = vec![MathGlyph::Text {
            text: "lim".to_string(),
            x: 0.0,
            y: 0.0,
            font_size: 12.0,
        }];
        let mut content = String::new();
        render_math_glyphs(&glyphs, 0.0, 0.0, &mut content);
        assert!(content.contains("/Helvetica 12 Tf"));
        assert!(content.contains("(lim) Tj"));
    }

    #[test]
    fn render_math_glyphs_rule() {
        use crate::layout::math::MathGlyph;
        let glyphs = vec![MathGlyph::Rule {
            x: 10.0,
            y: 20.0,
            width: 50.0,
            thickness: 0.5,
        }];
        let mut content = String::new();
        render_math_glyphs(&glyphs, 0.0, 0.0, &mut content);
        assert!(content.contains("re\nf\n"));
    }

    #[test]
    fn render_math_glyphs_radical() {
        use crate::layout::math::MathGlyph;
        let glyphs = vec![MathGlyph::Radical {
            x: 0.0,
            y: 0.0,
            width: 30.0,
            height: 15.0,
            font_size: 12.0,
        }];
        let mut content = String::new();
        render_math_glyphs(&glyphs, 0.0, 0.0, &mut content);
        // Radical draws lines
        assert!(content.contains(" l\n"));
        assert!(content.contains("S\n"));
    }

    #[test]
    fn render_math_glyphs_delimiter_small() {
        use crate::layout::math::MathGlyph;
        // Small delimiter: height <= font_size * 1.3, renders as text
        let glyphs = vec![MathGlyph::Delimiter {
            ch: '(',
            x: 0.0,
            y: 0.0,
            height: 12.0,
            font_size: 12.0,
        }];
        let mut content = String::new();
        render_math_glyphs(&glyphs, 0.0, 0.0, &mut content);
        assert!(content.contains("Tf\n"));
    }

    #[test]
    fn render_math_glyphs_delimiter_large() {
        use crate::layout::math::MathGlyph;
        // Large delimiter: height > font_size * 1.3, renders as paths
        let glyphs = vec![MathGlyph::Delimiter {
            ch: '(',
            x: 0.0,
            y: 0.0,
            height: 30.0,
            font_size: 12.0,
        }];
        let mut content = String::new();
        render_math_glyphs(&glyphs, 0.0, 0.0, &mut content);
        assert!(content.contains(" c\n")); // cubic bezier for parenthesis
    }

    // ── Math integration via HTML ───────────────────────────────────────

    #[test]
    fn math_inline_produces_symbol_font_in_pdf() {
        let html = r#"<span class="math-inline" data-math="\alpha + \beta">α+β</span>"#;
        let pdf = crate::html_to_pdf(html).unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Symbol"));
    }

    #[test]
    fn math_display_produces_valid_pdf() {
        let html = r#"<div class="math-display" data-math="\frac{a}{b}">a/b</div>"#;
        let pdf = crate::html_to_pdf(html).unwrap();
        assert!(pdf.len() > 100);
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("%PDF"));
    }

    #[test]
    fn math_markdown_inline_renders() {
        let pdf = crate::markdown_to_pdf("The equation $E = mc^2$ is famous.").unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("BT\n"));
        assert!(pdf.len() > 200);
    }

    #[test]
    fn math_markdown_display_renders() {
        let pdf = crate::markdown_to_pdf("$$\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$$").unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Symbol"));
    }

    #[test]
    fn render_rgba_background_produces_extgstate() {
        let html =
            r#"<div style="background-color: rgba(255, 0, 0, 0.5)">Semi-transparent bg</div>"#;
        let nodes = parse_html(html).unwrap();
        let pages = layout(&nodes, PageSize::A4, Margin::default());
        let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
        let content = String::from_utf8_lossy(&pdf);
        assert!(
            content.contains("/ca 0.5"),
            "PDF should contain fill opacity /ca 0.5 for rgba background"
        );
        assert!(
            content.contains("/ExtGState"),
            "PDF should contain ExtGState resource for rgba background"
        );
        assert!(
            content.contains("gs\n"),
            "PDF should use gs operator for rgba background"
        );
    }

    #[test]
    fn math_mixed_text_and_math() {
        let pdf =
            crate::markdown_to_pdf("For $x > 0$, we have $f(x) = x^2$ and $g(x) = \\sqrt{x}$.")
                .unwrap();
        assert!(pdf.len() > 200);
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("%PDF"));
        assert!(text.contains("%%EOF"));
    }

    #[test]
    fn render_box_shadow_no_blur() {
        let html = r#"<div style="width: 100pt; height: 50pt; box-shadow: 5px 5px 0px rgba(0,0,0,0.5)">Shadow</div>"#;
        let nodes = parse_html(html).unwrap();
        let pages = layout(&nodes, PageSize::A4, Margin::default());
        let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
        let content = String::from_utf8_lossy(&pdf);
        // No-blur shadow should draw a solid rect fill
        assert!(
            content.contains("re\nf\n"),
            "Box shadow without blur should produce a filled rectangle"
        );
    }

    #[test]
    fn render_box_shadow_with_blur() {
        let html = r#"<div style="width: 100pt; height: 50pt; box-shadow: 3px 3px 10px rgba(0,0,0,0.4)">Blurred shadow</div>"#;
        let nodes = parse_html(html).unwrap();
        let pages = layout(&nodes, PageSize::A4, Margin::default());
        let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
        let content = String::from_utf8_lossy(&pdf);
        // A blurred box-shadow is now rendered as a gaussian-blurred image
        // XObject (a soft penumbra), embedded and drawn with `Do`, rather than
        // the previous concentric-layer alpha approximation.
        assert!(
            content.contains("Do\n"),
            "Blurred box shadow should embed a blurred image XObject"
        );
    }

    #[test]
    fn any_positive_box_shadow_blur_uses_the_gaussian_path() {
        let html =
            r#"<div style="width:100pt;height:50pt;box-shadow:0 0 0.1pt black">Tiny blur</div>"#;
        let nodes = parse_html(html).unwrap();
        let pages = layout(&nodes, PageSize::A4, Margin::default());
        let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
        let content = String::from_utf8_lossy(&pdf);

        assert!(
            content.contains("Do\n"),
            "a positive CSS blur radius must not be rounded down to a solid rectangle"
        );
    }

    #[test]
    fn render_container_with_background_and_border() {
        let html = r#"
            <div style="background-color: #ccc; border: 2px solid blue; padding: 10px">
                <p>Inside container</p>
            </div>
        "#;
        let nodes = parse_html(html).unwrap();
        let pages = layout(&nodes, PageSize::A4, Margin::default());
        let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
        let content = String::from_utf8_lossy(&pdf);
        // Container background fill
        assert!(
            content.contains("rg\n"),
            "Container should have background color fill"
        );
        assert!(
            content.contains("Inside container"),
            "Container children text should be rendered"
        );
    }

    #[test]
    fn render_flexbox_honors_own_left_margin() {
        // Regression: a top-level flex container must honour its own horizontal
        // margin (like any block). The container background rect must be painted
        // at page-content-left + the container's margin-left, not flush left.
        // Page margin = 72pt (default); container margin-left = 40px = 30pt; so
        // the background rect x-origin must be 102pt.
        let html = r#"
            <div style="display: flex; margin-left: 40px; width: 200px; background-color: #abcdef">
                <div style="width: 50px">A</div>
            </div>
        "#;
        let nodes = parse_html(html).unwrap();
        let pages = layout(&nodes, PageSize::A4, Margin::default());
        let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
        let content = String::from_utf8_lossy(&pdf);
        // The container background fill rectangle starts at x = 102 (72 + 30).
        assert!(
            content.contains("102 ") && content.contains("re\nf\n"),
            "flex container background must be shifted right by its margin-left \
             (expected x-origin 102pt); content did not contain it.\n{content}"
        );
        // It must NOT be painted flush at the page content-left (72pt).
        assert!(
            !content.contains("\n72 "),
            "flex container background must not be flush at page content-left"
        );
    }

    #[test]
    fn render_flexbox_with_background_color() {
        let html = r#"
            <div style="display: flex; background-color: yellow; padding: 8px">
                <div style="flex: 1">A</div>
                <div style="flex: 1">B</div>
            </div>
        "#;
        let nodes = parse_html(html).unwrap();
        let pages = layout(&nodes, PageSize::A4, Margin::default());
        let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
        let content = String::from_utf8_lossy(&pdf);
        // Yellow bg = 1 1 0 rg
        assert!(
            content.contains("1 1 0 rg"),
            "FlexRow should render yellow background"
        );
    }

    #[test]
    fn render_transform_skew_matrix_in_pdf() {
        // skew() produces a Transform::Matrix variant, exercising the Matrix arm
        let html = r#"<div style="transform: skew(10deg); width: 50pt; height: 30pt; background: red">Skewed</div>"#;
        let nodes = parse_html(html).unwrap();
        let pages = layout(&nodes, PageSize::A4, Margin::default());
        let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
        let content = String::from_utf8_lossy(&pdf);
        // skew(10deg) produces a Matrix transform which emits a cm operator
        assert!(
            content.contains("cm\n"),
            "CSS transform: skew() should produce a cm (concat matrix) operator in PDF"
        );
    }

    #[test]
    fn render_grid_item_overflow_hidden_paints_clipped_inner_block() {
        // A grid item with overflow:hidden and an oversized inner block must
        // paint the inner block (clipped to the cell), not drop it. Regression
        // test for the grid-cell nested-block clip path.
        let html = r#"
            <div style="display: grid; grid-template-columns: 100px 100px; gap: 10px; width: 210px">
                <div style="overflow: hidden; height: 80px; background: #eee">
                    <div style="width: 200px; height: 160px; background: #2874a6"></div>
                </div>
                <div style="height: 80px; background: #ddd"></div>
            </div>
        "#;
        let nodes = parse_html(html).unwrap();
        let pages = layout(&nodes, PageSize::A4, Margin::default());
        let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
        let content = String::from_utf8_lossy(&pdf);
        assert!(pdf.starts_with(b"%PDF"));
        // The inner block fill colour #2874a6 (0.156.. 0.454.. 0.650..) must be
        // emitted, proving the oversized inner block is painted inside the cell.
        assert!(
            content.contains("0.1569 0.4549 0.651 rg"),
            "grid item's oversized inner block should be painted (clipped) inside the cell"
        );
        // And a clip (W n) must be present for the overflow:hidden cell.
        assert!(
            content.contains("W n"),
            "overflow:hidden grid cell should emit a clip path"
        );
    }

    #[test]
    fn render_container_with_border_radius() {
        let html = r#"
            <div style="background-color: blue; border-radius: 10px; width: 100pt; height: 60pt; padding: 10px">
                <p>Rounded</p>
            </div>
        "#;
        let nodes = parse_html(html).unwrap();
        let pages = layout(&nodes, PageSize::A4, Margin::default());
        let pdf = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
        let content = String::from_utf8_lossy(&pdf);
        // Rounded rect uses Bezier curves (c operator)
        assert!(
            content.contains(" c\n"),
            "Border radius should produce Bezier curve operators"
        );
    }

    #[test]
    fn render_pdf_to_writer_produces_same_output() {
        let nodes = parse_html("<p>Writer test</p>").unwrap();
        let pages = layout(&nodes, PageSize::A4, Margin::default());
        let pdf_bytes = render_pdf(&pages, PageSize::A4, Margin::default()).unwrap();
        let mut writer_buf = Vec::new();
        render_pdf_to_writer(&pages, PageSize::A4, Margin::default(), &mut writer_buf).unwrap();
        assert_eq!(
            pdf_bytes.len(),
            writer_buf.len(),
            "render_pdf and render_pdf_to_writer should produce identical output"
        );
        assert_eq!(pdf_bytes, writer_buf);
    }
