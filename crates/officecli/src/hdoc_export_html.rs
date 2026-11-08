//! One self-contained HTML export path for CLI and authenticated HTTP. This is
//! a derived artifact; no source document, registry or network lookup is used.
mod word;
use base64::Engine;
use hcd_core::{
    AssetDescriptor, Bundle, HcdError, HtmlPresentationOptions, HtmlPresentationReport,
};
use quick_xml::{events::Event, Reader};
use std::collections::{BTreeMap, HashMap};
use std::io::Write;

pub(crate) const MAX_HTML_EXPORT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 64 * 1024 * 1024;

pub(crate) struct HtmlExportReport {
    pub presentation: HtmlPresentationReport,
    pub embedded_assets: usize,
    pub word_regions: bool,
}

struct Resources<'a> {
    bundle: &'a Bundle,
    known: HashMap<String, AssetDescriptor>,
    encoded: HashMap<String, String>,
    encoded_bytes: usize,
    attachments: BTreeMap<(String, String), ()>,
}
impl Resources<'_> {
    fn uri(&mut self, hash: &str) -> Result<&str, HcdError> {
        if !self.encoded.contains_key(hash) {
            let asset = self
                .known
                .get(hash)
                .ok_or_else(|| HcdError::InvalidBundle(format!("unknown asset {hash}")))?;
            if asset.byte_length > MAX_ASSET_BYTES {
                return Err(HcdError::ResourceLimit(
                    "asset exceeds HTML export limit".into(),
                ));
            }
            // Check encoded allocation before reading/encoding. Repeated image
            // references reuse the verified bytes; total output is bounded too.
            let encoded_length = asset.byte_length.div_ceil(3).saturating_mul(4);
            if (self.encoded_bytes as u64)
                .saturating_add(encoded_length)
                .saturating_add(128)
                > MAX_HTML_EXPORT_BYTES
            {
                return Err(HcdError::ResourceLimit(
                    "embedded assets exceed HTML export limit".into(),
                ));
            }
            let path = self.bundle.resolve_href(&asset.href)?;
            if std::fs::metadata(&path)?.len() != asset.byte_length
                || hcd_core::hash_file(&path)? != hash
            {
                return Err(HcdError::InvalidBundle(format!(
                    "asset {hash} hash or length mismatch"
                )));
            }
            let bytes = std::fs::read(&path)?;
            // Recheck the exact bytes used in the artifact, rather than trusting
            // a successful earlier path read while the underlying file changes.
            if bytes.len() as u64 != asset.byte_length || hcd_core::hash_bytes(&bytes) != hash {
                return Err(HcdError::InvalidBundle(format!(
                    "asset {hash} changed during HTML export"
                )));
            }
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            let mime = crate::hdoc_asset_mime::asset_mime(extension, &bytes);
            let value = format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            );
            self.encoded_bytes += value.len();
            self.encoded.insert(hash.into(), value);
        }
        Ok(&self.encoded[hash])
    }

    fn fragment(&mut self, html: &str) -> Result<String, HcdError> {
        let adapted = hcd_core::adapt_extension_exports(html, "html")?;
        let mut reader = Reader::from_str(&adapted);
        let mut edits = Vec::new();
        loop {
            let start = reader.buffer_position() as usize;
            let event = reader
                .read_event()
                .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
            match event {
                Event::Start(element) | Event::Empty(element) => {
                    for attribute in element.attributes() {
                        let attribute = attribute
                            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
                        let key = attribute.key.as_ref();
                        if key.eq_ignore_ascii_case(b"data-hcd-extension") {
                            let value = attribute
                                .decode_and_unescape_value(reader.decoder())
                                .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
                            let node: hcd_core::ExtensionNode = serde_json::from_str(&value)?;
                            node.validate()?;
                            for resource in node.resources {
                                let asset = self.known.get(&resource.hash).ok_or_else(|| {
                                    HcdError::InvalidBundle("unknown HTML node resource".into())
                                })?;
                                if asset.byte_length != resource.byte_length {
                                    return Err(HcdError::InvalidBundle(
                                        "HTML node resource length mismatch".into(),
                                    ));
                                }
                                self.attachments
                                    .entry((resource.hash, resource.name))
                                    .or_insert(());
                            }
                        }
                        if !key.eq_ignore_ascii_case(b"src")
                            && !key.eq_ignore_ascii_case(b"href")
                            && !key.eq_ignore_ascii_case(b"xlink:href")
                        {
                            continue;
                        }
                        let raw = std::str::from_utf8(attribute.value.as_ref())
                            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
                        let Some(hash) = raw.strip_prefix("asset://sha256/") else {
                            continue;
                        };
                        if hash.len() != 64
                            || !hash
                                .bytes()
                                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                        {
                            return Err(HcdError::InvalidBundle(
                                "invalid HTML resource reference".into(),
                            ));
                        }
                        // Slice-reader attributes borrow the original fragment.
                        // Verify that range before recording a replacement, so
                        // ordinary text and inert JSON data never get rewritten.
                        let offset = (attribute.value.as_ptr() as usize)
                            .checked_sub(adapted.as_ptr() as usize)
                            .ok_or_else(|| {
                                HcdError::InvalidBundle("unbound HTML resource attribute".into())
                            })?;
                        let end = offset.checked_add(raw.len()).ok_or_else(|| {
                            HcdError::ResourceLimit("HTML resource offset overflow".into())
                        })?;
                        if offset < start
                            || end > reader.buffer_position() as usize
                            || adapted.as_bytes().get(offset..end) != Some(attribute.value.as_ref())
                        {
                            return Err(HcdError::InvalidBundle(
                                "unbound HTML resource attribute".into(),
                            ));
                        }
                        edits.push((offset..end, hash.to_string()));
                    }
                }
                Event::Eof => break,
                _ => {}
            }
        }
        let mut result = String::with_capacity(adapted.len());
        let mut previous = 0;
        for (range, hash) in edits {
            let uri = self.uri(&hash)?;
            if range.start < previous
                || result
                    .len()
                    .saturating_add(range.start - previous)
                    .saturating_add(uri.len())
                    > MAX_HTML_EXPORT_BYTES as usize
            {
                return Err(HcdError::ResourceLimit(
                    "HTML export chunk exceeds output limit".into(),
                ));
            }
            result.push_str(&adapted[previous..range.start]);
            result.push_str(uri);
            previous = range.end;
        }
        result.push_str(&adapted[previous..]);
        Ok(result)
    }

    /// Node resources can share bytes with displayed images or other files.
    /// Keep each distinct download name even when those bytes are rendered.
    fn attachment_suffix(&mut self) -> Result<String, HcdError> {
        let unused: Vec<_> = self.attachments.keys().cloned().collect();
        if unused.is_empty() {
            return Ok(String::new());
        }
        let mut result = String::from("<aside class=\"hcd-export-attachments\"><details><summary>Attachments / 文档附件</summary><ul>");
        for (hash, name) in unused {
            let uri = self.uri(&hash)?;
            if result.len().saturating_add(uri.len()).saturating_add(2048)
                > MAX_HTML_EXPORT_BYTES as usize
            {
                return Err(HcdError::ResourceLimit(
                    "HTML attachments exceed output limit".into(),
                ));
            }
            let name = quick_xml::escape::escape(&name);
            result.push_str(&format!("<li><a data-hcd-resource-hash=\"{hash}\" download=\"{name}\" href=\"{uri}\">{name}</a></li>"));
        }
        result.push_str("</ul></details></aside>");
        Ok(result)
    }
}

