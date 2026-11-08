/// Regional font context inherited from an HTML language tag.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum FontLocale {
    /// No regional CJK preference is known.
    #[default]
    Unspecified,
    /// Japanese glyph forms.
    Japanese,
    /// Korean glyph forms and Hangul.
    Korean,
    /// Simplified Chinese glyph forms.
    SimplifiedChinese,
    /// Traditional Chinese glyph forms.
    TraditionalChinese,
}

impl FontLocale {
    /// Parse the CJK preference carried by an HTML `lang` value.
    pub(crate) fn from_html_lang(value: Option<&str>, inherited: Self) -> Self {
        let Some(value) = value else {
            return inherited;
        };
        let Ok(language) = language_tags::LanguageTag::parse(value.trim()) else {
            return Self::Unspecified;
        };

        match language.primary_language() {
            "ja" => Self::Japanese,
            "ko" => Self::Korean,
            "zh" | "cmn" | "yue" => match (language.script(), language.region()) {
                (Some("Hans"), _) | (_, Some("CN" | "SG")) => Self::SimplifiedChinese,
                (Some("Hant"), _) | (_, Some("TW" | "HK" | "MO")) => Self::TraditionalChinese,
                _ => Self::Unspecified,
            },
            _ => Self::Unspecified,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_language_selects_a_regional_cjk_pack() {
        assert_eq!(
            FontLocale::from_html_lang(Some("ja"), FontLocale::Unspecified),
            FontLocale::Japanese
        );
        assert_eq!(
            FontLocale::from_html_lang(Some("ko-KR"), FontLocale::Unspecified),
            FontLocale::Korean
        );
        assert_eq!(
            FontLocale::from_html_lang(Some("zh-Hans"), FontLocale::Unspecified),
            FontLocale::SimplifiedChinese
        );
        assert_eq!(
            FontLocale::from_html_lang(Some("zh-TW"), FontLocale::Unspecified),
            FontLocale::TraditionalChinese
        );
    }

    #[test]
    fn absent_language_inherits_and_invalid_language_clears_the_parent() {
        assert_eq!(
            FontLocale::from_html_lang(None, FontLocale::Japanese),
            FontLocale::Japanese
        );
        assert_eq!(
            FontLocale::from_html_lang(Some("not_a_language"), FontLocale::Japanese),
            FontLocale::Unspecified
        );
    }
}
