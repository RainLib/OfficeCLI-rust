//! Authenticated local HCD core API. Bundles stay private under the configured root.
//! The HTTP surface only returns decoded, verified objects requested by the client.
use crate::commands::hdoc::{HdocIssueTokenCommand, HdocServeCommand, HdocTokenScope};
use crate::hdoc_remote::RemoteStore;
use anyhow::{anyhow, Context, Result};
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use futures::StreamExt;
use hcd_core::{
    apply_patch, apply_structure_patch, editor_projection, hash_file, manifest_at_revision,
    project_editor, restore_revision, search_bundle, BlockPrecondition, Bundle, EditorBlockContent,
    EditorInline, HcdError, PatchBatch, StructureOperation, StructurePatchBatch,
    HCD_PATCH_SCHEMA_VERSION_4, MAX_PATCH_JSON_BYTES,
};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

#[derive(Clone)]
struct ServerState {
    root: PathBuf,
    secret: Arc<Vec<u8>>,
    remote: Option<RemoteStore>,
    collaboration_lock: Arc<Mutex<()>>,
    downloads: Arc<Mutex<HashMap<String, DownloadTicket>>>,
}

#[derive(Clone)]
struct DownloadTicket {
    document_id: String,
    format: String,
    query: ExportQuery,
    expires_at: Instant,
}

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    doc: String,
    scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sub: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    aud: String,
    iat: usize,
    exp: usize,
}

fn load_secret(name: &str) -> Result<Vec<u8>> {
    let secret = std::env::var(name)
        .with_context(|| format!("set {name} before using HCD authorization"))?;
    if secret.len() < 32 {
        return Err(anyhow!("{name} must contain at least 32 bytes"));
    }
    Ok(secret.into_bytes())
}

pub fn issue_token(command: &HdocIssueTokenCommand) -> Result<String> {
    if !(valid_id(&command.document_id)
        || command.document_id == "*" && matches!(command.scope, HdocTokenScope::Upload))
    {
        return Err(anyhow!(
            "document ID must be 1-128 ASCII letters, digits, _ or -"
        ));
    }
    let secret = load_secret(&command.secret_env)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as usize;
    let claims = Claims {
        doc: command.document_id.clone(),
        scope: match command.scope {
            HdocTokenScope::Read => "read",
            HdocTokenScope::Write => "write",
            HdocTokenScope::Upload => "upload",
        }
        .to_string(),
        sub: command.user_id.clone(),
        name: command.display_name.clone(),
        aud: "hcd-core".to_string(),
        iat: now,
        exp: now + command.ttl_seconds as usize,
    };
    Ok(encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(&secret),
    )?)
}

pub async fn serve(command: HdocServeCommand) -> Result<()> {
    let secret = Arc::new(load_secret(&command.secret_env)?);
    std::fs::create_dir_all(&command.root)?;
    let root = command.root.canonicalize()?;
    let database_url = std::env::var(&command.database_url_env).ok();
    let bucket = std::env::var(&command.s3_bucket_env).ok();
    let remote = match (database_url, bucket) {
        (Some(url), Some(bucket)) => {
            let endpoint = std::env::var(&command.s3_endpoint_env).ok();
            let store =
                RemoteStore::connect(&url, &bucket, endpoint.as_deref(), root.clone()).await?;
            store.hydrate_all().await?;
            Some(store)
        }
        (None, None) => None,
        _ => {
            return Err(anyhow!(
                "configure both PostgreSQL and S3 bucket for remote HCD storage"
            ))
        }
    };
    let state = ServerState {
        root,
        secret,
        remote,
        collaboration_lock: Arc::new(Mutex::new(())),
        downloads: Arc::new(Mutex::new(HashMap::new())),
    };
    let router = Router::new()
        .route("/health", get(|| async { Json(json!({"ok": true})) }))
        .route("/v1/documents/{id}", get(manifest))
        .route("/v1/import", post(import_document))
        .route("/v1/jobs/{job_id}", get(job_status))
        .route("/v1/documents/{id}/editor", get(editor))
        .route("/v1/documents/{id}/project", post(project))
        .route("/v1/documents/{id}/patch", post(patch))
        .route("/v1/documents/{id}/node-patch", post(node_patch))
        .route("/v1/documents/{id}/checkpoints", post(checkpoint))
        .route("/v1/documents/{id}/revisions", get(revisions))
        .route("/v1/documents/{id}/revisions/{revision}", get(revision))
        .route("/v1/documents/{id}/restore/{revision}", post(restore))
        .route("/v1/documents/{id}/index/{page}", get(index_page))
        .route("/v1/documents/{id}/chunks/{sequence}", get(chunk))
        .route("/v1/documents/{id}/search", get(search))
        .route("/v1/documents/{id}/assets/{hash}", get(asset))
        .route("/v1/documents/{id}/styles", get(styles))
        .route("/v1/documents/{id}/export/{format}", get(export_document))
        .route(
            "/v1/documents/{id}/downloads/{format}",
            post(prepare_download),
        )
        .route("/v1/downloads/{ticket}", get(download_ticket))
        .route(
            "/v1/downloads/{ticket}/preview",
            get(preview_download_ticket),
        )
        .route("/v1/documents/{id}/auth", get(auth_check))
        .route(
            "/v1/documents/{id}/collaboration/state",
            get(collaboration_get).put(collaboration_put),
        )
        .layer(DefaultBodyLimit::max(MAX_PATCH_JSON_BYTES as usize))
        .with_state(state);
    let address: SocketAddr = command.bind.parse().context("invalid --bind address")?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    eprintln!(
        "HCD core API listening on http://{}",
        listener.local_addr()?
    );
    axum::serve(listener, router).await?;
    Ok(())
}