pub(crate) fn render(
    bundle: &Bundle,
    revision: u64,
    output: &mut impl Write,
) -> Result<HtmlExportReport, HcdError> {
    let head = bundle.manifest()?;
    let (manifest, _) = hcd_core::manifest_at_revision(bundle, &head, Some(revision))?;
    let layout = hcd_core::read_flow_document_layout(bundle, &manifest)?;
    let tail = layout.as_ref().map(word::suffix).transpose()?;
    if layout.is_some() && manifest.chunk_count == 0 {
        return Err(HcdError::InvalidBundle(
            "Word HTML requires canonical region chunks".into(),
        ));
    }
    let mut known = HashMap::new();
    for asset in bundle.read_asset_index_for_revision(revision)? {
        if known.insert(asset.hash.clone(), asset).is_some() {
            return Err(HcdError::InvalidBundle(
                "duplicate HTML export asset identity".into(),
            ));
        }
    }
    let mut resources = Resources {
        bundle,
        known,
        encoded: HashMap::new(),
        encoded_bytes: 0,
        attachments: BTreeMap::new(),
    };
    let options = HtmlPresentationOptions {
        revision: Some(revision),
        max_output_bytes: MAX_HTML_EXPORT_BYTES,
        max_transformed_chunk_bytes: MAX_HTML_EXPORT_BYTES as usize,
        paginate_docx_preview: layout.is_none(),
        text_hitboxes_enabled: layout.is_none(),
        image_hitboxes_enabled: layout.is_none(),
        // Explicitly select the full window so the presentation reader checks
        // the selected revision's index/stylesheet/asset root, including r0.
        chunk_limit: Some(manifest.chunk_count.max(1)),
        ..Default::default()
    };
    let mut at = 0;
    let presentation =
        hcd_core::render_standalone_html_with_transform(bundle, &options, output, |html| {
            at += 1;
            let mut result = resources.fragment(html)?;
            if at == manifest.chunk_count {
                result.push_str(&resources.attachment_suffix()?);
                if let Some(tail) = &tail {
                    result.push_str(tail);
                }
            }
            Ok(result)
        })?;
    Ok(HtmlExportReport {
        presentation,
        embedded_assets: resources.encoded.len(),
        word_regions: layout.is_some(),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use hcd_core::{
        BundleWriter, ChunkSourceMap, HcdCapabilities, HcdManifest, SourceDescriptor, StorageCodec,
        HCD_SCHEMA_VERSION,
    };
    fn fixture(
        bytes: &[u8],
        html: impl FnOnce(&str) -> String,
    ) -> (tempfile::TempDir, Bundle, String) {
        fixture_with_extension(bytes, "png", html)
    }
    pub(crate) fn fixture_with_extension(
        bytes: &[u8],
        extension: &str,
        html: impl FnOnce(&str) -> String,
    ) -> (tempfile::TempDir, Bundle, String) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("doc.hcd");
        let mut writer = BundleWriter::create(&path).unwrap();
        writer.write_styles("p{color:#123456}").unwrap();
        let (href, hash, byte_length) = writer
            .write_asset_from_reader(extension, &mut std::io::Cursor::new(bytes))
            .unwrap();
        let asset = AssetDescriptor {
            source_part: "html/uploads/image.png".into(),
            hash: hash.clone(),
            href,
            byte_length,
        };
        std::fs::write(
            path.join("assets/index.json"),
            serde_json::to_vec(&vec![asset]).unwrap(),
        )
        .unwrap();
        let chunk_id = format!("c_{:032x}", 1);
        writer
            .write_chunk(
                chunk_id.clone(),
                "body".into(),
                html(&hash),
                ChunkSourceMap {
                    schema_version: HCD_SCHEMA_VERSION.into(),
                    chunk_id,
                    entries: Vec::new(),
                },
                1,
                false,
            )
            .unwrap();
        writer
            .finish(HcdManifest {
                schema_version: HCD_SCHEMA_VERSION.into(),
                storage_codec: StorageCodec::None,
                document_id: "doc".into(),
                profile: "semantic-flow".into(),
                revision: 0,
                source: SourceDescriptor {
                    format: "html".into(),
                    sha256: "0".repeat(64),
                    size_bytes: 0,
                },
                root_hash: String::new(),
                annotation_root_hash: String::new(),
                annotation_href: None,
                index_prefix: String::new(),
                index_root_href: None,
                index_page_count: 0,
                chunk_count: 0,
                styles_href: String::new(),
                capabilities: HcdCapabilities::default(),
                fidelity: None,
                state: "IMPORTING".into(),
                warnings: Vec::new(),
            })
            .unwrap();
        (temp, Bundle::open(path).unwrap(), hash)
    }
    #[test]
    fn standalone_html_embeds_binary_archived_png_as_image() {
        let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
        let (_temp, bundle, _) = fixture_with_extension(&png, "bin", |hash| {
            format!("<img src=\"asset://sha256/{hash}\"/>")
        });
        let mut output = Vec::new();
        render(&bundle, 0, &mut output).unwrap();
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains(&format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&png)
        )));
    }
    #[test]
    fn standalone_html_embeds_exact_verified_bytes_and_reuses_repeated_resources() {
        let bytes = [1, 2, 3, 4, 5];
        let (_temp, bundle, _) = fixture(&bytes, |hash| {
            format!("<p>Offline</p><img src=\"asset://sha256/{hash}\"/><img src=\"asset://sha256/{hash}\"/>")
        });
        let mut output = Vec::new();
        let report = render(&bundle, 0, &mut output).unwrap();
        assert_eq!(report.embedded_assets, 1);
        assert_eq!(report.presentation.revision, 0);
        let text = String::from_utf8(output).unwrap();
        assert_eq!(text.matches("data:image/png;base64,AQIDBAU=").count(), 2);
        assert!(!text.contains("asset://"));
        assert!(text.contains("p{color:#123456}"));
    }
    #[test]
    fn standalone_html_allows_large_encoded_images_without_loosening_preview_defaults() {
        let bytes = vec![7; hcd_core::MAX_CHUNK_BYTES * 4];
        let (_temp, bundle, _) = fixture(&bytes, |hash| {
            format!("<img src=\"asset://sha256/{hash}\"/>")
        });
        let mut output = Vec::new();
        let report = render(&bundle, 0, &mut output).unwrap();
        assert!(report.presentation.bytes_written > bytes.len() as u64);
        assert!(HtmlPresentationOptions::default().max_transformed_chunk_bytes < output.len());
        let mut preview = Vec::new();
        let error = hcd_core::render_standalone_html_with_transform(
            &bundle,
            &Default::default(),
            &mut preview,
            |_| Ok("x".repeat(hcd_core::MAX_CHUNK_BYTES * 4 + 1)),
        )
        .unwrap_err();
        assert!(matches!(error, HcdError::ResourceLimit(_)));
    }
    #[test]
    fn standalone_html_rejects_a_resource_changed_after_the_revision_was_written() {
        let (_temp, bundle, hash) = fixture(b"original", |hash| {
            format!("<img src=\"asset://sha256/{hash}\"/>")
        });
        let asset = bundle.read_asset_index_for_revision(0).unwrap().remove(0);
        std::fs::write(bundle.resolve_href(&asset.href).unwrap(), b"tampered").unwrap();
        let error = render(&bundle, 0, &mut Vec::new()).err().unwrap();
        assert!(error.to_string().contains(&hash));
    }
    #[test]
    fn standalone_html_rejects_unknown_assets_and_changed_revision_roots() {
        let (_temp, bundle, _) = fixture(b"known", |_| {
            format!("<img src=\"asset://sha256/{}\"/>", "a".repeat(64))
        });
        assert!(render(&bundle, 0, &mut Vec::new())
            .err()
            .unwrap()
            .to_string()
            .contains("unknown asset"));
        std::fs::write(bundle.root().join("styles.css"), "p{color:red}").unwrap();
        assert!(render(&bundle, 0, &mut Vec::new())
            .err()
            .unwrap()
            .to_string()
            .contains("root hash"));
    }
    #[test]
    fn standalone_html_preserves_missing_codec_metadata_and_uses_portable_snapshots() {
        let (_temp, bundle, _) = fixture(b"png", |hash| {
            let node = serde_json::json!({"schemaVersion":"hcd.extension/2","instanceId":format!("x_{:032x}",1),"type":"example.missing","version":77,"display":"block","data":{"private":"offline-kept"},"fallback":{"text":"Readable fallback"},"resources":[{"key":"photo","name":"image.png","mediaType":"image/png","byteLength":3,"hash":hash}],"exports":{"html":{"support":"semantic","blocks":[{"kind":"paragraph","runs":[{"text":"Portable display"},{"resource":"photo","alt":"Photo","widthPt":32,"heightPt":24}]}]}}});
            let escaped = node
                .to_string()
                .replace('&', "&amp;")
                .replace('"', "&quot;")
                .replace('<', "&lt;");
            format!("<div data-hcd-extension=\"{escaped}\">Readable fallback</div>")
        });
        let mut output = Vec::new();
        render(&bundle, 0, &mut output).unwrap();
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains("Portable display"));
        assert!(text.contains("offline-kept"));
        assert!(text.contains("data:image/png;base64,cG5n"));
        assert!(text.contains("data-hcd-extension="));
    }
    #[test]
    fn standalone_html_refuses_unknown_historical_versions_instead_of_exporting_head() {
        let (_temp, bundle, _) = fixture(b"png", |_| "<p>Head only</p>".into());
        let mut output = Vec::new();
        assert!(render(&bundle, 99, &mut output).is_err());
        assert!(output.is_empty());
    }
    #[test]
    fn standalone_html_carries_unrendered_node_files_and_escapes_download_names() {
        let (_temp, bundle, hash) = fixture(b"png", |hash| {
            let node = serde_json::json!({"schemaVersion":"hcd.extension/2","instanceId":format!("x_{:032x}",1),"type":"example.missing","version":77,"display":"block","data":{},"fallback":{"text":"Readable file card"},"resources":[{"key":"photo","name":"photo <one> & \"two\".png","mediaType":"image/png","byteLength":3,"hash":hash}]});
            let escaped = quick_xml::escape::escape(node.to_string()).into_owned();
            format!("<div data-hcd-extension=\"{escaped}\">Readable file card</div>")
        });
        let mut output = Vec::new();
        let report = render(&bundle, 0, &mut output).unwrap();
        let text = String::from_utf8(output).unwrap();
        assert_eq!(report.embedded_assets, 1);
        assert!(text.contains(&format!("data-hcd-resource-hash=\"{hash}\"")));
        assert!(text.contains("download=\"photo &lt;one&gt; &amp; &quot;two&quot;.png\""));
        assert_eq!(text.matches("data:image/png;base64,cG5n").count(), 1);
        assert!(!text.contains("<one>"));
    }
    #[test]
    fn standalone_html_preserves_download_names_for_shared_displayed_bytes() {
        let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
        let (_temp, bundle, hash) = fixture_with_extension(&png, "bin", |hash| {
            let node = serde_json::json!({"schemaVersion":"hcd.extension/2","instanceId":format!("x_{:032x}",1),"type":"example.shared","version":1,"display":"block","data":{},"fallback":{"text":"Files"},"resources":[{"key":"photo","name":"picture.png","mediaType":"image/png","byteLength":png.len(),"hash":hash},{"key":"file","name":"attachment.bin","mediaType":"application/octet-stream","byteLength":png.len(),"hash":hash}],"exports":{"html":{"support":"semantic","blocks":[{"kind":"paragraph","runs":[{"resource":"photo","alt":"Photo","widthPt":32,"heightPt":24}]}]}}});
            format!(
                "<div data-hcd-extension=\"{}\">Files</div>",
                quick_xml::escape::escape(node.to_string())
            )
        });
        let mut output = Vec::new();
        let report = render(&bundle, 0, &mut output).unwrap();
        let text = String::from_utf8(output).unwrap();
        assert_eq!(report.embedded_assets, 1);
        assert_eq!(
            text.matches(&format!("data-hcd-resource-hash=\"{hash}\""))
                .count(),
            2
        );
        assert!(text.contains("download=\"picture.png\""));
        assert!(text.contains("download=\"attachment.bin\""));
        let data = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&png)
        );
        assert_eq!(text.matches(&data).count(), 3);
        if let Some(path) = std::env::var_os("HCD_TEST_SHARED_ASSET_HTML") {
            std::fs::write(path, text).unwrap();
        }
    }
    #[test]
    fn standalone_html_verifies_node_files_even_without_a_target_snapshot() {
        let (_temp, bundle, hash) = fixture(b"png", |hash| {
            let node = serde_json::json!({"schemaVersion":"hcd.extension/2","instanceId":format!("x_{:032x}",1),"type":"example.missing","version":77,"display":"block","data":{},"fallback":{"text":"Readable file card"},"resources":[{"key":"photo","name":"photo.png","mediaType":"image/png","byteLength":3,"hash":hash}]});
            format!(
                "<div data-hcd-extension=\"{}\">Readable file card</div>",
                quick_xml::escape::escape(node.to_string())
            )
        });
        let asset = bundle
            .read_asset_index_for_revision(0)
            .unwrap()
            .into_iter()
            .find(|asset| asset.hash == hash)
            .unwrap();
        std::fs::write(bundle.resolve_href(&asset.href).unwrap(), b"bad").unwrap();
        assert!(render(&bundle, 0, &mut Vec::new())
            .err()
            .unwrap()
            .to_string()
            .contains("hash or length mismatch"));
    }
}

