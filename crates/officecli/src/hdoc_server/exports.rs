use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExportCapabilities {
    document_id: String,
    source_format: String,
    revision: u64,
    head_revision: u64,
    default_format: String,
    formats: Vec<FormatCapability>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FormatCapability {
    format: String,
    available: bool,
    recommended_mode: String,
    modes: Vec<ExportMode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportMode {
    id: String,
    source: bool,
    available: bool,
    reason_code: Option<String>,
    reason: Option<String>,
    warnings: Vec<String>,
    font_warnings: Vec<String>,
}

impl ExportMode {
    fn new(id: &str, warnings: Vec<String>) -> Self {
        Self {
            id: id.into(),
            source: id == "source",
            available: true,
            reason_code: None,
            reason: None,
            warnings,
            font_warnings: Vec::new(),
        }
    }
    fn disable(&mut self, code: &str, reason: String) {
        self.available = false;
        self.reason_code = Some(code.into());
        self.reason = Some(reason);
    }
}

pub(super) async fn capabilities(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<ExportQuery>,
    headers: HeaderMap,
) -> Result<Json<ExportCapabilities>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let access = integration::access(&state, &headers, &id).await?;
    let plan_state = state.clone();
    let plan_id = id.clone();
    let mut plan = tokio::task::spawn_blocking(move || {
        let bundle = open(&plan_state, &plan_id)?;
        let head = bundle.manifest().map_err(internal)?;
        let range = checked_pdf_range(&bundle, &head, "pdf", &query)?;
        build_capabilities_with_range(&plan_state, &plan_id, query.revision, range)
    })
    .await
    .map_err(internal)??;
    if let Some(decision) = access {
        for format in &mut plan.formats {
            if integration::export_permission(&state, &id, &format.format, &decision).is_err() {
                format.available = false;
                for mode in &mut format.modes {
                    mode.disable(
                        "permission_denied",
                        "business policy does not allow this export".into(),
                    );
                }
            }
        }
    }
    Ok(Json(plan))
}

pub(super) async fn format_capabilities(
    State(state): State<ServerState>,
    Path((id, format)): Path<(String, String)>,
    Query(query): Query<ExportQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    if query.pdf_pages.is_some() && format != "pdf" {
        return Err(bad("pdfPages requires PDF-to-PDF export"));
    }
    let Json(plan) = capabilities(State(state), Path(id), Query(query), headers).await?;
    let selected = plan.formats.iter().find(|item| item.format == format);
    let source = selected.and_then(|item| item.modes.iter().find(|mode| mode.source));
    Ok(Json(json!({
        "revision": plan.revision,
        "source": {
            "available": source.is_some_and(|mode| mode.available),
            "reason": source.and_then(|mode| mode.reason.as_deref()).or_else(|| source.is_none().then_some("Source-backed export requires the original format")),
        }
    })))
}

fn build_capabilities_with_range(
    state: &ServerState,
    id: &str,
    revision: Option<u64>,
    range: Option<PdfPageRange>,
) -> Result<ExportCapabilities, ApiError> {
    let bundle = open(state, id)?;
    let head = bundle.manifest().map_err(internal)?;
    let (manifest, revision) = manifest_at_revision(&bundle, &head, revision).map_err(bad)?;
    let source_format = match head.source.format.as_str() {
        "markdown" => "md",
        "htm" => "html",
        other => other,
    }
    .to_string();
    if source_format == "excalidraw" {
        return Ok(ExportCapabilities {
            document_id: id.into(),
            source_format,
            revision,
            head_revision: head.revision,
            default_format: "excalidraw".into(),
            formats: vec![
                FormatCapability {
                    format: "excalidraw".into(),
                    available: true,
                    recommended_mode: "source".into(),
                    modes: vec![ExportMode::new("source", vec![])],
                },
                FormatCapability {
                    format: "hcd".into(),
                    available: revision == head.revision,
                    recommended_mode: "archive".into(),
                    modes: vec![ExportMode::new("archive", vec![])],
                },
            ],
        });
    }
    if hcd_formats::images::is_image_format(&source_format) {
        let layered = hcd_core::image_layers::saved_snapshot(&bundle, revision)
            .map_err(hcd_error)?
            .is_some();
        let formats = office_engine::registry::image_export_formats()
            .into_iter()
            .map(|format| {
                let archive = format == "hcd";
                let mode = if archive { "archive" } else { "raster" };
                let mut warnings = Vec::new();
                if layered {
                    warnings.push(
                        if archive {
                            "image_layers_archive"
                        } else {
                            "image_layers_flattened"
                        }
                        .into(),
                    );
                }
                if format == "webp" {
                    warnings.push("lossless_webp".into());
                }
                FormatCapability {
                    format: format.into(),
                    available: !archive || revision == head.revision,
                    recommended_mode: mode.into(),
                    modes: vec![ExportMode::new(mode, warnings)],
                }
            })
            .collect();
        return Ok(ExportCapabilities {
            document_id: id.into(),
            source_format,
            revision,
            head_revision: head.revision,
            default_format: "png".into(),
            formats,
        });
    }
    let source_path = state
        .root
        .join("sources")
        .join(format!("{id}.{}", head.source.format));
    let source_result = if !source_path.is_file() {
        Err((
            "source_missing",
            "immutable source is unavailable".to_string(),
        ))
    } else {
        let result = if source_format == "pdf" {
            hcd_formats::validate_pdf_source_export(
                &bundle,
                &source_path,
                revision,
                range.map(|range| range.start..=range.end),
            )
        } else {
            hcd_formats::validate_source_export(&bundle, &source_path, Some(revision))
        };
        result.map_err(|error| {
            let code = match &error {
                HcdError::SourceMismatch(_) => "source_mismatch",
                HcdError::Unsupported(_) => "source_revision_unsupported",
                _ => "source_unreadable",
            };
            (code, error.to_string())
        })
    };
    let mut formats = Vec::new();
    for format in office_engine::registry::document_export_formats(manifest.source.is_spreadsheet())
    {
        let mut warnings = Vec::new();
        let mode_id = match format {
            "hcd" => "archive",
            "html" => "canonical",
            "pdf" => "visual",
            _ => "semantic",
        };
        if mode_id == "semantic" {
            warnings.push("semantic_rebuild".into());
            if source_format == "xlsx" && format != "xlsx" {
                warnings.push("workbook_features_lost".into());
            }
            if source_format == "pdf" {
                warnings.push("pdf_no_ocr".into());
            }
        }
        if format == "pdf" {
            warnings.push(
                if source_format == "docx" {
                    "word_preview_layout"
                } else if source_format == "pdf" && manifest.profile == "fixed-layout" {
                    "pdf_visual_flattened"
                } else {
                    "canonical_pagination"
                }
                .into(),
            );
        }
        if format == "hcd" {
            warnings.push("archive_history".into());
        }
        let mut modes = vec![ExportMode::new(mode_id, warnings)];
        if format == "pdf"
            && source_format == "docx"
            && crate::commands::hdoc_word_pdf::browser().is_none()
        {
            modes[0].disable("layout_engine_unavailable","high-fidelity Word PDF export requires a Chromium renderer; configure OFFICECLI_PDF_BROWSER".into());
        }
        if format == "hcd" && revision != head.revision {
            modes[0].disable(
                "history_archive_unavailable",
                "portable HCD includes history through the current revision".into(),
            );
        }
        if format == source_format
            && office_engine::registry::format_for_extension(format)
                .is_some_and(|registration| registration.can_open())
        {
            let mut source = ExportMode::new(
                "source",
                if format == "pdf" && revision > 0 {
                    vec!["source_pdf_approximate".into()]
                } else {
                    Vec::new()
                },
            );
            if let Err((code, reason)) = &source_result {
                source.disable(code, reason.clone());
            }
            modes.insert(0, source);
        }
        if let Some(kind) = embed_kind(format) {
            match theme_font_report(&state.catalog, &bundle, Some(revision), kind) {
                Ok(fonts) => {
                    let font_warnings: Vec<String> = fonts
                        .into_iter()
                        .flat_map(|font| {
                            [
                                font.reason
                                    .map(|reason| format!("{}: {reason}", font.family)),
                                font.warning,
                            ]
                        })
                        .flatten()
                        .collect();
                    for mode in &mut modes {
                        mode.font_warnings = font_warnings.clone();
                    }
                }
                Err(error) => {
                    for mode in &mut modes {
                        mode.disable("theme_unavailable", error.to_string());
                    }
                }
            }
        }
        let recommended = if source_format == "pdf" && format == "pdf" {
            "visual"
        } else {
            "source"
        };
        // A same-format Word download must never silently switch to the lossy
        // semantic writer. Unsupported native edits stay explicit in the UI.
        let recommended_mode = if format == "docx" && source_format == "docx" {
            "source".into()
        } else {
            modes
                .iter()
                .find(|mode| mode.id == recommended && mode.available)
                .or_else(|| modes.iter().find(|mode| mode.available))
                .unwrap_or(&modes[0])
                .id
                .clone()
        };
        formats.push(FormatCapability {
            format: format.into(),
            available: modes.iter().any(|mode| mode.available),
            recommended_mode,
            modes,
        });
    }
    let default_format = formats
        .iter()
        .find(|item| item.format == source_format && item.available)
        .or_else(|| {
            formats
                .iter()
                .find(|item| item.format == "html" && item.available)
        })
        .map(|item| item.format.clone())
        .unwrap_or_else(|| "txt".into());
    Ok(ExportCapabilities {
        document_id: id.into(),
        source_format,
        revision,
        head_revision: head.revision,
        default_format,
        formats,
    })
}

#[derive(Clone, Default, Deserialize)]
pub(super) struct ExportQuery {
    pub(super) revision: Option<u64>,
    pub(super) source: Option<bool>,
    pub(super) filename: Option<String>,
    #[serde(rename = "pdfPages", default)]
    pub(super) pdf_pages: Option<String>,
    #[serde(default)]
    pub(super) sheet: Option<String>,
}

fn checked_pdf_range(
    bundle: &Bundle,
    head: &hcd_core::HcdManifest,
    format: &str,
    query: &ExportQuery,
) -> Result<Option<PdfPageRange>, ApiError> {
    let Some(pages) = query.pdf_pages.as_deref() else {
        return Ok(None);
    };
    if format != "pdf" || head.source.format != "pdf" {
        return Err(bad("pdfPages requires PDF-to-PDF export"));
    }
    let range: PdfPageRange = pages.parse().map_err(bad)?;
    let (manifest, _) = manifest_at_revision(bundle, head, query.revision).map_err(bad)?;
    let layout = hcd_core::pdf_page_layout(bundle, &manifest).map_err(bad)?;
    let page_count = if layout.is_empty() {
        hcd_core::pdf_page_count(bundle, &manifest).map_err(bad)?
    } else {
        layout.len()
    };
    if range.end > page_count {
        return Err(bad(format!(
            "PDF page range exceeds the {page_count}-page revision"
        )));
    }
    Ok(Some(range))
}

fn download_filename_with_range(
    name: Option<&str>,
    id: &str,
    format: &str,
    revision: u64,
    range: Option<PdfPageRange>,
) -> String {
    let filename = download_filename(name, id, format, revision);
    let Some(range) = range else { return filename };
    let stem = filename.strip_suffix(".pdf").unwrap_or(&filename);
    format!("{stem}-pages-{}-{}.pdf", range.start, range.end)
}

fn download_filename(name: Option<&str>, id: &str, format: &str, revision: u64) -> String {
    let Some(name) = name.filter(|name| !name.trim().is_empty()) else {
        return format!("{id}-r{revision}.{format}");
    };
    let name = name.trim();
    let stem = name.rsplit_once('.').map_or(name, |(stem, extension)| {
        if matches!(
            extension.to_ascii_lowercase().as_str(),
            "docx"
                | "xlsx"
                | "pptx"
                | "pdf"
                | "html"
                | "htm"
                | "md"
                | "markdown"
                | "txt"
                | "hcd"
                | "png"
                | "jpg"
                | "jpeg"
                | "webp"
        ) {
            stem
        } else {
            name
        }
    });
    let mut safe = String::new();
    for character in stem.chars() {
        let character = if character.is_control() || "<>:\"/\\|?*".contains(character) {
            '_'
        } else {
            character
        };
        if safe.len() + character.len_utf8() > 200 {
            break;
        }
        safe.push(character);
    }
    let stem = safe.trim_matches(|character: char| character.is_whitespace() || character == '.');
    format!(
        "{}.{format}",
        if stem.is_empty() { "document" } else { stem }
    )
}

fn download_disposition(filename: &str, format: &str, inline: bool) -> String {
    let encoded: String = filename
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                char::from(byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect();
    let disposition = if inline { "inline" } else { "attachment" };
    format!("{disposition}; filename=\"document.{format}\"; filename*=UTF-8''{encoded}")
}

const MAX_EXPORT_BYTES: usize = 256 * 1024 * 1024;
const MAX_DOWNLOAD_CACHE_BYTES: usize = 512 * 1024 * 1024;

#[derive(Clone)]
pub(super) struct DownloadTicket {
    pub(super) format: String,
    pub(super) integration_session: Option<String>,
    pub(super) revision: u64,
    filename: String,
    artifact: Arc<tempfile::NamedTempFile>,
    size: usize,
    expires_at: Instant,
}

pub(super) async fn prepare_download(
    State(state): State<ServerState>,
    Path((id, format)): Path<(String, String)>,
    Query(mut query): Query<ExportQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let actor = claims(&state, &headers, &id)?;
    query.revision = Some(
        query
            .revision
            .unwrap_or(open(&state, &id)?.manifest().map_err(hcd_error)?.revision),
    );
    admin::track_export(
        &state,
        &id,
        &format,
        query.revision,
        &actor,
        prepare_download_untracked(
            State(state.clone()),
            Path((id.clone(), format.clone())),
            Query(query),
            headers,
        ),
    )
    .await
}

async fn prepare_download_untracked(
    State(state): State<ServerState>,
    Path((id, format)): Path<(String, String)>,
    Query(query): Query<ExportQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let _permit = state.export_jobs.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "export workers are busy; retry shortly".into(),
        )
    })?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    let revision = query.revision.unwrap_or(head.revision);
    let range = checked_pdf_range(&bundle, &head, &format, &query)?;
    let filename =
        download_filename_with_range(query.filename.as_deref(), &id, &format, revision, range);
    // Generate now, so a ready link always refers to a materialized immutable file.
    let response = tokio::time::timeout(
        Duration::from_secs(90),
        export_document_inner(
            state.clone(),
            id.clone(),
            format.clone(),
            ExportQuery {
                revision: Some(revision),
                ..query
            },
        ),
    )
    .await
    .map_err(|_| ApiError(StatusCode::GATEWAY_TIMEOUT, "export timed out".into()))??;
    let bytes = axum::body::to_bytes(response.into_body(), MAX_EXPORT_BYTES)
        .await
        .map_err(internal)?;
    let artifact = tempfile::NamedTempFile::new().map_err(internal)?;
    tokio::fs::write(artifact.path(), &bytes)
        .await
        .map_err(internal)?;
    let size = bytes.len();
    let ticket = uuid::Uuid::new_v4().to_string();
    let mut downloads = state.downloads.lock().await;
    downloads.retain(|_, item| item.expires_at > Instant::now());
    if downloads.len() >= 64
        || downloads.values().map(|item| item.size).sum::<usize>() + size > MAX_DOWNLOAD_CACHE_BYTES
    {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "download cache is full; retry after existing links expire".into(),
        ));
    }
    downloads.insert(
        ticket.clone(),
        DownloadTicket {
            format: format.clone(),
            integration_session: claims(&state, &headers, &id)?.integration_session,
            revision,
            filename: filename.clone(),
            artifact: Arc::new(artifact),
            size,
            expires_at: Instant::now() + Duration::from_secs(300),
        },
    );
    Ok(Json(json!({ "url": format!("/v1/downloads/{ticket}"),
        "filename": filename, "revision": revision, "bytes": size })))
}