fn authorize_upload(state: &ServerState, headers: &HeaderMap) -> Result<(), ApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| {
            ApiError(
                StatusCode::UNAUTHORIZED,
                "bearer token required".to_string(),
            )
        })?;
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&["hcd-core"]);
    let claims = decode::<Claims>(token, &DecodingKey::from_secret(&state.secret), &validation)
        .map_err(|_| {
            ApiError(
                StatusCode::UNAUTHORIZED,
                "invalid or expired token".to_string(),
            )
        })?
        .claims;
    if claims.doc != "*" || claims.scope != "upload" {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "upload token required".to_string(),
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
struct ImportQuery {
    filename: String,
}

async fn import_document(
    State(state): State<ServerState>,
    Query(query): Query<ImportQuery>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<Value>, ApiError> {
    authorize_upload(&state, &headers)?;
    let extension = std::path::Path::new(&query.filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "docx" | "html" | "htm" | "md" | "markdown" | "txt" | "pdf" | "pptx" | "xlsx"
    ) {
        return Err(bad("unsupported import extension"));
    }
    let job_id = uuid::Uuid::new_v4().to_string();
    let uploads = state.root.join("uploads");
    tokio::fs::create_dir_all(&uploads)
        .await
        .map_err(internal)?;
    let temporary = uploads.join(format!("{job_id}.{extension}"));
    let mut file = tokio::fs::File::create(&temporary)
        .await
        .map_err(internal)?;
    let mut stream = body.into_data_stream();
    let mut size = 0u64;
    while let Some(item) = stream.next().await {
        let bytes = item.map_err(bad)?;
        size = size
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| bad("upload length overflow"))?;
        if size > 512 * 1024 * 1024 {
            return Err(bad("upload exceeds 512 MiB"));
        }
        file.write_all(&bytes).await.map_err(internal)?;
    }
    file.sync_all().await.map_err(internal)?;
    drop(file);
    if size == 0 {
        return Err(bad("empty upload"));
    }
    let hash = hash_file(&temporary).map_err(internal)?;
    let document_id = format!("doc-{}", &hash[..32]);
    let sources = state.root.join("sources");
    tokio::fs::create_dir_all(&sources)
        .await
        .map_err(internal)?;
    let source = sources.join(format!("{document_id}.{extension}"));
    if !source.exists() {
        tokio::fs::rename(&temporary, &source)
            .await
            .map_err(internal)?;
    } else {
        tokio::fs::remove_file(&temporary).await.map_err(internal)?;
    }
    let destination = state.root.join(format!("{document_id}.hcd"));
    let jobs = state.root.join("jobs");
    tokio::fs::create_dir_all(&jobs).await.map_err(internal)?;
    let job_path = jobs.join(format!("{job_id}.json"));
    if destination.exists() {
        if let Some(remote) = &state.remote {
            remote
                .publish(&document_id, &destination, Some(&source), None)
                .await
                .map_err(internal)?;
        }
        write_job(
            &job_path,
            state.remote.as_ref(),
            &job_id,
            json!({"jobId": job_id, "documentId": document_id, "state": "completed"}),
        )
        .await
        .map_err(internal)?;
        return Ok(Json(
            json!({"jobId": job_id, "documentId": document_id, "state": "completed"}),
        ));
    }
    write_job(
        &job_path,
        state.remote.as_ref(),
        &job_id,
        json!({"jobId": job_id, "documentId": document_id, "state": "queued"}),
    )
    .await
    .map_err(internal)?;
    let job_document_id = document_id.clone();
    let spawned_job_id = job_id.clone();
    let remote = state.remote.clone();
    tokio::spawn(async move {
        let run = async {
            write_job(
                &job_path,
                remote.as_ref(),
                &spawned_job_id,
                json!({"jobId": spawned_job_id, "documentId": job_document_id, "state": "running"}),
            )
            .await?;
            let output = tokio::process::Command::new(std::env::current_exe()?)
                .arg("hdoc")
                .arg("import")
                .arg(&source)
                .arg("--output")
                .arg(&destination)
                .arg("--document-id")
                .arg(&job_document_id)
                .output()
                .await?;
            if !output.status.success() {
                return Err(anyhow!(
                    "import failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            if let Some(remote) = &remote {
                remote
                    .publish(&job_document_id, &destination, Some(&source), None)
                    .await?;
            }
            Result::<()>::Ok(())
        }
        .await;
        let (status, error) = match run {
            Ok(()) => ("completed", None),
            Err(error) => ("failed", Some(error.to_string())),
        };
        let _ = write_job(&job_path, remote.as_ref(), &spawned_job_id,
            json!({"jobId": spawned_job_id, "documentId": job_document_id, "state": status, "error": error})).await;
    });
    Ok(Json(
        json!({"jobId": job_id, "documentId": document_id, "state": "queued"}),
    ))
}

async fn job_status(
    State(state): State<ServerState>,
    Path(job_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize_upload(&state, &headers)?;
    if !valid_id(&job_id) {
        return Err(bad("invalid job ID"));
    }
    if let Some(remote) = &state.remote {
        return remote
            .job_get(&job_id)
            .await
            .map_err(internal)?
            .map(Json)
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "job not found".to_string()));
    }
    let path = state.root.join("jobs").join(format!("{job_id}.json"));
    let bytes = tokio::fs::read(path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError(StatusCode::NOT_FOUND, "job not found".to_string())
        } else {
            internal(error)
        }
    })?;
    Ok(Json(serde_json::from_slice(&bytes).map_err(internal)?))
}

