//! Shared contract for results that UI, CLI and Agent may report as verified.
//! Other native/browser functions remain available as compatibility previews;
//! their presence is not a promise of a verified recalculation.
use super::{tokenizer, types::TokenType};

pub const CALCULATION_CONTRACT: &str = "officecli-calculation/1";
pub const VERIFIED_FUNCTIONS: &[&str] = &[
    "SUM",
    "AVERAGE",
    "MIN",
    "MAX",
    "COUNT",
    "COUNTA",
    "COUNTBLANK",
    "ABS",
    "ROUND",
    "ROUNDUP",
    "ROUNDDOWN",
    "LEN",
    "RANK",
    "RANK_EQ",
    "RANK_AVG",
];

pub fn normalized_function(name: &str) -> String {
    let name = name.replace('.', "_").to_ascii_uppercase();
    name.strip_prefix("_XLFN__XLWS_")
        .or_else(|| name.strip_prefix("_XLFN_"))
        .unwrap_or(&name)
        .to_string()
}

pub fn check_formula_support(formula: &str) -> Result<(), String> {
    let tokens = tokenizer::tokenize(formula).map_err(|_| "unsupported_formula".to_string())?;
    for token in tokens {
        if token.tt == TokenType::Func
            && !VERIFIED_FUNCTIONS.contains(&normalized_function(&token.value).as_str())
        {
            return Err("unsupported_function".into());
        }
    }
    Ok(())
}

pub fn calculation_capabilities() -> serde_json::Value {
    serde_json::json!({
        "contractVersion": CALCULATION_CONTRACT,
        "verifiedFunctions": VERIFIED_FUNCTIONS,
        "maxRangeCells": super::resolver::MAX_RANGE_CELLS,
        "maxDependencyDepth": super::resolver::MAX_CALCULATION_DEPTH,
        "maxCalculationSteps": super::resolver::MAX_CALCULATION_STEPS,
        "source": "current-expressions-and-native-literals",
        "cachedResultsAreVerified": false,
        "unsupportedResult": "unavailable",
        "scalarValueTypes": ["number", "string", "boolean", "blank"],
        "nativeLiteralTypes": ["number", "string", "boolean", "blank", "error"],
        "literalTypesRequireBundleMetadata": true,
        "additionalEngineFunctions": "compatibility-preview-only"
    })
}
