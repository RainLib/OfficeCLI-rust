use super::*;
use hcd_core::{Bundle, EditorBlockContent, EditorBlockKind as Kind};
use std::collections::{BTreeMap, HashSet};
use std::io::{Read, Write};
use std::path::Path;

fn fixture(path: &Path, body: &str, styles: &str) {
    let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    let document = format!(
        r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body>{body}</w:body></w:document>"#
    );
    let numbering = r#"<w:numbering xmlns:w="w">
      <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="4"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="7"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%2."/></w:lvl><w:lvl w:ilvl="2"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>
      <w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num>
      <w:num w:numId="4"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="10"/></w:lvlOverride></w:num>
      <w:num w:numId="5"><w:abstractNumId w:val="2"/></w:num>
      <w:num w:numId="6"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="0"/></w:lvlOverride></w:num>
      <w:num w:numId="7"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1000001"/></w:lvlOverride></w:num>
    </w:numbering>"#;
    for (name, content) in [
        (
            "[Content_Types].xml",
            r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
        ),
        (
            "_rels/.rels",
            r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
        ),
        ("word/document.xml", &document),
        ("word/styles.xml", styles),
        ("word/numbering.xml", numbering),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(content.as_bytes()).unwrap();
    }
    zip.finish().unwrap();
}

fn paragraph(id: &str, properties: &str, text: &str) -> String {
    format!(
        r#"<w:p w14:paraId="{id}"><w:pPr>{properties}</w:pPr><w:r><w:t>{text}</w:t></w:r></w:p>"#
    )
}

fn item(id: &str, number: u32, level: u8, text: &str) -> String {
    paragraph(
        id,
        &format!(r#"<w:numPr><w:ilvl w:val="{level}"/><w:numId w:val="{number}"/></w:numPr>"#),
        text,
    )
}

fn all_text(content: &EditorBlockContent) -> String {
    content
        .inlines
        .iter()
        .map(|inline| inline.text.as_str())
        .collect::<String>()
        + &content.children.iter().map(all_text).collect::<String>()
}

fn ownership(paragraph: String, item: u32, depth: u8, role: &str) -> String {
    paragraph.replacen(
        "<w:p ",
        &format!(
            "<w:p xmlns:owner=\"{}\" owner:list=\"1:{item}:{depth}:{role}\" ",
            oxml::semantic_lists::NAMESPACE
        ),
        1,
    )
}

#[test]
fn explicit_list_ownership_keeps_continuations_before_and_after_nested_items() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("owned.docx");
    let body = [
        ownership(item("a", 1, 0, "Parent"), 1, 0, "start"),
        ownership(paragraph("b", "", "Root continued"), 1, 0, "continue"),
        ownership(item("c", 2, 1, "Child seven"), 2, 1, "start"),
        ownership(item("d", 3, 2, "Leaf"), 3, 2, "start"),
        ownership(paragraph("e", "", "Child tail"), 2, 1, "continue"),
        ownership(item("f", 2, 1, "Child eight"), 4, 1, "start"),
        ownership(
            paragraph("g", "", "Root tail</w:t><w:br/><w:t>Next line"),
            1,
            0,
            "continue",
        ),
        ownership(item("h", 1, 0, "Next parent"), 5, 0, "start"),
        paragraph("i", "<w:ind w:left=\"720\"/>", "Plain indented body"),
    ]
    .join("");
    fixture(&source, &body, "<w:styles xmlns:w=\"w\"/>");
    let mut options = ImportOptions::new("owned");
    options.chunk_blocks = 1;
    let path = temp.path().join("owned.hcd");
    let manifest = import_docx(&source, &path, &options, |_| Ok(())).unwrap();
    assert!(!manifest
        .warnings
        .iter()
        .any(|warning| warning.code == "WORD_LIST_OWNERSHIP_IGNORED"));
    let bundle = Bundle::open(&path).unwrap();
    let state = hcd_core::editor_projection(&bundle, None).unwrap();
    assert_eq!(state.blocks.len(), 3);
    let root = &state.blocks[0].content;
    assert_eq!(root.list_start, Some(4));
    assert_eq!(root.children.len(), 4);
    assert_eq!(all_text(&root.children[1]), "Root continued");
    let children = &root.children[2];
    assert_eq!(children.kind, Kind::OrderedList);
    assert_eq!(children.list_start, Some(7));
    assert_eq!(children.children.len(), 2);
    let first = &children.children[0];
    assert_eq!(first.children[1].kind, Kind::BulletList);
    assert_eq!(all_text(&first.children[2]), "Child tail");
    assert_eq!(all_text(&root.children[3]), "Root tail\nNext line");
    assert_eq!(state.blocks[1].content.list_start, Some(5));
    assert_eq!(all_text(&state.blocks[2].content), "Plain indented body");
    assert_eq!(
        hcd_core::extract_text_page(&bundle, None, 100)
            .unwrap()
            .entries
            .len(),
        10
    );
    assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
}

