//! Report data model (also the regression baseline schema), the per-fixture
//! result constructors, and all artifact writers: `report.json`, `REPORT.md`,
//! and the in-repo visual HTML galleries.
//!
//! Extracted verbatim from the former monolithic `mod.rs` (C1 mechanical split).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::config::{
    PAPER_CONTENT_JND, VISUAL_BALANCED_EDGE_COLOR_MAX_BIAS,
    VISUAL_BALANCED_EDGE_COMPONENT_MAX_BIAS, VISUAL_BALANCED_EDGE_COMPONENT_MAX_SPAN_CSS_PX,
    VISUAL_BALANCED_EDGE_COMPONENT_MIN_AREA_CSS_PX2, VISUAL_COHERENT_OUTLINE_MAX_COMPONENTS,
    VISUAL_COLOR_CHANNEL_TOLERANCE_PCT, VISUAL_COLOR_JND, VISUAL_COVERAGE_RAMP_MIN_PROVEN_RATIO,
    VISUAL_EDGE_COLOR_PCT, VISUAL_EDGE_PRESENCE_PCT, VISUAL_INTERIOR_COLOR_PCT,
    VISUAL_MIXED_COVERAGE_MAX_BALANCE_BIAS, VISUAL_MIXED_COVERAGE_MAX_INTERIOR_COLOR_PCT,
    VISUAL_MIXED_COVERAGE_MAX_PRESENCE_PCT, VISUAL_MIXED_COVERAGE_MIN_COLOR_TO_PRESENCE_RATIO,
    VISUAL_ONE_SIDED_COVERAGE_MAX_PRESENCE_PCT,
    VISUAL_ONE_SIDED_COVERAGE_MIN_COLOR_TO_PRESENCE_RATIO,
    VISUAL_ONE_SIDED_COVERAGE_MIN_SHARED_CONTENT_RATIO, VISUAL_PASS_MAX_SEMANTIC_DIFF_PCT,
    VISUAL_PRESENCE_COMPONENT_AREA_CSS_PX2, VISUAL_PRESENCE_COMPONENT_SPAN_CSS_PX,
    VISUAL_PRESENCE_TOTAL_AREA_CSS_PX2, VISUAL_SUB_AUTHORED_COLOR_FRONTIER_MAX_CSS_PX,
};
use super::diagnose::Diagnosis;
use super::manifest::{ManifestEntry, ReferenceAssessment};
use super::overlay::{LEGEND_ORDER, class_label, class_rgb};
use super::util::sha256_hex;

// ---------------------------------------------------------------------------
// Report schema (also the regression baseline)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Status {
    #[serde(rename = "PASS")]
    Pass,
    #[serde(rename = "FAIL")]
    Fail,
    /// The candidate and committed oracle visibly differ, but standard review
    /// has established that the oracle is not a conformance target. Keep the
    /// comparison evidence as a first-class canary without calling it an
    /// Ironpress rendering failure.
    #[serde(rename = "REFERENCE-DISPUTED")]
    ReferenceDisputed,
}

impl Status {
    pub(crate) fn score_value(self) -> Option<f64> {
        match self {
            Status::Pass => Some(1.0),
            Status::Fail => Some(0.0),
            Status::ReferenceDisputed => None,
        }
    }

