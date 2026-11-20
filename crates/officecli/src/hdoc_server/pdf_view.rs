use super::*;

#[derive(Deserialize)]
pub(super) struct RasterQuery {
    dpi: u16,
}

pub(super) async fn ocr_pages(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    tokio::task::spawn_blocking(move || {
        let manifest = bundle.manifest().map_err(hcd_error)?;
        let pages =
            hcd_core::pdf_ocr::pdf_ocr_page_status(&bundle, &manifest).map_err(hcd_error)?;
        Ok(Json(
            json!({ "revision": manifest.revision, "pages": pages }),
        ))
    })
    .await
    .map_err(internal)?
}

pub(super) async fn render(
    State(state): State<ServerState>,
    Path((id, page)): Path<(String, u32)>,
    Query(query): Query<RasterQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    if page == 0 || !matches!(query.dpi, 192 | 288 | 384) {
        return Err(bad("invalid PDF render page or density"));
    }
    let bundle = open(&state, &id)?;
    let source = state.root.join("sources").join(format!("{id}.pdf"));
    // Rendering is bounded and has its own concurrency limit. A dropped
    // HTTP connection leaves the slot with the worker until rendering ends.
    static SLOTS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    let slot = SLOTS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
        .acquire_owned()
        .await
        .map_err(internal)?;
    let png = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        let manifest = bundle.manifest().map_err(hcd_error)?;
        if manifest.source.format != "pdf" || !source.is_file() {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                "source PDF is unavailable".into(),
            ));
        }
        let layout = hcd_core::pdf_page_layout(&bundle, &manifest).map_err(hcd_error)?;
        if !layout.is_empty() && !layout.iter().any(|entry| entry.source_page == Some(page)) {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                "PDF page is outside this revision".into(),
            ));
        }
        hcd_formats::render_pdf_raster(&source, &manifest.source.sha256, page, query.dpi)
            .map_err(hcd_error)
    })
    .await
    .map_err(internal)??;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "private, no-store"),
        ],
        png,
    )
        .into_response())
}