async fn write_job(
    path: &std::path::Path,
    remote: Option<&RemoteStore>,
    job_id: &str,
    payload: Value,
) -> Result<()> {
    tokio::fs::write(path, serde_json::to_vec(&payload)?).await?;
    if let Some(remote) = remote {
        remote.job_set(job_id, &payload).await?;
    }
    Ok(())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[derive(Debug)]
struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}

fn bad(error: impl std::fmt::Display) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, error.to_string())
}

fn hcd_error(error: HcdError) -> ApiError {
    let status = match &error {
        HcdError::RevisionConflict(_) => StatusCode::CONFLICT,
        HcdError::PreconditionFailed(_) => StatusCode::PRECONDITION_FAILED,
        HcdError::NodeNotFound(_) => StatusCode::NOT_FOUND,
        HcdError::ResourceLimit(_) => StatusCode::PAYLOAD_TOO_LARGE,
        HcdError::Unsupported(_) => StatusCode::UNPROCESSABLE_ENTITY,
        HcdError::Io(_) | HcdError::Json(_) | HcdError::InvalidBundle(_) => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
        HcdError::InvalidPatch(_) | HcdError::SourceMismatch(_) => StatusCode::BAD_REQUEST,
    };
    ApiError(status, error.to_string())
}

fn internal(error: impl std::fmt::Display) -> ApiError {
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

fn open(state: &ServerState, id: &str) -> Result<Bundle, ApiError> {
    if !valid_id(id) {
        return Err(bad("invalid document ID"));
    }
    let path = state.root.join(format!("{id}.hcd"));
    let bundle = Bundle::open(path)
        .map_err(|_| ApiError(StatusCode::NOT_FOUND, "document not found".to_string()))?;
    let manifest = bundle.manifest().map_err(internal)?;
    if manifest.document_id != id {
        return Err(internal("bundle document ID does not match its directory"));
    }
    Ok(bundle)
}

fn claims(state: &ServerState, headers: &HeaderMap, id: &str) -> Result<Claims, ApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| {
            ApiError(
                StatusCode::UNAUTHORIZED,
                "bearer token required".to_string(),
            )
        })?;
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&["hcd-core"]);
    let claims = decode::<Claims>(token, &DecodingKey::from_secret(&state.secret), &validation)
        .map_err(|_| {
            ApiError(
                StatusCode::UNAUTHORIZED,
                "invalid or expired token".to_string(),
            )
        })?
        .claims;
    if claims.doc != id || !matches!(claims.scope.as_str(), "read" | "write") {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "token document or scope mismatch".to_string(),
        ));
    }
    Ok(claims)
}

fn authorize(
    state: &ServerState,
    headers: &HeaderMap,
    id: &str,
    write: bool,
) -> Result<(), ApiError> {
    let claims = claims(state, headers, id)?;
    if write && claims.scope != "write" {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "read-only token cannot write".to_string(),
        ));
    }
    Ok(())
}

fn write_claims(state: &ServerState, headers: &HeaderMap, id: &str) -> Result<Claims, ApiError> {
    let actor = claims(state, headers, id)?;
    if actor.scope != "write" {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "read-only token cannot write".to_string(),
        ));
    }
    Ok(actor)
}

fn stamp_revision_author(bundle: &Bundle, revision: u64, actor: &Claims) -> Result<(), ApiError> {
    let identity = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(128).collect::<String>())
    };
    let author_id = identity(&actor.sub);
    let author_name = identity(&actor.name);
    if author_id.is_none() && author_name.is_none() {
        return Ok(());
    }
    let mut record = bundle.revision(revision).map_err(internal)?;
    record.author_id = author_id;
    record.author_name = author_name;
    bundle.write_revision(&record).map_err(internal)
}

