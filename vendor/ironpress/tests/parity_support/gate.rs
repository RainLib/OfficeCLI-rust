//! Scoring, report assembly, breadth/coverage + fix-first metrics, the surfaced
//! freshness/unsupported guards, and the CI regression gate.
//!
//! Extracted verbatim from the former monolithic `mod.rs` (C1 mechanical split).

use std::collections::BTreeMap;
use std::path::Path;

use super::config::DPI;
use super::report::{
    CategoryReport, Counts, Coverage, EnvBlock, FeatureReport, FixFirst, FixtureResult, Overall,
    RasterEvidence, RasterFingerprint, Report, Status,
};
use super::util::round2;

#[derive(Debug)]
pub(crate) enum BaselineState {
    Missing,
    Invalid(String),
    Valid(Report),
}

impl BaselineState {
    pub(crate) fn report(&self) -> Option<&Report> {
        match self {
            Self::Valid(report) => Some(report),
            Self::Missing | Self::Invalid(_) => None,
        }
    }
}

pub(crate) fn load_baseline(path: &Path) -> BaselineState {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return BaselineState::Missing;
        }
        Err(error) => {
            return BaselineState::Invalid(format!(
                "cannot read existing {}: {error}",
                path.display()
            ));
        }
    };
    match serde_json::from_str(&contents) {
        Ok(report) => BaselineState::Valid(report),
        Err(error) => {
            BaselineState::Invalid(format!("cannot parse existing {}: {error}", path.display()))
        }
    }
}

pub(crate) use super::refs_lock::check_refs_freshness;

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

pub(crate) fn score<'a>(results: impl IntoIterator<Item = &'a FixtureResult>) -> f64 {
    let mut num = 0.0;
    let mut den = 0.0;
    for r in results {
        if let Some(value) = r.status.score_value() {
            num += value;
            den += 1.0;
        }
    }
    if den == 0.0 {
        0.0
    } else {
        round2(100.0 * num / den)
    }
}

/// Collect ids of fixtures tagged `expected_support == "unsupported"` that
/// nonetheless scored PASS. Surfaced (not gated) so the run still completes.
pub(crate) fn collect_suspect_unsupported_pass(results: &[FixtureResult]) -> Vec<String> {
    let mut v: Vec<String> = results
        .iter()
        .filter(|r| r.expected_support == "unsupported" && r.status == Status::Pass)
        .map(|r| r.id.clone())
        .collect();
    v.sort();
    v
}

/// Rank failing declared dependency canaries by how many failed downstream
/// fixtures name them. This measures manifest reach for triage, not causality.
pub(crate) fn compute_fix_first(results: &[FixtureResult]) -> Vec<FixFirst> {
    let mut status_of: BTreeMap<String, Status> = BTreeMap::new();
    let mut feature_of: BTreeMap<String, String> = BTreeMap::new();
    for r in results {
        status_of.insert(r.id.clone(), r.status);
        feature_of.insert(r.id.clone(), r.feature.clone());
    }
    // probe/base id -> failed dependents.
    let mut declared_dependents: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for r in results {
        if !r.status.is_failure() {
            continue;
        }
        for d in r.depends_on.iter().chain(r.base_ids.iter()) {
            if matches!(status_of.get(d), Some(s) if s.is_failure()) {
                declared_dependents
                    .entry(d.clone())
                    .or_default()
                    .push(r.id.clone());
            }
        }
    }
    let mut ranked: Vec<FixFirst> = declared_dependents
        .into_iter()
        .map(|(id, mut deps)| {
            deps.sort();
            FixFirst {
                feature: feature_of.get(&id).cloned().unwrap_or_default(),
                status: status_of
                    .get(&id)
                    .map(|s| s.as_str().to_string())
                    .unwrap_or_else(|| "?".to_string()),
                dependent_failure_count: deps.len() as u32,
                dependent_failure_ids: deps,
                id,
            }
        })
        .collect();
    ranked.sort_by(|a, b| {
        b.dependent_failure_count
            .cmp(&a.dependent_failure_count)
            .then(a.id.cmp(&b.id))
    });
    ranked
}

// ---------------------------------------------------------------------------
// Breadth metrics (honest — no fabricated "% of all CSS" denominator)
// ---------------------------------------------------------------------------

/// Breadth, not score: how many distinct (category/feature) pairs we even probe,
/// plus a fixture-count breakdown by expected_support. There is intentionally no
/// `coverage_pct` against a whole-CSS total — that denominator does not exist.
pub(crate) fn compute_coverage(report: &Report) -> Coverage {
    let mut covered: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut implemented = 0u32;
    let mut partial = 0u32;
    let mut unsupported = 0u32;
    for c in &report.categories {
        for f in &c.features {
            // Probes are substrate canaries, not taxonomy surface entries.
            if c.category != "probes" {
                covered.insert(format!("{}/{}", c.category, f.feature));
            }
            for fx in &f.fixtures {
                match fx.expected_support.as_str() {
                    "partial" => partial += 1,
                    "unsupported" => unsupported += 1,
                    _ => implemented += 1,
                }
            }
        }
    }
    let n = covered.len() as u32;
    let results: Vec<_> = report
        .categories
        .iter()
        .flat_map(|category| &category.features)
        .flat_map(|feature| &feature.fixtures)
        .collect();
    let interactions = super::interaction_coverage::report_coverage(&results);
    Coverage {
        features_with_fixture: n,
        covered: covered.into_iter().collect(),
        implemented,
        partial,
        unsupported,
        interaction_families: interactions.family_count,
        interaction_pairs_required: interactions.required_pair_count,
        interaction_pairs_covered: interactions.covered_pair_count,
        interaction_pairs_missing: interactions.missing_pairs,
    }
}

