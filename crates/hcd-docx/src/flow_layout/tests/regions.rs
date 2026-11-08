use super::*;
use hcd_core::{
    BlockPrecondition, EditorBlockContent, EditorBlockKind, EditorBlockView, EditorInline,
    EditorProjection, FlowRegionEdits, FlowStructurePatchBatch, StructureOperation,
};
fn plain(text: &str) -> EditorBlockContent {
    EditorBlockContent {
        kind: EditorBlockKind::Paragraph,
        inlines: vec![EditorInline {
            text: text.into(),
            ..Default::default()
        }],
        ..Default::default()
    }
}
fn block<'a>(projection: &'a EditorProjection, text: &str) -> &'a EditorBlockView {
    projection
        .blocks
        .iter()
        .find(|b| b.content.inlines.iter().any(|i| i.text == text))
        .unwrap()
}
fn replace(block: &EditorBlockView, text: &str) -> StructureOperation {
    StructureOperation::Replace {
        block_id: block.block_id.clone(),
        block: plain(text),
        precondition: BlockPrecondition {
            block_hash: block.block_hash.clone(),
        },
    }
}
fn batch(
    projection: &EditorProjection,
    id: &str,
    regions: Vec<FlowRegionEdits>,
) -> FlowStructurePatchBatch {
    FlowStructurePatchBatch {
        schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_6.into(),
        document_id: projection.document_id.clone(),
        patch_id: id.into(),
        base_revision: projection.revision,
        layout_hash: projection.flow_layout_hash.clone().unwrap(),
        actor: BTreeMap::new(),
        regions,
    }
}
fn group(block: &EditorBlockView, operations: Vec<StructureOperation>) -> FlowRegionEdits {
    FlowRegionEdits {
        region_id: block.flow_region_id.clone().unwrap(),
        operations,
    }
}
fn setup() -> (tempfile::TempDir, std::path::PathBuf, Bundle) {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("source.docx");
    fixture(&source, &body(), &rels(), "<w:evenAndOddHeaders/>");
    let target = tmp.path().join("layout.hcd");
    imported(&source, &target, true).unwrap();
    let bundle = Bundle::open(&target).unwrap();
    hcd_core::project_flow_regions(&bundle, 0).unwrap();
    (tmp, source, bundle)
}
fn assert_valid(bundle: &Bundle) {
    let report = hcd_core::validate_bundle(bundle).unwrap();
    assert!(report.valid, "{report:?}");
}
fn rewrite_part(source: &std::path::Path, name: &str, xml: &str) {
    let mut original = zip::ZipArchive::new(std::fs::File::open(source).unwrap()).unwrap();
    let mut parts = Vec::new();
    for index in 0..original.len() {
        let mut part = original.by_index(index).unwrap();
        let path = part.name().to_string();
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut part, &mut bytes).unwrap();
        parts.push((path, bytes));
    }
    drop(original);
    let mut writer = zip::ZipWriter::new(std::fs::File::create(source).unwrap());
    for (path, bytes) in parts {
        writer
            .start_file(&path, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(if path == name { xml.as_bytes() } else { &bytes })
            .unwrap();
    }
    writer.finish().unwrap();
}

