use super::*;

pub(super) struct ShapedTextRender<'a> {
    origin: PdfPoint,
    font_size: f32,
    layout_to_text_scale: f32,
    text_y_axis: f32,
    font: &'a TtfFont,
    shaped: &'a crate::text::ShapedRun,
    prepared_font: Option<&'a PreparedCustomFont>,
    /// Extra advance (in PDF text-space units) to insert after each space
    /// cluster (U+0020).  Carries CSS `word-spacing` plus the per-space
    /// `text-align: justify` stretch.  Type0 / Identity-H text ignores the
    /// PDF `Tw` operator (it only applies to single-byte code 32), so this
    /// must be baked into the TJ array as a negative adjustment instead.
    word_spacing: f32,
    letter_spacing: f32,
    /// Synthetic-italic shear (the text-matrix `c` term): a face with no genuine
    /// italic gets an algorithmic oblique slant (CSS Fonts 4 `font-synthesis:
    /// style`). 0 = upright. Matches Skia/Chrome's synthetic skew (0.25).
    shear: f32,
    scale_x: f32,
}

impl<'a> ShapedTextRender<'a> {
    pub(super) fn new(
        origin: PdfPoint,
        font_size: f32,
        font: &'a TtfFont,
        shaped: &'a crate::text::ShapedRun,
        prepared_font: Option<&'a PreparedCustomFont>,
        text_space: PdfContentSpace,
    ) -> Self {
        Self {
            origin: text_space.point(origin),
            font_size: font.adjusted_font_size(text_space.length(font_size)),
            layout_to_text_scale: text_space.length(1.0),
            text_y_axis: text_space.y_axis(),
            font,
            shaped,
            prepared_font,
            word_spacing: 0.0,
            letter_spacing: 0.0,
            shear: 0.0,
            scale_x: 1.0,
        }
    }

    pub(super) const fn with_word_spacing(mut self, word_spacing: f32) -> Self {
        self.word_spacing = word_spacing * self.layout_to_text_scale;
        self
    }

    pub(super) const fn with_letter_spacing(mut self, letter_spacing: f32) -> Self {
        self.letter_spacing = letter_spacing * self.layout_to_text_scale;
        self
    }

    pub(super) const fn with_shear(mut self, shear: f32) -> Self {
        // `c` controls the physical horizontal displacement of glyph tops. The
        // text matrix's `d` term and the surrounding PageCss transform already
        // account for the Y-axis direction; reflecting `c` as well reverses the
        // visible oblique direction.
        self.shear = shear;
        self
    }

    /// Extra TJ adjustment (thousandths of an em / text-space units) to add
    /// after `glyph` when it is a space cluster.  A positive `Tj` number moves
    /// the cursor left, so the returned adjustment is negative in order to
    /// *widen* the gap after the space.
    fn space_tj_adjustment(&self, glyph: &crate::text::ShapedGlyph) -> f32 {
        if self.word_spacing == 0.0 {
            return 0.0;
        }
        if glyph.unicode.as_slice() == [0x0020] {
            -(self.word_spacing * 1000.0 / self.font_size.max(f32::EPSILON))
        } else {
            0.0
        }
    }

    pub(super) fn has_complex_offsets(&self) -> bool {
        self.shaped
            .glyphs
            .iter()
            .any(|glyph| glyph.x_offset != 0.0 || glyph.y_offset != 0.0)
    }

    fn encode_glyph(&self, glyph_id: u16) -> String {
        self.prepared_font.map_or_else(
            || encode_pdf_hex_glyph(glyph_id),
            |prepared_font| prepared_font.encode_glyph(glyph_id),
        )
    }
}

pub(crate) fn append_pdf_tj_adjustment(content: &mut String, adjustment: f32) {
    if adjustment != 0.0 {
        content.push(' ');
        content.push_str(&format_pdf_number(adjustment));
    }
}

fn sfnt_has_table(data: &[u8], tag: &[u8; 4]) -> bool {
    let base = if data.len() >= 16 && &data[0..4] == b"ttcf" {
        let first_offset = u32::from_be_bytes([data[12], data[13], data[14], data[15]]) as usize;
        if first_offset >= data.len() {
            return false;
        }
        first_offset
    } else {
        0
    };
    if data.len() < base + 12 {
        return false;
    }
    let num_tables = u16::from_be_bytes([data[base + 4], data[base + 5]]) as usize;
    let dir_end = base + 12 + num_tables.saturating_mul(16);
    if dir_end > data.len() {
        return false;
    }
    (0..num_tables).any(|i| &data[base + 12 + i * 16..base + 16 + i * 16] == tag)
}

