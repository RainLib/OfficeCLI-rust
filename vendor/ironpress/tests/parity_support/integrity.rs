//! Fail-closed evidence that an exact raster match represents real, distinct
//! coverage rather than two empty pages or duplicated corpus artifacts.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use image::RgbaImage;

use super::manifest::{ManifestEntry, symlink_component};
use super::report::{CorpusIssue, CorpusIssueKind, FixtureResult, RasterFingerprint};
use super::util::sha256_hex;

pub(crate) fn raster_fingerprints(images: &[RgbaImage]) -> Vec<RasterFingerprint> {
    images
        .iter()
        .map(|image| RasterFingerprint {
            width: image.width(),
            height: image.height(),
            rgba_sha256: sha256_hex(image.as_raw()),
            painted_pixels: image
                .pixels()
                .filter(|pixel| pixel.0 != [255, 255, 255, 255])
                .count() as u64,
        })
        .collect()
}

/// Inspect repository-owned inputs without interpreting HTML or PDF internals.
/// Every rule here is exact: regular-file identity, canonical path atoms, empty
/// source bytes, and byte-for-byte duplicate artifacts. Visual equivalence is
/// deliberately not treated as duplication because distinct syntax may be
/// expected to render identically.
pub(crate) fn audit_corpus(
    repository_root: &Path,
    manifest_dir: &Path,
    parity_dir: &Path,
    entries: &[ManifestEntry],
) -> Result<Vec<CorpusIssue>, String> {
    let mut issues = Vec::new();
    audit_manifest_paths(repository_root, manifest_dir, parity_dir, &mut issues)?;

    let mut source_hashes: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut oracle_hashes: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut symlinks = BTreeSet::new();
    let mut empty_sources = Vec::new();
    let mut noncanonical = Vec::new();

    for entry in entries {
        if !is_canonical_atom(&entry.category) {
            noncanonical.push(format!("{} (category {:?})", entry.id, entry.category));
        }

        let expected_file = format!("cases/{}/{}.html", entry.category, entry.id);
        if entry.file != expected_file {
            noncanonical.push(format!("{} ({:?})", entry.id, entry.file));
        }

        let source = parity_dir.join(&entry.file);
        if let Some(component) = symlink_component(repository_root, &source)? {
            symlinks.insert(format!(
                "{} -> {}",
                entry.id,
                relative(parity_dir, &component)
            ));
        } else {
            let bytes = std::fs::read(&source)
                .map_err(|error| format!("cannot read fixture {}: {error}", source.display()))?;
            if bytes.iter().all(u8::is_ascii_whitespace) {
                empty_sources.push(entry.id.clone());
            }
            source_hashes
                .entry(sha256_hex(&bytes))
                .or_default()
                .push(entry.id.clone());
        }

        let oracle = parity_dir
            .join("oracles")
            .join(&entry.category)
            .join(format!("{}.pdf", entry.id));
        if let Some(component) = symlink_component(repository_root, &oracle)? {
            symlinks.insert(format!(
                "{} -> {}",
                entry.id,
                relative(parity_dir, &component)
            ));
        } else {
            let bytes = std::fs::read(&oracle)
                .map_err(|error| format!("cannot read oracle {}: {error}", oracle.display()))?;
            oracle_hashes
                .entry(sha256_hex(&bytes))
                .or_default()
                .push(entry.id.clone());
        }
    }

    if !symlinks.is_empty() {
        issues.push(CorpusIssue {
            kind: CorpusIssueKind::Symlink,
            fixtures: symlinks.into_iter().collect(),
            detail: "fixture and oracle artifacts must be repository-owned regular files"
                .to_string(),
        });
    }
    if !empty_sources.is_empty() {
        empty_sources.sort();
        issues.push(CorpusIssue {
            kind: CorpusIssueKind::EmptyFixture,
            fixtures: empty_sources,
            detail: "fixture source is empty or ASCII-whitespace only".to_string(),
        });
    }
    if !noncanonical.is_empty() {
        noncanonical.sort();
        issues.push(CorpusIssue {
            kind: CorpusIssueKind::NonCanonicalPath,
            fixtures: noncanonical,
            detail: "categories and case paths must use the canonical cases/<category>/<id>.html mapping"
                .to_string(),
        });
    }

    push_duplicate_groups(
        &mut issues,
        CorpusIssueKind::DuplicateFixture,
        source_hashes,
        "distinct fixture IDs reuse byte-identical HTML",
    );
    push_duplicate_groups(
        &mut issues,
        CorpusIssueKind::DuplicateOracle,
        oracle_hashes,
        "distinct fixture IDs reuse the same oracle PDF bytes",
    );
    audit_pinned_ua_environment(repository_root, parity_dir, entries, &mut issues)?;
    issues.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then(left.fixtures.cmp(&right.fixtures))
            .then(left.detail.cmp(&right.detail))
    });
    Ok(issues)
}

