//! Stable identities and grapheme-preserving selection for bundled fonts.
//! Coverage describes available outlines, not complete document layout support.
use crate::font_embedder::{bundled_noto_emoji, bundled_noto_sans_sc};
use handler_common::HandlerError;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FontIdentity {
    pub id: String,
    pub sha256: String,
    pub face_index: u32,
    pub family: String,
    pub style: String,
    pub weight: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BuiltinFont {
    SansSc,
    Emoji,
}
impl BuiltinFont {
    pub(crate) fn bytes(self) -> &'static [u8] {
        match self {
            Self::SansSc => bundled_noto_sans_sc(),
            Self::Emoji => bundled_noto_emoji(),
        }
    }
    pub(crate) fn identity(self) -> &'static FontIdentity {
        &bundled_font_catalog()[match self {
            Self::SansSc => 0,
            Self::Emoji => 1,
        }]
    }
}

/// Inspect the default instance of one font face. Variation coordinates are
/// intentionally not accepted until the embedding/rendering pipeline supports them.
pub fn font_identity(bytes: &[u8], face_index: u32) -> Result<FontIdentity, HandlerError> {
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(error("font file exceeds 64 MiB"));
    }
    let face =
        ttf_parser::Face::parse(bytes, face_index).map_err(|_| error("invalid font face"))?;
    let family = face
        .names()
        .into_iter()
        .filter(|name| name.name_id == ttf_parser::name_id::FAMILY)
        .find_map(|name| name.to_string())
        .unwrap_or_else(|| "Unnamed font".into());
    let hash = format!("{:x}", Sha256::digest(bytes));
    Ok(FontIdentity {
        id: format!("sha256:{hash}#{face_index}"),
        sha256: hash,
        face_index,
        family,
        style: if face.is_italic() { "italic" } else { "normal" }.into(),
        weight: face.weight().to_number(),
    })
}

/// Content hash plus collection face index identifies the actual font bytes.
/// Family names alone cannot distinguish different releases or font files.
pub fn bundled_font_catalog() -> &'static [FontIdentity; 2] {
    static CATALOG: OnceLock<[FontIdentity; 2]> = OnceLock::new();
    CATALOG.get_or_init(|| {
        [
            (BuiltinFont::SansSc, "Noto Sans SC"),
            (BuiltinFont::Emoji, "Noto Emoji"),
        ]
        .map(|(font, family)| {
            let hash = format!("{:x}", Sha256::digest(font.bytes()));
            FontIdentity {
                id: format!("sha256:{hash}#0"),
                sha256: hash,
                face_index: 0,
                family: family.into(),
                style: "normal".into(),
                weight: 400,
            }
        })
    })
}

pub(crate) struct FontRun<'a> {
    pub font: BuiltinFont,
    pub text: &'a str,
}

fn default_ignorable(character: char) -> bool {
    matches!(character as u32, 0x200C..=0x200D | 0xFE00..=0xFE0F | 0xE0020..=0xE007F | 0xE0100..=0xE01EF)
}

