//! Vertical inline composition shared by block layout and PDF painting.
//!
//! `text-combine-upright` changes the inline formatting units, not the outer
//! block's physical box. Keeping this expansion separate from block layout
//! makes the one-em advance explicit and prevents ordinary vertical glyphs
//! from accidentally inheriting the composition rule at paint time.

use crate::layout::engine::{TextLine, TextRun};
use crate::layout::text::is_collapsible_space;
use crate::style::computed::TextCombineUpright;

/// Expand upright vertical lines into one line per typographic unit.
///
/// A retained `text-combine-upright` rule marks one resulting line as a
/// horizontal-in-vertical composition. Runs never combine across a box
/// boundary because each [`TextRun`] is expanded independently.
pub(crate) fn upright_lines(lines: &[TextLine]) -> Vec<TextLine> {
    let mut out = Vec::new();
    for line in lines {
        for run in &line.runs {
            if run.inline_box.is_some() {
                out.push(TextLine {
                    runs: vec![run.clone()],
                    height: line.height,
                    baseline_ascent: line.baseline_ascent,
                    x_offset: line.x_offset,
                    metadata: line.metadata,
                });
                continue;
            }
            match run.metadata.text_combine_upright {
                TextCombineUpright::All => {
                    if run.text.chars().any(|ch| !is_collapsible_space(ch)) {
                        push_upright_line(&mut out, line, run, run.text.clone(), true);
                    }
                }
                TextCombineUpright::Digits(limit) => {
                    push_digit_lines(&mut out, line, run, limit);
                }
                TextCombineUpright::None => {
                    for ch in run.text.chars().filter(|ch| !is_collapsible_space(*ch)) {
                        push_upright_line(&mut out, line, run, ch.to_string(), false);
                    }
                }
            }
        }
    }
    out
}

fn push_digit_lines(out: &mut Vec<TextLine>, line: &TextLine, run: &TextRun, limit: u8) {
    let mut chars = run.text.chars().peekable();
    while let Some(ch) = chars.next() {
        if !ch.is_ascii_digit() {
            if !is_collapsible_space(ch) {
                push_upright_line(out, line, run, ch.to_string(), false);
            }
            continue;
        }

        let mut digits = String::from(ch);
        while let Some(next) = chars.peek().copied() {
            if !next.is_ascii_digit() {
                break;
            }
            digits.push(next);
            chars.next();
        }
        if digits.chars().count() <= usize::from(limit) {
            push_upright_line(out, line, run, digits, true);
        } else {
            for digit in digits.chars() {
                push_upright_line(out, line, run, digit.to_string(), false);
            }
        }
    }
}

fn push_upright_line(
    out: &mut Vec<TextLine>,
    source: &TextLine,
    template: &TextRun,
    text: String,
    composition: bool,
) {
    let mut run = template.clone();
    run.text = text;
    if composition {
        // CSS Writing Modes §9.1.2 composes the text like a horizontal inline
        // block, ignoring author letter-spacing.
        run.metadata.spacing.letter = 0.0;
    } else {
        run.metadata.text_combine_upright = TextCombineUpright::None;
    }
    out.push(TextLine {
        runs: vec![run],
        height: upright_advance(template, source.height),
        baseline_ascent: None,
        x_offset: source.x_offset,
        metadata: source.metadata,
    });
}

fn upright_advance(run: &TextRun, fallback: f32) -> f32 {
    if run.font_size.is_finite() && run.font_size > 0.0 {
        run.font_size
    } else {
        fallback.max(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digits_combines_only_complete_short_ascii_sequences() {
        let line = TextLine {
            runs: vec![TextRun {
                text: "A12B123 7".into(),
                font_size: 24.0,
                metadata: crate::layout::engine::TextRunMetadata {
                    text_combine_upright: TextCombineUpright::Digits(2),
                    ..Default::default()
                },
                ..Default::default()
            }],
            height: 32.0,
            ..Default::default()
        };

        let lines = upright_lines(&[line]);
        let text: Vec<_> = lines
            .iter()
            .map(|line| line.runs[0].text.as_str())
            .collect();
        assert_eq!(text, ["A", "12", "B", "1", "2", "3", "7"]);
        assert!(!lines[0].runs[0].metadata.text_combine_upright.is_active());
        assert!(lines[1].runs[0].metadata.text_combine_upright.is_active());
        assert!(!lines[3].runs[0].metadata.text_combine_upright.is_active());
        assert!(lines[6].runs[0].metadata.text_combine_upright.is_active());
        assert!(lines.iter().all(|line| line.height == 24.0));
    }
}
