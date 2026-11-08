use super::*;
use hcd_core::{EditorBlockContent, EditorBlockKind as Kind, EditorInline};
use std::collections::{BTreeMap, HashSet};

fn inlines(content: &EditorBlockContent) -> Vec<&EditorInline> {
    content
        .inlines
        .iter()
        .chain(content.children.iter().flat_map(inlines))
        .collect()
}
fn text(content: &EditorBlockContent) -> String {
    inlines(content)
        .into_iter()
        .map(|inline| inline.text.as_str())
        .collect()
}
fn fixture(source: &str, id: &str) -> (tempfile::TempDir, Bundle) {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("source.html");
    std::fs::write(&path, source).unwrap();
    let mut options = ImportOptions::new(id);
    options.chunk_blocks = 2;
    options.chunk_soft_bytes = 1024;
    let bundle_path = temp.path().join("document.hcd");
    import_html(&path, &bundle_path, &options, |_| Ok(())).unwrap();
    let bundle = Bundle::open(bundle_path).unwrap();
    let validation = hcd_core::validate_bundle(&bundle).unwrap();
    assert!(validation.valid, "{:?}", validation.issues);
    (temp, bundle)
}
fn replace(bundle: &Bundle, entry: &hcd_core::TextExtractEntry, value: &str) {
    let head = bundle.manifest().unwrap();
    hcd_core::apply_patch(
        bundle,
        &hcd_core::PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.into(),
            document_id: head.document_id,
            patch_id: "html-text-edit".into(),
            base_revision: head.revision,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![hcd_core::PatchOperation::TextSplice {
                node_id: entry.node_id.clone(),
                start: 0,
                delete_count: entry.text.chars().count(),
                insert_text: value.into(),
                precondition: hcd_core::NodePrecondition {
                    node_hash: entry.node_hash.clone(),
                },
            }],
        },
        head.revision,
    )
    .unwrap();
}