async fn auth_check(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let claims = claims(&state, &headers, &id)?;
    open(&state, &id)?;
    let epoch = collaboration_epoch(&state, &id).await?;
    Ok(Json(
        json!({"documentId": id, "scope": claims.scope, "userId": claims.sub,
        "displayName": claims.name, "expiresAt": claims.exp, "collaborationEpoch": epoch}),
    ))
}

fn collaboration_path(state: &ServerState, id: &str) -> PathBuf {
    state.root.join("collaboration").join(format!("{id}.bin"))
}

fn collaboration_epoch_path(state: &ServerState, id: &str) -> PathBuf {
    state.root.join("collaboration").join(format!("{id}.epoch"))
}

async fn collaboration_epoch(state: &ServerState, id: &str) -> Result<u64, ApiError> {
    if let Some(remote) = &state.remote {
        return remote.collaboration_epoch(id).await.map_err(internal);
    }
    match tokio::fs::read_to_string(collaboration_epoch_path(state, id)).await {
        Ok(value) => value.trim().parse().map_err(internal),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(internal(error)),
    }
}

fn requested_collaboration_epoch(headers: &HeaderMap) -> Result<u64, ApiError> {
    headers
        .get("x-hcd-collaboration-epoch")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| bad("X-HCD-Collaboration-Epoch header required"))
}

async fn check_collaboration_epoch(
    state: &ServerState,
    id: &str,
    headers: &HeaderMap,
) -> Result<u64, ApiError> {
    let requested = requested_collaboration_epoch(headers)?;
    if requested != collaboration_epoch(state, id).await? {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "collaboration generation changed; reload the editor".to_string(),
        ));
    }
    Ok(requested)
}

async fn reset_collaboration(state: &ServerState, id: &str) -> Result<u64, ApiError> {
    let _guard = state.collaboration_lock.lock().await;
    if let Some(remote) = &state.remote {
        return remote.collaboration_reset(id).await.map_err(internal);
    }
    let current = collaboration_epoch(state, id).await?;
    let next = current
        .checked_add(1)
        .ok_or_else(|| internal("collaboration epoch limit reached"))?;
    let path = collaboration_epoch_path(state, id);
    tokio::fs::create_dir_all(path.parent().expect("epoch parent"))
        .await
        .map_err(internal)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temporary, next.to_string())
        .await
        .map_err(internal)?;
    tokio::fs::rename(&temporary, path)
        .await
        .map_err(internal)?;
    match tokio::fs::remove_file(collaboration_path(state, id)).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(internal(error)),
    }
    Ok(next)
}

async fn collaboration_get(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    open(&state, &id)?;
    let _guard = state.collaboration_lock.lock().await;
    check_collaboration_epoch(&state, &id, &headers).await?;
    if let Some(remote) = &state.remote {
        let bytes = remote
            .collaboration_get(&id)
            .await
            .map_err(internal)?
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "no collaboration state".to_string()))?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(internal("stored collaboration state exceeds 8 MiB"));
        }
        return Ok((
            [(header::CONTENT_TYPE, "application/octet-stream")],
            Body::from(bytes),
        )
            .into_response());
    }
    let bytes = tokio::fs::read(collaboration_path(&state, &id))
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ApiError(StatusCode::NOT_FOUND, "no collaboration state".to_string())
            } else {
                internal(error)
            }
        })?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(internal("stored collaboration state exceeds 8 MiB"));
    }
    Ok((
        [(header::CONTENT_TYPE, "application/octet-stream")],
        Body::from(bytes),
    )
        .into_response())
}

async fn collaboration_put(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, true)?;
    open(&state, &id)?;
    let _guard = state.collaboration_lock.lock().await;
    let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
    if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
        return Err(bad("collaboration state must be 1-8 MiB"));
    }
    if let Some(remote) = &state.remote {
        if !remote
            .collaboration_put(&id, epoch, &bytes)
            .await
            .map_err(internal)?
        {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "collaboration generation changed; reload the editor".to_string(),
            ));
        }
        return Ok(Json(json!({"saved": true, "bytes": bytes.len()})));
    }
    let destination = collaboration_path(&state, &id);
    tokio::fs::create_dir_all(destination.parent().expect("state parent"))
        .await
        .map_err(internal)?;
    let temporary = destination.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temporary, &bytes)
        .await
        .map_err(internal)?;
    tokio::fs::rename(&temporary, &destination)
        .await
        .map_err(internal)?;
    Ok(Json(json!({"saved": true, "bytes": bytes.len()})))
}