pub(crate) fn build_report(mut results: Vec<FixtureResult>, pdftoppm_available: bool) -> Report {
    // A visual PASS can retain raw exact variance. Keep that diagnosis visible;
    // only a genuinely byte-identical visual PASS has nothing residual to inspect.
    for result in &mut results {
        if result.status == Status::Pass
            && result
                .diagnosis
                .as_ref()
                .is_some_and(|diagnosis| diagnosis.different_pixels == 0)
        {
            result.diagnosis = None;
        }
    }

    results.sort_by(|a, b| {
        (a.category.as_str(), a.feature.as_str(), a.id.as_str()).cmp(&(
            b.category.as_str(),
            b.feature.as_str(),
            b.id.as_str(),
        ))
    });

    let total = results.len() as u32;
    let overall_score = score(results.iter());

    // Group category -> feature -> [results]
    let mut cat_map: BTreeMap<String, BTreeMap<String, Vec<FixtureResult>>> = BTreeMap::new();
    for r in results {
        cat_map
            .entry(r.category.clone())
            .or_default()
            .entry(r.feature.clone())
            .or_default()
            .push(r);
    }

    let mut categories = Vec::new();
    let mut overall_counts = Counts::default();
    for (cat, feats) in cat_map {
        let mut feat_reports = Vec::new();
        let mut cat_counts = Counts::default();
        for (feat, fxs) in feats {
            let mut counts = Counts::default();
            for fx in &fxs {
                counts.add(fx.status);
                cat_counts.add(fx.status);
                overall_counts.add(fx.status);
            }
            let feature_score = score(fxs.iter());
            feat_reports.push(FeatureReport {
                feature: feat,
                score_pct: feature_score,
                counts,
                fixtures: fxs,
            });
        }
        let category_score = score(
            feat_reports
                .iter()
                .flat_map(|feature| feature.fixtures.iter()),
        );
        categories.push(CategoryReport {
            category: cat,
            score_pct: category_score,
            counts: cat_counts,
            features: feat_reports,
        });
    }

    Report {
        schema_version: 12,
        invocation_id: String::new(),
        run_complete: true,
        env: EnvBlock {
            dpi: DPI,
            pdftoppm_available,
            rasterizer_source_path: String::new(),
            rasterizer_executed_path: String::new(),
            rasterizer_arguments: String::new(),
            rasterizer_version: String::new(),
            rasterizer_sha256: String::new(),
        },
        overall: Overall {
            score_pct: overall_score,
            pass: overall_counts.pass,
            fail: overall_counts.fail,
            reference_disputed: overall_counts.reference_disputed,
            total,
        },
        categories,
        corpus_issues: Vec::new(),
        coverage: Coverage::default(),
        fix_first: Vec::new(),
        ref_mismatches: Vec::new(),
        suspect_unsupported_pass: Vec::new(),
        stale_refs: Vec::new(),
        refs_lock_present: false,
        refs_lock_sha256: String::new(),
        baseline_present: false,
        gate_failure: None,
    }
}

// ---------------------------------------------------------------------------
// Regression gate
// ---------------------------------------------------------------------------

fn fixtures(report: &Report) -> impl Iterator<Item = &FixtureResult> {
    report
        .categories
        .iter()
        .flat_map(|category| &category.features)
        .flat_map(|feature| &feature.fixtures)
}

fn status_rank(status: Status) -> u8 {
    match status {
        Status::Fail => 0,
        Status::ReferenceDisputed => 1,
        Status::Pass => 2,
    }
}

