//! Same-machine font catalog. Documents store only a `themeRevisionId`.
//! The catalog directory holds immutable font revisions, theme revisions, and
//! content-addressed font blobs. There is no tenant field in this schema.

use crate::bundle::{
    atomic_write, finalize_root_hash, hash_descriptor, read_bytes_bounded, read_json_bounded,
};
use crate::{hash_bytes, manifest_at_revision, Bundle, HcdError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FONT_CATALOG_SCHEMA: &str = "hcd-font-catalog/1";
pub const THEME_SCHEMA: &str = "hcd-theme/1";
pub const MAX_FONT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_CATALOG_JSON_BYTES: u64 = 1024 * 1024;
const MAX_FACES: usize = 32;
const MAX_PRESENTATION_FACE_BYTES: u64 = 8 * 1024 * 1024;

/// Bounds for one audit line. A day file is read from its end, so a log that
/// grows past `MAX_AUDIT_FILE_BYTES` still answers with its newest entries
/// instead of failing the read; only the oldest fragment of that day is out of
/// reach, and the page counts it as unreadable rather than hiding it.
const MAX_AUDIT_ACTION_CHARS: usize = 48;
const MAX_AUDIT_TARGET_CHARS: usize = 160;
const MAX_AUDIT_ACTOR_CHARS: usize = 128;
const MAX_AUDIT_DETAIL_CHARS: usize = 512;
const MAX_AUDIT_FILE_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_AUDIT_LIMIT: usize = 500;

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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
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

/// What a catalog delete removed: the font revision ids dropped, and the blobs
/// that lost their last reference and were garbage-collected.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FontDeleteReport {
    pub removed_revisions: Vec<String>,
    pub removed_blobs: Vec<String>,
}

/// One document that reaches a theme revision, and where the pin lives.
///
/// A pin is a content revision, so it is recorded both on the head manifest and
/// on the revision record written when it took effect. History matters: an old
/// revision still resolves its theme's fonts, so a theme is only unreachable
/// when *neither* place cites it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDocumentRef {
    pub document_id: String,
    /// True when the current head pins the theme.
    pub head_pinned: bool,
    /// Revision records carrying the pin, oldest first.
    pub pinned_revisions: Vec<u64>,
}

impl ThemeDocumentRef {
    /// Whether this document cites the theme anywhere.
    pub fn pinned(&self) -> bool {
        self.head_pinned || !self.pinned_revisions.is_empty()
    }
}

/// Names the catalog audit log records. The log stores the string, so a new
/// action can be added without a schema change; these constants exist so the
/// HTTP layer and the admin console agree on the wording.
pub mod audit_action {
    pub const FONT_BYTES_PUT: &str = "font.bytes.put";
    pub const FONT_REVISION_PUT: &str = "font.revision.put";
    pub const FONT_DELETE: &str = "font.delete";
    pub const FONT_REVISION_DELETE: &str = "font.revision.delete";
    pub const THEME_PUT: &str = "theme.put";
    pub const THEME_RETIRE: &str = "theme.retire";
    pub const THEME_UNRETIRE: &str = "theme.unretire";
    pub const THEME_DELETE: &str = "theme.delete";
    pub const DOCUMENT_THEME_PIN: &str = "document.theme.pin";
    pub const DOCUMENT_THEME_UNPIN: &str = "document.theme.unpin";
}

/// One operation to append to the audit log, before its timestamp is taken.
///
/// Fields are named rather than positional because a record that swaps `target`
/// for `actor` says something false about who did what, and nothing downstream
/// would notice.
#[derive(Debug, Clone, Default)]
pub struct AuditRecord<'a> {
    pub action: &'a str,
    pub target: &'a str,
    pub actor: &'a str,
    /// Short free text: what changed, how many, or why it was refused-safe.
    pub detail: &'a str,
}

/// One appended line of the audit log.
///
/// This is the only place an operator's identity survives: a font revision, a
/// theme revision and a document pin each record their contents, never who wrote
/// them. Unknown JSON fields are accepted on read, so a later build can add a
/// field without older readers losing the line.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    /// Wall-clock milliseconds since the Unix epoch, when the write took effect.
    pub at: u64,
    /// One of [`audit_action`], as stored.
    pub action: String,
    /// What the operation addressed: `fontId/rev`, a `themeRevisionId`, a
    /// `documentId`.
    pub target: String,
    /// Who asked for it, taken from the caller's token claims.
    pub actor: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub detail: String,
}

/// An inclusive UTC-day window for reading the audit log.
///
/// Both ends are optional; `from` alone means "since that day", `to` alone means
/// "up to and including that day". The strings are compared as day names, which
/// is chronological because [`utc_day_name`] always writes zero-padded
/// `YYYY-MM-DD`, so a bound is checked for being a real calendar day rather than
/// normalized first.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AuditWindow<'a> {
    pub from: Option<&'a str>,
    pub to: Option<&'a str>,
}

/// A page read back from the audit log.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuditPage {
    /// Newest first.
    pub entries: Vec<AuditEntry>,
    /// Log lines that could not be read as records: a torn final line after a
    /// crash, or the fragment cut off by the tail read of a very large day.
    /// Reported so a short list is never mistaken for the whole trail.
    pub unreadable: usize,
    /// The page stopped at its limit with unread lines left inside the window,
    /// so older operations exist that are not listed here. Distinct from
    /// [`AuditPage::unreadable`]: those lines could not be read, these were not
    /// read.
    pub truncated: bool,
}

/// Scan `{docs_root}/*.hcd` for documents pinning `theme_revision_id`, on the
/// head or anywhere in revision history. Documents are named by their bundle
/// stem, which is the `documentId` the HTTP layer uses.
///
/// The scan is the reference check that makes theme deletion safe. It is honest
/// about its own scope: it can only see bundles under this document root, so a
/// copy of the document elsewhere is out of reach. An unreadable bundle is an
/// error rather than a skip, because "no references" must never rest on a
/// document we failed to read.
pub fn theme_documents(
    docs_root: &Path,
    theme_revision_id: &str,
) -> Result<Vec<ThemeDocumentRef>, HcdError> {
    require_sha256(theme_revision_id)?;
    let entries = match fs::read_dir(docs_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(HcdError::Io(error)),
    };
    let mut documents = Vec::new();
    for entry in entries {
        let path = entry?.path();
        let document_id = match bundle_document_id(&path) {
            Some(document_id) => document_id,
            None => continue,
        };
        let bundle = Bundle::open(&path)
            .map_err(|error| note_unreadable(&document_id, "manifest", error))?;
        let manifest = bundle
            .manifest()
            .map_err(|error| note_unreadable(&document_id, "manifest", error))?;
        let mut references = ThemeDocumentRef {
            document_id: document_id.clone(),
            head_pinned: manifest.theme_revision_id.as_deref() == Some(theme_revision_id),
            pinned_revisions: Vec::new(),
        };
        if manifest.revision > crate::MAX_REVISION {
            return Err(HcdError::InvalidBundle(format!(
                "document {document_id} claims revision {}, above the maximum {}",
                manifest.revision,
                crate::MAX_REVISION
            )));
        }
        for revision in 0..=manifest.revision {
            let record = bundle
                .revision(revision)
                .map_err(|error| note_unreadable(&document_id, "revision record", error))?;
            if record.theme_revision_id.as_deref() == Some(theme_revision_id) {
                references.pinned_revisions.push(revision);
            }
        }
        if references.pinned() {
            documents.push(references);
        }
    }
    documents.sort_by(|left, right| left.document_id.cmp(&right.document_id));
    Ok(documents)
}

/// One document in a document root: what it is, and which theme its head pins.
///
/// This is the content side of the catalog: the admin console lists these to
/// check what a theme change actually reached. It reads the head manifest only,
/// so a theme that survives just in history shows up here as unpinned; the
/// reference check for deletion is [`theme_documents`], which walks history.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    pub document_id: String,
    pub profile: String,
    pub format: String,
    pub revision: u64,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme_revision_id: Option<String>,
}

/// Summarize every `{docs_root}/*.hcd` bundle, ordered by `documentId`.
///
/// A missing root simply means no documents yet. Non-bundle entries in the root
/// (the catalog directory, `jobs/`, `sources/`, locks) are skipped, but an
/// unreadable bundle fails the scan: a management list must not quietly drop a
/// document nobody could read.
pub fn list_documents(docs_root: &Path) -> Result<Vec<DocumentSummary>, HcdError> {
    let entries = match fs::read_dir(docs_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(HcdError::Io(error)),
    };
    let mut documents = Vec::new();
    for entry in entries {
        let path = entry?.path();
        let document_id = match bundle_document_id(&path) {
            Some(document_id) => document_id,
            None => continue,
        };
        let bundle = Bundle::open(&path)
            .map_err(|error| note_unreadable(&document_id, "manifest", error))?;
        let manifest = bundle
            .manifest()
            .map_err(|error| note_unreadable(&document_id, "manifest", error))?;
        documents.push(DocumentSummary {
            document_id,
            profile: manifest.profile,
            format: manifest.source.format,
            revision: manifest.revision,
            state: manifest.state,
            theme_revision_id: manifest.theme_revision_id,
        });
    }
    documents.sort_by(|left, right| left.document_id.cmp(&right.document_id));
    Ok(documents)
}

/// The `documentId` for a `{docs_root}/{id}.hcd` bundle directory, `None` for
/// anything else in the root (the catalog directory, scratch files, locks).
fn bundle_document_id(path: &Path) -> Option<String> {
    if !path.is_dir() {
        return None;
    }
    if path.extension().and_then(|value| value.to_str()) != Some("hcd") {
        return None;
    }
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(str::to_string)
}

fn note_unreadable(document_id: &str, what: &str, error: HcdError) -> HcdError {
    HcdError::InvalidBundle(format!(
        "document {document_id} could not be scanned ({what}): {error}"
    ))
}

/// Document ids to quote in a deletion refusal, capped so one message stays
/// readable. The reachability view carries the full list.
fn named_documents(references: &[ThemeDocumentRef]) -> String {
    const MAX_NAMED: usize = 10;
    let mut names: Vec<String> = references
        .iter()
        .map(|reference| reference.document_id.clone())
        .collect();
    let overflow = names.len().saturating_sub(MAX_NAMED);
    names.truncate(MAX_NAMED);
    if overflow > 0 {
        names.push(format!("(+{overflow} more)"));
    }
    names.join(", ")
}

impl DiskCatalog {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, HcdError> {
        let root = root.as_ref();
        fs::create_dir_all(root.join("themes"))?;
        fs::create_dir_all(root.join("fonts"))?;
        fs::create_dir_all(root.join("blobs"))?;
        fs::create_dir_all(root.join("audit"))?;
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