#[derive(Deserialize)]
struct RevisionQuery {
    revision: Option<u64>,
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    revision: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedRevision {
    expected_revision: u64,
}

async fn manifest(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    Ok(Json(
        serde_json::to_value(open(&state, &id)?.manifest().map_err(internal)?).map_err(internal)?,
    ))
}

async fn editor(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let projection = editor_projection(&open(&state, &id)?, query.revision).map_err(bad)?;
    Ok(Json(serde_json::to_value(projection).map_err(internal)?))
}

async fn search(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<SearchQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let result =
        tokio::task::spawn_blocking(move || search_bundle(&bundle, query.revision, &query.q))
            .await
            .map_err(internal)?
            .map_err(hcd_error)?;
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}

async fn project(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ExpectedRevision>,
) -> Result<Json<Value>, ApiError> {
    let actor = write_claims(&state, &headers, &id)?;
    let bundle = open(&state, &id)?;
    let result = project_editor(&bundle, request.expected_revision).map_err(hcd_error)?;
    stamp_revision_author(&bundle, result.revision, &actor)?;
    publish_mutation(&state, &id, &bundle, request.expected_revision).await?;
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}

async fn patch(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(patch): Json<StructurePatchBatch>,
) -> Result<Json<Value>, ApiError> {
    let actor = write_claims(&state, &headers, &id)?;
    if patch.document_id != id {
        return Err(bad("patch document ID mismatch"));
    }
    let bundle = open(&state, &id)?;
    let result = apply_structure_patch(&bundle, &patch, patch.base_revision).map_err(hcd_error)?;
    if !result.idempotent_replay {
        stamp_revision_author(&bundle, result.revision, &actor)?;
        publish_mutation(&state, &id, &bundle, patch.base_revision).await?;
        reset_collaboration(&state, &id).await?;
    }
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}

async fn node_patch(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(patch): Json<PatchBatch>,
) -> Result<Json<Value>, ApiError> {
    let actor = write_claims(&state, &headers, &id)?;
    if patch.document_id != id {
        return Err(bad("patch document ID mismatch"));
    }
    let bundle = open(&state, &id)?;
    let format = bundle.manifest().map_err(hcd_error)?.source.format;
    if !matches!(format.as_str(), "pdf" | "pptx" | "xlsx") {
        return Err(bad("node patch endpoint accepts PDF, PPTX or XLSX bundles"));
    }
    let result = apply_patch(&bundle, &patch, patch.base_revision).map_err(hcd_error)?;
    if !result.idempotent_replay {
        stamp_revision_author(&bundle, result.revision, &actor)?;
        publish_mutation(&state, &id, &bundle, patch.base_revision).await?;
    }
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotRequest {
    expected_revision: u64,
    blocks: Vec<SnapshotBlock>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotBlock {
    block_id: Option<String>,
    content: EditorBlockContent,
}

fn normalized(mut content: EditorBlockContent) -> EditorBlockContent {
    let mut inlines: Vec<EditorInline> = Vec::new();
    for mut inline in content.inlines {
        inline.node_id = None;
        if inline.text.is_empty() {
            continue;
        }
        if let Some(previous) = inlines.last_mut() {
            if previous.bold == inline.bold
                && previous.italic == inline.italic
                && previous.link == inline.link
            {
                previous.text.push_str(&inline.text);
                continue;
            }
        }
        inlines.push(inline);
    }
    content.inlines = inlines;
    content
}

async fn checkpoint(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<SnapshotRequest>,
) -> Result<Json<Value>, ApiError> {
    let actor = write_claims(&state, &headers, &id)?;
    check_collaboration_epoch(&state, &id, &headers).await?;
    if request.blocks.len() > 1_000_000 {
        return Err(bad("snapshot block limit exceeded"));
    }
    let bundle = open(&state, &id)?;
    let current = editor_projection(&bundle, None).map_err(bad)?;
    if current.revision != request.expected_revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            format!(
                "expected revision {}, current {}",
                request.expected_revision, current.revision
            ),
        ));
    }
    let existing: HashMap<&str, _> = current
        .blocks
        .iter()
        .filter(|block| block.region == "body")
        .map(|block| (block.block_id.as_str(), block))
        .collect();
    let mut desired_seen = HashSet::new();
    let mut desired_known = Vec::new();
    for block in &request.blocks {
        if let Some(block_id) = &block.block_id {
            if let Some(original) = existing.get(block_id.as_str()) {
                if !desired_seen.insert(block_id.as_str()) {
                    return Err(bad("duplicate block ID in snapshot"));
                }
                if original.read_only
                    && normalized(block.content.clone()) != normalized(original.content.clone())
                {
                    return Err(bad("read-only block was changed"));
                }
                desired_known.push(block_id.clone());
            } else if !block_id.starts_with("tmp_") {
                return Err(bad("unknown canonical block ID"));
            }
        }
    }
    if current.blocks.iter().any(|block| {
        block.region == "body" && block.read_only && !desired_seen.contains(block.block_id.as_str())
    }) {
        return Err(bad("read-only block was removed"));
    }
    let mut operations = Vec::new();
    let mut live: Vec<String> = current
        .blocks
        .iter()
        .filter(|block| block.region == "body")
        .map(|block| block.block_id.clone())
        .collect();
    for original in current.blocks.iter().filter(|block| block.region == "body") {
        if !desired_seen.contains(original.block_id.as_str()) {
            operations.push(StructureOperation::Delete {
                block_id: original.block_id.clone(),
                precondition: BlockPrecondition {
                    block_hash: original.block_hash.clone(),
                },
            });
            live.retain(|id| id != &original.block_id);
        }
    }
    for (target, block_id) in desired_known.iter().enumerate() {
        let position = live
            .iter()
            .position(|value| value == block_id)
            .ok_or_else(|| internal("snapshot retained block disappeared"))?;
        if position != target {
            let original = existing[block_id.as_str()];
            if original.read_only {
                return Err(bad("read-only block cannot move"));
            }
            let previous = target
                .checked_sub(1)
                .map(|index| desired_known[index].clone());
            operations.push(StructureOperation::Move {
                block_id: block_id.clone(),
                after_block_id: previous,
                precondition: BlockPrecondition {
                    block_hash: original.block_hash.clone(),
                },
            });
            live.remove(position);
            live.insert(target, block_id.clone());
        }
    }
    for block in &request.blocks {
        let Some(block_id) = block.block_id.as_deref() else {
            continue;
        };
        let Some(original) = existing.get(block_id) else {
            continue;
        };
        let desired = normalized(block.content.clone());
        if desired != normalized(original.content.clone()) {
            if original.read_only {
                return Err(bad("read-only block cannot be replaced"));
            }
            operations.push(StructureOperation::Replace {
                block_id: block_id.to_string(),
                block: desired,
                precondition: BlockPrecondition {
                    block_hash: original.block_hash.clone(),
                },
            });
        }
    }
    for index in (0..request.blocks.len()).rev() {
        let block = &request.blocks[index];
        if block
            .block_id
            .as_ref()
            .is_some_and(|value| existing.contains_key(value.as_str()))
        {
            continue;
        }
        let previous = request.blocks[..index].iter().rev().find_map(|value| {
            value
                .block_id
                .as_ref()
                .filter(|id| existing.contains_key(id.as_str()))
                .cloned()
        });
        operations.push(StructureOperation::Insert {
            after_block_id: previous,
            block: normalized(block.content.clone()),
        });
    }
    if operations.is_empty() {
        return Ok(Json(
            json!({"saved": true, "revision": current.revision, "projection": current}),
        ));
    }
    let patch = StructurePatchBatch {
        schema_version: HCD_PATCH_SCHEMA_VERSION_4.to_string(),
        document_id: id,
        patch_id: format!("checkpoint-{}", uuid::Uuid::new_v4()),
        base_revision: current.revision,
        operations,
    };
    let result = apply_structure_patch(&bundle, &patch, current.revision).map_err(hcd_error)?;
    stamp_revision_author(&bundle, result.revision, &actor)?;
    publish_mutation(&state, &patch.document_id, &bundle, current.revision).await?;
    let projection = editor_projection(&bundle, None).map_err(internal)?;
    Ok(Json(
        json!({"saved": true, "revision": result.revision, "projection": projection}),
    ))
}

