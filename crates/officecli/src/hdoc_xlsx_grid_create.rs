//! Authenticated native XLSX cell creation and exact-attempt receipt lookup.
use super::*;
use hcd_core::{GridCreateRequest, RevisionRecord};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InspectRequest {
    expected_revision: u64,
    source_sha256: String,
    cells: Vec<InspectCell>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InspectCell {
    sheet_id: String,
    row: u32,
    column: u32,
}

fn address(row: u32, mut column: u32) -> Result<String, ApiError> {
    if !(1..=1_048_576).contains(&row) || !(1..=16_384).contains(&column) {
        return Err(bad("invalid XLSX cell coordinates"));
    }
    let mut letters = Vec::new();
    while column > 0 {
        column -= 1;
        letters.push((b'A' + (column % 26) as u8) as char);
        column /= 26;
    }
    Ok(format!(
        "{}{row}",
        letters.into_iter().rev().collect::<String>()
    ))
}

fn source_error(error: HcdError) -> ApiError {
    match error {
        HcdError::InvalidPatch(reason) if reason == "XLSX_CELL_ALREADY_MAPPED" => {
            ApiError(StatusCode::CONFLICT, reason)
        }
        HcdError::InvalidPatch(reason) if reason.starts_with("XLSX_FORMULA_READ_ONLY") => ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "XLSX_FORMULA_READ_ONLY".into(),
        ),
        HcdError::InvalidPatch(reason) if reason.starts_with("XLSX_MERGED_CELL_READ_ONLY") => {
            ApiError(
                StatusCode::UNPROCESSABLE_ENTITY,
                "XLSX_MERGED_CELL_READ_ONLY".into(),
            )
        }
        HcdError::InvalidPatch(reason)
            if matches!(
                reason.as_str(),
                "XLSX_SOURCE_CHANGED" | "XLSX_SHEET_PROTECTED"
            ) =>
        {
            ApiError(StatusCode::UNPROCESSABLE_ENTITY, reason)
        }
        HcdError::Unsupported(reason) if reason == "XLSX_VIRTUAL_MERGE_ANCHOR_UNSUPPORTED" => {
            ApiError(StatusCode::UNPROCESSABLE_ENTITY, reason)
        }
        other => hcd_error(other),
    }
}

/// Read-only comparison of already mapped cells at a pinned head. An absent
/// mapping is deliberately not called blank: it may exist in the source XLSX.
pub(super) async fn compare(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<InspectRequest>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    if request.cells.is_empty() || request.cells.len() > 100 {
        return Err(bad("invalid grid comparison size"));
    }
    let mut targets = std::collections::HashMap::new();
    for (index, cell) in request.cells.iter().enumerate() {
        let addr = address(cell.row, cell.column)?;
        if targets
            .insert((cell.sheet_id.clone(), addr), index)
            .is_some()
        {
            return Err(bad("duplicate grid comparison target"));
        }
    }
    let bundle = open(&state, &id)?;
    let manifest = bundle.manifest().map_err(hcd_error)?;
    if manifest.source.format != "xlsx"
        || manifest.revision != request.expected_revision
        || manifest.source.sha256 != request.source_sha256
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "XLSX_GRID_HEAD_CHANGED".into(),
        ));
    }
    let result = tokio::task::spawn_blocking(move || -> Result<Value, ApiError> {
        let mut results = vec![Value::Null; request.cells.len()];
        for page in 0..manifest.index_page_count {
            for chunk in bundle.read_index_page(&manifest, page).map_err(hcd_error)?.chunks {
                let Some(grid) = chunk.grid.as_ref() else { continue };
                if grid.kind != hcd_core::GridChunkKind::Cells || !request.cells.iter().any(|cell| cell.sheet_id == grid.sheet_id) { continue; }
                let map = bundle.read_map_verified(&chunk).map_err(hcd_error)?;
                let mut relevant = Vec::new();
                for entry in map.entries {
                    let Some(addr) = entry.source.paragraph_id.as_ref() else { continue };
                    let Some(index) = targets.get(&(grid.sheet_id.clone(), addr.clone())).copied() else { continue };
                    let sheet = hcd_core::stable_node_id(&[&id, &entry.source.part, "worksheet"]).replacen("n_", "s_", 1);
                    if entry.source.node_kind != "cell" || sheet != grid.sheet_id || !results[index].is_null() { return Err(internal("invalid grid comparison mapping")); }
                    relevant.push((index, entry));
                }
                if relevant.is_empty() { continue; }
                let html = bundle.read_chunk_verified(&chunk).map_err(hcd_error)?;
                let texts = hcd_core::extract_html_text_nodes(&html).map_err(hcd_error)?;
                for (index, entry) in relevant {
                    let text = texts.get(&entry.node_id).ok_or_else(|| internal("missing grid comparison text"))?;
                    if hash_bytes(text.as_bytes()) != entry.node_hash || !results[index].is_null() { return Err(internal("invalid grid comparison text")); }
                    let mut chars = text.chars(); let excerpt: String = chars.by_ref().take(1000).collect();
                    results[index] = json!({"nodeId":entry.node_id,"text":excerpt,"truncated":chars.next().is_some(),"editable":entry.source.editable});
                }
            }
        }
        Ok(json!({"documentId":id,"revision":manifest.revision,"rootHash":manifest.root_hash,"sourceSha256":manifest.source.sha256,"cells":request.cells.iter().zip(results).map(|(cell,mapped)| json!({"sheetId":cell.sheet_id,"row":cell.row,"column":cell.column,"mapped":mapped})).collect::<Vec<_>>() }))
    }).await.map_err(internal)??;
    Ok(Json(result))
}