#[cfg(test)]
mod fidelity_tests {
    use super::*;
    #[test]
    fn standalone_html_only_rewrites_resource_attributes_not_text_or_business_data() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("doc");
        let writer = hcd_core::BundleWriter::create(&path).unwrap();
        let (href, hash, byte_length) = writer
            .write_asset_from_reader("png", &mut std::io::Cursor::new(b"png"))
            .unwrap();
        let bundle = Bundle::open(&path).unwrap();
        let mut resources = Resources {
            bundle: &bundle,
            known: HashMap::from([(
                hash.clone(),
                AssetDescriptor {
                    source_part: "image".into(),
                    hash: hash.clone(),
                    href,
                    byte_length,
                },
            )]),
            encoded: HashMap::new(),
            encoded_bytes: 0,
            attachments: BTreeMap::new(),
        };
        let literal = format!("asset://sha256/{hash}");
        let html=format!("<p>{literal} and asset://sha256/{}</p><span data-business=\"{literal}\">kept</span><img src=\"{literal}\"/>","a".repeat(64));
        let result = resources.fragment(&html).unwrap();
        assert_eq!(result.matches(&literal).count(), 2);
        assert!(result.contains(&"a".repeat(64)));
        assert_eq!(result.matches("data:image/png;base64,cG5n").count(), 1);
    }
    #[test]
    fn standalone_html_checks_asset_and_encoded_budgets_before_allocation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("doc");
        let writer = hcd_core::BundleWriter::create(&path).unwrap();
        let bundle = Bundle::open(&path).unwrap();
        let hash = "a".repeat(64);
        let descriptor = AssetDescriptor {
            source_part: "image".into(),
            hash: hash.clone(),
            href: "assets/sha256/missing.png".into(),
            byte_length: MAX_ASSET_BYTES + 1,
        };
        let mut resources = Resources {
            bundle: &bundle,
            known: HashMap::from([(hash.clone(), descriptor)]),
            encoded: HashMap::new(),
            encoded_bytes: 0,
            attachments: BTreeMap::new(),
        };
        assert!(matches!(
            resources.uri(&hash),
            Err(HcdError::ResourceLimit(_))
        ));
        resources.known.get_mut(&hash).unwrap().byte_length = 1;
        resources.encoded_bytes = MAX_HTML_EXPORT_BYTES as usize;
        assert!(matches!(
            resources.uri(&hash),
            Err(HcdError::ResourceLimit(_))
        ));
        assert!(resources.encoded.is_empty());
        drop(writer);
    }
}