fn audit_pinned_ua_environment(
    repository_root: &Path,
    parity_dir: &Path,
    entries: &[ManifestEntry],
    issues: &mut Vec<CorpusIssue>,
) -> Result<(), String> {
    let stylesheet = parity_dir.join("ua-pins.css");
    if let Some(component) = symlink_component(repository_root, &stylesheet)? {
        issues.push(CorpusIssue {
            kind: CorpusIssueKind::Symlink,
            fixtures: vec![relative(parity_dir, &component)],
            detail: "the pinned UA stylesheet must be a repository-owned regular file".to_string(),
        });
        return Ok(());
    }
    let css = std::fs::read_to_string(&stylesheet).map_err(|error| {
        format!(
            "cannot read pinned UA stylesheet {}: {error}",
            stylesheet.display()
        )
    })?;
    if css.trim().is_empty() {
        issues.push(CorpusIssue {
            kind: CorpusIssueKind::UnpinnedUa,
            fixtures: vec!["ua-pins.css".to_string()],
            detail: "the shared author-origin UA baseline is empty".to_string(),
        });
    }

    let mut malformed = BTreeSet::new();
    for entry in entries {
        for relative_path in [
            entry.file.as_str(),
            entry.reference_file.as_deref().unwrap_or(&entry.file),
        ] {
            let path = parity_dir.join(relative_path);
            let html = std::fs::read_to_string(&path).map_err(|error| {
                format!("cannot read oracle source {}: {error}", path.display())
            })?;
            if !has_head_element(&html) {
                malformed.insert(relative_path.to_string());
            }
        }
    }
    if !malformed.is_empty() {
        issues.push(CorpusIssue {
            kind: CorpusIssueKind::UnpinnedUa,
            fixtures: malformed.into_iter().collect(),
            detail: "oracle source has no explicit <head> insertion point for the authenticated UA baseline"
                .to_string(),
        });
    }
    Ok(())
}

fn has_head_element(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    lower.match_indices("<head").any(|(offset, _)| {
        lower
            .as_bytes()
            .get(offset + "<head".len())
            .is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'>')
    })
}

/// An all-paper document has no tested output, even when both sides are exactly
/// equal. Check the complete page set so an intentional blank page inside an
/// otherwise painted multi-page document remains valid.
pub(crate) fn audit_raster_signals(results: &[FixtureResult]) -> Vec<CorpusIssue> {
    let mut blank_oracles = Vec::new();
    for fixture in results {
        if is_blank_document(&fixture.raster.oracle) {
            blank_oracles.push(fixture.id.clone());
        }
    }

    let mut issues = Vec::new();
    if !blank_oracles.is_empty() {
        blank_oracles.sort();
        issues.push(CorpusIssue {
            kind: CorpusIssueKind::MissingPaint,
            fixtures: blank_oracles,
            detail: "oracle raster has zero non-paper pixels across all pages".to_string(),
        });
    }
    issues
}