#[test]
fn regional_batches_reject_foreign_sources_anchors_duplicates_and_late_failures_atomically() {
    let (_tmp, _source, bundle) = setup();
    let projected = hcd_core::editor_projection(&bundle, None).unwrap();
    let body = block(&projected, "Body one");
    let header = block(&projected, "Default header");
    let footer = block(&projected, "Default footer");
    let valid = batch(
        &projected,
        "regional-guards",
        vec![
            group(body, vec![replace(body, "Body changed")]),
            group(header, vec![replace(header, "Header changed")]),
        ],
    );
    let mut cases = Vec::new();
    let mut wrong = valid.clone();
    wrong.layout_hash = "0".repeat(64);
    cases.push(wrong);
    let mut wrong = valid.clone();
    if let StructureOperation::Replace { precondition, .. } = &mut wrong.regions[1].operations[0] {
        precondition.block_hash = "0".repeat(64)
    }
    cases.push(wrong);
    let mut wrong = valid.clone();
    wrong.regions[0].region_id = header.flow_region_id.clone().unwrap();
    cases.push(wrong);
    let mut wrong = valid.clone();
    wrong.regions.push(wrong.regions[0].clone());
    cases.push(wrong);
    let mut wrong = valid.clone();
    wrong.regions[1].region_id = format!("n_{:032x}", 0);
    cases.push(wrong);
    let mut wrong = valid.clone();
    if let StructureOperation::Replace { block, .. } = &mut wrong.regions[0].operations[0] {
        block.inlines[0].node_id = header.content.inlines[0].node_id.clone();
    }
    cases.push(wrong);
    let mut wrong = valid.clone();
    wrong.regions[0].operations = vec![StructureOperation::Move {
        block_id: body.block_id.clone(),
        after_block_id: Some(header.block_id.clone()),
        precondition: BlockPrecondition {
            block_hash: body.block_hash.clone(),
        },
    }];
    cases.push(wrong);
    let mut wrong = valid.clone();
    wrong.regions[1].operations = vec![StructureOperation::Delete {
        block_id: header.block_id.clone(),
        precondition: BlockPrecondition {
            block_hash: header.block_hash.clone(),
        },
    }];
    cases.push(wrong);
    let mut wrong = valid.clone();
    wrong.regions[0].operations = vec![StructureOperation::Insert {
        after_block_id: Some(footer.block_id.clone()),
        block: plain("Foreign insert"),
    }];
    cases.push(wrong);
    let initial = std::fs::read(bundle.root().join("manifest.json")).unwrap();
    let baseline = serde_json::to_value(&projected).unwrap();
    for wrong in cases {
        assert!(
            hcd_core::apply_flow_structure_patch(&bundle, &wrong, 1).is_err(),
            "accepted {wrong:?}"
        );
        assert_eq!(
            std::fs::read(bundle.root().join("manifest.json")).unwrap(),
            initial
        );
        assert_eq!(
            serde_json::to_value(hcd_core::editor_projection(&bundle, None).unwrap()).unwrap(),
            baseline
        );
    }
    assert!(hcd_core::apply_flow_structure_patch(&bundle, &valid, 2).is_err());
    assert_valid(&bundle);
    let mut unknown = serde_json::to_value(&valid).unwrap();
    unknown["regions"][0]["sourcePart"] = "word/footer1.xml".into();
    assert!(serde_json::from_value::<FlowStructurePatchBatch>(unknown).is_err());
    assert_eq!(
        hcd_core::apply_flow_structure_patch(&bundle, &valid, 1)
            .unwrap()
            .revision,
        2
    );
    assert_valid(&bundle);
}