    pub(crate) fn is_failure(self) -> bool {
        self == Self::Fail
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Status::Pass => "PASS",
            Status::Fail => "FAIL",
            Status::ReferenceDisputed => "REFERENCE-DISPUTED",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct FixtureResult {
    pub(crate) id: String,
    pub(crate) category: String,
    pub(crate) feature: String,
    #[serde(default)]
    pub(crate) subfeature: String,
    #[serde(default)]
    pub(crate) interaction_of: Vec<String>,
    #[serde(default)]
    pub(crate) base_ids: Vec<String>,
    pub(crate) status: Status,
    /// Exact complete-page RGBA mismatch rate.
    pub(crate) diff_pct: f64,
    /// Complete-page mismatch rate after the global per-pixel RGB tolerance.
    /// This is the population painted into the classed diff artifact.
    #[serde(default)]
    pub(crate) semantic_diff_pct: f64,
    #[serde(default)]
    pub(crate) description: String,
    #[serde(default)]
    pub(crate) note: String,
    // ---- declared dependency context ----
    #[serde(default = "super::manifest::default_kind")]
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) depends_on: Vec<String>,
    #[serde(default = "super::manifest::default_expected_support")]
    pub(crate) expected_support: String,
    /// Reference ORACLE that produced `oracles/<cat>/<id>.pdf` ("chrome" default,
    /// "weasyprint" for CSS GCPM features Chrome's print path renders blank,
    /// "none" = no oracle). Surfaced in the report so a non-Chrome comparison is
    /// clearly labelled (Chrome+Paged.js marked unsupported for that fixture).
    #[serde(default = "super::manifest::default_oracle")]
    pub(crate) oracle: String,
    /// Standard-review state of the committed oracle. A disputed reference is
    /// prominently surfaced so it cannot be mistaken for a candidate bug.
    #[serde(default)]
    pub(crate) reference: ReferenceAssessment,
    /// Declared dependencies that also fail. Empty means no declared dependency
    /// failure. This is context only and deliberately makes no causal claim.
    #[serde(default)]
    pub(crate) dependency_context: String,
    /// SHA-256 of the fixture HTML (`cases/<cat>/<id>.html`), lowercase hex. Used
    /// to verify the committed oracle PDF is still fresh against `refs.lock`. Not
    /// part of the regression baseline comparison; carried for the freshness check.
    #[serde(default)]
    pub(crate) html_sha256: String,
    /// Exact runtime evidence for both sides of the comparison. Page hashes are
    /// identities, while `painted_pixels` proves that byte equality did not come
    /// from comparing two empty documents.
    #[serde(default)]
    pub(crate) raster: RasterEvidence,
    /// Per-fixture diagnosis: primary error class, human headline, magnitudes,
    /// and per-region breakdown. Retained for a visual PASS when raw exact
    /// evidence remains, so an imperceptible residual is never hidden.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) diagnosis: Option<super::diagnose::Diagnosis>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct RasterFingerprint {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) rgba_sha256: String,
    pub(crate) painted_pixels: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct RasterEvidence {
    pub(crate) candidate: Vec<RasterFingerprint>,
    pub(crate) oracle: Vec<RasterFingerprint>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CorpusIssueKind {
    DuplicateFixture,
    DuplicateOracle,
    EmptyFixture,
    InvalidOracle,
    MissingPaint,
    NonCanonicalPath,
    Symlink,
    UnpinnedUa,
}

impl CorpusIssueKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::DuplicateFixture => "duplicate-fixture",
            Self::DuplicateOracle => "duplicate-oracle",
            Self::EmptyFixture => "empty-fixture",
            Self::InvalidOracle => "invalid-oracle",
            Self::MissingPaint => "missing-paint",
            Self::NonCanonicalPath => "noncanonical-path",
            Self::Symlink => "symlink",
            Self::UnpinnedUa => "unpinned-ua",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct CorpusIssue {
    pub(crate) kind: CorpusIssueKind,
    pub(crate) fixtures: Vec<String>,
    pub(crate) detail: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub(crate) struct Counts {
    pub(crate) pass: u32,
    pub(crate) fail: u32,
    #[serde(default)]
    pub(crate) reference_disputed: u32,
}

impl Counts {
    pub(crate) fn add(&mut self, s: Status) {
        match s {
            Status::Pass => self.pass += 1,
            Status::Fail => self.fail += 1,
            Status::ReferenceDisputed => self.reference_disputed += 1,
        }
    }

    pub(crate) fn total(&self) -> u32 {
        self.pass + self.fail + self.reference_disputed
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct FeatureReport {
    pub(crate) feature: String,
    pub(crate) score_pct: f64,
    pub(crate) counts: Counts,
    pub(crate) fixtures: Vec<FixtureResult>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct CategoryReport {
    pub(crate) category: String,
    pub(crate) score_pct: f64,
    pub(crate) counts: Counts,
    pub(crate) features: Vec<FeatureReport>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct Overall {
    pub(crate) score_pct: f64,
    pub(crate) pass: u32,
    pub(crate) fail: u32,
    #[serde(default)]
    pub(crate) reference_disputed: u32,
    pub(crate) total: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct EnvBlock {
    pub(crate) dpi: u32,
    pub(crate) pdftoppm_available: bool,
    #[serde(default)]
    pub(crate) rasterizer_source_path: String,
    #[serde(default)]
    pub(crate) rasterizer_executed_path: String,
    #[serde(default)]
    pub(crate) rasterizer_arguments: String,
    #[serde(default)]
    pub(crate) rasterizer_version: String,
    /// SHA-256 of the exact executable used for both oracle and candidate PDFs.
    #[serde(default)]
    pub(crate) rasterizer_sha256: String,
}

/// One entry in the declared-dependency canary list, ordered by how many
/// non-PASS fixtures name it. The ranking deliberately makes no causal claim.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct FixFirst {
    pub(crate) id: String,
    pub(crate) feature: String,
    pub(crate) status: String,
    pub(crate) dependent_failure_count: u32,
    pub(crate) dependent_failure_ids: Vec<String>,
}

/// Honest breadth metrics. Deliberately NOT a percentage of "all of CSS": there
/// is no credible denominator for that, so any "X/199 = 100%" figure is a
/// tautology. Instead we report (a) how many distinct category/feature pairs
/// have at least one fixture, and (b) the fixture count by expected_support.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub(crate) struct Coverage {
    /// Number of distinct (category/feature) pairs with >= 1 fixture.
    pub(crate) features_with_fixture: u32,
    /// Those distinct (category/feature) labels.
    pub(crate) covered: Vec<String>,
    /// Fixture counts grouped by `expected_support`.
    pub(crate) implemented: u32,
    pub(crate) partial: u32,
    pub(crate) unsupported: u32,
    /// Supported feature-family product, counted as unordered pairs with the
    /// diagonal included. This denominator is derived from the actual manifest,
    /// unlike the open-ended category/feature breadth labels above.
    #[serde(default)]
    pub(crate) interaction_families: u32,
    #[serde(default)]
    pub(crate) interaction_pairs_required: u32,
    #[serde(default)]
    pub(crate) interaction_pairs_covered: u32,
    #[serde(default)]
    pub(crate) interaction_pairs_missing: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct Report {
    pub(crate) schema_version: u32,
    /// Opaque identity supplied by an external full-run launcher. It lets that
    /// launcher distinguish this invocation's report from durable stale evidence.
    /// Direct runs and committed baselines omit it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) invocation_id: String,
    /// False for an in-progress marker or a terminal setup/publication failure.
    #[serde(default)]
    pub(crate) run_complete: bool,
    pub(crate) env: EnvBlock,
    pub(crate) overall: Overall,
    pub(crate) categories: Vec<CategoryReport>,
    /// Fail-closed corpus/runtime evidence problems, kept structured so reports
    /// can place every implicated fixture at the top of the worklist.
    #[serde(default)]
    pub(crate) corpus_issues: Vec<CorpusIssue>,
    #[serde(default)]
    pub(crate) coverage: Coverage,
    #[serde(default)]
    pub(crate) fix_first: Vec<FixFirst>,
    /// Manifest ids whose expected oracle PDF is absent while its category has
    /// unclaimed PDF files: the likely id/filename mismatch case.
    #[serde(default)]
    pub(crate) ref_mismatches: Vec<RefMismatch>,
    /// Fixtures that are tagged `expected_support == "unsupported"` yet scored
    /// PASS — the tag or the feature implementation is suspect.
    #[serde(default)]
    pub(crate) suspect_unsupported_pass: Vec<String>,
    /// Fixtures whose committed oracle PDF is stale relative to `refs.lock`.
    /// Surfaced here so the integrity gate can require regeneration. Empty plus
    /// `refs_lock_present == false` means no valid schema-4 lock was committed.
    #[serde(default)]
    pub(crate) stale_refs: Vec<StaleRef>,
    /// Whether a `refs.lock` file was present and parsed. When false, no freshness
    /// claim can be made (every fixture is implicitly "unverified").
    #[serde(default)]
    pub(crate) refs_lock_present: bool,
    /// SHA-256 of the complete authenticated refs.lock. Because that lock binds
    /// fixture metadata, HTML, oracle kind, PDF bytes, and provenance, baseline
    /// comparison can reject a changed corpus/oracle identity even when every
    /// raster happens to remain PASS.
    #[serde(default)]
    pub(crate) refs_lock_sha256: String,
    /// Whether the separate committed regression baseline parsed, is an
    /// internally consistent snapshot (with FAIL and disputed evidence retained),
    /// uses this report schema, and binds the current refs.lock and rasterizer.
    #[serde(default)]
    pub(crate) baseline_present: bool,
    /// Exact terminal run or gate failure returned by this invocation. `None`
    /// means no terminal cause has been recorded; setup failures remain
    /// distinguishable from completed gate outcomes through `run_complete`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) gate_failure: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct StaleRef {
    pub(crate) id: String,
    pub(crate) category: String,
    /// "absent-from-lock" or "hash-mismatch".
    pub(crate) reason: String,
    /// Current SHA-256 of `cases/<cat>/<id>.html`.
    pub(crate) current_sha256: String,
    /// The hash recorded in refs.lock (empty when absent).
    pub(crate) locked_sha256: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct RefMismatch {
    pub(crate) id: String,
    pub(crate) category: String,
    pub(crate) expected_ref: String,
    /// Unclaimed oracle PDF file names present in the same category dir.
    pub(crate) orphan_refs: Vec<String>,
}

impl Report {
    /// Flat id -> result lookup across the whole report.
    pub(crate) fn by_id(&self) -> BTreeMap<&str, &FixtureResult> {
        let mut m = BTreeMap::new();
        for c in &self.categories {
            for f in &c.features {
                for fx in &f.fixtures {
                    m.insert(fx.id.as_str(), fx);
                }
            }
        }
        m
    }
}

// ---------------------------------------------------------------------------
// Result constructors
// ---------------------------------------------------------------------------

pub(crate) fn fixture_base(
    entry: &ManifestEntry,
    status: Status,
    diff_pct: f64,
    note: String,
) -> FixtureResult {
    FixtureResult {
        id: entry.id.clone(),
        category: entry.category.clone(),
        feature: entry.feature.clone(),
        subfeature: entry.subfeature.clone(),
        interaction_of: entry.interaction_of.clone(),
        base_ids: entry.base_ids.clone(),
        status,
        diff_pct,
        semantic_diff_pct: diff_pct,
        description: entry.description.clone(),
        note,
        kind: entry.kind.clone(),
        depends_on: entry.depends_on.clone(),
        expected_support: entry.expected_support.clone(),
        oracle: entry.oracle.clone(),
        reference: entry.reference.clone(),
        dependency_context: String::new(),
        html_sha256: String::new(),
        raster: RasterEvidence::default(),
        diagnosis: None,
    }
}

pub(crate) fn fixture_fail(entry: &ManifestEntry, diff_pct: f64, note: String) -> FixtureResult {
    fixture_base(entry, Status::Fail, diff_pct, note)
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/// Exact bytes and identity shared by all three report surfaces. Markdown and
/// HTML embed the digest of the JSON file they describe, so two checkpoints in
/// one invocation cannot be mistaken for one coherent publication.
struct SerializedReport {
    bytes: Vec<u8>,
    sha256: String,
}

impl SerializedReport {
    fn new(report: &Report) -> Result<Self, String> {
        let mut bytes = serde_json::to_vec_pretty(report).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        let sha256 = sha256_hex(&bytes);
        Ok(Self { bytes, sha256 })
    }
}

pub(crate) fn write_report_json(path: &Path, report: &Report) -> Result<(), String> {
    write_atomic(path, &SerializedReport::new(report)?.bytes)
}

/// Publish one coherent JSON/Markdown/HTML cohort while serializing the large
/// machine report exactly once.
pub(crate) fn write_report_artifacts(
    json_path: &Path,
    markdown_path: &Path,
    reports_dir: &Path,
    cases_dir: &Path,
    report: &Report,
) -> Result<(), String> {
    let serialized = SerializedReport::new(report)?;
    // JSON is the cohort commit marker: publish both human surfaces first and
    // replace report.json only after they carry this exact future JSON digest.
    write_report_md_identified(markdown_path, report, &serialized.sha256)?;
    write_html_reports_identified(reports_dir, cases_dir, report, &serialized.sha256)?;
    write_atomic(json_path, &serialized.bytes)
}

/// Publish one complete file with rename visibility. This deliberately makes no
/// power-loss durability claim; callers only rely on readers seeing the old or
/// new complete file, never a partially written one.
fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("report path has no parent: {}", path.display()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid report path: {}", path.display()))?;
    let temporary = parent.join(format!(".{file_name}.tmp"));
    remove_artifact(&temporary)
        .map_err(|error| format!("cannot clear {}: {error}", temporary.display()))?;
    std::fs::write(&temporary, contents)
        .map_err(|error| format!("cannot write {}: {error}", temporary.display()))?;
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = remove_artifact(&temporary);
        return Err(format!("cannot publish {}: {error}", path.display()));
    }
    Ok(())
}

fn remove_artifact(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || metadata.is_file() => {
            std::fs::remove_file(path)
        }
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn fixtures(report: &Report) -> impl Iterator<Item = &FixtureResult> {
    report
        .categories
        .iter()
        .flat_map(|category| category.features.iter())
        .flat_map(|feature| feature.fixtures.iter())
}

/// Coarse, directly-observed triage for the attention list. This deliberately
/// says nothing about root cause: it keeps failures whose policy-triggering
/// evidence is Missing/Extra ahead of colour-only residuals, whose raw pixel
/// count can otherwise look disproportionately severe at a glance.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum FailureTriage {
    DirectPaintMismatch,
    ColorOnlyResidual,
    NoRasterDiagnosis,
}

impl FailureTriage {
    fn rank(self) -> u8 {
        match self {
            Self::DirectPaintMismatch => 0,
            Self::ColorOnlyResidual => 1,
            Self::NoRasterDiagnosis => 2,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::DirectPaintMismatch => "direct paint mismatch",
            Self::ColorOnlyResidual => "colour-only residual",
            Self::NoRasterDiagnosis => "no raster diagnosis",
        }
    }

    fn explanation(self) -> &'static str {
        match self {
            Self::DirectPaintMismatch => {
                "Missing/Extra paint is the policy-triggering defect; inspect first"
            }
            Self::ColorOnlyResidual => {
                "colour/coverage is the policy-triggering defect; review at authored scale"
            }
            Self::NoRasterDiagnosis => "no per-pixel diagnosis was produced",
        }
    }
}

fn failure_triage(fixture: &FixtureResult) -> FailureTriage {
    let Some(diagnosis) = fixture.diagnosis.as_ref() else {
        return FailureTriage::NoRasterDiagnosis;
    };
    if matches!(diagnosis.primary_class.as_str(), "Missing" | "Extra") {
        FailureTriage::DirectPaintMismatch
    } else {
        FailureTriage::ColorOnlyResidual
    }
}

struct AttentionWorklist<'a> {
    integrity: Vec<String>,
    baseline_missing: bool,
    suspects: &'a [String],
    failures: Vec<&'a FixtureResult>,
    reference_disputes: Vec<&'a FixtureResult>,
    /// A gate cause counts separately only when no structured leaf already
    /// describes it. The gate is always shown as a banner, never duplicated as
    /// another table row beside the failures it summarizes.
    terminal_only: bool,
}

impl<'a> AttentionWorklist<'a> {
    fn new(report: &'a Report) -> Self {
        let integrity = super::gate::current_integrity_problems(report);
        let baseline_missing = !report.baseline_present;
        let mut failures: Vec<_> = fixtures(report)
            .filter(|fixture| fixture.status.is_failure())
            .collect();
        failures.sort_by(|left, right| {
            failure_triage(left)
                .rank()
                .cmp(&failure_triage(right).rank())
                .then(
                    right
                        .diff_pct
                        .partial_cmp(&left.diff_pct)
                        .unwrap_or(std::cmp::Ordering::Equal),
                )
                .then(left.category.cmp(&right.category))
                .then(left.id.cmp(&right.id))
        });
        let mut reference_disputes: Vec<_> = fixtures(report)
            .filter(|fixture| fixture.status == Status::ReferenceDisputed)
            .collect();
        reference_disputes.sort_by(|left, right| {
            right
                .diff_pct
                .partial_cmp(&left.diff_pct)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(left.category.cmp(&right.category))
                .then(left.id.cmp(&right.id))
        });
        let leaf_count = integrity.len()
            + usize::from(baseline_missing)
            + report.suspect_unsupported_pass.len()
            + failures.len()
            + reference_disputes.len();
        Self {
            integrity,
            baseline_missing,
            suspects: &report.suspect_unsupported_pass,
            failures,
            reference_disputes,
            terminal_only: report.gate_failure.is_some() && leaf_count == 0,
        }
    }

    fn len(&self) -> usize {
        self.integrity.len()
            + usize::from(self.baseline_missing)
            + self.suspects.len()
            + self.failures.len()
            + self.reference_disputes.len()
            + usize::from(self.terminal_only)
    }

    fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Keep the report headline honest about whether the work is an actual
    /// rendering failure, a report-integrity concern, or a coverage-label
    /// audit. A single total obscures that distinction at a glance.
    fn summary(&self) -> String {
        let mut parts = Vec::new();
        if !self.failures.is_empty() {
            parts.push(format!("{} failing fixture(s)", self.failures.len()));
        }

        if !self.reference_disputes.is_empty() {
            parts.push(format!(
                "{} disputed reference(s)",
                self.reference_disputes.len()
            ));
        }

        let integrity_items = self.integrity.len() + usize::from(self.baseline_missing);
        if integrity_items != 0 {
            parts.push(format!("{integrity_items} integrity item(s)"));
        }

        if !self.suspects.is_empty() {
            parts.push(format!("{} support-label item(s)", self.suspects.len()));
        }

        if self.terminal_only {
            parts.push("1 gate item".to_string());
        }

        if parts.is_empty() {
            "none".to_string()
        } else {
            parts.join(" · ")
        }
    }
}

/// Compact audit of successful fixtures which still have exact raster variance.
/// The fixture card retains each diagnosis; this header only makes the policy
/// path and total visible before a reader expands the PASS rows.
struct VisualPassAudit {
    exact: usize,
    nonidentical: usize,
    max_raw_diff_pct: f64,
    by_basis: BTreeMap<String, usize>,
}

impl VisualPassAudit {
    fn new(report: &Report) -> Self {
        let mut audit = Self {
            exact: 0,
            nonidentical: 0,
            max_raw_diff_pct: 0.0,
            by_basis: BTreeMap::new(),
        };
        for fixture in fixtures(report) {
            if fixture.status != Status::Pass {
                continue;
            }
            if fixture.diff_pct == 0.0 {
                audit.exact += 1;
                continue;
            }
            audit.nonidentical += 1;
            audit.max_raw_diff_pct = audit.max_raw_diff_pct.max(fixture.diff_pct);
            let basis = fixture
                .diagnosis
                .as_ref()
                .map(|diagnosis| diagnosis.visual_pass_basis.as_str())
                .filter(|basis| !basis.is_empty())
                .unwrap_or("unclassified visual pass");
            *audit.by_basis.entry(basis.to_string()).or_default() += 1;
        }
        audit
    }

    fn summary(&self) -> Option<String> {
        let bases = self
            .by_basis
            .iter()
            .map(|(basis, count)| format!("{} {count}", compact_pass_basis(basis)))
            .collect::<Vec<_>>()
            .join(" · ");
        let exact_label = if self.exact == 1 { "PASS" } else { "PASSes" };
        if self.nonidentical == 0 {
            return Some(format!("Raster audit: {} exact {exact_label}", self.exact));
        }
        Some(format!(
            "Raster audit: {} exact {exact_label} · {} visual-policy PASSes (max raw difference {}; {bases})",
            self.exact,
            self.nonidentical,
            display_diff_pct(self.max_raw_diff_pct),
        ))
    }
}

fn compact_pass_basis(basis: &str) -> &str {
    match basis {
        "raw same-coordinate visibility policy" => "raw policy",
        "CSS-scale observation: no visible direct-presence residue" => "CSS no-presence",
        "CSS-scale observation: outer one-device-pixel edge" => "CSS outer edge",
        "CSS-scale observation: shared outline coverage" => "CSS shared outline",
        "CSS-scale observation: shared-outline color-coverage phase" => "CSS outline color phase",
        "CSS-scale observation: mixed outline coverage" => "CSS mixed outline phase",
        "CSS-scale observation: sub-CSS direct-paint components" => "CSS sub-CSS components",
        other => other,
    }
}

fn gate_banner(report: &Report, terminal_only: bool) -> Option<(&'static str, &str)> {
    let failure = report.gate_failure.as_deref()?;
    let label = if report.run_complete {
        "REGRESSION"
    } else {
        "RUN FAILURE"
    };
    let detail = if terminal_only {
        failure
    } else {
        failure.lines().next().unwrap_or(failure)
    };
    Some((label, detail))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn rasterizer_identity_ok(report: &Report) -> bool {
    report.env.pdftoppm_available
        && !report.env.rasterizer_source_path.is_empty()
        && !report.env.rasterizer_executed_path.is_empty()
        && !report.env.rasterizer_arguments.is_empty()
        && !report.env.rasterizer_version.is_empty()
        && is_sha256(&report.env.rasterizer_sha256)
}

fn md_cell(value: &str) -> String {
    value
        .replace('|', "\\|")
        .replace(['\r', '\n'], " ")
        .trim()
        .to_string()
}

fn display_diff_pct(value: f64) -> String {
    // Never turn a real diff into a threshold-looking label. The comparator
    // has no cutoff; the report must not imply one through formatting either.
    // Six fractional places are enough to distinguish the smallest observed
    // page-level signal while keeping ordinary rows compact.
    if value == 0.0 {
        "0%".to_string()
    } else if value.abs() < 0.01 {
        format!("{value:.6}%")
    } else {
        format!("{value:.2}%")
    }
}

fn max_attention_diff(category: &CategoryReport) -> f64 {
    category
        .features
        .iter()
        .flat_map(|feature| &feature.fixtures)
        .filter(|fixture| fixture.status != Status::Pass)
        .map(|fixture| fixture.diff_pct)
        .fold(0.0, f64::max)
}

/// Compact measured value which never rounds a nonzero signal to a displayed
/// zero. Values below the useful two-decimal display floor remain explicitly
/// visible instead of disappearing.
fn display_measure(value: f64) -> String {
    let magnitude = value.abs();
    if magnitude == 0.0 {
        "0".to_string()
    } else if magnitude < 0.01 {
        format!("{magnitude:.6}")
    } else if magnitude < 0.1 {
        format!("{magnitude:.2}")
    } else {
        format!("{magnitude:.1}")
    }
}

fn display_html_measure(value: f64) -> String {
    html_escape(&display_measure(value))
}

fn fixture_anchor(id: &str) -> String {
    format!("fixture-{}", feat_slug(id))
}

fn preview_pages(root: &Path, category: &str, id: &str, diff: bool) -> BTreeSet<usize> {
    let directory = root.join(category);
    let mut pages = BTreeSet::new();
    let first = if diff {
        format!("{id}.diff.png")
    } else {
        format!("{id}.png")
    };
    if directory.join(first).is_file() {
        pages.insert(1);
    }
    let Ok(entries) = std::fs::read_dir(directory) else {
        return pages;
    };
    let prefix = format!("{id}.p");
    let suffix = if diff { ".diff.png" } else { ".png" };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Some(number) = name
            .strip_prefix(&prefix)
            .and_then(|rest| rest.strip_suffix(suffix))
            .filter(|digits| !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|digits| digits.parse::<usize>().ok())
            .filter(|number| *number >= 2)
        {
            pages.insert(number);
        }
    }
    pages
}

fn preview_figure(src: &str, label: &str, available: bool) -> String {
    if available {
        format!(
            "<figure><img loading=\"lazy\" src=\"{}\" alt=\"{}\"><figcaption>{}</figcaption></figure>",
            html_escape(src),
            html_escape(label),
            html_escape(label),
        )
    } else {
        format!(
            "<figure><div class=\"unavailable\">not generated</div><figcaption>{}</figcaption></figure>",
            html_escape(label),
        )
    }
}

fn md_fixture_link(category: &str, id: &str) -> String {
    format!(
        "[`{}`](cases/{}/{}.html)",
        md_cell(id),
        md_cell(category),
        md_cell(id),
    )
}

fn push_md_attention_row(
    output: &mut String,
    issue: &str,
    category: &str,
    fixture: &str,
    detail: &str,
) {
    output.push_str(&format!(
        "| {} | {} | {} | {} |\n",
        md_cell(issue),
        md_cell(category),
        fixture,
        md_cell(detail)
    ));
}

pub(crate) fn write_report_md(path: &Path, report: &Report) -> Result<(), String> {
    let serialized = SerializedReport::new(report)?;
    write_report_md_identified(path, report, &serialized.sha256)
}

fn write_report_md_identified(
    path: &Path,
    report: &Report,
    json_sha256: &str,
) -> Result<(), String> {
    let mut o = String::new();
    let worklist = AttentionWorklist::new(report);
    let ov = &report.overall;
    let attention = worklist.len();
    let attention_summary = worklist.summary();
    let visual_pass_audit = VisualPassAudit::new(report);
    let health = if report.gate_failure.is_none() && worklist.is_empty() {
        "OK"
    } else {
        "BROKEN"
    };
    o.push_str("# ironpress parity health\n\n");
    o.push_str(&format!(
        "<!-- parity-invocation-id: {} -->\n\n",
        report.invocation_id
    ));
    o.push_str(&format!(
        "<!-- parity-report-json-sha256: {json_sha256} -->\n\n"
    ));
    o.push_str("| health | verified visual parity | exact raster | visual-policy | FAIL | disputed refs | total |\n");
    o.push_str("|:------:|-----------------------:|-------------:|--------------:|-----:|--------------:|------:|\n");
    o.push_str(&format!(
        "| **{health}** | {:.2}% | {} | {} | {} | {} | {} |\n\n",
        ov.score_pct,
        visual_pass_audit.exact,
        visual_pass_audit.nonidentical,
        ov.fail,
        ov.reference_disputed,
        ov.total
    ));
    o.push_str(&format!(
        "**Needs attention: {attention_summary}.** PASS rule: a fixed, same-coordinate human-visibility policy is applied after both PDFs use the same pdftoppm executable and arguments. It never translates, registers, or fixture-tunes either image. Every raw RGBA difference remains reported.\n\nScope: {} category/feature pairs · labels only: implemented {} · partial {} · unsupported {} · supported-family interactions {}/{} across {} families.\n\n",
        report.coverage.features_with_fixture,
        report.coverage.implemented,
        report.coverage.partial,
        report.coverage.unsupported,
        report.coverage.interaction_pairs_covered,
        report.coverage.interaction_pairs_required,
        report.coverage.interaction_families
    ));
    if let Some(summary) = visual_pass_audit.summary() {
        o.push_str(&format!(
        "**{summary}.** Each visual-policy fixture card keeps its raw difference and policy basis.\n\n"
        ));
    }

    let integrity_broken = !worklist.integrity.is_empty()
        || worklist.baseline_missing
        || report.gate_failure.is_some();
    o.push_str("## Integrity\n\n");
    o.push_str("| state | run | gate | pdftoppm | refs.lock identity | baseline | stale refs | ref mismatches |\n");
    o.push_str("|:-----:|-----|------|----------|--------------------|----------|-----------:|---------------:|\n");
    o.push_str(&format!(
        "| **{}** | {} | {} | {} | {} | {} | {} | {} |\n\n",
        if integrity_broken { "BROKEN" } else { "OK" },
        if report.run_complete {
            "complete"
        } else {
            "INCOMPLETE"
        },
        if report.gate_failure.is_some() {
            "FAILED"
        } else if report.run_complete {
            "passed"
        } else {
            "pending"
        },
        if rasterizer_identity_ok(report) {
            "OK"
        } else if report.env.pdftoppm_available {
            "INVALID"
        } else {
            "MISSING"
        },
        if report.refs_lock_present && is_sha256(&report.refs_lock_sha256) {
            "authenticated"
        } else {
            "MISSING/INVALID"
        },
        if report.baseline_present {
            "valid/compatible"
        } else {
            "MISSING/INVALID/INCOMPATIBLE"
        },
        report.stale_refs.len(),
        report.ref_mismatches.len(),
    ));

    if let Some((label, detail)) = gate_banner(report, worklist.terminal_only) {
        o.push_str("### Gate result\n\n");
        o.push_str(&format!("**{label} — FAILED.** {}\n\n", md_cell(detail)));
    }

    // One worklist: actual rendering failures, disputed oracles, and integrity
    // evidence are deliberately not scattered across separate sections.
    let by_id = report.by_id();
    let failures = &worklist.failures;
    let reference_disputes = &worklist.reference_disputes;

    if !report.fix_first.is_empty() {
        o.push_str("## Declared dependency canaries\n\n");
        o.push_str("Failing canaries ranked by how many other failing fixtures declare them. This is reach/triage metadata only: it does not prove causality or that a named CSS feature is wrong.\n\n");
        o.push_str(
            "| dependency canary | measured concern | visual result | failing dependents |\n",
        );
        o.push_str(
            "|-------------------|------------------|--------------|-------------------:|\n",
        );
        for blocker in &report.fix_first {
            let category = by_id
                .get(blocker.id.as_str())
                .map_or("probes", |fixture| fixture.category.as_str());
            o.push_str(&format!(
                "| {} | {} | {} | {} |\n",
                md_fixture_link(category, &blocker.id),
                md_cell(&blocker.feature),
                md_cell(&blocker.status),
                blocker.dependent_failure_count
            ));
        }
        o.push('\n');
    }

    if !failures.is_empty() {
        let mut triage_groups: BTreeMap<FailureTriage, usize> = BTreeMap::new();
        for fixture in failures {
            let triage = failure_triage(fixture);
            *triage_groups.entry(triage).or_default() += 1;
        }
        let mut triage_groups: Vec<(FailureTriage, usize)> = triage_groups.into_iter().collect();
        triage_groups.sort_by(|left, right| {
            left.0
                .rank()
                .cmp(&right.0.rank())
                .then(right.1.cmp(&left.1))
        });
        o.push_str("## Failure triage\n\n");
        o.push_str("Direct paint mismatches are listed before colour-only residuals. Both remain FAIL under the fixed human-visibility policy; this grouping makes raw edge-pixel volume a secondary signal rather than the work order.\n\n");
        o.push_str("| direct evidence | fixtures | how to read it |\n");
        o.push_str("|-----------------|---------:|----------------|\n");
        for (triage, count) in triage_groups {
            o.push_str(&format!(
                "| {} | {} | {} |\n",
                md_cell(triage.label()),
                count,
                md_cell(triage.explanation())
            ));
        }
        o.push('\n');

        let mut groups: BTreeMap<&str, usize> = BTreeMap::new();
        for fixture in failures {
            *groups.entry(diag_class(fixture)).or_default() += 1;
        }
        let mut groups: Vec<(&str, usize)> = groups.into_iter().collect();
        groups.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(right.0)));
        o.push_str("## Failure groups\n\n");
        o.push_str("Raster-output symptoms, not inferred root causes.\n\n");
        o.push_str("| raster symptom | fixtures |\n");
        o.push_str("|----------------|---------:|\n");
        for (class, count) in groups {
            o.push_str(&format!("| {} | {} |\n", md_cell(class), count));
        }
        o.push('\n');
    }

    o.push_str("## Needs attention\n\n");
    if attention == 0 {
        o.push_str("Nothing unexpected or unverified.\n\n");
    } else {
        let failure_count = failures.len();
        let dispute_count = reference_disputes.len();
        o.push_str(&format!(
            "Integrity problems first, then all {failure_count} rendering failure(s) and {dispute_count} disputed reference(s). A disputed reference retains its raw comparison evidence but is not a candidate verdict. The gate result is summarized once above. Support labels provide context only and never hide a defect. Generated-local visual inventory: `reports/index.html`.\n\n",
        ));
        if !worklist.terminal_only {
            o.push_str("| issue | category | fixture | detail |\n");
            o.push_str("|-------|----------|---------|--------|\n");
        }

        for problem in &worklist.integrity {
            push_md_attention_row(&mut o, "INTEGRITY", "—", "—", &problem);
        }
        if worklist.baseline_missing {
            push_md_attention_row(
                &mut o,
                "INTEGRITY",
                "—",
                "—",
                "baseline.json is missing, invalid, or incompatible; regression comparison is unavailable",
            );
        }
        for id in worklist.suspects {
            let (category, fixture) = by_id
                .get(id.as_str())
                .map(|fx| (fx.category.as_str(), md_fixture_link(&fx.category, &fx.id)))
                .unwrap_or(("—", format!("`{}`", md_cell(id))));
            push_md_attention_row(
                &mut o,
                "SUSPECT",
                category,
                &fixture,
                "tagged unsupported but PASS; re-check the tag and fixture",
            );
        }
        for (issue, fx) in failures.iter().copied().map(|fx| ("FAIL", fx)).chain(
            reference_disputes
                .iter()
                .copied()
                .map(|fx| ("REFERENCE-DISPUTED", fx)),
        ) {
            let mut detail = format!(
                "{} · {} · {} · above-floor diff {} · raw RGBA diff {}",
                fx.feature,
                failure_triage(fx).label(),
                diag_class(fx),
                display_diff_pct(fx.semantic_diff_pct),
                display_diff_pct(fx.diff_pct)
            );
            if let Some(diagnosis) = fx
                .diagnosis
                .as_ref()
                .filter(|diagnosis| diagnosis.different_pixels > 0)
            {
                detail.push_str(&format!(
                    " · {} differing RGBA pixels",
                    diagnosis.different_pixels
                ));
            }
            if fx.expected_support != "implemented" {
                detail.push_str(&format!(" · expected {}", fx.expected_support));
            }
            if fx.reference.is_disputed() {
                detail.push_str(&format!(" · REFERENCE DISPUTED: {}", fx.reference.note));
            }
            if !fx.dependency_context.is_empty() {
                detail.push_str(&format!(" · {}", fx.dependency_context));
            }
            if let Some(reason) = diag_reason(fx).filter(|r| !r.is_empty()) {
                detail.push_str(&format!(" · {reason}"));
            } else if !fx.note.is_empty() {
                detail.push_str(&format!(" · {}", fx.note));
            }
            if !fx.interaction_of.is_empty() {
                let interaction = interaction_kind(fx, &by_id);
                if !interaction.is_empty() {
                    detail.push_str(&format!(" · {interaction}"));
                }
            }
            if let Some(fix) = report.fix_first.iter().find(|fix| fix.id == fx.id) {
                detail.push_str(&format!(
                    " · declared dependency for {} failing fixtures",
                    fix.dependent_failure_count
                ));
            }
            push_md_attention_row(
                &mut o,
                issue,
                &fx.category,
                &md_fixture_link(&fx.category, &fx.id),
                &detail,
            );
        }
        o.push('\n');
    }

    // Category order is intentionally independent of manifest order: the weakest
    // areas stay at the top even as categories are added.
    let mut categories: Vec<&CategoryReport> = report.categories.iter().collect();
    categories.sort_by(|a, b| {
        a.score_pct
            .partial_cmp(&b.score_pct)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.counts.fail.cmp(&a.counts.fail))
            .then_with(|| {
                max_attention_diff(b)
                    .partial_cmp(&max_attention_diff(a))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then(a.category.cmp(&b.category))
    });
    o.push_str("## Categories — worst first\n\n");
    o.push_str("| category | verified visual parity | pass | fail | disputed refs |\n");
    o.push_str("|----------|-----------------------:|-----:|-----:|--------------:|\n");
    for c in categories {
        o.push_str(&format!(
            "| [{}](cases/{}/) | {:.2}% | {} | {} | {} |\n",
            md_cell(&c.category),
            md_cell(&c.category),
            c.score_pct,
            c.counts.pass,
            c.counts.fail,
            c.counts.reference_disputed,
        ));
    }
    o.push('\n');

    let mut gaps: BTreeMap<&str, Counts> = BTreeMap::new();
    for fx in fixtures(report).filter(|fx| fx.expected_support != "implemented") {
        gaps.entry(fx.expected_support.as_str())
            .or_default()
            .add(fx.status);
    }
    o.push_str("## Support labels\n\n");
    o.push_str("These labels describe intended surface coverage only. They never change a verdict; every non-PASS fixture remains in the needs-attention worklist above.\n\n");
    if gaps.is_empty() {
        o.push_str("None.\n\n");
    } else {
        o.push_str("| expected support | total | pass | fail | disputed refs |\n");
        o.push_str("|------------------|------:|-----:|-----:|--------------:|\n");
        for (expected, counts) in gaps {
            let total = counts.total();
            o.push_str(&format!(
                "| {} | {} | {} | {} | {} |\n",
                md_cell(expected),
                total,
                counts.pass,
                counts.fail,
                counts.reference_disputed,
            ));
        }
        o.push('\n');
    }

    o.push_str("## Run details\n\n");
    o.push_str(&format!(
        "- Comparator: raw evidence is a shared upper-left canvas with white padding, no translation, registration, crop, filter, resampling, or replacement. The fixed visibility policy is applied directly to those pixels: paper ΔE2000 ≤{PAPER_CONTENT_JND:.1}; a ColorErr pixel with every RGB channel delta ≤{VISUAL_COLOR_CHANNEL_TOLERANCE_PCT:.1}% is semantically correct (its exact RGBA evidence remains reported); complete-page above-floor mismatch must be ≤{VISUAL_PASS_MAX_SEMANTIC_DIFF_PCT:.1}%; color ΔE2000 ≤{VISUAL_COLOR_JND:.1}; edge color above that per-pixel allowance ≤{VISUAL_EDGE_COLOR_PCT:.2}% of paint only when no component, span, or aggregate crosses the authored visibility floors; interior color ≤{VISUAL_INTERIOR_COLOR_PCT:.3}%; Missing/Extra or unproven ColorErr component ≥{VISUAL_PRESENCE_COMPONENT_AREA_CSS_PX2:.0} CSS px²; component ≥{VISUAL_PRESENCE_COMPONENT_SPAN_CSS_PX:.0} CSS px span; disconnected total ≥{VISUAL_PRESENCE_TOTAL_AREA_CSS_PX2:.0} CSS px². Balanced colour coverage requires page bias ≤{VISUAL_BALANCED_EDGE_COLOR_MAX_BIAS:.2}, every independently visible component (≥{VISUAL_BALANCED_EDGE_COMPONENT_MIN_AREA_CSS_PX2:.0} CSS px² or ≥{VISUAL_BALANCED_EDGE_COMPONENT_MAX_SPAN_CSS_PX:.0} CSS px span) bias ≤{VISUAL_BALANCED_EDGE_COMPONENT_MAX_BIAS:.2}, and direct unchanged anchors within one CSS px. A colour-ramp component may leave a corner/stem remainder only when at least {:.0}% of its pixels directly prove the shared ramp and the remainder is below {VISUAL_BALANCED_EDGE_COMPONENT_MIN_AREA_CSS_PX2:.0} CSS px²; a component wholly below that area floor still needs direct ramp evidence, no interior recolour, and one ink family. A mixed coverage phase additionally requires paired Missing/Extra ≤{VISUAL_MIXED_COVERAGE_MAX_PRESENCE_PCT:.1}% each, balance bias ≤{VISUAL_MIXED_COVERAGE_MAX_BALANCE_BIAS:.2}, ColorErr coverage ≥{VISUAL_MIXED_COVERAGE_MIN_COLOR_TO_PRESENCE_RATIO:.0}× direct presence, component bounds below the normal glyph limits, interior colour ≤{VISUAL_MIXED_COVERAGE_MAX_INTERIOR_COLOR_PCT:.2}%, an oriented shared paper/content ramp around every direct colour component, and either balanced colour energy or a hue-preserving ramp. A one-sided contour additionally requires ≥{:.0}% byte-identical shared paint, ≤{VISUAL_ONE_SIDED_COVERAGE_MAX_PRESENCE_PCT:.1}% direct presence, ColorErr ≥{VISUAL_ONE_SIDED_COVERAGE_MIN_COLOR_TO_PRESENCE_RATIO:.0}× presence, zero interior recolour, and a directly proven unchanged-endpoint ramp; edge-sample Delta-E is not an independent rejection when that topology is proven. A single-sample colour frontier is direct device quantization; a wider coherent frontier may pass only when every normal remains below {VISUAL_SUB_AUTHORED_COLOR_FRONTIER_MAX_CSS_PX:.2} CSS px between two distinct byte-identical shared colours and the field has at most {VISUAL_COHERENT_OUTLINE_MAX_COMPONENTS} components. A raw unpaired contour may pass only when every authored-space normal remains below one CSS pixel between directly shared paper and content; its total length is irrelevant because physical thickness, not raster-pixel count, controls visibility. Fragmented paired shared-outline coverage remains bounded to ≤{VISUAL_EDGE_PRESENCE_PCT:.1}% of paint; a coherent outline may exceed that only with at most {VISUAL_COHERENT_OUTLINE_MAX_COMPONENTS} direct components per sign. One-CSS-pixel strips, absent thin rules, inner cuts, and repeated glyph displacement remain failures. Exact RGBA mismatch remains in the numeric report; the full-page diff paints only pixels above the per-channel floor. {} DPI · source `{}` · executed snapshot `{}` · argv `{}` · {} · binary SHA-256 `{}`.\n",
        100.0 * VISUAL_COVERAGE_RAMP_MIN_PROVEN_RATIO,
        100.0 * VISUAL_ONE_SIDED_COVERAGE_MIN_SHARED_CONTENT_RATIO,
        report.env.dpi,
        if report.env.pdftoppm_available {
            report.env.rasterizer_source_path.as_str()
        } else {
            "MISSING"
        },
        if report.env.pdftoppm_available {
            report.env.rasterizer_executed_path.as_str()
        } else {
            "MISSING"
        },
        if report.env.rasterizer_arguments.is_empty() {
            "MISSING"
        } else {
            report.env.rasterizer_arguments.as_str()
        },
        report.env.rasterizer_version,
        if !is_sha256(&report.env.rasterizer_sha256) {
            "MISSING"
        } else {
            report.env.rasterizer_sha256.as_str()
        }
    ));
    o.push_str(&format!(
        "- Reference lock: {} · stale refs {} · ref-name mismatches {}.\n",
        if report.refs_lock_present && is_sha256(&report.refs_lock_sha256) {
            "present"
        } else {
            "MISSING"
        },
        report.stale_refs.len(),
        report.ref_mismatches.len()
    ));
    o.push_str(&format!(
        "- Regression baseline: {}.\n",
        if report.baseline_present {
            "VALID/COMPATIBLE"
        } else {
            "MISSING/INVALID/INCOMPATIBLE"
        }
    ));
    o.push_str("- Generated by `scripts/parity.sh`.\n");

    write_atomic(path, o.as_bytes())
}

// ---------------------------------------------------------------------------
// In-repo visual HTML reports (triptych galleries)
// ---------------------------------------------------------------------------

/// The V2 diagnosis primary class for a fixture, or "—" when none was computed
/// (legacy verdict path / old baseline). Used by the Markdown `class` column and
/// the HTML header chip.
pub(crate) fn diag_class(fx: &FixtureResult) -> &str {
    fx.diagnosis
        .as_ref()
        .filter(|d| !d.primary_class.is_empty())
        .map_or("—", |d| d.primary_class.as_str())
}

/// The V2 diagnosis headline (human reason) for a fixture, if one was computed.
pub(crate) fn diag_reason(fx: &FixtureResult) -> Option<&str> {
    if !fx.note.is_empty() {
        return Some(fx.note.as_str());
    }
    fx.diagnosis
        .as_ref()
        .map(|d| d.headline.as_str())
        .filter(|h| !h.is_empty())
}

/// Minimal HTML-attribute/text escaper (no external deps).
pub(crate) fn html_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            _ => o.push(c),
        }
    }
    o
}

/// Problem-first sort rank.
pub(crate) fn status_rank(s: Status) -> u8 {
    match s {
        Status::Fail => 0,
        Status::ReferenceDisputed => 1,
        Status::Pass => 2,
    }
}

pub(crate) fn status_color(s: Status) -> &'static str {
    match s {
        Status::Pass => "#1a7f37",
        Status::Fail => "#cf222e",
        Status::ReferenceDisputed => "#9a6700",
    }
}

/// Shared, dependency-free presentation and small filtering/sorting helpers.
pub(crate) fn report_css() -> &'static str {
    r#"<style>
:root{--bg:#fff;--fg:#1f2328;--muted:#57606a;--line:#d0d7de;--soft:#f6f8fa;--bad:#cf222e;--warn:#9a6700;--ok:#1a7f37}
*{box-sizing:border-box}
body{max-width:1600px;margin:0 auto;padding:24px;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg)}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}
.meta,.desc{color:var(--muted);font-size:13px}.meta{margin:0 0 14px}.desc{max-width:70ch}
.health{display:inline-block;margin:4px 0 10px;padding:3px 10px;border-radius:6px;color:#fff;font-weight:700;background:var(--bad)}
.health.ok{background:var(--ok)}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;color:#fff;font-weight:700;font-size:12px}
.chip{display:inline-block;padding:1px 7px;border-radius:6px;font-size:11px;font-weight:600;border:1px solid var(--line);background:var(--soft);font-variant-numeric:tabular-nums}
.chip.cls{color:#fff;border:0}.chip.bad{color:#fff;border-color:var(--bad);background:var(--bad)}
.dependency{color:var(--warn);font-weight:600}.oracle{color:var(--warn)}.chip.refdispute{color:#fff;border-color:var(--bad);background:var(--bad)}
.num{text-align:right;font-variant-numeric:tabular-nums}
table{border-collapse:collapse;width:100%;margin:8px 0 24px;font-size:13px}
th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{background:var(--soft);position:sticky;top:0;cursor:pointer;user-select:none}
tr:nth-child(even) td{background:#fafbfc}
.filterbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:12px 0 16px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--soft);font-size:13px}
.filterbar label{color:var(--muted)}.filterbar select,.filterbar input{font:inherit;padding:2px 6px;border:1px solid var(--line);border-radius:5px;background:#fff}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--muted);margin:10px 0 14px;padding:6px 8px;border:1px dashed var(--line);border-radius:6px}
.legend .lg{display:inline-flex;align-items:center;gap:4px}.legend .sw{display:inline-block;width:11px;height:11px;border-radius:2px;border:1px solid #0003}.legend .note{flex-basis:100%;color:var(--warn)}
section.feat{margin:0 0 28px}section.feat h2{display:flex;gap:10px;align-items:baseline;border-bottom:2px solid var(--line);padding-bottom:4px}section.feat h2 .top{margin-left:auto;font-size:12px;font-weight:400}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px;margin-top:10px}
.card{border:1px solid var(--line);border-left:4px solid var(--bad);border-radius:8px;padding:8px;background:#fff;scroll-margin-top:12px}.card[data-status=PASS]{border-left-color:var(--ok)}.card[data-status=REFERENCE-DISPUTED]{border-left-color:var(--warn)}
.chead{font-size:13px;margin-bottom:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.quad{display:flex;gap:4px;flex-wrap:nowrap;margin:4px 0}.quad figure{margin:0;flex:1;min-width:0}.quad figcaption{font-size:11px;color:var(--muted);text-align:center;margin-top:2px}.quad img{width:100%;max-width:260px;height:auto;border:1px solid var(--line);background:repeating-conic-gradient(#eee 0% 25%,#fff 0% 50%) 50%/16px 16px;display:block}
.quad .unavailable{display:grid;place-items:center;aspect-ratio:4/3;width:100%;max-width:260px;border:1px dashed var(--bad);background:var(--soft);color:var(--bad);font-size:12px;font-weight:700}
.pglabel{font-size:11px;font-weight:600;color:var(--muted);margin:6px 0 0}
details{margin:5px 0;border:1px solid var(--line);border-radius:6px;padding:6px 10px;background:var(--soft)}summary{cursor:pointer;font-weight:600}
.regtbl{font-size:12px;margin:6px 0 2px}.regtbl th{position:static;cursor:default}
.src pre{margin:6px 0 0;max-height:280px;overflow:auto;background:#0d1117;color:#e6edf3;border-radius:6px;padding:8px 10px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.src code{white-space:pre}.src .ln{color:#6e7681;display:inline-block;width:3ch;text-align:right;margin-right:12px;user-select:none}
.hidden{display:none!important}
@media(max-width:700px){body{padding:14px}.cards{grid-template-columns:1fr}.quad{overflow:auto}.quad figure{min-width:180px}}
</style>
<script>
function sortTable(t,col){var tb=t.tBodies[0],rows=[].slice.call(tb.rows),asc=t.getAttribute('data-sort')!=col+'a';rows.sort(function(a,b){var x=a.cells[col].getAttribute('data-k')||a.cells[col].innerText,y=b.cells[col].getAttribute('data-k')||b.cells[col].innerText,nx=parseFloat(x),ny=parseFloat(y);if(!isNaN(nx)&&!isNaN(ny))return asc?nx-ny:ny-nx;return asc?x.localeCompare(y):y.localeCompare(x)});rows.forEach(function(r){tb.appendChild(r)});t.setAttribute('data-sort',col+(asc?'a':'d'))}
function filterCards(){var st=(document.getElementById('f-status')||{}).value||'',cl=(document.getElementById('f-class')||{}).value||'',md=parseFloat((document.getElementById('f-diff')||{}).value)||0,showPass=!!(document.getElementById('f-pass')||{}).checked,cards=document.querySelectorAll('.card.fxrow'),shown=0;cards.forEach(function(c){var status=c.getAttribute('data-status'),ok=(showPass||status!=='PASS')&&(!st||status===st)&&(!cl||c.getAttribute('data-class')===cl)&&(parseFloat(c.getAttribute('data-diff'))>=md);c.classList.toggle('hidden',!ok);if(ok)shown++});document.querySelectorAll('section.feat').forEach(function(s){s.classList.toggle('hidden',!s.querySelector('.fxrow:not(.hidden)'))});var n=document.getElementById('f-count');if(n)n.textContent=shown+' / '+cards.length+' fixtures shown'}
function sortCards(){var mode=(document.getElementById('f-sort')||{}).value||'problem',rank={FAIL:0,'REFERENCE-DISPUTED':1,PASS:2};document.querySelectorAll('.cards').forEach(function(grid){var cards=[].slice.call(grid.querySelectorAll('.card.fxrow'));cards.sort(function(a,b){var da=parseFloat(a.getAttribute('data-diff'))||0,db=parseFloat(b.getAttribute('data-diff'))||0;if(mode==='diffd')return db-da;if(mode==='diffa')return da-db;var ra=rank[a.getAttribute('data-status')],rb=rank[b.getAttribute('data-status')];return ra!==rb?ra-rb:db-da});cards.forEach(function(c){grid.appendChild(c)})})}
function filterWorklist(){var cl=(document.getElementById('wl-class')||{}).value||'';document.querySelectorAll('tr.wl').forEach(function(r){r.classList.toggle('hidden',!!cl&&r.getAttribute('data-class')!==cl)})}
document.addEventListener('DOMContentLoaded',function(){sortCards();filterCards()});
</script>"#
}

pub(crate) fn status_badge(s: Status) -> String {
    format!(
        "<span class=\"badge\" style=\"background:{}\">{}</span>",
        status_color(s),
        s.as_str()
    )
}

/// CSS colour for directly observed diagnosis classes and page-structure failures.
pub(crate) fn diag_class_color(class: &str) -> &'static str {
    match class {
        "Missing" => "#e600e6",                // magenta (overlay Missing)
        "Extra" => "#1a9e3c",                  // green (overlay Extra)
        "ColorValue" => "#2850ff",             // blue (overlay ColorErr)
        "AntialiasCoverage" => "#59636e",      // slate (shared-outline coverage)
        "ColorSpace" => "#0a8a8a",             // teal (gradient/blend drift)
        "AlphaCompositing" => "#7a3cc0",       // purple (opacity)
        "PageSize" | "PageCount" => "#cf222e", // terminal page-structure failure
        _ => "#57606a",                        // grey (unknown / none)
    }
}

/// The always-visible legend: overlay colour -> counted unequal-pixel class.
/// The full-page overlay leaves matching pixels blank; the Match swatch is a
/// semantic class rather than a flat page fill.
pub(crate) fn render_legend() -> String {
    let mut o = String::from("<div class=\"legend\"><strong>diff colours:</strong>");
    for c in LEGEND_ORDER {
        let [r, g, b] = class_rgb(c);
        o.push_str(&format!(
            "<span class=\"lg\"><span class=\"sw\" style=\"background:rgb({r},{g},{b})\"></span>{}</span>",
            html_escape(class_label(c))
        ));
    }
    o.push_str(&format!(
        "<span class=\"note\">Full-page diff: matching and per-channel ≤{VISUAL_COLOR_CHANNEL_TOLERANCE_PCT:.1}% pixels are blank; coloured classes are same-coordinate above-floor evidence. Exact RGBA mismatch remains numeric.</span>"
    ));
    o.push_str("</div>");
    o
}

/// The magnitude chips for a fixture's header bar (spec §3.3 item 1), read from the
/// diagnosis: a class chip plus direct missing/extra, ΔE, and alpha magnitudes.
fn render_diag_chips(diag: &Diagnosis) -> String {
    let mut o = String::new();
    if !diag.visual_pass_basis.is_empty() && diag.different_pixels != 0 {
        o.push_str(&format!(
            "<span class=\"chip\">PASS via {}</span>",
            html_escape(&diag.visual_pass_basis)
        ));
    }
    if !diag.primary_class.is_empty() {
        o.push_str(&format!(
            "<span class=\"chip cls\" style=\"background:{}\">{}</span>",
            diag_class_color(&diag.primary_class),
            html_escape(&diag.primary_class)
        ));
    }
    let m = &diag.magnitude;
    if m.missing_area_pct != 0.0 {
        o.push_str(&format!(
            "<span class=\"chip\">missing {}%</span>",
            display_html_measure(m.missing_area_pct)
        ));
    }
    if m.extra_area_pct != 0.0 {
        o.push_str(&format!(
            "<span class=\"chip\">extra {}%</span>",
            display_html_measure(m.extra_area_pct)
        ));
    }
    if m.delta_e != 0.0 {
        o.push_str(&format!(
            "<span class=\"chip\">ΔE {}</span>",
            display_html_measure(m.delta_e)
        ));
    }
    if m.modal_drgba[3] != 0 {
        o.push_str(&format!(
            "<span class=\"chip\">ΔA {:+}</span>",
            m.modal_drgba[3]
        ));
    }
    if let Some(a) = m.recovered_alpha {
        o.push_str(&format!("<span class=\"chip\">α {a:.2}↛</span>"));
    }
    o
}

/// Complete class aggregates plus a bounded, honestly labelled worst-first
/// representative table. Empty string when there are no semantic regions.
fn render_region_table(diag: &Diagnosis) -> String {
    if diag.region_count == 0 {
        return String::new();
    }
    let example_count = diag.region_examples.len();
    let example_label = if example_count == 1 {
        "representative"
    } else {
        "representatives"
    };
    let mut o = format!(
        "<details><summary>regions ({} total; showing {} {})</summary>\
<p class=\"meta\">Complete component census grouped by dominant raster class; representative details are bounded.</p>\
<h4>Complete dominant-class aggregates</h4>\
<table class=\"regtbl\"><thead><tr>\
<th>class</th><th class=\"num\">regions</th><th class=\"num\">pixels</th>\
<th>union bbox (CSS px)</th><th class=\"num\">largest px</th>\
<th>maximum magnitude</th></tr></thead><tbody>",
        diag.region_count, example_count, example_label,
    );
    for summary in &diag.region_classes {
        let bbox = format!(
            "{:.0},{:.0} → {:.0},{:.0}",
            summary.union_bbox_css[0],
            summary.union_bbox_css[1],
            summary.union_bbox_css[2],
            summary.union_bbox_css[3]
        );
        let mut magnitude = format!(
            "total {}% · largest {}%",
            display_measure(summary.total_area_pct),
            display_measure(summary.largest_region_area_pct)
        );
        if summary.max_delta_e != 0.0 {
            magnitude.push_str(&format!(
                " · max ΔE {}",
                display_measure(summary.max_delta_e)
            ));
        }
        o.push_str(&format!(
            "<tr><td><span class=\"chip cls\" style=\"background:{color}\">{class}</span></td>\
<td class=\"num\">{regions}</td><td class=\"num\">{pixels}</td><td>{bbox}</td>\
<td class=\"num\">{largest}</td><td>{magnitude}</td></tr>",
            color = diag_class_color(&summary.class),
            class = html_escape(&summary.class),
            regions = summary.region_count,
            pixels = summary.total_pixels,
            bbox = bbox,
            largest = summary.largest_region_pixels,
            magnitude = html_escape(&magnitude),
        ));
    }
    o.push_str(
        "</tbody></table><h4>Representative region details (worst-first)</h4>\
<table class=\"regtbl\"><thead><tr>\
<th>class</th><th>bbox (CSS px)</th><th class=\"num\">area%</th>\
<th>magnitude</th><th>reason</th></tr></thead><tbody>",
    );
    for r in &diag.region_examples {
        let bbox = format!(
            "{:.0},{:.0} → {:.0},{:.0}",
            r.bbox_css[0], r.bbox_css[1], r.bbox_css[2], r.bbox_css[3]
        );
        // A compact per-region magnitude from facts measured at the same pixel.
        let mut mag = String::new();
        if r.delta_e != 0.0 {
            mag.push_str(&format!("ΔE {} ", display_measure(r.delta_e)));
        }
        let [red, green, blue, alpha] = r.modal_drgba;
        if [red, green, blue] != [0, 0, 0] || alpha != 0 {
            if alpha == 0 {
                mag.push_str(&format!("ΔRGB({red},{green},{blue}) "));
            } else {
                mag.push_str(&format!("ΔRGBA({red},{green},{blue},{alpha}) "));
            }
        }
        if let Some(a) = r.recovered_alpha {
            mag.push_str(&format!("α{a:.2} "));
        }
        o.push_str(&format!(
            "<tr><td><span class=\"chip cls\" style=\"background:{c}\">{cls}</span></td>\
<td>{bbox}</td><td class=\"num\">{area}</td><td>{mag}</td><td>{reason}</td></tr>",
            c = diag_class_color(&r.class),
            cls = html_escape(&r.class),
            bbox = bbox,
            area = html_escape(&display_measure(r.area_pct)),
            mag = html_escape(mag.trim()),
            reason = html_escape(&r.headline),
        ));
    }
    o.push_str("</tbody></table></details>");
    o
}

/// A closed source pane showing the fixture's HTML (`cases/<cat>/<id>.html`),
/// html_escape'd into
/// `<pre><code>` with line numbers. Read at write time (no new dependency). When
/// the file cannot be read, a small note is shown instead so the card still renders.
fn render_source_pane(cases_dir: &Path, category: &str, id: &str) -> String {
    let path = cases_dir.join(category).join(format!("{id}.html"));
    match std::fs::read_to_string(&path) {
        Ok(src) => {
            let mut body = String::new();
            for (i, line) in src.lines().enumerate() {
                body.push_str(&format!(
                    "<span class=\"ln\">{}</span>{}\n",
                    i + 1,
                    html_escape(line)
                ));
            }
            format!(
                "<details class=\"src\"><summary>source · cases/{}/{}.html</summary>\
<pre><code>{}</code></pre></details>",
                html_escape(category),
                html_escape(id),
                body
            )
        }
        Err(e) => format!(
            "<details class=\"src\"><summary>source · cases/{}/{}.html</summary>\
<p class=\"meta\">could not read fixture source: {}</p></details>",
            html_escape(category),
            html_escape(id),
            html_escape(&e.to_string())
        ),
    }
}

/// Stable anchor slug for a feature name (used for in-page `#feat-…` links).
pub(crate) fn feat_slug(feature: &str) -> String {
    feature
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect()
}

struct StagedDirectory {
    path: PathBuf,
    published: bool,
}

impl Drop for StagedDirectory {
    fn drop(&mut self) {
        if !self.published {
            let _ = remove_artifact(&self.path);
        }
    }
}

fn publish_directory(staging: &Path, destination: &Path, backup: &Path) -> Result<(), String> {
    remove_artifact(backup)
        .map_err(|error| format!("cannot clear {}: {error}", backup.display()))?;
    let had_destination = std::fs::symlink_metadata(destination).is_ok();
    if had_destination {
        std::fs::rename(destination, backup).map_err(|error| {
            format!(
                "cannot stage existing report tree {}: {error}",
                destination.display()
            )
        })?;
    }
    if let Err(error) = std::fs::rename(staging, destination) {
        if had_destination {
            let _ = std::fs::rename(backup, destination);
        }
        return Err(format!(
            "cannot publish report tree {}: {error}",
            destination.display()
        ));
    }
    remove_artifact(backup).map_err(|error| format!("cannot remove {}: {error}", backup.display()))
}

fn copy_report_assets(source: &Path, destination: &Path) -> Result<(), String> {
    let Ok(entries) = std::fs::read_dir(source) else {
        return Ok(());
    };
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "cannot inspect report asset directory {}: {error}",
                source.display()
            )
        })?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = entry
            .metadata()
            .map_err(|error| format!("cannot inspect {}: {error}", source_path.display()))?;
        if metadata.is_dir() {
            std::fs::create_dir_all(&destination_path).map_err(|error| {
                format!("cannot create {}: {error}", destination_path.display())
            })?;
            copy_report_assets(&source_path, &destination_path)?;
        } else if metadata.is_file()
            && source_path
                .extension()
                .and_then(|extension| extension.to_str())
                != Some("html")
        {
            std::fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "cannot stage report asset {}: {error}",
                    source_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn html_report_meta(report: &Report, json_sha256: &str) -> String {
    format!(
        "<meta name=\"parity-invocation-id\" content=\"{}\"><meta name=\"parity-report-json-sha256\" content=\"{}\">",
        html_escape(&report.invocation_id),
        json_sha256
    )
}

/// Write `reports/index.html` and one `reports/<category>.html` per category.
/// Image paths are RELATIVE to the reports/ dir so the gallery renders both from
/// the repo checkout and as a CI artifact:
///   ref      -> ../refs/<cat>/<id>.png
///   ironpress-> ../out/<cat>/<id>.png
///   diff     -> <cat>/<id>.diff.png  (the full-page classed overlay)
///
/// Category pages open as a problem worklist: non-PASS cards are visible, PASS
/// cards require an explicit toggle, and each card has a stable direct anchor.
/// The diff legend appears once per page and source panes are closed by default.
pub(crate) fn write_html_reports(
    reports_dir: &Path,
    cases_dir: &Path,
    report: &Report,
) -> Result<(), String> {
    let serialized = SerializedReport::new(report)?;
    write_html_reports_identified(reports_dir, cases_dir, report, &serialized.sha256)
}

fn write_html_reports_identified(
    reports_dir: &Path,
    cases_dir: &Path,
    report: &Report,
    json_sha256: &str,
) -> Result<(), String> {
    let destination = reports_dir;
    let parent = destination
        .parent()
        .ok_or_else(|| format!("report tree has no parent: {}", destination.display()))?;
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid report tree path: {}", destination.display()))?;
    let staging_path = parent.join(format!(".{name}.staging"));
    let backup = parent.join(format!(".{name}.previous"));
    remove_artifact(&staging_path)
        .map_err(|error| format!("cannot clear {}: {error}", staging_path.display()))?;
    std::fs::create_dir_all(&staging_path)
        .map_err(|error| format!("cannot create {}: {error}", staging_path.display()))?;
    let mut staging = StagedDirectory {
        path: staging_path,
        published: false,
    };
    copy_report_assets(destination, &staging.path)?;
    let reports_dir = staging.path.as_path();

    let parity_root = cases_dir.parent();

    for c in &report.categories {
        let mut feats: Vec<&FeatureReport> = c.features.iter().collect();
        feats.sort_by(|a, b| {
            a.score_pct
                .partial_cmp(&b.score_pct)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.counts.fail.cmp(&a.counts.fail))
                .then(
                    b.counts
                        .reference_disputed
                        .cmp(&a.counts.reference_disputed),
                )
                .then(a.feature.cmp(&b.feature))
        });

        let mut o = String::new();
        o.push_str("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">");
        o.push_str(&html_report_meta(report, json_sha256));
        o.push_str("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">");
        o.push_str(&format!(
            "<title>parity · {}</title>",
            html_escape(&c.category)
        ));
        o.push_str(report_css());
        o.push_str("</head><body>");
        o.push_str(&format!(
            "<h1>{} — {:.2}% verified visual parity</h1>",
            html_escape(&c.category),
            c.score_pct
        ));
        o.push_str(&format!(
            "<p class=\"meta\"><a href=\"index.html\">&larr; all categories</a> · \
             <strong>PASS {}</strong> · FAIL {} · REFERENCE-DISPUTED {} · {} total · {} DPI</p>",
            c.counts.pass,
            c.counts.fail,
            c.counts.reference_disputed,
            c.counts.total(),
            report.env.dpi
        ));

        o.push_str(&render_legend());

        let mut classes: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
        for f in &c.features {
            for fx in &f.fixtures {
                if fx.status != Status::Pass {
                    classes.insert(diag_class(fx));
                }
            }
        }
        o.push_str(
            "<div class=\"filterbar\">\
<label><input id=\"f-pass\" type=\"checkbox\" onchange=\"filterCards()\"> show PASS ",
        );
        o.push_str(&c.counts.pass.to_string());
        o.push_str(
            "</label>\
<label>status <select id=\"f-status\" onchange=\"filterCards()\">\
<option value=\"\">all non-PASS</option><option value=\"FAIL\">FAIL</option><option value=\"REFERENCE-DISPUTED\">REFERENCE-DISPUTED</option></select></label>",
        );
        o.push_str("<label>class <select id=\"f-class\" onchange=\"filterCards()\"><option value=\"\">all</option>");
        for cl in &classes {
            o.push_str(&format!(
                "<option value=\"{v}\">{v}</option>",
                v = html_escape(cl)
            ));
        }
        o.push_str("</select></label>");
        o.push_str(
            "<label>min diff% <input id=\"f-diff\" type=\"number\" min=\"0\" step=\"1\" \
value=\"0\" style=\"width:6ch\" oninput=\"filterCards()\"></label>\
<label>sort <select id=\"f-sort\" onchange=\"sortCards()\">\
<option value=\"problem\">problem-first</option><option value=\"diffd\">diff% high→low</option>\
<option value=\"diffa\">diff% low→high</option></select></label>\
<strong id=\"f-count\"></strong></div>",
        );

        for f in &feats {
            o.push_str(&format!(
                "<section class=\"feat\"><h2 id=\"feat-{slug}\">{name} — {sc:.2}% verified visual parity \
<span class=\"meta\">PASS {p} · FAIL {fl} · REFERENCE-DISPUTED {rd}</span>\
<a class=\"top\" href=\"index.html\">all categories ↑</a></h2>",
                slug = feat_slug(&f.feature),
                name = html_escape(&f.feature),
                sc = f.score_pct,
                p = f.counts.pass,
                fl = f.counts.fail,
                rd = f.counts.reference_disputed,
            ));

            let mut fxs: Vec<&FixtureResult> = f.fixtures.iter().collect();
            fxs.sort_by(|a, b| {
                status_rank(a.status)
                    .cmp(&status_rank(b.status))
                    .then(
                        b.diff_pct
                            .partial_cmp(&a.diff_pct)
                            .unwrap_or(std::cmp::Ordering::Equal),
                    )
                    .then(a.id.cmp(&b.id))
            });

            o.push_str("<div class=\"cards\">");
            for fx in &fxs {
                let sub_html = if !fx.subfeature.is_empty() {
                    format!(" · {}", html_escape(&fx.subfeature))
                } else if !fx.interaction_of.is_empty() {
                    format!(
                        " · interaction: {}",
                        html_escape(&fx.interaction_of.join(" × "))
                    )
                } else {
                    String::new()
                };
                let dependency_html = if fx.status == Status::Pass {
                    String::new()
                } else if !fx.dependency_context.is_empty() {
                    format!(
                        " · <span class=\"dependency\">{}</span>",
                        html_escape(&fx.dependency_context)
                    )
                } else {
                    String::new()
                };
                let description_html = if fx.description.is_empty() {
                    String::new()
                } else {
                    format!("<div class=\"desc\">{}</div>", html_escape(&fx.description))
                };
                let reference_html = if fx.reference.is_disputed() {
                    format!(
                        "<div class=\"desc\"><strong>reference dispute:</strong> {}</div>",
                        html_escape(&fx.reference.note)
                    )
                } else {
                    String::new()
                };
                let desc_html = format!("{description_html}{reference_html}");
                let ref_label = match fx.oracle.as_str() {
                    "weasyprint" => "WeasyPrint ref",
                    "none" => "ironpress only",
                    _ => "Chrome ref",
                };
                let oracle_chip = if fx.oracle == "chrome" {
                    String::new()
                } else {
                    format!(
                        " · <span class=\"oracle\">oracle: {}</span>",
                        html_escape(&fx.oracle)
                    )
                };
                let reference_chip = if fx.reference.is_disputed() {
                    " · <span class=\"chip refdispute\">REFERENCE DISPUTED</span>".to_string()
                } else {
                    String::new()
                };

                let (reference_pages, candidate_pages) = parity_root.map_or_else(
                    || (BTreeSet::new(), BTreeSet::new()),
                    |root| {
                        (
                            preview_pages(&root.join("refs"), &c.category, &fx.id, false),
                            preview_pages(&root.join("out"), &c.category, &fx.id, false),
                        )
                    },
                );
                let diff_pages = preview_pages(reports_dir, &c.category, &fx.id, true);
                let max_page = reference_pages
                    .iter()
                    .chain(candidate_pages.iter())
                    .chain(diff_pages.iter())
                    .copied()
                    .max()
                    .unwrap_or(1);
                let page_count_html = if reference_pages.len() != candidate_pages.len() {
                    format!(
                        " · <span class=\"chip bad\">pages: {} ref / {} ironpress</span>",
                        reference_pages.len(),
                        candidate_pages.len()
                    )
                } else if max_page > 1 {
                    format!(" · <span class=\"chip\">{max_page} pages</span>")
                } else {
                    String::new()
                };
                let page_figures = |page: usize| {
                    let suffix = if page == 1 {
                        String::new()
                    } else {
                        format!(".p{page}")
                    };
                    let reference_src = format!("../refs/{}/{}{}.png", c.category, fx.id, suffix);
                    let candidate_src = format!("../out/{}/{}{}.png", c.category, fx.id, suffix);
                    let diff_src = if page == 1 {
                        format!("{}/{}.diff.png", c.category, fx.id)
                    } else {
                        format!("{}/{}.p{}.diff.png", c.category, fx.id, page)
                    };
                    format!(
                        "{}{}{}",
                        preview_figure(&reference_src, ref_label, reference_pages.contains(&page)),
                        preview_figure(
                            &candidate_src,
                            "ironpress",
                            candidate_pages.contains(&page)
                        ),
                        preview_figure(
                            &diff_src,
                            &format!(
                                "full-page >{VISUAL_COLOR_CHANNEL_TOLERANCE_PCT:.1}%/channel diff"
                            ),
                            diff_pages.contains(&page)
                        ),
                    )
                };
                let page_one_figures = page_figures(1);
                let mut pages_extra = String::new();
                for page in 2..=max_page {
                    pages_extra.push_str(&format!(
                        "<div class=\"pglabel\">page {page}</div><div class=\"quad\">{}</div>",
                        page_figures(page)
                    ));
                }
                let p1label = if max_page == 1 {
                    String::new()
                } else {
                    "<div class=\"pglabel\">page 1</div>".to_string()
                };

                let (chips_html, regions_html) = match &fx.diagnosis {
                    Some(d) => (render_diag_chips(d), render_region_table(d)),
                    None => (String::new(), String::new()),
                };
                let reason_html = match diag_reason(fx) {
                    Some(r) => format!(
                        "<div class=\"desc\"><strong>why:</strong> {}</div>",
                        html_escape(r)
                    ),
                    None => String::new(),
                };
                let source_html = if fx.diagnosis.is_some() {
                    render_source_pane(cases_dir, &c.category, &fx.id)
                } else {
                    String::new()
                };
                let diff_label = if fx.status == Status::Pass {
                    fx.diagnosis.as_ref().filter(|diagnosis| diagnosis.different_pixels > 0).map_or_else(
                        || "<span class=\"meta\">exact match</span>".to_string(),
                        |diagnosis| format!(
                            "<span class=\"meta\">visually equivalent · no rejecting defect · thresholded evidence {} · raw {} ({} px)</span>",
                            display_diff_pct(fx.semantic_diff_pct),
                            display_diff_pct(fx.diff_pct),
                            diagnosis.different_pixels,
                        ),
                    )
                } else {
                    format!(
                        "<span class=\"num\">{}above-floor {} · raw {} max-page diff</span>",
                        fx.diagnosis
                            .as_ref()
                            .filter(|diagnosis| diagnosis.different_pixels > 0)
                            .map_or_else(String::new, |diagnosis| {
                                format!("{} px · ", diagnosis.different_pixels)
                            }),
                        display_diff_pct(fx.semantic_diff_pct),
                        display_diff_pct(fx.diff_pct)
                    )
                };
                let class = if fx.status == Status::Pass {
                    "—"
                } else {
                    diag_class(fx)
                };

                o.push_str(&format!(
                    "<article id=\"{anchor}\" class=\"card fxrow\" data-status=\"{st}\" data-class=\"{cls}\" data-diff=\"{diffk}\">\
<div class=\"chead\">{badge} {diff_label} \
<strong>{id}</strong>{sub_html}{attr}{oc}{rc}{page_count}{chips}</div>\
{p1label}<div class=\"quad\">\
{page_one_figures}\
</div>{pages_extra}{reason}{desc}{regions}{source}</article>",
                    anchor = fixture_anchor(&fx.id),
                    st = fx.status.as_str(),
                    cls = html_escape(class),
                    diffk = fx.diff_pct,
                    badge = status_badge(fx.status),
                    diff_label = diff_label,
                    id = html_escape(&fx.id),
                    sub_html = sub_html,
                    attr = dependency_html,
                    oc = oracle_chip,
                    rc = reference_chip,
                    page_count = page_count_html,
                    chips = chips_html,
                    page_one_figures = page_one_figures,
                    p1label = p1label,
                    pages_extra = pages_extra,
                    reason = reason_html,
                    desc = desc_html,
                    regions = regions_html,
                    source = source_html,
                ));
            }
            o.push_str("</div></section>");
        }
        o.push_str("</body></html>");

        let page = reports_dir.join(format!("{}.html", c.category));
        std::fs::write(&page, o).map_err(|e| format!("cannot write {}: {e}", page.display()))?;
    }

    let mut o = String::new();
    let ov = &report.overall;
    let worklist = AttentionWorklist::new(report);
    let attention = worklist.len();
    let attention_summary = worklist.summary();
    let visual_pass_audit = VisualPassAudit::new(report);
    let report_ok = report.gate_failure.is_none() && worklist.is_empty();
    let health = if report_ok { "OK" } else { "BROKEN" };
    o.push_str("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">");
    o.push_str(&html_report_meta(report, json_sha256));
    o.push_str("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">");
    o.push_str("<title>ironpress parity report</title>");
    o.push_str(report_css());
    o.push_str("</head><body>");
    o.push_str("<h1>ironpress parity health</h1>");
    o.push_str(&format!(
        "<div class=\"health{}\">{} · Needs attention: {}</div>\
<p><strong>{:.2}% verified visual-parity rate</strong> · exact raster {} · visual-policy {} · FAIL {} · REFERENCE-DISPUTED {} · {} total</p>\
<p class=\"meta\">PASS rule: fixed same-coordinate human-visibility policy after the shared pdftoppm path; no translation, registration, fixture-specific tuning, or hidden raw-diff suppression · {} category/feature pairs · family interactions {}/{} across {} families · {} DPI</p>",
        if report_ok { " ok" } else { "" },
        health,
        attention_summary,
        ov.score_pct,
        visual_pass_audit.exact,
        visual_pass_audit.nonidentical,
        ov.fail,
        ov.reference_disputed,
        ov.total,
        report.coverage.features_with_fixture,
        report.coverage.interaction_pairs_covered,
        report.coverage.interaction_pairs_required,
        report.coverage.interaction_families,
        report.env.dpi
    ));
    if let Some(summary) = visual_pass_audit.summary() {
        o.push_str(&format!(
            "<p class=\"meta\"><strong>{}</strong> · each visual-policy fixture card keeps its raw difference and policy basis.</p>",
            html_escape(&summary),
        ));
    }

    if let Some((label, detail)) = gate_banner(report, worklist.terminal_only) {
        o.push_str(&format!(
            "<h2>Gate result</h2><div class=\"health\"><strong>{label} — FAILED</strong> · {detail}</div>",
            label = html_escape(label),
            detail = html_escape(detail),
        ));
    }

    let by_id = report.by_id();
    let failures = &worklist.failures;
    let reference_disputes = &worklist.reference_disputes;

    if !report.fix_first.is_empty() {
        o.push_str("<h2>Declared dependency canaries</h2>");
        o.push_str("<p class=\"meta\">Failing canaries ranked by how many other failing fixtures declare them. This is reach/triage metadata only: it does not prove causality or that a named CSS feature is wrong.</p>");
        o.push_str("<table><thead><tr><th>dependency canary</th><th>measured concern</th><th>visual result</th><th class=\"num\">failing dependents</th></tr></thead><tbody>");
        for blocker in &report.fix_first {
            let category = by_id
                .get(blocker.id.as_str())
                .map_or("probes", |fixture| fixture.category.as_str());
            o.push_str(&format!(
                "<tr><td><a href=\"{category}.html#{anchor}\">{id}</a></td><td>{feature}</td><td>{status}</td><td class=\"num\">{count}</td></tr>",
                category = html_escape(category),
                anchor = fixture_anchor(&blocker.id),
                id = html_escape(&blocker.id),
                feature = html_escape(&blocker.feature),
                status = html_escape(&blocker.status),
                count = blocker.dependent_failure_count,
            ));
        }
        o.push_str("</tbody></table>");
    }

    if !failures.is_empty() {
        let mut triage_groups: BTreeMap<FailureTriage, usize> = BTreeMap::new();
        for fixture in failures {
            *triage_groups.entry(failure_triage(fixture)).or_default() += 1;
        }
        let mut triage_groups: Vec<(FailureTriage, usize)> = triage_groups.into_iter().collect();
        triage_groups.sort_by(|left, right| {
            left.0
                .rank()
                .cmp(&right.0.rank())
                .then(right.1.cmp(&left.1))
        });
        o.push_str("<h2>Failure triage</h2><p class=\"meta\">Direct paint mismatches are listed before colour-only residuals. Both remain FAIL under the fixed human-visibility policy; this grouping keeps raw edge-pixel volume from becoming the work order.</p><table><thead><tr><th>direct evidence</th><th class=\"num\">fixtures</th><th>how to read it</th></tr></thead><tbody>");
        for (triage, count) in triage_groups {
            o.push_str(&format!(
                "<tr><td>{label}</td><td class=\"num\">{count}</td><td>{explanation}</td></tr>",
                label = html_escape(triage.label()),
                explanation = html_escape(triage.explanation()),
            ));
        }
        o.push_str("</tbody></table>");
    }

    o.push_str("<h2>Needs attention</h2>");
    if attention == 0 {
        o.push_str("<p class=\"meta\">Nothing unexpected or unverified.</p>");
    } else if worklist.terminal_only {
        o.push_str("<p class=\"meta\">The terminal gate cause is shown once above.</p>");
    } else {
        o.push_str("<table data-sort=\"\"><thead><tr>");
        for (i, h) in ["issue", "category", "fixture", "detail"]
            .iter()
            .enumerate()
        {
            o.push_str(&format!(
                "<th onclick=\"sortTable(this.closest('table'),{i})\">{h}</th>"
            ));
        }
        o.push_str("</tr></thead><tbody>");
        for problem in &worklist.integrity {
            push_html_attention_row(&mut o, "INTEGRITY", "—", None, &problem);
        }
        if worklist.baseline_missing {
            push_html_attention_row(
                &mut o,
                "INTEGRITY",
                "—",
                None,
                "baseline.json is missing, invalid, or incompatible",
            );
        }
        for id in worklist.suspects {
            let located = by_id.get(id.as_str());
            push_html_attention_row(
                &mut o,
                "SUSPECT",
                located.map_or("—", |fx| fx.category.as_str()),
                located.map(|fx| (fx.category.as_str(), fx.id.as_str())),
                "tagged unsupported but PASS; re-check tag and fixture",
            );
        }
        for (issue, fx) in failures.iter().copied().map(|fx| ("FAIL", fx)).chain(
            reference_disputes
                .iter()
                .copied()
                .map(|fx| ("REFERENCE-DISPUTED", fx)),
        ) {
            let reason = diag_reason(fx).unwrap_or(fx.note.as_str());
            let reference_note = if fx.reference.is_disputed() {
                format!(" · reference dispute: {}", html_escape(&fx.reference.note))
            } else {
                String::new()
            };
            let dependency = if fx.dependency_context.is_empty() {
                String::new()
            } else {
                format!(" · {}", html_escape(&fx.dependency_context))
            };
            let differing_pixels = fx
                .diagnosis
                .as_ref()
                .filter(|diagnosis| diagnosis.different_pixels > 0)
                .map_or_else(String::new, |diagnosis| {
                    format!(" · {} differing RGBA pixels", diagnosis.different_pixels)
                });
            o.push_str(&format!(
                "<tr><td><span class=\"badge\" style=\"background:{color}\">{status}</span></td>\
<td>{cat}</td><td><a href=\"{cat}.html#{anchor}\">{id}</a></td>\
<td>{feature} · {triage} · {class} · above-floor diff {semantic_diff} · raw RGBA diff {diff}{differing_pixels}{reference_note}{dependency}{reason}</td></tr>",
                color = status_color(fx.status),
                status = issue,
                cat = html_escape(&fx.category),
                anchor = fixture_anchor(&fx.id),
                id = html_escape(&fx.id),
                feature = html_escape(&fx.feature),
                triage = html_escape(failure_triage(fx).label()),
                class = html_escape(diag_class(fx)),
                semantic_diff = display_diff_pct(fx.semantic_diff_pct),
                diff = display_diff_pct(fx.diff_pct),
                differing_pixels = differing_pixels,
                reference_note = reference_note,
                dependency = dependency,
                reason = if reason.is_empty() {
                    String::new()
                } else {
                    format!(" · {}", html_escape(reason))
                },
            ));
        }
        o.push_str("</tbody></table>");
    }

    let mut categories: Vec<&CategoryReport> = report.categories.iter().collect();
    categories.sort_by(|a, b| {
        a.score_pct
            .partial_cmp(&b.score_pct)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.counts.fail.cmp(&a.counts.fail))
            .then_with(|| {
                max_attention_diff(b)
                    .partial_cmp(&max_attention_diff(a))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then(a.category.cmp(&b.category))
    });
    o.push_str("<h2>Categories — worst first</h2>");
    o.push_str("<table data-sort=\"\"><thead><tr>");
    for (i, h) in [
        "category",
        "verified visual parity %",
        "pass",
        "fail",
        "disputed refs",
    ]
    .iter()
    .enumerate()
    {
        o.push_str(&format!(
            "<th onclick=\"sortTable(this.closest('table'),{i})\">{h}</th>"
        ));
    }
    o.push_str("</tr></thead><tbody>");
    for c in categories {
        o.push_str(&format!(
            "<tr>\
<td><a href=\"{cat}.html\">{cat}</a></td>\
<td class=\"num\" data-k=\"{score}\">{score:.2}</td>\
<td class=\"num\">{p}</td><td class=\"num\">{f}</td><td class=\"num\">{rd}</td>\
</tr>",
            cat = html_escape(&c.category),
            score = c.score_pct,
            p = c.counts.pass,
            f = c.counts.fail,
            rd = c.counts.reference_disputed,
        ));
    }
    o.push_str("</tbody></table>");

    let mut gaps: BTreeMap<&str, Counts> = BTreeMap::new();
    for fx in fixtures(report).filter(|fx| fx.expected_support != "implemented") {
        gaps.entry(fx.expected_support.as_str())
            .or_default()
            .add(fx.status);
    }
    if !gaps.is_empty() {
        o.push_str("<h2>Support labels</h2><p class=\"meta\">Descriptive only: labels never change the visibility verdict.</p><table><thead><tr><th>expected support</th><th>total</th><th>pass</th><th>fail</th><th>disputed refs</th></tr></thead><tbody>");
        for (expected, counts) in gaps {
            let total = counts.total();
            o.push_str(&format!(
                "<tr><td>{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td></tr>",
                html_escape(expected), total, counts.pass, counts.fail, counts.reference_disputed
            ));
        }
        o.push_str("</tbody></table>");
    }

    o.push_str("<p class=\"meta\">Generated by <code>scripts/parity.sh</code>. Category pages hide visual PASS results by default; use the toggle to inspect exact matches and retained raw variance.</p>");
    o.push_str("</body></html>");

    let index = reports_dir.join("index.html");
    std::fs::write(&index, o).map_err(|e| format!("cannot write {}: {e}", index.display()))?;
    publish_directory(&staging.path, destination, &backup)?;
    staging.published = true;
    Ok(())
}

fn push_html_attention_row(
    output: &mut String,
    issue: &str,
    category: &str,
    fixture: Option<(&str, &str)>,
    detail: &str,
) {
    let fixture = fixture.map_or_else(
        || "—".to_string(),
        |(category, id)| {
            format!(
                "<a href=\"{}.html#{}\">{}</a>",
                html_escape(category),
                fixture_anchor(id),
                html_escape(id)
            )
        },
    );
    output.push_str(&format!(
        "<tr><td><span class=\"badge\" style=\"background:#57606a\">{}</span></td><td>{}</td><td>{}</td><td>{}</td></tr>",
        html_escape(issue),
        html_escape(category),
        fixture,
        html_escape(detail)
    ));
}

pub(crate) fn interaction_kind(
    fx: &FixtureResult,
    by_id: &BTreeMap<&str, &FixtureResult>,
) -> String {
    if fx.base_ids.is_empty() {
        return String::new();
    }
    let mut failing_base: Option<&str> = None;
    let mut disputed_base: Option<&str> = None;
    let mut unresolved_base: Option<&str> = None;
    let mut all_pass = true;
    for b in &fx.base_ids {
        match by_id.get(b.as_str()) {
            Some(r) if r.status == Status::Pass => {}
            Some(r) if r.status == Status::ReferenceDisputed => {
                all_pass = false;
                disputed_base = Some(b.as_str());
            }
            Some(_) => {
                all_pass = false;
                failing_base = Some(b.as_str());
            }
            None => {
                all_pass = false;
                unresolved_base = Some(b.as_str());
            }
        }
    }
    // Report only declared state. Do not infer that a base caused the interaction.
    if let Some(b) = unresolved_base {
        return format!("declared base not present: `{b}`");
    }
    if all_pass {
        match fx.status {
            Status::Fail => "declared bases PASS; interaction fixture FAILS".to_string(),
            Status::ReferenceDisputed => {
                "declared bases PASS; interaction fixture has a disputed reference".to_string()
            }
            Status::Pass => String::new(),
        }
    } else if let Some(b) = failing_base {
        format!("declared base also FAILS: `{b}`")
    } else if let Some(b) = disputed_base {
        format!("declared base has a disputed reference: `{b}`")
    } else {
        "a declared base is non-PASS".to_string()
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn fixture(id: &str, category: &str, status: Status) -> FixtureResult {
        FixtureResult {
            id: id.to_string(),
            category: category.to_string(),
            feature: "sample-feature".to_string(),
            subfeature: String::new(),
            interaction_of: Vec::new(),
            base_ids: Vec::new(),
            status,
            diff_pct: if status == Status::Pass { 0.0 } else { 40.0 },
            semantic_diff_pct: if status == Status::Pass { 0.0 } else { 40.0 },
            description: format!("{id} description"),
            note: if status == Status::Pass {
                String::new()
            } else {
                "visible failure".to_string()
            },
            kind: "probe".to_string(),
            depends_on: Vec::new(),
            expected_support: "implemented".to_string(),
            oracle: "chrome".to_string(),
            reference: Default::default(),
            dependency_context: if status == Status::Pass {
                String::new()
            } else {
                String::new()
            },
            html_sha256: "0".repeat(64),
            raster: RasterEvidence {
                candidate: vec![RasterFingerprint {
                    width: 1,
                    height: 1,
                    rgba_sha256: "1".repeat(64),
                    painted_pixels: 1,
                }],
                oracle: vec![RasterFingerprint {
                    width: 1,
                    height: 1,
                    rgba_sha256: "1".repeat(64),
                    painted_pixels: 1,
                }],
            },
            diagnosis: None,
        }
    }

    fn category(name: &str, score_pct: f64, fx: FixtureResult) -> CategoryReport {
        let mut counts = Counts::default();
        counts.add(fx.status);
        CategoryReport {
            category: name.to_string(),
            score_pct,
            counts: counts.clone(),
            features: vec![FeatureReport {
                feature: "sample-feature".to_string(),
                score_pct,
                counts,
                fixtures: vec![fx],
            }],
        }
    }

    fn sample_report() -> Report {
        Report {
            schema_version: 2,
            invocation_id: String::new(),
            run_complete: true,
            env: EnvBlock {
                dpi: super::super::config::DPI,
                pdftoppm_available: true,
                rasterizer_source_path: "/test/source/pdftoppm".to_string(),
                rasterizer_executed_path: "/test/snapshot/pdftoppm".to_string(),
                rasterizer_arguments: "[-r, 144, -png, <PDF>, <PREFIX>]".to_string(),
                rasterizer_version: "test Poppler".to_string(),
                rasterizer_sha256: "2".repeat(64),
            },
            overall: Overall {
                score_pct: 50.0,
                pass: 1,
                fail: 1,
                reference_disputed: 0,
                total: 2,
            },
            // Deliberately best-first: writers must reverse the presentation.
            categories: vec![
                category(
                    "healthy",
                    100.0,
                    fixture("pass-one", "healthy", Status::Pass),
                ),
                category("broken", 0.0, fixture("fail-one", "broken", Status::Fail)),
            ],
            corpus_issues: Vec::new(),
            coverage: Coverage {
                features_with_fixture: 2,
                covered: Vec::new(),
                implemented: 2,
                partial: 0,
                unsupported: 0,
                ..Default::default()
            },
            fix_first: Vec::new(),
            ref_mismatches: Vec::new(),
            suspect_unsupported_pass: Vec::new(),
            stale_refs: Vec::new(),
            refs_lock_present: true,
            refs_lock_sha256: "3".repeat(64),
            baseline_present: true,
            gate_failure: None,
        }
    }

    fn temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "ironpress-parity-report-{label}-{}",
            std::process::id()
        ))
    }

    fn complete_report(fixtures: Vec<FixtureResult>) -> Report {
        let mut report = super::super::gate::build_report(fixtures, true);
        report.env.rasterizer_source_path = "/test/source/pdftoppm".to_string();
        report.env.rasterizer_executed_path = "/test/snapshot/pdftoppm".to_string();
        report.env.rasterizer_arguments = "[-r, 144, -png, <PDF>, <PREFIX>]".to_string();
        report.env.rasterizer_version = "test Poppler".to_string();
        report.env.rasterizer_sha256 = "2".repeat(64);
        report.refs_lock_present = true;
        report.refs_lock_sha256 = "3".repeat(64);
        report.baseline_present = true;
        report.coverage = super::super::gate::compute_coverage(&report);
        report
    }

    #[test]
    fn pass_payload_omits_optional_diagnosis() {
        let pass = serde_json::to_value(fixture("pass", "healthy", Status::Pass)).unwrap();
        assert!(pass.get("diagnosis").is_none());
    }

    #[test]
    fn visual_pass_keeps_raw_variance_in_its_category_card() {
        let mut fixture = fixture("subpixel-coverage", "healthy", Status::Pass);
        fixture.diff_pct = 0.25;
        fixture.semantic_diff_pct = 0.20;
        fixture.diagnosis = Some(Diagnosis {
            primary_class: "ColorValue".to_string(),
            headline: "edge coverage differs below the visibility policy".to_string(),
            different_pixels: 12,
            visual_pass_basis: "CSS-scale observation: shared outline coverage".to_string(),
            ..Default::default()
        });
        let report = complete_report(vec![fixture]);
        let root = temp_path("visual-pass-raw-evidence");
        let reports = root.join("reports");
        let cases = root.join("cases");
        let _ = std::fs::remove_dir_all(&root);

        write_html_reports(&reports, &cases, &report).unwrap();
        let category = std::fs::read_to_string(reports.join("healthy.html")).unwrap();
        let _ = std::fs::remove_dir_all(root);

        assert!(category.contains(
            "visually equivalent · no rejecting defect · thresholded evidence 0.20% · raw 0.25% (12 px)"
        ));
        assert!(category.contains("edge coverage differs below the visibility policy"));
    }

    #[test]
    fn visual_pass_audit_names_each_nonidentical_pass_basis() {
        let mut report = sample_report();
        let fixture = &mut report.categories[0].features[0].fixtures[0];
        fixture.diff_pct = 0.25;
        fixture.diagnosis = Some(Diagnosis {
            different_pixels: 12,
            visual_pass_basis: "CSS-scale observation: shared outline coverage".to_string(),
            ..Default::default()
        });

        assert_eq!(
            VisualPassAudit::new(&report).summary().as_deref(),
            Some(
                "Raster audit: 0 exact PASSes · 1 visual-policy PASSes (max raw difference 0.25%; CSS shared outline 1)"
            )
        );
    }

    #[test]
    fn disputed_reference_is_prominent_in_the_category_report() {
        let mut fixture = fixture("oracle-conflict", "healthy", Status::ReferenceDisputed);
        fixture.reference = ReferenceAssessment {
            status: super::super::manifest::ReferenceStatus::Disputed,
            note: "the standard requires the candidate behavior".to_string(),
        };
        let report = complete_report(vec![fixture]);
        let root = temp_path("disputed-reference");
        let reports = root.join("reports");
        let cases = root.join("cases");
        let _ = std::fs::remove_dir_all(&root);

        write_html_reports(&reports, &cases, &report).unwrap();
        let category = std::fs::read_to_string(reports.join("healthy.html")).unwrap();
        let _ = std::fs::remove_dir_all(root);

        assert!(category.contains("REFERENCE DISPUTED"));
        assert!(category.contains("the standard requires the candidate behavior"));
    }

    #[test]
    fn disputed_reference_is_not_counted_as_an_implementation_failure() {
        let mut disputed = fixture("oracle-conflict", "healthy", Status::ReferenceDisputed);
        disputed.reference = ReferenceAssessment {
            status: super::super::manifest::ReferenceStatus::Disputed,
            note: "the standard requires the candidate behavior".to_string(),
        };
        let report = complete_report(vec![fixture("verified", "healthy", Status::Pass), disputed]);
        let path = temp_path("disputed-reference-verdict");
        let _ = std::fs::remove_file(&path);

        write_report_md(&path, &report).unwrap();
        let markdown = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(path);

        assert_eq!(report.overall.score_pct, 100.0);
        assert_eq!(report.overall.pass, 1);
        assert_eq!(report.overall.fail, 0);
        assert_eq!(report.overall.reference_disputed, 1);
        assert!(markdown.contains("1 disputed reference(s)"));
        assert!(markdown.contains("| REFERENCE-DISPUTED | healthy | [`oracle-conflict`]"));
        assert!(!markdown.contains("1 failing fixture(s)"));
    }

    #[test]
    fn markdown_is_a_compact_problem_first_worklist() {
        let path = temp_path("report.md");
        let _ = std::fs::remove_file(&path);
        write_report_md(&path, &sample_report()).unwrap();
        let markdown = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(path);

        assert!(markdown.contains("**BROKEN**"));
        assert!(markdown.contains("[`fail-one`](cases/broken/fail-one.html)"));
        assert!(!markdown.contains("pass-one"));
        assert!(!markdown.contains("## Detail"));
        assert!(
            markdown.find("[broken](cases/broken/)") < markdown.find("[healthy](cases/healthy/)")
        );
        assert!(!markdown.contains("](reports/"));
        assert!(markdown.contains("Generated-local visual inventory: `reports/index.html`"));
    }

    #[test]
    fn structured_corpus_issues_lead_both_human_worklists() {
        let mut report = sample_report();
        report.corpus_issues.push(CorpusIssue {
            kind: CorpusIssueKind::DuplicateOracle,
            fixtures: vec!["oracle-a".to_string(), "oracle-b".to_string()],
            detail: "byte-identical oracle evidence".to_string(),
        });
        report.corpus_issues.push(CorpusIssue {
            kind: CorpusIssueKind::InvalidOracle,
            fixtures: vec!["oklab".to_string(), "srgb".to_string()],
            detail: "declared semantic distinction has identical oracle rasters".to_string(),
        });
        let root = temp_path("corpus-issue-worklists");
        let markdown_path = root.join("REPORT.md");
        let reports_path = root.join("reports");
        let cases_path = root.join("cases");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        write_report_md(&markdown_path, &report).unwrap();
        write_html_reports(&reports_path, &cases_path, &report).unwrap();
        let markdown = std::fs::read_to_string(markdown_path).unwrap();
        let html = std::fs::read_to_string(reports_path.join("index.html")).unwrap();

        for output in [&markdown, &html] {
            assert!(output.contains("corpus duplicate-oracle"));
            assert!(output.contains("oracle-a, oracle-b"));
            assert!(output.contains("byte-identical oracle evidence"));
            assert!(output.contains("corpus invalid-oracle"));
            assert!(output.contains("oklab, srgb"));
            assert!(output.contains("declared semantic distinction has identical oracle rasters"));
            assert!(output.find("byte-identical oracle evidence") < output.find("visible failure"));
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn every_one_of_31_equal_failures_is_searchable_in_markdown_and_html() {
        let failures = (0..31)
            .map(|index| {
                let mut failure =
                    fixture(&format!("equal-fail-{index:02}"), "broken", Status::Fail);
                failure.diff_pct = 1.0;
                failure.note = format!("direct-reason-{index:02}");
                failure
            })
            .collect();
        let report = complete_report(failures);
        let root = temp_path("all-equal-failures");
        let markdown_path = root.join("REPORT.md");
        let reports_path = root.join("reports");
        let cases_path = root.join("cases");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        write_report_md(&markdown_path, &report).unwrap();
        write_html_reports(&reports_path, &cases_path, &report).unwrap();
        let markdown = std::fs::read_to_string(markdown_path).unwrap();
        let html_index = std::fs::read_to_string(reports_path.join("index.html")).unwrap();
        let html_category = std::fs::read_to_string(reports_path.join("broken.html")).unwrap();
        let _ = std::fs::remove_dir_all(root);

        for index in 0..31 {
            let id = format!("equal-fail-{index:02}");
            let reason = format!("direct-reason-{index:02}");
            assert!(markdown.contains(&id), "Markdown omitted {id}");
            assert!(markdown.contains(&reason), "Markdown omitted {reason}");
            assert!(html_index.contains(&id), "HTML index omitted {id}");
            assert!(html_index.contains(&reason), "HTML index omitted {reason}");
            assert!(html_category.contains(&id), "HTML category omitted {id}");
            assert!(
                html_category.contains(&reason),
                "HTML category omitted {reason}"
            );
        }
        assert!(!markdown.contains("additional non-PASS fixtures"));
        assert!(!markdown.contains("worst 30"));
    }

    #[test]
    fn terminal_gate_cause_is_identical_and_broken_in_every_report_format() {
        let mut report = complete_report(vec![fixture("exact-pass", "healthy", Status::Pass)]);
        let cause = "parity gate FAILED: raster fingerprint changed for exact-pass";
        report.gate_failure = Some(cause.to_string());

        let root = temp_path("terminal-gate-cause");
        let json_path = root.join("report.json");
        let markdown_path = root.join("REPORT.md");
        let reports_path = root.join("reports");
        let cases_path = root.join("cases");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        write_report_json(&json_path, &report).unwrap();
        write_report_md(&markdown_path, &report).unwrap();
        write_html_reports(&reports_path, &cases_path, &report).unwrap();

        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(json_path).unwrap()).unwrap();
        let markdown = std::fs::read_to_string(markdown_path).unwrap();
        let html = std::fs::read_to_string(reports_path.join("index.html")).unwrap();
        let _ = std::fs::remove_dir_all(root);

        assert_eq!(json["gate_failure"], cause);
        assert!(markdown.contains("**BROKEN**"));
        assert!(markdown.contains("REGRESSION"));
        assert!(markdown.contains(cause));
        assert!(html.contains("BROKEN"));
        assert!(html.contains("REGRESSION"));
        assert!(html.contains(cause));
    }

    #[test]
    fn terminal_gate_summary_does_not_double_count_its_fixture_leaf() {
        let mut report = complete_report(vec![fixture("one-failure", "broken", Status::Fail)]);
        report.gate_failure = Some(
            "parity integrity gate FAILED (1 issue(s)):\n  - fixture is FAIL: one-failure"
                .to_string(),
        );
        let path = temp_path("single-leaf-attention.md");
        let _ = std::fs::remove_file(&path);

        write_report_md(&path, &report).unwrap();
        let markdown = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(path);

        assert!(markdown.contains("**Needs attention: 1 failing fixture(s).**"));
        assert_eq!(
            markdown
                .matches("[`one-failure`](cases/broken/one-failure.html)")
                .count(),
            1
        );
        assert!(markdown.contains("**REGRESSION — FAILED.** parity integrity gate FAILED"));
        assert!(!markdown.contains("| REGRESSION |"));
    }

    #[test]
    fn region_table_labels_complete_aggregates_and_bounded_examples() {
        let diagnosis = Diagnosis {
            region_count: 1_000,
            region_classes: vec![super::super::diagnose::RegionClassSummary {
                class: "ColorErr".to_string(),
                region_count: 1_000,
                total_pixels: 1_000,
                total_area_pct: 12.5,
                union_bbox_css: [0.0, 1.0, 20.0, 21.0],
                largest_region_pixels: 1,
                largest_region_area_pct: 0.0125,
                max_delta_e: 4.5,
            }],
            region_examples: vec![super::super::diagnose::RegionDiag {
                class: "ColorValue".to_string(),
                bbox_css: [0.0, 1.0, 0.0, 1.0],
                area_pct: 0.0125,
                headline: "representative one-pixel colour defect".to_string(),
                ..Default::default()
            }],
            ..Default::default()
        };

        let html = render_region_table(&diagnosis);
        assert!(html.contains("regions (1000 total; showing 1 representative)"));
        assert!(html.contains("Complete dominant-class aggregates"));
        assert!(html.contains(">1000</td><td class=\"num\">1000<"));
        assert!(html.contains("Representative region details (worst-first)"));
        assert!(html.contains("representative one-pixel colour defect"));
    }

    #[test]
    fn incomplete_run_marker_is_impossible_to_mistake_for_a_current_report() {
        let mut report = sample_report();
        report.run_complete = false;
        let path = temp_path("incomplete-report.md");
        let _ = std::fs::remove_file(&path);
        write_report_md(&path, &report).unwrap();
        let markdown = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(path);

        assert!(markdown.contains("| **BROKEN** | INCOMPLETE |"));
        assert!(markdown.contains("parity run did not complete"));
    }

    #[test]
    fn report_integrity_uses_the_same_dpi_contract_as_the_gate() {
        let mut report = sample_report();
        report.env.dpi += 1;
        let path = temp_path("wrong-dpi-report.md");
        let _ = std::fs::remove_file(&path);
        write_report_md(&path, &report).unwrap();
        let markdown = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(path);

        assert!(markdown.contains("does not match the compiled contract"));
        assert!(markdown.contains("| **BROKEN** |"));
    }

    #[test]
    fn diagnostic_chips_never_hide_or_round_nonzero_signals_to_zero() {
        let mut diagnosis = Diagnosis::default();
        diagnosis.primary_class = "ColorValue".to_string();
        diagnosis.magnitude.missing_area_pct = 0.04;
        diagnosis.magnitude.extra_area_pct = 0.004;
        diagnosis.magnitude.delta_e = 0.04;
        diagnosis.magnitude.modal_drgba = [0, 0, 0, -1];
        diagnosis.different_pixels = 12;
        diagnosis.visual_pass_basis = "CSS-scale observation: shared outline coverage".to_string();

        let html = render_diag_chips(&diagnosis);
        assert!(html.contains("PASS via CSS-scale observation: shared outline coverage"));
        assert!(html.contains("missing 0.04%"));
        assert!(html.contains("extra 0.004000%"));
        assert!(html.contains("ΔE 0.04"));
        assert!(html.contains("ΔA -1"));
        assert!(!html.contains("0.0%"));
    }

    #[test]
    fn tiny_exact_diff_remains_visibly_nonzero() {
        let mut report = sample_report();
        report.categories[1].features[0].fixtures[0].diff_pct = 0.000_001;
        report.categories[1].features[0].fixtures[0].semantic_diff_pct = 0.000_001;
        let path = temp_path("tiny-diff.md");
        let _ = std::fs::remove_file(&path);
        write_report_md(&path, &report).unwrap();
        let markdown = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(path);

        assert!(markdown.contains("above-floor diff 0.000001% · raw RGBA diff 0.000001%"));
        assert!(!markdown.contains("above-floor diff 0%"));
    }

    #[test]
    fn known_gap_failures_stay_in_the_attention_worklist() {
        let mut report = sample_report();
        report.categories[1].features[0].fixtures[0].expected_support = "unsupported".to_string();
        report.coverage.implemented = 1;
        report.coverage.unsupported = 1;

        let path = temp_path("known-gap.md");
        let _ = std::fs::remove_file(&path);
        write_report_md(&path, &report).unwrap();
        let markdown = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(path);

        assert!(markdown.contains("**BROKEN**"));
        assert!(markdown.contains("[`fail-one`](cases/broken/fail-one.html)"));
        assert!(markdown.contains("expected unsupported"));
    }

    #[test]
    fn unsupported_pass_suspect_counts_as_attention_and_is_visible() {
        let mut report = sample_report();
        report.categories = vec![report.categories.remove(0)];
        report.overall = Overall {
            score_pct: 100.0,
            pass: 1,
            fail: 0,
            reference_disputed: 0,
            total: 1,
        };
        report.suspect_unsupported_pass = vec!["pass-one".to_string()];

        let path = temp_path("unsupported-pass-suspect.md");
        let _ = std::fs::remove_file(&path);
        write_report_md(&path, &report).unwrap();
        let markdown = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(path);

        assert!(markdown.contains("| **BROKEN** | 100.00% | 1 | 0 | 0 | 0 | 1 |"));
        assert!(markdown.contains("**Needs attention: 1 support-label item(s).**"));
        assert!(markdown.contains("tagged unsupported but PASS"));
        assert!(!markdown.contains("Nothing unexpected or unverified"));
    }

    #[test]
    fn html_defaults_to_problems_and_links_directly_to_fixture_cards() {
        let mut report = sample_report();
        report.invocation_id = "html-generation".to_string();
        report.fix_first.push(FixFirst {
            id: "fail-one".to_string(),
            feature: "sample-feature".to_string(),
            status: "FAIL".to_string(),
            dependent_failure_count: 3,
            dependent_failure_ids: vec!["a".to_string(), "b".to_string(), "c".to_string()],
        });
        let root = temp_path("html");
        let reports = root.join("reports");
        let cases = root.join("cases");
        let _ = std::fs::remove_dir_all(&root);
        write_html_reports(&reports, &cases, &report).unwrap();

        let index = std::fs::read_to_string(reports.join("index.html")).unwrap();
        let category = std::fs::read_to_string(reports.join("broken.html")).unwrap();
        let _ = std::fs::remove_dir_all(root);

        assert!(index.contains("broken.html#fixture-fail-one"));
        assert!(index.contains("<meta name=\"parity-invocation-id\" content=\"html-generation\">"));
        assert!(index.contains("Declared dependency canaries"));
        assert!(index.contains("sample-feature"));
        assert!(index.contains("does not prove causality"));
        assert!(!index.contains("confound"));
        assert!(index.find(">broken</a>") < index.find(">healthy</a>"));
        assert!(category.contains("id=\"fixture-fail-one\""));
        assert!(category.contains("id=\"f-pass\" type=\"checkbox\""));
        assert!(!category.contains("id=\"f-pass\" type=\"checkbox\" checked"));
        assert_eq!(category.matches("class=\"legend\"").count(), 1);
        assert!(!category.contains("<details open"));
    }

    #[test]
    fn dependency_canary_tables_are_never_cut_off() {
        let mut report = sample_report();
        report.fix_first = (0..13)
            .map(|index| FixFirst {
                id: format!("canary-{index}"),
                feature: format!("feature-{index}"),
                status: "FAIL".to_string(),
                dependent_failure_count: 13 - index,
                dependent_failure_ids: Vec::new(),
            })
            .collect();
        let root = temp_path("uncut-canaries");
        let markdown = root.join("REPORT.md");
        let reports = root.join("reports");
        let cases = root.join("cases");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        write_report_md(&markdown, &report).unwrap();
        write_html_reports(&reports, &cases, &report).unwrap();
        let markdown = std::fs::read_to_string(markdown).unwrap();
        let index = std::fs::read_to_string(reports.join("index.html")).unwrap();
        let _ = std::fs::remove_dir_all(root);

        assert!(markdown.contains("canary-12"));
        assert!(index.contains("canary-12"));
    }

    #[test]
    fn html_tree_is_replaced_only_after_complete_staging() {
        let mut report = sample_report();
        report.invocation_id = "new-generation".to_string();
        let root = temp_path("html-tree-swap");
        let reports = root.join("reports");
        let cases = root.join("cases");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&reports).unwrap();
        std::fs::write(reports.join("index.html"), "old generation").unwrap();
        std::fs::write(reports.join("obsolete.html"), "must disappear").unwrap();
        std::fs::write(reports.join("asset.png"), b"current diff asset").unwrap();

        write_html_reports(&reports, &cases, &report).unwrap();

        let index = std::fs::read_to_string(reports.join("index.html")).unwrap();
        assert!(index.contains("content=\"new-generation\""));
        assert!(!reports.join("obsolete.html").exists());
        assert_eq!(
            std::fs::read(reports.join("asset.png")).unwrap(),
            b"current diff asset"
        );
        assert!(!root.join(".reports.staging").exists());
        assert!(!root.join(".reports.previous").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn html_generation_failure_preserves_the_previous_complete_tree() {
        let mut report = sample_report();
        report.categories[0].category = "invalid/nested-category".to_string();
        let root = temp_path("html-tree-failure");
        let reports = root.join("reports");
        let cases = root.join("cases");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&reports).unwrap();
        std::fs::write(reports.join("index.html"), "old complete generation").unwrap();

        let error = write_html_reports(&reports, &cases, &report).unwrap_err();

        assert!(error.contains("invalid/nested-category.html"));
        assert_eq!(
            std::fs::read_to_string(reports.join("index.html")).unwrap(),
            "old complete generation"
        );
        assert!(!root.join(".reports.staging").exists());
        assert!(!root.join(".reports.previous").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn html_exposes_oracle_only_pages_in_a_page_count_mismatch() {
        let report = sample_report();
        let root = temp_path("html-page-mismatch");
        let reports = root.join("reports");
        let cases = root.join("cases");
        for directory in [
            cases.join("broken"),
            root.join("refs/broken"),
            root.join("out/broken"),
            reports.join("broken"),
        ] {
            std::fs::create_dir_all(directory).unwrap();
        }
        std::fs::write(cases.join("broken/fail-one.html"), "<p>fixture</p>").unwrap();
        for path in [
            root.join("refs/broken/fail-one.png"),
            root.join("refs/broken/fail-one.p2.png"),
            root.join("out/broken/fail-one.png"),
            reports.join("broken/fail-one.diff.png"),
        ] {
            std::fs::write(path, []).unwrap();
        }

        write_html_reports(&reports, &cases, &report).unwrap();
        let category = std::fs::read_to_string(reports.join("broken.html")).unwrap();
        let _ = std::fs::remove_dir_all(root);

        assert!(category.contains("pages: 2 ref / 1 ironpress"));
        assert!(category.contains("page 2"));
        assert!(category.contains("../refs/broken/fail-one.p2.png"));
        assert!(category.contains("not generated"));
    }

    #[test]
    fn attention_lists_policy_triggering_paint_before_colour_only_residuals() {
        let mut colour = fixture("colour-only", "colour", Status::Fail);
        colour.diff_pct = 99.0;
        colour.diagnosis = Some(Diagnosis {
            primary_class: "ColorValue".to_string(),
            ..Default::default()
        });
        let mut paint = fixture("missing-paint", "paint", Status::Fail);
        paint.diff_pct = 0.01;
        paint.diagnosis = Some(Diagnosis {
            primary_class: "Missing".to_string(),
            ..Default::default()
        });
        let report = complete_report(vec![colour, paint]);
        let worklist = AttentionWorklist::new(&report);

        assert_eq!(worklist.failures[0].id, "missing-paint");

        let path = temp_path("failure-triage");
        let _ = std::fs::remove_file(&path);
        write_report_md(&path, &report).unwrap();
        let markdown = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(path);

        assert!(markdown.contains("## Failure triage"));
        assert!(markdown.contains("direct paint mismatch | 1"));
        assert!(markdown.contains("colour-only residual | 1"));
    }

    #[test]
    fn failures_sort_before_success() {
        assert!(status_rank(Status::Fail) < status_rank(Status::Pass));
    }
}