/// Enforce only explicitly declared semantic distinctions. Equal rasters are
/// otherwise legitimate: distinct syntax can intentionally have the same visual
/// result. Candidate status and candidate pixels never participate here.
pub(crate) fn audit_oracle_semantics(
    entries: &[ManifestEntry],
    results: &[FixtureResult],
) -> Vec<CorpusIssue> {
    let by_id: BTreeMap<&str, &FixtureResult> = results
        .iter()
        .map(|result| (result.id.as_str(), result))
        .collect();
    let mut issues = Vec::new();
    for entry in entries {
        for target in &entry.oracle_semantics.must_differ_from {
            let fixtures = vec![entry.id.clone(), target.clone()];
            let Some(left) = by_id.get(entry.id.as_str()) else {
                issues.push(invalid_oracle(
                    fixtures,
                    format!("oracle relation is unverified: {} has no result", entry.id),
                ));
                continue;
            };
            let Some(right) = by_id.get(target.as_str()) else {
                issues.push(invalid_oracle(
                    fixtures,
                    format!("oracle relation is unverified: {target} has no result"),
                ));
                continue;
            };
            let invalid = [*left, *right]
                .into_iter()
                .find(|result| !valid_raster_sequence(&result.raster.oracle));
            if let Some(invalid) = invalid {
                issues.push(invalid_oracle(
                    fixtures,
                    format!(
                        "oracle relation is unverified: {} has no valid complete oracle raster fingerprint",
                        invalid.id
                    ),
                ));
            } else if same_raster_identity(&left.raster.oracle, &right.raster.oracle) {
                issues.push(invalid_oracle(
                    fixtures,
                    format!(
                        "oracle_semantics requires {} and {target} to differ, but their ordered page dimensions and RGBA hashes are identical",
                        entry.id
                    ),
                ));
            }
        }
    }
    issues
}

fn invalid_oracle(fixtures: Vec<String>, detail: String) -> CorpusIssue {
    CorpusIssue {
        kind: CorpusIssueKind::InvalidOracle,
        fixtures,
        detail,
    }
}

fn valid_raster_sequence(pages: &[RasterFingerprint]) -> bool {
    !pages.is_empty()
        && pages.iter().all(|page| {
            let pixels = u64::from(page.width) * u64::from(page.height);
            page.width != 0
                && page.height != 0
                && page.rgba_sha256.len() == 64
                && page
                    .rgba_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                && page.painted_pixels <= pixels
        })
}

fn same_raster_identity(left: &[RasterFingerprint], right: &[RasterFingerprint]) -> bool {
    left.len() == right.len()
        && left.iter().zip(right).all(|(left, right)| {
            (left.width, left.height, left.rgba_sha256.as_str())
                == (right.width, right.height, right.rgba_sha256.as_str())
        })
}

fn audit_manifest_paths(
    repository_root: &Path,
    manifest_dir: &Path,
    parity_dir: &Path,
    issues: &mut Vec<CorpusIssue>,
) -> Result<(), String> {
    if let Some(component) = symlink_component(repository_root, manifest_dir)? {
        issues.push(CorpusIssue {
            kind: CorpusIssueKind::Symlink,
            fixtures: vec![relative(parity_dir, &component)],
            detail: "manifest fragments must be repository-owned regular files".to_string(),
        });
        return Ok(());
    }
    let entries = std::fs::read_dir(manifest_dir).map_err(|error| {
        format!(
            "cannot read manifest directory {}: {error}",
            manifest_dir.display()
        )
    })?;
    let mut symlinks = Vec::new();
    let mut noncanonical = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "cannot inspect an entry in manifest directory {}: {error}",
                manifest_dir.display()
            )
        })?;
        let path = entry.path();
        if let Some(component) = symlink_component(repository_root, &path)? {
            symlinks.push(relative(parity_dir, &component));
            continue;
        }
        let canonical = entry
            .file_type()
            .map_err(|error| format!("cannot inspect {}: {error}", path.display()))?
            .is_file()
            && path.extension().and_then(|extension| extension.to_str()) == Some("json")
            && path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .is_some_and(is_canonical_atom);
        if !canonical {
            noncanonical.push(relative(parity_dir, &path));
        }
    }
    if !symlinks.is_empty() {
        symlinks.sort();
        issues.push(CorpusIssue {
            kind: CorpusIssueKind::Symlink,
            fixtures: symlinks,
            detail: "manifest fragments must be repository-owned regular files".to_string(),
        });
    }
    if !noncanonical.is_empty() {
        noncanonical.sort();
        issues.push(CorpusIssue {
            kind: CorpusIssueKind::NonCanonicalPath,
            fixtures: noncanonical,
            detail: "manifest directory may contain only canonical <category>.json fragments"
                .to_string(),
        });
    }
    Ok(())
}