#[test]
fn insert_move_delete_update_section_boundaries_and_allow_story_tail_insertions() {
    let (_tmp, _source, bundle) = setup();
    let p = hcd_core::editor_projection(&bundle, None).unwrap();
    let body = block(&p, "Body one");
    let header = block(&p, "Default header");
    let insert = batch(
        &p,
        "regional-insert",
        vec![
            group(
                body,
                vec![StructureOperation::Insert {
                    after_block_id: Some(body.block_id.clone()),
                    block: plain("Section tail"),
                }],
            ),
            group(
                header,
                vec![StructureOperation::Insert {
                    after_block_id: Some(header.block_id.clone()),
                    block: plain("Header tail"),
                }],
            ),
        ],
    );
    hcd_core::apply_flow_structure_patch(&bundle, &insert, 1).unwrap();
    let p = hcd_core::editor_projection(&bundle, None).unwrap();
    let tail = block(&p, "Section tail");
    assert_eq!(
        p.flow_layout.as_ref().unwrap().sections[0]
            .canonical_end_block_id
            .as_deref(),
        Some(tail.block_id.as_str())
    );
    let body = block(&p, "Body one");
    let movement = batch(
        &p,
        "regional-move",
        vec![group(
            body,
            vec![StructureOperation::Move {
                block_id: body.block_id.clone(),
                after_block_id: Some(tail.block_id.clone()),
                precondition: BlockPrecondition {
                    block_hash: body.block_hash.clone(),
                },
            }],
        )],
    );
    hcd_core::apply_flow_structure_patch(&bundle, &movement, 2).unwrap();
    let p = hcd_core::editor_projection(&bundle, None).unwrap();
    let body = block(&p, "Body one");
    assert_eq!(
        p.flow_layout.as_ref().unwrap().sections[0]
            .canonical_end_block_id
            .as_deref(),
        Some(body.block_id.as_str())
    );
    let deletion = batch(
        &p,
        "regional-delete",
        vec![group(
            body,
            vec![StructureOperation::Delete {
                block_id: body.block_id.clone(),
                precondition: BlockPrecondition {
                    block_hash: body.block_hash.clone(),
                },
            }],
        )],
    );
    hcd_core::apply_flow_structure_patch(&bundle, &deletion, 3).unwrap();
    let p = hcd_core::editor_projection(&bundle, None).unwrap();
    assert_eq!(
        p.flow_layout.as_ref().unwrap().sections[0]
            .canonical_end_block_id
            .as_deref(),
        Some(block(&p, "Section tail").block_id.as_str())
    );
    assert_valid(&bundle);
    assert_eq!(
        hcd_core::apply_flow_structure_patch(&bundle, &insert, 1)
            .unwrap()
            .revision,
        2
    );
    assert_eq!(bundle.manifest().unwrap().revision, 4);
    let current = serde_json::to_value(&p).unwrap();
    let portable = hcd_core::create_portable_snapshot(&bundle, None).unwrap();
    let reopened = Bundle::open(portable.directory.path()).unwrap();
    assert_eq!(
        serde_json::to_value(hcd_core::editor_projection(&reopened, None).unwrap()).unwrap(),
        current
    );
}

#[test]
fn empty_region_blocks_get_real_empty_sources_and_valid_revisions() {
    let (_tmp, _source, bundle) = setup();
    let p = hcd_core::editor_projection(&bundle, None).unwrap();
    let header = block(&p, "Default header");
    let blank = EditorBlockContent {
        kind: EditorBlockKind::Paragraph,
        ..Default::default()
    };
    let patch = batch(
        &p,
        "empty-region-block",
        vec![group(
            header,
            vec![StructureOperation::Insert {
                after_block_id: None,
                block: blank,
            }],
        )],
    );
    let saved = hcd_core::apply_flow_structure_patch(&bundle, &patch, 1).unwrap();
    assert_eq!(saved.dirty_node_ids.len(), 1);
    let nodes = hcd_core::extract_text_page(&bundle, None, 1000).unwrap();
    let empty = nodes
        .entries
        .iter()
        .find(|e| e.node_id == saved.dirty_node_ids[0])
        .unwrap();
    assert!(empty.text.is_empty());
    assert_eq!(empty.node_hash, hcd_core::hash_bytes(b""));
    assert_eq!(empty.source.part, "word/header1.xml");
    assert_eq!(saved.dirty_source_parts, vec!["word/header1.xml"]);
    assert!(!saved.dirty_chunk_ids.is_empty());
    assert_valid(&bundle);
    let after = hcd_core::editor_projection(&bundle, None).unwrap();
    let roots: Vec<_> = after
        .blocks
        .iter()
        .filter(|b| b.flow_region_id == header.flow_region_id)
        .collect();
    assert_eq!(roots.len(), 2);
    assert_eq!(roots[0].content.inlines.len(), 1);
    assert!(roots[0].content.inlines[0].text.is_empty());
}

