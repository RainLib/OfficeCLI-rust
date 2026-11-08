//! Integrity checking for committed oracle PDFs.
//!
//! Schema 6 binds each fixture and any standards-derived reference source to the
//! browser-produced PDF, renderer, pinned UA stylesheet, exact declared
//! oracle-semantic relations, and provenance. PNGs are deliberately
//! absent: both oracle and candidate PDFs are rasterized by the same runtime
//! Poppler executable.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::manifest::{OracleSemantics, ReferenceAssessment, reject_symlink_components};
use super::report::{FixtureResult, StaleRef};
use super::util::sha256_hex;

const SCHEMA_VERSION: u32 = 6;

#[derive(Deserialize)]
struct OracleLock {
    schema: u32,
    fixtures: BTreeMap<String, LockedFixture>,
    provenance: BTreeMap<String, Provenance>,
}

#[derive(Deserialize)]
struct LockedFixture {
    category: String,
    file: String,
    manifest_sha256: String,
    html_sha256: String,
    #[serde(default)]
    reference_file: String,
    #[serde(default)]
    reference_html_sha256: String,
    oracle: String,
    pdf: Option<LockedArtifact>,
    provenance: String,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
struct LockedArtifact {
    file: String,
    sha256: String,
}

#[derive(Deserialize, Serialize)]
struct Provenance {
    generator: String,
    generator_sha256: String,
    oracle: String,
    renderer: String,
    renderer_version: String,
    font_bundle_sha256: String,
    #[serde(default)]
    ua_stylesheet_sha256: String,
    pagedjs: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    font_backend: Option<FontBackendProvenance>,
}

#[derive(Deserialize, Serialize)]
struct FontBackendProvenance {
    name: String,
    features: Vec<String>,
    launcher: LockedArtifact,
}

#[derive(Deserialize, Serialize)]
struct ManifestLockInput {
    id: String,
    category: String,
    feature: String,
    #[serde(default)]
    subfeature: String,
    #[serde(default)]
    description: String,
    file: String,
    #[serde(default)]
    interaction_of: Vec<String>,
    #[serde(default)]
    base_ids: Vec<String>,
    #[serde(default = "default_true")]
    sanitize: bool,
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default)]
    depends_on: Vec<String>,
    #[serde(default = "default_expected_support")]
    expected_support: String,
    #[serde(default = "default_oracle")]
    oracle: String,
    #[serde(default)]
    reference_file: Option<String>,
    #[serde(default)]
    reference: ReferenceAssessment,
    #[serde(default)]
    oracle_semantics: OracleSemantics,
}

fn default_true() -> bool {
    true
}

fn default_kind() -> String {
    "feature".to_string()
}

fn default_expected_support() -> String {
    "implemented".to_string()
}

fn default_oracle() -> String {
    "chrome".to_string()
}

fn manifest_identity(entry: &ManifestLockInput) -> Option<String> {
    // Keep the byte identity of pre-review manifests stable. A disputed
    // reference is an authenticated, material review state; a default verified
    // state is intentionally absent from the historical identity.
    let bytes = if entry.reference.is_disputed() {
        serde_json::to_vec(&(
            &entry.id,
            &entry.category,
            &entry.feature,
            &entry.subfeature,
            &entry.description,
            &entry.file,
            &entry.reference_file,
            &entry.interaction_of,
            &entry.base_ids,
            entry.sanitize,
            &entry.kind,
            &entry.depends_on,
            &entry.expected_support,
            &entry.oracle,
            &entry.reference,
            &entry.oracle_semantics,
        ))
    } else {
        serde_json::to_vec(&(
            &entry.id,
            &entry.category,
            &entry.feature,
            &entry.subfeature,
            &entry.description,
            &entry.file,
            &entry.reference_file,
            &entry.interaction_of,
            &entry.base_ids,
            entry.sanitize,
            &entry.kind,
            &entry.depends_on,
            &entry.expected_support,
            &entry.oracle,
            &entry.oracle_semantics,
        ))
    }
    .ok()?;
    Some(sha256_hex(&bytes))
}

