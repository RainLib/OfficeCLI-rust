//! Same-machine font catalog. Documents store only a `themeRevisionId`.
//! The catalog directory holds immutable font revisions, theme revisions, and
//! content-addressed font blobs. There is no tenant field in this schema.

use crate::bundle::{atomic_write, read_bytes_bounded, read_json_bounded};
use crate::{hash_bytes, manifest_at_revision, Bundle, HcdError};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FONT_CATALOG_SCHEMA: &str = "hcd-font-catalog/1";
pub const THEME_SCHEMA: &str = "hcd-theme/1";
const MAX_FONT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_CATALOG_JSON_BYTES: u64 = 1024 * 1024;
const MAX_FACES: usize = 32;
const MAX_PRESENTATION_FACE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct DiskCatalog {
    root: PathBuf,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum FontStyle {
    Normal,
    Italic,
    Oblique,
}

impl FontStyle {
    fn css(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Italic => "italic",
            Self::Oblique => "oblique",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum FontStretch {
    Normal,
    Condensed,
    Expanded,
}

impl FontStretch {
    fn css(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Condensed => "condensed",
            Self::Expanded => "expanded",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum FontScript {
    Latin,
    EastAsia,
    Bidi,
    Hans,
    Hant,
    Arab,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FontFileFormat {
    Woff2,
    Otf,
    Ttf,
}

impl FontFileFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Woff2 => "woff2",
            Self::Otf => "otf",
            Self::Ttf => "ttf",
        }
    }

    pub fn media_type(self) -> &'static str {
        match self {
            Self::Woff2 => "font/woff2",
            Self::Otf => "font/otf",
            Self::Ttf => "font/ttf",
        }
    }

    fn css_format(self) -> &'static str {
        match self {
            Self::Woff2 => "woff2",
            Self::Otf => "opentype",
            Self::Ttf => "truetype",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FontLicense {
    pub name: String,
    pub web_preview: bool,
    pub ooxml_embed: bool,
    pub pdf_embed: bool,
    pub redistribution: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_epoch_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FontFace {
    pub family: String,
    pub subfamily: String,
    pub weight: u16,
    pub style: FontStyle,
    pub stretch: FontStretch,
    pub scripts: Vec<FontScript>,
    pub format: FontFileFormat,
    pub sha256: String,
    pub byte_length: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FontRevision {
    pub schema_version: String,
    pub font_id: String,
    pub font_revision_id: String,
    pub family: String,
    pub faces: Vec<FontFace>,
    pub license: FontLicense,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FontRef {
    pub font_id: String,
    pub font_revision_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeFontSlots {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latin: Option<FontRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub east_asia: Option<FontRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bidi: Option<FontRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeRevision {
    pub schema_version: String,
    pub theme_revision_id: String,
    pub name: String,
    pub major: ThemeFontSlots,
    pub minor: ThemeFontSlots,
    pub fallback_families: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedFace {
    pub slot: String,
    pub font_id: String,
    pub font_revision_id: String,
    pub family: String,
    pub subfamily: String,
    pub weight: u16,
    pub style: FontStyle,
    pub stretch: FontStretch,
    pub scripts: Vec<FontScript>,
    pub format: FontFileFormat,
    pub sha256: String,
    pub byte_length: u64,
    pub href: String,
    pub web_preview: bool,
    pub ooxml_embed: bool,
    pub pdf_embed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTheme {
    pub theme_revision_id: String,
    pub name: String,
    pub css: String,
    pub faces: Vec<ResolvedFace>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentThemeResolution {
    pub document_id: String,
    pub revision: u64,
    pub theme_revision_id: String,
    pub theme: ResolvedTheme,
}

impl DiskCatalog {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, HcdError> {
        let root = root.as_ref();
        fs::create_dir_all(root.join("themes"))?;
        fs::create_dir_all(root.join("fonts"))?;
        fs::create_dir_all(root.join("blobs"))?;
        Ok(Self {
            root: root.canonicalize()?,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Store font bytes by SHA-256. The same digest is reused by every revision.
    pub fn put_font_bytes(&self, bytes: &[u8], format: FontFileFormat) -> Result<String, HcdError> {
        if bytes.is_empty() || bytes.len() as u64 > MAX_FONT_BYTES {
            return Err(HcdError::ResourceLimit(format!(
                "font file must be between 1 byte and {MAX_FONT_BYTES} bytes"
            )));
        }
        let sha256 = hash_bytes(bytes);
        let path = self.blob_path(&sha256, format)?;
        if path.exists() {
            let existing = read_bytes_bounded(&path, MAX_FONT_BYTES, "font blob")?;
            if existing != bytes {
                return Err(HcdError::InvalidBundle(format!(
                    "font blob {sha256} already exists with different bytes"
                )));
            }
            return Ok(sha256);
        }
        atomic_write(&path, bytes)?;
        Ok(sha256)
    }

    pub fn put_font_revision(&self, revision: &FontRevision) -> Result<(), HcdError> {
        let mut revision = revision.clone();
        validate_font_revision(&revision)?;
        revision.font_revision_id = content_id(&revision, "fontRevisionId")?;
        for face in &revision.faces {
            let path = self.blob_path(&face.sha256, face.format)?;
            let bytes = read_bytes_bounded(&path, MAX_FONT_BYTES, "font blob").map_err(|_| {
                HcdError::NotFound(format!(
                    "font blob {} for {}",
                    face.sha256, revision.font_id
                ))
            })?;
            if hash_bytes(&bytes) != face.sha256 || bytes.len() as u64 != face.byte_length {
                return Err(HcdError::InvalidBundle(format!(
                    "font blob {} does not match its descriptor",
                    face.sha256
                )));
            }
        }
        let path = self.font_revision_path(&revision.font_id, &revision.font_revision_id)?;
        write_immutable_json(&path, &revision)
    }

    pub fn put_theme(&self, theme: &ThemeRevision) -> Result<String, HcdError> {
        let mut theme = theme.clone();
        validate_theme_shape(&theme)?;
        theme.theme_revision_id = content_id(&theme, "themeRevisionId")?;
        for font_ref in theme_refs(&theme) {
            let _ = self.font_revision(&font_ref.font_id, &font_ref.font_revision_id)?;
        }
        let path = self.theme_path(&theme.theme_revision_id)?;
        write_immutable_json(&path, &theme)?;
        Ok(theme.theme_revision_id)
    }

    pub fn resolve(
        &self,
        theme_revision_id: &str,
        file_href: impl Fn(&str, &str, &str) -> String,
    ) -> Result<ResolvedTheme, HcdError> {
        let theme = self.theme(theme_revision_id)?;
        let mut fonts = BTreeMap::new();
        for font_ref in theme_refs(&theme) {
            let key = (font_ref.font_id.clone(), font_ref.font_revision_id.clone());
            if let std::collections::btree_map::Entry::Vacant(entry) = fonts.entry(key) {
                entry.insert(self.font_revision(&font_ref.font_id, &font_ref.font_revision_id)?);
            }
        }
        let now = now_epoch_ms();
        let mut warnings = Vec::new();
        let mut faces = Vec::new();
        let mut seen_css = BTreeSet::new();
        let mut css = String::new();
        for (slot, font_ref) in theme_slots(&theme) {
            let font = &fonts[&(font_ref.font_id.clone(), font_ref.font_revision_id.clone())];
            let expired = font
                .license
                .expires_at_epoch_ms
                .is_some_and(|expires| expires <= now);
            if expired {
                let warning = format!(
                    "font {} revision {} license expired; preview and embed flags were cleared",
                    font.font_id, font.font_revision_id
                );
                if !warnings.contains(&warning) {
                    warnings.push(warning);
                }
            }
            let web_preview = font.license.web_preview && !expired;
            let ooxml_embed = font.license.ooxml_embed && !expired;
            let pdf_embed = font.license.pdf_embed && !expired;
            for face in &font.faces {
                let href = file_href(&font.font_id, &font.font_revision_id, &face.sha256);
                if !href.is_empty() && href_is_unsafe(&href) {
                    return Err(HcdError::InvalidBundle(
                        "resolved font href contains unsafe characters".to_string(),
                    ));
                }
                if web_preview
                    && !href.is_empty()
                    && seen_css.insert((face.sha256.clone(), face.weight, face.style))
                {
                    css.push_str(&format!(
                        "@font-face{{font-family:'{}';font-style:{};font-weight:{};font-stretch:{};src:url(\"{href}\") format(\"{}\");}}\n",
                        font.family,
                        face.style.css(),
                        face.weight,
                        face.stretch.css(),
                        face.format.css_format()
                    ));
                }
                faces.push(ResolvedFace {
                    slot: slot.to_string(),
                    font_id: font.font_id.clone(),
                    font_revision_id: font.font_revision_id.clone(),
                    family: font.family.clone(),
                    subfamily: face.subfamily.clone(),
                    weight: face.weight,
                    style: face.style,
                    stretch: face.stretch,
                    scripts: face.scripts.clone(),
                    format: face.format,
                    sha256: face.sha256.clone(),
                    byte_length: face.byte_length,
                    href,
                    web_preview,
                    ooxml_embed,
                    pdf_embed,
                });
            }
            css.push_str(&format!(
                ":root{{--hcd-{slot}:'{}'{};}}\n",
                font.family,
                fallback_css(&theme.fallback_families)
            ));
        }
        Ok(ResolvedTheme {
            theme_revision_id: theme.theme_revision_id,
            name: theme.name,
            css,
            faces,
            warnings,
        })
    }

    pub fn read_web_face(
        &self,
        theme_revision_id: &str,
        font_id: &str,
        font_revision_id: &str,
        sha256: &str,
    ) -> Result<(Vec<u8>, FontFileFormat), HcdError> {
        let theme = self.resolve(theme_revision_id, |_, _, _| "about:blank".to_string())?;
        let face = theme
            .faces
            .iter()
            .find(|face| {
                face.font_id == font_id
                    && face.font_revision_id == font_revision_id
                    && face.sha256 == sha256
                    && face.web_preview
            })
            .ok_or_else(|| {
                HcdError::NotFound(format!(
                    "preview face {sha256} is not in {theme_revision_id}"
                ))
            })?;
        let format = face.format;
        let digest = face.sha256.clone();
        let bytes = self.read_blob(&digest, format)?;
        Ok((bytes, format))
    }

    fn read_blob(&self, sha256: &str, format: FontFileFormat) -> Result<Vec<u8>, HcdError> {
        require_sha256(sha256)?;
        let path = self.blob_path(sha256, format)?;
        let bytes = read_catalog_bytes(&path, MAX_FONT_BYTES, &format!("font blob {sha256}"))?;
        if hash_bytes(&bytes) != sha256 {
            return Err(HcdError::InvalidBundle(format!(
                "font blob {sha256} failed its content check"
            )));
        }
        Ok(bytes)
    }

    fn theme(&self, theme_revision_id: &str) -> Result<ThemeRevision, HcdError> {
        require_sha256(theme_revision_id)?;
        let path = self.theme_path(theme_revision_id)?;
        let theme: ThemeRevision =
            read_catalog_json(&path, &format!("theme revision {theme_revision_id}"))?;
        validate_theme_shape(&theme)?;
        if theme.theme_revision_id != theme_revision_id
            || content_id(&theme, "themeRevisionId")? != theme_revision_id
        {
            return Err(HcdError::InvalidBundle(format!(
                "theme revision {theme_revision_id} does not match its contents"
            )));
        }
        Ok(theme)
    }

    fn font_revision(
        &self,
        font_id: &str,
        font_revision_id: &str,
    ) -> Result<FontRevision, HcdError> {
        require_font_id(font_id)?;
        require_sha256(font_revision_id)?;
        let path = self.font_revision_path(font_id, font_revision_id)?;
        let revision: FontRevision = read_catalog_json(
            &path,
            &format!("font revision {font_id}/{font_revision_id}"),
        )?;
        validate_font_revision(&revision)?;
        if revision.font_id != font_id
            || revision.font_revision_id != font_revision_id
            || content_id(&revision, "fontRevisionId")? != font_revision_id
        {
            return Err(HcdError::InvalidBundle(format!(
                "font revision {font_id}/{font_revision_id} does not match its contents"
            )));
        }
        Ok(revision)
    }

    fn theme_path(&self, theme_revision_id: &str) -> Result<PathBuf, HcdError> {
        require_sha256(theme_revision_id)?;
        Ok(self
            .root
            .join("themes")
            .join(format!("{theme_revision_id}.json")))
    }

    fn font_revision_path(
        &self,
        font_id: &str,
        font_revision_id: &str,
    ) -> Result<PathBuf, HcdError> {
        require_font_id(font_id)?;
        require_sha256(font_revision_id)?;
        Ok(self
            .root
            .join("fonts")
            .join(font_id)
            .join(format!("{font_revision_id}.json")))
    }

    fn blob_path(&self, sha256: &str, format: FontFileFormat) -> Result<PathBuf, HcdError> {
        require_sha256(sha256)?;
        Ok(self
            .root
            .join("blobs")
            .join(format!("{sha256}.{}", format.extension())))
    }
}

pub fn resolve_document_theme(
    catalog: &DiskCatalog,
    bundle: &Bundle,
    revision: Option<u64>,
    file_href: impl Fn(&str, &str, &str) -> String,
) -> Result<DocumentThemeResolution, HcdError> {
    let head = bundle.manifest()?;
    let (manifest, revision) = manifest_at_revision(bundle, &head, revision)?;
    let theme_revision_id = manifest.theme_revision_id.ok_or_else(|| {
        HcdError::NotFound(format!(
            "document {} revision {revision} has no themeRevisionId",
            manifest.document_id
        ))
    })?;
    let theme = catalog.resolve(&theme_revision_id, file_href)?;
    Ok(DocumentThemeResolution {
        document_id: manifest.document_id,
        revision,
        theme_revision_id,
        theme,
    })
}

/// Build a self-contained stylesheet for HTML presentation.
/// Missing pins return `None`. Font bytes are inlined as data URLs, and faces
/// larger than 8 MiB are left out. The result is not stored in the bundle.
pub fn theme_presentation_css(
    catalog: &DiskCatalog,
    bundle: &Bundle,
    revision: Option<u64>,
) -> Result<Option<String>, HcdError> {
    let resolved = match resolve_document_theme(catalog, bundle, revision, |_, _, sha| {
        format!("/v1/embed/{sha}")
    }) {
        Ok(resolved) => resolved,
        Err(HcdError::NotFound(_)) => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut css = String::new();
    let mut seen = BTreeSet::new();
    for face in &resolved.theme.faces {
        if !face.web_preview || !seen.insert((face.sha256.clone(), face.weight, face.style)) {
            continue;
        }
        if face.byte_length == 0 || face.byte_length > MAX_PRESENTATION_FACE_BYTES {
            continue;
        }
        let (bytes, format) = catalog.read_web_face(
            &resolved.theme_revision_id,
            &face.font_id,
            &face.font_revision_id,
            &face.sha256,
        )?;
        if format != face.format || bytes.len() as u64 != face.byte_length {
            return Err(HcdError::InvalidBundle(format!(
                "preview face {} does not match its descriptor",
                face.sha256
            )));
        }
        css.push_str(&format!(
            "@font-face{{font-family:'{}';font-style:{};font-weight:{};font-stretch:{};src:url(\"data:{};base64,{}\") format(\"{}\");}}\n",
            face.family,
            face.style.css(),
            face.weight,
            face.stretch.css(),
            format.media_type(),
            base64_encode(&bytes),
            format.css_format()
        ));
    }
    for line in resolved.theme.css.lines() {
        if line.contains("@font-face") || line.contains("/v1/embed/") {
            continue;
        }
        css.push_str(line);
        css.push('\n');
    }
    css.push_str(
        "body[data-hcd-profile=\"semantic-flow\"]{font-family:var(--hcd-minor-latin,var(--hcd-major-latin))}body[data-hcd-profile=\"semantic-flow\"] :is(h1,h2){font-family:var(--hcd-major-latin,var(--hcd-minor-latin))}\n",
    );
    if css.contains('<') || css.to_ascii_lowercase().contains("@import") {
        return Err(HcdError::InvalidBundle(
            "theme presentation CSS is unsafe".to_string(),
        ));
    }
    Ok(Some(css))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeEmbedKind {
    /// Word and PowerPoint may embed TrueType or OpenType bytes.
    Ooxml,
    /// PDF may embed TrueType or OpenType bytes.
    Pdf,
    /// Excel records the family name and never embeds font bytes.
    Spreadsheet,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThemeFontAction {
    Embed {
        format: FontFileFormat,
        bytes: Vec<u8>,
    },
    /// The family name can still be written into the theme or font table.
    /// `reason` is the export note for this face.
    RegisterOnly { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemeFontDecision {
    pub slots: Vec<String>,
    pub family: String,
    pub subfamily: String,
    pub weight: u16,
    pub style: FontStyle,
    pub action: ThemeFontAction,
}

/// Choose which pinned faces can be embedded.
///
/// A face over 8 MiB is not embedded. A woff2 face is preview-only. When
/// `ooxmlEmbed` or `pdfEmbed` is false, or the license is expired, the bytes
/// stay in the catalog and the family name is registered instead. Workbook
/// export always registers the name and does not embed bytes.
pub fn theme_font_plan(
    catalog: &DiskCatalog,
    bundle: &Bundle,
    revision: Option<u64>,
    kind: ThemeEmbedKind,
) -> Result<Vec<ThemeFontDecision>, HcdError> {
    let resolved = match resolve_document_theme(catalog, bundle, revision, |_, _, _| {
        "about:blank".to_string()
    }) {
        Ok(resolved) => resolved,
        Err(HcdError::NotFound(_)) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut grouped = BTreeMap::new();
    for face in resolved.theme.faces {
        let key = (
            face.font_id.clone(),
            face.font_revision_id.clone(),
            face.sha256.clone(),
            face.weight,
            face.style,
        );
        match grouped.entry(key) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert((vec![face.slot.clone()], face));
            }
            std::collections::btree_map::Entry::Occupied(mut entry) => {
                let slots = &mut entry.get_mut().0;
                if !slots.contains(&face.slot) {
                    slots.push(face.slot.clone());
                }
            }
        }
    }
    let mut decisions = Vec::new();
    for ((font_id, font_revision_id, _, _, _), (slots, face)) in grouped {
        let font = catalog.font_revision(&font_id, &font_revision_id)?;
        let mut action = decide_face(kind, &font, &face);
        if matches!(action, ThemeFontAction::Embed { .. }) {
            let bytes = catalog.read_blob(&face.sha256, face.format)?;
            let format = face.format;
            if bytes.len() as u64 != face.byte_length {
                return Err(HcdError::InvalidBundle(format!(
                    "embed face {} does not match its descriptor",
                    face.sha256
                )));
            }
            action = ThemeFontAction::Embed { format, bytes };
        }
        decisions.push(ThemeFontDecision {
            slots,
            family: face.family,
            subfamily: face.subfamily,
            weight: face.weight,
            style: face.style,
            action,
        });
    }
    Ok(decisions)
}

fn decide_face(kind: ThemeEmbedKind, font: &FontRevision, face: &ResolvedFace) -> ThemeFontAction {
    if kind == ThemeEmbedKind::Spreadsheet {
        let mut reason =
            "xlsx export registers the font name and does not embed font bytes".to_string();
        if license_block_reason(font, ThemeEmbedKind::Ooxml).is_some() {
            reason.push_str(". The license does not allow OOXML embedding either");
        }
        return ThemeFontAction::RegisterOnly { reason };
    }
    if face.byte_length > MAX_PRESENTATION_FACE_BYTES {
        return ThemeFontAction::RegisterOnly {
            reason: format!(
                "{} {} is {} bytes, over the 8 MiB embed limit, so the bytes were not embedded; the family name is still registered",
                face.family, face.subfamily, face.byte_length
            ),
        };
    }
    if let Some(reason) = license_block_reason(font, kind) {
        return ThemeFontAction::RegisterOnly { reason };
    }
    if face.format == FontFileFormat::Woff2 {
        return ThemeFontAction::RegisterOnly {
            reason: format!(
                "{} {} is a woff2 preview face, so its bytes were not embedded in Office or PDF; the family name is still registered",
                face.family, face.subfamily
            ),
        };
    }
    ThemeFontAction::Embed {
        format: face.format,
        bytes: Vec::new(),
    }
}

fn license_block_reason(font: &FontRevision, kind: ThemeEmbedKind) -> Option<String> {
    let expired = font
        .license
        .expires_at_epoch_ms
        .is_some_and(|expires| expires <= now_epoch_ms());
    let allowed = match kind {
        ThemeEmbedKind::Pdf => font.license.pdf_embed,
        ThemeEmbedKind::Ooxml | ThemeEmbedKind::Spreadsheet => font.license.ooxml_embed,
    };
    if expired {
        return Some(format!(
            "{} license expired, so the font bytes were not embedded; the family name is still registered",
            font.family
        ));
    }
    if !allowed {
        let flag = match kind {
            ThemeEmbedKind::Pdf => "pdfEmbed",
            ThemeEmbedKind::Ooxml | ThemeEmbedKind::Spreadsheet => "ooxmlEmbed",
        };
        return Some(format!(
            "{} license {flag} is false, so the font bytes were not embedded; the family name is still registered",
            font.family
        ));
    }
    None
}

/// Record `themeRevisionId` on the current head and its revision record.
/// Older revision records are left unchanged.
pub fn pin_document_theme(
    bundle: &Bundle,
    theme_revision_id: &str,
) -> Result<crate::HcdManifest, HcdError> {
    require_sha256(theme_revision_id)?;
    let _guard = bundle.acquire_write_lock()?;
    let mut manifest = bundle.manifest()?;
    if manifest.state != "COMPLETE" {
        return Err(HcdError::InvalidBundle(
            "only a complete document can pin a theme".to_string(),
        ));
    }
    let mut record = bundle.revision(manifest.revision)?;
    if record.document_id != manifest.document_id || record.revision != manifest.revision {
        return Err(HcdError::InvalidBundle(
            "head revision record does not match the manifest".to_string(),
        ));
    }
    manifest.theme_revision_id = Some(theme_revision_id.to_string());
    record.theme_revision_id = Some(theme_revision_id.to_string());
    bundle.write_revision(&record)?;
    bundle.write_manifest(&manifest)?;
    Ok(manifest)
}

fn read_catalog_json<T: for<'de> Deserialize<'de>>(path: &Path, kind: &str) -> Result<T, HcdError> {
    match read_json_bounded(path, MAX_CATALOG_JSON_BYTES, kind) {
        Ok(value) => Ok(value),
        Err(HcdError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(HcdError::NotFound(kind.to_string()))
        }
        Err(HcdError::Json(error)) => Err(HcdError::InvalidBundle(format!(
            "{kind} is invalid: {error}"
        ))),
        Err(error) => Err(error),
    }
}

fn read_catalog_bytes(path: &Path, maximum_bytes: u64, kind: &str) -> Result<Vec<u8>, HcdError> {
    match read_bytes_bounded(path, maximum_bytes, kind) {
        Ok(bytes) => Ok(bytes),
        Err(HcdError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(HcdError::NotFound(kind.to_string()))
        }
        Err(error) => Err(error),
    }
}

fn write_immutable_json<T>(path: &Path, value: &T) -> Result<(), HcdError>
where
    T: Serialize + for<'de> Deserialize<'de> + PartialEq,
{
    let bytes = serde_json::to_vec(value)?;
    if path.exists() {
        let existing: T = read_catalog_json(path, "catalog object")?;
        if existing != *value {
            return Err(HcdError::InvalidBundle(format!(
                "catalog object {} is immutable",
                path.display()
            )));
        }
        return Ok(());
    }
    atomic_write(path, &bytes)
}

fn content_id<T: Serialize>(value: &T, id_field: &str) -> Result<String, HcdError> {
    let mut json = serde_json::to_value(value)?;
    json.as_object_mut()
        .ok_or_else(|| HcdError::InvalidBundle("catalog object must be a JSON object".to_string()))?
        .remove(id_field);
    Ok(hash_bytes(&serde_json::to_vec(&json)?))
}

fn validate_font_revision(revision: &FontRevision) -> Result<(), HcdError> {
    if revision.schema_version != FONT_CATALOG_SCHEMA {
        return Err(HcdError::InvalidBundle(format!(
            "unsupported font catalog schema {}",
            revision.schema_version
        )));
    }
    require_font_id(&revision.font_id)?;
    require_label(&revision.family, "font family")?;
    if revision.faces.is_empty() || revision.faces.len() > MAX_FACES {
        return Err(HcdError::InvalidBundle(format!(
            "a font revision must contain 1 to {MAX_FACES} faces"
        )));
    }
    validate_license(&revision.license)?;
    let mut seen = BTreeSet::new();
    for face in &revision.faces {
        if face.family != revision.family {
            return Err(HcdError::InvalidBundle(
                "face family must match the font revision family".to_string(),
            ));
        }
        require_label(&face.subfamily, "font subfamily")?;
        if face.weight == 0 || face.weight > 1000 {
            return Err(HcdError::InvalidBundle(
                "font weight must be from 1 to 1000".to_string(),
            ));
        }
        if face.scripts.is_empty() || face.scripts.len() > 8 {
            return Err(HcdError::InvalidBundle(
                "a font face must name 1 to 8 scripts".to_string(),
            ));
        }
        let mut scripts = face.scripts.clone();
        scripts.sort();
        scripts.dedup();
        if scripts.len() != face.scripts.len() {
            return Err(HcdError::InvalidBundle(
                "font face scripts must be unique".to_string(),
            ));
        }
        require_sha256(&face.sha256)?;
        if face.byte_length == 0 || face.byte_length > MAX_FONT_BYTES {
            return Err(HcdError::InvalidBundle(
                "font face byte length is outside the catalog limit".to_string(),
            ));
        }
        if !seen.insert((face.weight, face.style, face.stretch, face.sha256.clone())) {
            return Err(HcdError::InvalidBundle(
                "font revision repeats a face".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_theme_shape(theme: &ThemeRevision) -> Result<(), HcdError> {
    if theme.schema_version != THEME_SCHEMA {
        return Err(HcdError::InvalidBundle(format!(
            "unsupported theme schema {}",
            theme.schema_version
        )));
    }
    require_label(&theme.name, "theme name")?;
    if theme.fallback_families.len() > 4 {
        return Err(HcdError::InvalidBundle(
            "a theme can name at most 4 fallback families".to_string(),
        ));
    }
    let mut seen = BTreeSet::new();
    for family in &theme.fallback_families {
        if !matches!(
            family.as_str(),
            "serif" | "sans-serif" | "monospace" | "cursive" | "fantasy" | "system-ui"
        ) || !seen.insert(family.as_str())
        {
            return Err(HcdError::InvalidBundle(format!(
                "unsupported theme fallback family {family}"
            )));
        }
    }
    let refs = theme_refs(theme);
    if refs.is_empty() {
        return Err(HcdError::InvalidBundle(
            "a theme must reference at least one font revision".to_string(),
        ));
    }
    for font_ref in refs {
        require_font_id(&font_ref.font_id)?;
        require_sha256(&font_ref.font_revision_id)?;
    }
    Ok(())
}

fn validate_license(license: &FontLicense) -> Result<(), HcdError> {
    require_label(&license.name, "license name")?;
    Ok(())
}

fn theme_refs(theme: &ThemeRevision) -> Vec<&FontRef> {
    theme_slots(theme)
        .into_iter()
        .map(|(_, font_ref)| font_ref)
        .collect()
}

fn theme_slots(theme: &ThemeRevision) -> Vec<(&'static str, &FontRef)> {
    let mut slots = Vec::new();
    let groups = [
        ("major-latin", &theme.major.latin),
        ("major-east-asia", &theme.major.east_asia),
        ("major-bidi", &theme.major.bidi),
        ("minor-latin", &theme.minor.latin),
        ("minor-east-asia", &theme.minor.east_asia),
        ("minor-bidi", &theme.minor.bidi),
    ];
    for (name, slot) in groups {
        if let Some(font_ref) = slot {
            slots.push((name, font_ref));
        }
    }
    slots
}

fn fallback_css(families: &[String]) -> String {
    let mut css = String::new();
    for family in families {
        css.push(',');
        css.push_str(family);
    }
    css
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut index = 0;
    while index + 3 <= bytes.len() {
        let chunk = ((bytes[index] as u32) << 16)
            | ((bytes[index + 1] as u32) << 8)
            | bytes[index + 2] as u32;
        encoded.push(TABLE[((chunk >> 18) & 63) as usize] as char);
        encoded.push(TABLE[((chunk >> 12) & 63) as usize] as char);
        encoded.push(TABLE[((chunk >> 6) & 63) as usize] as char);
        encoded.push(TABLE[(chunk & 63) as usize] as char);
        index += 3;
    }
    match bytes.len() - index {
        1 => {
            let chunk = (bytes[index] as u32) << 16;
            encoded.push(TABLE[((chunk >> 18) & 63) as usize] as char);
            encoded.push(TABLE[((chunk >> 12) & 63) as usize] as char);
            encoded.push('=');
            encoded.push('=');
        }
        2 => {
            let chunk = ((bytes[index] as u32) << 16) | ((bytes[index + 1] as u32) << 8);
            encoded.push(TABLE[((chunk >> 18) & 63) as usize] as char);
            encoded.push(TABLE[((chunk >> 12) & 63) as usize] as char);
            encoded.push(TABLE[((chunk >> 6) & 63) as usize] as char);
            encoded.push('=');
        }
        _ => {}
    }
    encoded
}

fn href_is_unsafe(href: &str) -> bool {
    href.is_empty()
        || href.chars().any(|character| {
            character.is_whitespace()
                || matches!(character, '"' | '\'' | '(' | ')' | '\\' | '<' | '>')
        })
}

fn require_sha256(value: &str) -> Result<(), HcdError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(HcdError::InvalidBundle(
            "catalog revision id must be a lowercase SHA-256 digest".to_string(),
        ))
    }
}

fn require_font_id(value: &str) -> Result<(), HcdError> {
    let bytes = value.as_bytes();
    if (1..=64).contains(&bytes.len())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
    {
        Ok(())
    } else {
        Err(HcdError::InvalidBundle(
            "fontId must be 1-64 lowercase letters, digits, or hyphens".to_string(),
        ))
    }
}

fn require_label(value: &str, kind: &str) -> Result<(), HcdError> {
    let count = value.chars().count();
    if (1..=128).contains(&count)
        && value.chars().all(|character| {
            !character.is_control()
                && !matches!(character, '\'' | '"' | '\\' | '<' | '>' | '{' | '}')
        })
    {
        Ok(())
    } else {
        Err(HcdError::InvalidBundle(format!(
            "{kind} must be 1-128 characters without quotes or controls"
        )))
    }
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Bundle, BundleWriter, HcdCapabilities, HcdManifest, SourceDescriptor, StorageCodec,
    };

    fn sample_font(sha256: &str, byte_length: u64) -> FontRevision {
        FontRevision {
            schema_version: FONT_CATALOG_SCHEMA.to_string(),
            font_id: "source-han-sans".to_string(),
            font_revision_id: String::new(),
            family: "Source Han Sans".to_string(),
            faces: vec![
                FontFace {
                    family: "Source Han Sans".to_string(),
                    subfamily: "Regular".to_string(),
                    weight: 400,
                    style: FontStyle::Normal,
                    stretch: FontStretch::Normal,
                    scripts: vec![FontScript::Latin, FontScript::EastAsia, FontScript::Hans],
                    format: FontFileFormat::Woff2,
                    sha256: sha256.to_string(),
                    byte_length,
                },
                FontFace {
                    family: "Source Han Sans".to_string(),
                    subfamily: "Bold".to_string(),
                    weight: 700,
                    style: FontStyle::Normal,
                    stretch: FontStretch::Normal,
                    scripts: vec![FontScript::Latin],
                    format: FontFileFormat::Otf,
                    sha256: sha256.to_string(),
                    byte_length,
                },
            ],
            license: FontLicense {
                name: "OFL-1.1".to_string(),
                web_preview: true,
                ooxml_embed: true,
                pdf_embed: true,
                redistribution: false,
                expires_at_epoch_ms: None,
            },
        }
    }

    fn install() -> (tempfile::TempDir, DiskCatalog, String, String) {
        let temp = tempfile::tempdir().unwrap();
        let catalog = DiskCatalog::open(temp.path()).unwrap();
        let bytes = b"fake-woff2";
        let sha256 = catalog
            .put_font_bytes(bytes, FontFileFormat::Woff2)
            .unwrap();
        catalog.put_font_bytes(bytes, FontFileFormat::Otf).unwrap();
        let mut font = sample_font(&sha256, bytes.len() as u64);
        font.faces[1].sha256 = catalog
            .put_font_bytes(b"fake-otf-bold", FontFileFormat::Otf)
            .unwrap();
        font.faces[1].byte_length = b"fake-otf-bold".len() as u64;
        catalog.put_font_revision(&font).unwrap();
        let stored = catalog
            .font_revision(&font.font_id, &content_id(&font, "fontRevisionId").unwrap())
            .unwrap();
        let theme = ThemeRevision {
            schema_version: THEME_SCHEMA.to_string(),
            theme_revision_id: String::new(),
            name: "Office default".to_string(),
            major: ThemeFontSlots {
                latin: Some(FontRef {
                    font_id: stored.font_id.clone(),
                    font_revision_id: stored.font_revision_id.clone(),
                }),
                east_asia: Some(FontRef {
                    font_id: stored.font_id.clone(),
                    font_revision_id: stored.font_revision_id.clone(),
                }),
                bidi: None,
            },
            minor: ThemeFontSlots {
                latin: None,
                east_asia: None,
                bidi: None,
            },
            fallback_families: vec!["sans-serif".to_string()],
        };
        let theme_id = catalog.put_theme(&theme).unwrap();
        (temp, catalog, stored.font_revision_id, theme_id)
    }

    #[test]
    fn resolve_pins_font_files_and_css_variables() {
        let (_temp, catalog, font_revision_id, theme_id) = install();
        let resolved = catalog
            .resolve(&theme_id, |font_id, revision, sha| {
                format!("/v1/themes/{theme_id}/files/{font_id}/{revision}/{sha}")
            })
            .unwrap();
        assert_eq!(resolved.theme_revision_id, theme_id);
        assert!(resolved
            .css
            .contains("--hcd-major-latin:'Source Han Sans',sans-serif"));
        assert!(resolved
            .css
            .contains("--hcd-major-east-asia:'Source Han Sans',sans-serif"));
        assert!(resolved.css.contains("font-weight:400"));
        assert!(resolved.css.contains(&format!(
            "/v1/themes/{theme_id}/files/source-han-sans/{font_revision_id}/"
        )));
        assert!(!resolved.css.contains("--hcd-major-bidi"));
        assert_eq!(resolved.faces.len(), 4);
        let (bytes, format) = catalog
            .read_web_face(
                &theme_id,
                "source-han-sans",
                &font_revision_id,
                &resolved.faces[0].sha256,
            )
            .unwrap();
        assert_eq!(bytes, b"fake-woff2");
        assert_eq!(format, FontFileFormat::Woff2);
        assert!(catalog
            .put_theme(&ThemeRevision {
                schema_version: THEME_SCHEMA.to_string(),
                theme_revision_id: theme_id.clone(),
                name: "Office default".to_string(),
                major: ThemeFontSlots {
                    latin: Some(FontRef {
                        font_id: "source-han-sans".to_string(),
                        font_revision_id: font_revision_id.clone(),
                    }),
                    east_asia: Some(FontRef {
                        font_id: "source-han-sans".to_string(),
                        font_revision_id,
                    }),
                    bidi: None,
                },
                minor: ThemeFontSlots {
                    latin: None,
                    east_asia: None,
                    bidi: None,
                },
                fallback_families: vec!["sans-serif".to_string()],
            })
            .is_ok());
    }

    #[test]
    fn expired_license_drops_preview_and_rejects_a_changed_theme() {
        let (temp, catalog, font_revision_id, theme_id) = install();
        let mut font = catalog
            .font_revision("source-han-sans", &font_revision_id)
            .unwrap();
        font.license.expires_at_epoch_ms = Some(1);
        font.font_id = "source-han-sans-expired".to_string();
        catalog.put_font_revision(&font).unwrap();
        let expired_font = content_id(
            &FontRevision {
                font_revision_id: String::new(),
                ..font
            },
            "fontRevisionId",
        )
        .unwrap();
        let theme_id_expired = catalog
            .put_theme(&ThemeRevision {
                schema_version: THEME_SCHEMA.to_string(),
                theme_revision_id: String::new(),
                name: "Expired".to_string(),
                major: ThemeFontSlots {
                    latin: Some(FontRef {
                        font_id: "source-han-sans-expired".to_string(),
                        font_revision_id: expired_font,
                    }),
                    east_asia: None,
                    bidi: None,
                },
                minor: ThemeFontSlots {
                    latin: None,
                    east_asia: None,
                    bidi: None,
                },
                fallback_families: vec![],
            })
            .unwrap();
        let resolved = catalog
            .resolve(&theme_id_expired, |_, _, sha| format!("/fonts/{sha}"))
            .unwrap();
        assert!(resolved
            .faces
            .iter()
            .all(|face| !face.web_preview && !face.pdf_embed));
        assert!(resolved.css.is_empty() || !resolved.css.contains("@font-face"));
        assert!(!resolved.warnings.is_empty());
        let path = temp.path().join("themes").join(format!("{theme_id}.json"));
        fs::write(&path, b"{\"tampered\":true}").unwrap();
        let error = catalog
            .resolve(&theme_id, |_, _, _| "/font".to_string())
            .unwrap_err();
        assert!(matches!(error, HcdError::InvalidBundle(_)));
    }

    #[test]
    fn presentation_css_inlines_the_pinned_theme() {
        let (_temp, catalog, _font_revision_id, theme_id) = install();
        let bundle_dir = tempfile::tempdir().unwrap();
        let root = bundle_dir.path().join("demo.hcd");
        let writer = BundleWriter::create(&root).unwrap();
        writer.write_styles("").unwrap();
        writer
            .finish(HcdManifest {
                schema_version: String::new(),
                storage_codec: StorageCodec::None,
                document_id: "demo".to_string(),
                profile: "semantic-flow".to_string(),
                revision: 0,
                source: SourceDescriptor {
                    format: "docx".to_string(),
                    sha256: "ab".repeat(32),
                    size_bytes: 1,
                },
                root_hash: String::new(),
                annotation_root_hash: String::new(),
                annotation_href: None,
                index_prefix: String::new(),
                index_root_href: None,
                index_page_count: 0,
                chunk_count: 0,
                styles_href: String::new(),
                theme_revision_id: None,
                capabilities: HcdCapabilities::default(),
                fidelity: None,
                state: "IMPORTING".to_string(),
                warnings: Vec::new(),
            })
            .unwrap();
        let bundle = Bundle::open(&root).unwrap();
        assert!(theme_presentation_css(&catalog, &bundle, None)
            .unwrap()
            .is_none());
        pin_document_theme(&bundle, &theme_id).unwrap();
        let css = theme_presentation_css(&catalog, &bundle, None)
            .unwrap()
            .unwrap();
        assert!(css.contains("data:font/woff2;base64,"));
        assert!(css.contains("data:font/otf;base64,"));
        assert!(css.contains("--hcd-major-latin:'Source Han Sans',sans-serif"));
        assert!(css.contains("body[data-hcd-profile=\"semantic-flow\"]"));
        assert!(!css.contains("/v1/embed/"));
        assert!(!css.contains('<'));
    }

    fn face_of(font: &FontRevision, index: usize) -> ResolvedFace {
        let face = &font.faces[index];
        ResolvedFace {
            slot: "major-latin".to_string(),
            font_id: font.font_id.clone(),
            font_revision_id: "ab".repeat(32),
            family: font.family.clone(),
            subfamily: face.subfamily.clone(),
            weight: face.weight,
            style: face.style,
            stretch: face.stretch,
            scripts: face.scripts.clone(),
            format: face.format,
            sha256: face.sha256.clone(),
            byte_length: face.byte_length,
            href: String::new(),
            web_preview: true,
            ooxml_embed: font.license.ooxml_embed,
            pdf_embed: font.license.pdf_embed,
        }
    }

    #[test]
    fn embed_plan_skips_oversize_and_records_license_limits() {
        let mut font = sample_font(&"ab".repeat(32), 8 * 1024 * 1024 + 1);
        let oversize = decide_face(ThemeEmbedKind::Ooxml, &font, &face_of(&font, 0));
        assert!(
            matches!(oversize, ThemeFontAction::RegisterOnly { ref reason } if reason.contains("8 MiB") && reason.contains("still registered"))
        );
        font.faces[0].byte_length = 12;
        font.license.ooxml_embed = false;
        let denied = decide_face(ThemeEmbedKind::Ooxml, &font, &face_of(&font, 0));
        assert!(
            matches!(denied, ThemeFontAction::RegisterOnly { ref reason } if reason.contains("ooxmlEmbed is false"))
        );
        font.license.ooxml_embed = true;
        font.license.pdf_embed = false;
        let pdf_denied = decide_face(ThemeEmbedKind::Pdf, &font, &face_of(&font, 0));
        assert!(
            matches!(pdf_denied, ThemeFontAction::RegisterOnly { ref reason } if reason.contains("pdfEmbed is false"))
        );
        font.license.pdf_embed = true;
        font.license.expires_at_epoch_ms = Some(1);
        let expired = decide_face(ThemeEmbedKind::Pdf, &font, &face_of(&font, 0));
        assert!(
            matches!(expired, ThemeFontAction::RegisterOnly { ref reason } if reason.contains("license expired"))
        );
        font.license.expires_at_epoch_ms = None;
        font.license.ooxml_embed = false;
        let workbook = decide_face(ThemeEmbedKind::Spreadsheet, &font, &face_of(&font, 0));
        assert!(
            matches!(workbook, ThemeFontAction::RegisterOnly { ref reason } if reason.contains("does not embed font bytes") && reason.contains("does not allow OOXML"))
        );
    }

    #[test]
    fn theme_font_plan_embeds_otf_and_registers_woff2() {
        let (_temp, catalog, _font_revision_id, theme_id) = install();
        let bundle_dir = tempfile::tempdir().unwrap();
        let root = bundle_dir.path().join("demo.hcd");
        let writer = BundleWriter::create(&root).unwrap();
        writer.write_styles("").unwrap();
        writer
            .finish(HcdManifest {
                schema_version: String::new(),
                storage_codec: StorageCodec::None,
                document_id: "demo".to_string(),
                profile: "semantic-flow".to_string(),
                revision: 0,
                source: SourceDescriptor {
                    format: "docx".to_string(),
                    sha256: "ab".repeat(32),
                    size_bytes: 1,
                },
                root_hash: String::new(),
                annotation_root_hash: String::new(),
                annotation_href: None,
                index_prefix: String::new(),
                index_root_href: None,
                index_page_count: 0,
                chunk_count: 0,
                styles_href: String::new(),
                theme_revision_id: None,
                capabilities: HcdCapabilities::default(),
                fidelity: None,
                state: "IMPORTING".to_string(),
                warnings: Vec::new(),
            })
            .unwrap();
        let bundle = Bundle::open(&root).unwrap();
        assert!(
            theme_font_plan(&catalog, &bundle, None, ThemeEmbedKind::Ooxml)
                .unwrap()
                .is_empty()
        );
        pin_document_theme(&bundle, &theme_id).unwrap();
        let plan = theme_font_plan(&catalog, &bundle, None, ThemeEmbedKind::Ooxml).unwrap();
        assert!(plan.iter().any(|decision| {
            matches!(&decision.action, ThemeFontAction::Embed { bytes, .. } if bytes == b"fake-otf-bold")
        }));
        assert!(plan.iter().any(|decision| {
            matches!(&decision.action, ThemeFontAction::RegisterOnly { reason } if reason.contains("woff2"))
        }));
        let workbook =
            theme_font_plan(&catalog, &bundle, None, ThemeEmbedKind::Spreadsheet).unwrap();
        assert!(workbook
            .iter()
            .all(|decision| matches!(decision.action, ThemeFontAction::RegisterOnly { .. })));
    }

    #[test]
    fn document_pin_stays_on_its_revision_when_the_head_changes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("demo.hcd");
        let writer = BundleWriter::create(&root).unwrap();
        writer.write_styles("").unwrap();
        writer
            .finish(HcdManifest {
                schema_version: String::new(),
                storage_codec: StorageCodec::None,
                document_id: "demo".to_string(),
                profile: "semantic-flow".to_string(),
                revision: 0,
                source: SourceDescriptor {
                    format: "docx".to_string(),
                    sha256: "ab".repeat(32),
                    size_bytes: 1,
                },
                root_hash: String::new(),
                annotation_root_hash: String::new(),
                annotation_href: None,
                index_prefix: String::new(),
                index_root_href: None,
                index_page_count: 0,
                chunk_count: 0,
                styles_href: String::new(),
                theme_revision_id: None,
                capabilities: HcdCapabilities::default(),
                fidelity: None,
                state: "IMPORTING".to_string(),
                warnings: Vec::new(),
            })
            .unwrap();
        let bundle = Bundle::open(&root).unwrap();
        let pinned = "cd".repeat(32);
        pin_document_theme(&bundle, &pinned).unwrap();
        assert_eq!(
            bundle.manifest().unwrap().theme_revision_id.as_deref(),
            Some(pinned.as_str())
        );
        assert_eq!(
            bundle.revision(0).unwrap().theme_revision_id.as_deref(),
            Some(pinned.as_str())
        );
        let mut head = bundle.manifest().unwrap();
        head.revision = 1;
        head.theme_revision_id = Some("ef".repeat(32));
        let (historical, _) = manifest_at_revision(&bundle, &head, Some(0)).unwrap();
        assert_eq!(
            historical.theme_revision_id.as_deref(),
            Some(pinned.as_str())
        );
        let (current, _) = manifest_at_revision(&bundle, &head, None).unwrap();
        assert_eq!(
            current.theme_revision_id.as_deref(),
            Some("ef".repeat(32).as_str())
        );
    }
}
