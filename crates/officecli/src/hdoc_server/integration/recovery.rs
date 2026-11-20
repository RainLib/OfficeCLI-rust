//! Operations for the application service that owns the managed publishing queue.
use super::*;
use axum::body::{Body, Bytes};
use axum::response::{IntoResponse, Response};
use tokio::io::AsyncReadExt;

const PAGE_SIZE: usize = 40;

#[derive(Deserialize)]
pub(crate) struct PublicationPage {
    before: Option<String>,
}

pub(crate) async fn list(
    State(state): State<ServerState>,
    Query(page): Query<PublicationPage>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    configured(&state)?.service(&headers)?;
    tokio::task::spawn_blocking(move || {
        let integration = configured(&state)?;
        let mut records = Vec::new();
        for id in integration.store.publication_ids().map_err(internal)? {
            if let Some(record) = integration.store.publication(&id)? {
                records.push(record);
            }
        }
        records.sort_unstable_by(|left, right| {
            (right.created_at, &right.publication_id).cmp(&(left.created_at, &left.publication_id))
        });
        let start = if let Some(before) = &page.before {
            records.iter().position(|record| &record.publication_id == before)
                .ok_or_else(|| bad("publication list cursor is invalid"))? + 1
        } else { 0 };
        let end = (start + PAGE_SIZE).min(records.len());
        let items: Vec<_> = records[start..end].iter().map(|record| view(integration, record)).collect::<Result<_, _>>()?;
        Ok(Json(json!({"items":items,"next":(end < records.len()).then(|| &records[end - 1].publication_id)})))
    }).await.map_err(internal)?
}

pub(crate) async fn read(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let integration = configured(&state)?;
    integration.service(&headers)?;
    Ok(Json(view(integration, &get(integration, &id)?)?))
}

pub(crate) async fn reconcile(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let integration = configured(&state)?;
    integration.service(&headers)?;
    let document = get(integration, &id)?.document_id;
    let _guard = integration.lock(&document).await;
    let mut record = get(integration, &id)?;
    let mut mapping = mapping(integration, &record)?;
    let provider_state = publication::reconcile(integration, &mut mapping, &mut record).await?;
    Ok(Json(
        json!({"job":view(integration, &record)?,"providerState":provider_state}),
    ))
}

pub(crate) async fn retry_event(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let integration = configured(&state)?;
    integration.service(&headers)?;
    let document = get(integration, &id)?.document_id;
    let _guard = integration.lock(&document).await;
    let mut record = get(integration, &id)?;
    if record.state != "committed" || record.event.is_none() || record.event_delivered {
        return Err(conflict(
            "only an undelivered committed event can be retried",
        ));
    }
    record.event_dead_letter = false;
    record.event_next_at = 0;
    integration.store.save_publication(&record)?;
    Ok(Json(view(integration, &record)?))
}

pub(crate) async fn artifact(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let integration = configured(&state)?;
    integration.service(&headers)?;
    let record = get(integration, &id)?;
    let output = record
        .intent
        .as_ref()
        .map(|intent| &intent["output"])
        .ok_or_else(|| conflict("this publication has no retained output"))?;
    let length = output["sizeBytes"]
        .as_u64()
        .filter(|length| *length <= MAX_FILE_BYTES)
        .ok_or_else(|| internal("invalid publication output size"))?;
    let path = integration.store.artifact(&record);
    let expected = output["sha256"].as_str().unwrap_or_default().to_owned();
    let mut file = tokio::task::spawn_blocking(move || {
        if !path.is_file()
            || std::fs::metadata(&path).map_err(internal)?.len() != length
            || hash_file(&path).map_err(internal)? != expected
        {
            return Err(conflict(
                "retained output is missing or its checksum differs",
            ));
        }
        std::fs::File::open(path)
            .map(tokio::fs::File::from_std)
            .map_err(internal)
    })
    .await
    .map_err(internal)??;
    let content = async_stream::stream! {
        let mut buffer = vec![0; 64 * 1024];
        loop {
            match file.read(&mut buffer).await {
                Ok(0) => break,
                Ok(count) => yield Ok(Bytes::copy_from_slice(&buffer[..count])),
                Err(error) => { yield Err(error); break; }
            }
        }
    };
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (header::CONTENT_LENGTH, length.to_string()),
            (header::CACHE_CONTROL, "no-store".into()),
        ],
        Body::from_stream(content),
    )
        .into_response())
}

fn get(integration: &Integration, id: &str) -> Result<Publication, ApiError> {
    integration
        .store
        .publication(id)?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "publication not found".into()))
}

fn mapping(integration: &Integration, record: &Publication) -> Result<Mapping, ApiError> {
    integration
        .store
        .mapping(&record.document_id)
        .ok_or_else(|| internal("missing publication mapping"))
}

fn view(integration: &Integration, record: &Publication) -> Result<Value, ApiError> {
    let mapping = mapping(integration, record)?;
    let mut value = publication::public_record(record);
    value["fileId"] = json!(mapping.external_file_id);
    value["actorId"] = json!(record.actor_id);
    value["exportMode"] = json!(record.export_mode);
    value["createdAt"] = json!(record.created_at);
    value["pending"] =
        json!(mapping.pending_publication.as_deref() == Some(&record.publication_id));
    value["hasArtifact"] =
        json!(record.intent.is_some() && integration.store.artifact(record).is_file());
    Ok(value)
}