#[test]
fn stale_duplicate_invalid_or_wrong_namespace_ownership_never_absorbs_body_text() {
    let temp = tempfile::tempdir().unwrap();
    for (name, continuation, repeat) in [
        (
            "stale",
            ownership(paragraph("b", "", "Body"), 2, 0, "continue"),
            false,
        ),
        (
            "depth",
            ownership(paragraph("b", "", "Body"), 1, 1, "continue"),
            false,
        ),
        (
            "future",
            ownership(paragraph("b", "", "Body"), 1, 0, "continue")
                .replace("1:1:0:continue", "2:1:0:continue"),
            false,
        ),
        (
            "namespace",
            ownership(paragraph("b", "", "Body"), 1, 0, "continue")
                .replace(oxml::semantic_lists::NAMESPACE, "urn:unrelated"),
            false,
        ),
        (
            "duplicate",
            ownership(paragraph("b", "", "Body"), 1, 0, "continue"),
            true,
        ),
    ] {
        let source = temp.path().join(format!("{name}.docx"));
        let root = ownership(item("a", 1, 0, "Parent"), 1, 0, "start");
        let duplicate = if repeat {
            ownership(item("d", 1, 0, "Duplicate"), 1, 0, "start")
        } else {
            String::new()
        };
        fixture(
            &source,
            &(root + &duplicate + &continuation),
            "<w:styles xmlns:w=\"w\"/>",
        );
        let path = temp.path().join(format!("{name}.hcd"));
        let manifest = import_docx(&source, &path, &ImportOptions::new(name), |_| Ok(())).unwrap();
        let state = hcd_core::editor_projection(&Bundle::open(path).unwrap(), None).unwrap();
        assert_eq!(
            all_text(&state.blocks.last().unwrap().content),
            "Body",
            "{name}"
        );
        assert_eq!(
            state.blocks.last().unwrap().content.kind,
            Kind::Paragraph,
            "{name}"
        );
        if name != "namespace" {
            assert_eq!(
                manifest
                    .warnings
                    .iter()
                    .filter(|warning| warning.code == "WORD_LIST_OWNERSHIP_IGNORED")
                    .count(),
                1,
                "{name}"
            );
        }
    }
}