async fn revisions(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<RevisionListQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?.revision;
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let last = query.before.unwrap_or(head).min(head);
    let first = last.saturating_sub(limit - 1);
    let mut result = Vec::new();
    for number in first..=last {
        result.push(bundle.revision(number).map_err(internal)?);
    }
    Ok(Json(json!({"headRevision": head, "revisions": result,
        "nextBefore": first.checked_sub(1)})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevisionListQuery {
    before: Option<u64>,
    limit: Option<u64>,
}

async fn revision(
    State(state): State<ServerState>,
    Path((id, number)): Path<(String, u64)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?.revision;
    if number > head {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "revision not found".to_string(),
        ));
    }
    Ok(Json(
        serde_json::to_value(bundle.revision(number).map_err(internal)?).map_err(internal)?,
    ))
}

async fn restore(
    State(state): State<ServerState>,
    Path((id, number)): Path<(String, u64)>,
    headers: HeaderMap,
    Json(request): Json<ExpectedRevision>,
) -> Result<Json<Value>, ApiError> {
    let actor = write_claims(&state, &headers, &id)?;
    let bundle = open(&state, &id)?;
    let result = restore_revision(&bundle, number, request.expected_revision).map_err(hcd_error)?;
    stamp_revision_author(&bundle, result.revision, &actor)?;
    publish_mutation(&state, &id, &bundle, request.expected_revision).await?;
    reset_collaboration(&state, &id).await?;
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}

async fn publish_mutation(
    state: &ServerState,
    id: &str,
    bundle: &Bundle,
    previous_revision: u64,
) -> Result<(), ApiError> {
    let Some(remote) = &state.remote else {
        return Ok(());
    };
    if let Err(error) = remote
        .publish(id, bundle.root(), None, Some(previous_revision))
        .await
    {
        let recovery = remote.refresh(id).await;
        return Err(ApiError(
            StatusCode::CONFLICT,
            format!(
                "remote head was not advanced: {error}; local cache recovery: {}",
                recovery
                    .map(|_| "succeeded".to_string())
                    .unwrap_or_else(|issue| issue.to_string())
            ),
        ));
    }
    Ok(())
}

async fn index_page(
    State(state): State<ServerState>,
    Path((id, page)): Path<(String, usize)>,
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    let (manifest, _) = manifest_at_revision(&bundle, &head, query.revision).map_err(bad)?;
    let index = bundle.read_index_page(&manifest, page).map_err(bad)?;
    Ok(Json(serde_json::to_value(index).map_err(internal)?))
}

async fn chunk(
    State(state): State<ServerState>,
    Path((id, sequence)): Path<(String, usize)>,
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    let (manifest, revision) = manifest_at_revision(&bundle, &head, query.revision).map_err(bad)?;
    if sequence >= manifest.chunk_count {
        return Err(bad("chunk sequence out of range"));
    }
    let page = bundle
        .read_index_page(&manifest, sequence / hcd_core::INDEX_PAGE_SIZE)
        .map_err(bad)?;
    let descriptor = page
        .chunks
        .into_iter()
        .find(|item| item.sequence == sequence)
        .ok_or_else(|| internal("index page missing chunk"))?;
    let html = bundle.read_chunk_verified(&descriptor).map_err(bad)?;
    let map = bundle.read_map_verified(&descriptor).map_err(bad)?;
    if map.chunk_id != descriptor.chunk_id {
        return Err(internal("chunk source map ID mismatch"));
    }
    Ok(Json(
        json!({"revision": revision, "descriptor": descriptor, "html": html, "map": map}),
    ))
}

async fn asset(
    State(state): State<ServerState>,
    Path((id, hash)): Path<(String, String)>,
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(bad("invalid asset hash"));
    }
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?.revision;
    let revision = query.revision.unwrap_or(head);
    if revision > head {
        return Err(bad("revision ahead of head"));
    }
    let descriptor = bundle
        .read_asset_index_for_revision(revision)
        .map_err(bad)?
        .into_iter()
        .find(|asset| asset.hash == hash)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "asset not found".to_string()))?;
    if descriptor.byte_length > hcd_core::MAX_STAGED_ASSET_BYTES {
        return Err(bad("asset exceeds response limit"));
    }
    let path = bundle.resolve_href(&descriptor.href).map_err(bad)?;
    if hash_file(&path).map_err(internal)? != hash {
        return Err(internal("asset hash mismatch"));
    }
    let bytes = tokio::fs::read(&path).await.map_err(internal)?;
    if bytes.len() as u64 != descriptor.byte_length {
        return Err(internal("asset length mismatch"));
    }
    let mime = match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
    .parse::<axum::http::HeaderValue>()
    .map_err(internal)?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(header::CONTENT_TYPE, mime);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "private, immutable, max-age=31536000"
            .parse()
            .map_err(internal)?,
    );
    Ok(response)
}

