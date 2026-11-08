//! Manifest schema (`ManifestEntry`), fragment loading + structural validation,
//! and the id != ref-filename mismatch detector.
//!
//! Extracted verbatim from the former monolithic `mod.rs` (C1 mechanical split).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::report::RefMismatch;

/// Reject indirection anywhere below the parity root. Checking only the leaf is
/// insufficient: `cases/category -> /outside` makes the eventual HTML leaf look
/// like a regular file to `symlink_metadata`.
pub(crate) fn symlink_component(root: &Path, path: &Path) -> Result<Option<PathBuf>, String> {
    let relative = path.strip_prefix(root).map_err(|_| {
        format!(
            "parity input {} is outside {}",
            path.display(),
            root.display()
        )
    })?;
    let mut current = root.to_path_buf();
    for component in std::iter::once(None).chain(relative.components().map(Some)) {
        if let Some(component) = component {
            use std::path::Component;
            match component {
                Component::Normal(_) => current.push(component),
                _ => {
                    return Err(format!(
                        "parity input has a non-canonical path component: {}",
                        path.display()
                    ));
                }
            }
        }
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Ok(Some(current));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(format!(
                    "cannot inspect parity input component {}: {error}",
                    current.display()
                ));
            }
        }
    }
    Ok(None)
}

pub(crate) fn reject_symlink_components(root: &Path, path: &Path) -> Result<(), String> {
    if let Some(component) = symlink_component(root, path)? {
        return Err(format!(
            "parity input path contains symlink component {}",
            component.display()
        ));
    }
    Ok(())
}

fn collect_html_cases(
    repository_root: &Path,
    directory: &Path,
    parity_dir: &Path,
    cases: &mut Vec<String>,
) -> Result<(), String> {
    reject_symlink_components(repository_root, directory)?;
    let entries = std::fs::read_dir(directory).map_err(|error| {
        format!(
            "cannot read case directory {}: {error}",
            directory.display()
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "cannot inspect an entry in case directory {}: {error}",
                directory.display()
            )
        })?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("cannot inspect {}: {error}", path.display()))?;
        if file_type.is_symlink() {
            return Err(format!(
                "case tree contains symlink component {}",
                path.display()
            ));
        }
        if file_type.is_dir() {
            collect_html_cases(repository_root, &path, parity_dir, cases)?;
        } else if file_type.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("html"))
        {
            let relative = path
                .strip_prefix(parity_dir)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            cases.push(relative);
        }
    }
    Ok(())
}