pub(super) async fn download_ticket(
    State(state): State<ServerState>,
    Path(ticket): Path<String>,
) -> Result<Response, ApiError> {
    serve_ticket(&state, &ticket, false).await
}

pub(super) async fn preview_download_ticket(
    State(state): State<ServerState>,
    Path(ticket): Path<String>,
) -> Result<Response, ApiError> {
    serve_ticket(&state, &ticket, true).await
}

async fn serve_ticket(
    state: &ServerState,
    ticket: &str,
    inline: bool,
) -> Result<Response, ApiError> {
    let mut downloads = state.downloads.lock().await;
    if downloads
        .get(ticket)
        .is_some_and(|item| item.expires_at <= Instant::now())
    {
        downloads.remove(ticket);
        return Err(ApiError(StatusCode::GONE, "download link expired".into()));
    }
    let download = downloads
        .get(ticket)
        .cloned()
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "download link not found".into()))?;
    drop(downloads);
    if inline && download.format != "pdf" {
        return Err(bad("inline preview supports only PDF downloads"));
    }
    let bytes = tokio::fs::read(download.artifact.path())
        .await
        .map_err(internal)?;
    export_response(&download.filename, &download.format, bytes, inline)
}

pub(super) async fn export_document(
    State(state): State<ServerState>,
    Path((id, format)): Path<(String, String)>,
    Query(mut query): Query<ExportQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let actor = claims(&state, &headers, &id)?;
    query.revision = Some(
        query
            .revision
            .unwrap_or(open(&state, &id)?.manifest().map_err(hcd_error)?.revision),
    );
    admin::track_export(
        &state,
        &id,
        &format,
        query.revision,
        &actor,
        export_document_untracked(
            State(state.clone()),
            Path((id.clone(), format.clone())),
            Query(query),
            headers,
        ),
    )
    .await
}