    /// Store one immutable font revision and return it with its computed
    /// `fontRevisionId`. Writing the same revision again succeeds.
    pub fn put_font_revision(&self, revision: &FontRevision) -> Result<FontRevision, HcdError> {
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
        write_immutable_json(&path, &revision)?;
        Ok(revision)
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

    /// Every font ID stored in the catalog, sorted. Directories with invalid
    /// names cannot be addressed and are skipped.
    pub fn list_font_ids(&self) -> Result<Vec<String>, HcdError> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(self.root.join("fonts"))? {
            let entry = entry?;
            if !entry.path().is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if require_font_id(&name).is_ok() {
                ids.push(name);
            }
        }
        ids.sort();
        Ok(ids)
    }

    /// Every stored revision of one font, each verified against its contents.
    /// A revision whose file no longer matches returns an error instead of an
    /// incomplete listing.
    pub fn font_revisions(&self, font_id: &str) -> Result<Vec<FontRevision>, HcdError> {
        require_font_id(font_id)?;
        let mut revisions = Vec::new();
        let entries = fs::read_dir(self.root.join("fonts").join(font_id)).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                HcdError::NotFound(format!("font {font_id} has no revisions"))
            } else {
                HcdError::Io(error)
            }
        })?;
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let stem = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string();
            revisions.push(self.font_revision(font_id, &stem)?);
        }
        revisions.sort_by(|left, right| left.font_revision_id.cmp(&right.font_revision_id));
        Ok(revisions)
    }

    /// Read one stored theme revision.
    pub fn get_theme(&self, theme_revision_id: &str) -> Result<ThemeRevision, HcdError> {
        self.theme(theme_revision_id)
    }

    /// Every stored theme revision, each verified against its contents.
    pub fn list_themes(&self) -> Result<Vec<ThemeRevision>, HcdError> {
        let mut themes = Vec::new();
        for entry in fs::read_dir(self.root.join("themes"))? {
            let path = entry?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let stem = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string();
            themes.push(self.theme(&stem)?);
        }
        themes.sort_by(|left, right| left.theme_revision_id.cmp(&right.theme_revision_id));
        Ok(themes)
    }

    /// Delete one immutable font revision.
    ///
    /// A document can only reach a font revision through a theme that cites it,
    /// so removal is refused while any stored theme still references it. Once
    /// the revision is dropped, every blob that loses its last reference is
    /// garbage-collected.
    pub fn delete_font_revision(
        &self,
        font_id: &str,
        font_revision_id: &str,
    ) -> Result<FontDeleteReport, HcdError> {
        let revision = self.font_revision(font_id, font_revision_id)?;
        if let Some(theme_id) = self.first_theme_referencing(font_id, Some(font_revision_id))? {
            return Err(HcdError::Unsupported(format!(
                "font revision {font_id}/{font_revision_id} is still used by theme {theme_id}"
            )));
        }
        let candidates: Vec<(String, FontFileFormat)> = revision
            .faces
            .iter()
            .map(|face| (face.sha256.clone(), face.format))
            .collect();
        let path = self.font_revision_path(font_id, font_revision_id)?;
        fs::remove_file(&path)?;
        self.remove_font_dir_if_empty(font_id);
        let removed_blobs = self.gc_blobs(&candidates)?;
        Ok(FontDeleteReport {
            removed_revisions: vec![font_revision_id.to_string()],
            removed_blobs,
        })
    }

    /// Delete every revision of one font, refusing while any theme references
    /// the font. Shared blobs survive until no other revision cites them.
    pub fn delete_font(&self, font_id: &str) -> Result<FontDeleteReport, HcdError> {
        require_font_id(font_id)?;
        let revisions = self.font_revisions(font_id)?;
        if revisions.is_empty() {
            return Err(HcdError::NotFound(format!(
                "font {font_id} has no revisions"
            )));
        }
        if let Some(theme_id) = self.first_theme_referencing(font_id, None)? {
            return Err(HcdError::Unsupported(format!(
                "font {font_id} is still used by theme {theme_id}"
            )));
        }
        let mut candidates: Vec<(String, FontFileFormat)> = Vec::new();
        let mut removed_revisions = Vec::new();
        for revision in &revisions {
            for face in &revision.faces {
                candidates.push((face.sha256.clone(), face.format));
            }
            let path = self.font_revision_path(font_id, &revision.font_revision_id)?;
            fs::remove_file(&path)?;
            removed_revisions.push(revision.font_revision_id.clone());
        }
        let _ = fs::remove_dir(self.root.join("fonts").join(font_id));
        removed_revisions.sort();
        let removed_blobs = self.gc_blobs(&candidates)?;
        Ok(FontDeleteReport {
            removed_revisions,
            removed_blobs,
        })
    }

    /// The first theme revision that references `font_id` (and, when given, a
    /// specific revision). Themes are few, so a linear scan is the reference
    /// check that makes deletion safe without touching the document store.
    fn first_theme_referencing(
        &self,
        font_id: &str,
        font_revision_id: Option<&str>,
    ) -> Result<Option<String>, HcdError> {
        for theme in self.list_themes()? {
            let hit = theme_refs(&theme).iter().any(|reference| {
                reference.font_id == font_id
                    && font_revision_id.is_none_or(|id| reference.font_revision_id == id)
            });
            if hit {
                return Ok(Some(theme.theme_revision_id));
            }
        }
        Ok(None)
    }

    fn remove_font_dir_if_empty(&self, font_id: &str) {
        let dir = self.root.join("fonts").join(font_id);
        let removable = fs::read_dir(&dir)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if removable {
            let _ = fs::remove_dir(&dir);
        }
    }

    /// Remove blobs that no surviving font revision still references. Callers
    /// delete their revision files first, so the surviving scan reflects the
    /// post-deletion state.
    fn gc_blobs(&self, candidates: &[(String, FontFileFormat)]) -> Result<Vec<String>, HcdError> {
        let mut live: BTreeSet<String> = BTreeSet::new();
        for font_id in self.list_font_ids()? {
            for revision in self.font_revisions(&font_id)? {
                for face in revision.faces {
                    live.insert(face.sha256);
                }
            }
        }
        let mut seen = BTreeSet::new();
        let mut removed = Vec::new();
        for (sha256, format) in candidates {
            if live.contains(sha256) || !seen.insert(sha256.clone()) {
                continue;
            }
            let path = self.blob_path(sha256, *format)?;
            if path.exists() {
                fs::remove_file(&path)?;
                removed.push(sha256.clone());
            }
        }
        removed.sort();
        Ok(removed)
    }

    /// Mark a theme revision retired. Retirement blocks *new* pins to the theme
    /// while leaving already-pinned documents able to resolve it, so it needs no
    /// scan of the document store. The state lives in a sidecar marker so the
    /// content-hashed `themeRevisionId` is untouched.
    pub fn retire_theme(&self, theme_revision_id: &str) -> Result<(), HcdError> {
        let _ = self.theme(theme_revision_id)?;
        atomic_write(&self.retirement_marker_path(theme_revision_id)?, b"retired")?;
        Ok(())
    }

    /// Lift a retirement. A no-op when the theme is not retired.
    pub fn unretire_theme(&self, theme_revision_id: &str) -> Result<(), HcdError> {
        require_sha256(theme_revision_id)?;
        match fs::remove_file(self.retirement_marker_path(theme_revision_id)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(HcdError::Io(error)),
        }
    }

    pub fn is_theme_retired(&self, theme_revision_id: &str) -> Result<bool, HcdError> {
        require_sha256(theme_revision_id)?;
        Ok(self.retirement_marker_path(theme_revision_id)?.exists())
    }

    /// Every theme revision currently retired, by id.
    pub fn list_retired_theme_ids(&self) -> Result<Vec<String>, HcdError> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(self.root.join("themes"))? {
            let path = entry?.path();
            if path.extension().and_then(|value| value.to_str()) == Some("retired") {
                if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
                    if require_sha256(stem).is_ok() {
                        ids.push(stem.to_string());
                    }
                }
            }
        }
        ids.sort();
        Ok(ids)
    }

    fn retirement_marker_path(&self, theme_revision_id: &str) -> Result<PathBuf, HcdError> {
        require_sha256(theme_revision_id)?;
        Ok(self
            .root
            .join("themes")
            .join(format!("{theme_revision_id}.retired")))
    }

    /// Delete a theme revision outright. Retirement only stops *new* pins, so
    /// this is the step that actually drops the theme file, and it is refused
    /// while any document under `docs_root` still reaches it — through its head
    /// or through revision history — naming those documents.
    ///
    /// Font revisions and blobs survive: a theme is only a set of slots that
    /// cite them, so freeing storage is the font delete path's job.
    pub fn delete_theme(&self, theme_revision_id: &str, docs_root: &Path) -> Result<(), HcdError> {
        let _ = self.theme(theme_revision_id)?;
        let referenced = theme_documents(docs_root, theme_revision_id)?;
        if !referenced.is_empty() {
            let named = named_documents(&referenced);
            return Err(HcdError::Unsupported(format!(
                "theme {theme_revision_id} is still pinned by {} document(s): {named}",
                referenced.len()
            )));
        }
        fs::remove_file(self.theme_path(theme_revision_id)?)?;
        // A retirement marker is only bookkeeping for a theme that no longer
        // exists, so drop it with the theme instead of orphaning it.
        let _ = fs::remove_file(self.retirement_marker_path(theme_revision_id)?);
        Ok(())
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

    /// Append one operation to the audit log and return the stored line.
    ///
    /// Records go to `{catalog}/audit/{YYYY-MM-DD}.jsonl`, one JSON object per
    /// line, split by UTC day so the log is never rewritten as a whole and an
    /// operator can read a busy period without touching the rest. Nothing in the
    /// catalog edits or removes a line: the point of the file is that a change
    /// made through this API stays visible afterwards.
    ///
    /// A failure to append is returned instead of being swallowed. An operation
    /// that took effect without being recorded is precisely the hole an audit
    /// trail exists to close, so callers treat this as a failed request; the
    /// import auto-pin is the one place that degrades to a warning, because
    /// there the pin itself is already best-effort.
    pub fn record_audit(&self, record: AuditRecord<'_>) -> Result<AuditEntry, HcdError> {
        require_audit_action(record.action)?;
        require_audit_text(record.target, "target", MAX_AUDIT_TARGET_CHARS)?;
        require_audit_text(record.actor, "actor", MAX_AUDIT_ACTOR_CHARS)?;
        require_audit_detail(record.detail)?;
        let entry = AuditEntry {
            at: now_epoch_ms(),
            action: record.action.to_string(),
            target: record.target.to_string(),
            actor: record.actor.to_string(),
            detail: record.detail.to_string(),
        };
        let line = format!("{}\n", serde_json::to_string(&entry)?);
        let path = self.audit_path(&utc_day_name(entry.at))?;
        fs::create_dir_all(path.parent().expect("audit path has a parent"))?;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| {
                HcdError::Io(std::io::Error::new(
                    error.kind(),
                    format!("audit log {} could not be opened: {error}", path.display()),
                ))
            })?;
        file.write_all(line.as_bytes())?;
        file.sync_all()?;
        Ok(entry)
    }

    /// Read the newest audit entries, most recent first, across at most `limit`
    /// lines (clamped to `1..=MAX_AUDIT_LIMIT`).
    ///
    /// Days are scanned newest-first and each is read from its end, so the cost
    /// of one page does not grow with the age of the log. Lines that fail to
    /// parse are counted in [`AuditPage::unreadable`] rather than dropped
    /// silently: a torn final line from a crash, or a fragment cut off by the
    /// tail bound, must not turn into "nothing else happened".
    pub fn audit_entries(&self, limit: usize) -> Result<AuditPage, HcdError> {
        self.audit_entries_in(AuditWindow::default(), limit)
    }

    /// Read the newest audit entries inside a UTC-day window, most recent first,
    /// across at most `limit` lines (clamped to `1..=MAX_AUDIT_LIMIT`).
    ///
    /// A bound that is not a real calendar day is refused rather than treated as
    /// open: `from=2026-02-30` excludes every day that exists, and answering
    /// "nothing happened" to that would be a false statement about the past.
    /// Bounds that invert (`from` after `to`) are refused for the same reason.
    ///
    /// Days are scanned newest-first, so the window's newest end is what the
    /// limit spends: the entries not returned are the older ones, and
    /// [`AuditPage::truncated`] says they are there.
    pub fn audit_entries_in(
        &self,
        window: AuditWindow<'_>,
        limit: usize,
    ) -> Result<AuditPage, HcdError> {
        let limit = limit.clamp(1, MAX_AUDIT_LIMIT);
        for (name, bound) in [("from", window.from), ("to", window.to)] {
            if let Some(day) = bound {
                require_audit_bound(day, name)?;
            }
        }
        if let (Some(from), Some(to)) = (window.from, window.to) {
            if from > to {
                return Err(HcdError::InvalidBundle(format!(
                    "audit window from {from} is after to {to}"
                )));
            }
        }
        let mut days: Vec<String> = Vec::new();
        match fs::read_dir(self.root.join("audit")) {
            Ok(entries) => {
                for entry in entries {
                    let path = entry?.path();
                    if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                        continue;
                    }
                    let stem = path
                        .file_stem()
                        .and_then(|value| value.to_str())
                        .unwrap_or_default();
                    if !is_audit_day(stem) {
                        continue;
                    }
                    if window.from.is_some_and(|from| stem < from) {
                        continue;
                    }
                    if window.to.is_some_and(|to| stem > to) {
                        continue;
                    }
                    days.push(stem.to_string());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(AuditPage::default())
            }
            Err(error) => return Err(HcdError::Io(error)),
        }
        days.sort();
        days.reverse();
        let mut page = AuditPage::default();
        'days: for day in days {
            let path = self.audit_path(&day)?;
            let (bytes, dropped_front) = read_audit_tail(&path, MAX_AUDIT_FILE_BYTES)?;
            if dropped_front {
                page.unreadable += 1;
            }
            let mut lines: Vec<&str> = bytes
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
                .filter_map(|line| std::str::from_utf8(line).ok())
                .collect();
            lines.reverse();
            for line in lines {
                // Checked per line, not per day, so a full page followed by an
                // empty older day is not reported as if something were missing.
                if page.entries.len() >= limit {
                    page.truncated = true;
                    break 'days;
                }
                match serde_json::from_str::<AuditEntry>(line) {
                    Ok(entry) => page.entries.push(entry),
                    Err(_) => page.unreadable += 1,
                }
            }
        }
        Ok(page)
    }

    fn audit_path(&self, day: &str) -> Result<PathBuf, HcdError> {
        if !is_audit_day(day) {
            return Err(HcdError::InvalidBundle(
                "audit day must be a YYYY-MM-DD date".to_string(),
            ));
        }
        Ok(self.root.join("audit").join(format!("{day}.jsonl")))
    }
}

