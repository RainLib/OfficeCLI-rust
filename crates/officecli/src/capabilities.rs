//! One operation contract for CLI discovery, browser preflight and MCP.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, sync::OnceLock};

pub const AGENT_CONTINUATION_PROTOCOL: &str = "hcd-agent-continuation/1";
pub const AGENT_WORKFLOW_PROTOCOL: &str = "hcd-agent-workflow/1";

pub const PROTOCOL_HEADER: &str = "x-hcd-protocol-fingerprint";

/// Optional selection fields must be negotiated even when the coordinator's
/// base protocol version is unchanged, before an older service parses a plan.
pub fn validate_workflow_support(capabilities: &Value, plan: Option<&Value>) -> Result<(), String> {
    if capabilities["agentWorkflow"]["protocolVersion"] != AGENT_WORKFLOW_PROTOCOL {
        return Err("Connected service does not support this workflow protocol; refresh capabilities before planning.".into());
    }
    let has_identity = |selections: &Value| {
        selections
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item.get("identity").is_some()))
    };
    let requires_identity = plan.is_some_and(|plan| {
        has_identity(&plan["facts"])
            || plan["steps"]
                .as_array()
                .is_some_and(|steps| steps.iter().any(|step| has_identity(&step["produces"])))
    });
    if requires_identity && capabilities["agentWorkflow"]["selectionIdentityGuard"] != true {
        return Err("Connected service does not support stable-content identity guards; update the service before submitting this plan.".into());
    }
    Ok(())
}

include!(concat!(env!("OUT_DIR"), "/hcd_patch_schemas.rs"));

/// Self-contained (no root-relative references), so it can also be embedded
/// under an MCP tool's plan property. The entire shape participates in the
/// server fingerprint, like the patch schemas.
pub fn agent_workflow_plan_schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        let id=json!({"type":"string","pattern":"^[A-Za-z0-9_-]{1,128}$"});
        let selection=json!({"type":"object","additionalProperties":false,
            "properties":{
                "key":id,"documentId":id,"resource":{"enum":["manifest","editor","sheet","index","chunk","node"]},
                "number":{"type":["integer","null"],"minimum":0},"nodeId":{"type":["string","null"],"pattern":"^n_[0-9a-f]{32}$"},
                "identity":{"type":"object","additionalProperties":false,"properties":{"pointer":{"type":"string","pattern":"^/","maxLength":512},"value":{"type":"string","minLength":1,"maxLength":512}},"required":["pointer","value"],"description":"Optional stable block/cell identity at a second JSON Pointer. Extraction stops if the selected position now refers to another object."},
                "pointer":{"type":"string","pattern":"^/","maxLength":512,"description":"JSON Pointer into the selected real hcd_read response; value must be <=8 KiB. Formula calculation/value requires status=calculated."}},
            "required":["key","documentId","resource","pointer"]});
        json!({"type":"object","additionalProperties":false,"properties":{
            "name":{"type":"string","minLength":1,"maxLength":120},
            "documents":{"type":"array","minItems":2,"maxItems":16,"items":{"type":"object","additionalProperties":false,"properties":{
                "documentId":id,"access":{"enum":["read","write"]},"expectedRevision":{"type":"integer","minimum":0},"collaborationEpoch":{"type":"integer","minimum":0}},"required":["documentId","access","expectedRevision","collaborationEpoch"]}},
            "facts":{"type":"array","maxItems":64,"items":selection},
            "steps":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"object","additionalProperties":false,"properties":{
                "stepId":id,"documentId":id,"task":{"type":"string","minLength":1,"maxLength":4000},
                "dependsOn":{"type":"array","maxItems":32,"uniqueItems":true,"items":id},
                "consumes":{"type":"array","maxItems":64,"uniqueItems":true,"items":id},
                "produces":{"type":"array","maxItems":64,"items":selection},
                "agentCount":{"type":"integer","minimum":1,"maximum":4,"default":1},
                "mode":{"enum":["edit","rebuild"],"default":"edit"},"generateImages":{"type":"boolean","default":false},
                "target":{"type":["object","null"]}},"required":["stepId","documentId","task"]}}
        },"required":["name","documents","steps"],"description":"Immutable dependency plan. Same-document steps must be ordered. Consume initial facts or ancestor outputs only; declare at most 64 total fact keys. Steps plus consumed facts must fit the 8000-character task limit."})
    })
}

fn operations(schema: &Value, item: &Value, found: &mut BTreeSet<String>) {
    if let Some(reference) = item["$ref"].as_str().and_then(|r| r.strip_prefix('#')) {
        if let Some(target) = schema.pointer(reference) {
            operations(schema, target, found);
        }
    }
    if let Some(name) = item.pointer("/properties/op/const").and_then(Value::as_str) {
        found.insert(name.to_string());
    }
    for kind in ["oneOf", "anyOf", "allOf"] {
        if let Some(variants) = item[kind].as_array() {
            for variant in variants {
                operations(schema, variant, found);
            }
        }
    }
}

