use crate::{Bundle, HcdError, HcdManifest, PdfPagePlacement};
use std::collections::HashSet;

pub const PDF_BLANK_WIDTH_PT: f32 = 595.2756;
pub const PDF_BLANK_HEIGHT_PT: f32 = 841.8898;

pub fn pdf_page_count(bundle: &Bundle, manifest: &HcdManifest) -> Result<usize, HcdError> {
    if manifest.source.format != "pdf" {
        return Err(HcdError::Unsupported(
            "Page organization requires a PDF".into(),
        ));
    }
    let mut count = 0;
    for index in 0..manifest.index_page_count {
        let page = bundle.read_index_page(manifest, index)?;
        count += page
            .chunks
            .iter()
            .filter(|chunk| chunk.region == "page" && !chunk.continuation)
            .count();
    }
    Ok(count)
}

pub fn pdf_page_layout(
    bundle: &Bundle,
    manifest: &HcdManifest,
) -> Result<Vec<PdfPagePlacement>, HcdError> {
    if manifest.source.format != "pdf" || manifest.index_page_count == 0 {
        return Ok(Vec::new());
    }
    let first = bundle.read_index_page(manifest, 0)?;
    let layout = first
        .chunks
        .into_iter()
        .next()
        .map(|chunk| chunk.pdf_layout)
        .unwrap_or_default();
    if !layout.is_empty() {
        validate_pdf_placements(&layout, pdf_page_count(bundle, manifest)?)?;
    }
    Ok(layout)
}

pub fn validate_pdf_placements(
    pages: &[PdfPagePlacement],
    source_page_count: usize,
) -> Result<(), HcdError> {
    if pages.is_empty() || pages.len() > 100_000 {
        return Err(HcdError::InvalidPatch(
            "PDF page layout must contain between 1 and 100,000 pages".into(),
        ));
    }
    let mut seen = HashSet::new();
    for page in pages {
        if !matches!(page.rotation, 0 | 90 | 180 | 270)
            || page.source_page.is_some_and(|number| {
                number == 0 || number as usize > source_page_count || !seen.insert(number)
            })
        {
            return Err(HcdError::InvalidPatch(
                "PDF page layout must use unique source pages and quarter-turn rotations".into(),
            ));
        }
    }
    Ok(())
}