/// A version-bound observation, not a reservation. The create transaction
/// independently repeats every check under its own write lock.
pub(super) async fn inspect(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<InspectRequest>,
) -> Result<Json<Value>, ApiError> {
    let identity = authorize_claims(&state, &headers, &id)?;
    if !author_actor(&identity, &[]).contains_key("userId") {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "grid inspection requires a stable user identity".into(),
        ));
    }
    if state.remote.is_some() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "XLSX_GRID_REMOTE_UNSUPPORTED".into(),
        ));
    }
    if request.cells.is_empty() || request.cells.len() > 4000 {
        return Err(bad("invalid grid inspection size"));
    }
    let addresses = request
        .cells
        .iter()
        .map(|cell| address(cell.row, cell.column))
        .collect::<Result<Vec<_>, _>>()?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(hcd_error)?;
    if head.revision != request.expected_revision || head.source.sha256 != request.source_sha256 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "XLSX_GRID_HEAD_CHANGED".into(),
        ));
    }
    let source = state.root.join("sources").join(format!("{id}.xlsx"));
    if !source.is_file() {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "XLSX_SOURCE_REQUIRED".into(),
        ));
    }
    let observations = tokio::task::spawn_blocking(move || {
        let targets: Vec<_> = request
            .cells
            .iter()
            .zip(&addresses)
            .map(|(cell, address)| (cell.sheet_id.as_str(), address.as_str()))
            .collect();
        hcd_formats::inspect_xlsx_virtual_blanks(&bundle, &source, &targets)
    })
    .await
    .map_err(internal)?
    .map_err(source_error)?;
    if observations.iter().any(|item| item.merged_anchor) {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "XLSX_VIRTUAL_MERGE_ANCHOR_UNSUPPORTED".into(),
        ));
    }
    let first = observations
        .first()
        .ok_or_else(|| internal("missing grid inspection"))?;
    // A concurrent commit can occur before the source snapshot is taken.
    // Never label the new observation with the caller's older requested head.
    if first.revision != head.revision
        || first.root_hash != head.root_hash
        || first.source_sha256 != head.source.sha256
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "XLSX_GRID_HEAD_CHANGED".into(),
        ));
    }
    Ok(Json(
        json!({"revision":first.revision,"rootHash":first.root_hash,"sourceSha256":first.source_sha256,"cells":observations.iter().map(|item| json!({"sheetId":item.sheet_id,"sheetPart":item.sheet_part,"sheetName":item.sheet_name,"sheetIndex":item.sheet_index,"sheetState":item.sheet_state,"row":item.row,"column":item.column,"address":item.address,"nodeId":item.node_id})).collect::<Vec<_>>()}),
    ))
}

