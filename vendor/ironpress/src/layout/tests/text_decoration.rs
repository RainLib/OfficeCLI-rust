use crate::style::computed::TextDecorationStyle;

use super::support::visible_runs;

#[test]
fn block_decoration_reaches_text_through_a_structured_flex_item() {
    let runs = visible_runs(
        r#"<style>
            .stage { display: inline-flex; }
            .node { text-decoration: underline wavy #ef476f; }
        </style>
        <div class="stage"><div class="node"><div><span>Ag</span><span>Bb</span></div></div></div>"#,
    );

    assert!(!runs.is_empty());
    assert!(
        runs.iter().all(|run| {
            run.decorations
                .iter()
                .any(|decoration| decoration.lines.underline)
        }),
        "runs: {runs:#?}"
    );
}

#[test]
fn cartesian_fixture_retains_explicit_decoration_on_every_run() {
    let runs = visible_runs(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/parity/cases/interactions/",
        "interactions-cartesian-backgrounds-gradients-x-text-advanced.html"
    )));

    assert_eq!(runs.len(), 10, "runs: {runs:#?}");
    let decorated = runs
        .iter()
        .filter(|run| {
            run.decorations
                .iter()
                .any(|decoration| decoration.lines.underline)
        })
        .collect::<Vec<_>>();
    assert_eq!(decorated.len(), 8, "runs: {runs:#?}");
    assert!(
        decorated.iter().all(|run| run
            .decorations
            .iter()
            .all(|decoration| decoration.style == TextDecorationStyle::Solid)),
        "runs: {runs:#?}"
    );
    assert!(
        decorated.iter().all(|run| run
            .decorations
            .iter()
            .all(|decoration| decoration.thickness == Some(1.5))),
        "runs: {runs:#?}"
    );
}