async fn styles(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let manifest = bundle.manifest().map_err(internal)?;
    let path = bundle.resolve_href(&manifest.styles_href).map_err(bad)?;
    let bytes = tokio::fs::read(path).await.map_err(internal)?;
    if bytes.len() > 1024 * 1024 {
        return Err(bad("stylesheet exceeds 1 MiB"));
    }
    Ok((
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        Body::from(bytes),
    )
        .into_response())
}

#[derive(Clone, Copy, Deserialize)]
struct ExportQuery {
    revision: Option<u64>,
    source: Option<bool>,
}

async fn prepare_download(
    State(state): State<ServerState>,
    Path((id, format)): Path<(String, String)>,
    Query(query): Query<ExportQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    let revision = query.revision.unwrap_or(head.revision);
    if revision > head.revision {
        return Err(bad("revision ahead of head"));
    }
    if !matches!(
        format.as_str(),
        "docx" | "xlsx" | "pptx" | "pdf" | "html" | "md" | "txt"
    ) {
        return Err(bad("unsupported export format"));
    }
    let ticket = uuid::Uuid::new_v4().to_string();
    let mut downloads = state.downloads.lock().await;
    downloads.retain(|_, item| item.expires_at > Instant::now());
    if downloads.len() >= 256 {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "too many pending downloads".to_string(),
        ));
    }
    downloads.insert(
        ticket.clone(),
        DownloadTicket {
            document_id: id.clone(),
            format: format.clone(),
            query: ExportQuery {
                revision: Some(revision),
                source: query.source,
            },
            expires_at: Instant::now() + Duration::from_secs(300),
        },
    );
    Ok(Json(json!({
        "url": format!("/v1/downloads/{ticket}"),
        "filename": format!("{id}-r{revision}.{format}"),
    })))
}

async fn download_ticket(
    State(state): State<ServerState>,
    Path(ticket): Path<String>,
) -> Result<Response, ApiError> {
    let download = resolve_download_ticket(&state, &ticket).await?;
    export_document_inner(state, download.document_id, download.format, download.query).await
}