#[test]
fn truly_empty_stories_and_final_section_get_distinct_editable_sources_and_retry_safely() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("empty.docx");
    fixture(
        &source,
        "<w:p><w:pPr><w:sectPr/></w:pPr></w:p><w:sectPr/>",
        &rels(),
        "",
    );
    for (part, kind) in [
        ("word/header1.xml", "hdr"),
        ("word/header2.xml", "hdr"),
        ("word/header3.xml", "hdr"),
        ("word/parts/custom.xml", "hdr"),
        ("word/footer1.xml", "ftr"),
        ("word/footer2.xml", "ftr"),
    ] {
        rewrite_part(
            &source,
            part,
            &format!("<w:{kind} xmlns:w=\"{WORD_MAIN_NS}\"/>"),
        );
    }
    let target = tmp.path().join("empty.hcd");
    imported(&source, &target, true).unwrap();
    let bundle = Bundle::open(&target).unwrap();
    let r0 = serde_json::to_value(hcd_core::editor_projection(&bundle, None).unwrap()).unwrap();
    let saved = hcd_core::project_flow_regions(&bundle, 0).unwrap();
    assert_eq!(saved.revision, 1);
    assert_valid(&bundle);
    let p = hcd_core::editor_projection(&bundle, None).unwrap();
    assert_eq!(p.blocks.len(), 8);
    assert!(p.blocks.iter().all(|b| !b.read_only));
    let text = hcd_core::extract_text_page(&bundle, None, 1000).unwrap();
    let ids: HashSet<_> = text.entries.iter().map(|e| e.node_id.as_str()).collect();
    assert_eq!(ids.len(), text.entries.len());
    assert!(text
        .entries
        .iter()
        .all(|e| e.text.is_empty() && e.source.editable));
    assert!(
        hcd_core::project_flow_regions(&bundle, 0)
            .unwrap()
            .idempotent_replay
    );
    assert_eq!(bundle.manifest().unwrap().revision, 1);
    hcd_core::restore_revision(&bundle, 0, 1, None, None).unwrap();
    assert_eq!(bundle.manifest().unwrap().capabilities.flow_layout, Some(1));
    assert_eq!(
        hcd_core::project_flow_regions(&bundle, 2).unwrap().revision,
        3
    );
    assert_valid(&bundle);
    assert_eq!(
        serde_json::to_value(hcd_core::editor_projection(&bundle, Some(0)).unwrap()).unwrap(),
        r0
    );
    let portable = hcd_core::create_portable_snapshot(&bundle, None).unwrap();
    let reopened = Bundle::open(portable.directory.path()).unwrap();
    assert_valid(&reopened);
}

#[test]
fn calculated_field_roots_stay_read_only_while_neighboring_regions_remain_editable() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("field.docx");
    fixture(&source, &body(), &rels(), "");
    rewrite_part(
        &source,
        "word/header2.xml",
        &format!(
            r#"<w:hdr xmlns:w="{WORD_MAIN_NS}"><w:p><w:fldSimple w:instr=" PAGE "><w:r><w:t>7</w:t></w:r></w:fldSimple></w:p><w:p><w:r><w:t>Editable neighbor</w:t></w:r></w:p></w:hdr>"#
        ),
    );
    let target = tmp.path().join("field.hcd");
    imported(&source, &target, true).unwrap();
    let bundle = Bundle::open(&target).unwrap();
    hcd_core::project_flow_regions(&bundle, 0).unwrap();
    let p = hcd_core::editor_projection(&bundle, None).unwrap();
    let field = block(&p, "7");
    assert!(field.read_only);
    assert!(!block(&p, "Editable neighbor").read_only);
    let bad = batch(
        &p,
        "bad-field",
        vec![
            group(
                block(&p, "Body one"),
                vec![replace(block(&p, "Body one"), "Should roll back")],
            ),
            group(field, vec![replace(field, "8")]),
        ],
    );
    assert!(hcd_core::apply_flow_structure_patch(&bundle, &bad, 1).is_err());
    assert_eq!(bundle.manifest().unwrap().revision, 1);
    let good = batch(
        &p,
        "field-neighbor",
        vec![group(
            block(&p, "Editable neighbor"),
            vec![replace(block(&p, "Editable neighbor"), "Neighbor saved")],
        )],
    );
    hcd_core::apply_flow_structure_patch(&bundle, &good, 1).unwrap();
    assert_valid(&bundle);
    let text = hcd_core::extract_text_page(&bundle, None, 1000).unwrap();
    assert!(
        !text
            .entries
            .iter()
            .find(|e| e.text == "7")
            .unwrap()
            .source
            .editable
    );
    let portable = hcd_core::create_portable_snapshot(&bundle, None).unwrap();
    let reopened = Bundle::open(portable.directory.path()).unwrap();
    assert!(block(&hcd_core::editor_projection(&reopened, None).unwrap(), "7").read_only);
}

