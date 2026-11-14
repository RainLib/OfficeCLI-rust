use super::*;

const FORMATS: [&str; 8] = ["docx", "xlsx", "pptx", "pdf", "html", "md", "txt", "hcd"];

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
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Json<ExportCapabilities>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let plan = tokio::task::spawn_blocking(move || build_capabilities(&state, &id, query.revision))
        .await
        .map_err(internal)??;
    Ok(Json(plan))
}

fn build_capabilities(
    state: &ServerState,
    id: &str,
    revision: Option<u64>,
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
        hcd_formats::validate_source_export(&bundle, &source_path, Some(revision)).map_err(
            |error| {
                let code = match &error {
                    HcdError::SourceMismatch(_) => "source_mismatch",
                    HcdError::Unsupported(_) => "source_revision_unsupported",
                    _ => "source_unreadable",
                };
                (code, error.to_string())
            },
        )
    };
    let mut formats = Vec::new();
    for format in FORMATS {
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
                if source_format == "pdf" && manifest.profile == "fixed-layout" {
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
        if format == "hcd" && revision != head.revision {
            modes[0].disable(
                "history_archive_unavailable",
                "portable HCD includes history through the current revision".into(),
            );
        }
        if format == source_format && matches!(format, "docx" | "xlsx" | "pptx" | "pdf") {
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
        let recommended_mode = modes
            .iter()
            .find(|mode| mode.id == recommended && mode.available)
            .or_else(|| modes.iter().find(|mode| mode.available))
            .unwrap_or(&modes[0])
            .id
            .clone();
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

#[derive(Clone, Copy, Deserialize)]
pub(super) struct ExportQuery {
    revision: Option<u64>,
    source: Option<bool>,
}

const MAX_EXPORT_BYTES: usize = 256 * 1024 * 1024;
const MAX_DOWNLOAD_CACHE_BYTES: usize = 512 * 1024 * 1024;

#[derive(Clone)]
pub(super) struct DownloadTicket {
    document_id: String,
    format: String,
    revision: u64,
    artifact: Arc<tempfile::NamedTempFile>,
    size: usize,
    expires_at: Instant,
}

pub(super) async fn prepare_download(
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
    let head = open(&state, &id)?.manifest().map_err(internal)?;
    let revision = query.revision.unwrap_or(head.revision);
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
            document_id: id.clone(),
            format: format.clone(),
            revision,
            artifact: Arc::new(artifact),
            size,
            expires_at: Instant::now() + Duration::from_secs(300),
        },
    );
    Ok(Json(json!({ "url": format!("/v1/downloads/{ticket}"),
        "filename": format!("{id}-r{revision}.{format}"), "revision": revision, "bytes": size })))
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
    export_response(
        &download.document_id,
        &download.format,
        download.revision,
        bytes,
        inline,
    )
}

pub(super) async fn export_document(
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
    if requested > head.revision {
        return Err(bad("revision ahead of head"));
    }
    if format == "hcd" && requested != head.revision {
        return Err(bad(
            "portable HCD includes history through the current revision",
        ));
    }
    if !matches!(
        format.as_str(),
        "docx" | "xlsx" | "pptx" | "pdf" | "html" | "md" | "txt" | "hcd"
    ) {
        return Err(bad("unsupported export format"));
    }
    let plan_state = state.clone();
    let plan_id = id.clone();
    let plan = tokio::task::spawn_blocking(move || {
        build_capabilities(&plan_state, &plan_id, Some(requested))
    })
    .await
    .map_err(internal)??;
    let mode = plan
        .formats
        .iter()
        .find(|item| item.format == format)
        .and_then(|item| {
            item.modes
                .iter()
                .find(|mode| mode.source == query.source.unwrap_or(false))
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
        crate::commands::hdoc_html::render(
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
        if query.source.unwrap_or(false) {
            let source = state
                .root
                .join("sources")
                .join(format!("{id}.{}", head.source.format));
            if !source.is_file() {
                return Err(bad("immutable source is unavailable"));
            }
            command.arg("--source").arg(source);
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
    export_response(&id, &format, requested, bytes, false)
}

fn export_response(
    id: &str,
    format: &str,
    revision: u64,
    bytes: Vec<u8>,
    inline: bool,
) -> Result<Response, ApiError> {
    let mime = match format {
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pdf" => "application/pdf",
        "hcd" => "application/zip",
        "html" => "text/html; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        _ => "text/plain; charset=utf-8",
    };
    let mut response = Response::new(Body::from(bytes));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, mime.parse().map_err(internal)?);
    let disposition = if inline { "inline" } else { "attachment" };
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        format!("{disposition}; filename=\"{id}-r{revision}.{format}\"")
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