fn counts_tuple(counts: &Counts) -> (u32, u32, u32) {
    (counts.pass, counts.fail, counts.reference_disputed)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Enforce harness-integrity invariants that must hold even during an intentional
/// baseline update.
///
/// A baseline is reviewed regression history, never a source of fixture verdicts.
/// Report-integrity failures are independent of the candidate's visual PASS/FAIL
/// results. Both the gate and the human report consume this one checklist so a
/// gate-red report cannot present an OK integrity headline.
pub(crate) fn current_integrity_problems(current: &Report) -> Vec<String> {
    let mut problems = Vec::new();

    if current.overall.total == 0 {
        problems.push("the full parity run contains no fixtures".to_string());
    }
    if !current.run_complete {
        problems.push("the parity run did not complete".to_string());
    }
    if !current.refs_lock_present {
        problems.push("refs.lock is missing or invalid".to_string());
    }
    if !is_sha256(&current.refs_lock_sha256) {
        problems.push("refs.lock identity is missing or invalid".to_string());
    }
    if current.env.dpi != DPI {
        problems.push(format!(
            "rasterization DPI {} does not match the compiled contract {DPI}",
            current.env.dpi
        ));
    }
    if !current.env.pdftoppm_available {
        problems.push("pdftoppm is unavailable".to_string());
    } else if current.env.rasterizer_source_path.is_empty()
        || current.env.rasterizer_executed_path.is_empty()
        || current.env.rasterizer_arguments.is_empty()
        || current.env.rasterizer_version.is_empty()
        || !is_sha256(&current.env.rasterizer_sha256)
    {
        problems.push("pdftoppm executable identity is incomplete".to_string());
    }
    for stale in &current.stale_refs {
        problems.push(format!("stale reference: {} ({})", stale.id, stale.reason));
    }
    for issue in &current.corpus_issues {
        let fixtures = if issue.fixtures.is_empty() {
            "no fixture/path recorded".to_string()
        } else {
            issue.fixtures.join(", ")
        };
        problems.push(format!(
            "corpus {} [{}]: {}",
            issue.kind.as_str(),
            fixtures,
            issue.detail
        ));
    }
    for mismatch in &current.ref_mismatches {
        problems.push(format!(
            "reference filename mismatch: {}/{} expected {}",
            mismatch.category, mismatch.id, mismatch.expected_ref
        ));
    }

    // Recompute every aggregate from fixture rows. The summary is evidence, not
    // an independently trusted counter that may drift from (or conceal) the
    // actual worklist.
    let mut seen = std::collections::BTreeSet::new();
    let mut actual_overall = Counts::default();
    let mut fixture_total = 0u32;
    for category in &current.categories {
        let mut actual_category = Counts::default();
        for feature in &category.features {
            let mut actual_feature = Counts::default();
            for fixture in &feature.fixtures {
                fixture_total += 1;
                actual_feature.add(fixture.status);
                actual_category.add(fixture.status);
                actual_overall.add(fixture.status);

                if fixture.category != category.category {
                    problems.push(format!(
                        "fixture {} is filed under category {} but declares {}",
                        fixture.id, category.category, fixture.category
                    ));
                }
                if fixture.feature != feature.feature {
                    problems.push(format!(
                        "fixture {} is filed under feature {} but declares {}",
                        fixture.id, feature.feature, fixture.feature
                    ));
                }
                if !seen.insert(fixture.id.as_str()) {
                    problems.push(format!("duplicate fixture result id: {}", fixture.id));
                }
                if !matches!(
                    fixture.expected_support.as_str(),
                    "implemented" | "partial" | "unsupported"
                ) {
                    problems.push(format!(
                        "{} has invalid expected_support {:?}",
                        fixture.id, fixture.expected_support
                    ));
                }
                if fixture.status == Status::ReferenceDisputed && !fixture.reference.is_disputed() {
                    problems.push(format!(
                        "fixture is REFERENCE-DISPUTED without a disputed oracle assessment: {}",
                        fixture.id
                    ));
                }
                if !is_sha256(&fixture.html_sha256) {
                    problems.push(format!(
                        "fixture has no valid HTML fingerprint: {}",
                        fixture.id
                    ));
                }
                if fixture.raster.candidate.is_empty() {
                    problems.push(format!(
                        "fixture has no candidate raster fingerprint: {}",
                        fixture.id
                    ));
                }
                if fixture.raster.oracle.is_empty() {
                    problems.push(format!(
                        "fixture has no oracle raster fingerprint: {}",
                        fixture.id
                    ));
                }
                for (side, pages) in [
                    ("candidate", &fixture.raster.candidate),
                    ("oracle", &fixture.raster.oracle),
                ] {
                    for (index, page) in pages.iter().enumerate() {
                        let pixels = u64::from(page.width) * u64::from(page.height);
                        if page.width == 0
                            || page.height == 0
                            || !is_sha256(&page.rgba_sha256)
                            || page.painted_pixels > pixels
                        {
                            problems.push(format!(
                                "fixture has an invalid {side} page {} fingerprint: {}",
                                index + 1,
                                fixture.id
                            ));
                        }
                    }
                }
                let oracle_is_blank = !fixture.raster.oracle.is_empty()
                    && fixture
                        .raster
                        .oracle
                        .iter()
                        .all(|page| page.painted_pixels == 0);
                let blank_is_structured = current.corpus_issues.iter().any(|issue| {
                    issue.kind == super::report::CorpusIssueKind::MissingPaint
                        && issue.fixtures.iter().any(|id| id == &fixture.id)
                });
                if oracle_is_blank && !blank_is_structured {
                    problems.push(format!(
                        "fixture oracle has zero painted pixels across all pages: {}",
                        fixture.id
                    ));
                }
                if fixture.status == Status::Pass
                    && (fixture.raster.candidate.is_empty() || fixture.raster.oracle.is_empty())
                {
                    problems.push(format!(
                        "fixture is PASS without complete candidate/oracle raster evidence: {}",
                        fixture.id
                    ));
                }
                if !fixture.diff_pct.is_finite() || !(0.0..=100.0).contains(&fixture.diff_pct) {
                    problems.push(format!(
                        "fixture has an invalid raw diff percentage: {} ({:?})",
                        fixture.id, fixture.diff_pct
                    ));
                }
            }

            if counts_tuple(&feature.counts) != counts_tuple(&actual_feature) {
                problems.push(format!(
                    "feature summary disagrees with fixture rows: {}/{}",
                    category.category, feature.feature
                ));
            }
            let actual_score = score(feature.fixtures.iter());
            if feature.score_pct != actual_score {
                problems.push(format!(
                    "feature visual-parity rate disagrees with fixture rows: {}/{} ({:.2}% != {:.2}%)",
                    category.category, feature.feature, feature.score_pct, actual_score
                ));
            }
        }

        if counts_tuple(&category.counts) != counts_tuple(&actual_category) {
            problems.push(format!(
                "category summary disagrees with fixture rows: {}",
                category.category
            ));
        }
        let actual_score = score(
            category
                .features
                .iter()
                .flat_map(|feature| feature.fixtures.iter()),
        );
        if category.score_pct != actual_score {
            problems.push(format!(
                "category visual-parity rate disagrees with fixture rows: {} ({:.2}% != {:.2}%)",
                category.category, category.score_pct, actual_score
            ));
        }
    }

    let reported_counts = (
        current.overall.pass,
        current.overall.fail,
        current.overall.reference_disputed,
    );
    if reported_counts != counts_tuple(&actual_overall) || current.overall.total != fixture_total {
        problems.push(format!(
            "overall summary disagrees with fixture rows: reported {} total, found {}",
            current.overall.total, fixture_total
        ));
    }
    let actual_score = score(fixtures(current));
    if current.overall.score_pct != actual_score {
        problems.push(format!(
            "overall visual-parity rate disagrees with fixture rows ({:.2}% != {:.2}%)",
            current.overall.score_pct, actual_score
        ));
    }
    problems
}

fn current_health_problems(current: &Report) -> Vec<String> {
    let mut problems = current_integrity_problems(current);
    if let Some(failure) = &current.gate_failure {
        problems.push(format!("report records a terminal gate failure: {failure}"));
    }
    for fixture in fixtures(current) {
        if fixture.status.is_failure() {
            problems.push(format!(
                "fixture is {}: {} [{}/{}] expected_support={} {}",
                fixture.status.as_str(),
                fixture.id,
                fixture.category,
                fixture.feature,
                fixture.expected_support,
                fixture.note
            ));
        }
    }
    problems
}

fn enforce_no_problems(label: &str, problems: Vec<String>) -> Result<(), String> {
    if problems.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{label} ({} issue(s)):\n  - {}",
            problems.len(),
            problems.join("\n  - ")
        ))
    }
}