#[test]
fn header_extensions_resources_mentions_and_marks_roundtrip_without_mixing_story_sources() {
    let (_tmp, _source, bundle) = setup();
    let p = hcd_core::editor_projection(&bundle, None).unwrap();
    let header = block(&p, "Default header");
    let footer = block(&p, "Default footer");
    let bytes = b"region-owned offline attachment";
    let asset = bundle
        .stage_asset_from_reader("bin", &mut std::io::Cursor::new(bytes))
        .unwrap();
    let node = hcd_core::ExtensionNode {
        schema_version: "hcd.extension/2".into(),
        instance_id: format!("x_{:032x}", 1),
        node_type: "example.region_card".into(),
        version: 77,
        display: hcd_core::ExtensionDisplay::Block,
        data: serde_json::json!({"future":{"values":[1,true,null,"中文<&😀"]}}),
        fallback: hcd_core::ExtensionFallback {
            text: "Header card".into(),
        },
        resources: vec![hcd_core::NodeResource {
            key: "attachment".into(),
            hash: asset.hash.clone(),
            byte_length: asset.byte_length,
            name: "context.bin".into(),
            media_type: "application/octet-stream".into(),
        }],
        content_model: Some("blocks".into()),
        exports: BTreeMap::new(),
    };
    let mention = hcd_core::InlineReference {
        node_type: "hcd.mention".into(),
        version: 1,
        mention_id: format!("m_{:032x}", 1),
        target: hcd_core::ReferenceTarget {
            kind: "person".into(),
            id: "alice".into(),
        },
        snapshot: hcd_core::ReferenceSnapshot {
            label: "Alice".into(),
        },
    };
    let mark = hcd_core::CustomTextMark {
        schema_version: "hcd.mark/1".into(),
        mark_type: "example.review".into(),
        version: 19,
        data: serde_json::json!({"retain":true}),
        fallback: hcd_core::CustomMarkFallback {
            label: "Review".into(),
            style: hcd_core::CustomMarkStyle {
                bold: Some(true),
                ..Default::default()
            },
        },
    };
    let child = EditorBlockContent {
        kind: EditorBlockKind::Paragraph,
        inlines: vec![
            EditorInline {
                text: "Header detail 中😀".into(),
                custom_marks: vec![mark.clone()],
                ..Default::default()
            },
            EditorInline {
                text: mention.text(),
                reference: Some(mention.clone()),
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    let content = EditorBlockContent {
        kind: EditorBlockKind::Extension,
        extension: Some(node.clone()),
        inlines: Vec::new(),
        children: vec![child],
        ..Default::default()
    };
    let patch = batch(
        &p,
        "regional-extensions",
        vec![
            group(
                header,
                vec![StructureOperation::Replace {
                    block_id: header.block_id.clone(),
                    block: content,
                    precondition: BlockPrecondition {
                        block_hash: header.block_hash.clone(),
                    },
                }],
            ),
            group(footer, vec![replace(footer, "Footer remains separate")]),
        ],
    );
    hcd_core::apply_flow_structure_patch(&bundle, &patch, 1).unwrap();
    assert_valid(&bundle);
    let saved = hcd_core::editor_projection(&bundle, None).unwrap();
    assert_eq!(hcd_core::projection_extensions(&saved).unwrap(), vec![node]);
    let refs = hcd_core::document_references(&bundle, None).unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].reference, mention);
    let card = saved
        .blocks
        .iter()
        .find(|b| b.block_id == header.block_id)
        .unwrap();
    assert_eq!(card.flow_region_id, header.flow_region_id);
    assert_eq!(card.content.children[0].inlines[0].custom_marks, vec![mark]);
    let text = hcd_core::extract_text_page(&bundle, None, 1000).unwrap();
    for entry in text
        .entries
        .iter()
        .filter(|e| ["Header card", "Header detail 中😀", "@Alice"].contains(&e.text.as_str()))
    {
        assert_eq!(entry.source.part, "word/header1.xml");
    }
    let portable = hcd_core::create_portable_snapshot(&bundle, None).unwrap();
    let reopened = Bundle::open(portable.directory.path()).unwrap();
    assert_valid(&reopened);
    assert_eq!(
        serde_json::to_value(hcd_core::editor_projection(&reopened, None).unwrap()).unwrap(),
        serde_json::to_value(&saved).unwrap()
    );
    let indexed = reopened.read_asset_index_for_revision(2).unwrap();
    let archived = indexed.iter().find(|a| a.hash == asset.hash).unwrap();
    assert_eq!(
        std::fs::read(reopened.resolve_href(&archived.href).unwrap()).unwrap(),
        bytes
    );
}

#[test]
fn an_unrelated_patch_cannot_impersonate_a_region_projection_receipt() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("source.docx");
    fixture(&source, &body(), &rels(), "");
    let target = tmp.path().join("layout.hcd");
    imported(&source, &target, true).unwrap();
    let bundle = Bundle::open(&target).unwrap();
    let page = hcd_core::extract_text_page(&bundle, None, 1000).unwrap();
    let entry = page.entries.iter().find(|e| e.text == "Body one").unwrap();
    let patch:hcd_core::PatchBatch=serde_json::from_value(serde_json::json!({"schemaVersion":"hcd-patch/1","documentId":"layout-test","patchId":"flow-region-projection-0","baseRevision":0,"operations":[{"op":"text.splice","nodeId":entry.node_id,"start":0,"deleteCount":0,"insertText":"Changed ","precondition":{"nodeHash":entry.node_hash}}]})).unwrap();
    hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
    assert!(hcd_core::project_flow_regions(&bundle, 0).is_err());
    assert_eq!(bundle.manifest().unwrap().capabilities.flow_layout, Some(1));
    assert_eq!(
        hcd_core::project_flow_regions(&bundle, 1).unwrap().revision,
        2
    );
    assert_valid(&bundle);
}

