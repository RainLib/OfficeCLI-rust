//! Streaming DOCX adapters for the HTML Canonical Document format.

mod exporter;
mod importer;
mod source_runs;

pub use exporter::{export_docx, requires_semantic_rebuild, ExportOptions};
pub use importer::{
    import_docx, source_typography_styles, ImportOptions, FONT_METADATA_CSS_MARKER,
};

#[cfg(test)]
mod tests {
    use super::*;
    use hcd_core::{
        Annotation, Bundle, NodePrecondition, PatchBatch, PatchOperation, HCD_PATCH_SCHEMA_VERSION,
    };
    use std::collections::BTreeMap;
    use std::io::{Read, Write};
    use zip::write::SimpleFileOptions;

    #[test]
    fn source_size_partitions_survive_text_edits_annotations_history_and_native_export() {
        use hcd_core::{FontSizeRun, TextRunsPrecondition};
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.docx");
        let path = temp.path().join("formatted.hcd");
        create_fixture(&source);
        import_docx(&source, &path, &ImportOptions::new("sizes"), |_| Ok(())).unwrap();
        let bundle = Bundle::open(&path).unwrap();
        let first = hcd_core::extract_text_page(&bundle, None, 100)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.text == "Hello 😀 World")
            .unwrap();
        let original_map = first.source.clone();
        let batch = |id: &str, base, operations| PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_5.into(),
            document_id: "sizes".into(),
            patch_id: id.into(),
            base_revision: base,
            actor: BTreeMap::new(),
            operations,
            metadata: BTreeMap::new(),
        };
        let annotation = |id: &str, start, end| PatchOperation::AnnotationUpsert {
            annotation: Annotation {
                annotation_id: id.into(),
                node_id: first.node_id.clone(),
                start,
                end,
                kind: "recognition".into(),
                rule_id: None,
                confidence: None,
                ignored: false,
            },
        };
        hcd_core::apply_patch(
            &bundle,
            &batch(
                "annotations",
                0,
                vec![annotation("prefix", 0, 5), annotation("glyph", 6, 7)],
            ),
            0,
        )
        .unwrap();
        let annotation_root = bundle.manifest().unwrap().annotation_root_hash;
        let lookup = hcd_core::get_text_node(&bundle, &first.node_id).unwrap();
        let original_format = lookup.format_hash.clone().unwrap();
        let runs = vec![
            FontSizeRun {
                chars: 6,
                size_pt: None,
            },
            FontSizeRun {
                chars: 1,
                size_pt: Some(28.5),
            },
            FontSizeRun {
                chars: 6,
                size_pt: None,
            },
        ];
        let rich = batch(
            "partial-size",
            1,
            vec![PatchOperation::TextRuns {
                node_id: first.node_id.clone(),
                text: first.text.clone(),
                runs: runs.clone(),
                precondition: TextRunsPrecondition {
                    node_hash: first.node_hash.clone(),
                    format_hash: original_format.clone(),
                },
            }],
        );
        let saved = hcd_core::apply_patch(&bundle, &rich, 1).unwrap();
        assert_eq!(saved.revision, 2);
        assert!(
            hcd_core::apply_patch(&bundle, &rich, 1)
                .unwrap()
                .idempotent_replay
        );
        assert_eq!(
            bundle.manifest().unwrap().annotation_root_hash,
            annotation_root
        );
        assert!(!bundle.revision(2).unwrap().structural_change);
        let lookup = hcd_core::get_text_node(&bundle, &first.node_id).unwrap();
        assert_eq!(lookup.node.source, original_map);
        assert_eq!(lookup.node.node_hash, first.node_hash);
        assert_eq!(lookup.font_size_runs, Some(runs.clone()));
        assert_ne!(lookup.format_hash.as_ref().unwrap(), &original_format);
        let mut stale = rich.clone();
        stale.patch_id = "stale-format".into();
        stale.base_revision = 2;
        assert!(matches!(
            hcd_core::apply_patch(&bundle, &stale, 2),
            Err(hcd_core::HcdError::PreconditionFailed(_))
        ));
        assert_eq!(bundle.manifest().unwrap().revision, 2);
        let projection = hcd_core::editor_projection(&bundle, None).unwrap();
        let parts: Vec<_> = projection
            .blocks
            .iter()
            .flat_map(|block| &block.content.inlines)
            .filter(|inline| inline.node_id.as_deref() == Some(&first.node_id))
            .collect();
        assert_eq!(
            parts
                .iter()
                .map(|inline| inline.text.as_str())
                .collect::<Vec<_>>(),
            ["Hello ", "😀", " World"]
        );
        assert_eq!(parts[1].typography.as_ref().unwrap().size_pt, Some(28.5));

        let output = temp.path().join("native.docx");
        let report = export_docx(&path, &source, &output, &ExportOptions::default()).unwrap();
        assert_eq!(report.level, hcd_core::FidelityLevel::High);
        for part in [
            "word/styles.xml",
            "word/_rels/document.xml.rels",
            "word/theme/custom-theme.xml",
            "word/header1.xml",
            "word/comments.xml",
            "word/media/image1.png",
        ] {
            assert_eq!(
                read_zip_bytes(&source, part),
                read_zip_bytes(&output, part),
                "{part}"
            );
        }
        let xml = read_zip_entry(&output, "word/document.xml");
        assert_eq!(xml.matches("asciiTheme=\"minorHAnsi\"").count(), 3);
        assert_eq!(xml.matches("w:themeTint=\"80\"").count(), 3);
        assert_eq!(xml.matches("w14:textId=\"B1\"").count(), 1);
        assert!(xml.contains("<w:pStyle w:val=\"Heading1\"/>"));
        assert!(xml.contains("hcdr:val=\"57\""));
        assert!(xml.contains("Historical deletion"));
        let reimported = temp.path().join("reimported.hcd");
        import_docx(
            &output,
            &reimported,
            &ImportOptions::new("reimported"),
            |_| Ok(()),
        )
        .unwrap();
        let reprojection =
            hcd_core::editor_projection(&Bundle::open(&reimported).unwrap(), None).unwrap();
        assert!(reprojection
            .blocks
            .iter()
            .flat_map(|block| &block.content.inlines)
            .any(|inline| inline.text == "😀"
                && inline.typography.as_ref().and_then(|font| font.size_pt) == Some(28.5)));

        hcd_core::apply_patch(
            &bundle,
            &batch(
                "after-size-text",
                2,
                vec![PatchOperation::TextSplice {
                    node_id: first.node_id.clone(),
                    start: 6,
                    delete_count: 1,
                    insert_text: "中😀".into(),
                    precondition: NodePrecondition {
                        node_hash: first.node_hash.clone(),
                    },
                }],
            ),
            2,
        )
        .unwrap();
        let after = hcd_core::get_text_node(&bundle, &first.node_id).unwrap();
        assert_eq!(after.node.text, "Hello 中😀 World");
        assert_eq!(
            after.font_size_runs.unwrap()[1],
            FontSizeRun {
                chars: 2,
                size_pt: Some(28.5)
            }
        );
        let validation = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
        let old = hcd_core::editor_projection(&bundle, Some(2)).unwrap();
        assert!(old
            .blocks
            .iter()
            .flat_map(|block| &block.content.inlines)
            .any(|inline| inline.text == "😀"));
        let old_manifest =
            hcd_core::manifest_at_revision(&bundle, &bundle.manifest().unwrap(), Some(2))
                .unwrap()
                .0;
        assert_eq!(
            hcd_core::get_text_node_in_manifest(&bundle, &first.node_id, &old_manifest)
                .unwrap()
                .node
                .text,
            first.text
        );
        let PatchOperation::AnnotationUpsert { annotation: prefix } = annotation("prefix", 0, 5)
        else {
            unreachable!()
        };
        let expected = hcd_core::AnnotationSet {
            schema_version: hcd_core::HCD_SCHEMA_VERSION.into(),
            annotations: vec![prefix],
        };
        assert_eq!(
            bundle.manifest().unwrap().annotation_root_hash,
            hcd_core::hash_bytes(&serde_json::to_vec(&expected).unwrap())
        );
    }

    #[test]
    fn docx_hcd_patch_export_roundtrip() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.docx");
        let bundle_path = temp.path().join("document.hcd");
        let repeat_bundle_path = temp.path().join("document-repeat.hcd");
        let failed_bundle_path = temp.path().join("document-failed.hcd");
        let exported = temp.path().join("exported.docx");
        create_fixture(&source);

        let failed = import_docx(
            &source,
            &failed_bundle_path,
            &ImportOptions::new("failed-doc"),
            |event| {
                if matches!(event, hcd_core::ImportEvent::ChunkReady { .. }) {
                    Err(hcd_core::HcdError::InvalidBundle(
                        "simulated event sink failure".to_string(),
                    ))
                } else {
                    Ok(())
                }
            },
        );
        assert!(failed.is_err());
        assert!(!failed_bundle_path.exists());

        let mut events = Vec::new();
        let manifest = import_docx(
            &source,
            &bundle_path,
            &ImportOptions::new("doc-test"),
            |event| {
                events.push(event.clone());
                Ok(())
            },
        )
        .unwrap();
        assert!(manifest.chunk_count >= 3);
        assert_eq!(
            manifest.fidelity.as_ref().map(|report| &report.level),
            Some(&hcd_core::FidelityLevel::High)
        );
        let chunk_event = events
            .iter()
            .position(|event| matches!(event, hcd_core::ImportEvent::ChunkReady { .. }))
            .unwrap();
        let completed_event = events
            .iter()
            .position(|event| matches!(event, hcd_core::ImportEvent::Completed { .. }))
            .unwrap();
        assert!(chunk_event < completed_event);
        let asset_events: Vec<_> = events
            .iter()
            .enumerate()
            .filter(|(_, event)| matches!(event, hcd_core::ImportEvent::AssetReady { .. }))
            .map(|(index, _)| index)
            .collect();
        assert_eq!(asset_events.len(), 2);
        assert!(asset_events[0] < chunk_event);
        assert!(chunk_event < asset_events[1]);

        let bundle = Bundle::open(&bundle_path).unwrap();
        let validation = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
        assert_eq!(
            std::fs::read_dir(bundle_path.join("assets/sha256"))
                .unwrap()
                .count(),
            2
        );
        let first_page = bundle.read_index_page(&manifest, 0).unwrap();
        assert!(first_page
            .chunks
            .iter()
            .map(|descriptor| bundle.read_chunk(descriptor).unwrap())
            .any(|html| html.contains("asset://sha256/")));
        let body_html = first_page
            .chunks
            .iter()
            .map(|descriptor| bundle.read_chunk(descriptor).unwrap())
            .find(|html| html.contains("Hello 😀 World"))
            .unwrap();
        assert!(body_html.contains("data-hcd-word-style=\"Heading1\""));
        assert!(body_html.contains("hcd-ws-"));
        assert!(body_html.contains("data-hcd-font=\"Aptos\""));
        assert!(body_html.contains("color:#F6BE98"));
        assert!(body_html.contains("data-hcd-revision=\"insert\""));
        assert!(body_html.contains("data-hcd-revision=\"delete\""));
        assert!(body_html.contains("rowspan=\"0000000002\""));
        assert!(body_html.contains("data-hcd-font-east-asia=\"等线\""));
        assert!(body_html.contains("data-hcd-drawing-layout=\"anchor\""));
        assert!(body_html.contains("data-hcd-position-h-relative-from=\"margin\""));
        assert!(body_html.contains("data-hcd-wrap=\"square\""));
        assert!(body_html.contains("data-hcd-table-style=\"FancyTable\""));
        assert!(body_html.contains("data-hcd-look-first-row=\"true\""));
        assert!(body_html.contains("data-hcd-look-h-band=\"true\""));
        let styles = std::fs::read_to_string(bundle_path.join("styles.css")).unwrap();
        assert!(styles.contains("font-weight:700"));
        assert!(styles.contains("font-size:18.0pt"));
        assert!(styles.contains("font-family:'Aptos Display'"));
        assert!(styles.contains("color:#335593"));
        assert!(styles.contains("data-hcd-look-first-row=\"true\""));
        assert!(styles.contains("background-color:#4472C4"));
        assert!(styles.contains("data-hcd-look-h-band=\"true\""));
        assert!(styles.contains("background-color:#DDEBF7"));
        let text = hcd_core::extract_text_page(&bundle, None, 100).unwrap();
        assert!(text.entries.iter().any(|entry| entry.text == "页眉敏感"));
        assert!(text.entries.iter().any(|entry| entry.text == "批注敏感"));
        let secret = text
            .entries
            .iter()
            .find(|entry| entry.text == "Secret 123")
            .unwrap();
        let hello = text
            .entries
            .iter()
            .find(|entry| entry.text == "Hello 😀 World")
            .unwrap();
        let hidden_merge = text
            .entries
            .iter()
            .find(|entry| entry.text == "Hidden merge")
            .unwrap();
        assert!(!hidden_merge.source.editable);
        assert!(!text
            .entries
            .iter()
            .any(|entry| entry.text == "Historical deletion"));

        import_docx(
            &source,
            &repeat_bundle_path,
            &ImportOptions::new("doc-test"),
            |_| Ok(()),
        )
        .unwrap();
        let repeated =
            hcd_core::extract_text_page(&Bundle::open(&repeat_bundle_path).unwrap(), None, 100)
                .unwrap();
        let original_ids: Vec<_> = text
            .entries
            .iter()
            .map(|entry| (&entry.text, &entry.node_id))
            .collect();
        let repeated_ids: Vec<_> = repeated
            .entries
            .iter()
            .map(|entry| (&entry.text, &entry.node_id))
            .collect();
        assert_eq!(original_ids, repeated_ids);

        let read_only_patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION.to_string(),
            document_id: "doc-test".to_string(),
            patch_id: "patch-read-only-merge".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: hidden_merge.node_id.clone(),
                start: 0,
                delete_count: 1,
                insert_text: "X".to_string(),
                precondition: NodePrecondition {
                    node_hash: hidden_merge.node_hash.clone(),
                },
            }],
            metadata: BTreeMap::new(),
        };
        assert!(matches!(
            hcd_core::apply_patch(&bundle, &read_only_patch, 0),
            Err(hcd_core::HcdError::Unsupported(_))
        ));

        let patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION.to_string(),
            document_id: "doc-test".to_string(),
            patch_id: "patch-mask".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: secret.node_id.clone(),
                start: 7,
                delete_count: 3,
                insert_text: "***".to_string(),
                precondition: NodePrecondition {
                    node_hash: secret.node_hash.clone(),
                },
            }],
            metadata: BTreeMap::new(),
        };
        let first = hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
        assert_eq!(first.revision, 1);
        let replay = hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
        assert!(replay.idempotent_replay);
        assert_eq!(replay.revision, 1);

        let stale_non_overlapping = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION.to_string(),
            document_id: "doc-test".to_string(),
            patch_id: "patch-hello".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: hello.node_id.clone(),
                start: 6,
                delete_count: 1,
                insert_text: "🌍".to_string(),
                precondition: NodePrecondition {
                    node_hash: hello.node_hash.clone(),
                },
            }],
            metadata: BTreeMap::new(),
        };
        let second = hcd_core::apply_patch(&bundle, &stale_non_overlapping, 1).unwrap();
        assert_eq!(second.revision, 2);

        let stale_same_node = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION.to_string(),
            document_id: "doc-test".to_string(),
            patch_id: "patch-stale-secret".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: secret.node_id.clone(),
                start: 0,
                delete_count: 1,
                insert_text: "X".to_string(),
                precondition: NodePrecondition {
                    node_hash: secret.node_hash.clone(),
                },
            }],
            metadata: BTreeMap::new(),
        };
        assert!(matches!(
            hcd_core::apply_patch(&bundle, &stale_same_node, 2),
            Err(hcd_core::HcdError::RevisionConflict(_))
        ));

        let mut reused_id = patch.clone();
        if let PatchOperation::TextSplice { insert_text, .. } = &mut reused_id.operations[0] {
            *insert_text = "XXX".to_string();
        }
        assert!(matches!(
            hcd_core::apply_patch(&bundle, &reused_id, 2),
            Err(hcd_core::HcdError::InvalidPatch(_))
        ));

        let annotation_patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION.to_string(),
            document_id: "doc-test".to_string(),
            patch_id: "patch-annotation".to_string(),
            base_revision: 2,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::AnnotationUpsert {
                annotation: Annotation {
                    annotation_id: "hit-1".to_string(),
                    node_id: secret.node_id.clone(),
                    start: 0,
                    end: 6,
                    kind: "sensitive".to_string(),
                    rule_id: Some("rule-1".to_string()),
                    confidence: Some(0.99),
                    ignored: false,
                },
            }],
            metadata: BTreeMap::new(),
        };
        let third = hcd_core::apply_patch(&bundle, &annotation_patch, 2).unwrap();
        assert_eq!(third.root_hash, second.root_hash);

        let validation = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
        export_docx(&bundle_path, &source, &exported, &ExportOptions::default()).unwrap();
        let document_xml = read_zip_entry(&exported, "word/document.xml");
        assert!(document_xml.contains("Secret ***"));
        assert!(document_xml.contains("Hello 🌍 World"));
        assert!(document_xml.contains("<w:ins"));
        assert!(document_xml.contains("<w:delText>Historical deletion</w:delText>"));
        assert!(document_xml.contains("<w:vMerge"));
        assert!(document_xml.contains("<wp:anchor"));
        assert!(document_xml.contains("<wp:posOffset>914400</wp:posOffset>"));
        assert!(document_xml.contains("<w:tblStyle w:val=\"FancyTable\""));
        assert_eq!(
            read_zip_entry(&source, "word/header1.xml"),
            read_zip_entry(&exported, "word/header1.xml")
        );
        assert_eq!(
            read_zip_bytes(&source, "word/media/image1.png"),
            read_zip_bytes(&exported, "word/media/image1.png")
        );
        assert_eq!(
            read_zip_raw(&source, "word/header1.xml"),
            read_zip_raw(&exported, "word/header1.xml")
        );
        assert_eq!(
            read_zip_raw(&source, "word/media/image1.png"),
            read_zip_raw(&exported, "word/media/image1.png")
        );
        assert_eq!(
            read_zip_raw(&source, "word/theme/custom-theme.xml"),
            read_zip_raw(&exported, "word/theme/custom-theme.xml")
        );
    }

    #[test]
    fn validator_rejects_a_corrupted_revision_chain() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.docx");
        let bundle_path = temp.path().join("document.hcd");
        create_fixture(&source);
        import_docx(
            &source,
            &bundle_path,
            &ImportOptions::new("revision-test"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let entry = hcd_core::extract_text_page(&bundle, None, 1)
            .unwrap()
            .entries
            .remove(0);
        let patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION.to_string(),
            document_id: "revision-test".to_string(),
            patch_id: "revision-test-patch".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: entry.node_id,
                start: 0,
                delete_count: 0,
                insert_text: "*".to_string(),
                precondition: NodePrecondition {
                    node_hash: entry.node_hash,
                },
            }],
            metadata: BTreeMap::new(),
        };
        hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
        let revision_path = bundle_path.join("revisions/00000000000000000001.json");
        let mut record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&revision_path).unwrap()).unwrap();
        record["parentRevision"] = serde_json::json!(99);
        std::fs::write(&revision_path, serde_json::to_vec(&record).unwrap()).unwrap();

        let report = hcd_core::validate_bundle(&bundle).unwrap();

        assert!(!report.valid);
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.code == "REVISION_PARENT_MISMATCH"));
    }

    fn create_fixture(path: &std::path::Path) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let parts = [
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
            ),
            (
                "word/document.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p w14:paraId="A1"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:ins w:id="1" w:author="Alice"><w:r w14:textId="B1"><w:rPr><w:rFonts w:asciiTheme="minorHAnsi"/><w:color w:themeColor="accent2" w:themeTint="80" w:val="F6BE98"/></w:rPr><w:t>Hello 😀 World</w:t></w:r></w:ins><w:del w:id="2" w:author="Bob"><w:r><w:delText>Historical deletion</w:delText></w:r></w:del><w:r><w:drawing><wp:anchor distT="91440" distB="91440" distL="182880" distR="182880" relativeHeight="5" behindDoc="0" layoutInCell="1" allowOverlap="1"><wp:positionH relativeFrom="margin"><wp:posOffset>914400</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>457200</wp:posOffset></wp:positionV><wp:extent cx="914400" cy="457200"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="9" descr="Anchored preview"/><a:graphic><a:blip r:embed="rIdImage1"/></a:graphic></wp:anchor></w:drawing></w:r></w:p><w:tbl><w:tblPr><w:tblStyle w:val="FancyTable"/><w:tblLook w:val="04A0"/></w:tblPr><w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p w14:paraId="A2"><w:r w14:textId="B2"><w:t>Secret 123</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p w14:paraId="A4"><w:r w14:textId="B4"><w:t>Hidden merge</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p w14:paraId="A5"><w:r w14:textId="B5"><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr><w:t>主题中文</w:t></w:r></w:p><w:p w14:paraId="A3"><w:r w14:textId="B3"><w:t/></w:r></w:p><w:sectPr/></w:body></w:document>"#,
            ),
            (
                "word/_rels/document.xml.rels",
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/custom-theme.xml"/><Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>"#,
            ),
            (
                "word/styles.xml",
                r#"<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Normal"/><w:style w:type="paragraph" w:styleId="Heading1"><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:b/><w:rFonts w:asciiTheme="majorHAnsi"/><w:color w:themeColor="accent1" w:themeShade="BF" w:val="335593"/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="table" w:styleId="BaseTable"><w:tblPr><w:tblW w:type="pct" w:w="5000"/><w:tblBorders><w:top w:val="single" w:sz="8" w:color="4472C4"/><w:insideH w:val="single" w:sz="4" w:color="D9E2F3"/></w:tblBorders></w:tblPr><w:tcPr><w:vAlign w:val="center"/></w:tcPr></w:style><w:style w:type="table" w:styleId="FancyTable"><w:basedOn w:val="BaseTable"/><w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr><w:tcPr><w:shd w:fill="4472C4"/></w:tcPr></w:tblStylePr><w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:fill="DDEBF7"/></w:tcPr></w:tblStylePr></w:style></w:styles>"#,
            ),
            (
                "word/theme/custom-theme.xml",
                r#"<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="HCD Test Theme"><a:themeElements><a:clrScheme name="HCD"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2></a:clrScheme><a:fontScheme name="HCD"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="等线"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme></a:themeElements></a:theme>"#,
            ),
            (
                "word/header1.xml",
                r#"<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:p w14:paraId="H1"><w:r w14:textId="H2"><w:t>页眉敏感</w:t></w:r></w:p></w:hdr>"#,
            ),
            (
                "word/comments.xml",
                r#"<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:comment w:id="0"><w:p w14:paraId="C1"><w:r w14:textId="C2"><w:t>批注敏感</w:t></w:r></w:p></w:comment></w:comments>"#,
            ),
        ];
        for (name, content) in parts {
            zip.start_file(name, options).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.start_file("word/media/image1.png", options).unwrap();
        zip.write_all(b"not-a-real-png-but-an-opaque-test-asset")
            .unwrap();
        zip.start_file("word/media/unreferenced.bin", options)
            .unwrap();
        zip.write_all(b"deferred-unreferenced-media").unwrap();
        zip.finish().unwrap();
    }

    fn read_zip_entry(path: &std::path::Path, name: &str) -> String {
        String::from_utf8(read_zip_bytes(path, name)).unwrap()
    }

    fn read_zip_bytes(path: &std::path::Path, name: &str) -> Vec<u8> {
        let file = std::fs::File::open(path).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut entry = zip.by_name(name).unwrap();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        bytes
    }

    fn read_zip_raw(path: &std::path::Path, name: &str) -> Vec<u8> {
        let file = std::fs::File::open(path).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        for index in 0..zip.len() {
            let mut entry = zip.by_index_raw(index).unwrap();
            if entry.name() == name {
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                return bytes;
            }
        }
        panic!("missing ZIP entry {name}");
    }
}