pub(crate) fn enforce_current_health(current: &Report) -> Result<(), String> {
    enforce_no_problems(
        "parity integrity gate FAILED",
        current_health_problems(current),
    )
}

/// Validate an explicit regression-snapshot replacement without changing any
/// current fixture verdict or silently shrinking the reviewed corpus.
///
/// A snapshot may retain failing fixtures: their FAIL status and exact raster
/// fingerprints remain current-health failures, while the snapshot makes any
/// later movement, worsening, disappearance, or new failure detectable.
/// Reference/rasterizer identities may intentionally change in update mode, but
/// every prior fixture id must remain.
pub(crate) fn enforce_baseline_update(
    baseline: &BaselineState,
    current: &Report,
) -> Result<(), String> {
    enforce_no_problems(
        "parity baseline update FAILED: current report is structurally invalid",
        current_integrity_problems(current),
    )?;

    let previous = match baseline {
        BaselineState::Missing => return Ok(()),
        BaselineState::Invalid(error) => {
            return Err(format!(
                "parity baseline update FAILED: existing baseline.json is invalid or unreadable: {error}"
            ));
        }
        BaselineState::Valid(previous) => previous,
    };
    if previous.schema_version != current.schema_version {
        return Err(format!(
            "parity baseline update FAILED: existing baseline schema {} != current schema {}",
            previous.schema_version, current.schema_version
        ));
    }
    enforce_no_problems(
        "parity baseline update FAILED: existing baseline is structurally invalid",
        current_integrity_problems(previous),
    )?;

    let previous_by_id = previous.by_id();
    let current_by_id = current.by_id();
    let missing: Vec<&str> = previous_by_id
        .keys()
        .copied()
        .filter(|id| !current_by_id.contains_key(id))
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "parity baseline update FAILED: refusing to remove {} prior fixture(s): {}",
            missing.len(),
            missing.join(", ")
        ));
    }

    Ok(())
}

/// Whether a parsed baseline is a usable regression snapshot for this run.
/// Parsing alone is insufficient: the snapshot must be structurally sound, use
/// the current schema, and bind the same authenticated fixture/oracle corpus.
/// Retained FAIL verdicts do not make the snapshot incompatible; they remain
/// failures in the current-health gate.
pub(crate) fn baseline_is_compatible(baseline: &BaselineState, current: &Report) -> bool {
    let Some(baseline) = baseline.report() else {
        return false;
    };
    baseline.schema_version == current.schema_version
        && !current.refs_lock_sha256.is_empty()
        && baseline.refs_lock_sha256 == current.refs_lock_sha256
        && baseline.env.dpi == current.env.dpi
        && !current.env.rasterizer_sha256.is_empty()
        && baseline.env.rasterizer_sha256 == current.env.rasterizer_sha256
        && baseline.env.rasterizer_version == current.env.rasterizer_version
        && baseline.env.rasterizer_arguments == current.env.rasterizer_arguments
        && current_integrity_problems(baseline).is_empty()
}