fn collect_manifest_fragments(
    repository_root: &Path,
    directory: &Path,
    fragments: &mut Vec<PathBuf>,
) -> Result<(), String> {
    reject_symlink_components(repository_root, directory)?;
    for entry in std::fs::read_dir(directory)
        .map_err(|error| format!("cannot read manifest dir {}: {error}", directory.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("cannot inspect {}: {error}", path.display()))?;
        if file_type.is_symlink() {
            return Err(format!(
                "manifest tree contains symlink component {}",
                path.display()
            ));
        }
        if file_type.is_dir() {
            collect_manifest_fragments(repository_root, &path, fragments)?;
        } else if file_type.is_file()
            && path.extension().and_then(|extension| extension.to_str()) == Some("json")
        {
            fragments.push(path);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Manifest schema
// ---------------------------------------------------------------------------

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub(crate) struct ManifestEntry {
    pub(crate) id: String,
    pub(crate) category: String,
    pub(crate) feature: String,
    #[serde(default)]
    pub(crate) subfeature: String,
    #[serde(default)]
    pub(crate) description: String,
    pub(crate) file: String,
    #[serde(default)]
    pub(crate) interaction_of: Vec<String>,
    #[serde(default)]
    pub(crate) base_ids: Vec<String>,
    #[serde(default = "default_sanitize")]
    pub(crate) sanitize: bool,
    /// Fixture kind: "feature" (default), "interaction", or "probe".
    #[serde(default = "default_kind")]
    pub(crate) kind: String,
    /// Substrate probe / base ids this fixture renders through. Their failures
    /// are reported as related context, never assumed to cause this fixture's diff.
    #[serde(default)]
    pub(crate) depends_on: Vec<String>,
    /// Descriptive surface-map label: "implemented" (default), "partial", or
    /// "unsupported". Labels never waive an exact-raster failure.
    #[serde(default = "default_expected_support")]
    pub(crate) expected_support: String,
    /// Reference ORACLE: which engine generates `oracles/<cat>/<id>.pdf`. "chrome"
    /// (default) = Chrome `--print-to-pdf` / Paged.js. "weasyprint" = WeasyPrint,
    /// used for CSS GCPM features (footnotes, running elements) that Chrome's
    /// print path renders blank, so Chrome+Paged.js are NOT a valid oracle there.
    /// Every parity fixture must have one of these real PDF oracles.
    #[serde(default = "default_oracle")]
    pub(crate) oracle: String,
    /// Optional standards-derived source used to generate the oracle PDF.
    ///
    /// This is reserved for cases where the selected reference renderer has a
    /// known implementation defect but can faithfully render an equivalent,
    /// explicitly derived layout. It is separately authenticated in refs.lock;
    /// the candidate always remains `file`.
    #[serde(default)]
    pub(crate) reference_file: Option<String>,
    /// Whether the committed oracle has been checked against the applicable
    /// standard for this fixture. A disputed reference remains visible as a
    /// reviewable compatibility canary; it is never treated as candidate evidence.
    #[serde(default)]
    pub(crate) reference: ReferenceAssessment,
    /// Exact relations required for the oracle to prove the intended semantic
    /// distinction. Relations compare ordered runtime oracle raster identities;
    /// they never inspect or excuse candidate output.
    #[serde(default, skip_serializing_if = "OracleSemantics::is_empty")]
    pub(crate) oracle_semantics: OracleSemantics,
}

/// Review state for a fixture's committed reference PDF.
#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReferenceAssessment {
    #[serde(default)]
    pub(crate) status: ReferenceStatus,
    #[serde(default)]
    pub(crate) note: String,
}

impl ReferenceAssessment {
    pub(crate) fn is_disputed(&self) -> bool {
        self.status == ReferenceStatus::Disputed
    }
}

/// A verified reference has been checked against the applicable standard.
/// A disputed reference is retained as evidence of an oracle issue, never as
/// proof that the candidate should be changed to match it.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ReferenceStatus {
    #[default]
    Verified,
    Disputed,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct OracleSemantics {
    #[serde(default)]
    pub(crate) must_differ_from: Vec<String>,
}

impl OracleSemantics {
    fn is_empty(&self) -> bool {
        self.must_differ_from.is_empty()
    }
}

pub(crate) fn default_sanitize() -> bool {
    true
}
pub(crate) fn default_kind() -> String {
    "feature".to_string()
}
pub(crate) fn default_expected_support() -> String {
    "implemented".to_string()
}
pub(crate) fn default_oracle() -> String {
    "chrome".to_string()
}

fn is_canonical_slug(value: &str) -> bool {
    !value.is_empty()
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn validate_oracle_semantics(
    entries: &[ManifestEntry],
    known: &std::collections::BTreeSet<&str>,
) -> Result<(), String> {
    let mut relations = std::collections::BTreeSet::new();

    for entry in entries {
        let mut declared = std::collections::BTreeSet::new();
        for target in &entry.oracle_semantics.must_differ_from {
            if target == &entry.id {
                return Err(format!(
                    "entry '{}': oracle_semantics.must_differ_from cannot reference itself",
                    entry.id
                ));
            }
            if !known.contains(target.as_str()) {
                return Err(format!(
                    "entry '{}': oracle_semantics.must_differ_from target `{target}` does not resolve to a known fixture id",
                    entry.id
                ));
            }
            if !declared.insert(target.as_str()) {
                return Err(format!(
                    "entry '{}': duplicate oracle_semantics.must_differ_from target `{target}`",
                    entry.id
                ));
            }
            let pair = if entry.id.as_str() < target.as_str() {
                (entry.id.clone(), target.clone())
            } else {
                (target.clone(), entry.id.clone())
            };
            if !relations.insert(pair) {
                return Err(format!(
                    "duplicate oracle_semantics relation between `{}` and `{target}`",
                    entry.id
                ));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Manifest loading + validation
// ---------------------------------------------------------------------------

pub(crate) fn load_manifests(
    repository_root: &Path,
    manifest_dir: &Path,
    parity_dir: &Path,
) -> Result<Vec<ManifestEntry>, String> {
    reject_symlink_components(repository_root, manifest_dir)?;
    let mut frag_files: Vec<PathBuf> = Vec::new();
    if manifest_dir.is_dir() {
        collect_manifest_fragments(repository_root, manifest_dir, &mut frag_files)?;
    }
    frag_files.sort();

    let mut all: Vec<ManifestEntry> = Vec::new();
    let mut seen_ids = BTreeMap::new();
    let mut seen_files = BTreeMap::new();
    for f in &frag_files {
        let stem = f
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let txt = std::fs::read_to_string(f)
            .map_err(|e| format!("cannot read manifest {}: {e}", f.display()))?;
        let frag: Vec<ManifestEntry> = serde_json::from_str(&txt)
            .map_err(|e| format!("invalid manifest JSON in {}: {e}", f.display()))?;
        for e in frag {
            if !is_canonical_slug(&e.id) {
                return Err(format!("entry has unsafe/non-canonical id {:?}", e.id));
            }
            if !is_canonical_slug(&e.category) {
                return Err(format!(
                    "entry '{}': unsafe/non-canonical category {:?}",
                    e.id, e.category
                ));
            }
            if e.category != stem {
                return Err(format!(
                    "manifest {}: entry '{}' has category '{}' != filename stem '{}'",
                    f.display(),
                    e.id,
                    e.category,
                    stem
                ));
            }
            for (label, value) in [("feature", &e.feature), ("description", &e.description)] {
                if value.is_empty() || value.trim() != value {
                    return Err(format!(
                        "entry '{}': {label} must be nonempty and trimmed, got {value:?}",
                        e.id
                    ));
                }
            }
            if !matches!(
                e.expected_support.as_str(),
                "implemented" | "partial" | "unsupported"
            ) {
                return Err(format!(
                    "entry '{}': invalid expected_support {:?}",
                    e.id, e.expected_support
                ));
            }
            if !matches!(e.kind.as_str(), "feature" | "interaction" | "probe") {
                return Err(format!("entry '{}': invalid kind {:?}", e.id, e.kind));
            }
            if !matches!(e.oracle.as_str(), "chrome" | "weasyprint") {
                return Err(format!(
                    "entry '{}': invalid PDF oracle {:?}",
                    e.id, e.oracle
                ));
            }
            match e.reference.status {
                ReferenceStatus::Verified if !e.reference.note.is_empty() => {
                    return Err(format!(
                        "entry '{}': verified reference must not carry a dispute note",
                        e.id
                    ));
                }
                ReferenceStatus::Disputed
                    if e.reference.note.is_empty()
                        || e.reference.note.trim() != e.reference.note =>
                {
                    return Err(format!(
                        "entry '{}': disputed reference requires a nonempty trimmed note",
                        e.id
                    ));
                }
                _ => {}
            }
            if !e.interaction_of.is_empty() && e.interaction_of.len() < 2 {
                return Err(format!(
                    "entry '{}' has interaction_of with < 2 elements",
                    e.id
                ));
            }
            let expected_file = format!("cases/{}/{}.html", e.category, e.id);
            if e.file != expected_file {
                return Err(format!(
                    "entry '{}': file {:?} must be {:?}",
                    e.id, e.file, expected_file
                ));
            }
            let fixture = parity_dir.join(&e.file);
            reject_symlink_components(repository_root, &fixture)?;
            if !fixture.is_file() {
                return Err(format!(
                    "entry '{}': fixture file not found: {}",
                    e.id,
                    fixture.display()
                ));
            }
            if let Some(reference_file) = &e.reference_file {
                let expected_reference_file = format!("references/{}/{}.html", e.category, e.id);
                if reference_file != &expected_reference_file {
                    return Err(format!(
                        "entry '{}': reference_file {:?} must be {:?}",
                        e.id, reference_file, expected_reference_file
                    ));
                }
                let reference = parity_dir.join(reference_file);
                reject_symlink_components(repository_root, &reference)?;
                if !reference.is_file() {
                    return Err(format!(
                        "entry '{}': reference source file not found: {}",
                        e.id,
                        reference.display()
                    ));
                }
            }
            let oracle = parity_dir
                .join("oracles")
                .join(&e.category)
                .join(format!("{}.pdf", e.id));
            reject_symlink_components(repository_root, &oracle)?;
            if let Some(previous_id) = seen_files.insert(e.file.clone(), e.id.clone()) {
                return Err(format!(
                    "fixture file '{}' is mapped by both '{}' and '{}'",
                    e.file, previous_id, e.id
                ));
            }
            // Per-fixture `@page { size: <content>; margin: 0 }` is now the design:
            // each fixture sizes the page to what it tests (no white-space skew) and
            // BOTH engines honor it (Chrome via --print-to-pdf, ironpress via the
            // @page-rule override), so there is no geometry desync. The former guard
            // that REJECTED @page is therefore obsolete and was removed.
            if let Some(prev) = seen_ids.insert(e.id.clone(), f.clone()) {
                return Err(format!(
                    "duplicate fixture id '{}' (in {} and {})",
                    e.id,
                    prev.display(),
                    f.display()
                ));
            }
            all.push(e);
        }
    }

    // Reference resolution guard (mirrors the duplicate-id guard): every
    // `depends_on` id and every interaction `base_id` MUST resolve to a known
    // fixture id, otherwise the manifest is structurally broken.
    let known: std::collections::BTreeSet<&str> = seen_ids.keys().map(|s| s.as_str()).collect();
    let mut ref_problems: Vec<String> = Vec::new();
    for e in &all {
        for d in &e.depends_on {
            if !known.contains(d.as_str()) {
                ref_problems.push(format!(
                    "entry '{}': depends_on `{}` does not resolve to a known fixture id",
                    e.id, d
                ));
            }
        }
        for b in &e.base_ids {
            if !known.contains(b.as_str()) {
                ref_problems.push(format!(
                    "entry '{}': interaction base_id `{}` does not resolve to a known fixture id",
                    e.id, b
                ));
            }
        }
    }
    if !ref_problems.is_empty() {
        return Err(format!(
            "manifest reference validation FAILED ({} problem(s)):\n  - {}",
            ref_problems.len(),
            ref_problems.join("\n  - ")
        ));
    }
    validate_oracle_semantics(&all, &known)?;

    // Enforce the reverse mapping too: an HTML case without a manifest entry is
    // dead coverage that never runs and can silently mislead reviewers. Walk the
    // complete tree first so a root-level or nested case cannot sit outside the
    // canonical `cases/<category>/<fixture>.html` corpus unnoticed.
    let cases_dir = parity_dir.join("cases");
    let mut discovered_cases = Vec::new();
    collect_html_cases(
        repository_root,
        &cases_dir,
        parity_dir,
        &mut discovered_cases,
    )?;
    discovered_cases.sort();

    let mut noncanonical_cases = Vec::new();
    let mut orphan_cases = Vec::new();
    for relative in discovered_cases {
        let components: Vec<&str> = relative.split('/').collect();
        if components.len() != 3 || components[0] != "cases" {
            noncanonical_cases.push(relative);
            continue;
        }
        if !seen_files.contains_key(&relative) {
            orphan_cases.push(relative);
        }
    }
    if !noncanonical_cases.is_empty() {
        return Err(format!(
            "{} HTML case path(s) are non-canonical; every case must be exactly cases/<category>/<fixture>.html:\n  - {}",
            noncanonical_cases.len(),
            noncanonical_cases.join("\n  - ")
        ));
    }
    if !orphan_cases.is_empty() {
        return Err(format!(
            "{} case file(s) have no manifest entry:\n  - {}",
            orphan_cases.len(),
            orphan_cases.join("\n  - ")
        ));
    }

    all.sort_by(|a, b| (a.category.clone(), a.id.clone()).cmp(&(b.category.clone(), b.id.clone())));
    Ok(all)
}

/// Detect id != oracle-filename mismatches: a manifest id whose expected
/// `oracles/<category>/<id>.pdf` is absent while the category dir contains one or
/// more oracle PDFs claimed by no id. That signature means an oracle exists but was
/// committed under the wrong name (e.g. `border-box-shadow-offset` whose ref is
/// `box-shadow-offset.pdf`). Missing and misnamed references are both strict
/// failures; this distinction improves the repair message.
pub(crate) fn find_ref_mismatches(
    entries: &[ManifestEntry],
    oracles_dir: &Path,
) -> Vec<RefMismatch> {
    // category -> set of expected oracle file names (one per id).
    let mut expected: BTreeMap<String, std::collections::BTreeSet<String>> = BTreeMap::new();
    for e in entries {
        expected
            .entry(e.category.clone())
            .or_default()
            .insert(format!("{}.pdf", e.id));
    }

    let mut out: Vec<RefMismatch> = Vec::new();
    for e in entries {
        let expected_ref = format!("{}.pdf", e.id);
        let ref_path = oracles_dir.join(&e.category).join(&expected_ref);
        if ref_path.is_file() {
            continue; // ref present under the right name; nothing to flag.
        }
        // Gather orphan oracle PDFs in this category dir (present on disk but not
        // an expected name for any id in the category).
        let cat_dir = oracles_dir.join(&e.category);
        let mut orphans: Vec<String> = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&cat_dir) {
            let claimed = expected.get(&e.category);
            for ent in rd.flatten() {
                let name = ent.file_name().to_string_lossy().into_owned();
                if !name.ends_with(".pdf") {
                    continue;
                }
                let is_claimed = claimed.map(|c| c.contains(&name)).unwrap_or(false);
                if !is_claimed {
                    orphans.push(name);
                }
            }
        }
        if !orphans.is_empty() {
            orphans.sort();
            out.push(RefMismatch {
                id: e.id.clone(),
                category: e.category.clone(),
                expected_ref,
                orphan_refs: orphans,
            });
        }
    }
    out.sort_by(|a, b| (a.category.clone(), a.id.clone()).cmp(&(b.category.clone(), b.id.clone())));
    out
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use serde_json::json;

    use super::*;

    static NEXT_TMP: AtomicU64 = AtomicU64::new(0);

    struct TestDir {
        root: PathBuf,
        parity: PathBuf,
        manifest: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let number = NEXT_TMP.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "ironpress-manifest-test-{}-{number}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&root);
            let parity = root.join("tests/parity");
            let manifest = parity.join("manifest");
            std::fs::create_dir_all(parity.join("cases/test")).unwrap();
            std::fs::create_dir_all(&manifest).unwrap();
            std::fs::write(parity.join("cases/test/example.html"), "<p>example</p>").unwrap();
            std::fs::write(
                manifest.join("test.json"),
                serde_json::to_vec(&json!([{
                    "id": "example",
                    "category": "test",
                    "feature": "test",
                    "description": "test fixture",
                    "file": "cases/test/example.html"
                }]))
                .unwrap(),
            )
            .unwrap();
            Self {
                root,
                parity,
                manifest,
            }
        }

        fn write_oracle_relations(&self, relations: &[(&str, &[&str])]) {
            let entries: Vec<_> = relations
                .iter()
                .map(|(id, targets)| {
                    std::fs::write(
                        self.parity.join(format!("cases/test/{id}.html")),
                        format!("<p>{id}</p>"),
                    )
                    .unwrap();
                    json!({
                        "id": id,
                        "category": "test",
                        "feature": "oracle semantics",
                        "description": format!("oracle semantics fixture {id}"),
                        "file": format!("cases/test/{id}.html"),
                        "oracle_semantics": { "must_differ_from": targets }
                    })
                })
                .collect();
            std::fs::write(
                self.manifest.join("test.json"),
                serde_json::to_vec(&entries).unwrap(),
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
    fn canonical_case_path_is_accepted() {
        let directory = TestDir::new();
        let entries =
            load_manifests(&directory.root, &directory.manifest, &directory.parity).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "example");
    }

    #[test]
    fn root_level_html_case_is_rejected_explicitly() {
        let directory = TestDir::new();
        std::fs::write(directory.parity.join("cases/root.html"), "<p>hidden</p>").unwrap();

        let error =
            load_manifests(&directory.root, &directory.manifest, &directory.parity).unwrap_err();
        assert!(error.contains("every case must be exactly cases/<category>/<fixture>.html"));
        assert!(error.contains("cases/root.html"));
    }

    #[test]
    fn nested_html_case_is_rejected_explicitly() {
        let directory = TestDir::new();
        let nested = directory.parity.join("cases/test/nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("hidden.html"), "<p>hidden</p>").unwrap();

        let error =
            load_manifests(&directory.root, &directory.manifest, &directory.parity).unwrap_err();
        assert!(error.contains("every case must be exactly cases/<category>/<fixture>.html"));
        assert!(error.contains("cases/test/nested/hidden.html"));
    }

    #[test]
    fn uppercase_html_extension_cannot_hide_an_unmanifested_case() {
        let directory = TestDir::new();
        std::fs::write(
            directory.parity.join("cases/test/hidden.HTML"),
            "<p>hidden</p>",
        )
        .unwrap();

        let error =
            load_manifests(&directory.root, &directory.manifest, &directory.parity).unwrap_err();
        assert!(error.contains("case file(s) have no manifest entry"));
        assert!(error.contains("cases/test/hidden.HTML"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_case_category_cannot_escape_the_parity_tree() {
        let directory = TestDir::new();
        let category = directory.parity.join("cases/test");
        let external = directory.root.join("external-cases");
        std::fs::rename(&category, &external).unwrap();
        std::os::unix::fs::symlink(&external, &category).unwrap();

        let error =
            load_manifests(&directory.root, &directory.manifest, &directory.parity).unwrap_err();
        assert!(error.contains("symlink component"), "{error}");
        assert!(error.contains("cases/test"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_manifest_root_is_rejected_before_fragments_are_read() {
        let directory = TestDir::new();
        let external = directory.root.join("external-manifest");
        std::fs::rename(&directory.manifest, &external).unwrap();
        std::os::unix::fs::symlink(&external, &directory.manifest).unwrap();

        let error =
            load_manifests(&directory.root, &directory.manifest, &directory.parity).unwrap_err();
        assert!(error.contains("symlink component"), "{error}");
        assert!(error.contains("manifest"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_tests_ancestor_is_rejected_from_the_trusted_repository_root() {
        let directory = TestDir::new();
        let tests = directory.root.join("tests");
        let external = directory.root.join("external-tests");
        std::fs::rename(&tests, &external).unwrap();
        std::os::unix::fs::symlink(&external, &tests).unwrap();

        let error =
            load_manifests(&directory.root, &directory.manifest, &directory.parity).unwrap_err();
        assert!(error.contains("symlink component"), "{error}");
        assert!(error.contains("/tests"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_oracle_category_is_rejected_even_when_the_leaf_is_regular() {
        let directory = TestDir::new();
        let external = directory.root.join("external-oracles");
        std::fs::create_dir_all(&external).unwrap();
        std::fs::write(external.join("example.pdf"), b"%PDF external").unwrap();
        std::fs::create_dir_all(directory.parity.join("oracles")).unwrap();
        std::os::unix::fs::symlink(&external, directory.parity.join("oracles/test")).unwrap();

        let error =
            load_manifests(&directory.root, &directory.manifest, &directory.parity).unwrap_err();
        assert!(error.contains("symlink component"), "{error}");
        assert!(error.contains("oracles/test"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn recursive_case_walk_rejects_symlinked_directories() {
        let directory = TestDir::new();
        let external = directory.root.join("external-extra-cases");
        std::fs::create_dir_all(&external).unwrap();
        std::fs::write(external.join("hidden.html"), "<p>hidden</p>").unwrap();
        std::os::unix::fs::symlink(&external, directory.parity.join("cases/test/linked")).unwrap();

        let error =
            load_manifests(&directory.root, &directory.manifest, &directory.parity).unwrap_err();
        assert!(error.contains("case tree contains symlink"), "{error}");
    }

    #[test]
    fn report_labels_must_be_nonempty_and_trimmed() {
        for (field, value) in [
            ("feature", ""),
            ("feature", " padded"),
            ("description", "\t"),
            ("description", "trailing "),
        ] {
            let directory = TestDir::new();
            let path = directory.manifest.join("test.json");
            let mut manifest: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            manifest[0][field] = value.into();
            std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();

            let error = load_manifests(&directory.root, &directory.manifest, &directory.parity)
                .unwrap_err();
            assert!(error.contains(&format!("{field} must be nonempty and trimmed")));
        }
    }

    #[test]
    fn disputed_reference_requires_a_trimmed_standard_note() {
        let directory = TestDir::new();
        let path = directory.manifest.join("test.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();

        manifest[0]["reference"] = json!({"status": "disputed", "note": "  "});
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let error =
            load_manifests(&directory.root, &directory.manifest, &directory.parity).unwrap_err();
        assert!(error.contains("disputed reference requires"), "{error}");

        manifest[0]["reference"] = json!({
            "status": "disputed",
            "note": "spec review found an oracle conflict"
        });
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let entries =
            load_manifests(&directory.root, &directory.manifest, &directory.parity).unwrap();
        assert!(entries[0].reference.is_disputed());
    }

    #[test]
    fn category_must_be_a_canonical_path_atom() {
        let directory = TestDir::new();
        std::fs::remove_file(directory.manifest.join("test.json")).unwrap();
        std::fs::create_dir_all(directory.parity.join("cases/bad--category")).unwrap();
        std::fs::write(
            directory.parity.join("cases/bad--category/example.html"),
            "<p>example</p>",
        )
        .unwrap();
        std::fs::write(
            directory.manifest.join("bad--category.json"),
            serde_json::to_vec(&json!([{
                "id": "example",
                "category": "bad--category",
                "feature": "test",
                "description": "test fixture",
                "file": "cases/bad--category/example.html"
            }]))
            .unwrap(),
        )
        .unwrap();

        let error =
            load_manifests(&directory.root, &directory.manifest, &directory.parity).unwrap_err();
        assert!(error.contains("unsafe/non-canonical category"));
        assert!(error.contains("bad--category"));
    }

    #[test]
    fn oracle_semantic_relation_is_structured_and_resolves_known_ids() {
        let directory = TestDir::new();
        directory.write_oracle_relations(&[("example", &["peer"]), ("peer", &[])]);

        let entries =
            load_manifests(&directory.root, &directory.manifest, &directory.parity).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0].oracle_semantics.must_differ_from,
            ["peer".to_string()]
        );
    }

    #[test]
    fn oracle_semantic_relations_reject_unknown_self_and_duplicate_edges() {
        let directory = TestDir::new();
        directory.write_oracle_relations(&[("example", &["missing"])]);
        let error =
            load_manifests(&directory.root, &directory.manifest, &directory.parity).unwrap_err();
        assert!(error.contains("does not resolve"), "{error}");

        let directory = TestDir::new();
        directory.write_oracle_relations(&[("example", &["example"])]);
        let error =
            load_manifests(&directory.root, &directory.manifest, &directory.parity).unwrap_err();
        assert!(error.contains("cannot reference itself"), "{error}");

        let directory = TestDir::new();
        directory.write_oracle_relations(&[("example", &["peer", "peer"]), ("peer", &[])]);
        let error =
            load_manifests(&directory.root, &directory.manifest, &directory.parity).unwrap_err();
        assert!(error.contains("duplicate oracle_semantics"), "{error}");
    }

    #[test]
    fn oracle_semantic_relations_allow_inequality_cycles() {
        let directory = TestDir::new();
        directory.write_oracle_relations(&[
            ("example", &["second"]),
            ("second", &["third"]),
            ("third", &["example"]),
        ]);

        let entries =
            load_manifests(&directory.root, &directory.manifest, &directory.parity).unwrap();
        assert_eq!(entries.len(), 3);
    }
}
