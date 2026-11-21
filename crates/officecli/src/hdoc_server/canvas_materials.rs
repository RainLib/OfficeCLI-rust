use super::*;
use canvas_core::materials::{browse_materials, plan_material, MaterialQuery};

pub(super) async fn browse(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<MaterialQuery>,
) -> Result<Json<Value>, ApiError> {
    canvas::access(&state, &id, &headers, false).await?;
    browse_materials(&query).map(Json).map_err(bad)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Plan {
    material_id: String,
    patch_id: String,
    expected_revision: u64,
    region: Option<canvas_core::Region>,
}
pub(super) async fn plan(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<Plan>,
) -> Result<Json<Value>, ApiError> {
    canvas::access(&state, &id, &headers, true).await?;
    let _lock = state.collaboration_lock.lock().await;
    let bundle = open(&state, &id)?;
    let revision = bundle.manifest().map_err(hcd_error)?.revision;
    if revision != request.expected_revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "画布已更新，请重试。".into(),
        ));
    }
    let scene = hcd_core::canvas::read_scene(&bundle, None).map_err(hcd_error)?;
    let batch = plan_material(
        &scene,
        &id,
        revision,
        &request.patch_id,
        &request.material_id,
        request.region,
    )
    .map_err(bad)?;
    Ok(Json(
        json!({"batch":batch,"collaborationEpoch":collaboration_epoch(&state,&id).await?}),
    ))
}
