//! CSS Text emergency opportunities span adjacent styled source runs.
use super::*;
use unicode_segmentation::UnicodeSegmentation;

impl StyledWord {
    pub(super) fn enable_emergency_group_breaks(
        tokens: &mut [Self],
        runs: &[TextRun],
        options: TextWrapOptions,
        fonts: &HashMap<String, TtfFont>,
    ) {
        if options.overflow_wrap == OverflowWrap::Normal || !options.whitespace.allows_soft_wraps {
            return;
        }
        let mut start = 0;
        while start < tokens.len() {
            let mut end = start + 1;
            while end < tokens.len()
                && !tokens[end].break_before
                && tokens[end].text != "\n"
                && tokens[start].text != "\n"
            {
                end += 1;
            }
            let group = &mut tokens[start..end];
            // Atomic boxes and preserved whitespace retain their own policies.
            if group.len() > 1
                && group.iter().all(|token| {
                    !token.preserve_spacing && runs[token.run_index].inline_box.is_none()
                })
            {
                let mut width = 0.0;
                let mut context = Vec::new();
                let mut previous_whitespace = true;
                for token in group.iter() {
                    width = measure_styled_token_end(
                        token,
                        runs,
                        width,
                        &context,
                        previous_whitespace,
                        options,
                        fonts,
                    );
                    let run = &runs[token.run_index];
                    push_token_shaping_context(&mut context, token, run);
                    previous_whitespace =
                        token.text.chars().last().is_some_and(is_collapsible_space);
                }
                // A single short run's width is not the width of the source
                // word. Only overlong complete groups gain emergency breaks;
                // words that fit a fresh line keep their ordinary boundaries.
                if width_exceeds_limit(width, options.max_width) {
                    let text = group
                        .iter()
                        .map(|token| token.text.as_str())
                        .collect::<String>();
                    let boundaries = text
                        .grapheme_indices(true)
                        .map(|(offset, _)| offset)
                        .collect::<std::collections::HashSet<_>>();
                    let mut offset = 0;
                    for (index, token) in group.iter_mut().enumerate() {
                        if index > 0 && boundaries.contains(&offset) {
                            token.break_before = true;
                        }
                        offset += token.text.len();
                    }
                }
            }
            start = end;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn runs(text: &[&str]) -> Vec<TextRun> {
        text.iter()
            .enumerate()
            .map(|(index, text)| TextRun {
                text: (*text).into(),
                bold: index % 2 == 0,
                ..Default::default()
            })
            .collect()
    }
    #[test]
    fn an_overlong_styled_word_wraps_without_losing_or_inserting_text() {
        let source = runs(&["abc", "def", "ghi", "jkl", "mno", "pqr"]);
        let options = TextWrapOptions::new(40.0, 12.0, 1.2, OverflowWrap::Anywhere);
        let lines = wrap_text_runs(source, options, &HashMap::new());
        assert!(lines.len() > 1);
        assert_eq!(
            lines
                .iter()
                .flat_map(|line| &line.runs)
                .map(|run| run.text.as_str())
                .collect::<String>(),
            "abcdefghijklmnopqr"
        );
        assert!(
            lines
                .iter()
                .all(|line| crate::layout::helpers::measure_runs_width(
                    &line.runs,
                    &HashMap::new()
                ) <= 40.0)
        );
    }
    #[test]
    fn fitting_groups_and_nowrap_keep_their_source_word_boundaries() {
        for options in [
            TextWrapOptions::new(500.0, 12.0, 1.2, OverflowWrap::Anywhere),
            TextWrapOptions::new(1.0, 12.0, 1.2, OverflowWrap::Anywhere)
                .with_white_space(WhiteSpace::NoWrap),
        ] {
            let source = runs(&["abc", "def"]);
            let mut tokens = tokenize_text_runs(&source, options);
            assert!(!tokens[1].break_before);
            StyledWord::enable_emergency_group_breaks(
                &mut tokens,
                &source,
                options,
                &HashMap::new(),
            );
            assert!(!tokens[1].break_before);
        }
    }
    #[test]
    fn a_style_boundary_inside_a_grapheme_is_not_a_break_opportunity() {
        let source = runs(&["a", "\u{301}", "bcdefghijklmnopqrstuvwxyz"]);
        let options = TextWrapOptions::new(20.0, 12.0, 1.2, OverflowWrap::Anywhere);
        let mut tokens = tokenize_text_runs(&source, options);
        StyledWord::enable_emergency_group_breaks(&mut tokens, &source, options, &HashMap::new());
        assert!(!tokens[1].break_before);
        assert!(tokens[2].break_before);
    }
}