#[test]
fn nested_html_keeps_parent_paragraphs_containers_marks_and_original_byte_ranges() {
    let source = concat!(
        "<!doctype html><head><title>Hidden title</title><style>ignored</style></head><body><h1>HTML 列表验收</h1>",
        "<ol start=4><li><p>父项 <strong>甲 Parent A</strong></p><p>续段 Continuation<br>第二行 Line two</p>",
        "<ol start=7><li><p><em>子项七 Child seven</em></p><ul><li>叶项 Leaf</li></ul></li><li>子项八 Child eight</li>",
        "<li value=10><a href=https://example.test/path?a=1&amp;b=2>跳号 Jump</a></li></ol><p>收尾 Tail</p></li><li><p>父项乙 Parent B</p></li></ol>",
        "<blockquote><p>Quote one</p><p>Quote two</p><blockquote><p>Nested quote</p></blockquote></blockquote>",
        "<pre><code>const x = 1;\n  console.log(x)</code></pre><p><s>strike</s> <u>underline</u> <a href='javascript:alert(1)'>unsafe</a></p>",
        "<p>Before<br>After</p><script>not-visible</script></body>",
    );
    let (temp, bundle) = fixture(source, "nested-html");
    let original = hcd_core::editor_projection(&bundle, None).unwrap();
    assert_eq!(original.blocks.len(), 7);
    assert!(original.blocks.iter().all(|block| !block.read_only));
    let root = &original.blocks[1].content;
    assert_eq!(root.kind, Kind::ListItem);
    assert_eq!(root.list_start, Some(4));
    assert_eq!(root.children.len(), 5);
    assert_eq!(text(&root.children[0]), "父项 甲 Parent A");
    assert!(root.children[0].inlines[1].bold);
    assert_eq!(
        text(&root.children[1]),
        "续段 Continuation\n第二行 Line two"
    );
    assert!(root.children[1].inlines[1].hard_break);
    let children = &root.children[2];
    assert_eq!(children.kind, Kind::OrderedList);
    assert_eq!(children.list_start, Some(7));
    assert_eq!(children.children.len(), 2);
    assert!(children.children[0].children[0].inlines[0].italic);
    assert_eq!(children.children[0].children[1].kind, Kind::BulletList);
    assert_eq!(root.children[3].list_start, Some(10));
    assert_eq!(
        root.children[3].children[0].inlines[0].link.as_deref(),
        Some("https://example.test/path?a=1&b=2")
    );
    assert_eq!(text(&root.children[4]), "收尾 Tail");
    assert_eq!(original.blocks[2].content.list_start, Some(5));
    assert_eq!(original.blocks[3].content.kind, Kind::Blockquote);
    assert_eq!(
        original.blocks[3].content.children[2].kind,
        Kind::Blockquote
    );
    assert_eq!(original.blocks[4].content.kind, Kind::CodeBlock);
    assert_eq!(
        text(&original.blocks[4].content),
        "const x = 1;\n  console.log(x)"
    );
    assert!(original.blocks[5]
        .content
        .inlines
        .iter()
        .any(|inline| inline.strike));
    assert!(original.blocks[5]
        .content
        .inlines
        .iter()
        .any(|inline| inline.underline));
    assert!(original.blocks[5]
        .content
        .inlines
        .iter()
        .all(|inline| inline.link.is_none()));
    assert_eq!(text(&original.blocks[6].content), "Before\nAfter");
    let entries = hcd_core::extract_text_page(&bundle, None, 1000)
        .unwrap()
        .entries;
    let mut ids = HashSet::new();
    for block in &original.blocks {
        for inline in inlines(&block.content) {
            if let Some(id) = &inline.node_id {
                assert!(ids.insert(id.clone()));
            }
        }
    }
    assert_eq!(
        ids,
        entries.iter().map(|entry| entry.node_id.clone()).collect()
    );
    for entry in &entries {
        let range = entry
            .source
            .text_id
            .as_ref()
            .unwrap()
            .strip_prefix("bytes:")
            .unwrap();
        let (start, end) = range.split_once(':').unwrap();
        assert_eq!(
            decode_entities(
                &source[start.parse::<usize>().unwrap()..end.parse::<usize>().unwrap()]
            ),
            entry.text
        );
    }
    let entry = entries
        .iter()
        .find(|entry| entry.text == "子项七 Child seven")
        .unwrap();
    replace(&bundle, entry, "子项七 已修改");
    let target = temp.path().join("updated.html");
    let report = export_html(
        &bundle,
        &temp.path().join("source.html"),
        &target,
        &ExportOptions::default(),
    )
    .unwrap();
    assert_eq!(report.level, FidelityLevel::High);
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        source.replace("子项七 Child seven", "子项七 已修改")
    );
    let historical = hcd_core::editor_projection(&bundle, Some(0)).unwrap();
    assert_eq!(
        serde_json::to_value(historical).unwrap(),
        serde_json::to_value(original).unwrap()
    );
    let reopened = temp.path().join("reopened.hcd");
    import_html(&target, &reopened, &ImportOptions::new("reopened"), |_| {
        Ok(())
    })
    .unwrap();
    let after = hcd_core::editor_projection(&Bundle::open(reopened).unwrap(), None).unwrap();
    assert_eq!(after.blocks[1].content.children.len(), 5);
    assert!(text(&after.blocks[1].content).contains("子项七 已修改"));
}

#[test]
fn empty_html_items_keep_real_insertion_anchors_before_their_child_lists() {
    let source = "<ol start=3><li><ol start=7><li>Child</li></ol></li><li></li></ol><p></p>";
    let (temp, bundle) = fixture(source, "empty-html");
    let state = hcd_core::editor_projection(&bundle, None).unwrap();
    assert_eq!(state.blocks.len(), 3);
    let root = &state.blocks[0].content;
    assert_eq!(root.children[0].kind, Kind::Paragraph);
    assert_eq!(root.children[0].inlines[0].text, "");
    assert_eq!(root.children[1].list_start, Some(7));
    assert_eq!(state.blocks[1].content.list_start, Some(4));
    let id = root.children[0].inlines[0].node_id.as_ref().unwrap();
    let entries = hcd_core::extract_text_page(&bundle, None, 100)
        .unwrap()
        .entries;
    let entry = entries.iter().find(|entry| &entry.node_id == id).unwrap();
    let point = source.find("<li>").unwrap() + 4;
    assert_eq!(
        entry.source.text_id.as_deref(),
        Some(format!("bytes:{point}:{point}").as_str())
    );
    replace(&bundle, entry, "Empty parent text");
    let target = temp.path().join("updated.html");
    export_html(
        &bundle,
        &temp.path().join("source.html"),
        &target,
        &ExportOptions::default(),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(target).unwrap(),
        source.replacen("<li>", "<li>Empty parent text", 1)
    );
}