fn push_duplicate_groups(
    issues: &mut Vec<CorpusIssue>,
    kind: CorpusIssueKind,
    groups: BTreeMap<String, Vec<String>>,
    detail: &str,
) {
    for (sha256, mut fixtures) in groups {
        if fixtures.len() < 2 {
            continue;
        }
        fixtures.sort();
        issues.push(CorpusIssue {
            kind,
            fixtures,
            detail: format!("{detail} (SHA-256 {sha256})"),
        });
    }
}

fn is_blank_document(pages: &[RasterFingerprint]) -> bool {
    !pages.is_empty() && pages.iter().all(|page| page.painted_pixels == 0)
}

fn is_canonical_atom(value: &str) -> bool {
    !value.is_empty()
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use image::{ImageBuffer, Rgba};

    use super::*;
    use crate::parity_support::manifest::{default_expected_support, default_kind, default_oracle};
    use crate::parity_support::report::RasterEvidence;

    static NEXT_TMP: AtomicU64 = AtomicU64::new(0);

    struct TempCorpus {
        root: PathBuf,
        parity: PathBuf,
    }

    impl TempCorpus {
        fn new() -> Self {
            let sequence = NEXT_TMP.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "ironpress-parity-integrity-{}-{sequence}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&root);
            let parity = root.join("tests/parity");
            for directory in [
                parity.join("manifest"),
                parity.join("cases/test"),
                parity.join("oracles/test"),
            ] {
                std::fs::create_dir_all(directory).unwrap();
            }
            std::fs::write(parity.join("ua-pins.css"), b":where(body){margin:0}").unwrap();
            Self { root, parity }
        }

        fn entry(&self, id: &str) -> ManifestEntry {
            ManifestEntry {
                id: id.to_string(),
                category: "test".to_string(),
                feature: "integrity".to_string(),
                subfeature: String::new(),
                description: format!("integrity fixture {id}"),
                file: format!("cases/test/{id}.html"),
                interaction_of: Vec::new(),
                base_ids: Vec::new(),
                sanitize: true,
                kind: default_kind(),
                depends_on: Vec::new(),
                expected_support: default_expected_support(),
                oracle: default_oracle(),
                reference_file: None,
                reference: Default::default(),
                oracle_semantics: Default::default(),
            }
        }
    }

    impl Drop for TempCorpus {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn raster_evidence_counts_exact_nonpaper_pixels_without_a_cutoff() {
        let mut image = ImageBuffer::from_pixel(3, 1, Rgba([255, 255, 255, 255]));
        image.put_pixel(1, 0, Rgba([254, 255, 255, 255]));
        image.put_pixel(2, 0, Rgba([255, 255, 255, 254]));

        let evidence = raster_fingerprints(&[image]);
        assert_eq!(evidence[0].painted_pixels, 2);
        assert_eq!(evidence[0].width, 3);
        assert_eq!(evidence[0].height, 1);
        assert_eq!(evidence[0].rgba_sha256.len(), 64);
    }

    #[test]
    fn only_an_all_paper_oracle_is_a_corpus_integrity_failure() {
        let blank = RasterFingerprint {
            width: 2,
            height: 2,
            rgba_sha256: "0".repeat(64),
            painted_pixels: 0,
        };
        let painted = RasterFingerprint {
            painted_pixels: 1,
            ..blank.clone()
        };
        let mut first = crate::parity_support::report::fixture_base(
            &TempCorpus::new().entry("both-blank"),
            crate::parity_support::report::Status::Pass,
            0.0,
            String::new(),
        );
        first.raster = RasterEvidence {
            candidate: vec![blank.clone()],
            oracle: vec![blank.clone()],
        };
        let mut second = crate::parity_support::report::fixture_base(
            &TempCorpus::new().entry("blank-oracle"),
            crate::parity_support::report::Status::Pass,
            0.0,
            String::new(),
        );
        second.raster = RasterEvidence {
            candidate: vec![painted],
            oracle: vec![blank],
        };

        let issues = audit_raster_signals(&[first, second]);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].fixtures, ["blank-oracle", "both-blank"]);
        assert!(issues[0].detail.starts_with("oracle raster"));
    }

    #[test]
    fn declared_oracle_distinction_uses_only_complete_oracle_raster_identity() {
        let corpus = TempCorpus::new();
        let mut left_entry = corpus.entry("left");
        left_entry.oracle_semantics.must_differ_from = vec!["right".to_string()];
        let right_entry = corpus.entry("right");
        let fingerprint = RasterFingerprint {
            width: 2,
            height: 2,
            rgba_sha256: "a".repeat(64),
            painted_pixels: 1,
        };
        let mut left = crate::parity_support::report::fixture_base(
            &left_entry,
            crate::parity_support::report::Status::Fail,
            100.0,
            "candidate failed before comparison".to_string(),
        );
        left.raster.oracle = vec![fingerprint.clone()];
        let mut right = crate::parity_support::report::fixture_base(
            &right_entry,
            crate::parity_support::report::Status::Pass,
            0.0,
            String::new(),
        );
        right.raster.oracle = vec![fingerprint];

        let issues = audit_oracle_semantics(
            &[left_entry.clone(), right_entry.clone()],
            &[left.clone(), right.clone()],
        );
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, CorpusIssueKind::InvalidOracle);
        assert!(issues[0].detail.contains("RGBA hashes are identical"));

        right.raster.oracle[0].rgba_sha256 = "b".repeat(64);
        assert!(
            audit_oracle_semantics(
                &[left_entry.clone(), right_entry.clone()],
                &[left.clone(), right]
            )
            .is_empty()
        );

        let mut unavailable = crate::parity_support::report::fixture_base(
            &right_entry,
            crate::parity_support::report::Status::Fail,
            100.0,
            "oracle decode failed".to_string(),
        );
        unavailable.raster.oracle.clear();
        let issues = audit_oracle_semantics(&[left_entry, right_entry], &[left, unavailable]);
        assert_eq!(issues.len(), 1);
        assert!(issues[0].detail.contains("unverified"));
    }

    #[test]
    fn corpus_audit_propagates_authenticated_input_read_failures() {
        let corpus = TempCorpus::new();
        let entry = corpus.entry("missing");
        let error = audit_corpus(
            &corpus.root,
            &corpus.parity.join("manifest"),
            &corpus.parity,
            &[entry],
        )
        .unwrap_err();
        assert!(error.contains("cannot read fixture"), "{error}");
    }

    #[test]
    fn corpus_audit_reports_an_oracle_source_without_a_ua_insertion_point() {
        let corpus = TempCorpus::new();
        let entry = corpus.entry("implicit-head");
        std::fs::write(
            corpus.parity.join("cases/test/implicit-head.html"),
            b"<p>implicit document</p>",
        )
        .unwrap();
        std::fs::write(
            corpus.parity.join("oracles/test/implicit-head.pdf"),
            b"%PDF oracle",
        )
        .unwrap();

        let issues = audit_corpus(
            &corpus.root,
            &corpus.parity.join("manifest"),
            &corpus.parity,
            &[entry],
        )
        .unwrap();
        let issue = issues
            .iter()
            .find(|issue| issue.kind == CorpusIssueKind::UnpinnedUa)
            .unwrap();
        assert_eq!(issue.fixtures, ["cases/test/implicit-head.html"]);
    }

    #[test]
    fn corpus_audit_reports_every_exact_duplicate_empty_path_and_symlink_problem() {
        let corpus = TempCorpus::new();
        let entries = ["duplicate-a", "duplicate-b", "empty", "linked"].map(|id| corpus.entry(id));
        for id in ["duplicate-a", "duplicate-b"] {
            std::fs::write(
                corpus.parity.join(format!("cases/test/{id}.html")),
                b"<p>same fixture</p>",
            )
            .unwrap();
            std::fs::write(
                corpus.parity.join(format!("oracles/test/{id}.pdf")),
                b"%PDF same oracle",
            )
            .unwrap();
        }
        std::fs::write(corpus.parity.join("cases/test/empty.html"), b" \n\t").unwrap();
        std::fs::write(
            corpus.parity.join("oracles/test/empty.pdf"),
            b"%PDF unique empty",
        )
        .unwrap();
        std::fs::write(corpus.parity.join("manifest/Bad Name.txt"), b"ignored").unwrap();
        std::os::unix::fs::symlink(
            corpus.parity.join("cases/test/duplicate-a.html"),
            corpus.parity.join("cases/test/linked.html"),
        )
        .unwrap();
        std::os::unix::fs::symlink(
            corpus.parity.join("oracles/test/duplicate-a.pdf"),
            corpus.parity.join("oracles/test/linked.pdf"),
        )
        .unwrap();

        let issues = audit_corpus(
            &corpus.root,
            &corpus.parity.join("manifest"),
            &corpus.parity,
            &entries,
        )
        .unwrap();
        let by_kind: BTreeMap<_, Vec<_>> =
            issues.iter().fold(BTreeMap::new(), |mut groups, issue| {
                groups.entry(issue.kind).or_default().push(issue);
                groups
            });

        assert_eq!(
            by_kind[&CorpusIssueKind::DuplicateFixture][0].fixtures,
            ["duplicate-a", "duplicate-b"]
        );
        assert_eq!(
            by_kind[&CorpusIssueKind::DuplicateOracle][0].fixtures,
            ["duplicate-a", "duplicate-b"]
        );
        assert_eq!(
            by_kind[&CorpusIssueKind::EmptyFixture][0].fixtures,
            ["empty"]
        );
        assert_eq!(by_kind[&CorpusIssueKind::Symlink][0].fixtures.len(), 2);
        assert!(
            by_kind[&CorpusIssueKind::NonCanonicalPath]
                .iter()
                .any(|issue| issue
                    .fixtures
                    .iter()
                    .any(|path| path.contains("Bad Name.txt")))
        );
    }

    #[cfg(unix)]
    #[test]
    fn corpus_audit_reports_symlinked_ancestor_directories() {
        let corpus = TempCorpus::new();
        let entry = corpus.entry("ancestor-link");
        let external_cases = corpus.root.join("external-cases");
        let external_oracles = corpus.root.join("external-oracles");
        std::fs::create_dir_all(&external_cases).unwrap();
        std::fs::create_dir_all(&external_oracles).unwrap();
        std::fs::write(
            external_cases.join("ancestor-link.html"),
            b"<p>external</p>",
        )
        .unwrap();
        std::fs::write(external_oracles.join("ancestor-link.pdf"), b"%PDF external").unwrap();
        std::fs::remove_dir(corpus.parity.join("cases/test")).unwrap();
        std::fs::remove_dir(corpus.parity.join("oracles/test")).unwrap();
        std::os::unix::fs::symlink(&external_cases, corpus.parity.join("cases/test")).unwrap();
        std::os::unix::fs::symlink(&external_oracles, corpus.parity.join("oracles/test")).unwrap();

        let issues = audit_corpus(
            &corpus.root,
            &corpus.parity.join("manifest"),
            &corpus.parity,
            &[entry],
        )
        .unwrap();
        let symlinks = issues
            .iter()
            .find(|issue| issue.kind == CorpusIssueKind::Symlink)
            .expect("ancestor symlinks must be structured corpus evidence");
        assert!(
            symlinks
                .fixtures
                .iter()
                .any(|fixture| fixture.contains("cases/test"))
        );
        assert!(
            symlinks
                .fixtures
                .iter()
                .any(|fixture| fixture.contains("oracles/test"))
        );
    }
}
