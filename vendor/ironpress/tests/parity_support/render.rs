//! In-process ironpress rendering: bundled-font loading/resolution, the per-
//! fixture PDF render at Chrome-matching geometry, and the PDF validity guard.
//!
//! Extracted verbatim from the former monolithic `mod.rs` (C1 mechanical split).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::util::contains;

/// Immutable deterministic font inputs shared by reference across parallel
/// fixture jobs. Registration aliases point at uniquely owned byte buffers;
/// only the fresh converter receives the owned clones required by its builder.
pub(crate) struct FontBundle {
    faces: Vec<Vec<u8>>,
    registrations: Vec<(&'static str, usize)>,
}

/// Repository-owned author stylesheet that replaces renderer-specific HTML UA
/// choices with one explicit, zero-specificity parity baseline.
pub(crate) struct PinnedUaStylesheet {
    css: String,
}

impl PinnedUaStylesheet {
    pub(crate) fn load(parity_dir: &Path) -> Result<Self, String> {
        let path = parity_dir.join("ua-pins.css");
        let css = std::fs::read_to_string(&path).map_err(|error| {
            format!(
                "cannot read pinned UA stylesheet {}: {error}",
                path.display()
            )
        })?;
        if css.trim().is_empty() {
            return Err(format!("pinned UA stylesheet {} is empty", path.display()));
        }
        Ok(Self { css })
    }

    pub(crate) fn inject(&self, html: &str) -> Result<String, String> {
        let lower = html.to_ascii_lowercase();
        let head_start = lower
            .match_indices("<head")
            .find_map(|(offset, _)| {
                lower
                    .as_bytes()
                    .get(offset + "<head".len())
                    .is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'>')
                    .then_some(offset)
            })
            .ok_or_else(|| "fixture has no <head> for pinned UA stylesheet".to_string())?;
        let head_end = lower[head_start..]
            .find('>')
            .map(|offset| head_start + offset + 1)
            .ok_or_else(|| "fixture has an unterminated <head> tag".to_string())?;

        let mut pinned = String::with_capacity(html.len() + self.css.len() + 64);
        pinned.push_str(&html[..head_end]);
        pinned.push_str("\n<style data-parity-ua-pins>\n");
        pinned.push_str(&self.css);
        pinned.push_str("\n</style>\n");
        pinned.push_str(&html[head_end..]);
        Ok(pinned)
    }
}

pub(crate) fn render_pdf(
    html: &str,
    sanitize: bool,
    fonts: &FontBundle,
    ua_stylesheet: &PinnedUaStylesheet,
    base_path: Option<&std::path::Path>,
    resource_root: Option<&std::path::Path>,
) -> Result<Vec<u8>, String> {
    use ironpress::{HtmlConverter, Margin, PageSize};
    let mut conv = HtmlConverter::new()
        .page_size(PageSize::LETTER)
        .margin(Margin::uniform(28.8))
        .sanitize(sanitize);

    // Resolve a fixture's relative resource URLs (e.g. `@font-face { src:
    // url('../../fonts/ParitySerif.ttf') }`) against the fixture's own directory,
    // exactly as the Chrome oracle PDF producer did when it loaded that font
    // from disk. This is a determinism fix: it gives ironpress the SAME font
    // input used to produce the oracle PDF; it does not alter comparison.
    if let Some(base) = base_path {
        conv = conv.base_path(base);
    }
    if let Some(root) = resource_root {
        conv = conv.resource_root(root);
    }

    // Register the bundled deterministic Parity faces (DejaVu Sans/Serif/Mono
    // renamed) so in-process rendering uses the SAME outlines Chrome uses via
    // FONTCONFIG_FILE in scripts/parity-gen-refs.sh. Registered under the Parity
    // family names AND the CSS generic families so fixtures may use either. The
    // bytes are loaded ONCE (see `load_bundled_fonts`) and shared immutably; this
    // builds a FRESH converter per render so no mutable state is shared across
    // parallel jobs.
    for &(family, face_index) in &fonts.registrations {
        conv = conv.add_font(family, fonts.faces[face_index].clone());
    }

    let html = ua_stylesheet.inject(html)?;
    conv.convert(&html).map_err(|e| e.to_string())
}

/// Load every bundled face's bytes ONCE so the parallel per-fixture renders can
/// share immutable font data instead of re-reading each face from disk per
/// render. Every declared face is part of the authenticated oracle contract, so
/// a missing file aborts the run instead of changing font fallback silently.
pub(crate) fn load_bundled_fonts(root: &std::path::Path) -> Result<FontBundle, String> {
    let mut faces = Vec::new();
    let mut registrations = Vec::new();
    let mut by_path: BTreeMap<PathBuf, usize> = BTreeMap::new();
    for (family, file) in bundled_font_faces(root) {
        let face_index = if let Some(&index) = by_path.get(&file) {
            index
        } else {
            let bytes = std::fs::read(&file)
                .map_err(|error| format!("required parity font {}: {error}", file.display()))?;
            let index = faces.len();
            faces.push(bytes);
            by_path.insert(file, index);
            index
        };
        registrations.push((family, face_index));
    }
    Ok(FontBundle {
        faces,
        registrations,
    })
}

/// (css-family, ttf-path) for every bundled face.
///
/// The snap Chromium oracle resolves CSS generics to these three host faces and
/// explicit `Parity*` names to the installed bundled faces. The oracle lock
/// hashes every file listed here, and the parity runner fails if one is absent,
/// so a host-font change cannot masquerade as a renderer change.
pub(crate) fn bundled_font_faces(root: &std::path::Path) -> Vec<(&'static str, PathBuf)> {
    let lib = PathBuf::from("/usr/share/fonts/truetype/liberation");
    let sans = lib.join("LiberationSans-Regular.ttf");
    let serif = lib.join("LiberationSerif-Regular.ttf");
    let mono = PathBuf::from("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf");
    let parity = root.join("tests").join("parity").join("fonts");
    vec![
        ("sans-serif", sans),
        ("serif", serif),
        ("monospace", mono),
        ("ParitySans", parity.join("ParitySans.ttf")),
        ("ParitySerif", parity.join("ParitySerif.ttf")),
        ("ParityMono", parity.join("ParityMono.ttf")),
    ]
}

pub(crate) fn check_pdf_valid(pdf: &[u8]) -> Result<(), String> {
    if !pdf.starts_with(b"%PDF-1.") {
        return Err("missing %PDF header".into());
    }
    let needles: [&[u8]; 4] = [b"/Catalog", b"/Pages", b"xref", b"%%EOF"];
    for n in needles {
        if !contains(pdf, n) {
            return Err(format!("missing {}", String::from_utf8_lossy(n)));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::PinnedUaStylesheet;

    #[test]
    fn pinned_ua_stylesheet_precedes_fixture_author_styles() {
        let stylesheet = PinnedUaStylesheet {
            css: ":where(body) { margin: 0; }".to_string(),
        };
        let html =
            "<!doctype html><html><head><style>body{margin:8px}</style></head><body></body></html>";

        let pinned = stylesheet.inject(html).unwrap();
        assert!(
            pinned.find("data-parity-ua-pins").unwrap() < pinned.find("body{margin:8px}").unwrap()
        );
    }

    #[test]
    fn pinned_ua_stylesheet_requires_an_explicit_head() {
        let stylesheet = PinnedUaStylesheet {
            css: ":where(body) { margin: 0; }".to_string(),
        };
        let error = stylesheet.inject("<p>implicit document</p>").unwrap_err();
        assert!(error.contains("no <head>"), "{error}");
    }
}