#[test]
fn html_list_tables_stay_in_their_parent_and_top_level_lists_stream_by_item() {
    let source = "<ul><li><p>Before table</p><table><tr><td>Cell one</td><td>Cell two</td></tr></table><p>After table</p></li></ul><p>Outside</p>";
    let (_temp, bundle) = fixture(source, "table-html");
    let state = hcd_core::editor_projection(&bundle, None).unwrap();
    assert_eq!(state.blocks.len(), 2);
    assert!(state.blocks[0].read_only);
    assert!(!state.blocks[1].read_only);
    let html = state.blocks[0].read_only_html.as_ref().unwrap();
    assert!(html.find("Before table").unwrap() < html.find("<table").unwrap());
    assert!(html.find("Cell two").unwrap() < html.find("After table").unwrap());
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("long.html");
    std::fs::write(
        &source,
        format!(
            "<ol start=4>{}",
            (0..300)
                .map(|n| format!("<li>Entry {n}"))
                .collect::<String>()
        ),
    )
    .unwrap();
    let mut options = ImportOptions::new("long-html");
    options.chunk_blocks = 2;
    options.chunk_soft_bytes = 1024;
    let mut chunks = Vec::new();
    let path = temp.path().join("long.hcd");
    import_html(&source, &path, &options, |event| {
        if let ImportEvent::ChunkReady { descriptor } = event {
            chunks.push(descriptor.clone());
        }
        Ok(())
    })
    .unwrap();
    assert!(chunks.len() >= 150);
    assert!(chunks.iter().all(|chunk| chunk.block_count <= 2));
    let state = hcd_core::editor_projection(&Bundle::open(path).unwrap(), None).unwrap();
    assert_eq!(state.blocks.len(), 300);
    assert_eq!(state.blocks[299].content.list_start, Some(303));
}

#[test]
fn inline_scopes_cross_blocks_safely_and_canonical_orphan_items_keep_declared_order() {
    let (_temp, bundle) = fixture("<strong><p>One</p><p>Two</p></strong><li data-hcd-editor-kind='list_item' data-hcd-editor-level='1' data-hcd-list-start='10'>Ten</li><p>&nbsp;</p>", "scoped-html");
    let state = hcd_core::editor_projection(&bundle, None).unwrap();
    assert_eq!(state.blocks.len(), 4);
    assert!(state.blocks[..2]
        .iter()
        .all(|block| block.content.inlines[0].bold));
    assert_eq!(state.blocks[2].content.level, Some(1));
    assert_eq!(state.blocks[2].content.list_start, Some(10));
    assert_eq!(text(&state.blocks[3].content), "\u{a0}");
}

#[test]
fn oversized_or_overdeep_html_subtrees_fail_without_publishing_a_manifest() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("large.html");
    std::fs::write(
        &source,
        format!("<ul><li>{}</li></ul>", "<p>small text</p>".repeat(12000)),
    )
    .unwrap();
    let path = temp.path().join("large.hcd");
    let error = import_html(
        &source,
        &path,
        &ImportOptions::new("large-html"),
        |_| Ok(()),
    )
    .unwrap_err();
    assert!(error.to_string().contains("NODE_TOO_LARGE"), "{error}");
    assert!(!path.join("manifest.json").exists());
    std::fs::write(
        &source,
        format!("{}text{}", "<ul><li>".repeat(20), "</li></ul>".repeat(20)),
    )
    .unwrap();
    let path = temp.path().join("deep.hcd");
    let error =
        import_html(&source, &path, &ImportOptions::new("deep-html"), |_| Ok(())).unwrap_err();
    assert!(error.to_string().contains("depth limit"), "{error}");
    assert!(!path.join("manifest.json").exists());
}