pub(crate) fn sfnt_has_cff_outlines(data: &[u8]) -> bool {
    sfnt_has_table(data, b"CFF ") || sfnt_has_table(data, b"CFF2")
}

pub(super) fn append_positioned_shaped_text(content: &mut String, render: ShapedTextRender<'_>) {
    let mut cursor_x = render.origin.x;
    let last_idx = render.shaped.glyphs.len().saturating_sub(1);
    for (idx, glyph) in render.shaped.glyphs.iter().enumerate() {
        let draw_x = cursor_x + glyph.x_offset * render.layout_to_text_scale;
        let draw_y =
            render.origin.y + glyph.y_offset * render.layout_to_text_scale * render.text_y_axis;
        let encoded = render.encode_glyph(glyph.glyph_id);
        content.push_str(&format!(
            "{} 0 {} {} {} {} Tm\n",
            format_pdf_number(render.scale_x),
            format_pdf_number(render.shear),
            format_pdf_number(render.text_y_axis),
            format_pdf_number(draw_x),
            format_pdf_number(draw_y),
        ));
        content.push_str(&format!("<{encoded}> Tj\n"));
        cursor_x += glyph.x_advance * render.layout_to_text_scale;
        if idx < last_idx {
            cursor_x += render.letter_spacing;
        }
        // Identity-H ignores the PDF `Tw` operator, so widen the gap after
        // each space cluster by advancing the cursor manually.
        if render.word_spacing != 0.0 && glyph.unicode.as_slice() == [0x0020] {
            cursor_x += render.word_spacing;
        }
    }
}

/// Emit a top-to-bottom shaped run one glyph at a time.
///
/// PDF Type0 text does not have a vertical writing mode in this renderer, so
/// each glyph receives the exact vertical OpenType origin selected by the
/// shaper.  Unlike horizontal `TJ`, the cursor advances on Y between glyphs.
pub(super) fn append_positioned_vertical_shaped_text(
    content: &mut String,
    origin: PdfPoint,
    shaped: &crate::text::VerticalShapedRun,
    prepared_font: Option<&PreparedCustomFont>,
) {
    let mut cursor_y = origin.y;
    for glyph in &shaped.glyphs {
        let encoded = prepared_font.map_or_else(
            || encode_pdf_hex_glyph(glyph.glyph_id),
            |font| font.encode_glyph(glyph.glyph_id),
        );
        content.push_str(&format!(
            "1 0 0 1 {} {} Tm\n",
            format_pdf_number(origin.x + glyph.x_offset),
            format_pdf_number(cursor_y + glyph.y_offset),
        ));
        content.push_str(&format!("<{encoded}> Tj\n"));
        cursor_y += glyph.y_advance;
    }
}

pub(super) fn append_tj_shaped_text(content: &mut String, render: ShapedTextRender<'_>) {
    content.push_str(&format!(
        "{} 0 {} {} {} {} Tm\n",
        format_pdf_number(render.scale_x),
        format_pdf_number(render.shear),
        format_pdf_number(render.text_y_axis),
        format_pdf_number(render.origin.x),
        format_pdf_number(render.origin.y),
    ));
    content.push('[');

    let mut first = true;
    let last_idx = render.shaped.glyphs.len().saturating_sub(1);
    for (idx, glyph) in render.shaped.glyphs.iter().enumerate() {
        if !first {
            content.push(' ');
        }
        first = false;

        let encoded = render.encode_glyph(glyph.glyph_id);
        content.push('<');
        content.push_str(&encoded);
        content.push('>');

        let nominal_advance = render
            .font
            .glyph_width_scaled(glyph.glyph_id, render.font_size);
        let advance_adjustment = glyph.x_advance * render.layout_to_text_scale - nominal_advance;
        // Fold the shaper advance/kerning delta together with any extra
        // inter-word spacing (CSS word-spacing + justify stretch) for space
        // clusters, so a single TJ number carries both.
        let kern_adjustment = -(advance_adjustment * 1000.0 / render.font_size.max(f32::EPSILON));
        let letter_adjustment = if idx < last_idx {
            -(render.letter_spacing * 1000.0 / render.font_size.max(f32::EPSILON))
        } else {
            0.0
        };
        let tj_adjustment = kern_adjustment + render.space_tj_adjustment(glyph) + letter_adjustment;
        append_pdf_tj_adjustment(content, tj_adjustment);
    }

    content.push_str("] TJ\n");
}