async fn export_document_untracked(
    State(state): State<ServerState>,
    Path((id, format)): Path<(String, String)>,
    Query(query): Query<ExportQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let _permit = state.export_jobs.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "export workers are busy; retry shortly".into(),
        )
    })?;
    tokio::time::timeout(
        Duration::from_secs(90),
        export_document_inner(state, id, format, query),
    )
    .await
    .map_err(|_| ApiError(StatusCode::GATEWAY_TIMEOUT, "export timed out".into()))?
}

async fn export_document_inner(
    state: ServerState,
    id: String,
    format: String,
    query: ExportQuery,
) -> Result<Response, ApiError> {
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    let requested = query.revision.unwrap_or(head.revision);
    let range = checked_pdf_range(&bundle, &head, &format, &query)?;
    let filename =
        download_filename_with_range(query.filename.as_deref(), &id, &format, requested, range);
    if query.sheet.is_some() && !matches!(format.as_str(), "csv" | "tsv") {
        return Err(bad("sheet requires CSV or TSV output"));
    }
    if requested > head.revision {
        return Err(bad("revision ahead of head"));
    }
    if format == "hcd" && requested != head.revision {
        return Err(bad(
            "portable HCD includes history through the current revision",
        ));
    }
    if head.source.format == "excalidraw" && format == "excalidraw" {
        let scene = hcd_core::canvas::read_scene(&bundle, Some(requested)).map_err(hcd_error)?;
        return export_response(
            &filename,
            &format,
            serde_json::to_vec(&scene).map_err(internal)?,
            false,
        );
    }
    if hcd_formats::images::is_image_format(&head.source.format)
        && hcd_formats::images::is_image_format(&format)
    {
        let output = tempfile::Builder::new()
            .suffix(&format!(".{format}"))
            .tempfile()
            .map_err(internal)?;
        let path = output.path().to_path_buf();
        let options = hcd_formats::ExportOptions {
            revision: Some(requested),
            fidelity_report: None,
        };
        tokio::task::spawn_blocking(move || {
            hcd_formats::images::export_image(&bundle, &path, &options)
        })
        .await
        .map_err(internal)?
        .map_err(hcd_error)?;
        let bytes = tokio::fs::read(output.path()).await.map_err(internal)?;
        return export_response(&filename, &format, bytes, false);
    }
    if !office_engine::registry::document_export_formats(true).contains(&format.as_str()) {
        return Err(bad("unsupported export format"));
    }
    let plan_state = state.clone();
    let plan_id = id.clone();
    let plan = tokio::task::spawn_blocking(move || {
        build_capabilities_with_range(&plan_state, &plan_id, Some(requested), range)
    })
    .await
    .map_err(internal)??;
    let mode = plan
        .formats
        .iter()
        .find(|item| item.format == format)
        .and_then(|item| {
            item.modes.iter().find(|mode| {
                query
                    .source
                    .map_or(mode.id == item.recommended_mode, |source| {
                        mode.source == source
                    })
            })
        })
        .ok_or_else(|| bad("source-backed export requires a matching source and target format"))?;
    if !mode.available {
        return Err(bad(mode
            .reason
            .clone()
            .unwrap_or_else(|| "export mode is unavailable".into())));
    }
    let bytes = if format == "hcd" {
        let temp = tempfile::tempdir().map_err(internal)?;
        let output = temp.path().join("document.hcd");
        let bundle_path = bundle.root().to_path_buf();
        let archive_path = output.clone();
        tokio::task::spawn_blocking(move || {
            let snapshot = Bundle::open(bundle_path)?;
            hcd_core::pack_archive(&snapshot, archive_path)
        })
        .await
        .map_err(internal)?
        .map_err(bad)?;
        if bundle.manifest().map_err(internal)?.revision != requested {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "document changed while packaging HCD; prepare the current revision again".into(),
            ));
        }
        if tokio::fs::metadata(&output).await.map_err(internal)?.len() > 256 * 1024 * 1024 {
            return Err(bad("HCD archive exceeds 256 MiB HTTP limit"));
        }
        tokio::fs::read(output).await.map_err(internal)?
    } else if format == "html" {
        let mut output = Vec::new();
        let theme_stylesheet =
            hcd_core::theme_presentation_css(&state.catalog, &bundle, Some(requested))
                .map_err(hcd_error)?;
        office_engine::render_hcd_html(
            &bundle,
            &hcd_core::HtmlPresentationOptions {
                revision: Some(requested),
                max_output_bytes: 256 * 1024 * 1024,
                theme_stylesheet,
                ..Default::default()
            },
            &mut output,
        )
        .map_err(bad)?;
        output
    } else {
        let temp = tempfile::tempdir().map_err(internal)?;
        let output = temp.path().join(format!("export.{format}"));
        let mut command = tokio::process::Command::new(std::env::current_exe().map_err(internal)?);
        command.kill_on_drop(true);
        command
            .arg("hdoc")
            .arg("export")
            .arg(bundle.root())
            .arg("--output")
            .arg(&output)
            .arg("--revision")
            .arg(requested.to_string())
            .arg("--catalog")
            .arg(state.catalog.root());
        if mode.source {
            let source = state
                .root
                .join("sources")
                .join(format!("{id}.{}", head.source.format));
            if !source.is_file() {
                return Err(bad("immutable source is unavailable"));
            }
            command.arg("--source").arg(source);
        }
        if let Some(range) = range {
            command
                .arg("--pdf-pages")
                .arg(format!("{}-{}", range.start, range.end));
        }
        if let Some(sheet) = &query.sheet {
            command.arg("--sheet").arg(sheet);
        }
        let result = command.output().await.map_err(internal)?;
        if !result.status.success() {
            return Err(bad(format!(
                "export failed: {}",
                String::from_utf8_lossy(&result.stderr)
            )));
        }
        let metadata = tokio::fs::metadata(&output).await.map_err(internal)?;
        if metadata.len() > 256 * 1024 * 1024 {
            return Err(bad("export exceeds 256 MiB HTTP limit"));
        }
        tokio::fs::read(output).await.map_err(internal)?
    };
    export_response(&filename, &format, bytes, false)
}

