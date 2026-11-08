//! Auditable supported feature-family interaction product.
//!
//! The generated corpus contains exactly one fixture for every unordered pair
//! with replacement. Each fixture itself exercises same-element composition and
//! both nesting directions; the pair census therefore stays dense without
//! pretending that an arbitrary multi-family fixture proves an implicit clique.

use std::collections::{BTreeMap, BTreeSet};

use super::manifest::ManifestEntry;
use super::report::FixtureResult;

pub(crate) const CARTESIAN_FIXTURE_PREFIX: &str = "interactions-cartesian-";
const CROSS_CUTTING_FAMILIES: &[&str] = &["page-margins"];

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct FamilyPair {
    first: String,
    second: String,
}

impl FamilyPair {
    fn new(first: &str, second: &str) -> Self {
        if first <= second {
            Self {
                first: first.to_string(),
                second: second.to_string(),
            }
        } else {
            Self {
                first: second.to_string(),
                second: first.to_string(),
            }
        }
    }

    fn label(&self) -> String {
        format!("{} × {}", self.first, self.second)
    }

    fn fixture_id(&self) -> String {
        format!("{CARTESIAN_FIXTURE_PREFIX}{}-x-{}", self.first, self.second)
    }
}

trait InteractionSubject {
    fn id(&self) -> &str;
    fn category(&self) -> &str;
    fn kind(&self) -> &str;
    fn expected_support(&self) -> &str;
    fn interaction_of(&self) -> &[String];
}

impl InteractionSubject for ManifestEntry {
    fn id(&self) -> &str {
        &self.id
    }

    fn category(&self) -> &str {
        &self.category
    }

    fn kind(&self) -> &str {
        &self.kind
    }

    fn expected_support(&self) -> &str {
        &self.expected_support
    }

    fn interaction_of(&self) -> &[String] {
        &self.interaction_of
    }
}

impl InteractionSubject for &FixtureResult {
    fn id(&self) -> &str {
        &self.id
    }

    fn category(&self) -> &str {
        &self.category
    }

    fn kind(&self) -> &str {
        &self.kind
    }

    fn expected_support(&self) -> &str {
        &self.expected_support
    }

