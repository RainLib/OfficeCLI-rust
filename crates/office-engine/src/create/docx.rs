use super::*;

pub(crate) fn create_blank_docx(path: &str) -> Result<String, HandlerError> {
    create_blank_docx_with_options(path, false)
}

fn create_blank_docx_with_options(path: &str, minimal: bool) -> Result<String, HandlerError> {
    create_blank_docx_with_locale(path, minimal, None)
}

pub(crate) fn create_blank_docx_with_locale(
    path: &str,
    minimal: bool,
    locale: Option<&str>,
) -> Result<String, HandlerError> {
    use oxml::OxmlPackage;

    // Minimal blank docx: word/document.xml with empty body
    let rtl = locale.map(locale_is_rtl).unwrap_or(false);
    let document_xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:r><w:t/></w:r></w:p>
    {}
  </w:body>
</w:document>"#,
        if rtl {
            "<w:sectPr><w:bidi/></w:sectPr>"
        } else {
            ""
        }
    );

    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
</Types>"#;
    let minimal_content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#;

    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;

    // Word permits documents without styles.xml, but Markdown headings and
    // direct `style=HeadingN` edits must not create dangling pStyle IDs. Keep
    // the built-in style IDs Word itself recognizes, with concise definitions
    // sufficient for interoperable OOXML and later style mutation.
    let (latin, east_asia, complex_script) = locale_fonts(locale);
    let r_fonts = format!(
        "<w:rFonts w:ascii=\"{}\" w:hAnsi=\"{}\"{}{} />",
        latin.unwrap_or("Calibri"),
        latin.unwrap_or("Calibri"),
        east_asia
            .map(|font| format!(" w:eastAsia=\"{}\"", font))
            .unwrap_or_default(),
        complex_script
            .map(|font| format!(" w:cs=\"{}\"", font))
            .unwrap_or_default(),
    );
    let paragraph_defaults = if rtl {
        "<w:pPrDefault><w:pPr><w:bidi/></w:pPr></w:pPrDefault>"
    } else {
        ""
    };
    let styles_xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr>{}</w:rPr></w:rPrDefault>{}</w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading7"><w:name w:val="heading 7"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading8"><w:name w:val="heading 8"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading9"><w:name w:val="heading 9"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/></w:style>
</w:styles>"#,
        r_fonts, paragraph_defaults
    );
    let document_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>"#;

    let mut pkg = OxmlPackage::create(path);
    pkg.add_part(
        "[Content_Types].xml",
        if minimal {
            minimal_content_types.as_bytes()
        } else {
            content_types.as_bytes()
        },
    );
    pkg.add_part("_rels/.rels", rels.as_bytes());
    pkg.add_part("word/document.xml", document_xml.as_bytes());
    if !minimal {
        pkg.add_part("word/styles.xml", styles_xml.as_bytes());
        // Keep non-minimal Word creation aligned with C# BlankDocCreator:
        // styles and future theme-font references resolve through a real
        // theme part, and `dump /theme` can replay into a fresh document.
        pkg.add_part(
            "word/theme/theme1.xml",
            default_theme_xml(locale).as_bytes(),
        );
        pkg.add_part("word/_rels/document.xml.rels", document_rels.as_bytes());
    }

    pkg.save_as(path)
        .map_err(|e| HandlerError::SaveError(e.to_string()))?;
    Ok(format!("Created blank Word document: {}", path))
}