#[test]
fn native_lists_keep_hierarchy_numbers_source_anchors_and_source_backed_edits() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source.docx");
    let path = temp.path().join("lists.hcd");
    let body = [
        paragraph("h", r#"<w:pStyle w:val="Heading1"/>"#, "标题"),
        item("a", 1, 0, "Parent A"),
        item("b", 2, 1, "Child seven"),
        item("c", 3, 2, "Leaf"),
        item("d", 2, 1, "Child eight"),
        item("e", 1, 0, "Parent B"),
        paragraph("f", "", "After"),
        item("g", 4, 0, "Restart"),
    ]
    .join("");
    fixture(
        &source,
        &body,
        r#"<w:styles xmlns:w="w"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>"#,
    );
    let mut options = ImportOptions::new("lists");
    options.chunk_blocks = 1;
    options.chunk_soft_bytes = 128;
    let manifest = import_docx(&source, &path, &options, |_| Ok(())).unwrap();
    let bundle = Bundle::open(&path).unwrap();
    let original = hcd_core::editor_projection(&bundle, None).unwrap();
    assert_eq!(original.blocks.len(), 5);
    assert!(original.blocks.iter().all(|block| !block.read_only));
    assert_eq!(original.blocks[0].content.kind, Kind::Heading);
    assert_eq!(original.blocks[0].content.level, Some(1));
    let root = &original.blocks[1].content;
    assert_eq!(root.kind, Kind::ListItem);
    assert_eq!(root.list_start, Some(4));
    assert_eq!(root.children[0].kind, Kind::Paragraph);
    let sublist = &root.children[1];
    assert_eq!(sublist.kind, Kind::OrderedList);
    assert_eq!(sublist.list_start, Some(7));
    assert_eq!(sublist.children.len(), 2);
    assert_eq!(sublist.children[0].children[1].kind, Kind::BulletList);
    assert_eq!(all_text(root), "Parent AChild sevenLeafChild eight");
    assert_eq!(original.blocks[2].content.list_start, Some(5));
    assert_eq!(original.blocks[4].content.list_start, Some(10));
    let entries = hcd_core::extract_text_page(&bundle, None, 100)
        .unwrap()
        .entries;
    assert_eq!(entries.len(), 8);
    let mut ids = HashSet::new();
    fn anchors(content: &EditorBlockContent, ids: &mut HashSet<String>) {
        for inline in &content.inlines {
            assert!(ids.insert(inline.node_id.clone().unwrap()));
        }
        for child in &content.children {
            anchors(child, ids);
        }
    }
    for block in &original.blocks {
        anchors(&block.content, &mut ids);
    }
    assert_eq!(
        ids,
        entries.iter().map(|entry| entry.node_id.clone()).collect()
    );
    let child = entries
        .iter()
        .find(|entry| entry.text == "Child seven")
        .unwrap();
    let batch = hcd_core::PatchBatch {
        schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.into(),
        document_id: "lists".into(),
        patch_id: "edit-child".into(),
        base_revision: 0,
        actor: BTreeMap::new(),
        metadata: BTreeMap::new(),
        operations: vec![hcd_core::PatchOperation::TextSplice {
            node_id: child.node_id.clone(),
            start: 0,
            delete_count: 11,
            insert_text: "子项已修改".into(),
            precondition: hcd_core::NodePrecondition {
                node_hash: child.node_hash.clone(),
            },
        }],
    };
    hcd_core::apply_patch(&bundle, &batch, 0).unwrap();
    assert!(!requires_semantic_rebuild(&bundle, 1).unwrap());
    let after = hcd_core::get_text_node(&bundle, &child.node_id).unwrap();
    assert_eq!(after.node.source, child.source);
    let historical = hcd_core::editor_projection(&bundle, Some(0)).unwrap();
    assert_eq!(
        serde_json::to_value(&historical).unwrap(),
        serde_json::to_value(&original).unwrap()
    );
    let exported = temp.path().join("updated.docx");
    export_docx(&path, &source, &exported, &ExportOptions::default()).unwrap();
    fn read_part(path: &Path, part: &str) -> String {
        let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
        let mut xml = String::new();
        archive
            .by_name(part)
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        xml
    }
    assert_eq!(
        read_part(&source, "word/numbering.xml"),
        read_part(&exported, "word/numbering.xml")
    );
    assert!(read_part(&exported, "word/document.xml").contains("子项已修改"));
    let reopened_path = temp.path().join("reopened.hcd");
    import_docx(&exported, &reopened_path, &options, |_| Ok(())).unwrap();
    let reopened = Bundle::open(reopened_path).unwrap();
    let state = hcd_core::editor_projection(&reopened, None).unwrap();
    assert_eq!(
        all_text(&state.blocks[1].content),
        "Parent A子项已修改LeafChild eight"
    );
    assert_eq!(state.blocks[2].content.list_start, Some(5));
    assert_eq!(
        hcd_core::manifest_at_revision(&bundle, &bundle.manifest().unwrap(), Some(0))
            .unwrap()
            .0
            .root_hash,
        manifest.root_hash
    );
    let validation = hcd_core::validate_bundle(&bundle).unwrap();
    assert!(validation.valid, "{:?}", validation.issues);
}