fn prepare(
    mut request: GridCreateRequest,
    id: &str,
    claims: &Claims,
) -> Result<GridCreateRequest, ApiError> {
    if request.document_id != id
        || request.patch_id.trim().is_empty()
        || request.patch_id.len() > 256
    {
        return Err(bad("invalid grid request identity"));
    }
    request.actor = author_actor(claims, &[]);
    if !request.actor.contains_key("userId") {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "grid creation requires a stable user identity".into(),
        ));
    }
    Ok(request)
}

// Reconstruct the server's original attribution before hashing the exact
// attempt. A later display-name change must not hide an existing receipt.
fn find_receipt(
    bundle: &Bundle,
    request: &mut GridCreateRequest,
) -> Result<Option<RevisionRecord>, ApiError> {
    let head = bundle.manifest().map_err(hcd_error)?;
    for revision in 1..=head.revision {
        let record = bundle.revision(revision).map_err(hcd_error)?;
        if record.patch_id.as_deref() != Some(request.patch_id.as_str()) {
            continue;
        }
        if record.author_id.as_deref() != request.actor.get("userId").map(String::as_str) {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "grid receipt belongs to another author".into(),
            ));
        }
        request.actor.clear();
        if let Some(author) = &record.author_id {
            request.actor.insert("userId".into(), author.clone());
        }
        if let Some(name) = &record.author_name {
            request.actor.insert("displayName".into(), name.clone());
        }
        let hash = hash_bytes(&serde_json::to_vec(&request).map_err(internal)?);
        if record.patch_hash.as_deref() != Some(hash.as_str()) {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "grid identity was used with a different payload".into(),
            ));
        }
        return Ok(Some(record));
    }
    Ok(None)
}

pub(super) async fn receipt(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<GridCreateRequest>,
) -> Result<Json<Value>, ApiError> {
    let identity = claims(&state, &headers, &id)?;
    let mut request = prepare(request, &id, &identity)?;
    let bundle = open(&state, &id)?;
    // Observe an already advanced native head before searching its immutable
    // history. An in-flight request based on an older revision can no longer
    // commit; a missing receipt after this point is therefore definitive.
    let observed = bundle.manifest().map_err(hcd_error)?.revision;
    match find_receipt(&bundle, &mut request)? {
        Some(record) => Ok(Json(
            json!({"status":"committed", "revision":record.revision, "baseRevision":record.patch_base_revision, "patchId":request.patch_id, "rootHash":record.root_hash, "dirtyNodeIds":record.dirty_node_ids}),
        )),
        None if state.remote.is_none() && observed > request.base_revision => Ok(Json(
            json!({"status":"superseded", "patchId":request.patch_id, "baseRevision":request.base_revision, "observedRevision":observed}),
        )),
        None => Ok(Json(
            json!({"status":"missing", "patchId":request.patch_id}),
        )),
    }
}

pub(super) async fn create(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<GridCreateRequest>,
) -> Result<Json<Value>, ApiError> {
    let identity = authorize_claims(&state, &headers, &id)?;
    let mut request = prepare(request, &id, &identity)?;
    if state.remote.is_some() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "XLSX_GRID_REMOTE_UNSUPPORTED".into(),
        ));
    }
    let bundle = open(&state, &id)?;
    let replay = find_receipt(&bundle, &mut request)?.is_some();
    let previous = request.base_revision;
    let source = state.root.join("sources").join(format!("{id}.xlsx"));
    if !replay && !source.is_file() {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "XLSX_SOURCE_REQUIRED".into(),
        ));
    }
    let checked_bundle = bundle.clone();
    let result = tokio::task::spawn_blocking(move || {
        hcd_formats::create_xlsx_virtual_cells(&checked_bundle, &source, &request)
    })
    .await
    .map_err(internal)?
    .map_err(source_error)?;
    if !result.idempotent_replay {
        publish_mutation(&state, &id, &bundle, previous).await?;
    }
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}