fn export_response(
    filename: &str,
    format: &str,
    bytes: Vec<u8>,
    inline: bool,
) -> Result<Response, ApiError> {
    let mime = match format {
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pdf" => "application/pdf",
        "csv" => "text/csv; charset=utf-8",
        "tsv" => "text/tab-separated-values; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "hcd" => "application/zip",
        "html" => "text/html; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        _ => "text/plain; charset=utf-8",
    };
    let mut response = Response::new(Body::from(bytes));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, mime.parse().map_err(internal)?);
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        download_disposition(filename, format, inline)
            .parse()
            .map_err(internal)?,
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().map_err(internal)?);
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        "no-referrer".parse().map_err(internal)?,
    );
    Ok(response)
}

#[cfg(test)]
mod download_name_tests {
    use super::*;

    #[test]
    fn names_keep_the_document_title_and_use_the_selected_format() {
        assert_eq!(
            download_filename(Some("170kV采购合同.docx"), "internal-id", "docx", 8),
            "170kV采购合同.docx"
        );
        assert_eq!(
            download_filename(Some("合同 #1.DOCX"), "internal-id", "pdf", 8),
            "合同 #1.pdf"
        );
        assert_eq!(
            download_filename(Some("方案.2026"), "internal-id", "xlsx", 8),
            "方案.2026.xlsx"
        );
        assert_eq!(
            download_filename(None, "document-id", "txt", 8),
            "document-id-r8.txt"
        );
        let unsafe_name = download_filename(Some("../\"合同\r\nX-Test: bad.docx"), "id", "docx", 0);
        assert!(!unsafe_name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)));
        let long = download_filename(Some(&"文".repeat(500)), "id", "docx", 0);
        assert!(long.len() <= 205);
        assert!(long.ends_with(".docx"));
    }

    #[test]
    fn download_headers_carry_a_safe_ascii_fallback_and_the_exact_utf8_name() {
        assert_eq!(download_disposition("合同 #1.docx", "docx", false), "attachment; filename=\"document.docx\"; filename*=UTF-8''%E5%90%88%E5%90%8C%20%231.docx");
        assert!(download_disposition("合同.pdf", "pdf", true).starts_with("inline;"));
    }
}