#[test]
fn plain_and_heading_line_breaks_survive_projection_and_source_text_edits() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("breaks.docx");
    let path = temp.path().join("breaks.hcd");
    fixture(
        &source,
        &format!(
            "{}{}{}",
            paragraph(
                "a",
                "",
                "first</w:t><w:br/><w:t>second</w:t><w:cr/><w:t>third"
            ),
            paragraph(
                "b",
                "<w:outlineLvl w:val=\"1\"/>",
                "heading</w:t><w:br w:type=\"textWrapping\"></w:br><w:t>next"
            ),
            item("c", 1, 0, "list</w:t><w:br/><w:t>line")
        ),
        "<w:styles xmlns:w=\"w\"/>",
    );
    import_docx(&source, &path, &ImportOptions::new("breaks"), |_| Ok(())).unwrap();
    let bundle = Bundle::open(&path).unwrap();
    let before = hcd_core::editor_projection(&bundle, None).unwrap();
    assert_eq!(all_text(&before.blocks[0].content), "first\nsecond\nthird");
    assert_eq!(all_text(&before.blocks[1].content), "heading\nnext");
    assert_eq!(all_text(&before.blocks[2].content), "list\nline");
    assert_eq!(
        before.blocks[0]
            .content
            .inlines
            .iter()
            .filter(|part| part.hard_break)
            .count(),
        2
    );
    let node = hcd_core::extract_text_page(&bundle, None, 100)
        .unwrap()
        .entries
        .into_iter()
        .find(|node| node.text == "second")
        .unwrap();
    hcd_core::apply_patch(
        &bundle,
        &hcd_core::PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.into(),
            document_id: "breaks".into(),
            patch_id: "edit-after-break".into(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![hcd_core::PatchOperation::TextSplice {
                node_id: node.node_id,
                start: 0,
                delete_count: 6,
                insert_text: "updated".into(),
                precondition: hcd_core::NodePrecondition {
                    node_hash: node.node_hash,
                },
            }],
        },
        0,
    )
    .unwrap();
    let output = temp.path().join("updated.docx");
    export_docx(&path, &source, &output, &ExportOptions::default()).unwrap();
    let mut zip = zip::ZipArchive::new(std::fs::File::open(&output).unwrap()).unwrap();
    let mut xml = String::new();
    zip.by_name("word/document.xml")
        .unwrap()
        .read_to_string(&mut xml)
        .unwrap();
    assert!(xml.contains("<w:br/><w:t>updated</w:t><w:cr/>"));
    let reopened_path = temp.path().join("reopened.hcd");
    import_docx(
        &output,
        &reopened_path,
        &ImportOptions::new("reopened"),
        |_| Ok(()),
    )
    .unwrap();
    let reopened =
        hcd_core::editor_projection(&Bundle::open(reopened_path).unwrap(), None).unwrap();
    assert_eq!(
        all_text(&reopened.blocks[0].content),
        "first\nupdated\nthird"
    );
    assert_eq!(
        all_text(
            &hcd_core::editor_projection(&bundle, Some(0))
                .unwrap()
                .blocks[0]
                .content
        ),
        "first\nsecond\nthird"
    );
}