pub fn runtime() -> &'static Value {
    static CAPABILITIES: OnceLock<Value> = OnceLock::new();
    CAPABILITIES.get_or_init(|| {
        let mut schemas = serde_json::Map::new();
        for text in SCHEMAS {
            let schema: Value = serde_json::from_str(text).expect("embedded patch schema");
            let version = schema["properties"]["schemaVersion"]["const"]
                .as_str()
                .expect("schema version");
            let mut names = BTreeSet::new();
            operations(
                &schema,
                &schema["properties"]["operations"]["items"],
                &mut names,
            );
            schemas.insert(
                version.into(),
                json!({
                    "route": if matches!(version, "hcd-patch/4" | "hcd-patch/67") { "/patch" } else { "/node-patch" },
                    "operations": names,
                }),
            );
        }
        schemas.insert(canvas_core::PROTOCOL.into(),json!({"route":"/canvas/patch","operations":["element.add","element.update","element.remove","file.add","scene.update","spec.update","spec.splice"]}));
        let mut result = json!({
            "protocolVersion": "hcd-api/1",
            "build": {"version":env!("CARGO_PKG_VERSION")},
            "documentFormats": office_engine::registry::capabilities(),
            "patchSchemas": schemas,
            "canvas":{"schema":serde_json::from_str::<Value>(canvas_core::SCHEMA_JSON).expect("canvas schema"),"protocolVersion":canvas_core::PROTOCOL,"nativeFormat":"excalidraw","events":"/canvas/events","fieldCompareAndSet":true,"serverEnforcedSelection":true,"appendOnlyLayouts":{"endpoint":"/canvas/layout","tool":"hcd_canvas_plan","schema":canvas_core::composition_schema(),"vacantRegionGuards":true,"preservesExistingLayout":true,"automaticVisualPlanning":true,"nativeJournal":true,"stickerCatalogVersion":canvas_core::materials::CATALOG_VERSION,"materialLibrary":{"resource":"canvas_materials","disclosure":["overview","candidates","detail"]},"elementReactions":["thumbsUp","plusOne","loveIt","insight","done","favorite","fire","watch","celebrate","smile","launch","action","okay","thumbsDown","question","dot","profile"],"emojiCatalog":"Unicode 16.0","maxStickersPerComposition":4,"maxMotionStickersPerComposition":2,"staticExportFallback":true},"partitionedAgents":{"maxConcurrent":4,"maxSections":8,"stagedDrafts":true,"atomicAppend":true},"maxElements":canvas_core::MAX_ELEMENTS},
            "calculation": xlsx_handler::formula::calculation_capabilities(),
            "targetValidationRequired": true,
            "docxInlineEdits": {"protocolVersion":"hcd-docx-inline/1","marks":["bold","italic"],"stableSourceAnchors":true,"sourceBackedExport":true,"hyperlinkChangesRequireSemanticRebuild":true},
            "xlsxRichText": {"protocolVersion":"hcd-xlsx-rich-text/1","readNodeField":"xlsxRuns","operation":"xlsx.richText.set","schemaVersion":"hcd-patch/49","existingStringCellsOnly":true,"maxRuns":4096,"maxUtf16Units":32767,"sourceBackedExport":true},
            "xlsxContentBatch": {"protocolVersion":"hcd-xlsx-content/1","schemaVersion":"hcd-patch/50","richCreateOperation":"xlsx.richText.create","richSetConvertsWritableCellsToText":true,"mixedCellContent":true,"atomic":true,"maxOperations":10000},
            "xlsxLiteralRestore": {"schemaVersion":"hcd-patch/65","atomic":true,"richText":true,"createdCellClear":true,"numbers":true},
            "nodePatchReview": {"protocolVersion":"hcd-node-patch-review/1","route":"/node-patch-review","formats":["xlsx","csv","tsv"],"exactPayloadAndAuthor":true,"readOnly":true},
            "agentContinuation": {"protocolVersion":AGENT_CONTINUATION_PROTOCOL,"actions":["review","resume"],"explicitAuthorizationRequired":true,"maxAttempts":16,"maxConcurrentAgents":4},
            "agentWorkflow": {"protocolVersion":AGENT_WORKFLOW_PROTOCOL,"planSchema":agent_workflow_plan_schema(),"selectionIdentityGuard":true,"actions":["create","list","read","review","continue","compensate","cancel"],"maxDocuments":16,"maxSteps":32,"maxFacts":64,"maxConcurrentAgents":4,"documentGrantsHeader":"x-hcd-document-grants","explicitAuthorizationRequired":true,"atomicAcrossDocuments":false},
        });
        let mut hash = Sha256::new();
        // Include the complete schema definitions, so an argument/constraint
        // change is detectable even when operation names are unchanged.
        for text in SCHEMAS {
            hash.update(text.as_bytes());
        }
        hash.update(serde_json::to_vec(&result).expect("capabilities JSON"));
        result["protocolFingerprint"] = json!(format!("{:x}", hash.finalize()));
        result
    })
}

