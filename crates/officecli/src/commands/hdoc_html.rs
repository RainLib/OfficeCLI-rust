//! Shared, bounded standalone HTML export for CLI and HTTP clients.
use base64::Engine;
use hcd_core::{Bundle, HcdError, HtmlPresentationOptions, HtmlPresentationReport};
use std::collections::HashMap;
use std::io::{Read, Write};

pub(crate) fn render(
    bundle: &Bundle,
    options: &HtmlPresentationOptions,
    output: &mut impl Write,
) -> Result<HtmlPresentationReport, HcdError> {
    let revision = options.revision.unwrap_or(bundle.manifest()?.revision);
    let known: HashMap<_, _> = bundle
        .read_asset_index_for_revision(revision)?
        .into_iter()
        .map(|asset| (asset.hash.clone(), asset))
        .collect();
    let pattern =
        regex::Regex::new(r"asset://sha256/([0-9a-f]{64})").expect("constant asset pattern");
    let mut cache = HashMap::<String, String>::new();
    let mut cached_bytes = 0u64;
    hcd_core::render_standalone_html_with_transform(bundle, options, output, |html| {
        let mut transformed = String::new();
        let mut previous = 0;
        for matched in pattern.captures_iter(html) {
            let full = matched.get(0).expect("asset match");
            let hash = matched.get(1).expect("asset hash").as_str();
            if !cache.contains_key(hash) {
                let asset = known
                    .get(hash)
                    .ok_or_else(|| HcdError::InvalidBundle(format!("unknown asset {hash}")))?;
                if asset.byte_length > 64 * 1024 * 1024 {
                    return Err(HcdError::ResourceLimit(
                        "asset exceeds HTML export limit".into(),
                    ));
                }
                let path = bundle.resolve_href(&asset.href)?;
                let mut bytes = Vec::new();
                std::fs::File::open(&path)?
                    .take(asset.byte_length + 1)
                    .read_to_end(&mut bytes)?;
                if bytes.len() as u64 != asset.byte_length || hcd_core::hash_bytes(&bytes) != hash {
                    return Err(HcdError::InvalidBundle(format!(
                        "asset {hash} hash or length mismatch"
                    )));
                }
                let mime = match path
                    .extension()
                    .and_then(|v| v.to_str())
                    .unwrap_or_default()
                {
                    "png" => "image/png",
                    "jpg" | "jpeg" => "image/jpeg",
                    "gif" => "image/gif",
                    "webp" => "image/webp",
                    "svg" => "image/svg+xml",
                    _ => "application/octet-stream",
                };
                let uri = format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                );
                cached_bytes = cached_bytes.saturating_add(uri.len() as u64);
                if cached_bytes > options.max_output_bytes {
                    return Err(HcdError::ResourceLimit(
                        "HTML asset cache exceeds export limit".into(),
                    ));
                }
                cache.insert(hash.to_string(), uri);
            }
            let segment = &html[previous..full.start()];
            let uri = &cache[hash];
            if (transformed.len() as u64)
                .saturating_add(segment.len() as u64)
                .saturating_add(uri.len() as u64)
                > options.max_output_bytes
            {
                return Err(HcdError::ResourceLimit(
                    "HTML fragment exceeds export limit".into(),
                ));
            }
            transformed.push_str(segment);
            transformed.push_str(uri);
            previous = full.end();
        }
        transformed.push_str(&html[previous..]);
        Ok(transformed)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standalone_html_inlines_assets_and_refuses_tampering() {
        let temp = tempfile::tempdir().unwrap();
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/ppt/pictures/pictures-basic.pptx");
        let root = temp.path().join("bundle");
        hcd_formats::import_document(
            &source,
            &root,
            &hcd_formats::ImportOptions::new("html-assets"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&root).unwrap();
        let assets = bundle.read_asset_index().unwrap();
        assert!(!assets.is_empty());
        let mut output = Vec::new();
        render(&bundle, &HtmlPresentationOptions::default(), &mut output).unwrap();
        let html = String::from_utf8(output).unwrap();
        assert!(html.contains("data:image/png;base64,"));
        assert!(!html.contains("asset://"));
        std::fs::write(bundle.resolve_href(&assets[0].href).unwrap(), b"tampered").unwrap();
        assert!(render(
            &bundle,
            &HtmlPresentationOptions::default(),
            &mut Vec::new()
        )
        .is_err());
    }
}