pub(crate) fn enforce_gate(baseline: &BaselineState, current: &Report) -> Result<(), String> {
    let mut problems = current_health_problems(current);

    let base = match baseline {
        BaselineState::Missing => {
            problems.push(
                "committed baseline.json is missing; use PARITY_UPDATE_BASELINE=1 only after reviewing the current report"
                    .to_string(),
            );
            return enforce_no_problems("parity gate FAILED", problems);
        }
        BaselineState::Invalid(error) => {
            problems.push(format!(
                "committed baseline.json is invalid or unreadable: {error}"
            ));
            return enforce_no_problems("parity gate FAILED", problems);
        }
        BaselineState::Valid(base) => base,
    };

    if base.schema_version != current.schema_version {
        problems.push(format!(
            "baseline schema {} != current schema {}; use PARITY_UPDATE_BASELINE=1 after reviewing the current report",
            base.schema_version, current.schema_version
        ));
        return enforce_no_problems("parity gate FAILED", problems);
    }
    let baseline_integrity = current_integrity_problems(base);
    if !baseline_integrity.is_empty() {
        problems.extend(
            baseline_integrity
                .into_iter()
                .map(|problem| format!("committed baseline is structurally invalid: {problem}")),
        );
        return enforce_no_problems("parity gate FAILED", problems);
    }
    let health_problem_count = problems.len();
    if base.refs_lock_sha256 != current.refs_lock_sha256 {
        problems.push(format!(
            "refs.lock identity changed (baseline {} != current {}); fixture/oracle identity changes require an explicit reviewed baseline update",
            base.refs_lock_sha256, current.refs_lock_sha256
        ));
    }
    if base.env.rasterizer_sha256 != current.env.rasterizer_sha256 {
        problems.push(format!(
            "pdftoppm executable identity changed (baseline {} != current {}); rasterizer changes require explicit review",
            base.env.rasterizer_sha256, current.env.rasterizer_sha256
        ));
    }
    if base.env.rasterizer_version != current.env.rasterizer_version {
        problems.push(format!(
            "pdftoppm version changed (baseline {:?} != current {:?}); rasterizer changes require explicit review",
            base.env.rasterizer_version, current.env.rasterizer_version
        ));
    }
    if base.env.rasterizer_arguments != current.env.rasterizer_arguments {
        problems.push(format!(
            "pdftoppm argument contract changed (baseline {:?} != current {:?}); comparator changes require explicit review",
            base.env.rasterizer_arguments, current.env.rasterizer_arguments
        ));
    }
    if base.env.dpi != current.env.dpi {
        problems.push(format!(
            "rasterization DPI changed (baseline {} != current {}); comparator changes require explicit review",
            base.env.dpi, current.env.dpi
        ));
    }
    if problems.len() != health_problem_count {
        return enforce_no_problems("parity gate FAILED", problems);
    }

    let base_by_id = base.by_id();
    let cur_by_id = current.by_id();

    // Every committed fixture must remain present, and PASS -> FAIL is a
    // regression regardless of the rounded scalar.
    for (id, baseline_fixture) in &base_by_id {
        let Some(current_fixture) = cur_by_id.get(id) else {
            problems.push(format!("baseline fixture disappeared: {id}"));
            continue;
        };
        if baseline_fixture.status == Status::ReferenceDisputed
            || current_fixture.status == Status::ReferenceDisputed
        {
            if current_fixture.status != baseline_fixture.status
                || current_fixture.raster != baseline_fixture.raster
            {
                problems.push(format!(
                    "disputed-reference evidence changed: {} {} -> {} [{}/{}]; explicit baseline review required",
                    id,
                    baseline_fixture.status.as_str(),
                    current_fixture.status.as_str(),
                    current_fixture.category,
                    current_fixture.feature,
                ));
            }
        } else if status_rank(current_fixture.status) < status_rank(baseline_fixture.status) {
            problems.push(format!(
                "status regression: {} {} -> {} [{}/{}] diff {:.4}% -> {:.4}% {}",
                id,
                baseline_fixture.status.as_str(),
                current_fixture.status.as_str(),
                current_fixture.category,
                current_fixture.feature,
                baseline_fixture.diff_pct,
                current_fixture.diff_pct,
                current_fixture.note
            ));
        } else if current_fixture.status == baseline_fixture.status
            && current_fixture.raster != baseline_fixture.raster
        {
            problems.push(format!(
                "raster fingerprint changed: {} {} {:.4}% -> {:.4}% [{}/{}]; explicit baseline review required: {}",
                id,
                current_fixture.status.as_str(),
                baseline_fixture.diff_pct,
                current_fixture.diff_pct,
                current_fixture.category,
                current_fixture.feature,
                current_fixture.note
            ));
        }
    }

    // A new broken/unknown fixture is also a real regression. No support label
    // or explicit baseline-update request can make it healthy.
    for (id, current_fixture) in &cur_by_id {
        if !base_by_id.contains_key(id) && current_fixture.status != Status::Pass {
            problems.push(format!(
                "new fixture is {}: {} [{}/{}] {}",
                current_fixture.status.as_str(),
                id,
                current_fixture.category,
                current_fixture.feature,
                current_fixture.note
            ));
        }
    }

    enforce_no_problems("parity gate FAILED", problems)
}

#[cfg(test)]
mod gate_tests {
    use super::super::report::{CorpusIssue, CorpusIssueKind};
    use super::{
        BaselineState, DPI, FixtureResult, RasterEvidence, RasterFingerprint, Report, Status,
        baseline_is_compatible, build_report, enforce_baseline_update, enforce_current_health,
        enforce_gate, load_baseline, score,
    };