#[test]
fn headings_use_outline_inheritance_body_override_and_builtin_style_names() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("headings.docx");
    let styles = r#"<w:styles xmlns:w="w">
      <w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>
      <w:style w:type="paragraph" w:styleId="Derived"><w:basedOn w:val="Base"/></w:style>
      <w:style w:type="paragraph" w:styleId="Localized"><w:name w:val="heading 2"/></w:style>
      <w:style w:type="paragraph" w:styleId="NotAHeading"><w:basedOn w:val="Base"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>
      <w:style w:type="paragraph" w:styleId="Cycle"><w:basedOn w:val="Cycle"/></w:style>
    </w:styles>"#;
    let body = [
        paragraph("a", r#"<w:pStyle w:val="Derived"/>"#, "Inherited"),
        paragraph(
            "b",
            r#"<w:pStyle w:val="Derived"/><w:outlineLvl w:val="0"/>"#,
            "Direct",
        ),
        paragraph(
            "c",
            r#"<w:pStyle w:val="Derived"/><w:outlineLvl w:val="9"/>"#,
            "Body override",
        ),
        paragraph("d", r#"<w:pStyle w:val="Localized"/>"#, "Named"),
        paragraph("e", r#"<w:pStyle w:val="NotAHeading"/>"#, "Body style"),
        paragraph("f", r#"<w:pStyle w:val="Heading6"/>"#, "Builtin"),
        paragraph("g", r#"<w:pStyle w:val="Cycle"/>"#, "Cycle"),
        paragraph("h", r#"<w:outlineLvl w:val="6"/>"#, "Deep heading"),
        item("i", 5, 0, "Roman"),
        item("j", 6, 0, "Zero"),
        item("k", 7, 0, "Large start"),
    ]
    .join("");
    fixture(&source, &body, styles);
    let path = temp.path().join("headings.hcd");
    let manifest = import_docx(source, &path, &ImportOptions::new("headings"), |_| Ok(())).unwrap();
    let state = hcd_core::editor_projection(&Bundle::open(path).unwrap(), None).unwrap();
    assert_eq!(
        state
            .blocks
            .iter()
            .map(|block| block.content.level)
            .collect::<Vec<_>>(),
        vec![
            Some(3),
            Some(1),
            None,
            Some(2),
            None,
            Some(6),
            None,
            None,
            None,
            None,
            None
        ]
    );
    assert!(state.blocks[7].read_only && state.blocks[8].read_only);
    assert!(state.blocks[9].read_only && state.blocks[10].read_only);
    assert_eq!(all_text(&state.blocks[8].content), "Roman");
    assert!(state.blocks[8]
        .read_only_html
        .as_ref()
        .unwrap()
        .contains(">I.</span>"));
    assert!(manifest
        .warnings
        .iter()
        .any(|warning| warning.code == "WORD_SEMANTIC_EDITING_LIMIT"));
}

#[test]
fn large_lists_stream_by_root_items_and_empty_parents_retain_children() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("long.docx");
    let mut body = item("empty", 1, 0, "");
    body.push_str(&item("child", 2, 1, "Child of empty parent"));
    for index in 0..300 {
        body.push_str(&item(
            &format!("item{index}"),
            1,
            0,
            &format!("Entry {index}"),
        ));
    }
    fixture(&source, &body, r#"<w:styles xmlns:w="w"/>"#);
    let mut options = ImportOptions::new("long");
    options.chunk_blocks = 2;
    options.chunk_soft_bytes = 2048;
    let mut chunks = Vec::new();
    let path = temp.path().join("long.hcd");
    import_docx(source, &path, &options, |event| {
        if let hcd_core::ImportEvent::ChunkReady { descriptor } = event {
            chunks.push(descriptor.clone());
        }
        Ok(())
    })
    .unwrap();
    assert!(chunks.len() >= 150);
    assert!(chunks
        .iter()
        .all(|chunk| chunk.block_count <= 2 && chunk.byte_length < 4096));
    let bundle = Bundle::open(path).unwrap();
    let state = hcd_core::editor_projection(&bundle, None).unwrap();
    assert_eq!(state.blocks.len(), 301);
    let first = &state.blocks[0].content;
    assert_eq!(all_text(&first.children[0]), "");
    assert_eq!(all_text(&first.children[1]), "Child of empty parent");
    assert_eq!(state.blocks[300].content.list_start, Some(304));
    let validation = hcd_core::validate_bundle(&bundle).unwrap();
    assert!(validation.valid, "{:?}", validation.issues);
}