/// Recognise a catalog-supported font file by its magic bytes.
///
/// Unknown or unsupported binaries (woff, ttc, images) return `None`, so an
/// upload endpoint can reject them before storing a blob.
pub fn detect_font_format(bytes: &[u8]) -> Option<FontFileFormat> {
    if bytes.len() < 4 {
        return None;
    }
    match &bytes[..4] {
        b"wOF2" => Some(FontFileFormat::Woff2),
        b"OTTO" => Some(FontFileFormat::Otf),
        [0x00, 0x01, 0x00, 0x00] | b"true" => Some(FontFileFormat::Ttf),
        _ => None,
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

/// Whether the document's own stylesheet at this revision already carries the
/// managed theme region. `pin_document_theme` writes that region into the
/// bundle as a content revision, so a surface that renders the bundle
/// stylesheet already has the theme declarations. An unreadable stylesheet
/// counts as absent: the caller then falls back to sending the declarations,
/// which is the older behaviour rather than a new failure.
fn theme_region_in_styles(bundle: &Bundle, revision: Option<u64>) -> Result<bool, HcdError> {
    let head = bundle.manifest()?;
    let (manifest, _) = manifest_at_revision(bundle, &head, revision)?;
    let styles = match bundle.read_styles_part(&manifest.styles_href) {
        Ok(styles) => styles,
        Err(HcdError::NotFound(_)) | Err(HcdError::Io(_)) => return Ok(false),
        Err(error) => return Err(error),
    };
    Ok(styles.lines().any(|line| line.trim() == THEME_REGION_BEGIN))
}

/// Build the theme part of an HTML presentation stylesheet.
/// Missing pins return `None`. Font bytes are inlined as data URLs, and faces
/// larger than 8 MiB are left out. The result is not stored in the bundle.
///
/// The variables and the rules that apply them belong to the document: the pin
/// wrote them into `styles.css` as a content revision, and the presentation
/// renders that stylesheet, so re-sending them here would mean two stylesheets
/// claiming one document. Only the font bytes are added, because they cannot
/// live in the bundle — they are catalog objects addressed by per-deployment
/// URLs. A document pinned before the region existed still needs the
/// declarations, and gets them here.
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
    if !theme_region_in_styles(bundle, revision)? {
        for line in resolved.theme.css.lines() {
            if line.contains("@font-face") || line.contains("/v1/embed/") {
                continue;
            }
            css.push_str(line);
            css.push('\n');
        }
        css.push_str(THEME_SEMANTIC_FLOW_RULE);
        css.push('\n');
    }
    if css.contains('<') || css.to_ascii_lowercase().contains("@import") {
        return Err(HcdError::InvalidBundle(
            "theme presentation CSS is unsafe".to_string(),
        ));
    }
    Ok(Some(css))
}

const THEME_REGION_BEGIN: &str = "/* hcd-theme-begin */";
const THEME_REGION_END: &str = "/* hcd-theme-end */";
const THEME_SEMANTIC_FLOW_RULE: &str = "body[data-hcd-profile=\"semantic-flow\"]{font-family:var(--hcd-minor-latin,var(--hcd-major-latin))}body[data-hcd-profile=\"semantic-flow\"] :is(h1,h2){font-family:var(--hcd-major-latin,var(--hcd-minor-latin))}";

/// Build the stylesheet block a pinned theme contributes to the document's own
/// `styles.css`. It carries only the resolved `--hcd-*` font variables and the
/// semantic-flow rules; font bytes stay in the catalog and are resolved as
/// `@font-face` data URLs at preview and export time, not stored here.
pub fn theme_document_css(
    catalog: &DiskCatalog,
    theme_revision_id: &str,
) -> Result<String, HcdError> {
    // An empty href makes `resolve` skip every `@font-face` src line, leaving
    // only the `:root { --hcd-* }` variable lines that belong in the document.
    let resolved = catalog.resolve(theme_revision_id, |_, _, _| String::new())?;
    let mut block = String::new();
    for line in resolved.css.lines() {
        block.push_str(line);
        block.push('\n');
    }
    block.push_str(THEME_SEMANTIC_FLOW_RULE);
    block.push('\n');
    if block.contains('<') || block.to_ascii_lowercase().contains("@import") {
        return Err(HcdError::InvalidBundle(
            "theme document CSS is unsafe".to_string(),
        ));
    }
    Ok(block)
}

/// Return `styles` with the managed theme region replaced by `block`. The
/// region is delimited so repeated pins update one place instead of stacking,
/// and every document rule outside the region is preserved verbatim.
fn with_theme_region(styles: &str, block: &str) -> String {
    let mut kept = String::new();
    let mut inside = false;
    for line in styles.lines() {
        if line.trim() == THEME_REGION_BEGIN {
            inside = true;
            continue;
        }
        if line.trim() == THEME_REGION_END {
            inside = false;
            continue;
        }
        if !inside {
            kept.push_str(line);
            kept.push('\n');
        }
    }
    let trimmed = kept.trim_end();
    let mut merged = String::from(trimmed);
    if !merged.is_empty() && !block.is_empty() {
        merged.push('\n');
    }
    if !block.is_empty() {
        merged.push_str(THEME_REGION_BEGIN);
        merged.push('\n');
        merged.push_str(block);
        merged.push_str(THEME_REGION_END);
        merged.push('\n');
    }
    merged
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

/// Pin a catalog theme to the document as a real content revision.
///
/// The theme's font families and `--hcd-*` variables are written into a managed
/// region of the document's stylesheet, committed under a new `stylesHref`, and
/// the head revision is advanced with a recomputed body root. Font bytes are not
/// stored here; they stay in the catalog and are resolved at preview/export time.
/// Re-pinning a theme the head already carries with an identical block is an
/// idempotent no-op that does not add a revision.
pub fn pin_document_theme(
    catalog: &DiskCatalog,
    bundle: &Bundle,
    theme_revision_id: &str,
) -> Result<crate::HcdManifest, HcdError> {
    require_sha256(theme_revision_id)?;
    let block = theme_document_css(catalog, theme_revision_id)?;
    commit_document_theme(catalog, bundle, Some(theme_revision_id), &block)
}

/// Drop the theme pinned on the document, as a content revision of its own.
///
/// The managed region leaves a new stylesheet and `themeRevisionId` clears on the
/// head record, so preview and export fall back to the faces the document itself
/// carries: the same result removing one selection face has for a text node, one
/// level up. A document that carries no pin and no managed region comes back
/// unchanged, so repeating the call is safe. The catalog entry the document
/// pointed at is untouched; retiring or deleting it stays a separate decision.
pub fn unpin_document_theme(
    catalog: &DiskCatalog,
    bundle: &Bundle,
) -> Result<crate::HcdManifest, HcdError> {
    commit_document_theme(catalog, bundle, None, "")
}

/// Writes `block` as the document's managed theme region and advances the head
/// revision. `theme_revision_id` is the theme being pinned, or `None` for an
/// unpin, and is recorded on the new revision so history shows what the document
/// pointed at. The retired-theme guard runs only for a real change, so a document
/// that already pins a retired theme can keep re-asserting it.
fn commit_document_theme(
    catalog: &DiskCatalog,
    bundle: &Bundle,
    theme_revision_id: Option<&str>,
    block: &str,
) -> Result<crate::HcdManifest, HcdError> {
    let _guard = bundle.acquire_write_lock()?;
    let mut manifest = bundle.manifest()?;
    if manifest.state != "COMPLETE" {
        return Err(HcdError::InvalidBundle(if theme_revision_id.is_some() {
            "only a complete document can pin a theme".to_string()
        } else {
            "only a complete document can unpin a theme".to_string()
        }));
    }
    let head_record = bundle.revision(manifest.revision)?;
    if head_record.document_id != manifest.document_id || head_record.revision != manifest.revision
    {
        return Err(HcdError::InvalidBundle(
            "head revision record does not match the manifest".to_string(),
        ));
    }
    let base_styles = bundle.read_styles_part(&manifest.styles_href)?;
    let new_styles = with_theme_region(&base_styles, block);
    if manifest.theme_revision_id.as_deref() == theme_revision_id && new_styles == base_styles {
        return Ok(manifest);
    }
    // A retired theme stays resolvable for documents that already pin it, but
    // cannot be newly pinned. The idempotent no-op above already covers
    // re-asserting the current pin, so only a real change reaches this guard.
    if let Some(theme_revision_id) = theme_revision_id {
        if catalog.is_theme_retired(theme_revision_id)? {
            return Err(HcdError::Unsupported(format!(
                "theme {theme_revision_id} is retired and cannot be newly pinned"
            )));
        }
    }
    if manifest.revision >= crate::MAX_REVISION {
        return Err(HcdError::ResourceLimit(
            "revision limit reached".to_string(),
        ));
    }

    let new_revision = manifest.revision + 1;
    let new_styles_href = format!("styles/rev-{new_revision:020}.css");
    bundle.write_styles_part(&new_styles_href, &new_styles)?;

    // The node tree is unchanged, so rebuild the descriptor digest from the
    // current index pages; only the stylesheet component of the root moves.
    let mut root_hasher = Sha256::new();
    let view = manifest.clone();
    for page_number in 0..view.index_page_count {
        let page = bundle.read_index_page(&view, page_number)?;
        for descriptor in page.chunks {
            hash_descriptor(&mut root_hasher, &descriptor);
        }
    }
    let asset_index_href = bundle.asset_index_href_for_revision(manifest.revision)?;
    let root_hash = finalize_root_hash(bundle, root_hasher, &asset_index_href, &new_styles_href)?;

    let record = crate::RevisionRecord {
        schema_version: manifest.schema_version.clone(),
        document_id: manifest.document_id.clone(),
        revision: new_revision,
        parent_revision: Some(manifest.revision),
        // A pin keeps the identifiers it has always used, so history written
        // before an unpin exists still hashes the same way.
        patch_id: Some(match theme_revision_id {
            Some(_) => format!("theme-{new_revision}"),
            None => format!("theme-clear-{new_revision}"),
        }),
        patch_hash: Some(hash_bytes(
            match theme_revision_id {
                Some(theme_revision_id) => {
                    format!("theme:{theme_revision_id}:{new_revision}")
                }
                None => format!("theme-clear:{new_revision}"),
            }
            .as_bytes(),
        )),
        patch_base_revision: Some(manifest.revision),
        author_id: None,
        author_name: None,
        theme_revision_id: theme_revision_id.map(str::to_string),
        root_hash: root_hash.clone(),
        annotation_root_hash: manifest.annotation_root_hash.clone(),
        index_prefix: manifest.index_prefix.clone(),
        index_root_href: manifest.index_root_href.clone(),
        index_page_count: Some(manifest.index_page_count),
        chunk_count: Some(manifest.chunk_count),
        asset_index_href,
        styles_href: new_styles_href.clone(),
        created_at_epoch_ms: crate::bundle::now_epoch_ms(),
        dirty_node_ids: Vec::new(),
        removed_node_ids: Vec::new(),
        dirty_chunk_ids: Vec::new(),
        dirty_source_parts: Vec::new(),
        dirty_grid_parts: Vec::new(),
        converted_formula_node_ids: Vec::new(),
        grid_row_insertions: Vec::new(),
        grid_row_deletions: Vec::new(),
        grid_column_insertions: Vec::new(),
        grid_column_deletions: Vec::new(),
        structural_change: false,
    };
    manifest.revision = new_revision;
    manifest.root_hash = root_hash;
    manifest.styles_href = new_styles_href;
    manifest.theme_revision_id = theme_revision_id.map(str::to_string);
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

/// Audit actions are machine names, not prose: they are what the console groups
/// and filters on, so the charset is the same one the font ids use, plus dots.
fn require_audit_action(value: &str) -> Result<(), HcdError> {
    let bytes = value.as_bytes();
    if (1..=MAX_AUDIT_ACTION_CHARS).contains(&bytes.len())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
        })
    {
        Ok(())
    } else {
        Err(HcdError::InvalidBundle(format!(
            "audit action must be 1-{MAX_AUDIT_ACTION_CHARS} lowercase letters, digits, dots, hyphens or underscores"
        )))
    }
}

/// Target and actor are stored one record per line and shown in a table, so
/// control characters are refused: a newline would splice a forged record into
/// the log, and an empty one would leave a line nobody acted on.
fn require_audit_text(value: &str, kind: &str, maximum: usize) -> Result<(), HcdError> {
    let count = value.chars().count();
    if count == 0 || count > maximum || value.chars().any(char::is_control) {
        return Err(HcdError::InvalidBundle(format!(
            "audit {kind} must be 1-{maximum} characters without control characters"
        )));
    }
    Ok(())
}

/// The detail may be empty (nothing extra to say), but follows the same rule
/// about control characters and length.
fn require_audit_detail(value: &str) -> Result<(), HcdError> {
    let count = value.chars().count();
    if count > MAX_AUDIT_DETAIL_CHARS || value.chars().any(char::is_control) {
        return Err(HcdError::InvalidBundle(format!(
            "audit detail must be at most {MAX_AUDIT_DETAIL_CHARS} characters without control characters"
        )));
    }
    Ok(())
}

/// `YYYY-MM-DD` shape check, which also keeps a hand-planted file name out of
/// the day scan.
fn is_audit_day(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

/// Whether `value` names a day that exists: the [`is_audit_day`] shape plus a
/// real month and day-of-month, leap years included.
///
/// Exported because an HTTP layer needs the same answer to send 400 rather than
/// the 500 this crate's own error mapping would give a caller for a typo in a
/// query string.
pub fn is_audit_calendar_day(value: &str) -> bool {
    if !is_audit_day(value) {
        return false;
    }
    let Ok(month) = value[5..7].parse::<u8>() else {
        return false;
    };
    let Ok(day) = value[8..10].parse::<u8>() else {
        return false;
    };
    let Ok(year) = value[0..4].parse::<i16>() else {
        return false;
    };
    if !(1..=12).contains(&month) {
        return false;
    }
    day >= 1 && day <= days_in_month(year, month)
}

fn days_in_month(year: i16, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

/// A window bound as an error, naming which bound was wrong.
fn require_audit_bound(day: &str, name: &str) -> Result<(), HcdError> {
    if is_audit_calendar_day(day) {
        return Ok(());
    }
    Err(HcdError::InvalidBundle(format!(
        "audit {name} must name a real UTC day as YYYY-MM-DD, got {day}"
    )))
}

/// The UTC calendar day for an epoch-millisecond timestamp, used as the audit
/// file name so days sort lexicographically in the order they happened.
fn utc_day_name(epoch_ms: u64) -> String {
    // Days since 1970-01-01, shifted to the 146097-day Gregorian cycle whose
    // civil-date formula starts at March.
    const MS_PER_DAY: u64 = 24 * 60 * 60 * 1000;
    let shifted = epoch_ms / MS_PER_DAY + 719_468;
    let era = shifted / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_period = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_period + 2) / 5 + 1;
    let month = if month_period < 10 {
        month_period + 3
    } else {
        month_period - 9
    };
    let year = year_of_era + era * 400 + if month <= 2 { 1 } else { 0 };
    format!("{year:04}-{month:02}-{day:02}")
}

/// Read the last `maximum_bytes` of one audit day file.
///
/// The second field says whether the returned slice starts inside a longer line,
/// which happens only once a day grows past the bound. A missing file is an
/// empty log, not an error.
fn read_audit_tail(path: &Path, maximum_bytes: u64) -> Result<(Vec<u8>, bool), HcdError> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), false))
        }
        Err(error) => return Err(HcdError::Io(error)),
    };
    let length = file.metadata()?.len();
    if length <= maximum_bytes {
        let mut bytes = Vec::with_capacity(length as usize);
        file.read_to_end(&mut bytes)?;
        return Ok((bytes, false));
    }
    let start = length - maximum_bytes;
    // The byte just before the cut decides whether the first line survives it.
    let mut probe = [0u8; 1];
    file.seek(SeekFrom::Start(start - 1))?;
    file.read_exact(&mut probe)?;
    let first_line_whole = probe[0] == b'\n';
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity(maximum_bytes as usize);
    file.read_to_end(&mut bytes)?;
    Ok((bytes, !first_line_whole))
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
        let stored = catalog.put_font_revision(&font).unwrap();
        assert_eq!(
            stored.font_revision_id,
            content_id(&font, "fontRevisionId").unwrap()
        );
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
    fn listing_returns_stored_fonts_and_themes() {
        let (_temp, catalog, font_revision_id, theme_id) = install();
        assert_eq!(
            catalog.list_font_ids().unwrap(),
            vec!["source-han-sans".to_string()]
        );
        let revisions = catalog.font_revisions("source-han-sans").unwrap();
        assert_eq!(revisions.len(), 1);
        assert_eq!(revisions[0].font_revision_id, font_revision_id);
        assert_eq!(revisions[0].faces.len(), 2);
        assert_eq!(catalog.get_theme(&theme_id).unwrap().name, "Office default");
        let themes = catalog.list_themes().unwrap();
        assert_eq!(themes.len(), 1);
        assert_eq!(themes[0].theme_revision_id, theme_id);
    }

    #[test]
    fn listing_rejects_a_tampered_object_instead_of_a_partial_view() {
        let (temp, catalog, _font_revision_id, _theme_id) = install();
        fs::write(
            temp.path()
                .join("themes")
                .join(format!("{}.json", "ab".repeat(32))),
            b"{}",
        )
        .unwrap();
        let error = catalog.list_themes().unwrap_err();
        assert!(matches!(error, HcdError::InvalidBundle(_)));
    }

    #[test]
    fn detect_font_format_reads_magic_bytes() {
        assert_eq!(
            detect_font_format(b"wOF2 payload"),
            Some(FontFileFormat::Woff2)
        );
        assert_eq!(
            detect_font_format(b"OTTO payload"),
            Some(FontFileFormat::Otf)
        );
        assert_eq!(
            detect_font_format(&[0x00, 0x01, 0x00, 0x00, b'g', b'p', b'f', b'x']),
            Some(FontFileFormat::Ttf)
        );
        assert_eq!(
            detect_font_format(b"true payload"),
            Some(FontFileFormat::Ttf)
        );
        assert_eq!(detect_font_format(b"wOFF payload"), None);
        assert_eq!(detect_font_format(b"PK\x03\x04 zip"), None);
        assert_eq!(detect_font_format(b"ab"), None);
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
    fn presentation_css_adds_fonts_and_leaves_rules_to_the_document() {
        let (_temp, catalog, _font_revision_id, theme_id) = install();
        let docs = tempfile::tempdir().unwrap();
        let bundle = bundle_pinned(docs.path(), "demo", "article { color: #123456; }", None);
        assert!(theme_presentation_css(&catalog, &bundle, None)
            .unwrap()
            .is_none());

        pin_document_theme(&catalog, &bundle, &theme_id).unwrap();
        // One copy of the declarations, in the document's own stylesheet.
        let manifest = bundle.manifest().unwrap();
        let styles = bundle.read_styles_part(&manifest.styles_href).unwrap();
        assert_eq!(
            styles.matches(THEME_SEMANTIC_FLOW_RULE).count(),
            1,
            "the pin wrote the rules once: {styles}"
        );
        assert_eq!(styles.matches("--hcd-major-latin:").count(), 1);

        // The presentation adds only the font bytes, which cannot live in the
        // bundle because they are catalog objects behind service URLs.
        let css = theme_presentation_css(&catalog, &bundle, None)
            .unwrap()
            .unwrap();
        assert!(css.contains("data:font/woff2;base64,"));
        assert!(css.contains("data:font/otf;base64,"));
        assert!(
            !css.contains("--hcd-major-latin"),
            "the document stylesheet already declares the variables: {css}"
        );
        assert!(
            !css.contains("body[data-hcd-profile"),
            "the document stylesheet already applies the families: {css}"
        );
        assert!(!css.contains("/v1/embed/"));
        assert!(!css.contains('<'));
    }

    #[test]
    fn presentation_css_carries_declarations_when_the_document_has_no_region() {
        // A document pinned before the pin wrote a theme region still gets a
        // themed presentation: with nothing in its stylesheet, this is the only
        // copy of the declarations.
        let (_temp, catalog, _font_revision_id, theme_id) = install();
        let docs = tempfile::tempdir().unwrap();
        let bundle = bundle_pinned(
            docs.path(),
            "legacy",
            "article { color: #123456; }",
            Some(theme_id.clone()),
        );
        let manifest = bundle.manifest().unwrap();
        assert_eq!(
            manifest.theme_revision_id.as_deref(),
            Some(theme_id.as_str())
        );
        let styles = bundle.read_styles_part(&manifest.styles_href).unwrap();
        assert!(!styles.contains(THEME_REGION_BEGIN));

        let css = theme_presentation_css(&catalog, &bundle, None)
            .unwrap()
            .unwrap();
        assert!(css.contains("--hcd-major-latin:"));
        assert!(css.contains(THEME_SEMANTIC_FLOW_RULE));
        assert!(css.contains("data:font/"));
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
        pin_document_theme(&catalog, &bundle, &theme_id).unwrap();
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

    fn complete_bundle(root_dir: &tempfile::TempDir, styles: &str) -> Bundle {
        bundle_at(root_dir.path(), "demo", styles)
    }

    /// A finished bundle at `{docs_root}/{name}.hcd`, which is how the document
    /// store lays out every service-visible document.
    fn bundle_at(docs_root: &Path, name: &str, styles: &str) -> Bundle {
        bundle_pinned(docs_root, name, styles, None)
    }

    /// Like `bundle_at`, but `theme` records a pin on the head manifest without
    /// touching the stylesheet — exactly the shape a document pinned before the
    /// pin started writing a theme region into `styles.css` leaves behind.
    fn bundle_pinned(docs_root: &Path, name: &str, styles: &str, theme: Option<String>) -> Bundle {
        let root = docs_root.join(format!("{name}.hcd"));
        let writer = BundleWriter::create(&root).unwrap();
        writer.write_styles(styles).unwrap();
        writer
            .finish(HcdManifest {
                schema_version: String::new(),
                storage_codec: StorageCodec::None,
                document_id: name.to_string(),
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
                theme_revision_id: theme,
                capabilities: HcdCapabilities::default(),
                fidelity: None,
                state: "IMPORTING".to_string(),
                warnings: Vec::new(),
            })
            .unwrap();
        Bundle::open(&root).unwrap()
    }

    #[test]
    fn pin_bumps_revision_and_stays_on_the_revision_it_pinned() {
        let (_temp, catalog, font_revision_id, theme_id) = install();
        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle = complete_bundle(&bundle_dir, "article { color: #123456; }");
        assert_eq!(bundle.manifest().unwrap().revision, 0);

        let manifest = pin_document_theme(&catalog, &bundle, &theme_id).unwrap();
        assert_eq!(manifest.revision, 1);
        assert_eq!(
            manifest.theme_revision_id.as_deref(),
            Some(theme_id.as_str())
        );
        assert!(manifest.styles_href.starts_with("styles/rev-"));

        let pinned_css = bundle.read_styles_part(&manifest.styles_href).unwrap();
        assert!(pinned_css.contains("article { color: #123456; }"));
        assert!(pinned_css.contains("/* hcd-theme-begin */"));
        assert!(pinned_css.contains("--hcd-major-latin:'Source Han Sans',sans-serif"));

        // Revision 0 predates the pin; revision 1 carries it.
        assert!(bundle.revision(0).unwrap().theme_revision_id.is_none());
        assert_eq!(
            bundle.revision(1).unwrap().theme_revision_id.as_deref(),
            Some(theme_id.as_str())
        );
        // The body root moved because the committed stylesheet changed.
        assert_ne!(
            bundle.revision(0).unwrap().root_hash,
            bundle.revision(1).unwrap().root_hash
        );
        let report = crate::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{:?}", report.issues);

        // Re-pinning the same theme is idempotent: no extra revision.
        let again = pin_document_theme(&catalog, &bundle, &theme_id).unwrap();
        assert_eq!(again.revision, 1);

        // A different theme advances the head; older revisions keep their own pin.
        let second = catalog
            .put_theme(&ThemeRevision {
                schema_version: THEME_SCHEMA.to_string(),
                theme_revision_id: String::new(),
                name: "Serif default".to_string(),
                major: ThemeFontSlots {
                    latin: Some(FontRef {
                        font_id: "source-han-sans".to_string(),
                        font_revision_id: font_revision_id.clone(),
                    }),
                    east_asia: None,
                    bidi: None,
                },
                minor: ThemeFontSlots {
                    latin: Some(FontRef {
                        font_id: "source-han-sans".to_string(),
                        font_revision_id,
                    }),
                    east_asia: None,
                    bidi: None,
                },
                fallback_families: vec!["serif".to_string()],
            })
            .unwrap();
        let head = pin_document_theme(&catalog, &bundle, &second).unwrap();
        assert_eq!(head.revision, 2);
        assert_ne!(head.styles_href, manifest.styles_href);

        let (rev1, _) = manifest_at_revision(&bundle, &head, Some(1)).unwrap();
        assert_eq!(rev1.theme_revision_id.as_deref(), Some(theme_id.as_str()));
        assert_eq!(rev1.styles_href, manifest.styles_href);
        let (rev0, _) = manifest_at_revision(&bundle, &head, Some(0)).unwrap();
        assert!(rev0.theme_revision_id.is_none());
        assert_eq!(rev0.styles_href, "styles.css");
        let report = crate::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{:?}", report.issues);
    }

    #[test]
    fn unpin_drops_the_theme_region_and_keeps_the_document_styles() {
        let (_temp, catalog, _font_revision_id, theme_id) = install();
        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle = complete_bundle(&bundle_dir, "article { color: #123456; }");
        let pinned = pin_document_theme(&catalog, &bundle, &theme_id).unwrap();
        assert_eq!(pinned.revision, 1);

        let cleared = unpin_document_theme(&catalog, &bundle).unwrap();
        assert_eq!(cleared.revision, 2, "an unpin is a revision of its own");
        assert!(cleared.theme_revision_id.is_none());
        assert_ne!(cleared.styles_href, pinned.styles_href);

        // The managed region is gone and nothing else moved: the document is left
        // with exactly the stylesheet it was imported with.
        let cleared_css = bundle.read_styles_part(&cleared.styles_href).unwrap();
        assert_eq!(cleared_css.trim(), "article { color: #123456; }");
        assert!(!cleared_css.contains("hcd-theme-begin"));
        assert!(!cleared_css.contains("--hcd-major-latin"));
        assert!(!bundle.revision(2).unwrap().structural_change);

        // History keeps what each revision pointed at.
        assert_eq!(
            bundle.revision(1).unwrap().theme_revision_id.as_deref(),
            Some(theme_id.as_str())
        );
        assert!(bundle.revision(2).unwrap().theme_revision_id.is_none());
        assert_ne!(
            bundle.revision(1).unwrap().root_hash,
            bundle.revision(2).unwrap().root_hash
        );
        let report = crate::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{:?}", report.issues);

        // Repeating the unpin changes nothing, so no empty revision piles up.
        let again = unpin_document_theme(&catalog, &bundle).unwrap();
        assert_eq!(again.revision, 2);
        assert_eq!(again.styles_href, cleared.styles_href);

        // Pinning after an unpin advances the head again.
        let repinned = pin_document_theme(&catalog, &bundle, &theme_id).unwrap();
        assert_eq!(repinned.revision, 3);
        assert_eq!(
            repinned.theme_revision_id.as_deref(),
            Some(theme_id.as_str())
        );
    }

    #[test]
    fn unpin_never_advances_a_document_that_carries_no_theme() {
        let (_temp, catalog, _font_revision_id, _theme_id) = install();
        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle = complete_bundle(&bundle_dir, "p { color: #111111; }");
        let before = bundle.manifest().unwrap();

        let manifest = unpin_document_theme(&catalog, &bundle).unwrap();
        assert_eq!(manifest.revision, before.revision);
        assert_eq!(manifest.styles_href, "styles.css");
        assert!(manifest.theme_revision_id.is_none());
        // The untouched stylesheet still reads as it was written.
        assert_eq!(
            bundle.read_styles_part(&manifest.styles_href).unwrap(),
            "p { color: #111111; }"
        );
    }

    #[test]
    fn retired_theme_blocks_new_pins_but_still_resolves_and_reasserts() {
        let (_temp, catalog, _font_revision_id, theme_id) = install();
        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle = complete_bundle(&bundle_dir, "p { color: #111111; }");

        // Retiring before any pin blocks a new pin, but the theme still
        // resolves so operators can inspect or preview it.
        catalog.retire_theme(&theme_id).unwrap();
        assert!(catalog.is_theme_retired(&theme_id).unwrap());
        assert_eq!(
            catalog.list_retired_theme_ids().unwrap(),
            vec![theme_id.clone()]
        );
        assert!(matches!(
            pin_document_theme(&catalog, &bundle, &theme_id),
            Err(HcdError::Unsupported(_))
        ));
        catalog
            .resolve(&theme_id, |_, _, _| "/f".to_string())
            .unwrap();

        // Unretiring lifts the block; the document pins cleanly.
        catalog.unretire_theme(&theme_id).unwrap();
        assert!(!catalog.is_theme_retired(&theme_id).unwrap());
        assert!(catalog.list_retired_theme_ids().unwrap().is_empty());
        let manifest = pin_document_theme(&catalog, &bundle, &theme_id).unwrap();
        assert_eq!(
            manifest.theme_revision_id.as_deref(),
            Some(theme_id.as_str())
        );

        // Once pinned, re-asserting the same (now retired) theme is an
        // idempotent no-op, not a new pin, so it is still allowed.
        catalog.retire_theme(&theme_id).unwrap();
        let again = pin_document_theme(&catalog, &bundle, &theme_id).unwrap();
        assert_eq!(again.revision, manifest.revision);
    }

    fn store_font_without_theme(catalog: &DiskCatalog) -> FontRevision {
        let reg = catalog
            .put_font_bytes(b"fake-woff2", FontFileFormat::Woff2)
            .unwrap();
        let mut font = sample_font(&reg, b"fake-woff2".len() as u64);
        font.faces[1].sha256 = catalog
            .put_font_bytes(b"fake-otf-bold", FontFileFormat::Otf)
            .unwrap();
        font.faces[1].byte_length = b"fake-otf-bold".len() as u64;
        catalog.put_font_revision(&font).unwrap()
    }

    fn store_revision(catalog: &DiskCatalog, reg: &str, bold: &str) -> FontRevision {
        let mut font = sample_font(reg, b"shared-regular".len() as u64);
        font.faces[1].sha256 = bold.to_string();
        font.faces[1].byte_length = b"bold-A".len() as u64;
        catalog.put_font_revision(&font).unwrap()
    }

    fn blob_names(catalog: &DiskCatalog) -> Vec<String> {
        std::fs::read_dir(catalog.root().join("blobs"))
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn delete_is_refused_while_a_theme_references_the_font() {
        let (_temp, catalog, font_revision_id, _theme_id) = install();
        assert!(matches!(
            catalog.delete_font_revision("source-han-sans", &font_revision_id),
            Err(HcdError::Unsupported(_))
        ));
        assert!(matches!(
            catalog.delete_font("source-han-sans"),
            Err(HcdError::Unsupported(_))
        ));
        // Nothing was removed while a theme cites it.
        assert_eq!(catalog.font_revisions("source-han-sans").unwrap().len(), 1);
        assert_eq!(
            catalog.list_font_ids().unwrap(),
            vec!["source-han-sans".to_string()]
        );
    }

    #[test]
    fn delete_font_revision_drops_it_and_garbage_collects_orphan_blobs() {
        let temp = tempfile::tempdir().unwrap();
        let catalog = DiskCatalog::open(temp.path()).unwrap();
        let stored = store_font_without_theme(&catalog);
        assert_eq!(catalog.list_font_ids().unwrap().len(), 1);
        assert_eq!(blob_names(&catalog).len(), 2);

        let report = catalog
            .delete_font_revision("source-han-sans", &stored.font_revision_id)
            .unwrap();
        assert_eq!(report.removed_revisions, vec![stored.font_revision_id]);
        assert_eq!(report.removed_blobs.len(), 2);
        assert!(catalog.list_font_ids().unwrap().is_empty());
        assert!(blob_names(&catalog).is_empty());
    }

    #[test]
    fn delete_keeps_a_shared_blob_until_the_last_revision_goes() {
        let temp = tempfile::tempdir().unwrap();
        let catalog = DiskCatalog::open(temp.path()).unwrap();
        let reg = catalog
            .put_font_bytes(b"shared-regular", FontFileFormat::Woff2)
            .unwrap();
        let bold_a = catalog
            .put_font_bytes(b"bold-A", FontFileFormat::Otf)
            .unwrap();
        let bold_b = catalog
            .put_font_bytes(b"bold-B", FontFileFormat::Otf)
            .unwrap();
        let rev_a = store_revision(&catalog, &reg, &bold_a);
        let _rev_b = store_revision(&catalog, &reg, &bold_b);
        assert_eq!(blob_names(&catalog).len(), 3);

        let report = catalog
            .delete_font_revision("source-han-sans", &rev_a.font_revision_id)
            .unwrap();
        // bold_a is now unreferenced, but reg is still cited by the survivor.
        assert_eq!(report.removed_blobs, vec![bold_a]);
        assert_eq!(blob_names(&catalog).len(), 2);
        assert!(blob_names(&catalog)
            .iter()
            .any(|name| name.starts_with(&reg)));

        // Removing the whole font releases the shared regular blob too.
        let report = catalog.delete_font("source-han-sans").unwrap();
        assert!(report.removed_blobs.contains(&reg));
        assert_eq!(report.removed_revisions.len(), 1);
        assert!(blob_names(&catalog).is_empty());
        assert!(catalog.list_font_ids().unwrap().is_empty());
    }

    /// A theme with only the major latin slot, so a test can hold two themes
    /// that differ by content and therefore by id.
    fn latin_theme(catalog: &DiskCatalog, font_revision_id: &str, name: &str) -> String {
        catalog
            .put_theme(&ThemeRevision {
                schema_version: THEME_SCHEMA.to_string(),
                theme_revision_id: String::new(),
                name: name.to_string(),
                major: ThemeFontSlots {
                    latin: Some(FontRef {
                        font_id: "source-han-sans".to_string(),
                        font_revision_id: font_revision_id.to_string(),
                    }),
                    east_asia: None,
                    bidi: None,
                },
                minor: ThemeFontSlots::default(),
                fallback_families: vec!["serif".to_string()],
            })
            .unwrap()
    }

    #[test]
    fn reachability_names_the_head_and_the_revision_that_pinned() {
        let (_temp, catalog, _font_revision_id, theme_id) = install();
        let docs = tempfile::tempdir().unwrap();
        let bundle = bundle_at(docs.path(), "demo", "article { color: #123456; }");
        assert!(theme_documents(docs.path(), &theme_id).unwrap().is_empty());

        pin_document_theme(&catalog, &bundle, &theme_id).unwrap();
        let found = theme_documents(docs.path(), &theme_id).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].document_id, "demo");
        assert!(found[0].head_pinned);
        // Revision 0 predates the pin, so only the pinning revision cites it.
        assert_eq!(found[0].pinned_revisions, vec![1]);
    }

    #[test]
    fn a_theme_that_only_survives_in_history_is_still_reachable() {
        let (_temp, catalog, font_revision_id, first) = install();
        let second = latin_theme(&catalog, &font_revision_id, "Serif default");
        let docs = tempfile::tempdir().unwrap();
        let bundle = bundle_at(docs.path(), "demo", "article { color: #123456; }");
        pin_document_theme(&catalog, &bundle, &first).unwrap();
        pin_document_theme(&catalog, &bundle, &second).unwrap();

        let history = theme_documents(docs.path(), &first).unwrap();
        assert_eq!(history.len(), 1);
        assert!(!history[0].head_pinned);
        assert_eq!(history[0].pinned_revisions, vec![1]);
        // The head theme is reachable in both places.
        let head = theme_documents(docs.path(), &second).unwrap();
        assert!(head[0].head_pinned);
        assert_eq!(head[0].pinned_revisions, vec![2]);

        // Old revisions can still be viewed and re-resolved, so deletion refuses
        // and names the document that keeps the theme alive.
        let error = catalog.delete_theme(&first, docs.path()).unwrap_err();
        assert!(matches!(
            &error,
            HcdError::Unsupported(message) if message.contains("demo")
        ));
        assert!(catalog.get_theme(&first).is_ok());
    }

    #[test]
    fn documents_pinning_another_theme_are_not_reported() {
        let (_temp, catalog, font_revision_id, theme_a) = install();
        let theme_b = latin_theme(&catalog, &font_revision_id, "Serif default");
        let docs = tempfile::tempdir().unwrap();
        let alpha = bundle_at(docs.path(), "alpha", "article { color: #123456; }");
        let beta = bundle_at(docs.path(), "beta", "article { color: #222222; }");
        pin_document_theme(&catalog, &alpha, &theme_a).unwrap();
        pin_document_theme(&catalog, &beta, &theme_b).unwrap();

        let names = |id: &str| -> Vec<String> {
            theme_documents(docs.path(), id)
                .unwrap()
                .into_iter()
                .map(|reference| reference.document_id)
                .collect()
        };
        assert_eq!(names(&theme_a), vec!["alpha".to_string()]);
        assert_eq!(names(&theme_b), vec!["beta".to_string()]);
        // A theme nobody pinned.
        assert!(names(&"cd".repeat(32)).is_empty());
    }

    #[test]
    fn deleting_an_unpinned_theme_keeps_the_fonts_and_drops_the_marker() {
        let (_temp, catalog, font_revision_id, _theme_id) = install();
        let theme = latin_theme(&catalog, &font_revision_id, "Retired spare");
        let docs = tempfile::tempdir().unwrap();
        catalog.retire_theme(&theme).unwrap();
        assert!(catalog.is_theme_retired(&theme).unwrap());

        catalog.delete_theme(&theme, docs.path()).unwrap();

        assert!(catalog.get_theme(&theme).is_err());
        assert!(!catalog.theme_path(&theme).unwrap().exists());
        // The retirement marker belonged to this theme, so it went with it.
        assert!(!catalog.is_theme_retired(&theme).unwrap());
        assert_eq!(catalog.list_themes().unwrap().len(), 1);
        // A theme is only slots: the fonts and blobs it cited stay for reuse.
        assert_eq!(
            catalog.font_revisions("source-han-sans").unwrap()[0].font_revision_id,
            font_revision_id
        );
        assert!(!blob_names(&catalog).is_empty());

        // Deleting twice is not silently fine.
        assert!(matches!(
            catalog.delete_theme(&theme, docs.path()),
            Err(HcdError::NotFound(_))
        ));
    }

    #[test]
    fn the_scan_skips_non_bundles_and_a_missing_document_root() {
        let (_temp, _catalog, _font_revision_id, theme_id) = install();
        let docs = tempfile::tempdir().unwrap();
        // The catalog directory and loose files live in the same root as the
        // documents in production; neither may stop the scan.
        DiskCatalog::open(docs.path().join("catalog")).unwrap();
        fs::write(docs.path().join("notes.txt"), b"not a bundle").unwrap();
        bundle_at(docs.path(), "spare", "article { color: #123456; }");
        assert!(theme_documents(docs.path(), &theme_id).unwrap().is_empty());

        assert!(theme_documents(&docs.path().join("absent"), &theme_id)
            .unwrap()
            .is_empty());
        assert!(theme_documents(docs.path(), "not-a-digest").is_err());
    }

    #[test]
    fn listing_documents_shows_the_head_pin() {
        let (_temp, catalog, _font_revision_id, theme_id) = install();
        let docs = tempfile::tempdir().unwrap();
        let bundle = bundle_at(docs.path(), "demo", "article { color: #123456; }");

        let before = list_documents(docs.path()).unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].document_id, "demo");
        assert_eq!(before[0].profile, "semantic-flow");
        assert_eq!(before[0].format, "docx");
        assert_eq!(before[0].revision, 0);
        assert_eq!(before[0].theme_revision_id, None);

        pin_document_theme(&catalog, &bundle, &theme_id).unwrap();
        let after = list_documents(docs.path()).unwrap();
        assert_eq!(after[0].revision, 1);
        assert_eq!(
            after[0].theme_revision_id.as_deref(),
            Some(theme_id.as_str())
        );
    }

    #[test]
    fn listing_documents_skips_loose_files_and_sorts_by_id() {
        let (_temp, _catalog, _font_revision_id, _theme_id) = install();
        let docs = tempfile::tempdir().unwrap();
        // The production root mixes bundles with the catalog and scratch files.
        DiskCatalog::open(docs.path().join("catalog")).unwrap();
        fs::write(docs.path().join("uploads"), b"not a directory of bundles").unwrap();
        bundle_at(docs.path(), "beta", "article { color: #123456; }");
        bundle_at(docs.path(), "alpha", "article { color: #222222; }");

        let ids: Vec<String> = list_documents(docs.path())
            .unwrap()
            .into_iter()
            .map(|document| document.document_id)
            .collect();
        assert_eq!(ids, vec!["alpha".to_string(), "beta".to_string()]);
        assert!(list_documents(&docs.path().join("absent"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn listing_documents_fails_loudly_on_an_unreadable_bundle() {
        let (_temp, _catalog, _font_revision_id, _theme_id) = install();
        let docs = tempfile::tempdir().unwrap();
        bundle_at(docs.path(), "good", "article { color: #123456; }");
        bundle_at(docs.path(), "bad", "article { color: #222222; }");
        // A half-written bundle must not disappear from a management list.
        fs::write(
            docs.path().join("bad.hcd").join("manifest.json"),
            b"{ this is not json",
        )
        .unwrap();

        let error = list_documents(docs.path()).unwrap_err();
        assert!(matches!(
            &error,
            HcdError::InvalidBundle(message) if message.contains("bad")
        ));
    }

    #[test]
    fn document_summaries_omit_an_absent_pin() {
        let value = serde_json::to_value(DocumentSummary {
            document_id: "demo".to_string(),
            profile: "semantic-flow".to_string(),
            format: "docx".to_string(),
            revision: 3,
            state: "READY".to_string(),
            theme_revision_id: None,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "documentId": "demo",
                "profile": "semantic-flow",
                "format": "docx",
                "revision": 3,
                "state": "READY",
            })
        );
    }

    #[test]
    fn theme_document_refs_serialize_with_http_names() {
        let value = serde_json::to_value(ThemeDocumentRef {
            document_id: "demo".to_string(),
            head_pinned: true,
            pinned_revisions: vec![1, 4],
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "documentId": "demo",
                "headPinned": true,
                "pinnedRevisions": [1, 4],
            })
        );
    }

    fn audit_catalog() -> (tempfile::TempDir, DiskCatalog) {
        let temp = tempfile::tempdir().unwrap();
        let catalog = DiskCatalog::open(temp.path()).unwrap();
        (temp, catalog)
    }

    fn record(catalog: &DiskCatalog, action: &str, target: &str, actor: &str, detail: &str) {
        catalog
            .record_audit(AuditRecord {
                action,
                target,
                actor,
                detail,
            })
            .unwrap();
    }

    /// Hand-written log lines, one file per named day, for readers that must not
    /// depend on the wall clock.
    fn plant_audit_lines(catalog: &DiskCatalog, day: &str, lines: &[&str]) {
        let path = catalog.root().join("audit").join(format!("{day}.jsonl"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut body = String::new();
        for line in lines {
            body.push_str(line);
            body.push('\n');
        }
        fs::write(&path, body).unwrap();
    }

    #[test]
    fn audit_lines_append_one_file_per_day_and_read_back_newest_first() {
        let (_temp, catalog) = audit_catalog();
        record(
            &catalog,
            audit_action::FONT_BYTES_PUT,
            "ui-serif",
            "admin:will",
            "1024 bytes, woff2",
        );
        record(
            &catalog,
            audit_action::THEME_RETIRE,
            "a".repeat(64).as_str(),
            "admin:will",
            "",
        );
        let day = utc_day_name(now_epoch_ms());
        let path = catalog.root().join("audit").join(format!("{day}.jsonl"));
        let stored = fs::read_to_string(&path).unwrap();
        assert_eq!(stored.lines().count(), 2, "both records share one day file");
        assert!(stored.ends_with('\n'), "every record ends its own line");

        let page = catalog.audit_entries(10).unwrap();
        assert_eq!(page.unreadable, 0);
        assert_eq!(page.entries.len(), 2);
        assert_eq!(page.entries[0].action, audit_action::THEME_RETIRE);
        assert_eq!(page.entries[1].action, audit_action::FONT_BYTES_PUT);
        assert_eq!(page.entries[1].detail, "1024 bytes, woff2");
        assert!(page.entries[1].at > 0);
        assert_eq!(page.entries[0].detail, "");

        // The limit is a newest-first window, not a truncation of the oldest.
        let one = catalog.audit_entries(1).unwrap();
        assert_eq!(one.entries.len(), 1);
        assert_eq!(one.entries[0].action, audit_action::THEME_RETIRE);
    }

    #[test]
    fn audit_read_walks_days_newest_first_across_files() {
        let (_temp, catalog) = audit_catalog();
        let older = serde_json::json!({
            "at": 1_600_000_000_000u64, "action": "theme.put", "target": "old",
            "actor": "admin:will", "detail": "first",
        });
        let newer = serde_json::json!({
            "at": 1_700_000_000_000u64, "action": "theme.delete", "target": "old",
            "actor": "admin:will",
        });
        plant_audit_lines(
            &catalog,
            "2020-09-13",
            &[&older.to_string(), "not json at all"],
        );
        plant_audit_lines(&catalog, "2023-11-14", &[&newer.to_string()]);

        let page = catalog.audit_entries(5).unwrap();
        assert_eq!(page.entries.len(), 2, "the day order is newest first");
        assert_eq!(page.entries[0].action, "theme.delete");
        assert_eq!(
            page.entries[0].detail, "",
            "an absent detail reads as empty"
        );
        assert_eq!(page.entries[1].action, "theme.put");
        assert_eq!(page.unreadable, 1, "the torn line is counted, not hidden");

        // A limit that stops inside the newest day must not reach back further.
        let one = catalog.audit_entries(1).unwrap();
        assert_eq!(one.entries.len(), 1);
        assert_eq!(one.entries[0].action, "theme.delete");
    }

    #[test]
    fn audit_rejects_a_bad_action_and_forgery_shaped_text() {
        let (_temp, catalog) = audit_catalog();
        let long_action = "a".repeat(MAX_AUDIT_ACTION_CHARS + 1);
        let long = "d".repeat(MAX_AUDIT_DETAIL_CHARS + 1);
        for (action, target, actor, detail, why) in [
            ("Theme.Put", "x", "a", "", "uppercase action"),
            ("theme put", "x", "a", "", "space in action"),
            ("", "x", "a", "", "empty action"),
            (long_action.as_str(), "x", "a", "", "oversized action"),
            ("theme.put", "", "a", "", "empty target"),
            ("theme.put", "x\nforged", "a", "", "newline in target"),
            (
                "theme.put",
                "x\ttabbed",
                "a",
                "",
                "tab in target, inside the limit",
            ),
            ("theme.put", "x", "", "", "empty actor"),
            ("theme.put", "x", "a", long.as_str(), "oversized detail"),
        ] {
            let error = catalog
                .record_audit(AuditRecord {
                    action,
                    target,
                    actor,
                    detail,
                })
                .expect_err(why);
            assert!(
                matches!(error, HcdError::InvalidBundle(_)),
                "{why}: {error}"
            );
        }
        // An over-long target names its own bound rather than failing as a
        // generic text check, so a caller can tell which field to shorten.
        let error = catalog
            .record_audit(AuditRecord {
                action: "theme.put",
                target: long.as_str(),
                actor: "a",
                detail: "",
            })
            .expect_err("oversized target");
        assert!(
            error
                .to_string()
                .contains(&MAX_AUDIT_TARGET_CHARS.to_string()),
            "{error}"
        );
        assert!(
            catalog
                .root()
                .join("audit")
                .read_dir()
                .unwrap()
                .flatten()
                .next()
                .is_none(),
            "a refused record leaves no line behind"
        );
    }

    #[test]
    fn audit_tail_keeps_the_newest_lines_of_an_oversized_day() {
        let (_temp, catalog) = audit_catalog();
        let line = |index: usize| {
            format!(
                "{{\"at\":{},\"action\":\"theme.put\",\"target\":\"t{index}\",\"actor\":\"admin\"}}",
                1_700_000_000_000u64 + index as u64
            )
        };
        let whole = line(0);
        let bound = whole.len() * 3;
        plant_audit_lines(
            &catalog,
            "2023-11-14",
            &[&line(0), &line(1), &line(2), &line(3)],
        );
        let path = catalog.root().join("audit").join("2023-11-14.jsonl");

        // Cut mid-line: the fragment is dropped and counted, the rest survives.
        let (bytes, dropped) = read_audit_tail(&path, bound as u64).unwrap();
        assert!(dropped, "the read started inside a line");
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains(&line(2)), "{text}");
        assert!(text.contains(&line(3)), "{text}");
        assert!(!text.contains(&whole), "the oldest line is out of reach");

        // A cut that lands on a boundary is not a fragment.
        let exact = (whole.len() + 1) * 2;
        let (bytes, dropped) = read_audit_tail(&path, exact as u64).unwrap();
        assert!(!dropped);
        assert_eq!(bytes, format!("{}\n{}\n", line(2), line(3)).as_bytes());

        // A file within the bound is read whole.
        let (bytes, dropped) = read_audit_tail(&path, 1 << 20).unwrap();
        assert!(!dropped);
        assert_eq!(bytes.len(), (whole.len() + 1) * 4);
    }

    #[test]
    fn audit_day_names_follow_the_utc_calendar() {
        assert_eq!(utc_day_name(0), "1970-01-01");
        assert_eq!(utc_day_name(8_639_999), "1970-01-01");
        assert_eq!(utc_day_name(86_400_000), "1970-01-02");
        assert_eq!(utc_day_name(1_700_000_000_000), "2023-11-14");
        assert_eq!(utc_day_name(1_709_164_800_000), "2024-02-29");
        assert_eq!(utc_day_name(1_735_689_599_000), "2024-12-31");
        assert!(is_audit_day("2024-02-29"));
        assert!(!is_audit_day("2024-2-29"));
        assert!(!is_audit_day("../../etc/passwd"));
        assert!(!is_audit_day(""));
    }

    #[test]
    fn audit_a_missing_log_reads_as_empty_and_unknown_fields_survive() {
        let temp = tempfile::tempdir().unwrap();
        let catalog = DiskCatalog::open(temp.path().join("catalog")).unwrap();
        fs::remove_dir_all(catalog.root().join("audit")).unwrap();
        let page = catalog.audit_entries(20).unwrap();
        assert!(page.entries.is_empty());
        assert_eq!(page.unreadable, 0);

        // A later build may add a field; an older reader must still show the line.
        plant_audit_lines(
            &catalog,
            "2023-11-14",
            &["{\"at\":1,\"action\":\"theme.put\",\"target\":\"t\",\"actor\":\"a\",\"future\":true}"],
        );
        let page = catalog.audit_entries(20).unwrap();
        assert_eq!(
            page.entries.len(),
            1,
            "an unknown field is not a lost record"
        );
        assert_eq!(page.unreadable, 0);
    }

    #[test]
    fn audit_entries_serialize_with_http_names() {
        let value = serde_json::to_value(AuditEntry {
            at: 7,
            action: "theme.retire".to_string(),
            target: "abc".to_string(),
            actor: "admin:will".to_string(),
            detail: String::new(),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "at": 7,
                "action": "theme.retire",
                "target": "abc",
                "actor": "admin:will",
            })
        );
    }

    /// A line written by hand for one planted day.
    fn planted(day: &str, ordinal: u32) -> String {
        let epoch = utc_day_start_ms(day);
        serde_json::json!({
            "at": epoch + u64::from(ordinal) * 1_000,
            "action": "theme.put",
            "target": format!("{day}-{ordinal}"),
            "actor": "admin:will",
            "detail": " planted",
        })
        .to_string()
    }

    /// Midnight UTC for one test day, counted forward from 1970 so the planted
    /// lines carry the timestamps their day name claims. Checked against
    /// [`utc_day_name`] by `planted_timestamps_land_on_the_day_they_name`.
    fn utc_day_start_ms(day: &str) -> u64 {
        let year: i16 = day[0..4].parse().unwrap();
        let month: u8 = day[5..7].parse().unwrap();
        let date: u8 = day[8..10].parse().unwrap();
        let mut days: i64 = 0;
        for counted in 1970..year {
            // 366 days does not fit a u8, so the year totals as u16.
            days += i64::from(
                (1..=12u8)
                    .map(|month| u16::from(days_in_month(counted, month)))
                    .sum::<u16>(),
            );
        }
        for counted in 1..month {
            days += i64::from(days_in_month(year, counted));
        }
        days += i64::from(date - 1);
        u64::try_from(days).expect("test day after 1970") * 86_400_000
    }

    #[test]
    fn audit_window_keeps_only_the_days_it_names() {
        let (_temp, catalog) = audit_catalog();
        plant_audit_lines(&catalog, "2020-09-13", &[&planted("2020-09-13", 1)]);
        plant_audit_lines(&catalog, "2023-11-14", &[&planted("2023-11-14", 1)]);
        plant_audit_lines(&catalog, "2024-12-31", &[&planted("2024-12-31", 1)]);

        let page = catalog
            .audit_entries_in(
                AuditWindow {
                    from: Some("2023-01-01"),
                    to: Some("2023-12-31"),
                },
                MAX_AUDIT_LIMIT,
            )
            .unwrap();
        assert_eq!(page.entries.len(), 1, "only 2023 is inside the window");
        assert_eq!(page.entries[0].target, "2023-11-14-1");
        assert!(!page.truncated);

        // Both ends are inclusive, so a single-day window reads that day whole.
        let one_day = catalog
            .audit_entries_in(
                AuditWindow {
                    from: Some("2023-11-14"),
                    to: Some("2023-11-14"),
                },
                MAX_AUDIT_LIMIT,
            )
            .unwrap();
        assert_eq!(one_day.entries.len(), 1);

        // An open end means "since" or "up to", never "nothing".
        let since = catalog
            .audit_entries_in(
                AuditWindow {
                    from: Some("2023-01-01"),
                    to: None,
                },
                MAX_AUDIT_LIMIT,
            )
            .unwrap();
        assert_eq!(
            since
                .entries
                .iter()
                .map(|entry| entry.target.as_str())
                .collect::<Vec<_>>(),
            vec!["2024-12-31-1", "2023-11-14-1"],
            "newest first inside the window"
        );
        let up_to = catalog
            .audit_entries_in(
                AuditWindow {
                    from: None,
                    to: Some("2023-12-31"),
                },
                MAX_AUDIT_LIMIT,
            )
            .unwrap();
        assert_eq!(
            up_to
                .entries
                .iter()
                .map(|entry| entry.target.as_str())
                .collect::<Vec<_>>(),
            vec!["2023-11-14-1", "2020-09-13-1"]
        );

        // A window nobody has written in reads as empty, not as an error, and a
        // limit still spends itself inside the window only.
        let empty = catalog
            .audit_entries_in(
                AuditWindow {
                    from: Some("2015-01-01"),
                    to: Some("2016-01-01"),
                },
                10,
            )
            .unwrap();
        assert_eq!(empty.entries.len(), 0);
        assert!(!empty.truncated, "an empty window has nothing left to say");
        let bounded = catalog
            .audit_entries_in(
                AuditWindow {
                    from: Some("2020-01-01"),
                    to: Some("2024-12-31"),
                },
                2,
            )
            .unwrap();
        assert_eq!(bounded.entries.len(), 2);
        assert!(bounded.truncated, "2020 is inside the window and unread");
    }

    #[test]
    fn audit_window_refuses_names_that_are_not_days() {
        let (_temp, catalog) = audit_catalog();
        record(&catalog, audit_action::THEME_PUT, "abc", "admin:will", "");

        for rejected in [
            "2026-02-30",          // February has no 30th
            "2023-02-29",          // not a leap year
            "2100-02-29",          // century years need /400
            "2026-13-01",          // no such month
            "2026-00-10",
            "2026-04-31",          // April has 30
            "2026-2-1",            // not zero-padded
            "",
            "2026-1-1",
            "20260101",
            "../../etc/passwd",
            "2026-01-01 ",
            "x026-01-01",
        ] {
            for name in ["from", "to"] {
                let window = match name {
                    "from" => AuditWindow {
                        from: Some(rejected),
                        to: None,
                    },
                    _ => AuditWindow {
                        from: None,
                        to: Some(rejected),
                    },
                };
                let error = catalog.audit_entries_in(window, 10).unwrap_err();
                let message = error.to_string();
                assert!(
                    message.contains(name) && message.contains(rejected),
                    "{name}={rejected:?} refused with {message}"
                );
            }
        }

        // A bound that exists but leaves nothing behind it is a mistake, not a
        // question, and an empty answer would read as "nothing happened".
        let error = catalog
            .audit_entries_in(
                AuditWindow {
                    from: Some("2026-06-01"),
                    to: Some("2026-05-01"),
                },
                10,
            )
            .unwrap_err();
        assert!(
            error.to_string().contains("2026-06-01"),
            "inverted window: {error}"
        );

        for accepted in [
            "2024-02-29", // leap
            "2000-02-29", // century divisible by 400
            "1970-01-01",
            "2026-12-31",
            "2026-01-01",
        ] {
            assert!(is_audit_calendar_day(accepted), "{accepted} rejected");
            let page = catalog
                .audit_entries_in(
                    AuditWindow {
                        from: None,
                        to: Some(accepted),
                    },
                    10,
                )
                .unwrap();
            assert!(page.entries.len() <= 1, "{accepted} read odd");
        }
    }

    #[test]
    fn truncation_only_says_what_is_really_left_behind() {
        let (_temp, catalog) = audit_catalog();
        let busy = [
            planted("2024-05-06", 1),
            planted("2024-05-06", 2),
            planted("2024-05-06", 3),
        ];
        plant_audit_lines(
            &catalog,
            "2024-05-06",
            &busy.iter().map(String::as_str).collect::<Vec<_>>(),
        );

        // The page fills exactly with the newest day and nothing older exists.
        let exact = catalog.audit_entries_in(AuditWindow::default(), 3).unwrap();
        assert_eq!(exact.entries.len(), 3);
        assert!(!exact.truncated, "no unread day follows this page");

        // One line fewer does leave unread lines in the same file.
        let short = catalog.audit_entries_in(AuditWindow::default(), 2).unwrap();
        assert!(short.truncated);

        // A full page that ends on a day boundary is only truncated when an
        // older day still holds lines: an empty one must not claim otherwise.
        plant_audit_lines(&catalog, "2024-05-05", &[]);
        let boundary = catalog.audit_entries_in(AuditWindow::default(), 3).unwrap();
        assert_eq!(boundary.entries.len(), 3);
        assert!(
            !boundary.truncated,
            "the older day is empty, nothing was left behind"
        );

        // Now it genuinely is.
        plant_audit_lines(&catalog, "2024-05-04", &[&planted("2024-05-04", 1)]);
        let older = catalog.audit_entries_in(AuditWindow::default(), 3).unwrap();
        assert!(older.truncated);
        let all = catalog.audit_entries_in(AuditWindow::default(), 4).unwrap();
        assert!(!all.truncated, "the whole trail was read");
        assert_eq!(all.entries.len(), 4);
    }

    /// The planted lines above claim a timestamp inside the day their file is
    /// named for, so keep that claim checked: a helper that drifted would make
    /// the window tests pass against data no real day file could contain.
    #[test]
    fn planted_timestamps_land_on_the_day_they_name() {
        for day in [
            "1970-01-01",
            "2000-02-29",
            "2020-09-13",
            "2023-11-14",
            "2024-02-29",
            "2024-05-06",
            "2024-12-31",
            "2026-12-31",
        ] {
            assert_eq!(utc_day_name(utc_day_start_ms(day)), day);
            assert_eq!(utc_day_name(utc_day_start_ms(day) + 86_399_999), day);
        }
    }
}