    fn fixture(id: &str, status: Status, expected_support: &str) -> FixtureResult {
        FixtureResult {
            id: id.to_string(),
            category: "gate-test".to_string(),
            feature: "gate".to_string(),
            subfeature: String::new(),
            interaction_of: Vec::new(),
            base_ids: Vec::new(),
            status,
            diff_pct: if status == Status::Pass { 0.0 } else { 1.0 },
            semantic_diff_pct: if status == Status::Pass { 0.0 } else { 1.0 },
            description: String::new(),
            note: "test fixture".to_string(),
            kind: "feature".to_string(),
            depends_on: Vec::new(),
            expected_support: expected_support.to_string(),
            oracle: "chrome".to_string(),
            reference: Default::default(),
            dependency_context: String::new(),
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

    fn report(fixtures: Vec<FixtureResult>) -> Report {
        let mut report = build_report(fixtures, true);
        report.refs_lock_present = true;
        report.refs_lock_sha256 = "3".repeat(64);
        report.env.rasterizer_source_path = "/test/source/pdftoppm".to_string();
        report.env.rasterizer_executed_path = "/test/snapshot/pdftoppm".to_string();
        report.env.rasterizer_arguments = "[-r, 144, -png, <PDF>, <PREFIX>]".to_string();
        report.env.rasterizer_version = "pdftoppm version test".to_string();
        report.env.rasterizer_sha256 = "4".repeat(64);
        report
    }

    fn valid_baseline(report: &Report) -> BaselineState {
        BaselineState::Valid(report.clone())
    }

    #[test]
    fn baseline_loader_distinguishes_missing_malformed_and_valid() {
        let path = std::env::temp_dir().join(format!(
            "ironpress-baseline-state-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        assert!(matches!(load_baseline(&path), BaselineState::Missing));

        std::fs::write(&path, "{ malformed").unwrap();
        let BaselineState::Invalid(error) = load_baseline(&path) else {
            panic!("malformed baseline must remain distinguishable from missing")
        };
        assert!(error.contains("cannot parse existing"));

        let valid = report(vec![fixture("present", Status::Pass, "implemented")]);
        std::fs::write(&path, serde_json::to_vec(&valid).unwrap()).unwrap();
        let BaselineState::Valid(loaded) = load_baseline(&path) else {
            panic!("valid baseline must load")
        };
        assert_eq!(loaded.overall.total, 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn missing_baseline_fails_closed() {
        let current = report(vec![fixture("present", Status::Pass, "implemented")]);
        let error = enforce_gate(&BaselineState::Missing, &current).unwrap_err();
        assert!(error.contains("committed baseline.json is missing"));
    }

    #[test]
    fn baseline_update_accepts_a_reviewed_failing_snapshot_but_not_invalid_json() {
        let current = report(vec![fixture("present", Status::Pass, "implemented")]);
        assert!(enforce_baseline_update(&BaselineState::Missing, &current).is_ok());

        let invalid = BaselineState::Invalid("JSON syntax error at line 3".to_string());
        let error = enforce_baseline_update(&invalid, &current).unwrap_err();
        assert!(error.contains("existing baseline.json is invalid or unreadable"));
        assert!(error.contains("JSON syntax error at line 3"));

        let failing = report(vec![fixture("present", Status::Fail, "implemented")]);
        assert!(enforce_baseline_update(&valid_baseline(&failing), &current).is_ok());
    }

    #[test]
    fn baseline_update_rejects_loss_of_every_prior_fixture_id() {
        let previous = report(vec![
            fixture("retained", Status::Pass, "implemented"),
            fixture("removed-a", Status::Pass, "implemented"),
            fixture("removed-b", Status::Pass, "implemented"),
        ]);
        let current = report(vec![fixture("retained", Status::Pass, "implemented")]);

        let error = enforce_baseline_update(&valid_baseline(&previous), &current).unwrap_err();
        assert!(error.contains("refusing to remove 2 prior fixture(s)"));
        assert!(error.contains("removed-a"));
        assert!(error.contains("removed-b"));
    }

    #[test]
    fn baseline_update_allows_reviewed_identity_changes_when_prior_ids_remain() {
        let previous = report(vec![fixture("retained", Status::Pass, "implemented")]);
        let mut current = report(vec![
            fixture("retained", Status::Pass, "implemented"),
            fixture("added", Status::Pass, "implemented"),
        ]);
        current.refs_lock_sha256 = "5".repeat(64);
        current.env.rasterizer_sha256 = "6".repeat(64);

        assert!(enforce_baseline_update(&valid_baseline(&previous), &current).is_ok());
    }

    #[test]
    fn a_recorded_terminal_gate_failure_is_never_healthy() {
        let mut current = report(vec![fixture("present", Status::Pass, "implemented")]);
        current.gate_failure = Some("parity gate FAILED: exact test cause".to_string());

        let error = enforce_current_health(&current).unwrap_err();
        assert!(error.contains("report records a terminal gate failure"));
        assert!(error.contains("parity gate FAILED: exact test cause"));
    }

    #[test]
    fn exact_match_rate_includes_failures_in_the_denominator() {
        let fixtures = vec![
            fixture("exact", Status::Pass, "implemented"),
            fixture("different", Status::Fail, "implemented"),
        ];
        assert_eq!(score(&fixtures), 50.0);
        let report = build_report(fixtures, true);
        assert_eq!(report.overall.score_pct, 50.0);
    }

    #[test]
    fn baseline_presence_requires_a_compatible_structural_snapshot() {
        let current = report(vec![fixture("current", Status::Pass, "implemented")]);
        let valid = report(vec![fixture("current", Status::Pass, "implemented")]);
        assert!(baseline_is_compatible(&valid_baseline(&valid), &current));

        let mut wrong_schema = valid.clone();
        wrong_schema.schema_version += 1;
        assert!(!baseline_is_compatible(
            &valid_baseline(&wrong_schema),
            &current
        ));

        let mut wrong_refs = valid.clone();
        wrong_refs.refs_lock_sha256 = "5".repeat(64);
        assert!(!baseline_is_compatible(
            &valid_baseline(&wrong_refs),
            &current
        ));

        let mut wrong_rasterizer = valid.clone();
        wrong_rasterizer.env.rasterizer_sha256 = "6".repeat(64);
        assert!(!baseline_is_compatible(
            &valid_baseline(&wrong_rasterizer),
            &current
        ));

        let mut wrong_rasterizer_version = valid.clone();
        wrong_rasterizer_version.env.rasterizer_version = "pdftoppm changed".to_string();
        assert!(!baseline_is_compatible(
            &valid_baseline(&wrong_rasterizer_version),
            &current
        ));

        let mut wrong_rasterizer_arguments = valid.clone();
        wrong_rasterizer_arguments.env.rasterizer_arguments =
            "[-r, 144, -singlefile, -png, <PDF>, <PREFIX>]".to_string();
        assert!(!baseline_is_compatible(
            &valid_baseline(&wrong_rasterizer_arguments),
            &current
        ));

        let failing = report(vec![fixture("current", Status::Fail, "implemented")]);
        assert!(baseline_is_compatible(&valid_baseline(&failing), &current));
        assert!(!baseline_is_compatible(&BaselineState::Missing, &current));
        assert!(!baseline_is_compatible(
            &BaselineState::Invalid("broken".to_string()),
            &current
        ));
    }

    #[test]
    fn every_failure_is_a_health_failure_regardless_of_support_label() {
        let current = report(vec![fixture("broken", Status::Fail, "implemented")]);
        let error = enforce_current_health(&current).unwrap_err();
        assert!(error.contains("fixture is FAIL: broken"));

        let gap = report(vec![fixture("known-gap", Status::Fail, "unsupported")]);
        let error = enforce_current_health(&gap).unwrap_err();
        assert!(error.contains("fixture is FAIL: known-gap"));
    }

    #[test]
    fn disputed_reference_is_reviewable_without_becoming_a_health_failure() {
        let mut disputed = fixture("oracle-conflict", Status::ReferenceDisputed, "implemented");
        disputed.reference.status = super::super::manifest::ReferenceStatus::Disputed;
        let baseline = report(vec![disputed]);
        assert!(enforce_current_health(&baseline).is_ok());

        let changed = report(vec![fixture(
            "oracle-conflict",
            Status::Pass,
            "implemented",
        )]);
        let error = enforce_gate(&valid_baseline(&baseline), &changed).unwrap_err();
        assert!(error.contains("disputed-reference evidence changed"));
    }

    #[test]
    fn every_status_downgrade_fails_current_health_before_baseline_comparison() {
        let baseline = report(vec![fixture("existing", Status::Pass, "partial")]);
        let current = report(vec![fixture("existing", Status::Fail, "partial")]);
        let error = enforce_gate(&valid_baseline(&baseline), &current).unwrap_err();
        assert!(error.contains("fixture is FAIL: existing"));
    }

    #[test]
    fn disappeared_baseline_fixture_is_a_regression() {
        let baseline = report(vec![fixture("removed", Status::Pass, "implemented")]);
        let current = report(vec![fixture("other", Status::Pass, "implemented")]);
        let error = enforce_gate(&valid_baseline(&baseline), &current).unwrap_err();
        assert!(error.contains("baseline fixture disappeared: removed"));
    }

    #[test]
    fn new_non_pass_fixture_requires_an_explicit_baseline_update() {
        let baseline = report(vec![fixture("existing", Status::Pass, "implemented")]);
        let current = report(vec![
            fixture("existing", Status::Pass, "implemented"),
            fixture("new-gap", Status::Fail, "partial"),
        ]);
        let error = enforce_gate(&valid_baseline(&baseline), &current).unwrap_err();
        assert!(error.contains("fixture is FAIL: new-gap"));
    }

    #[test]
    fn support_labels_are_descriptive_only() {
        let current = report(vec![fixture("stale-label", Status::Pass, "unsupported")]);
        assert!(enforce_current_health(&current).is_ok());
    }

    #[test]
    fn a_failing_baseline_tracks_regressions_without_blessing_current_health() {
        let baseline = report(vec![fixture("existing", Status::Fail, "partial")]);
        let improved = report(vec![fixture("existing", Status::Pass, "partial")]);
        assert!(enforce_gate(&valid_baseline(&baseline), &improved).is_ok());

        let unchanged = report(vec![fixture("existing", Status::Fail, "partial")]);
        let error = enforce_gate(&valid_baseline(&baseline), &unchanged).unwrap_err();
        assert!(error.contains("fixture is FAIL: existing"));
        assert!(!error.contains("baseline is structurally invalid"));
    }

    #[test]
    fn changed_refs_lock_identity_cannot_reuse_a_compatible_baseline() {
        let baseline = report(vec![fixture("existing", Status::Pass, "implemented")]);
        let mut current = report(vec![fixture("existing", Status::Pass, "implemented")]);
        current.refs_lock_sha256 = "5".repeat(64);
        let error = enforce_gate(&valid_baseline(&baseline), &current).unwrap_err();
        assert!(error.contains("refs.lock identity changed"));
    }

    #[test]
    fn unavailable_or_changed_rasterizer_cannot_reuse_a_compatible_baseline() {
        let baseline = report(vec![fixture("existing", Status::Pass, "implemented")]);

        let mut unavailable = baseline.clone();
        unavailable.env.pdftoppm_available = false;
        let error = enforce_current_health(&unavailable).unwrap_err();
        assert!(error.contains("pdftoppm is unavailable"));

        let mut changed = baseline.clone();
        changed.env.rasterizer_sha256 = "6".repeat(64);
        let error = enforce_gate(&valid_baseline(&baseline), &changed).unwrap_err();
        assert!(error.contains("pdftoppm executable identity changed"));

        let mut changed_version = baseline.clone();
        changed_version.env.rasterizer_version = "pdftoppm changed".to_string();
        let error = enforce_gate(&valid_baseline(&baseline), &changed_version).unwrap_err();
        assert!(error.contains("pdftoppm version changed"));

        let mut changed_arguments = baseline.clone();
        changed_arguments.env.rasterizer_arguments =
            "[-r, 144, -singlefile, -png, <PDF>, <PREFIX>]".to_string();
        let error = enforce_gate(&valid_baseline(&baseline), &changed_arguments).unwrap_err();
        assert!(error.contains("pdftoppm argument contract changed"));

        let mut wrong_dpi = baseline.clone();
        wrong_dpi.env.dpi = DPI / 2;
        let error = enforce_current_health(&wrong_dpi).unwrap_err();
        assert!(error.contains("does not match the compiled contract"));

        let mut changed_pixels = baseline.clone();
        changed_pixels.categories[0].features[0].fixtures[0]
            .raster
            .candidate[0]
            .rgba_sha256 = "2".repeat(64);
        changed_pixels.categories[0].features[0].fixtures[0]
            .raster
            .oracle[0]
            .rgba_sha256 = "2".repeat(64);
        let error = enforce_gate(&valid_baseline(&baseline), &changed_pixels).unwrap_err();
        assert!(error.contains("raster fingerprint changed"));
    }

    #[test]
    fn summary_counters_cannot_claim_more_passes_than_fixture_rows() {
        let mut current = report(vec![fixture("existing", Status::Pass, "implemented")]);
        current.overall.pass = 2;
        current.overall.total = 2;
        current.overall.score_pct = 100.0;
        let error = enforce_current_health(&current).unwrap_err();
        assert!(error.contains("overall summary disagrees with fixture rows"));
    }

    #[test]
    fn fixture_rows_cannot_be_hidden_under_the_wrong_group() {
        let mut current = report(vec![fixture("existing", Status::Pass, "implemented")]);
        current.categories[0].features[0].fixtures[0].category = "other".to_string();
        let error = enforce_current_health(&current).unwrap_err();
        assert!(error.contains("filed under category"));
    }

    #[test]
    fn malformed_raster_fingerprints_fail_integrity() {
        let mut current = report(vec![fixture("existing", Status::Pass, "implemented")]);
        current.categories[0].features[0].fixtures[0]
            .raster
            .candidate[0]
            .rgba_sha256 = "not-a-sha".to_string();
        let error = enforce_current_health(&current).unwrap_err();
        assert!(error.contains("invalid candidate page 1 fingerprint"));
    }

    #[test]
    fn exact_all_paper_oracle_cannot_be_a_healthy_pass() {
        let mut current = report(vec![fixture("blank", Status::Pass, "implemented")]);
        let fixture = &mut current.categories[0].features[0].fixtures[0];
        fixture.raster.candidate[0].painted_pixels = 0;
        fixture.raster.oracle[0].painted_pixels = 0;

        let error = enforce_current_health(&current).unwrap_err();
        assert!(error.contains("oracle has zero painted pixels across all pages: blank"));
    }

    #[test]
    fn every_structured_corpus_issue_is_visible_and_gate_fatal() {
        let mut current = report(vec![fixture("present", Status::Pass, "implemented")]);
        current.corpus_issues = vec![
            CorpusIssue {
                kind: CorpusIssueKind::DuplicateFixture,
                fixtures: vec!["clone-a".to_string(), "clone-b".to_string()],
                detail: "duplicate source evidence".to_string(),
            },
            CorpusIssue {
                kind: CorpusIssueKind::Symlink,
                fixtures: vec!["linked-oracle".to_string()],
                detail: "external artifact".to_string(),
            },
            CorpusIssue {
                kind: CorpusIssueKind::InvalidOracle,
                fixtures: vec!["oklab".to_string(), "srgb".to_string()],
                detail: "declared semantic distinction has identical oracle rasters".to_string(),
            },
        ];

        let error = enforce_current_health(&current).unwrap_err();
        for expected in [
            "corpus duplicate-fixture [clone-a, clone-b]: duplicate source evidence",
            "corpus symlink [linked-oracle]: external artifact",
            "corpus invalid-oracle [oklab, srgb]: declared semantic distinction has identical oracle rasters",
        ] {
            assert!(
                error.contains(expected),
                "missing {expected:?} from {error}"
            );
        }
    }
}