/// Select a whole grapheme, never split combining marks, emoji modifiers or ZWJ.
/// The single-line painter has no paragraph/bidi layout; those inputs must use
/// the document renderer rather than quietly disappearing or being reordered.
pub(crate) fn bundled_font_runs(text: &str) -> Result<Vec<FontRun<'_>>, HandlerError> {
    if text.len() > 16 * 1024 || text.chars().count() > 4096 {
        return Err(error(
            "fallback text exceeds the 4096-character/16-KiB limit",
        ));
    }
    if text
        .chars()
        .any(|c| c.is_control() || matches!(c as u32, 0x2028..=0x202E | 0x2066..=0x2069))
    {
        return Err(error(
            "fallback painter requires one line without control or bidi layout characters",
        ));
    }
    let sans = rustybuzz::Face::from_slice(BuiltinFont::SansSc.bytes(), 0)
        .ok_or_else(|| error("invalid bundled CJK font"))?;
    let emoji = rustybuzz::Face::from_slice(BuiltinFont::Emoji.bytes(), 0)
        .ok_or_else(|| error("invalid bundled emoji font"))?;
    let mut runs: Vec<FontRun<'_>> = Vec::new();
    for (start, grapheme) in text.grapheme_indices(true) {
        let prefer_emoji = grapheme
            .chars()
            .any(|c| matches!(c as u32, 0xFE0F | 0x20E3 | 0x1F000..=0x1FAFF));
        let candidates = if prefer_emoji {
            [BuiltinFont::Emoji, BuiltinFont::SansSc]
        } else {
            [BuiltinFont::SansSc, BuiltinFont::Emoji]
        };
        let selected = candidates
            .into_iter()
            .find(|font| {
                let face = match font {
                    BuiltinFont::SansSc => &sans,
                    BuiltinFont::Emoji => &emoji,
                };
                let mut previous = None;
                for character in grapheme.chars() {
                    // IVS and mathematical variation selectors request a real
                    // alternate glyph, rather than just emoji/text presentation.
                    if matches!(character as u32, 0xFE00..=0xFE0D | 0xE0100..=0xE01EF) {
                        if previous
                            .and_then(|base| face.glyph_variation_index(base, character))
                            .is_none()
                        {
                            return false;
                        }
                    } else if !default_ignorable(character) && face.glyph_index(character).is_none()
                    {
                        return false;
                    }
                    previous = Some(character);
                }
                true
            })
            .ok_or_else(|| {
                let scalars = grapheme
                    .chars()
                    .take(16)
                    .map(|c| format!("U+{:04X}", c as u32))
                    .collect::<Vec<_>>()
                    .join(" ");
                error(&format!(
                    "no bundled font covers the complete grapheme ({scalars})"
                ))
            })?;
        if let Some(previous) = runs.last_mut().filter(|run| run.font == selected) {
            let begin = start - previous.text.len();
            previous.text = &text[begin..start + grapheme.len()];
        } else {
            runs.push(FontRun {
                font: selected,
                text: grapheme,
            });
        }
    }
    Ok(runs)
}

fn error(message: &str) -> HandlerError {
    HandlerError::OperationFailed(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identities_match_payloads_and_distinguish_fonts() {
        let fonts = bundled_font_catalog();
        assert_ne!(fonts[0].id, fonts[1].id);
        for (index, bytes) in [bundled_noto_sans_sc(), bundled_noto_emoji()]
            .iter()
            .enumerate()
        {
            assert_eq!(fonts[index].sha256, format!("{:x}", Sha256::digest(bytes)));
            assert_eq!(fonts[index].id, format!("sha256:{}#0", fonts[index].sha256));
            let inspected = font_identity(bytes, 0).unwrap();
            assert_eq!(inspected.id, fonts[index].id);
            assert_eq!(inspected.weight, 400);
        }
    }
    #[test]
    fn mixed_text_uses_complete_emoji_graphemes_and_preserves_every_byte() {
        let text = "中文A😀👨‍👩‍👧‍👦👍🏽🇨🇳B";
        let runs = bundled_font_runs(text).unwrap();
        assert_eq!(runs.iter().map(|run| run.text).collect::<String>(), text);
        assert_eq!(runs.len(), 3);
        assert_eq!(runs[1].font, BuiltinFont::Emoji);
        assert_eq!(runs[1].text, "😀👨‍👩‍👧‍👦👍🏽🇨🇳");
    }
    #[test]
    fn missing_glyphs_and_layout_controls_are_explicit_errors() {
        for text in [
            "əʊ",
            "A\u{FE00}",
            "中\u{E01EF}",
            "\u{10FFFF}",
            "A\nB",
            "A\rB",
            "A\tB",
            "A\u{2028}B",
            "\u{202E}ABC",
        ] {
            assert!(bundled_font_runs(text).is_err(), "{text:?}");
        }
        assert!(bundled_font_runs(&"a".repeat(4097)).is_err());
    }
}