#[test]
fn mapped_writes_also_reject_missing_or_future_required_region_models() {
    let (_tmp, _source, bundle) = setup();
    let page = hcd_core::extract_text_page(&bundle, None, 1000).unwrap();
    let entry = page
        .entries
        .iter()
        .find(|e| e.text == "Default header")
        .unwrap();
    let patch:hcd_core::PatchBatch=serde_json::from_value(serde_json::json!({"schemaVersion":"hcd-patch/1","documentId":"layout-test","patchId":"known-region-text","baseRevision":1,"operations":[{"op":"text.splice","nodeId":entry.node_id,"start":0,"deleteCount":0,"insertText":"Valid ","precondition":{"nodeHash":entry.node_hash}}]})).unwrap();
    let manifest = bundle.manifest().unwrap();
    for version in [None, Some(99)] {
        let mut invalid = manifest.clone();
        invalid.capabilities.flow_layout = version;
        let bytes = serde_json::to_vec(&invalid).unwrap();
        std::fs::write(bundle.root().join("manifest.json"), &bytes).unwrap();
        assert!(hcd_core::apply_patch(&bundle, &patch, 1).is_err());
        assert_eq!(
            std::fs::read(bundle.root().join("manifest.json")).unwrap(),
            bytes
        );
        assert!(!bundle
            .root()
            .join("revisions/00000000000000000002.json")
            .exists());
    }
    std::fs::write(
        bundle.root().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    assert_eq!(
        hcd_core::apply_patch(&bundle, &patch, 1).unwrap().revision,
        2
    );
    assert_valid(&bundle);
}
