//! Optional fallback fonts loaded explicitly by the caller.

mod fallback;
mod locale;
mod pack;

pub use pack::{FontPack, FontPackError, FontPackKind, UnknownFontPackKind};

pub(crate) use fallback::{
    CJK_JAPANESE_FALLBACK_KEY, CJK_KOREAN_FALLBACK_KEY, CJK_SIMPLIFIED_CHINESE_FALLBACK_KEY,
    CJK_TRADITIONAL_CHINESE_FALLBACK_KEY, FontFallbacks, fallback_keys,
};
pub(crate) use locale::FontLocale;
pub(crate) use pack::FontCatalog;
