//! Build a disposable legacy-mapping fixture for browser acceptance tests.
use hcd_core::{Bundle, BundleWriter};
use std::{io::Write, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("missing new fixture directory")?,
    );
    std::fs::create_dir(&root)?;
    let source = root.join("source.docx");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&source)?);
    for (name, content) in [
        (
            "[Content_Types].xml",
            r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
        ),
        (
            "_rels/.rels",
            r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
        ),
        (
            "word/document.xml",
            r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Normal paragraph</w:t></w:r></w:p><w:p><w:fldSimple w:instr="PAGE"><w:r><w:t>Cached page 1</w:t></w:r></w:fldSimple></w:p><w:p><w:r><w:t>Neighbor paragraph</w:t></w:r></w:p></w:body></w:document>"#,
        ),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())?;
        zip.write_all(content.as_bytes())?;
    }
    zip.finish()?;
    let fresh_path = root.join("fresh.hcd");
    let manifest = hcd_docx::import_docx(
        &source,
        &fresh_path,
        &hcd_docx::ImportOptions::new("inline-native"),
        |_| Ok(()),
    )?;
    let fresh = Bundle::open(fresh_path)?;
    let mut writer = BundleWriter::create(root.join("legacy.hcd"))?;
    writer.write_styles("")?;
    let mut changed = 0;
    for page in 0..manifest.index_page_count {
        for descriptor in fresh.read_index_page(&manifest, page)?.chunks {
            let mut map = fresh.read_map_verified(&descriptor)?;
            for entry in &mut map.entries {
                if entry.source.node_kind == "text" && !entry.source.editable {
                    entry.source.editable = true;
                    changed += 1;
                }
            }
            let html = fresh
                .read_chunk_verified(&descriptor)?
                .replace(" data-hcd-computed-field=\"1\"", "");
            writer.write_chunk(
                map.chunk_id.clone(),
                "body".into(),
                html,
                map,
                descriptor.block_count,
                false,
            )?;
        }
    }
    if changed != 1 {
        return Err("unexpected protected node count".into());
    }
    writer.finish(manifest)?;
    println!("{}", root.display());
    Ok(())
}