pub fn fingerprint() -> &'static str {
    runtime()["protocolFingerprint"]
        .as_str()
        .expect("protocol fingerprint")
}

pub fn validate_patch(capabilities: &Value, route: &str, patch: &Value) -> Result<(), String> {
    let schema = patch["schemaVersion"]
        .as_str()
        .and_then(|version| capabilities["patchSchemas"].get(version))
        .ok_or("service does not support this patch schema; refresh capabilities and replan")?;
    if schema["route"] != route {
        return Err("patch schema uses a different endpoint".into());
    }
    let allowed = schema["operations"]
        .as_array()
        .ok_or("invalid operation capability response")?;
    let operations = patch["operations"]
        .as_array()
        .ok_or("patch operations must be an array")?;
    if operations.is_empty()
        || operations
            .iter()
            .any(|op| !op["op"].is_string() || !allowed.contains(&op["op"]))
    {
        return Err(
            "service does not support a requested operation; refresh capabilities and replan"
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn advertises_table_operations_and_exact_schema_routes() {
        let caps = runtime();
        let tables = caps.pointer("/patchSchemas/hcd-patch~14").unwrap();
        assert_eq!(tables["route"], "/patch");
        for name in [
            "table.edit",
            "table.insert",
            "table.delete",
            "table.restore",
        ] {
            assert!(tables["operations"]
                .as_array()
                .unwrap()
                .contains(&json!(name)));
        }
        assert_eq!(caps["patchSchemas"]["hcd-patch/29"]["route"], "/node-patch");
        assert_eq!(caps["patchSchemas"]["hcd-patch/67"]["route"], "/patch");
        assert_eq!(
            caps["patchSchemas"]["hcd-patch/67"]["operations"],
            json!(["table.cell.split", "table.cells.merge"])
        );
        assert_eq!(caps["patchSchemas"]["hcd-patch/49"]["route"], "/node-patch");
        assert_eq!(
            caps["patchSchemas"]["hcd-patch/49"]["operations"],
            json!(["text.splice", "xlsx.richText.set"])
        );
        assert_eq!(caps["xlsxRichText"]["readNodeField"], "xlsxRuns");
        assert_eq!(caps["xlsxRichText"]["schemaVersion"], "hcd-patch/49");
        assert_eq!(caps["xlsxRichText"]["existingStringCellsOnly"], true);
        assert_eq!(caps["patchSchemas"]["hcd-patch/50"]["route"], "/node-patch");
        assert_eq!(caps["xlsxContentBatch"]["atomic"], true);
        assert_eq!(caps["patchSchemas"]["hcd-patch/65"]["route"], "/node-patch");
        assert_eq!(
            caps["patchSchemas"]["hcd-patch/65"]["operations"],
            json!([
                "text.splice",
                "xlsx.cell.clear",
                "xlsx.number.set",
                "xlsx.richText.set"
            ])
        );
        assert_eq!(
            caps["nodePatchReview"]["protocolVersion"],
            "hcd-node-patch-review/1"
        );
        assert_eq!(caps["nodePatchReview"]["route"], "/node-patch-review");
        assert_eq!(caps["nodePatchReview"]["exactPayloadAndAuthor"], true);
        assert!(caps["patchSchemas"]["hcd-patch/50"]["operations"]
            .as_array()
            .unwrap()
            .contains(&json!("xlsx.richText.create")));
        assert_eq!(fingerprint().len(), 64);
        assert_eq!(
            caps["calculation"],
            xlsx_handler::formula::calculation_capabilities()
        );
    }

    #[test]
    fn workflow_identity_fields_are_negotiated_for_initial_and_produced_facts() {
        let supported = json!({"agentWorkflow":{"protocolVersion":AGENT_WORKFLOW_PROTOCOL,"selectionIdentityGuard":true}});
        let older = json!({"agentWorkflow":{"protocolVersion":AGENT_WORKFLOW_PROTOCOL}});
        assert!(validate_workflow_support(&older, None).is_ok());
        assert!(validate_workflow_support(&older, Some(&json!({"facts":[]}))).is_ok());
        for plan in [
            json!({"facts":[{"identity":{"pointer":"/blocks/0/blockId","value":"original"}}]}),
            json!({"steps":[{"produces":[{"identity":{"pointer":"/cells/0/nodeId","value":"original"}}]}]}),
        ] {
            assert!(validate_workflow_support(&older, Some(&plan)).is_err());
            assert!(validate_workflow_support(&supported, Some(&plan)).is_ok());
        }
        assert!(validate_workflow_support(&json!({}), None).is_err());
    }
}
