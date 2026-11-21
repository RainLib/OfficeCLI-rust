//! Office metadata follows the same revision, draft and authorization fences as text.
use super::*;
fn source(state: &ServerState, id: &str, bundle: &Bundle) -> Result<std::path::PathBuf, ApiError> {
    let format = bundle.manifest().map_err(hcd_error)?.source.format;
    if !matches!(format.as_str(), "docx" | "xlsx" | "pptx") {
        return Err(bad("Office settings require DOCX, XLSX or PPTX"));
    }
    Ok(state.root.join("sources").join(format!("{id}.{format}")))
}
pub(super) async fn read(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let source = source(&state, &id, &bundle)?;
    let snapshot = tokio::task::spawn_blocking(move || {
        hcd_formats::read_office_features(&bundle, &source, query.revision)
    })
    .await
    .map_err(internal)?
    .map_err(hcd_error)?;
    Ok(Json(serde_json::to_value(snapshot).map_err(internal)?))
}
pub(super) async fn edit(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<hcd_core::office_features::OfficeEdit>,
) -> Result<Json<hcd_core::ApplyResult>, ApiError> {
    let actor = write_claims(&state, &headers, &id)?;
    if uuid::Uuid::parse_str(&request.patch_id).is_err() {
        return Err(bad("Office edit requires a UUID patchId"));
    }
    let _lock = state.collaboration_lock.lock().await;
    require_clean_collaboration(&state, &id, &headers).await?;
    // Whole-document metadata must not evade another worker's resource lease.
    agent_team::check_write(
        &state,
        &id,
        &actor,
        &headers,
        &json!([{"op":"office.features"}]),
    )
    .await?;
    let bundle = open(&state, &id)?;
    let source = source(&state, &id, &bundle)?;
    let root = bundle.root().to_path_buf();
    let base = request.base_revision;
    let result = tokio::task::spawn_blocking(move || {
        hcd_formats::edit_office_features(&Bundle::open(root)?, &source, &request)
    })
    .await
    .map_err(internal)?
    .map_err(hcd_error)?;
    if !result.idempotent_replay {
        stamp_revision_author(&bundle, result.revision, &actor)?;
        publish_mutation(&state, &id, &bundle, base).await?;
    }
    Ok(Json(result))
}
