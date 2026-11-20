use super::*;

pub(super) async fn read(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let source = state.root.join("sources").join(format!("{id}.docx"));
    let review = tokio::task::spawn_blocking(move || {
        hcd_formats::read_word_review(&bundle, &source, query.revision)
    })
    .await
    .map_err(internal)?
    .map_err(hcd_error)?;
    Ok(Json(serde_json::to_value(review).map_err(internal)?))
}

pub(super) async fn edit(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<hcd_formats::WordReviewEdit>,
) -> Result<Json<hcd_core::ApplyResult>, ApiError> {
    let actor = write_claims(&state, &headers, &id)?;
    if uuid::Uuid::parse_str(&request.patch_id).is_err() {
        return Err(bad("review requires a UUID patchId"));
    }
    let _lock = state.collaboration_lock.lock().await;
    require_clean_collaboration(&state, &id, &headers).await?;
    agent_team::check_write(
        &state,
        &id,
        &actor,
        &headers,
        &json!([{"op": "docx.review"}]),
    )
    .await?;
    let bundle = open(&state, &id)?;
    let root = bundle.root().to_path_buf();
    let source = state.root.join("sources").join(format!("{id}.docx"));
    let user = actor.sub.clone().unwrap_or_else(|| "editor".into());
    let author = actor
        .name
        .clone()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| user.clone());
    let base_revision = request.base_revision;
    let changes_body = request.changes_body();
    let result = tokio::task::spawn_blocking(move || {
        hcd_formats::edit_word_review(&Bundle::open(root)?, &source, &request, &user, &author)
    })
    .await
    .map_err(internal)?
    .map_err(hcd_error)?;
    if !result.idempotent_replay {
        stamp_revision_author(&bundle, result.revision, &actor)?;
        publish_mutation(&state, &id, &bundle, base_revision).await?;
        if changes_body {
            reset_collaboration_locked(&state, &id).await?;
        }
    }
    Ok(Json(result))
}