async fn preview_download_ticket(
    State(state): State<ServerState>,
    Path(ticket): Path<String>,
) -> Result<Response, ApiError> {
    let download = resolve_download_ticket(&state, &ticket).await?;
    if download.format != "pdf" {
        return Err(bad("inline preview supports only PDF downloads"));
    }
    let mut response =
        export_document_inner(state, download.document_id, download.format, download.query).await?;
    let disposition = response
        .headers()
        .get(header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| bad("PDF export has no content disposition"))?
        .replacen("attachment;", "inline;", 1);
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        disposition.parse().map_err(internal)?,
    );
    Ok(response)
}

async fn resolve_download_ticket(
    state: &ServerState,
    ticket: &str,
) -> Result<DownloadTicket, ApiError> {
    let download = state
        .downloads
        .lock()
        .await
        .get(ticket)
        .cloned()
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "download link not found".to_string()))?;
    if download.expires_at <= Instant::now() {
        state.downloads.lock().await.remove(ticket);
        return Err(ApiError(
            StatusCode::GONE,
            "download link expired".to_string(),
        ));
    }
    Ok(download)
}

async fn export_document(
    State(state): State<ServerState>,
    Path((id, format)): Path<(String, String)>,
    Query(query): Query<ExportQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    export_document_inner(state, id, format, query).await
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
    if !matches!(
        format.as_str(),
        "docx" | "xlsx" | "pptx" | "pdf" | "html" | "md" | "txt"
    ) {
        return Err(bad("unsupported export format"));
    }
    let mime = match format.as_str() {
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pdf" => "application/pdf",
        "html" => "text/html; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        _ => "text/plain; charset=utf-8",
    };
    let bytes = if format == "html" {
        let mut output = Vec::new();
        let assets = bundle
            .read_asset_index_for_revision(requested)
            .map_err(bad)?;
        let known: HashMap<String, _> = assets
            .into_iter()
            .map(|asset| (asset.hash.clone(), asset))
            .collect();
        let pattern = Regex::new(r"asset://sha256/([0-9a-f]{64})").map_err(internal)?;
        let mut cache = HashMap::<String, String>::new();
        let options = hcd_core::HtmlPresentationOptions {
            revision: Some(requested),
            max_output_bytes: 256 * 1024 * 1024,
            ..Default::default()
        };
        hcd_core::render_standalone_html_with_transform(&bundle, &options, &mut output, |html| {
            let mut transformed = String::with_capacity(html.len());
            let mut previous = 0;
            for matched in pattern.captures_iter(html) {
                let full = matched.get(0).expect("regex match");
                let hash = matched.get(1).expect("regex hash").as_str();
                transformed.push_str(&html[previous..full.start()]);
                if !cache.contains_key(hash) {
                    let asset = known.get(hash).ok_or_else(|| {
                        hcd_core::HcdError::InvalidBundle(format!("unknown asset {hash}"))
                    })?;
                    if asset.byte_length > 64 * 1024 * 1024 {
                        return Err(hcd_core::HcdError::ResourceLimit(
                            "asset exceeds HTML export limit".to_string(),
                        ));
                    }
                    let path = bundle.resolve_href(&asset.href)?;
                    if hash_file(&path)? != hash {
                        return Err(hcd_core::HcdError::InvalidBundle(format!(
                            "asset {hash} hash mismatch"
                        )));
                    }
                    let bytes = std::fs::read(&path)?;
                    if bytes.len() as u64 != asset.byte_length {
                        return Err(hcd_core::HcdError::InvalidBundle(format!(
                            "asset {hash} length mismatch"
                        )));
                    }
                    let mime = match path
                        .extension()
                        .and_then(|value| value.to_str())
                        .unwrap_or_default()
                    {
                        "png" => "image/png",
                        "jpg" | "jpeg" => "image/jpeg",
                        "gif" => "image/gif",
                        "webp" => "image/webp",
                        "svg" => "image/svg+xml",
                        _ => "application/octet-stream",
                    };
                    cache.insert(
                        hash.to_string(),
                        format!(
                            "data:{mime};base64,{}",
                            base64::engine::general_purpose::STANDARD.encode(bytes)
                        ),
                    );
                }
                transformed.push_str(&cache[hash]);
                previous = full.end();
            }
            transformed.push_str(&html[previous..]);
            Ok(transformed)
        })
        .map_err(bad)?;
        output
    } else {
        let temp = tempfile::tempdir().map_err(internal)?;
        let output = temp.path().join(format!("export.{format}"));
        let mut command = tokio::process::Command::new(std::env::current_exe().map_err(internal)?);
        command
            .arg("hdoc")
            .arg("export")
            .arg(bundle.root())
            .arg("--output")
            .arg(&output)
            .arg("--revision")
            .arg(requested.to_string());
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
    let mut response = Response::new(Body::from(bytes));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, mime.parse().map_err(internal)?);
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{id}-r{requested}.{format}\"")
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
