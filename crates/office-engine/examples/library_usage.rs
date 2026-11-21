//! Run with: cargo run -p office-engine --example library_usage -- /tmp/office-engine-demo
use office_engine::{convert_html, create_document, open_document, CreateOptions};
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("provide an output directory")?,
    );
    std::fs::create_dir_all(&directory)?;
    let created = create_document(
        directory.join("blank.docx"),
        None,
        &CreateOptions::default(),
    )?;
    println!("{}", created.message);

    let source = directory.join("source.html");
    std::fs::write(
        &source,
        "<h1>Office Engine</h1><p>Created directly from Rust. 中文内容。</p>",
    )?;
    for format in ["docx", "xlsx", "pptx", "pdf"] {
        let output = directory.join(format!("converted.{format}"));
        let converted = convert_html(&source, &output, format)?;
        let handler = open_document(&output, false)?;
        let issues = handler.validate()?;
        println!(
            "{}: {} blocks, {} validation issues",
            output.display(),
            converted.block_count,
            issues.len()
        );
        if !issues.is_empty() {
            return Err(format!("validation failed for {}", output.display()).into());
        }
    }
    Ok(())
}