pub(crate) fn check_refs_freshness(
    repository_root: &Path,
    parity_dir: &Path,
    results: &[FixtureResult],
) -> (Vec<StaleRef>, bool) {
    let lock = match std::fs::read_to_string(parity_dir.join("refs.lock"))
        .ok()
        .and_then(|text| serde_json::from_str::<OracleLock>(&text).ok())
    {
        Some(lock) if lock.schema == SCHEMA_VERSION => lock,
        _ => return (Vec::new(), false),
    };
    let manifest = match read_manifest_inputs(repository_root, parity_dir) {
        Ok(manifest) => manifest,
        Err(_) => return (Vec::new(), false),
    };

    let mut stale = Vec::new();
    let mut invalid_provenance_reported = BTreeSet::new();
    let current_font_bundle_sha256 = current_font_bundle_sha256(parity_dir);
    let current_ua_stylesheet_sha256 = current_ua_stylesheet_sha256(repository_root, parity_dir);
    for result in results {
        if result.html_sha256.is_empty() {
            continue;
        }
        let Some(current) = manifest.get(&result.id) else {
            stale.push(stale_ref(
                result,
                "absent-from-manifest",
                &result.html_sha256,
                "",
            ));
            continue;
        };
        let Some(locked) = lock.fixtures.get(&result.id) else {
            stale.push(stale_ref(
                result,
                "absent-from-lock",
                &result.html_sha256,
                "",
            ));
            continue;
        };

        if locked.category != current.category || locked.category != result.category {
            stale.push(stale_ref(
                result,
                "category-mismatch",
                &result.category,
                &locked.category,
            ));
            continue;
        }
        if locked.file != current.file {
            stale.push(stale_ref(
                result,
                "fixture-path-mismatch",
                &current.file,
                &locked.file,
            ));
            continue;
        }
        let Some(current_manifest_sha) = manifest_identity(current) else {
            return (Vec::new(), false);
        };
        if locked.manifest_sha256 != current_manifest_sha {
            stale.push(stale_ref(
                result,
                "manifest-metadata-mismatch",
                &current_manifest_sha,
                &locked.manifest_sha256,
            ));
            continue;
        }
        if locked.html_sha256 != result.html_sha256 {
            stale.push(stale_ref(
                result,
                "fixture-hash-mismatch",
                &result.html_sha256,
                &locked.html_sha256,
            ));
            continue;
        }
        let reference_file = current.reference_file.as_deref().unwrap_or(&current.file);
        if locked.reference_file != reference_file {
            stale.push(stale_ref(
                result,
                "reference-source-path-mismatch",
                reference_file,
                &locked.reference_file,
            ));
            continue;
        }
        let reference_html_sha256 =
            match reference_source_sha256(repository_root, parity_dir, reference_file) {
                Ok(sha256) => sha256,
                Err(reason) => {
                    stale.push(stale_ref(result, &reason, "", ""));
                    continue;
                }
            };
        if locked.reference_html_sha256 != reference_html_sha256 {
            stale.push(stale_ref(
                result,
                "reference-source-hash-mismatch",
                &reference_html_sha256,
                &locked.reference_html_sha256,
            ));
            continue;
        }
        if locked.oracle != current.oracle || locked.oracle != result.oracle {
            stale.push(stale_ref(
                result,
                "oracle-mismatch",
                &result.oracle,
                &locked.oracle,
            ));
            continue;
        }

        let expected_artifact = match current_oracle_artifact(
            repository_root,
            parity_dir,
            &result.category,
            &result.id,
            &result.oracle,
        ) {
            Ok(artifact) => artifact,
            Err(reason) => {
                stale.push(stale_ref(result, &reason, "", ""));
                continue;
            }
        };
        if locked.pdf != expected_artifact {
            let reason = match (&expected_artifact, &locked.pdf) {
                (None, Some(_)) => "unexpected-oracle-pdf",
                (Some(_), None) => "missing-oracle-pdf",
                (Some(current), Some(locked)) if current.file == locked.file => {
                    "oracle-pdf-hash-mismatch"
                }
                _ => "oracle-pdf-path-mismatch",
            };
            stale.push(stale_ref(
                result,
                reason,
                expected_artifact
                    .as_ref()
                    .map(|artifact| artifact.sha256.as_str())
                    .unwrap_or(""),
                locked
                    .pdf
                    .as_ref()
                    .map(|artifact| artifact.sha256.as_str())
                    .unwrap_or(""),
            ));
            continue;
        }

        let Some(provenance) = lock.provenance.get(&locked.provenance) else {
            stale.push(stale_ref(
                result,
                "missing-provenance",
                "",
                &locked.provenance,
            ));
            continue;
        };
        if !valid_provenance(
            &locked.provenance,
            provenance,
            &locked.oracle,
            repository_root,
            current_font_bundle_sha256.as_deref(),
            current_ua_stylesheet_sha256.as_deref(),
        ) && invalid_provenance_reported.insert(locked.provenance.clone())
        {
            stale.push(stale_ref(
                result,
                "invalid-provenance",
                "",
                &locked.provenance,
            ));
        }
    }

    let result_ids: BTreeSet<&str> = results.iter().map(|result| result.id.as_str()).collect();
    for (id, locked) in &lock.fixtures {
        if !manifest.contains_key(id.as_str()) && !result_ids.contains(id.as_str()) {
            stale.push(StaleRef {
                id: id.clone(),
                category: locked.category.clone(),
                reason: "removed-fixture-in-lock".to_string(),
                current_sha256: String::new(),
                locked_sha256: locked.html_sha256.clone(),
            });
        }
    }

    let claimed_oracles: BTreeSet<String> = lock
        .fixtures
        .iter()
        .filter_map(|(id, locked)| {
            let current = manifest.get(id)?;
            let expected = format!("oracles/{}/{id}.pdf", current.category);
            (locked.category == current.category
                && locked.file == current.file
                && locked.oracle == current.oracle
                && locked
                    .pdf
                    .as_ref()
                    .is_some_and(|artifact| artifact.file == expected))
            .then_some(expected)
        })
        .collect();
    let mut oracle_pdfs = Vec::new();
    if collect_oracle_pdfs(
        repository_root,
        &parity_dir.join("oracles"),
        parity_dir,
        &mut oracle_pdfs,
    )
    .is_err()
    {
        return (stale, false);
    }
    for relative in oracle_pdfs {
        if claimed_oracles.contains(&relative) {
            continue;
        }
        let category = Path::new(&relative)
            .strip_prefix("oracles")
            .ok()
            .and_then(Path::parent)
            .map(|parent| parent.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let current_sha256 = std::fs::read(parity_dir.join(&relative))
            .map(|bytes| sha256_hex(&bytes))
            .unwrap_or_default();
        stale.push(StaleRef {
            id: relative,
            category,
            reason: "orphan-oracle".to_string(),
            current_sha256,
            locked_sha256: String::new(),
        });
    }

    stale.sort_by(|left, right| {
        (left.category.as_str(), left.id.as_str())
            .cmp(&(right.category.as_str(), right.id.as_str()))
    });
    (stale, true)
}

fn collect_oracle_pdfs(
    repository_root: &Path,
    directory: &Path,
    parity_dir: &Path,
    paths: &mut Vec<String>,
) -> Result<(), String> {
    reject_symlink_components(repository_root, directory)?;
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let path = entry.path();
        if file_type.is_symlink() {
            return Err(format!(
                "oracle tree contains symlink component {}",
                path.display()
            ));
        }
        if file_type.is_dir() {
            collect_oracle_pdfs(repository_root, &path, parity_dir, paths)?;
        } else if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
        {
            paths.push(
                path.strip_prefix(parity_dir)
                    .map_err(|error| error.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
    Ok(())
}

fn read_manifest_inputs(
    repository_root: &Path,
    parity_dir: &Path,
) -> Result<BTreeMap<String, ManifestLockInput>, String> {
    let manifest_dir = parity_dir.join("manifest");
    let mut paths = Vec::new();
    collect_manifest_inputs(repository_root, &manifest_dir, &mut paths)?;
    paths.sort();

    let mut entries = BTreeMap::new();
    for path in paths {
        let text = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let fragment: Vec<ManifestLockInput> =
            serde_json::from_str(&text).map_err(|error| error.to_string())?;
        for entry in fragment {
            if entries.insert(entry.id.clone(), entry).is_some() {
                return Err("duplicate manifest id".to_string());
            }
        }
    }
    Ok(entries)
}

fn collect_manifest_inputs(
    repository_root: &Path,
    directory: &Path,
    paths: &mut Vec<PathBuf>,
) -> Result<(), String> {
    reject_symlink_components(repository_root, directory)?;
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            return Err(format!(
                "manifest tree contains symlink component {}",
                path.display()
            ));
        }
        if file_type.is_dir() {
            collect_manifest_inputs(repository_root, &path, paths)?;
        } else if file_type.is_file()
            && path.extension().and_then(|extension| extension.to_str()) == Some("json")
        {
            paths.push(path);
        }
    }
    Ok(())
}

fn current_oracle_artifact(
    repository_root: &Path,
    parity_dir: &Path,
    category: &str,
    id: &str,
    oracle: &str,
) -> Result<Option<LockedArtifact>, String> {
    let relative = format!("oracles/{category}/{id}.pdf");
    let path = parity_dir.join(&relative);
    reject_symlink_components(repository_root, &path)?;
    if oracle == "none" {
        return if path.exists() {
            Err("unexpected-oracle-pdf".to_string())
        } else {
            Ok(None)
        };
    }
    let bytes = std::fs::read(path).map_err(|_| "missing-oracle-pdf".to_string())?;
    Ok(Some(LockedArtifact {
        file: relative,
        sha256: sha256_hex(&bytes),
    }))
}

fn reference_source_sha256(
    repository_root: &Path,
    parity_dir: &Path,
    reference_file: &str,
) -> Result<String, String> {
    let path = parity_dir.join(reference_file);
    reject_symlink_components(repository_root, &path)?;
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("cannot read reference source {}: {error}", path.display()))?;
    Ok(sha256_hex(&bytes))
}

fn valid_provenance(
    provenance_id: &str,
    provenance: &Provenance,
    oracle: &str,
    repository_root: &Path,
    current_font_bundle_sha256: Option<&str>,
    current_ua_stylesheet_sha256: Option<&str>,
) -> bool {
    let renderer_matches = match oracle {
        "chrome" => matches!(
            provenance.renderer.as_str(),
            "chromium" | "chromium+pagedjs"
        ),
        "weasyprint" => provenance.renderer == "weasyprint",
        "none" => provenance.renderer == "none",
        _ => false,
    };
    renderer_matches
        && provenance.oracle == oracle
        && provenance.generator == "scripts/parity-gen-refs.sh"
        && !provenance.renderer_version.is_empty()
        && provenance_identity(provenance).is_some_and(|identity| provenance_id == identity)
        && generator_source_is_authenticated(
            repository_root,
            &provenance.generator,
            &provenance.generator_sha256,
        )
        && font_backend_is_authenticated(repository_root, provenance)
        && current_font_bundle_sha256.is_some_and(|current| {
            is_sha256(&provenance.font_bundle_sha256) && provenance.font_bundle_sha256 == current
        })
        && current_ua_stylesheet_sha256.is_some_and(|current| {
            is_sha256(&provenance.ua_stylesheet_sha256)
                && provenance.ua_stylesheet_sha256 == current
        })
}

fn font_backend_is_authenticated(repository_root: &Path, provenance: &Provenance) -> bool {
    if provenance.oracle != "chrome" {
        return provenance.font_backend.is_none();
    }
    let Some(backend) = &provenance.font_backend else {
        return historical_generator_is_archived(
            repository_root,
            &provenance.generator,
            &provenance.generator_sha256,
        );
    };
    backend.name == "fontations"
        && backend.features == ["FontationsFontBackend", "FontationsLinuxSystemFonts"]
        && backend.launcher.file == "scripts/chromium-fontations.sh"
        && authenticated_font_backend_launcher(repository_root, &backend.launcher)
}

fn historical_generator_is_archived(
    repository_root: &Path,
    generator: &str,
    expected_sha256: &str,
) -> bool {
    let live = repository_root.join(generator);
    let archived = archived_generator_path(repository_root, expected_sha256);
    source_matches(repository_root, &archived, expected_sha256)
        && !source_matches(repository_root, &live, expected_sha256)
}

fn authenticated_font_backend_launcher(repository_root: &Path, launcher: &LockedArtifact) -> bool {
    if !is_sha256(&launcher.sha256) {
        return false;
    }
    let archived = repository_root
        .join("scripts/parity-generators/fontations/sha256")
        .join(&launcher.sha256)
        .join("chromium-fontations.sh");
    [repository_root.join(&launcher.file), archived]
        .into_iter()
        .any(|path| source_matches(repository_root, &path, &launcher.sha256))
}

fn current_ua_stylesheet_sha256(repository_root: &Path, parity_dir: &Path) -> Option<String> {
    let path = parity_dir.join("ua-pins.css");
    reject_symlink_components(repository_root, &path).ok()?;
    let bytes = std::fs::read(path).ok()?;
    (!bytes.iter().all(u8::is_ascii_whitespace)).then(|| sha256_hex(&bytes))
}

fn generator_source_is_authenticated(
    repository_root: &Path,
    generator: &str,
    expected_sha256: &str,
) -> bool {
    if generator != "scripts/parity-gen-refs.sh" || !is_sha256(expected_sha256) {
        return false;
    }
    let archived = archived_generator_path(repository_root, expected_sha256);
    [repository_root.join(generator), archived]
        .into_iter()
        .any(|path| source_matches(repository_root, &path, expected_sha256))
}

fn source_matches(repository_root: &Path, path: &Path, expected_sha256: &str) -> bool {
    reject_symlink_components(repository_root, path).is_ok()
        && std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
        && std::fs::read(path).is_ok_and(|bytes| sha256_hex(&bytes) == expected_sha256)
}

fn archived_generator_path(repository_root: &Path, sha256: &str) -> PathBuf {
    repository_root
        .join("scripts/parity-generators/sha256")
        .join(sha256)
        .join("parity-gen-refs.sh")
}

fn current_generator_sha256(parity_dir: &Path) -> Option<String> {
    let root = parity_dir.parent()?.parent()?;
    let bytes = std::fs::read(root.join("scripts/parity-gen-refs.sh")).ok()?;
    Some(sha256_hex(&bytes))
}

fn current_font_bundle_sha256(parity_dir: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};

    let fonts = parity_dir.join("fonts");
    let mut paths = Vec::new();
    let config = fonts.join("fonts.conf");
    if config.is_file() {
        paths.push(config);
    }
    let mut faces = Vec::new();
    for entry in std::fs::read_dir(&fonts).ok()? {
        let path = entry.ok()?.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("Parity") && name.ends_with(".ttf"))
        {
            faces.push(path);
        }
    }
    faces.sort();
    paths.extend(faces);

    let mut hasher = Sha256::new();
    for path in paths {
        let relative = path.strip_prefix(&fonts).ok()?.to_string_lossy();
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(std::fs::read(path).ok()?);
        hasher.update([0]);
    }
    for (label, path) in [
        (
            "generic-sans",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        ),
        (
            "generic-serif",
            "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
        ),
        (
            "generic-monospace",
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        ),
        (
            "cjk-sans",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        ),
    ] {
        let path = Path::new(path);
        // The generator fails closed when these Linux oracle inputs are absent.
        // A non-Linux unit-test host may omit them; its digest then cannot match
        // a committed Linux oracle lock, which also fails freshness closed.
        if !path.is_file() {
            continue;
        }
        hasher.update(label.as_bytes());
        hasher.update([0]);
        hasher.update(std::fs::read(path).ok()?);
        hasher.update([0]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

fn provenance_identity(provenance: &Provenance) -> Option<String> {
    let value = serde_json::to_value(provenance).ok()?;
    let canonical = serde_json::to_vec(&value).ok()?;
    Some(sha256_hex(&canonical))
}

fn stale_ref(result: &FixtureResult, reason: &str, current: &str, locked: &str) -> StaleRef {
    StaleRef {
        id: result.id.clone(),
        category: result.category.clone(),
        reason: reason.to_string(),
        current_sha256: current.to_string(),
        locked_sha256: locked.to_string(),
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use serde_json::json;

    use super::*;
    use crate::parity_support::report::Status;

    static NEXT_TMP: AtomicU64 = AtomicU64::new(0);

    struct TestDir {
        root: PathBuf,
        parity: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let number = NEXT_TMP.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "ironpress-oracle-lock-{}-{number}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&root);
            let parity = root.join("tests/parity");
            for directory in [
                parity.join("manifest"),
                parity.join("cases/test"),
                parity.join("oracles/test"),
                parity.join("fonts"),
                root.join("scripts"),
            ] {
                std::fs::create_dir_all(directory).unwrap();
            }
            std::fs::write(root.join("scripts/parity-gen-refs.sh"), b"test generator").unwrap();
            std::fs::write(
                root.join("scripts/chromium-fontations.sh"),
                b"test Fontations launcher",
            )
            .unwrap();
            std::fs::write(parity.join("ua-pins.css"), b":where(body){margin:0}").unwrap();
            std::fs::write(parity.join("cases/test/example.html"), b"<p>example</p>").unwrap();
            std::fs::write(
                parity.join("manifest/test.json"),
                serde_json::to_vec(&json!([{
                    "id": "example",
                    "category": "test",
                    "feature": "test",
                    "file": "cases/test/example.html",
                    "oracle": "chrome"
                }]))
                .unwrap(),
            )
            .unwrap();
            Self { root, parity }
        }

        fn result(&self) -> FixtureResult {
            FixtureResult {
                id: "example".to_string(),
                category: "test".to_string(),
                feature: "test".to_string(),
                subfeature: String::new(),
                interaction_of: Vec::new(),
                base_ids: Vec::new(),
                oracle: "chrome".to_string(),
                reference: Default::default(),
                html_sha256: sha256_hex(b"<p>example</p>"),
                raster: Default::default(),
                status: Status::Pass,
                diff_pct: 0.0,
                semantic_diff_pct: 0.0,
                description: String::new(),
                note: String::new(),
                kind: "feature".to_string(),
                depends_on: Vec::new(),
                expected_support: "implemented".to_string(),
                dependency_context: String::new(),
                diagnosis: None,
            }
        }

        fn write_lock(&self, pdf: &[u8]) {
            std::fs::write(self.parity.join("oracles/test/example.pdf"), pdf).unwrap();
            let provenance = Provenance {
                generator: "scripts/parity-gen-refs.sh".to_string(),
                generator_sha256: current_generator_sha256(&self.parity).unwrap(),
                oracle: "chrome".to_string(),
                renderer: "chromium".to_string(),
                renderer_version: "test Chromium".to_string(),
                font_bundle_sha256: current_font_bundle_sha256(&self.parity).unwrap(),
                ua_stylesheet_sha256: current_ua_stylesheet_sha256(&self.root, &self.parity)
                    .unwrap(),
                pagedjs: false,
                font_backend: Some(FontBackendProvenance {
                    name: "fontations".to_string(),
                    features: vec![
                        "FontationsFontBackend".to_string(),
                        "FontationsLinuxSystemFonts".to_string(),
                    ],
                    launcher: LockedArtifact {
                        file: "scripts/chromium-fontations.sh".to_string(),
                        sha256: sha256_hex(b"test Fontations launcher"),
                    },
                }),
            };
            let identity = provenance_identity(&provenance).expect("serializable provenance");
            let manifests = read_manifest_inputs(&self.root, &self.parity).unwrap();
            let manifest = manifests.get("example").unwrap();
            let manifest_sha = manifest_identity(manifest).expect("serializable manifest");
            let reference_file = manifest.reference_file.as_deref().unwrap_or(&manifest.file);
            let reference_html_sha256 =
                sha256_hex(&std::fs::read(self.parity.join(reference_file)).unwrap());
            let lock = json!({
                "schema": 6,
                "fixtures": {
                    "example": {
                        "category": "test",
                        "file": "cases/test/example.html",
                        "manifest_sha256": manifest_sha,
                        "html_sha256": sha256_hex(b"<p>example</p>"),
                        "reference_file": reference_file,
                        "reference_html_sha256": reference_html_sha256,
                        "oracle": "chrome",
                        "pdf": {
                            "file": "oracles/test/example.pdf",
                            "sha256": sha256_hex(pdf)
                        },
                        "provenance": identity
                    }
                },
                "provenance": { (identity.clone()): provenance }
            });
            std::fs::write(
                self.parity.join("refs.lock"),
                serde_json::to_vec_pretty(&lock).unwrap(),
            )
            .unwrap();
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn authenticates_fixture_oracle_and_pdf_bytes() {
        let directory = TestDir::new();
        directory.write_lock(b"%PDF oracle");
        let (stale, present) =
            check_refs_freshness(&directory.root, &directory.parity, &[directory.result()]);
        assert!(present);
        assert!(stale.is_empty());
    }

    #[test]
    fn current_chromium_provenance_requires_the_fontations_backend() {
        let directory = TestDir::new();
        directory.write_lock(b"%PDF oracle");
        let lock_path = directory.parity.join("refs.lock");
        let mut lock: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&lock_path).unwrap()).unwrap();
        let old_identity = lock["fixtures"]["example"]["provenance"]
            .as_str()
            .unwrap()
            .to_string();
        let mut record = lock["provenance"][&old_identity].clone();
        record.as_object_mut().unwrap().remove("font_backend");
        let provenance: Provenance = serde_json::from_value(record).unwrap();
        let identity = provenance_identity(&provenance).unwrap();
        lock["fixtures"]["example"]["provenance"] = json!(identity);
        lock["provenance"] = json!({ (identity): provenance });
        std::fs::write(lock_path, serde_json::to_vec_pretty(&lock).unwrap()).unwrap();

        let (stale, present) =
            check_refs_freshness(&directory.root, &directory.parity, &[directory.result()]);
        assert!(present);
        assert!(
            stale
                .iter()
                .any(|entry| entry.reason == "invalid-provenance")
        );
    }

    #[test]
    fn fontations_launcher_bytes_are_authenticated() {
        let directory = TestDir::new();
        directory.write_lock(b"%PDF oracle");
        std::fs::write(
            directory.root.join("scripts/chromium-fontations.sh"),
            b"tampered launcher",
        )
        .unwrap();

        let (stale, present) =
            check_refs_freshness(&directory.root, &directory.parity, &[directory.result()]);
        assert!(present);
        assert!(
            stale
                .iter()
                .any(|entry| entry.reason == "invalid-provenance")
        );
    }

    #[test]
    fn authenticates_fixture_from_nested_manifest_directory() {
        let directory = TestDir::new();
        let generated = directory.parity.join("manifest/generated");
        std::fs::create_dir_all(&generated).unwrap();
        std::fs::rename(
            directory.parity.join("manifest/test.json"),
            generated.join("test.json"),
        )
        .unwrap();
        directory.write_lock(b"%PDF oracle");

        let (stale, present) =
            check_refs_freshness(&directory.root, &directory.parity, &[directory.result()]);
        assert!(present);
        assert!(stale.is_empty());
    }

    #[test]
    fn authenticates_a_standards_derived_reference_source() {
        let directory = TestDir::new();
        let reference = directory.parity.join("references/test/example.html");
        std::fs::create_dir_all(reference.parent().unwrap()).unwrap();
        std::fs::write(&reference, b"<p>derived reference</p>").unwrap();
        std::fs::write(
            directory.parity.join("manifest/test.json"),
            serde_json::to_vec(&json!([{
                "id": "example",
                "category": "test",
                "feature": "test",
                "file": "cases/test/example.html",
                "reference_file": "references/test/example.html",
                "oracle": "chrome"
            }]))
            .unwrap(),
        )
        .unwrap();
        directory.write_lock(b"%PDF oracle");

        let (stale, present) =
            check_refs_freshness(&directory.root, &directory.parity, &[directory.result()]);
        assert!(present);
        assert!(stale.is_empty());

        std::fs::write(reference, b"<p>changed derived reference</p>").unwrap();
        let (stale, present) =
            check_refs_freshness(&directory.root, &directory.parity, &[directory.result()]);
        assert!(present);
        assert!(
            stale
                .iter()
                .any(|entry| entry.reason == "reference-source-hash-mismatch")
        );
    }

    #[test]
    fn rejects_every_unclaimed_pdf_in_the_recursive_oracle_corpus() {
        let directory = TestDir::new();
        directory.write_lock(b"%PDF oracle");
        let orphan_paths = [
            "oracles/test/orphan.pdf",
            "oracles/unknown/orphan.pdf",
            "oracles/test/nested/orphan.pdf",
            "oracles/test/example.PDF",
        ];
        for relative in orphan_paths {
            let path = directory.parity.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"%PDF orphan").unwrap();
        }

        let (stale, present) =
            check_refs_freshness(&directory.root, &directory.parity, &[directory.result()]);
        let actual: BTreeSet<_> = stale
            .iter()
            .filter(|entry| entry.reason == "orphan-oracle")
            .map(|entry| entry.id.as_str())
            .collect();
        let expected: BTreeSet<_> = orphan_paths.into_iter().collect();

        assert!(present);
        assert_eq!(actual, expected);
        assert!(
            stale
                .iter()
                .all(|entry| entry.id != "oracles/test/example.pdf")
        );
    }

    #[cfg(unix)]
    #[test]
    fn recursive_oracle_inventory_rejects_symlinked_directories() {
        let directory = TestDir::new();
        directory.write_lock(b"%PDF oracle");
        let external = directory.root.join("external-oracles");
        std::fs::create_dir_all(&external).unwrap();
        std::fs::write(external.join("hidden.pdf"), b"%PDF external").unwrap();
        std::os::unix::fs::symlink(&external, directory.parity.join("oracles/linked")).unwrap();

        let (_, present) =
            check_refs_freshness(&directory.root, &directory.parity, &[directory.result()]);
        assert!(
            !present,
            "a symlinked oracle subtree must invalidate refs.lock"
        );
    }

    #[test]
    fn lock_entry_without_a_manifest_entry_cannot_claim_an_oracle() {
        let directory = TestDir::new();
        directory.write_lock(b"%PDF oracle");
        let relative = "oracles/unknown/rogue.pdf";
        let path = directory.parity.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"%PDF rogue").unwrap();

        let lock_path = directory.parity.join("refs.lock");
        let mut lock: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&lock_path).unwrap()).unwrap();
        let provenance = lock["fixtures"]["example"]["provenance"]
            .as_str()
            .unwrap()
            .to_string();
        lock["fixtures"].as_object_mut().unwrap().insert(
            "rogue".to_string(),
            json!({
                "category": "unknown",
                "file": "cases/unknown/rogue.html",
                "manifest_sha256": "0".repeat(64),
                "html_sha256": "0".repeat(64),
                "reference_file": "cases/unknown/rogue.html",
                "reference_html_sha256": "0".repeat(64),
                "oracle": "chrome",
                "pdf": {
                    "file": relative,
                    "sha256": sha256_hex(b"%PDF rogue")
                },
                "provenance": provenance
            }),
        );
        std::fs::write(lock_path, serde_json::to_vec_pretty(&lock).unwrap()).unwrap();

        let (stale, present) =
            check_refs_freshness(&directory.root, &directory.parity, &[directory.result()]);
        assert!(present);
        assert!(
            stale
                .iter()
                .any(|entry| entry.id == relative && entry.reason == "orphan-oracle")
        );
    }

    #[test]
    fn detects_oracle_pdf_tampering() {
        let directory = TestDir::new();
        directory.write_lock(b"%PDF oracle");
        std::fs::write(
            directory.parity.join("oracles/test/example.pdf"),
            b"%PDF tampered",
        )
        .unwrap();
        let (stale, present) =
            check_refs_freshness(&directory.root, &directory.parity, &[directory.result()]);
        assert!(present);
        assert_eq!(stale[0].reason, "oracle-pdf-hash-mismatch");
    }

    #[test]
    fn detects_pinned_ua_stylesheet_tampering() {
        let directory = TestDir::new();
        directory.write_lock(b"%PDF oracle");
        std::fs::write(
            directory.parity.join("ua-pins.css"),
            b":where(body){margin:8px}",
        )
        .unwrap();

        let (stale, present) =
            check_refs_freshness(&directory.root, &directory.parity, &[directory.result()]);
        assert!(present);
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].reason, "invalid-provenance");
    }

    #[test]
    fn authenticates_declared_oracle_semantics() {
        let directory = TestDir::new();
        directory.write_lock(b"%PDF oracle");

        let manifest_path = directory.parity.join("manifest/test.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest[0]["oracle_semantics"] = json!({
            "must_differ_from": ["peer"]
        });
        std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

        let (stale, present) =
            check_refs_freshness(&directory.root, &directory.parity, &[directory.result()]);
        assert!(present);
        assert_eq!(stale.len(), 1, "{stale:?}");
        assert_eq!(stale[0].reason, "manifest-metadata-mismatch");
    }

    #[test]
    fn detects_generator_tampering() {
        let directory = TestDir::new();
        directory.write_lock(b"%PDF oracle");
        std::fs::write(
            directory.root.join("scripts/parity-gen-refs.sh"),
            b"changed generator",
        )
        .unwrap();
        let (stale, present) =
            check_refs_freshness(&directory.root, &directory.parity, &[directory.result()]);
        assert!(present);
        assert_eq!(stale[0].reason, "invalid-provenance");
    }

    #[test]
    fn authenticates_a_content_addressed_historical_generator() {
        let directory = TestDir::new();
        directory.write_lock(b"%PDF oracle");
        let generator = directory.root.join("scripts/parity-gen-refs.sh");
        let bytes = std::fs::read(&generator).unwrap();
        let sha256 = sha256_hex(&bytes);
        let archived = archived_generator_path(&directory.root, &sha256);
        std::fs::create_dir_all(archived.parent().unwrap()).unwrap();
        std::fs::write(&archived, bytes).unwrap();
        std::fs::write(generator, b"changed live generator").unwrap();

        let (stale, present) =
            check_refs_freshness(&directory.root, &directory.parity, &[directory.result()]);
        assert!(present);
        assert!(stale.is_empty(), "{stale:?}");
    }

    #[test]
    fn historical_generator_archive_rejects_a_wrong_digest_path_or_content() {
        for wrong_path in [true, false] {
            let directory = TestDir::new();
            directory.write_lock(b"%PDF oracle");
            let generator = directory.root.join("scripts/parity-gen-refs.sh");
            let bytes = std::fs::read(&generator).unwrap();
            let sha256 = sha256_hex(&bytes);
            let archive_sha256 = if wrong_path {
                "0".repeat(64)
            } else {
                sha256.clone()
            };
            let archived = archived_generator_path(&directory.root, &archive_sha256);
            std::fs::create_dir_all(archived.parent().unwrap()).unwrap();
            std::fs::write(
                archived,
                if wrong_path {
                    bytes.as_slice()
                } else {
                    b"wrong archived bytes"
                },
            )
            .unwrap();
            std::fs::write(generator, b"changed live generator").unwrap();

            let (stale, present) =
                check_refs_freshness(&directory.root, &directory.parity, &[directory.result()]);
            assert!(present);
            assert_eq!(stale.len(), 1, "wrong_path={wrong_path}: {stale:?}");
            assert_eq!(stale[0].reason, "invalid-provenance");
        }
    }

    #[cfg(unix)]
    #[test]
    fn historical_generator_archive_rejects_symlinks() {
        let directory = TestDir::new();
        directory.write_lock(b"%PDF oracle");
        let generator = directory.root.join("scripts/parity-gen-refs.sh");
        let bytes = std::fs::read(&generator).unwrap();
        let sha256 = sha256_hex(&bytes);
        let archived = archived_generator_path(&directory.root, &sha256);
        std::fs::create_dir_all(archived.parent().unwrap()).unwrap();
        let external = directory.root.join("external-generator.sh");
        std::fs::write(&external, bytes).unwrap();
        std::os::unix::fs::symlink(external, archived).unwrap();
        std::fs::write(generator, b"changed live generator").unwrap();

        let (stale, present) =
            check_refs_freshness(&directory.root, &directory.parity, &[directory.result()]);
        assert!(present);
        assert_eq!(stale.len(), 1, "{stale:?}");
        assert_eq!(stale[0].reason, "invalid-provenance");
    }

    #[test]
    fn rejects_png_schema_and_legacy_provenance() {
        let directory = TestDir::new();
        for lock in [
            json!({"schema": 2, "fixtures": {}, "provenance": {}}),
            json!({
                "schema": 3,
                "fixtures": {},
                "provenance": {
                    "legacy": {
                        "generator": "scripts/parity-gen-refs.sh",
                        "generator_sha256": null,
                        "oracle": "chrome",
                        "renderer": "legacy-unrecorded",
                        "renderer_version": null,
                        "font_bundle_sha256": null,
                        "pagedjs": null
                    }
                }
            }),
        ] {
            std::fs::write(
                directory.parity.join("refs.lock"),
                serde_json::to_vec(&lock).unwrap(),
            )
            .unwrap();
            let (_, present) =
                check_refs_freshness(&directory.root, &directory.parity, &[directory.result()]);
            assert!(!present);
        }
    }

    #[test]
    fn committed_lock_is_either_current_or_rejected_as_pre_schema6() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let parity = root.join("tests/parity");
        let lock: OracleLock = serde_json::from_slice(
            &std::fs::read(parity.join("refs.lock")).expect("committed refs.lock"),
        )
        .expect("parse committed refs.lock");
        assert!(!lock.fixtures.is_empty());

        let results: Vec<_> = lock
            .fixtures
            .iter()
            .map(|(id, fixture)| FixtureResult {
                id: id.clone(),
                category: fixture.category.clone(),
                feature: "lock-check".to_string(),
                subfeature: String::new(),
                interaction_of: Vec::new(),
                base_ids: Vec::new(),
                status: Status::Pass,
                diff_pct: 0.0,
                semantic_diff_pct: 0.0,
                description: String::new(),
                note: String::new(),
                kind: "feature".to_string(),
                depends_on: Vec::new(),
                expected_support: "implemented".to_string(),
                oracle: fixture.oracle.clone(),
                reference: Default::default(),
                dependency_context: String::new(),
                html_sha256: fixture.html_sha256.clone(),
                raster: Default::default(),
                diagnosis: None,
            })
            .collect();
        let (stale, present) = check_refs_freshness(root, &parity, &results);
        if lock.schema != SCHEMA_VERSION {
            assert!(!present, "pre-schema-6 refs.lock must fail closed");
            return;
        }
        assert!(present);
        assert!(stale.is_empty(), "{stale:?}");
    }
}