    fn interaction_of(&self) -> &[String] {
        &self.interaction_of
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct InteractionProductCoverage {
    pub(crate) declared: bool,
    pub(crate) family_count: u32,
    pub(crate) required_pair_count: u32,
    pub(crate) covered_pair_count: u32,
    pub(crate) missing_pairs: Vec<String>,
}

fn supported_families<T: InteractionSubject>(subjects: &[T]) -> BTreeSet<String> {
    let mut families: BTreeSet<_> = subjects
        .iter()
        .filter(|subject| {
            subject.kind() == "feature"
                && subject.expected_support() != "unsupported"
                && !matches!(subject.category(), "interactions" | "probes")
        })
        .map(|subject| subject.category().to_string())
        .collect();
    if subjects
        .iter()
        .any(|subject| subject.id().starts_with(CARTESIAN_FIXTURE_PREFIX))
    {
        families.extend(
            CROSS_CUTTING_FAMILIES
                .iter()
                .map(|family| family.to_string()),
        );
    }
    families
}

fn expected_pairs(families: &BTreeSet<String>) -> BTreeSet<FamilyPair> {
    let families: Vec<_> = families.iter().collect();
    let mut pairs = BTreeSet::new();
    for (index, first) in families.iter().enumerate() {
        for second in families.iter().skip(index) {
            pairs.insert(FamilyPair::new(first, second));
        }
    }
    pairs
}

fn declared_pairs<T: InteractionSubject>(
    subjects: &[T],
    families: &BTreeSet<String>,
) -> BTreeSet<FamilyPair> {
    let mut pairs = BTreeSet::new();
    for subject in subjects
        .iter()
        .filter(|subject| subject.kind() == "interaction")
    {
        let interaction = subject.interaction_of();
        for first_index in 0..interaction.len() {
            for second in interaction.iter().skip(first_index + 1) {
                let first = &interaction[first_index];
                if families.contains(first) && families.contains(second) {
                    pairs.insert(FamilyPair::new(first, second));
                }
            }
        }
    }
    pairs
}

fn analyze<T: InteractionSubject>(subjects: &[T]) -> InteractionProductCoverage {
    let families = supported_families(subjects);
    let expected = expected_pairs(&families);
    let declared = declared_pairs(subjects, &families);
    let missing_pairs = expected
        .difference(&declared)
        .map(FamilyPair::label)
        .collect();
    InteractionProductCoverage {
        declared: subjects
            .iter()
            .any(|subject| subject.id().starts_with(CARTESIAN_FIXTURE_PREFIX)),
        family_count: families.len() as u32,
        required_pair_count: expected.len() as u32,
        covered_pair_count: expected.intersection(&declared).count() as u32,
        missing_pairs,
    }
}

pub(crate) fn report_coverage(results: &[&FixtureResult]) -> InteractionProductCoverage {
    analyze(results)
}

/// Require the generated corpus to be an exact one-fixture-per-pair product.
/// Small synthetic unit-test corpora do not declare the generated prefix and
/// remain free to exercise manifest mechanics without constructing 300 files.
pub(crate) fn validate_manifest_product(entries: &[ManifestEntry]) -> Result<(), String> {
    let coverage = analyze(entries);
    if !coverage.declared {
        return Ok(());
    }
    if !coverage.missing_pairs.is_empty() {
        return Err(format!(
            "Cartesian interaction coverage is incomplete ({}/{} pairs):\n  - {}",
            coverage.covered_pair_count,
            coverage.required_pair_count,
            coverage.missing_pairs.join("\n  - ")
        ));
    }

    let families = supported_families(entries);
    let expected = expected_pairs(&families);
    let mut generated = BTreeMap::new();
    for entry in entries
        .iter()
        .filter(|entry| entry.id.starts_with(CARTESIAN_FIXTURE_PREFIX))
    {
        if entry.kind != "interaction" || entry.interaction_of.len() != 2 {
            return Err(format!(
                "generated Cartesian fixture '{}' must declare exactly one two-family interaction",
                entry.id
            ));
        }
        let pair = FamilyPair::new(&entry.interaction_of[0], &entry.interaction_of[1]);
        if !expected.contains(&pair) {
            return Err(format!(
                "generated Cartesian fixture '{}' declares unsupported pair {}",
                entry.id,
                pair.label()
            ));
        }
        if entry.id != pair.fixture_id() {
            return Err(format!(
                "generated Cartesian fixture id '{}' must be '{}'",
                entry.id,
                pair.fixture_id()
            ));
        }
        if let Some(previous) = generated.insert(pair.clone(), entry.id.as_str()) {
            return Err(format!(
                "generated Cartesian pair {} is duplicated by '{}' and '{}'",
                pair.label(),
                previous,
                entry.id
            ));
        }
    }
    if generated.len() != expected.len() {
        return Err(format!(
            "generated Cartesian fixture count {} does not match required pair count {}",
            generated.len(),
            expected.len()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(id: &str, category: &str, kind: &str, interaction: &[&str]) -> FixtureResult {
        FixtureResult {
            id: id.to_string(),
            category: category.to_string(),
            feature: "coverage".to_string(),
            subfeature: String::new(),
            interaction_of: interaction.iter().map(|value| value.to_string()).collect(),
            base_ids: Vec::new(),
            status: super::super::report::Status::Pass,
            diff_pct: 0.0,
            semantic_diff_pct: 0.0,
            description: String::new(),
            note: String::new(),
            kind: kind.to_string(),
            depends_on: Vec::new(),
            expected_support: "implemented".to_string(),
            oracle: "chrome".to_string(),
            reference: Default::default(),
            dependency_context: String::new(),
            html_sha256: String::new(),
            raster: Default::default(),
            diagnosis: None,
        }
    }

    #[test]
    fn product_includes_diagonal_without_treating_multi_family_entries_as_self_pairs() {
        let results = vec![
            fixture("a", "alpha", "feature", &[]),
            fixture("b", "beta", "feature", &[]),
            fixture("ab", "interactions", "interaction", &["alpha", "beta"]),
            fixture("aa", "interactions", "interaction", &["alpha", "alpha"]),
        ];
        let coverage = report_coverage(&results.iter().collect::<Vec<_>>());
        assert_eq!(coverage.family_count, 2);
        assert_eq!(coverage.required_pair_count, 3);
        assert_eq!(coverage.covered_pair_count, 2);
        assert_eq!(coverage.missing_pairs, ["beta × beta"]);
    }

    #[test]
    fn generated_product_includes_cross_cutting_page_context() {
        let results = vec![
            fixture("a", "alpha", "feature", &[]),
            fixture(
                "interactions-cartesian-alpha-x-page-margins",
                "interactions",
                "interaction",
                &["alpha", "page-margins"],
            ),
        ];
        let families = supported_families(&results.iter().collect::<Vec<_>>());
        assert_eq!(
            families,
            BTreeSet::from(["alpha".to_string(), "page-margins".to_string()])
        );
    }
}
