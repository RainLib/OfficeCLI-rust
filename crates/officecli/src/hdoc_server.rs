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
    append_comment, apply_patch, apply_structure_patch, extract_image_page, get_image_node,
    hash_bytes, hash_file, manifest_at_revision, project_editor, resolve_tracked_change,
    restore_revision, revision_author, BlockPrecondition, Bundle, EditorBlockContent,
    EditorBlockKind, EditorBlockView, EditorInline, EditorProjection, HcdError, ImageGeometry,
    NodePrecondition, NodeStylePatch, PatchBatch, PatchOperation, StructureOperation,
    StructurePatchBatch, VisualPrecondition, HCD_PATCH_SCHEMA_VERSION, HCD_PATCH_SCHEMA_VERSION_3,
    HCD_PATCH_SCHEMA_VERSION_4, MAX_PATCH_JSON_BYTES,
};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, Mutex};

#[path = "hdoc_revision_events.rs"]
mod revision_events;
use revision_events::{revision_events, revision_websocket};

#[derive(Clone)]
struct ServerState {
    root: PathBuf,
    secret: Arc<Vec<u8>>,
    remote: Option<RemoteStore>,
    collaboration_lock: Arc<Mutex<()>>,
    revisions: RevisionHub,
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
        revisions: RevisionHub::default(),
    };
    let router = Router::new()
        .route("/health", get(|| async { Json(json!({"ok": true})) }))
        .route("/v1/documents/{id}", get(manifest))
        .route("/v1/import", post(import_document))
        .route("/v1/jobs/{job_id}", get(job_status))
        .route("/v1/documents/{id}/editor", get(editor))
        .route("/v1/documents/{id}/export-options", get(export_options))
        .route("/v1/documents/{id}/project", post(project))
        .route(
            "/v1/documents/{id}/pdf/layout",
            get(pdf_layout_status).post(upgrade_pdf_layout),
        )
        .route("/v1/documents/{id}/patch", post(patch))
        .route("/v1/documents/{id}/checkpoints", post(checkpoint))
        .route("/v1/documents/{id}/revisions", get(revisions))
        .route("/v1/documents/{id}/revisions/{revision}", get(revision))
        .route("/v1/documents/{id}/restore/{revision}", post(restore))
        .route("/v1/documents/{id}/index/{page}", get(index_page))
        .route("/v1/documents/{id}/chunks/{sequence}", get(chunk))
        .route("/v1/documents/{id}/assets/{hash}", get(asset))
        .route("/v1/documents/{id}/staged-assets", post(stage_image))
        .route("/v1/documents/{id}/staged-assets/{hash}", get(staged_image))
        .route("/v1/documents/{id}/images", get(images))
        .route(
            "/v1/documents/{id}/images/{node_id}",
            get(image).post(replace_image),
        )
        .route(
            "/v1/documents/{id}/images/{node_id}/geometry",
            post(move_image),
        )
        .route("/v1/documents/{id}/text", post(text_patch))
        .route("/v1/documents/{id}/text/{node_id}", get(text_node))
        .route("/v1/documents/{id}/edits", post(editor_edits))
        .route(
            "/v1/documents/{id}/edits/receipt",
            post(editor_edits_receipt),
        )
        .route("/v1/documents/{id}/tracked-changes", post(resolve_change))
        .route("/v1/documents/{id}/comments", post(reply_comment))
        .route("/v1/documents/{id}/events", get(revision_events))
        .route("/v1/documents/{id}/events/ws", get(revision_websocket))
        .route("/v1/documents/{id}/styles", get(styles))
        .route("/v1/documents/{id}/export/{format}", get(export_document))
        .route("/v1/documents/{id}/auth", get(auth_check))
        .route(
            "/v1/documents/{id}/collaboration/state",
            get(collaboration_get).put(collaboration_put),
        )
        .route(
            "/v1/documents/{id}/collaboration/recovery",
            get(collaboration_recoveries).post(collaboration_recover),
        )
        .route(
            "/v1/documents/{id}/collaboration/recovery/{recovery_id}",
            get(collaboration_recovery),
        )
        .route(
            "/v1/documents/{id}/collaboration/reset",
            post(collaboration_reset),
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

// Verified, bounded font metadata cache. The key names the immutable source,
// so changes to the companion file cannot replace a cached author's fonts.
fn editor_projection(bundle: &Bundle, revision: Option<u64>) -> Result<EditorProjection, HcdError> {
    type Cache = HashMap<(PathBuf, String), Arc<String>>;
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Cache>> = std::sync::OnceLock::new();
    let manifest = bundle.manifest()?;
    if manifest.source.format != "docx" {
        return hcd_core::editor_projection(bundle, revision);
    }
    use std::io::Read as _;
    let mut prefix = [0u8; 64];
    let count =
        std::fs::File::open(bundle.resolve_href(&manifest.styles_href)?)?.read(&mut prefix)?;
    if prefix[..count].starts_with(hcd_docx::FONT_METADATA_CSS_MARKER.as_bytes()) {
        return hcd_core::editor_projection(bundle, revision);
    }
    let source = bundle
        .root()
        .parent()
        .unwrap_or(bundle.root())
        .join("sources")
        .join(format!("{}.docx", manifest.document_id));
    let key = (source.clone(), manifest.source.sha256.clone());
    let cache = CACHE.get_or_init(Default::default);
    let cached = cache
        .lock()
        .map_err(|_| HcdError::InvalidBundle("font metadata cache unavailable".into()))?
        .get(&key)
        .cloned();
    let styles = if let Some(styles) = cached {
        styles
    } else if source.is_file() {
        let styles = Arc::new(hcd_docx::source_typography_styles(
            &source,
            &manifest.source.sha256,
        )?);
        let mut cache = cache
            .lock()
            .map_err(|_| HcdError::InvalidBundle("font metadata cache unavailable".into()))?;
        if cache.len() >= 16
            || cache.values().map(|value| value.len()).sum::<usize>() + styles.len()
                > 16 * 1024 * 1024
        {
            cache.clear();
        }
        cache.insert(key, styles.clone());
        styles
    } else {
        return hcd_core::editor_projection(bundle, revision);
    };
    hcd_core::editor_projection_with_typography_styles(bundle, revision, &styles)
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

async fn collaboration_current_path(
    state: &ServerState,
    id: &str,
    epoch: u64,
) -> Result<PathBuf, ApiError> {
    let path = state
        .root
        .join("collaboration")
        .join(format!("{id}.epoch-{epoch}.bin"));
    let legacy = collaboration_path(state, id);
    // Called under the collaboration lock. Migrate the old unversioned name
    // once; subsequent epochs cannot accidentally load an older binary after
    // a crash between generation advancement and file deletion.
    if !tokio::fs::try_exists(&path).await.map_err(internal)?
        && tokio::fs::try_exists(&legacy).await.map_err(internal)?
    {
        tokio::fs::rename(legacy, &path).await.map_err(internal)?;
    }
    Ok(path)
}

async fn sync_collaboration_directory(directory: &std::path::Path) -> Result<(), ApiError> {
    #[cfg(unix)]
    tokio::fs::File::open(directory)
        .await
        .map_err(internal)?
        .sync_all()
        .await
        .map_err(internal)?;
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
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
    reset_collaboration_locked(state, id).await
}

async fn reset_collaboration_locked(state: &ServerState, id: &str) -> Result<u64, ApiError> {
    if let Some(remote) = &state.remote {
        return remote.collaboration_reset(id).await.map_err(internal);
    }
    let current = collaboration_epoch(state, id).await?;
    let previous_state = collaboration_current_path(state, id, current).await?;
    match tokio::fs::read(&previous_state).await {
        Ok(bytes) => {
            save_collaboration_recovery(state, id, current, &bytes).await?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(internal(error)),
    }
    let next = current
        .checked_add(1)
        .ok_or_else(|| internal("collaboration epoch limit reached"))?;
    let path = collaboration_epoch_path(state, id);
    tokio::fs::create_dir_all(path.parent().expect("epoch parent"))
        .await
        .map_err(internal)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = tokio::fs::File::create(&temporary)
        .await
        .map_err(internal)?;
    file.write_all(next.to_string().as_bytes())
        .await
        .map_err(internal)?;
    file.sync_all().await.map_err(internal)?;
    tokio::fs::rename(&temporary, &path)
        .await
        .map_err(internal)?;
    sync_collaboration_directory(path.parent().expect("epoch parent")).await?;
    Ok(next)
}

fn recovery_name(epoch: u64) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("e{epoch}-{timestamp}-{}", uuid::Uuid::new_v4().simple())
}

fn valid_recovery_name(name: &str) -> bool {
    let parts: Vec<_> = name.split('-').collect();
    parts.len() == 3
        && parts[0].starts_with('e')
        && parts[0][1..].parse::<u64>().is_ok()
        && parts[1].parse::<u64>().is_ok()
        && parts[2].len() == 32
        && parts[2]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

async fn save_collaboration_recovery(
    state: &ServerState,
    id: &str,
    epoch: u64,
    bytes: &[u8],
) -> Result<String, ApiError> {
    if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
        return Err(bad("collaboration recovery must be 1-8 MiB"));
    }
    let recovery_id = recovery_name(epoch);
    if let Some(remote) = &state.remote {
        remote
            .collaboration_recover(id, &recovery_id, epoch, bytes)
            .await
            .map_err(internal)?;
    } else {
        let directory = state.root.join("collaboration/recovery").join(id);
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(internal)?;
        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(directory.join(format!("{recovery_id}.bin")))
            .await
            .map_err(internal)?;
        file.write_all(bytes).await.map_err(internal)?;
        file.sync_all().await.map_err(internal)?;
        sync_collaboration_directory(&directory).await?;
    }
    Ok(recovery_id)
}

async fn collaboration_recover(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, true)?;
    open(&state, &id)?;
    // Recovery deliberately accepts old epochs: it cannot mutate canonical
    // content or the current room and must preserve drafts after a reset.
    let epoch = requested_collaboration_epoch(&headers)?;
    let recovery_id = save_collaboration_recovery(&state, &id, epoch, &bytes).await?;
    Ok(Json(json!({"recoveryId": recovery_id, "epoch": epoch})))
}

async fn collaboration_recoveries(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    open(&state, &id)?;
    let ids = if let Some(remote) = &state.remote {
        remote
            .collaboration_recoveries(&id)
            .await
            .map_err(internal)?
    } else {
        let mut names = std::collections::BTreeSet::new();
        match tokio::fs::read_dir(state.root.join("collaboration/recovery").join(&id)).await {
            Ok(mut directory) => {
                while let Some(entry) = directory.next_entry().await.map_err(internal)? {
                    if let Some(name) = entry
                        .file_name()
                        .to_str()
                        .and_then(|name| name.strip_suffix(".bin"))
                    {
                        if valid_recovery_name(name) {
                            let timestamp = name
                                .split('-')
                                .nth(1)
                                .and_then(|value| value.parse::<u64>().ok())
                                .unwrap_or(0);
                            names.insert((timestamp, name.to_string()));
                            if names.len() > 50 {
                                names.pop_first();
                            }
                        }
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(internal(error)),
        }
        names.into_iter().rev().map(|(_, name)| name).collect()
    };
    Ok(Json(json!({"recoveries": ids})))
}

async fn collaboration_recovery(
    State(state): State<ServerState>,
    Path((id, recovery_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    open(&state, &id)?;
    if !valid_recovery_name(&recovery_id) {
        return Err(bad("invalid recovery ID"));
    }
    let bytes = if let Some(remote) = &state.remote {
        remote
            .collaboration_recovery(&id, &recovery_id)
            .await
            .map_err(internal)?
    } else {
        match tokio::fs::read(
            state
                .root
                .join("collaboration/recovery")
                .join(&id)
                .join(format!("{recovery_id}.bin")),
        )
        .await
        {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(internal(error)),
        }
    }
    .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "recovery not found".into()))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(internal("recovery exceeds 8 MiB"));
    }
    Ok((
        [(header::CONTENT_TYPE, "application/octet-stream")],
        Body::from(bytes),
    )
        .into_response())
}

async fn collaboration_reset(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, true)?;
    open(&state, &id)?;
    let _guard = state.collaboration_lock.lock().await;
    check_collaboration_epoch(&state, &id, &headers).await?;
    let epoch = reset_collaboration_locked(&state, &id).await?;
    Ok(Json(json!({"collaborationEpoch": epoch})))
}

async fn collaboration_get(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    open(&state, &id)?;
    let _guard = state.collaboration_lock.lock().await;
    let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
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
            [
                ("content-type", "application/octet-stream".to_string()),
                ("x-hcd-state-hash", hash_bytes(&bytes)),
            ],
            Body::from(bytes),
        )
            .into_response());
    }
    let bytes = tokio::fs::read(collaboration_current_path(&state, &id, epoch).await?)
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
        [
            ("content-type", "application/octet-stream".to_string()),
            ("x-hcd-state-hash", hash_bytes(&bytes)),
        ],
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
    let claims = authorize_claims(&state, &headers, &id)?;
    if claims.sub.as_deref() != Some("hcd-collaboration")
        || headers
            .get("x-hcd-coordinator-version")
            .and_then(|value| value.to_str().ok())
            != Some("4")
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "collaboration persistence requires the HCD save coordinator".into(),
        ));
    }
    let expected_hash = headers
        .get("x-hcd-state-hash")
        .and_then(|value| value.to_str().ok())
        .filter(|hash| {
            *hash == "none"
                || hash.len() == 64
                    && hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or_else(|| {
            ApiError(
                StatusCode::PRECONDITION_REQUIRED,
                "X-HCD-State-Hash required".into(),
            )
        })?;
    open(&state, &id)?;
    let _guard = state.collaboration_lock.lock().await;
    let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
    if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
        return Err(bad("collaboration state must be 1-8 MiB"));
    }
    if let Some(remote) = &state.remote {
        match remote
            .collaboration_put(&id, epoch, expected_hash, &bytes)
            .await
            .map_err(internal)?
        {
            crate::hdoc_remote::CollaborationPut::EpochChanged => {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "collaboration generation changed; reload the editor".to_string(),
                ))
            }
            crate::hdoc_remote::CollaborationPut::StateChanged => {
                return Err(ApiError(
                    StatusCode::PRECONDITION_FAILED,
                    "collaboration state changed in another owner".into(),
                ))
            }
            crate::hdoc_remote::CollaborationPut::Saved => {}
        }
        return Ok(Json(
            json!({"saved": true, "bytes": bytes.len(), "stateHash": hash_bytes(&bytes)}),
        ));
    }
    let destination = collaboration_current_path(&state, &id, epoch).await?;
    let previous = match tokio::fs::read(&destination).await {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(internal(error)),
    };
    let actual_hash = previous
        .as_ref()
        .map(|bytes| hash_bytes(bytes))
        .unwrap_or_else(|| "none".into());
    if actual_hash != expected_hash && actual_hash != hash_bytes(&bytes) {
        return Err(ApiError(
            StatusCode::PRECONDITION_FAILED,
            "collaboration state changed in another owner".into(),
        ));
    }
    tokio::fs::create_dir_all(destination.parent().expect("state parent"))
        .await
        .map_err(internal)?;
    let temporary = destination.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = tokio::fs::File::create(&temporary)
        .await
        .map_err(internal)?;
    file.write_all(&bytes).await.map_err(internal)?;
    file.sync_all().await.map_err(internal)?;
    tokio::fs::rename(&temporary, &destination)
        .await
        .map_err(internal)?;
    sync_collaboration_directory(destination.parent().expect("state parent")).await?;
    Ok(Json(
        json!({"saved": true, "bytes": bytes.len(), "stateHash": hash_bytes(&bytes)}),
    ))
}

#[derive(Deserialize)]
struct RevisionQuery {
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

async fn pdf_layout_status(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    let needs_upgrade = hcd_formats::pdf_layout_needs_upgrade(&bundle).map_err(hcd_error)?;
    Ok(Json(
        json!({"revision":head.revision,"needsUpgrade":needs_upgrade}),
    ))
}

async fn upgrade_pdf_layout(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ExpectedRevision>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    let bundle = open(&state, &id)?;
    let source = state.root.join("sources").join(format!("{id}.pdf"));
    let result = hcd_formats::upgrade_pdf_layout(
        &bundle,
        &source,
        request.expected_revision,
        author_actor(&claims, &[]),
    )
    .map_err(hcd_error)?;
    if let Some(result) = result {
        publish_mutation(&state, &id, &bundle, request.expected_revision).await?;
        Ok(Json(json!({"upgraded":true,"revision":result.revision})))
    } else {
        Ok(Json(
            json!({"upgraded":false,"revision":request.expected_revision}),
        ))
    }
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

async fn project(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ExpectedRevision>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, true)?;
    let bundle = open(&state, &id)?;
    let result = project_editor(&bundle, request.expected_revision).map_err(hcd_error)?;
    publish_mutation(&state, &id, &bundle, request.expected_revision).await?;
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}

async fn patch(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(patch): Json<StructurePatchBatch>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, true)?;
    if patch.document_id != id {
        return Err(bad("patch document ID mismatch"));
    }
    let bundle = open(&state, &id)?;
    let result = apply_structure_patch(&bundle, &patch, patch.base_revision).map_err(hcd_error)?;
    if !result.idempotent_replay {
        publish_mutation(&state, &id, &bundle, patch.base_revision).await?;
        reset_collaboration(&state, &id).await?;
    }
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotRequest {
    #[serde(default)]
    typography_version: Option<u32>,
    #[serde(default)]
    coordinator_version: Option<u32>,
    #[serde(default)]
    coordinator_id: Option<String>,
    #[serde(default)]
    checkpoint_id: Option<String>,
    #[serde(default)]
    coordinator_digest: Option<String>,
    expected_revision: u64,
    blocks: Vec<SnapshotBlock>,
    #[serde(default)]
    images: Vec<SnapshotImage>,
    #[serde(default)]
    contributors: Vec<Contributor>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotImage {
    node_id: String,
    geometry: ImageGeometry,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    asset_hash: Option<String>,
    precondition: VisualPrecondition,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Contributor {
    user_id: String,
    display_name: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotBlock {
    block_id: Option<String>,
    content: EditorBlockContent,
}

fn normalized(mut content: EditorBlockContent) -> EditorBlockContent {
    let mut inlines: Vec<EditorInline> = Vec::new();
    for mut inline in content.inlines {
        inline.node_id = None;
        if inline
            .typography
            .as_ref()
            .is_some_and(|font| font.is_empty())
        {
            inline.typography = None;
        }
        if inline.text.is_empty() {
            continue;
        }
        if let Some(previous) = inlines.last_mut() {
            if previous.bold == inline.bold
                && previous.italic == inline.italic
                && previous.link == inline.link
                && previous.text_color == inline.text_color
                && previous.background_color == inline.background_color
                && previous.border == inline.border
                && previous.typography == inline.typography
                && previous.font_size_explicit == inline.font_size_explicit
                && previous.underline == inline.underline
                && previous.strike == inline.strike
                && previous.code == inline.code
                && !previous.hard_break
                && !inline.hard_break
            {
                previous.text.push_str(&inline.text);
                continue;
            }
        }
        inlines.push(inline);
    }
    content.inlines = inlines;
    content.children = content.children.into_iter().map(normalized).collect();
    content
}

// Keep source anchors when the editor changed only text inside the same runs.
// A split, merged run, formatting change, or block edit must use the semantic
// structure path instead of guessing which source XML text node to rewrite.
fn marginal_region(region: &str) -> bool {
    matches!(region, "header" | "footer" | "footnote" | "endnote")
}

fn editor_surface(current: &EditorProjection) -> Vec<&EditorBlockView> {
    current
        .blocks
        .iter()
        .filter(|block| block.region == "body" || marginal_region(&block.region))
        .collect()
}

fn editor_inline_pairs<'a, 'b>(
    before: &'a EditorBlockContent,
    after: &'b EditorBlockContent,
    pairs: &mut Vec<(&'a EditorInline, &'b EditorInline)>,
) -> bool {
    if before.kind != after.kind
        || before.level != after.level
        || before.language != after.language
        || before.list_start != after.list_start
        || before.inlines.len() != after.inlines.len()
        || before.children.len() != after.children.len()
    {
        return false;
    }
    pairs.extend(before.inlines.iter().zip(&after.inlines));
    before
        .children
        .iter()
        .zip(&after.children)
        .all(|(before, after)| editor_inline_pairs(before, after, pairs))
}

fn source_text_splice(node_id: &str, before: &str, after: &str, node_hash: &str) -> PatchOperation {
    let old: Vec<char> = before.chars().collect();
    let new: Vec<char> = after.chars().collect();
    let prefix = old
        .iter()
        .zip(&new)
        .take_while(|(left, right)| left == right)
        .count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(left, right)| left == right)
        .count();
    PatchOperation::TextSplice {
        node_id: node_id.into(),
        start: prefix,
        delete_count: old.len() - prefix - suffix,
        insert_text: new[prefix..new.len() - suffix].iter().collect(),
        precondition: NodePrecondition {
            node_hash: node_hash.into(),
        },
    }
}

fn text_only_operations(
    current: &EditorProjection,
    requested: &[SnapshotBlock],
) -> Option<Vec<PatchOperation>> {
    let body = editor_surface(current);
    if body.len() != requested.len() {
        return None;
    }
    let mut operations = Vec::new();
    let mut seen_nodes = HashSet::new();
    for (original, desired) in body.into_iter().zip(requested) {
        if desired.block_id.as_deref() != Some(original.block_id.as_str()) {
            return None;
        }
        let desired = normalized(desired.content.clone());
        if desired == normalized(original.content.clone()) {
            continue;
        }
        let mut pairs = Vec::new();
        if !editor_inline_pairs(&original.content, &desired, &mut pairs) {
            return None;
        }
        for (before, after) in pairs {
            if before.bold != after.bold
                || before.italic != after.italic
                || before.link != after.link
                || before.text_color != after.text_color
                || before.background_color != after.background_color
                || before.border != after.border
                || before.underline != after.underline
                || before.strike != after.strike
                || before.code != after.code
                || before.hard_break != after.hard_break
                || before.typography != after.typography
                || before.font_size_explicit != after.font_size_explicit
            {
                return None;
            }
            if before.text == after.text {
                continue;
            }
            if original.read_only && before.node_id.is_none() {
                return None;
            }
            if original.read_only
                && !marginal_region(&original.region)
                && original.content.kind != EditorBlockKind::Opaque
            {
                return None;
            }
            let node_id = before.node_id.as_ref()?;
            if !seen_nodes.insert(node_id) {
                return None;
            }
            operations.push(source_text_splice(
                node_id,
                &before.text,
                &after.text,
                &hash_bytes(before.text.as_bytes()),
            ));
        }
    }
    Some(operations)
}

#[derive(Default)]
struct SourceTextChange {
    before: Vec<EditorInline>,
    after: Vec<EditorInline>,
}

#[derive(PartialEq)]
enum SourceToken {
    Node(String),
    Literal(Box<EditorInline>),
}

fn inline_without_size(inline: &EditorInline) -> EditorInline {
    let mut value = inline.clone();
    value.text.clear();
    value.node_id = None;
    value.font_size_explicit = false;
    if let Some(font) = &mut value.typography {
        font.size_pt = None;
        if font.is_empty() {
            value.typography = None;
        }
    }
    value
}

/// Source identities survive both text edits and arbitrary size-mark splits.
/// Validate order and block membership rather than guessing from text offsets.
fn source_changes(
    before: &EditorBlockContent,
    after: &EditorBlockContent,
    output: &mut BTreeMap<String, SourceTextChange>,
) -> Result<bool, HcdError> {
    if before.kind != after.kind
        || before.level != after.level
        || before.language != after.language
        || before.list_start != after.list_start
        || before.children.len() != after.children.len()
    {
        return Ok(false);
    }
    let mut original = BTreeMap::<String, Vec<EditorInline>>::new();
    let mut before_tokens = Vec::new();
    for inline in &before.inlines {
        if let Some(id) = &inline.node_id {
            let token = SourceToken::Node(id.clone());
            if before_tokens.last() != Some(&token) {
                before_tokens.push(token);
            }
            original.entry(id.clone()).or_default().push(inline.clone());
        } else {
            before_tokens.push(SourceToken::Literal(Box::new(inline.clone())));
        }
    }
    let mut desired = BTreeMap::<String, Vec<EditorInline>>::new();
    let mut after_tokens = Vec::new();
    for inline in &after.inlines {
        if let Some(id) = &inline.node_id {
            if !original.contains_key(id) {
                return Err(HcdError::InvalidPatch(
                    "source identity does not belong to this block".into(),
                ));
            }
            let token = SourceToken::Node(id.clone());
            if after_tokens.last() != Some(&token) {
                after_tokens.push(token);
            }
            desired.entry(id.clone()).or_default().push(inline.clone());
        } else {
            if !inline.hard_break
                && !inline.text.is_empty()
                && !before
                    .inlines
                    .iter()
                    .any(|original| original.node_id.is_none() && original == inline)
            {
                return Err(HcdError::InvalidPatch("source-aware text is missing its identity; retain the draft and reload the editor".into()));
            }
            after_tokens.push(SourceToken::Literal(Box::new(inline.clone())));
        }
    }
    before_tokens
        .retain(|token| !matches!(token, SourceToken::Node(id) if !desired.contains_key(id)));
    if before_tokens != after_tokens {
        return Ok(false);
    }
    for (id, before) in original {
        let after = desired.remove(&id).unwrap_or_default();
        let style = inline_without_size(&before[0]);
        if before
            .iter()
            .chain(&after)
            .any(|inline| inline_without_size(inline) != style)
        {
            return Ok(false);
        }
        if output
            .insert(id, SourceTextChange { before, after })
            .is_some()
        {
            return Err(HcdError::InvalidPatch(
                "source identity is repeated across editor blocks".into(),
            ));
        }
    }
    for (before, after) in before.children.iter().zip(&after.children) {
        if !source_changes(before, after, output)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn normalized_sizes(runs: &[hcd_core::FontSizeRun]) -> Vec<hcd_core::FontSizeRun> {
    let mut output: Vec<hcd_core::FontSizeRun> = Vec::new();
    for run in runs {
        if let Some(last) = output.last_mut().filter(|last| last.size_pt == run.size_pt) {
            last.chars += run.chars;
        } else {
            output.push(run.clone());
        }
    }
    output
}

fn source_run_operations(
    bundle: &Bundle,
    current: &EditorProjection,
    requested: &[SnapshotBlock],
) -> Result<Option<Vec<PatchOperation>>, HcdError> {
    let head = bundle.manifest()?;
    if !["docx", "html", "md", "txt"].contains(&head.source.format.as_str()) {
        return Ok(None);
    }
    let body = editor_surface(current);
    if body.len() != requested.len() {
        return Ok(None);
    }
    let mut nodes = BTreeMap::new();
    for (original, desired) in body.into_iter().zip(requested) {
        if desired.block_id.as_deref() != Some(&original.block_id) {
            return Ok(None);
        }
        if normalized(desired.content.clone()) == normalized(original.content.clone()) {
            continue;
        }
        if original.read_only || marginal_region(&original.region) {
            return Ok(None);
        }
        if !source_changes(&original.content, &desired.content, &mut nodes)? {
            return Ok(None);
        }
    }
    if nodes.is_empty() {
        return Ok(None);
    }
    let (manifest, _) = manifest_at_revision(bundle, &head, Some(current.revision))?;
    let mut operations = Vec::new();
    let mut found = HashSet::new();
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(&manifest, page_number)?.chunks {
            if !nodes
                .keys()
                .any(|id| hcd_core::node_bloom_might_contain(&descriptor.node_bloom, id))
            {
                continue;
            }
            let map = bundle.read_map_verified(&descriptor)?;
            if !map
                .entries
                .iter()
                .any(|entry| nodes.contains_key(&entry.node_id))
            {
                continue;
            }
            let html = bundle.read_chunk_verified(&descriptor)?;
            let texts = hcd_core::extract_html_text_nodes(&html)?;
            let formats = hcd_core::extract_text_run_sizes(&html)?;
            let hashes = hcd_core::text_format_hashes(&html)?;
            for entry in map
                .entries
                .iter()
                .filter(|entry| nodes.contains_key(&entry.node_id))
            {
                if !entry.source.editable || entry.source.node_kind == "image" {
                    return Ok(None);
                }
                let change = &nodes[&entry.node_id];
                let original: String = change
                    .before
                    .iter()
                    .map(|inline| inline.text.as_str())
                    .collect();
                let text: String = change
                    .after
                    .iter()
                    .map(|inline| inline.text.as_str())
                    .collect();
                let base_font = &change.before[0].typography;
                let base_explicit = change.before[0].font_size_explicit;
                let font_unchanged = change.before.iter().chain(&change.after).all(|inline| {
                    &inline.typography == base_font && inline.font_size_explicit == base_explicit
                });
                if texts.get(&entry.node_id) != Some(&original)
                    || hash_bytes(original.as_bytes()) != entry.node_hash
                    || !found.insert(entry.node_id.clone())
                {
                    return Err(HcdError::InvalidBundle(
                        "source identity does not match canonical text".into(),
                    ));
                }
                if head.source.format != "docx" || entry.source.node_kind != "text" {
                    if !font_unchanged {
                        return Ok(None);
                    }
                    if text != original {
                        operations.push(source_text_splice(
                            &entry.node_id,
                            &original,
                            &text,
                            &entry.node_hash,
                        ));
                    }
                    continue;
                }
                let mut runs = Vec::new();
                for inline in &change.after {
                    if inline.text.is_empty() {
                        continue;
                    }
                    let size_pt = if inline.font_size_explicit {
                        Some(
                            inline
                                .typography
                                .as_ref()
                                .and_then(|font| font.size_pt)
                                .ok_or_else(|| {
                                    HcdError::InvalidPatch("explicit size has no sizePt".into())
                                })?,
                        )
                    } else {
                        None
                    };
                    runs.push(hcd_core::FontSizeRun {
                        chars: inline.text.chars().count(),
                        size_pt,
                    });
                }
                let runs = normalized_sizes(&runs);
                let old = formats.get(&entry.node_id).cloned().unwrap_or_else(|| {
                    if original.is_empty() {
                        vec![]
                    } else {
                        vec![hcd_core::FontSizeRun {
                            chars: original.chars().count(),
                            size_pt: None,
                        }]
                    }
                });
                if text == original && runs == normalized_sizes(&old) {
                    continue;
                }
                if !formats.contains_key(&entry.node_id)
                    && runs.iter().all(|run| run.size_pt.is_none())
                {
                    operations.push(source_text_splice(
                        &entry.node_id,
                        &original,
                        &text,
                        &entry.node_hash,
                    ));
                } else {
                    operations.push(PatchOperation::TextRuns {
                        node_id: entry.node_id.clone(),
                        text,
                        runs,
                        precondition: hcd_core::TextRunsPrecondition {
                            node_hash: entry.node_hash.clone(),
                            format_hash: hashes
                                .get(&entry.node_id)
                                .ok_or_else(|| {
                                    HcdError::InvalidBundle("source format hash absent".into())
                                })?
                                .clone(),
                        },
                    });
                }
            }
        }
    }
    if found.len() != nodes.len() {
        return Err(HcdError::InvalidBundle(
            "editor source identity is absent".into(),
        ));
    }
    Ok((!operations.is_empty()).then_some(operations))
}

fn presentation_style_operations(
    current: &EditorProjection,
    requested: &[SnapshotBlock],
) -> Option<Vec<PatchOperation>> {
    let body = editor_surface(current);
    if body.len() != requested.len() {
        return None;
    }
    let mut operations = Vec::new();
    let mut seen_nodes = HashSet::new();
    for (original, desired) in body.into_iter().zip(requested) {
        if desired.block_id.as_deref() != Some(original.block_id.as_str()) {
            return None;
        }
        let desired = normalized(desired.content.clone());
        if desired == normalized(original.content.clone()) {
            continue;
        }
        if desired.kind != original.content.kind
            || desired.level != original.content.level
            || desired.children != normalized(original.content.clone()).children
            || desired.language != original.content.language
            || desired.list_start != original.content.list_start
            || desired.inlines.len() != original.content.inlines.len()
        {
            return None;
        }
        if marginal_region(&original.region) {
            let changed = original
                .content
                .inlines
                .iter()
                .zip(&desired.inlines)
                .any(|(before, after)| before != after);
            if changed {
                return None;
            }
            continue;
        }
        if original.read_only && original.content.kind != EditorBlockKind::Opaque {
            return None;
        }
        for (before, after) in original.content.inlines.iter().zip(&desired.inlines) {
            if before.text != after.text
                || before.bold != after.bold
                || before.italic != after.italic
                || before.link != after.link
                || before.underline != after.underline
                || before.strike != after.strike
                || before.code != after.code
                || before.hard_break != after.hard_break
                || before.typography != after.typography
                || before.font_size_explicit != after.font_size_explicit
            {
                return None;
            }
            let clears_text = before.text_color.is_some() && after.text_color.is_none();
            let clears_background =
                before.background_color.is_some() && after.background_color.is_none();
            let clears_border = before.border.is_some() && after.border.is_none();
            if clears_text || clears_background || clears_border {
                return None;
            }
            if before.text_color == after.text_color
                && before.background_color == after.background_color
                && before.border == after.border
            {
                continue;
            }
            let node_id = before.node_id.clone()?;
            if !seen_nodes.insert(node_id.clone()) {
                return None;
            }
            operations.push(PatchOperation::NodeStyle {
                node_id,
                style: NodeStylePatch {
                    text_color: (before.text_color != after.text_color)
                        .then(|| after.text_color.clone())
                        .flatten(),
                    background_color: (before.background_color != after.background_color)
                        .then(|| after.background_color.clone())
                        .flatten(),
                    border: (before.border != after.border)
                        .then(|| after.border.clone())
                        .flatten(),
                },
                precondition: NodePrecondition {
                    node_hash: hash_bytes(before.text.as_bytes()),
                },
            });
        }
    }
    (!operations.is_empty()).then_some(operations)
}

fn author_actor(claims: &Claims, contributors: &[Contributor]) -> BTreeMap<String, String> {
    let mut people = Vec::new();
    let service = claims.sub.as_deref() == Some("hcd-collaboration");
    if !service {
        if let Some(id) = claims.sub.clone().filter(|id| valid_id(id)) {
            let name = claims
                .name
                .clone()
                .filter(|name| valid_display_name(name))
                .unwrap_or_else(|| id.clone());
            people.push((id, name));
        }
    } else {
        for person in contributors.iter().take(16) {
            if !valid_id(&person.user_id) || !valid_display_name(&person.display_name) {
                continue;
            }
            if people.iter().any(|(id, _)| id == &person.user_id) {
                continue;
            }
            people.push((person.user_id.clone(), person.display_name.clone()));
        }
    }
    let mut actor = BTreeMap::new();
    if let Some((id, _)) = people.first() {
        actor.insert("userId".to_string(), id.clone());
    }
    if !people.is_empty() {
        let mut joined = people
            .iter()
            .map(|(_, name)| name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        if joined.len() > 256 {
            let mut end = 256;
            while !joined.is_char_boundary(end) {
                end -= 1;
            }
            joined.truncate(end);
        }
        actor.insert("displayName".to_string(), joined);
    }
    actor
}

fn valid_display_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && !name.chars().any(char::is_control)
}

fn require_typography_support(
    current: &EditorProjection,
    version: Option<u32>,
) -> Result<(), ApiError> {
    fn has_typography(content: &EditorBlockContent) -> bool {
        content.inlines.iter().any(|inline| {
            inline
                .typography
                .as_ref()
                .is_some_and(|font| !font.is_empty())
        }) || content.children.iter().any(has_typography)
    }
    if version.is_some_and(|value| value != 2)
        || (version != Some(2)
            && current
                .blocks
                .iter()
                .any(|block| has_typography(&block.content)))
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "typography-aware editor required; no content was saved".into(),
        ));
    }
    Ok(())
}

fn coordinator_patch_id(
    state: &ServerState,
    id: &str,
    epoch: u64,
    request: &SnapshotRequest,
) -> Result<String, ApiError> {
    fn hex(value: Option<&str>, length: usize) -> Option<&str> {
        value.filter(|value| {
            value.len() == length
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    }
    let coordinator =
        hex(request.coordinator_id.as_deref(), 32).ok_or_else(|| bad("invalid coordinatorId"))?;
    let attempt =
        hex(request.checkpoint_id.as_deref(), 32).ok_or_else(|| bad("invalid checkpointId"))?;
    let digest = hex(request.coordinator_digest.as_deref(), 64)
        .ok_or_else(|| bad("invalid coordinatorDigest"))?;
    // Preserve existing text-only signed receipts. New combined attempts bind
    // both exact bodies, so a retry cannot silently replace image properties.
    let body = if request.images.is_empty() {
        serde_json::to_vec(&request.blocks)
    } else {
        serde_json::to_vec(&json!({"blocks": request.blocks, "images": request.images}))
    };
    let body_hash = hash_bytes(&body.map_err(internal)?);
    let unsigned = format!("hcdsave4:{coordinator}:{attempt}:{digest}:{body_hash}");
    let message = format!("{id}:{epoch}:{}:{unsigned}", request.expected_revision);
    let mac = jsonwebtoken::crypto::sign(
        message.as_bytes(),
        &EncodingKey::from_secret(&state.secret),
        Algorithm::HS256,
    )
    .map_err(internal)?;
    // <= 256 bytes, with a full HMAC. The immutable revision ID records the
    // lineage and exact attempt without adding mutable save receipts to HCD.
    Ok(format!("{unsigned}:{mac}"))
}

fn checkpoint_images(
    bundle: &Bundle,
    images: &[SnapshotImage],
    revision: u64,
) -> Result<Vec<Value>, ApiError> {
    let head = bundle.manifest().map_err(internal)?;
    let (manifest, _) = manifest_at_revision(bundle, &head, Some(revision)).map_err(hcd_error)?;
    images.iter().map(|image| {
        let node = hcd_core::get_image_node_in_manifest(bundle, &image.node_id, &manifest).map_err(hcd_error)?.node;
        Ok(json!({"nodeId":node.node_id,"visualHash":node.visual_hash,"assetHash":node.asset_hash,"geometry":node.geometry}))
    }).collect()
}

async fn finish_checkpoint(
    state: &ServerState,
    id: &str,
    bundle: &Bundle,
    result: hcd_core::ApplyResult,
    previous: u64,
    images: &[SnapshotImage],
    mode: &str,
) -> Result<Json<Value>, ApiError> {
    if !result.idempotent_replay {
        publish_mutation(state, id, bundle, previous).await?;
    }
    let projection = editor_projection(bundle, Some(result.revision)).map_err(internal)?;
    let saved_images = checkpoint_images(bundle, images, result.revision)?;
    Ok(Json(
        json!({"saved":true,"revision":result.revision,"rootHash":result.root_hash,
        "projection":projection,"images":saved_images,"saveMode":mode}),
    ))
}

async fn checkpoint(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<SnapshotRequest>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    // Old browser/sidecar snapshots could pair stale content with a freshly
    // polled revision. Only the room coordinator may submit full snapshots.
    if request.coordinator_version != Some(4) || claims.sub.as_deref() != Some("hcd-collaboration")
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "full snapshots require the HCD save coordinator".into(),
        ));
    }
    let _guard = state.collaboration_lock.lock().await;
    let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
    let checkpoint_id = coordinator_patch_id(&state, &id, epoch, &request)?;
    let actor = author_actor(&claims, &request.contributors);
    if request.images.len() > 1000 {
        return Err(bad("snapshot image limit exceeded"));
    }
    let mut image_ids = HashSet::new();
    if request
        .images
        .iter()
        .any(|image| !image_ids.insert(&image.node_id))
    {
        return Err(bad("duplicate image in snapshot"));
    }
    if request.blocks.len() > 1_000_000 {
        return Err(bad("snapshot block limit exceeded"));
    }
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    if let Some(number) = request
        .expected_revision
        .checked_add(1)
        .filter(|number| *number <= head.revision)
    {
        let record = bundle.revision(number).map_err(internal)?;
        if record.patch_id.as_deref() == Some(&checkpoint_id) {
            let projection = editor_projection(&bundle, Some(number)).map_err(internal)?;
            return Ok(Json(
                json!({"saved": true, "revision": number, "rootHash": record.root_hash,
                "projection": projection, "images": checkpoint_images(&bundle, &request.images, number)?, "saveMode": "replayed", "idempotentReplay": true}),
            ));
        }
    }
    let current = editor_projection(&bundle, None).map_err(bad)?;
    require_typography_support(&current, request.typography_version)?;
    if current.revision != request.expected_revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            format!(
                "expected revision {}, current {}",
                request.expected_revision, current.revision
            ),
        ));
    }
    let mut image_operations = Vec::new();
    for image in &request.images {
        let original = get_image_node(&bundle, &image.node_id).map_err(hcd_error)?;
        if original.node.visual_hash != image.precondition.visual_hash {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "image changed since this draft was created".into(),
            ));
        }
        let patch = prepare_image_geometry(
            &id,
            image.node_id.clone(),
            current.revision,
            &original.node,
            image.geometry.clone(),
            BTreeMap::new(),
        )?;
        image_operations.extend(patch.operations);
        if let Some(asset_hash) = &image.asset_hash {
            image_operations.push(PatchOperation::ImageReplace {
                node_id: image.node_id.clone(),
                asset_hash: asset_hash.clone(),
                precondition: image.precondition.clone(),
            });
        }
    }
    let current_root = bundle
        .revision(current.revision)
        .map_err(internal)?
        .root_hash;
    if let Some(mut operations) =
        source_run_operations(&bundle, &current, &request.blocks).map_err(hcd_error)?
    {
        operations.extend(image_operations.clone());
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_5.into(),
            document_id: id.clone(),
            patch_id: checkpoint_id.clone(),
            base_revision: current.revision,
            actor: actor.clone(),
            operations,
            metadata: Default::default(),
        };
        let result = apply_patch(&bundle, &patch, current.revision).map_err(hcd_error)?;
        return finish_checkpoint(
            &state,
            &id,
            &bundle,
            result,
            current.revision,
            &request.images,
            "source-runs",
        )
        .await;
    }
    if let Some(mut operations) = text_only_operations(&current, &request.blocks) {
        operations.extend(image_operations.clone());
        if operations.is_empty() {
            return Ok(Json(
                json!({"saved": true, "revision": current.revision, "rootHash": current_root,
                "projection": current, "images": [], "saveMode": "unchanged"}),
            ));
        }
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_5.to_string(),
            document_id: id.clone(),
            patch_id: checkpoint_id.clone(),
            base_revision: current.revision,
            actor: actor.clone(),
            operations,
            metadata: Default::default(),
        };
        let result = apply_patch(&bundle, &patch, current.revision).map_err(hcd_error)?;
        return finish_checkpoint(
            &state,
            &id,
            &bundle,
            result,
            current.revision,
            &request.images,
            "source-text",
        )
        .await;
    }
    if let Some(mut operations) = presentation_style_operations(&current, &request.blocks) {
        operations.extend(image_operations);
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_5.to_string(),
            document_id: id.clone(),
            patch_id: checkpoint_id.clone(),
            base_revision: current.revision,
            actor: actor.clone(),
            operations,
            metadata: Default::default(),
        };
        let result = apply_patch(&bundle, &patch, current.revision).map_err(hcd_error)?;
        return finish_checkpoint(
            &state,
            &id,
            &bundle,
            result,
            current.revision,
            &request.images,
            "presentation-style",
        )
        .await;
    }
    let existing: HashMap<&str, _> = current
        .blocks
        .iter()
        .filter(|block| block.region == "body")
        .map(|block| (block.block_id.as_str(), block))
        .collect();
    let marginal: HashMap<&str, _> = current
        .blocks
        .iter()
        .filter(|block| marginal_region(&block.region))
        .map(|block| (block.block_id.as_str(), block))
        .collect();
    let mut desired_seen = HashSet::new();
    let mut desired_known = Vec::new();
    for block in &request.blocks {
        if let Some(block_id) = &block.block_id {
            if let Some(original) = marginal.get(block_id.as_str()) {
                if !desired_seen.insert(block_id.as_str()) {
                    return Err(bad("duplicate block ID in snapshot"));
                }
                if normalized(block.content.clone()) != normalized(original.content.clone()) {
                    return Err(bad(
                        "header, footer, and note text must be saved as a text splice",
                    ));
                }
                continue;
            }
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
    if marginal
        .keys()
        .any(|block_id| !desired_seen.contains(block_id))
    {
        return Err(bad("header, footer, or note block was removed"));
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
        if block.block_id.as_ref().is_some_and(|value| {
            existing.contains_key(value.as_str()) || marginal.contains_key(value.as_str())
        }) {
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
    operations.extend(request.images.iter().map(|image| match &image.asset_hash {
        Some(asset_hash) => StructureOperation::ImageReplace {
            node_id: image.node_id.clone(),
            asset_hash: asset_hash.clone(),
            geometry: Some(image.geometry.clone()),
            precondition: image.precondition.clone(),
        },
        None => StructureOperation::ImageGeometry {
            node_id: image.node_id.clone(),
            geometry: image.geometry.clone(),
            precondition: image.precondition.clone(),
        },
    }));
    if operations.is_empty() {
        return Ok(Json(
            json!({"saved": true, "revision": current.revision, "rootHash": current_root, "projection": current}),
        ));
    }
    let patch = StructurePatchBatch {
        schema_version: HCD_PATCH_SCHEMA_VERSION_4.to_string(),
        document_id: id.clone(),
        patch_id: checkpoint_id,
        base_revision: current.revision,
        actor,
        operations,
    };
    let result = apply_structure_patch(&bundle, &patch, current.revision).map_err(hcd_error)?;
    finish_checkpoint(
        &state,
        &id,
        &bundle,
        result,
        current.revision,
        &request.images,
        "semantic-structure",
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetExtensionQuery {
    extension: String,
}

fn image_magic(extension: &str, bytes: &[u8]) -> bool {
    match extension {
        "png" => bytes.len() >= 8 && bytes[..8] == [137, 80, 78, 71, 13, 10, 26, 10],
        "jpg" | "jpeg" => bytes.len() >= 3 && bytes[..3] == [0xff, 0xd8, 0xff],
        "gif" => bytes.len() >= 6 && matches!(&bytes[..6], b"GIF87a" | b"GIF89a"),
        "webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

async fn stage_image(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<AssetExtensionQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, true)?;
    let extension = query.extension.to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
        return Err(bad("staged image must be PNG, JPEG, GIF, or WebP"));
    }
    if body.is_empty() || body.len() > 8 * 1024 * 1024 {
        return Err(bad("staged image must be between 1 byte and 8 MiB"));
    }
    if !image_magic(&extension, &body) {
        return Err(bad("image content does not match its extension"));
    }
    let bundle = open(&state, &id)?;
    let descriptor = bundle
        .stage_asset_from_reader(&extension, &mut std::io::Cursor::new(body.as_ref()))
        .map_err(hcd_error)?;
    Ok(Json(serde_json::to_value(descriptor).map_err(internal)?))
}

async fn images(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let page = extract_image_page(&open(&state, &id)?, None, 50).map_err(bad)?;
    Ok(Json(serde_json::to_value(page).map_err(internal)?))
}

async fn text_node(
    State(state): State<ServerState>,
    Path((id, node_id)): Path<(String, String)>,
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    let (manifest, _) = manifest_at_revision(&bundle, &head, query.revision).map_err(hcd_error)?;
    let node =
        hcd_core::get_text_node_in_manifest(&bundle, &node_id, &manifest).map_err(hcd_error)?;
    Ok(Json(serde_json::to_value(node).map_err(internal)?))
}

async fn image(
    State(state): State<ServerState>,
    Path((id, node_id)): Path<(String, String)>,
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    // Read one immutable head: a concurrent update must not label old geometry
    // with a newer revision. A missing object is an explicit draft conflict.
    let head = bundle.manifest().map_err(internal)?;
    let (manifest, _) = manifest_at_revision(&bundle, &head, query.revision).map_err(hcd_error)?;
    let page = match hcd_core::get_image_node_in_manifest(&bundle, &node_id, &manifest) {
        Ok(found) => Some(found.node),
        Err(HcdError::NodeNotFound(_)) => None,
        Err(error) => return Err(hcd_error(error)),
    };
    Ok(Json(json!({"revision": manifest.revision, "image": page})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageReplaceRequest {
    expected_revision: u64,
    #[serde(default)]
    expected_visual_hash: Option<String>,
    asset_hash: String,
}

fn require_image_base(
    current: &hcd_core::ImageNodeState,
    expected: Option<&str>,
) -> Result<(), ApiError> {
    match expected {
        None => Err(ApiError(
            StatusCode::PRECONDITION_REQUIRED,
            "expectedVisualHash is required for image edits".into(),
        )),
        Some(hash) if hash != current.visual_hash => Err(ApiError(
            StatusCode::CONFLICT,
            "image changed since this draft was created".into(),
        )),
        Some(_) => Ok(()),
    }
}

async fn replace_image(
    State(state): State<ServerState>,
    Path((id, node_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(request): Json<ImageReplaceRequest>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    if head.revision != request.expected_revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            format!(
                "expected revision {}, current {}",
                request.expected_revision, head.revision
            ),
        ));
    }
    let image = get_image_node(&bundle, &node_id).map_err(hcd_error)?;
    require_image_base(&image.node, request.expected_visual_hash.as_deref())?;
    let patch = PatchBatch {
        schema_version: HCD_PATCH_SCHEMA_VERSION_3.to_string(),
        document_id: id.clone(),
        patch_id: format!("image-{}", uuid::Uuid::new_v4()),
        base_revision: request.expected_revision,
        actor: author_actor(&claims, &[]),
        operations: vec![PatchOperation::ImageReplace {
            node_id,
            asset_hash: request.asset_hash,
            precondition: VisualPrecondition {
                visual_hash: image.node.visual_hash,
            },
        }],
        metadata: Default::default(),
    };
    let plan = if head.source.format == "pdf" {
        let source = state.root.join("sources").join(format!("{id}.pdf"));
        hcd_formats::plan_pdf_page_rasters(&bundle, &source, &patch.operations)
            .map_err(hcd_error)?
    } else {
        hcd_core::PdfRasterPlan::default()
    };
    let result =
        hcd_core::apply_patch_with_pdf_rasters(&bundle, &patch, request.expected_revision, plan)
            .map_err(hcd_error)?;
    publish_mutation(&state, &id, &bundle, request.expected_revision).await?;
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageGeometryRequest {
    expected_revision: u64,
    #[serde(default)]
    expected_visual_hash: Option<String>,
    geometry: ImageGeometry,
}

fn prepare_image_geometry(
    document_id: &str,
    node_id: String,
    expected_revision: u64,
    current: &hcd_core::ImageNodeState,
    geometry: ImageGeometry,
    actor: BTreeMap<String, String>,
) -> Result<PatchBatch, ApiError> {
    let Some(existing) = &current.geometry else {
        return Err(bad("this image has no stored geometry to edit"));
    };
    if existing.unit != geometry.unit {
        return Err(bad("image geometry must keep the stored coordinate unit"));
    }
    if !geometry.x.is_finite()
        || !geometry.y.is_finite()
        || !geometry.width.is_finite()
        || !geometry.height.is_finite()
        || geometry.width <= 0.0
        || geometry.height <= 0.0
    {
        return Err(bad(
            "image geometry must be finite and have positive width and height",
        ));
    }
    Ok(PatchBatch {
        schema_version: HCD_PATCH_SCHEMA_VERSION_3.to_string(),
        document_id: document_id.to_string(),
        patch_id: format!("geometry-{}", uuid::Uuid::new_v4()),
        base_revision: expected_revision,
        actor,
        operations: vec![PatchOperation::ImageGeometry {
            node_id,
            geometry,
            precondition: VisualPrecondition {
                visual_hash: current.visual_hash.clone(),
            },
        }],
        metadata: Default::default(),
    })
}

async fn move_image(
    State(state): State<ServerState>,
    Path((id, node_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(request): Json<ImageGeometryRequest>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    if head.revision != request.expected_revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            format!(
                "expected revision {}, current {}",
                request.expected_revision, head.revision
            ),
        ));
    }
    let image = get_image_node(&bundle, &node_id).map_err(hcd_error)?;
    require_image_base(&image.node, request.expected_visual_hash.as_deref())?;
    let patch = prepare_image_geometry(
        &id,
        node_id,
        request.expected_revision,
        &image.node,
        request.geometry,
        author_actor(&claims, &[]),
    )?;
    let plan = if head.source.format == "pdf" {
        let source = state.root.join("sources").join(format!("{id}.pdf"));
        hcd_formats::plan_pdf_page_rasters(&bundle, &source, &patch.operations)
            .map_err(hcd_error)?
    } else {
        hcd_core::PdfRasterPlan::default()
    };
    let result =
        hcd_core::apply_patch_with_pdf_rasters(&bundle, &patch, request.expected_revision, plan)
            .map_err(hcd_error)?;
    publish_mutation(&state, &id, &bundle, request.expected_revision).await?;
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}

fn prepare_text_patch(
    mut patch: PatchBatch,
    id: &str,
    actor: BTreeMap<String, String>,
) -> Result<PatchBatch, ApiError> {
    if patch.document_id != id {
        return Err(bad("text patch document ID mismatch"));
    }
    if patch.schema_version != HCD_PATCH_SCHEMA_VERSION {
        return Err(bad("text patches use schemaVersion hcd-patch/1"));
    }
    if patch.operations.is_empty()
        || patch
            .operations
            .iter()
            .any(|operation| !matches!(operation, PatchOperation::TextSplice { .. }))
    {
        return Err(bad("this endpoint accepts only text.splice operations"));
    }
    patch.actor = actor;
    patch.metadata.clear();
    Ok(patch)
}

async fn text_patch(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<PatchBatch>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    let patch = prepare_text_patch(request, &id, author_actor(&claims, &[]))?;
    apply_editor_edits(&state, &id, patch).await
}

fn prepare_editor_edits(
    mut patch: PatchBatch,
    id: &str,
    actor: BTreeMap<String, String>,
) -> Result<PatchBatch, ApiError> {
    if patch.document_id != id
        || ![
            HCD_PATCH_SCHEMA_VERSION_3,
            hcd_core::HCD_PATCH_SCHEMA_VERSION_5,
        ]
        .contains(&patch.schema_version.as_str())
    {
        return Err(bad(
            "editor edits require the document ID and schemaVersion hcd-patch/3 or hcd-patch/5",
        ));
    }
    if patch.operations.is_empty()
        || patch.operations.iter().any(|operation| {
            !matches!(
                operation,
                PatchOperation::TextSplice { .. }
                    | PatchOperation::TextRuns { .. }
                    | PatchOperation::ImageReplace { .. }
                    | PatchOperation::ImageRestoreSource { .. }
                    | PatchOperation::ImageGeometry { .. }
            )
        })
    {
        return Err(bad(
            "editor edits accept only text.splice, text.runs, image.replace, image.restoreSource and image.geometry operations",
        ));
    }
    if patch.schema_version != hcd_core::HCD_PATCH_SCHEMA_VERSION_5
        && patch
            .operations
            .iter()
            .any(|operation| matches!(operation, PatchOperation::TextRuns { .. }))
    {
        return Err(bad("text.runs requires schemaVersion hcd-patch/5"));
    }
    patch.actor = actor;
    patch.metadata.clear();
    Ok(patch)
}

async fn editor_edits(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<PatchBatch>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    let patch = prepare_editor_edits(request, &id, author_actor(&claims, &[]))?;
    apply_editor_edits(&state, &id, patch).await
}

/// Read-only resolution of a potentially committed request. Validate its entire
/// canonical payload, restoring only the server-recorded attribution so a
/// display-name change cannot make the caller's own receipt unrecognizable.
async fn editor_edits_receipt(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<PatchBatch>,
) -> Result<Json<Value>, ApiError> {
    let claims = claims(&state, &headers, &id)?;
    let mut patch = prepare_editor_edits(request, &id, author_actor(&claims, &[]))?;
    if patch.patch_id.is_empty() || patch.patch_id.len() > 256 {
        return Err(bad("invalid edit request identity"));
    }
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    for revision in 1..=head.revision {
        let record = bundle.revision(revision).map_err(hcd_error)?;
        if record.patch_id.as_deref() != Some(patch.patch_id.as_str()) {
            continue;
        }
        if record.author_id.as_deref() != patch.actor.get("userId").map(String::as_str) {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "edit receipt belongs to another author".into(),
            ));
        }
        patch.actor.clear();
        if let Some(author) = record.author_id {
            patch.actor.insert("userId".into(), author);
        }
        if let Some(name) = record.author_name {
            patch.actor.insert("displayName".into(), name);
        }
        if record.patch_hash.as_deref()
            != Some(&hash_bytes(&serde_json::to_vec(&patch).map_err(internal)?))
        {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "edit identity was used with a different payload".into(),
            ));
        }
        let body = json!({"status":"committed", "revision":record.revision,"baseRevision":record.patch_base_revision,
            "patchId":patch.patch_id,"idempotentReplay":true});
        return editor_edits_saved_response(&bundle, &patch, body);
    }
    Ok(Json(json!({"status":"missing","patchId":patch.patch_id})))
}

fn editor_edits_saved_response(
    bundle: &Bundle,
    patch: &PatchBatch,
    mut body: Value,
) -> Result<Json<Value>, ApiError> {
    let revision = body["revision"]
        .as_u64()
        .ok_or_else(|| internal("missing saved revision"))?;
    let head = bundle.manifest().map_err(internal)?;
    let (saved_manifest, _) =
        manifest_at_revision(bundle, &head, Some(revision)).map_err(hcd_error)?;
    let mut image_ids = std::collections::BTreeSet::new();
    let mut text_ids = std::collections::BTreeSet::new();
    for operation in &patch.operations {
        match operation {
            PatchOperation::ImageGeometry { node_id, .. }
            | PatchOperation::ImageReplace { node_id, .. }
            | PatchOperation::ImageRestoreSource { node_id, .. } => {
                image_ids.insert(node_id);
            }
            PatchOperation::TextSplice { node_id, .. }
            | PatchOperation::TextRuns { node_id, .. } => {
                text_ids.insert(node_id);
            }
            _ => {}
        }
    }
    let mut images = Vec::new();
    for id in image_ids {
        let node =
            hcd_core::get_image_node_in_manifest(bundle, id, &saved_manifest).map_err(hcd_error)?;
        images.push(serde_json::to_value(node.node).map_err(internal)?);
    }
    let mut hashes = serde_json::Map::new();
    let mut formats = serde_json::Map::new();
    for id in text_ids {
        let node =
            hcd_core::get_text_node_in_manifest(bundle, id, &saved_manifest).map_err(hcd_error)?;
        hashes.insert(id.clone(), json!(node.node.node_hash));
        formats.insert(id.clone(), json!(node.format_hash));
    }
    body["nodeHashes"] = Value::Object(hashes);
    body["formatHashes"] = Value::Object(formats);
    body["images"] = Value::Array(images);
    Ok(Json(body))
}

async fn apply_editor_edits(
    state: &ServerState,
    id: &str,
    patch: PatchBatch,
) -> Result<Json<Value>, ApiError> {
    let bundle = open(state, id)?;
    let previous = patch.base_revision;
    let manifest = bundle.manifest().map_err(internal)?;
    let (base_manifest, _) =
        manifest_at_revision(&bundle, &manifest, Some(previous)).map_err(hcd_error)?;
    // Capture the receipt from the same base as the requested transaction.
    // The core checks revision + visualHash again under its document write lock.
    for operation in &patch.operations {
        if let PatchOperation::ImageGeometry {
            node_id,
            precondition,
            ..
        }
        | PatchOperation::ImageReplace {
            node_id,
            precondition,
            ..
        }
        | PatchOperation::ImageRestoreSource {
            node_id,
            precondition,
        } = operation
        {
            let current = hcd_core::get_image_node_in_manifest(&bundle, node_id, &base_manifest)
                .map_err(hcd_error)?;
            if current.revision != previous || current.node.visual_hash != precondition.visual_hash
            {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "image changed since this draft was created".into(),
                ));
            }
            if let PatchOperation::ImageGeometry { geometry, .. } = operation {
                prepare_image_geometry(
                    id,
                    node_id.clone(),
                    previous,
                    &current.node,
                    geometry.clone(),
                    BTreeMap::new(),
                )?;
            }
        }
    }
    // Old-base requests can only replay an immutable receipt or fail CAS. Do
    // not re-plan their text against a later PDF head before core replay checks.
    let raster_plan = if manifest.source.format == "pdf" && previous == manifest.revision {
        let source = state.root.join("sources").join(format!("{id}.pdf"));
        hcd_formats::plan_pdf_page_rasters(&bundle, &source, &patch.operations)
            .map_err(hcd_error)?
    } else {
        hcd_core::PdfRasterPlan::default()
    };
    let result = hcd_core::apply_patch_with_pdf_rasters(&bundle, &patch, previous, raster_plan)
        .map_err(hcd_error)?;
    if !result.idempotent_replay {
        publish_mutation(state, id, &bundle, previous).await?;
        if manifest.profile == "semantic-flow"
            && patch.operations.iter().any(|operation| {
                matches!(
                    operation,
                    PatchOperation::TextSplice { .. } | PatchOperation::TextRuns { .. }
                )
            })
        {
            reset_collaboration(state, id).await?;
        }
    }
    editor_edits_saved_response(
        &bundle,
        &patch,
        serde_json::to_value(&result).map_err(internal)?,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackedChangeRequest {
    expected_revision: u64,
    change_id: String,
    action: String,
    patch_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentReplyRequest {
    expected_revision: u64,
    text: String,
    patch_id: String,
}

async fn resolve_change(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<TrackedChangeRequest>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    let accept = match request.action.as_str() {
        "accept" => true,
        "reject" => false,
        _ => return Err(bad("action must be accept or reject")),
    };
    let bundle = open(&state, &id)?;
    let result = resolve_tracked_change(
        &bundle,
        request.expected_revision,
        &request.change_id,
        accept,
        &request.patch_id,
        &author_actor(&claims, &[]),
    )
    .map_err(hcd_error)?;
    if !result.idempotent_replay {
        publish_mutation(&state, &id, &bundle, request.expected_revision).await?;
        reset_collaboration(&state, &id).await?;
    }
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}

async fn reply_comment(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<CommentReplyRequest>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    let bundle = open(&state, &id)?;
    let result = append_comment(
        &bundle,
        request.expected_revision,
        &request.text,
        &request.patch_id,
        &author_actor(&claims, &[]),
    )
    .map_err(hcd_error)?;
    if !result.idempotent_replay {
        publish_mutation(&state, &id, &bundle, request.expected_revision).await?;
        reset_collaboration(&state, &id).await?;
    }
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct RevisionEvent {
    revision: u64,
    patch_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_name: Option<String>,
    nodes: Vec<RevisionNode>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    reset: bool,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    node_hashes: BTreeMap<String, Option<String>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RevisionNode {
    node_id: String,
    text: String,
    node_hash: String,
}

#[derive(Clone, Default)]
struct RevisionHub {
    senders: Arc<std::sync::Mutex<HashMap<String, broadcast::Sender<u64>>>>,
}

impl RevisionHub {
    fn subscribe(&self, id: &str) -> broadcast::Receiver<u64> {
        let mut senders = self.senders.lock().unwrap_or_else(|p| p.into_inner());
        senders.retain(|_, sender| sender.receiver_count() > 0);
        senders
            .entry(id.to_string())
            .or_insert_with(|| broadcast::channel(64).0)
            .subscribe()
    }

    fn publish(&self, id: &str, revision: u64) {
        let senders = self.senders.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(sender) = senders.get(id) {
            let _ = sender.send(revision);
        }
    }
}

fn authorize_claims(
    state: &ServerState,
    headers: &HeaderMap,
    id: &str,
) -> Result<Claims, ApiError> {
    let claims = claims(state, headers, id)?;
    if claims.scope != "write" {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "read-only token cannot write".to_string(),
        ));
    }
    Ok(claims)
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
    authorize(&state, &headers, &id, true)?;
    let bundle = open(&state, &id)?;
    let (author_id, author_name) =
        revision_author(&author_actor(&claims(&state, &headers, &id)?, &[])).map_err(bad)?;
    let result = restore_revision(
        &bundle,
        number,
        request.expected_revision,
        author_id,
        author_name,
    )
    .map_err(hcd_error)?;
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
    if let Some(remote) = &state.remote {
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
    }
    state
        .revisions
        .publish(id, bundle.manifest().map_err(internal)?.revision);
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
    asset_response(&bundle, &descriptor, &hash).await
}

async fn staged_image(
    State(state): State<ServerState>,
    Path((id, hash)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(bad("invalid asset hash"));
    }
    let bundle = open(&state, &id)?;
    let descriptor = bundle.staged_asset(&hash).map_err(|error| match error {
        HcdError::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
            ApiError(StatusCode::NOT_FOUND, "staged image not found".into())
        }
        other => hcd_error(other),
    })?;
    if descriptor.hash != hash {
        return Err(internal("staged image descriptor hash mismatch"));
    }
    asset_response(&bundle, &descriptor, &hash).await
}

async fn asset_response(
    bundle: &Bundle,
    descriptor: &hcd_core::AssetDescriptor,
    hash: &str,
) -> Result<Response, ApiError> {
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

#[derive(Deserialize)]
struct ExportQuery {
    revision: Option<u64>,
    source: Option<bool>,
}

async fn export_options(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let manifest = bundle.manifest().map_err(internal)?;
    let revision = query.revision.unwrap_or(manifest.revision);
    if revision > manifest.revision {
        return Err(bad("revision ahead of head"));
    }
    let source_available = state
        .root
        .join("sources")
        .join(format!("{id}.{}", manifest.source.format))
        .is_file();
    let requires_rebuild = if manifest.source.format == "docx" {
        tokio::task::spawn_blocking(move || hcd_docx::requires_semantic_rebuild(&bundle, revision))
            .await
            .map_err(internal)?
            .map_err(hcd_error)?
    } else {
        false
    };
    Ok(Json(
        json!({"revision":revision,"sourceAvailable":source_available,"sourceEditsSupported":!requires_rebuild,
        "reasonCode": if !source_available { Some("SOURCE_UNAVAILABLE") } else if requires_rebuild { Some("DOCX_REBUILD_REQUIRED") } else { None }}),
    ))
}

async fn export_document(
    State(state): State<ServerState>,
    Path((id, format)): Path<(String, String)>,
    Query(query): Query<ExportQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
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
    let source_backed = query.source.unwrap_or(false);
    let (bytes, fidelity_level) = if format == "html" && !source_backed {
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
        (output, "SEMANTIC".to_string())
    } else {
        let temp = tempfile::tempdir().map_err(internal)?;
        let output = temp.path().join(format!("export.{format}"));
        let fidelity_path = temp.path().join("fidelity.json");
        let mut command = tokio::process::Command::new(std::env::current_exe().map_err(internal)?);
        command
            .arg("hdoc")
            .arg("export")
            .arg(bundle.root())
            .arg("--output")
            .arg(&output)
            .arg("--revision")
            .arg(requested.to_string())
            .arg("--fidelity-report")
            .arg(&fidelity_path);
        if source_backed {
            let source = state
                .root
                .join("sources")
                .join(format!("{id}.{}", head.source.format));
            if !source.is_file() {
                return Err(bad("immutable source is unavailable"));
            }
            command.arg("--source").arg(source);
        }
        if !source_backed && format == "docx" && head.source.format == "docx" {
            let font_source = state.root.join("sources").join(format!("{id}.docx"));
            if font_source.is_file() {
                command.arg("--typography-source").arg(font_source);
            }
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
        let report: hcd_core::FidelityReport =
            serde_json::from_slice(&tokio::fs::read(&fidelity_path).await.map_err(internal)?)
                .map_err(internal)?;
        (
            tokio::fs::read(output).await.map_err(internal)?,
            format!("{:?}", report.level).to_ascii_uppercase(),
        )
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
    response.headers_mut().insert(
        header::HeaderName::from_static("x-hcd-fidelity-level"),
        fidelity_level.parse().map_err(internal)?,
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hcd_core::{get_text_node, EditorBlockKind, EditorBlockView};

    fn image_bundle(root: &std::path::Path) -> Bundle {
        use std::io::Write;
        let source = root.join("test.pptx");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&source).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        let parts = [
            (
                "[Content_Types].xml",
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>"#,
            ),
            (
                "ppt/presentation.xml",
                r#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="9144000" cy="6858000"/><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>"#,
            ),
            (
                "ppt/_rels/presentation.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>"#,
            ),
            (
                "ppt/slides/_rels/slide1.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image.png"/></Relationships>"#,
            ),
            (
                "ppt/slides/slide1.xml",
                r#"<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="12700" y="25400"/><a:ext cx="1270000" cy="127000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Original text</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="3" name="Image"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld></p:sld>"#,
            ),
        ];
        for (name, content) in parts {
            zip.start_file(name, options).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.start_file("ppt/media/image.png", options).unwrap();
        zip.write_all(&base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap()).unwrap();
        zip.finish().unwrap();
        let output = root.join("doc.hcd");
        hcd_formats::import_document(
            &source,
            &output,
            &hcd_formats::ImportOptions::new("doc"),
            |_| Ok(()),
        )
        .unwrap();
        Bundle::open(output).unwrap()
    }

    fn word_image_bundle(root: &std::path::Path) -> Bundle {
        use std::io::Write;
        let source = root.join("source.docx");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&source).unwrap());
        let parts = [
            (
                "[Content_Types].xml",
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
            ),
            (
                "word/_rels/document.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/></Relationships>"#,
            ),
            (
                "word/document.xml",
                r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body><w:p><w:r><w:rPr><w:sz w:val="28"/></w:rPr><w:t>Original 中😀</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:anchor><wp:positionH relativeFrom="page"><wp:posOffset>127000</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>254000</wp:posOffset></wp:positionV><wp:extent cx="1270000" cy="635000"/><wp:docPr id="42" descr="Atomic image"/><a:graphic><a:blip r:embed="rIdImage"/></a:graphic></wp:anchor></w:drawing></w:r></w:p><w:p><w:r><w:t>Neighbor</w:t></w:r></w:p><w:sectPr/></w:body></w:document>"#,
            ),
        ];
        for (name, content) in parts {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.start_file(
            "word/media/image.png",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(&base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap()).unwrap();
        zip.finish().unwrap();
        hcd_docx::import_docx(
            &source,
            root.join("doc.hcd"),
            &hcd_docx::ImportOptions::new("doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(root.join("doc.hcd")).unwrap();
        project_editor(&bundle, 0).unwrap();
        bundle
    }

    #[tokio::test]
    async fn staged_image_previews_are_document_scoped_verified_and_do_not_publish_a_revision() {
        let root = tempfile::tempdir().unwrap();
        let bundle = word_image_bundle(root.path());
        let state = edit_state(root.path());
        let baseline = bundle.manifest().unwrap();
        let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
        let staged = bundle
            .stage_asset_from_reader("png", &mut std::io::Cursor::new(&png))
            .unwrap();
        // Every collaborator who can read the shared draft may inspect its
        // resource, but a token for another document cannot read it.
        let response = staged_image(
            State(state.clone()),
            Path(("doc".into(), staged.hash.clone())),
            edit_headers(&state, "read"),
        )
        .await
        .unwrap();
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 1024)
                .await
                .unwrap()
                .as_ref(),
            png
        );
        assert!(matches!(
            staged_image(
                State(state.clone()),
                Path(("another".into(), staged.hash.clone())),
                edit_headers(&state, "read")
            )
            .await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        assert!(matches!(
            staged_image(
                State(state.clone()),
                Path(("doc".into(), "../bad".into())),
                edit_headers(&state, "read")
            )
            .await,
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        assert!(matches!(
            staged_image(
                State(state.clone()),
                Path(("doc".into(), "0".repeat(64))),
                edit_headers(&state, "read")
            )
            .await,
            Err(ApiError(StatusCode::NOT_FOUND, _))
        ));
        std::fs::write(bundle.resolve_href(&staged.href).unwrap(), b"corrupt").unwrap();
        assert!(matches!(
            staged_image(
                State(state.clone()),
                Path(("doc".into(), staged.hash)),
                edit_headers(&state, "read")
            )
            .await,
            Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, _))
        ));
        assert_eq!(bundle.manifest().unwrap().revision, baseline.revision);
        assert_eq!(bundle.manifest().unwrap().root_hash, baseline.root_hash);
    }

    #[tokio::test]
    async fn word_checkpoints_commit_text_styles_structure_and_image_geometry_in_one_revision() {
        for (mode, replacement) in [
            "source-runs",
            "presentation-style",
            "semantic-structure",
            "source-text",
        ]
        .into_iter()
        .flat_map(|mode| [(mode, false), (mode, true)])
        {
            let root = tempfile::tempdir().unwrap();
            let bundle = word_image_bundle(root.path());
            let projection = editor_projection(&bundle, None).unwrap();
            let text = hcd_core::extract_text_page(&bundle, None, 50)
                .unwrap()
                .entries
                .into_iter()
                .find(|node| node.text == "Original 中😀")
                .unwrap();
            let image = extract_image_page(&bundle, None, 50)
                .unwrap()
                .entries
                .remove(0)
                .node;
            let original_assets = bundle.read_asset_index_for_revision(1).unwrap();
            let mut png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
            png.extend_from_slice(b"replacement");
            let staged = bundle
                .stage_asset_from_reader("png", &mut std::io::Cursor::new(&png))
                .unwrap();
            assert!(!original_assets
                .iter()
                .any(|asset| asset.hash == staged.hash));
            let mut geometry = image.geometry.clone().unwrap();
            geometry.x += 12700.0;
            let mut blocks = editor_surface(&projection)
                .into_iter()
                .map(|block| json!({"blockId":block.block_id,"content":block.content}))
                .collect::<Vec<_>>();
            let body = blocks
                .iter_mut()
                .find(|block| block["content"]["inlines"][0]["text"] == "Original 中😀")
                .unwrap();
            match mode {
                "source-runs" => {
                    body["content"]["inlines"][0]["text"] = json!("Changed 中文😀");
                    body["content"]["inlines"][0]["typography"]["sizePt"] = json!(18);
                    body["content"]["inlines"][0]["fontSizeExplicit"] = json!(true);
                }
                "presentation-style" => {
                    body["content"]["inlines"][0]["textColor"] = json!("#123456")
                }
                "semantic-structure" => {
                    body["content"]["kind"] = json!("heading");
                    body["content"]["level"] = json!(2);
                }
                _ => {}
            }
            let mut payload = json!({"typographyVersion":2,"coordinatorVersion":4,"coordinatorId":"c".repeat(32),"checkpointId":"a".repeat(32),"coordinatorDigest":"b".repeat(64),"expectedRevision":1,"blocks":blocks,"images":[{"nodeId":image.node_id,"geometry":geometry,"precondition":{"visualHash":image.visual_hash}}]});
            if replacement {
                payload["images"][0]["assetHash"] = json!(staged.hash);
            }
            let state = edit_state(root.path());
            let mut service = edit_headers_for(&state, "write", "hcd-collaboration");
            service.insert("x-hcd-collaboration-epoch", "0".parse().unwrap());
            // Every rejected batch keeps both the immutable head and body intact.
            for (key, value, status) in [
                ("stale", json!("0".repeat(64)), StatusCode::CONFLICT),
                ("unit", json!("pt"), StatusCode::BAD_REQUEST),
                ("size", json!(-1), StatusCode::BAD_REQUEST),
                (
                    "asset",
                    json!("../../not-an-asset"),
                    StatusCode::BAD_REQUEST,
                ),
                (
                    "missing",
                    json!(format!("n_{:032x}", 0)),
                    StatusCode::NOT_FOUND,
                ),
            ] {
                let mut bad = payload.clone();
                match key {
                    "stale" => bad["images"][0]["precondition"]["visualHash"] = value,
                    "unit" => bad["images"][0]["geometry"]["unit"] = value,
                    "size" => bad["images"][0]["geometry"]["width"] = value,
                    "asset" => bad["images"][0]["assetHash"] = value,
                    _ => bad["images"][0]["nodeId"] = value,
                }
                assert!(
                    matches!(checkpoint(State(state.clone()),Path("doc".into()),service.clone(),Json(serde_json::from_value(bad).unwrap())).await,Err(ApiError(actual,_)) if actual==status),
                    "{mode} {key}"
                );
                assert_eq!(bundle.manifest().unwrap().revision, 1);
                assert_eq!(
                    bundle.read_asset_index_for_revision(1).unwrap(),
                    original_assets
                );
                assert_eq!(
                    get_image_node(&bundle, &image.node_id)
                        .unwrap()
                        .node
                        .asset_hash,
                    image.asset_hash
                );
                assert_eq!(
                    get_text_node(&bundle, &text.node_id).unwrap().node.text,
                    "Original 中😀"
                );
            }
            if replacement {
                // A staged descriptor whose bytes have been corrupted cannot
                // publish either the earlier valid body operation or the asset index.
                let path = bundle.resolve_href(&staged.href).unwrap();
                let mut corrupt = png.clone();
                *corrupt.last_mut().unwrap() ^= 1;
                std::fs::write(&path, &corrupt).unwrap();
                assert!(checkpoint(
                    State(state.clone()),
                    Path("doc".into()),
                    service.clone(),
                    Json(serde_json::from_value(payload.clone()).unwrap())
                )
                .await
                .is_err());
                assert_eq!(bundle.manifest().unwrap().revision, 1);
                assert_eq!(
                    bundle.read_asset_index_for_revision(1).unwrap(),
                    original_assets
                );
                assert_eq!(
                    get_text_node(&bundle, &text.node_id).unwrap().node.text,
                    "Original 中😀"
                );
                std::fs::write(&path, &png).unwrap();
            }
            let mut duplicate = payload.clone();
            duplicate["images"]
                .as_array_mut()
                .unwrap()
                .push(payload["images"][0].clone());
            assert!(matches!(
                checkpoint(
                    State(state.clone()),
                    Path("doc".into()),
                    service.clone(),
                    Json(serde_json::from_value(duplicate).unwrap())
                )
                .await,
                Err(ApiError(StatusCode::BAD_REQUEST, _))
            ));
            let Json(saved) = checkpoint(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(serde_json::from_value(payload.clone()).unwrap()),
            )
            .await
            .unwrap();
            assert_eq!(saved["saveMode"], mode);
            assert_eq!(saved["revision"], 2);
            assert_eq!(
                saved["images"][0]["geometry"],
                serde_json::to_value(&geometry).unwrap()
            );
            let record = bundle.revision(2).unwrap();
            assert_eq!(record.structural_change, mode == "semantic-structure");
            assert!(record.dirty_node_ids.contains(&image.node_id));
            let current = get_image_node(&bundle, &image.node_id).unwrap();
            assert_eq!(current.node.geometry, Some(geometry.clone()));
            assert_eq!(
                current.node.asset_hash.as_ref(),
                if replacement {
                    Some(&staged.hash)
                } else {
                    image.asset_hash.as_ref()
                }
            );
            assert_eq!(
                saved["images"][0]["assetHash"],
                serde_json::to_value(&current.node.asset_hash).unwrap()
            );
            assert_eq!(
                bundle.read_asset_index_for_revision(1).unwrap(),
                original_assets
            );
            assert_eq!(
                bundle
                    .read_asset_index_for_revision(2)
                    .unwrap()
                    .iter()
                    .any(|asset| asset.hash == staged.hash),
                replacement
            );
            if mode == "source-runs" {
                assert_eq!(
                    get_text_node(&bundle, &text.node_id).unwrap().node.text,
                    "Changed 中文😀"
                );
            }
            if mode == "semantic-structure" {
                assert!(editor_projection(&bundle, None)
                    .unwrap()
                    .blocks
                    .iter()
                    .any(|block| block.content.kind == EditorBlockKind::Heading));
            }
            assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
            // Replaying a lost response returns the original image receipt,
            // even after a later image edit, without creating another revision.
            let mut later = geometry;
            later.y += 12700.0;
            let mut later_patch = PatchBatch {
                schema_version: HCD_PATCH_SCHEMA_VERSION_3.into(),
                document_id: "doc".into(),
                patch_id: "later-image".into(),
                base_revision: 2,
                actor: BTreeMap::new(),
                metadata: BTreeMap::new(),
                operations: vec![PatchOperation::ImageGeometry {
                    node_id: image.node_id.clone(),
                    geometry: later,
                    precondition: VisualPrecondition {
                        visual_hash: current.node.visual_hash.clone(),
                    },
                }],
            };
            if replacement {
                later_patch.operations.push(PatchOperation::ImageReplace {
                    node_id: image.node_id.clone(),
                    asset_hash: image.asset_hash.clone().unwrap(),
                    precondition: VisualPrecondition {
                        visual_hash: current.node.visual_hash,
                    },
                });
            }
            apply_patch(&bundle, &later_patch, 2).unwrap();
            assert_eq!(
                get_image_node(&bundle, &image.node_id)
                    .unwrap()
                    .node
                    .asset_hash,
                image.asset_hash
            );

            let Json(historical_image) = super::image(
                State(state.clone()),
                Path(("doc".into(), image.node_id.clone())),
                Query(RevisionQuery { revision: Some(2) }),
                edit_headers(&state, "read"),
            )
            .await
            .unwrap();
            assert_eq!(historical_image["revision"], 2);
            assert_eq!(
                historical_image["image"]["geometry"],
                saved["images"][0]["geometry"]
            );
            let Json(replayed) = checkpoint(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(serde_json::from_value(payload.clone()).unwrap()),
            )
            .await
            .unwrap();
            assert_eq!(replayed["revision"], 2);
            assert_eq!(replayed["images"], saved["images"]);
            assert_eq!(bundle.manifest().unwrap().revision, 3);
            let mut altered = payload;
            if replacement {
                altered["images"][0]["assetHash"] = json!(image.asset_hash);
            } else {
                altered["images"][0]["geometry"]["x"] = json!(1);
            }
            assert!(matches!(
                checkpoint(
                    State(state),
                    Path("doc".into()),
                    service,
                    Json(serde_json::from_value(altered).unwrap())
                )
                .await,
                Err(ApiError(StatusCode::CONFLICT, _))
            ));
            assert_eq!(bundle.manifest().unwrap().revision, 3);
        }
    }

    #[test]
    fn structural_image_replacement_retains_history_and_rolls_back_failed_batches() {
        let root = tempfile::tempdir().unwrap();
        let bundle = word_image_bundle(root.path());
        let image = extract_image_page(&bundle, None, 50)
            .unwrap()
            .entries
            .remove(0)
            .node;
        let old_assets = bundle.read_asset_index_for_revision(1).unwrap();
        let staged = bundle
            .stage_asset_from_reader("png", &mut std::io::Cursor::new(b"replacement bytes"))
            .unwrap();
        let operation = StructureOperation::ImageReplace {
            node_id: image.node_id.clone(),
            asset_hash: staged.hash.clone(),
            geometry: None,
            precondition: VisualPrecondition {
                visual_hash: image.visual_hash.clone(),
            },
        };
        let mut patch = StructurePatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION_4.into(),
            document_id: "doc".into(),
            patch_id: "replacement-only".into(),
            base_revision: 1,
            actor: BTreeMap::new(),
            operations: vec![operation.clone()],
        };
        let baseline = bundle.manifest().unwrap();
        let projection = editor_projection(&bundle, None).unwrap();
        let image_block = projection
            .blocks
            .iter()
            .find(|block| {
                block.read_only
                    && block
                        .read_only_html
                        .as_ref()
                        .is_some_and(|html| html.contains(&image.node_id))
            })
            .unwrap();
        let text_block = projection
            .blocks
            .iter()
            .find(|block| !block.read_only)
            .unwrap();
        let mut heading = normalized(text_block.content.clone());
        heading.kind = EditorBlockKind::Heading;
        heading.level = Some(2);
        patch.operations.push(StructureOperation::Replace {
            block_id: text_block.block_id.clone(),
            block: heading,
            precondition: BlockPrecondition {
                block_hash: text_block.block_hash.clone(),
            },
        });
        if let StructureOperation::ImageReplace { precondition, .. } = &mut patch.operations[0] {
            precondition.visual_hash = "0".repeat(64);
        }
        // Even when the image is listed first, block operations run first in
        // memory. A later image precondition failure cannot publish the block.
        assert!(matches!(
            apply_structure_patch(&bundle, &patch, 1),
            Err(HcdError::PreconditionFailed(_))
        ));
        assert_eq!(bundle.manifest().unwrap().root_hash, baseline.root_hash);
        assert_eq!(bundle.read_asset_index_for_revision(1).unwrap(), old_assets);
        assert!(!editor_projection(&bundle, None)
            .unwrap()
            .blocks
            .iter()
            .any(|block| block.content.kind == EditorBlockKind::Heading));
        patch.operations = vec![operation];
        // Removing this read-only image block is rejected before publication.
        patch.operations.push(StructureOperation::Delete {
            block_id: image_block.block_id.clone(),
            precondition: BlockPrecondition {
                block_hash: image_block.block_hash.clone(),
            },
        });
        assert!(apply_structure_patch(&bundle, &patch, 1).is_err());
        assert_eq!(bundle.manifest().unwrap().root_hash, baseline.root_hash);
        assert_eq!(bundle.read_asset_index_for_revision(1).unwrap(), old_assets);
        assert!(bundle.revision(2).is_err());
        patch.operations.pop();
        patch.operations.push(StructureOperation::ImageGeometry {
            node_id: image.node_id.clone(),
            geometry: image.geometry.clone().unwrap(),
            precondition: VisualPrecondition {
                visual_hash: image.visual_hash.clone(),
            },
        });
        assert!(matches!(
            apply_structure_patch(&bundle, &patch, 1),
            Err(HcdError::InvalidPatch(_))
        ));
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        patch.operations.pop();
        let saved = apply_structure_patch(&bundle, &patch, 1).unwrap();
        assert_eq!(saved.revision, 2);
        assert!(!bundle.revision(2).unwrap().structural_change);
        let current = get_image_node(&bundle, &image.node_id).unwrap().node;
        assert_eq!(current.asset_hash.as_deref(), Some(staged.hash.as_str()));
        assert_eq!(current.geometry, image.geometry);
        assert_ne!(current.visual_hash, image.visual_hash);
        assert_eq!(bundle.read_asset_index_for_revision(1).unwrap(), old_assets);
        assert!(bundle
            .read_asset_index_for_revision(2)
            .unwrap()
            .iter()
            .any(|asset| asset.hash == staged.hash));
        let validation = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
        assert!(
            apply_structure_patch(&bundle, &patch, 1)
                .unwrap()
                .idempotent_replay
        );
        // Reusing a committed asset does not depend on a staging descriptor.
        patch.base_revision = 2;
        patch.patch_id = "reuse-original-asset".into();
        patch.operations = vec![StructureOperation::ImageReplace {
            node_id: image.node_id.clone(),
            asset_hash: image.asset_hash.clone().unwrap(),
            geometry: None,
            precondition: VisualPrecondition {
                visual_hash: current.visual_hash,
            },
        }];
        apply_structure_patch(&bundle, &patch, 2).unwrap();
        assert_eq!(
            get_image_node(&bundle, &image.node_id)
                .unwrap()
                .node
                .asset_hash,
            image.asset_hash
        );
        assert!(!bundle.revision(3).unwrap().structural_change);
        let validation = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
    }

    #[test]
    fn structural_image_failure_cannot_publish_an_earlier_valid_block_edit() {
        let root = tempfile::tempdir().unwrap();
        let bundle = word_image_bundle(root.path());
        let original = bundle.manifest().unwrap();
        let projection = editor_projection(&bundle, None).unwrap();
        let block = projection
            .blocks
            .iter()
            .find(|block| !block.read_only)
            .unwrap();
        let mut content = normalized(block.content.clone());
        content.kind = EditorBlockKind::Heading;
        content.level = Some(2);
        let image = extract_image_page(&bundle, None, 50)
            .unwrap()
            .entries
            .remove(0)
            .node;
        let mut patch = StructurePatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION_4.into(),
            document_id: "doc".into(),
            patch_id: "failed-structure-and-image".into(),
            base_revision: 1,
            actor: BTreeMap::new(),
            operations: vec![
                StructureOperation::Replace {
                    block_id: block.block_id.clone(),
                    block: content,
                    precondition: BlockPrecondition {
                        block_hash: block.block_hash.clone(),
                    },
                },
                StructureOperation::ImageGeometry {
                    node_id: image.node_id.clone(),
                    geometry: image.geometry.clone().unwrap(),
                    precondition: VisualPrecondition {
                        visual_hash: "0".repeat(64),
                    },
                },
            ],
        };
        assert!(matches!(
            apply_structure_patch(&bundle, &patch, 1),
            Err(HcdError::PreconditionFailed(_))
        ));
        assert_eq!(bundle.manifest().unwrap().root_hash, original.root_hash);
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        assert!(bundle.revision(2).is_err());
        assert!(!editor_projection(&bundle, None)
            .unwrap()
            .blocks
            .iter()
            .any(|block| block.content.kind == EditorBlockKind::Heading));
        // Even if the image operation is placed first, block hash checks use
        // the original body. Repeated image operations are never accepted.
        if let StructureOperation::ImageGeometry { precondition, .. } = &mut patch.operations[1] {
            precondition.visual_hash = image.visual_hash;
        }
        patch.operations.swap(0, 1);
        apply_structure_patch(&bundle, &patch, 1).unwrap();
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
        let current = get_image_node(&bundle, &image.node_id).unwrap().node;
        let image_op = StructureOperation::ImageGeometry {
            node_id: image.node_id,
            geometry: current.geometry.unwrap(),
            precondition: VisualPrecondition {
                visual_hash: current.visual_hash,
            },
        };
        patch.base_revision = 2;
        patch.patch_id = "duplicate-images".into();
        patch.operations = vec![image_op.clone(), image_op];
        assert!(matches!(
            apply_structure_patch(&bundle, &patch, 2),
            Err(HcdError::InvalidPatch(_))
        ));
        assert_eq!(bundle.manifest().unwrap().revision, 2);
        patch.patch_id = "geometry-without-block-edit".into();
        patch.operations.pop();
        if let StructureOperation::ImageGeometry { geometry, .. } = &mut patch.operations[0] {
            geometry.x += 12700.0;
        }
        apply_structure_patch(&bundle, &patch, 2).unwrap();
        assert!(!bundle.revision(3).unwrap().structural_change);
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
    }

    fn edit_state(root: &std::path::Path) -> ServerState {
        ServerState {
            root: root.to_path_buf(),
            secret: Arc::new(vec![b'x'; 32]),
            remote: None,
            collaboration_lock: Arc::new(Mutex::new(())),
            revisions: RevisionHub::default(),
        }
    }

    fn edit_headers(state: &ServerState, scope: &str) -> HeaderMap {
        edit_headers_for(state, scope, "editor")
    }

    fn edit_headers_for(state: &ServerState, scope: &str, user: &str) -> HeaderMap {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize;
        let token = encode(
            &Header::new(Algorithm::HS256),
            &Claims {
                doc: "doc".into(),
                scope: scope.into(),
                sub: Some(user.into()),
                name: None,
                aud: "hcd-core".into(),
                iat: now,
                exp: now + 60,
            },
            &EncodingKey::from_secret(&state.secret),
        )
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        headers
    }

    fn text_bundle(root: &std::path::Path) -> Bundle {
        let input = root.join("source.txt");
        std::fs::write(&input, "Original\nNeighbor").unwrap();
        hcd_formats::import_document(
            &input,
            root.join("doc.hcd"),
            &hcd_formats::ImportOptions::new("doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(root.join("doc.hcd")).unwrap();
        project_editor(&bundle, 0).unwrap();
        bundle
    }

    #[tokio::test]
    async fn source_identity_text_edits_preserve_unedited_annotations_and_source_html() {
        let root = tempfile::tempdir().unwrap();
        let bundle = text_bundle(root.path());
        let first = hcd_core::extract_text_page(&bundle, None, 1)
            .unwrap()
            .entries
            .remove(0);
        apply_patch(
            &bundle,
            &PatchBatch {
                schema_version: HCD_PATCH_SCHEMA_VERSION.into(),
                document_id: "doc".into(),
                patch_id: "recognition".into(),
                base_revision: 1,
                actor: BTreeMap::new(),
                metadata: BTreeMap::new(),
                operations: vec![PatchOperation::AnnotationUpsert {
                    annotation: hcd_core::Annotation {
                        annotation_id: "prefix".into(),
                        node_id: first.node_id.clone(),
                        start: 0,
                        end: 4,
                        kind: "recognition".into(),
                        rule_id: None,
                        confidence: None,
                        ignored: false,
                    },
                }],
            },
            1,
        )
        .unwrap();
        let annotation_root = bundle.manifest().unwrap().annotation_root_hash;
        let projection = editor_projection(&bundle, None).unwrap();
        let mut blocks = editor_surface(&projection)
            .into_iter()
            .map(|block| json!({"blockId":block.block_id,"content":block.content}))
            .collect::<Vec<_>>();
        blocks[0]["content"]["inlines"][0]["text"] = json!("Orig中😀inal");
        let payload = json!({"typographyVersion":2,"coordinatorVersion":4,"coordinatorId":"c".repeat(32),"checkpointId":"a".repeat(32),"coordinatorDigest":"b".repeat(64),"expectedRevision":2,"blocks":blocks});
        let state = edit_state(root.path());
        let mut service = edit_headers_for(&state, "write", "hcd-collaboration");
        service.insert("x-hcd-collaboration-epoch", "0".parse().unwrap());
        let Json(saved) = checkpoint(
            State(state),
            Path("doc".into()),
            service,
            Json(serde_json::from_value(payload).unwrap()),
        )
        .await
        .unwrap();
        assert_eq!(saved["saveMode"], "source-runs");
        assert_eq!(
            bundle.manifest().unwrap().annotation_root_hash,
            annotation_root
        );
        let current = hcd_core::get_text_node(&bundle, &first.node_id).unwrap();
        assert_eq!(current.node.text, "Orig中😀inal");
        assert_eq!(current.node.source, first.source);
        assert!(!bundle.revision(3).unwrap().structural_change);
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
    }

    #[tokio::test]
    async fn coordinator_checkpoints_reject_old_clients_and_replay_exact_saved_versions_after_newer_updates(
    ) {
        let root = tempfile::tempdir().unwrap();
        let bundle = text_bundle(root.path());
        let state = edit_state(root.path());
        let projection = editor_projection(&bundle, None).unwrap();
        let mut blocks = projection
            .blocks
            .iter()
            .map(|block| json!({"blockId": block.block_id, "content": block.content}))
            .collect::<Vec<_>>();
        blocks[0]["content"]["inlines"][0]["text"] = json!("Coordinated 中文");
        let payload = json!({"typographyVersion":2,"coordinatorVersion":4,"coordinatorId":"c".repeat(32),"checkpointId":"a".repeat(32),"coordinatorDigest":"b".repeat(64),"expectedRevision":1,"blocks":blocks});
        let mut writer = edit_headers(&state, "write");
        writer.insert("x-hcd-collaboration-epoch", "0".parse().unwrap());
        assert!(matches!(
            checkpoint(
                State(state.clone()),
                Path("doc".into()),
                writer,
                Json(serde_json::from_value(payload.clone()).unwrap())
            )
            .await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        let mut service = edit_headers_for(&state, "write", "hcd-collaboration");
        service.insert("x-hcd-collaboration-epoch", "0".parse().unwrap());
        let mut legacy = payload.clone();
        legacy["coordinatorVersion"] = json!(1);
        assert!(matches!(
            checkpoint(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(serde_json::from_value(legacy).unwrap())
            )
            .await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        let mut old_v2 = payload.clone();
        old_v2["coordinatorVersion"] = json!(2);
        assert!(matches!(
            checkpoint(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(serde_json::from_value(old_v2).unwrap())
            )
            .await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        let mut old_v3 = payload.clone();
        old_v3["coordinatorVersion"] = json!(3);
        assert!(matches!(
            checkpoint(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(serde_json::from_value(old_v3).unwrap())
            )
            .await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        let mut storage_v3 = service.clone();
        storage_v3.insert("x-hcd-coordinator-version", "3".parse().unwrap());
        assert!(matches!(
            collaboration_put(
                State(state.clone()),
                Path("doc".into()),
                storage_v3,
                Bytes::from_static(b"old v3 cannot erase replacement intents")
            )
            .await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        let mut storage_v2 = service.clone();
        storage_v2.insert("x-hcd-coordinator-version", "2".parse().unwrap());
        storage_v2.insert("x-hcd-state-hash", "none".parse().unwrap());
        assert!(matches!(
            collaboration_put(
                State(state.clone()),
                Path("doc".into()),
                storage_v2,
                Bytes::from_static(b"old v2 state")
            )
            .await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        let mut legacy_storage = service.clone();
        legacy_storage.insert("x-hcd-coordinator-version", "1".parse().unwrap());
        legacy_storage.insert("x-hcd-state-hash", "none".parse().unwrap());
        assert!(matches!(
            collaboration_put(
                State(state.clone()),
                Path("doc".into()),
                legacy_storage,
                Bytes::from_static(b"old state")
            )
            .await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        let Json(saved) = checkpoint(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(serde_json::from_value(payload.clone()).unwrap()),
        )
        .await
        .unwrap();
        assert_eq!(saved["revision"], 2);
        assert_eq!(saved["projection"]["revision"], 2);
        let record = bundle.revision(2).unwrap();
        assert!(record.patch_id.as_ref().unwrap().len() <= 256);
        assert!(record.patch_id.as_ref().unwrap().starts_with("hcdsave4:"));
        assert_eq!(saved["rootHash"], record.root_hash);
        let text = hcd_core::extract_text_page(&bundle, None, 1)
            .unwrap()
            .entries
            .remove(0);
        apply_patch(
            &bundle,
            &PatchBatch {
                schema_version: HCD_PATCH_SCHEMA_VERSION.into(),
                document_id: "doc".into(),
                patch_id: "external-update".into(),
                base_revision: 2,
                actor: BTreeMap::new(),
                metadata: BTreeMap::new(),
                operations: vec![PatchOperation::TextSplice {
                    node_id: text.node_id.clone(),
                    start: 0,
                    delete_count: text.text.chars().count(),
                    insert_text: "External canonical update".into(),
                    precondition: NodePrecondition {
                        node_hash: text.node_hash,
                    },
                }],
            },
            2,
        )
        .unwrap();
        let Json(replayed) = checkpoint(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(serde_json::from_value(payload.clone()).unwrap()),
        )
        .await
        .unwrap();
        assert_eq!(replayed["revision"], 2);
        assert_eq!(replayed["rootHash"], saved["rootHash"]);
        assert_eq!(replayed["projection"], saved["projection"]);
        assert_eq!(bundle.manifest().unwrap().revision, 3);
        assert_eq!(
            get_text_node(&bundle, &text.node_id).unwrap().node.text,
            "External canonical update"
        );
        let mut other = payload;
        other["checkpointId"] = json!("d".repeat(32));
        assert!(matches!(
            checkpoint(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(serde_json::from_value(other.clone()).unwrap())
            )
            .await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        reset_collaboration(&state, "doc").await.unwrap();
        assert!(matches!(
            checkpoint(
                State(state.clone()),
                Path("doc".into()),
                service,
                Json(serde_json::from_value(other).unwrap())
            )
            .await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        assert_eq!(bundle.manifest().unwrap().revision, 3);
    }

    #[tokio::test]
    async fn room_reset_archives_old_states_and_old_epoch_recovery_cannot_change_the_current_room()
    {
        let root = tempfile::tempdir().unwrap();
        let bundle = text_bundle(root.path());
        let initial = bundle.manifest().unwrap();
        let state = edit_state(root.path());
        let mut writer = edit_headers(&state, "write");
        writer.insert("x-hcd-collaboration-epoch", "0".parse().unwrap());
        let mut storage = edit_headers_for(&state, "write", "hcd-collaboration");
        storage.insert("x-hcd-collaboration-epoch", "0".parse().unwrap());
        storage.insert("x-hcd-coordinator-version", "4".parse().unwrap());
        storage.insert("x-hcd-state-hash", "none".parse().unwrap());
        let _ = collaboration_put(
            State(state.clone()),
            Path("doc".into()),
            storage.clone(),
            Bytes::from_static(b"old binary state"),
        )
        .await
        .unwrap();
        assert!(matches!(
            collaboration_put(
                State(state.clone()),
                Path("doc".into()),
                storage.clone(),
                Bytes::from_static(b"stale owner")
            )
            .await,
            Err(ApiError(StatusCode::PRECONDITION_FAILED, _))
        ));
        let _ = collaboration_put(
            State(state.clone()),
            Path("doc".into()),
            storage.clone(),
            Bytes::from_static(b"old binary state"),
        )
        .await
        .unwrap();
        assert_eq!(reset_collaboration(&state, "doc").await.unwrap(), 1);
        assert!(!collaboration_path(&state, "doc").exists());
        assert!(matches!(
            collaboration_put(
                State(state.clone()),
                Path("doc".into()),
                storage.clone(),
                Bytes::from_static(b"cannot overwrite new room")
            )
            .await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        let Json(saved) = collaboration_recover(
            State(state.clone()),
            Path("doc".into()),
            writer.clone(),
            Bytes::from_static(b"newer old-epoch draft"),
        )
        .await
        .unwrap();
        let Json(list) =
            collaboration_recoveries(State(state.clone()), Path("doc".into()), writer.clone())
                .await
                .unwrap();
        assert_eq!(list["recoveries"].as_array().unwrap().len(), 2);
        for item in list["recoveries"].as_array().unwrap() {
            let name = item.as_str().unwrap().to_string();
            let response = collaboration_recovery(
                State(state.clone()),
                Path(("doc".into(), name.clone())),
                writer.clone(),
            )
            .await
            .unwrap();
            let bytes = axum::body::to_bytes(response.into_body(), 8 * 1024 * 1024)
                .await
                .unwrap();
            assert_eq!(
                bytes.as_ref(),
                if name == saved["recoveryId"].as_str().unwrap() {
                    b"newer old-epoch draft".as_slice()
                } else {
                    b"old binary state".as_slice()
                }
            );
        }
        assert!(matches!(
            collaboration_recover(
                State(state.clone()),
                Path("doc".into()),
                edit_headers(&state, "read"),
                Bytes::from_static(b"denied")
            )
            .await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        assert_eq!(collaboration_epoch(&state, "doc").await.unwrap(), 1);
        assert_eq!(bundle.manifest().unwrap().root_hash, initial.root_hash);
        assert!(collaboration_recovery(
            State(state.clone()),
            Path(("doc".into(), "../../outside".into())),
            writer
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn source_font_size_edits_require_format_cas_and_expose_immutable_read_state() {
        use std::io::Write;
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.docx");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&source).unwrap());
        for (name, content) in [
            (
                "[Content_Types].xml",
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
            ),
            (
                "word/document.xml",
                r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:sz w:val="28"/><w:spacing w:val="12"/></w:rPr><w:t>A中😀 B</w:t><w:t>after</w:t></w:r></w:p></w:body></w:document>"#,
            ),
            (
                "_rels/.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
            ),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        hcd_docx::import_docx(
            &source,
            root.path().join("doc.hcd"),
            &hcd_docx::ImportOptions::new("doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(root.path().join("doc.hcd")).unwrap();
        let id = hcd_core::extract_text_page(&bundle, None, 1)
            .unwrap()
            .entries[0]
            .node_id
            .clone();
        let state = edit_state(root.path());
        let Json(original) = text_node(
            State(state.clone()),
            Path(("doc".into(), id.clone())),
            Query(RevisionQuery { revision: None }),
            edit_headers(&state, "read"),
        )
        .await
        .unwrap();
        let request: PatchBatch = serde_json::from_value(json!({ "schemaVersion":"hcd-patch/5", "documentId":"doc", "patchId":"sizes-api", "baseRevision":0,
            "operations":[{"op":"text.runs","nodeId":id,"text":"A中😀 B","runs":[{"chars":1},{"chars":2,"sizePt":28.5},{"chars":2}],"precondition":{"nodeHash":original["nodeHash"],"formatHash":original["formatHash"]}}] })).unwrap();
        assert!(matches!(
            editor_edits(
                State(state.clone()),
                Path("doc".into()),
                edit_headers(&state, "read"),
                Json(request.clone())
            )
            .await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        let mut legacy = request.clone();
        legacy.schema_version = HCD_PATCH_SCHEMA_VERSION_3.into();
        assert!(prepare_editor_edits(legacy, "doc", BTreeMap::new()).is_err());
        let Json(saved) = editor_edits(
            State(state.clone()),
            Path("doc".into()),
            edit_headers(&state, "write"),
            Json(request.clone()),
        )
        .await
        .unwrap();
        assert_eq!(saved["revision"], 1);
        assert_eq!(saved["nodeHashes"][&id], original["nodeHash"]);
        assert_ne!(saved["formatHashes"][&id], original["formatHash"]);
        assert_eq!(collaboration_epoch(&state, "doc").await.unwrap(), 1);
        let Json(replayed) = editor_edits(
            State(state.clone()),
            Path("doc".into()),
            edit_headers(&state, "write"),
            Json(request.clone()),
        )
        .await
        .unwrap();
        assert_eq!(replayed["revision"], 1);
        assert_eq!(collaboration_epoch(&state, "doc").await.unwrap(), 1);
        let mut stale = request;
        stale.patch_id = "stale-size".into();
        stale.base_revision = 1;
        assert!(matches!(
            editor_edits(
                State(state.clone()),
                Path("doc".into()),
                edit_headers(&state, "write"),
                Json(stale)
            )
            .await,
            Err(ApiError(StatusCode::PRECONDITION_FAILED, _))
        ));
        let Json(current) = text_node(
            State(state.clone()),
            Path(("doc".into(), id.clone())),
            Query(RevisionQuery { revision: None }),
            edit_headers(&state, "read"),
        )
        .await
        .unwrap();
        assert_eq!(current["fontSizeRuns"][1]["sizePt"], 28.5);
        let Json(historical) = text_node(
            State(state.clone()),
            Path(("doc".into(), id.clone())),
            Query(RevisionQuery { revision: Some(0) }),
            edit_headers(&state, "read"),
        )
        .await
        .unwrap();
        assert_eq!(historical, original);
        let projection = editor_projection(&bundle, None).unwrap();
        let mut desired: Vec<SnapshotBlock> = editor_surface(&projection)
            .into_iter()
            .map(|block| SnapshotBlock {
                block_id: Some(block.block_id.clone()),
                content: block.content.clone(),
            })
            .collect();
        let middle = desired[0]
            .content
            .inlines
            .iter()
            .position(|inline| inline.text == "中😀")
            .unwrap();
        let mut glyph = desired[0].content.inlines[middle].clone();
        glyph.text = "😀".into();
        desired[0].content.inlines[middle].text = "中".into();
        desired[0].content.inlines[middle]
            .typography
            .as_mut()
            .unwrap()
            .size_pt = Some(32.0);
        desired[0].content.inlines.insert(middle + 1, glyph);
        let payload = json!({"typographyVersion":2,"coordinatorVersion":4,"coordinatorId":"c".repeat(32),"checkpointId":"d".repeat(32),"coordinatorDigest":"f".repeat(64),"expectedRevision":1,"blocks":desired});
        let mut headers = edit_headers_for(&state, "write", "hcd-collaboration");
        headers.insert("x-hcd-collaboration-epoch", "1".parse().unwrap());
        let mut missing = payload.clone();
        missing["blocks"][0]["content"]["inlines"][middle]["nodeId"] = Value::Null;
        assert!(matches!(
            checkpoint(
                State(state.clone()),
                Path("doc".into()),
                headers.clone(),
                Json(serde_json::from_value(missing).unwrap())
            )
            .await,
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        let Json(saved) = checkpoint(
            State(state.clone()),
            Path("doc".into()),
            headers.clone(),
            Json(serde_json::from_value(payload.clone()).unwrap()),
        )
        .await
        .unwrap();
        assert_eq!(saved["saveMode"], "source-runs");
        assert_eq!(saved["revision"], 2);
        assert!(!bundle.revision(2).unwrap().structural_change);
        assert_eq!(collaboration_epoch(&state, "doc").await.unwrap(), 1);
        let node = hcd_core::get_text_node(&bundle, &id).unwrap();
        assert_eq!(node.node.source.text_ordinal, 1);
        assert_eq!(
            node.font_size_runs
                .unwrap()
                .iter()
                .map(|run| (run.chars, run.size_pt))
                .collect::<Vec<_>>(),
            [(1, None), (1, Some(32.0)), (1, Some(28.5)), (2, None)]
        );
        let Json(replayed) = checkpoint(
            State(state.clone()),
            Path("doc".into()),
            headers,
            Json(serde_json::from_value(payload).unwrap()),
        )
        .await
        .unwrap();
        assert_eq!(replayed["revision"], 2);
        assert_eq!(replayed["saveMode"], "replayed");
        let projection = editor_projection(&bundle, None).unwrap();
        let mut desired: Vec<SnapshotBlock> = editor_surface(&projection)
            .into_iter()
            .map(|block| SnapshotBlock {
                block_id: Some(block.block_id.clone()),
                content: block.content.clone(),
            })
            .collect();
        let middle = desired[0]
            .content
            .inlines
            .iter()
            .position(|inline| inline.text == "中")
            .unwrap();
        desired[0].content.inlines[middle].text = "中文".into();
        let neighbor = desired[0]
            .content
            .inlines
            .iter_mut()
            .find(|inline| inline.text == "after")
            .unwrap();
        neighbor.text = "after edited".into();
        neighbor.typography.as_mut().unwrap().size_pt = Some(18.0);
        neighbor.font_size_explicit = true;
        let payload = json!({"typographyVersion":2,"coordinatorVersion":4,"coordinatorId":"c".repeat(32),"checkpointId":"e".repeat(32),"coordinatorDigest":"a".repeat(64),"expectedRevision":2,"blocks":desired});
        let mut headers = edit_headers_for(&state, "write", "hcd-collaboration");
        headers.insert("x-hcd-collaboration-epoch", "1".parse().unwrap());
        let Json(saved) = checkpoint(
            State(state.clone()),
            Path("doc".into()),
            headers,
            Json(serde_json::from_value(payload).unwrap()),
        )
        .await
        .unwrap();
        assert_eq!(saved["saveMode"], "source-runs");
        assert_eq!(saved["revision"], 3);
        let node = hcd_core::get_text_node(&bundle, &id).unwrap();
        assert_eq!(node.node.text, "A中文😀 B");
        assert_eq!(
            node.font_size_runs
                .unwrap()
                .iter()
                .map(|run| (run.chars, run.size_pt))
                .collect::<Vec<_>>(),
            [(1, None), (2, Some(32.0)), (1, Some(28.5)), (2, None)]
        );
        assert!(!bundle.revision(3).unwrap().structural_change);
        assert_eq!(bundle.revision(3).unwrap().dirty_node_ids.len(), 2);
        let report = hcd_docx::export_docx(
            bundle.root(),
            &source,
            root.path().join("native.docx"),
            &hcd_docx::ExportOptions::default(),
        )
        .unwrap();
        assert_eq!(report.level, hcd_core::FidelityLevel::High);
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
    }

    #[tokio::test]
    async fn editor_edits_commit_replacement_text_and_geometry_with_immutable_asset_receipts() {
        let root = tempfile::tempdir().unwrap();
        let bundle = image_bundle(root.path());
        let baseline = bundle.manifest().unwrap();
        let state = edit_state(root.path());
        let text = hcd_core::extract_text_page(&bundle, None, 1)
            .unwrap()
            .entries
            .remove(0);
        let image = extract_image_page(&bundle, None, 1)
            .unwrap()
            .entries
            .remove(0)
            .node;
        let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC").unwrap();
        let staged = bundle
            .stage_asset_from_reader("png", &mut std::io::Cursor::new(&png))
            .unwrap();
        let mut geometry = image.geometry.clone().unwrap();
        geometry.width += 12700.0;
        let request: PatchBatch = serde_json::from_value(json!({"schemaVersion":"hcd-patch/3","documentId":"doc","patchId":"replace-and-text","baseRevision":0,
            "operations":[{"op":"text.splice","nodeId":text.node_id,"start":0,"deleteCount":text.text.chars().count(),"insertText":"Replacement 中文😀","precondition":{"nodeHash":text.node_hash}},
                {"op":"image.replace","nodeId":image.node_id,"assetHash":staged.hash,"precondition":{"visualHash":image.visual_hash}},
                {"op":"image.geometry","nodeId":image.node_id,"geometry":geometry,"precondition":{"visualHash":image.visual_hash}}]})).unwrap();
        let mut missing = request.clone();
        if let PatchOperation::ImageReplace { asset_hash, .. } = &mut missing.operations[1] {
            *asset_hash = "0".repeat(64);
        }
        assert!(editor_edits(
            State(state.clone()),
            Path("doc".into()),
            edit_headers(&state, "write"),
            Json(missing)
        )
        .await
        .is_err());
        assert_eq!(bundle.manifest().unwrap().root_hash, baseline.root_hash);
        assert_eq!(
            get_text_node(&bundle, &text.node_id).unwrap().node.text,
            text.text
        );
        let Json(not_committed) = editor_edits_receipt(
            State(state.clone()),
            Path("doc".into()),
            edit_headers(&state, "read"),
            Json(request.clone()),
        )
        .await
        .unwrap();
        assert_eq!(not_committed["status"], "missing");
        assert_eq!(bundle.manifest().unwrap().revision, 0);
        assert!(matches!(
            editor_edits(
                State(state.clone()),
                Path("doc".into()),
                edit_headers(&state, "read"),
                Json(request.clone())
            )
            .await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        let Json(saved) = editor_edits(
            State(state.clone()),
            Path("doc".into()),
            edit_headers(&state, "write"),
            Json(request.clone()),
        )
        .await
        .unwrap();
        assert_eq!(saved["revision"], 1);
        assert_eq!(saved["images"].as_array().unwrap().len(), 1);
        assert_eq!(saved["images"][0]["assetHash"], staged.hash);
        assert_eq!(
            saved["images"][0]["geometry"],
            serde_json::to_value(&geometry).unwrap()
        );
        let confirmed = get_image_node(&bundle, &image.node_id).unwrap().node;
        assert_eq!(saved["images"][0]["visualHash"], confirmed.visual_hash);
        assert_eq!(
            get_text_node(&bundle, &text.node_id).unwrap().node.text,
            "Replacement 中文😀"
        );
        assert_eq!(
            hcd_core::get_image_node_in_manifest(&bundle, &image.node_id, &baseline)
                .unwrap()
                .node
                .asset_hash,
            image.asset_hash
        );
        let revert: PatchBatch = serde_json::from_value(json!({"schemaVersion":"hcd-patch/3","documentId":"doc","patchId":"later-replacement","baseRevision":1,
            "operations":[{"op":"image.replace","nodeId":image.node_id,"assetHash":image.asset_hash,"precondition":{"visualHash":confirmed.visual_hash}}]})).unwrap();
        let Json(later) = editor_edits(
            State(state.clone()),
            Path("doc".into()),
            edit_headers(&state, "write"),
            Json(revert),
        )
        .await
        .unwrap();
        assert_eq!(later["revision"], 2);
        let Json(replayed) = editor_edits(
            State(state.clone()),
            Path("doc".into()),
            edit_headers(&state, "write"),
            Json(request.clone()),
        )
        .await
        .unwrap();
        assert_eq!(replayed["revision"], 1);
        assert_eq!(replayed["idempotentReplay"], true);
        assert_eq!(replayed["images"], saved["images"]);
        assert_eq!(bundle.manifest().unwrap().revision, 2);
        let head = bundle.manifest().unwrap();
        let Json(receipt) = editor_edits_receipt(
            State(state.clone()),
            Path("doc".into()),
            edit_headers(&state, "read"),
            Json(request.clone()),
        )
        .await
        .unwrap();
        assert_eq!(receipt["status"], "committed");
        assert_eq!(receipt["revision"], 1);
        assert_eq!(receipt["images"], saved["images"]);
        assert_eq!(receipt["nodeHashes"], saved["nodeHashes"]);
        let mut changed = request.clone();
        if let PatchOperation::TextSplice { insert_text, .. } = &mut changed.operations[0] {
            *insert_text = "Different payload".into();
        }
        assert!(matches!(
            editor_edits_receipt(
                State(state.clone()),
                Path("doc".into()),
                edit_headers(&state, "read"),
                Json(changed)
            )
            .await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        assert!(matches!(
            editor_edits_receipt(
                State(state.clone()),
                Path("doc".into()),
                edit_headers_for(&state, "read", "another-user"),
                Json(request.clone())
            )
            .await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        let mut renamed = claims(&state, &edit_headers(&state, "read"), "doc").unwrap();
        renamed.name = Some("New display name".into());
        let token = encode(
            &Header::new(Algorithm::HS256),
            &renamed,
            &EncodingKey::from_secret(&state.secret),
        )
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        let Json(renamed_receipt) = editor_edits_receipt(
            State(state.clone()),
            Path("doc".into()),
            headers,
            Json(request),
        )
        .await
        .unwrap();
        assert_eq!(renamed_receipt["images"], saved["images"]);
        assert_eq!(bundle.manifest().unwrap().root_hash, head.root_hash);
        assert_eq!(bundle.manifest().unwrap().revision, 2);
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
    }

    #[tokio::test]
    async fn editor_edits_atomically_save_text_and_geometry_and_pin_receipts_to_the_saved_revision()
    {
        let root = tempfile::tempdir().unwrap();
        let bundle = image_bundle(root.path());
        let initial = bundle.manifest().unwrap();
        let text = hcd_core::extract_text_page(&bundle, None, 1)
            .unwrap()
            .entries
            .remove(0);
        let image = extract_image_page(&bundle, None, 1)
            .unwrap()
            .entries
            .remove(0)
            .node;
        let mut geometry = image.geometry.clone().unwrap();
        geometry.x += 12700.0;
        let state = edit_state(root.path());
        let request: PatchBatch = serde_json::from_value(json!({ "schemaVersion":"hcd-patch/3", "documentId":"doc", "patchId":"both", "baseRevision":0,
            "operations":[{"op":"text.splice","nodeId":text.node_id,"start":0,"deleteCount":text.text.chars().count(),"insertText":"Saved 中文 😀","precondition":{"nodeHash":text.node_hash}},
            {"op":"image.geometry","nodeId":image.node_id,"geometry":geometry,"precondition":{"visualHash":image.visual_hash}}] })).unwrap();
        let mut bad_request = request.clone();
        if let PatchOperation::ImageGeometry { precondition, .. } = &mut bad_request.operations[1] {
            precondition.visual_hash = "0".repeat(64);
        }
        assert!(matches!(
            editor_edits(
                State(state.clone()),
                Path("doc".into()),
                edit_headers(&state, "write"),
                Json(bad_request)
            )
            .await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        assert_eq!(bundle.manifest().unwrap().root_hash, initial.root_hash);
        assert_eq!(
            get_text_node(&bundle, &text.node_id).unwrap().node.text,
            text.text
        );
        assert!(matches!(
            editor_edits(
                State(state.clone()),
                Path("doc".into()),
                edit_headers(&state, "read"),
                Json(request.clone())
            )
            .await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        let Json(result) = editor_edits(
            State(state.clone()),
            Path("doc".into()),
            edit_headers(&state, "write"),
            Json(request.clone()),
        )
        .await
        .unwrap();
        assert_eq!(result["revision"], 1);
        assert_eq!(
            result["images"][0]["geometry"],
            serde_json::to_value(&geometry).unwrap()
        );
        assert_eq!(
            result["images"][0]["visualHash"],
            get_image_node(&bundle, &image.node_id)
                .unwrap()
                .node
                .visual_hash
        );
        assert_eq!(
            result["nodeHashes"][&text.node_id],
            hash_bytes("Saved 中文 😀".as_bytes())
        );
        assert_eq!(
            get_text_node(&bundle, &text.node_id).unwrap().node.text,
            "Saved 中文 😀"
        );
        assert_eq!(
            hcd_core::get_text_node_in_manifest(&bundle, &text.node_id, &initial)
                .unwrap()
                .node
                .text,
            text.text
        );
        assert_eq!(
            hcd_core::get_image_node_in_manifest(&bundle, &image.node_id, &initial)
                .unwrap()
                .node
                .geometry,
            image.geometry
        );
        let Json(replayed) = editor_edits(
            State(state.clone()),
            Path("doc".into()),
            edit_headers(&state, "write"),
            Json(request.clone()),
        )
        .await
        .unwrap();
        assert_eq!(replayed["revision"], 1);
        assert_eq!(replayed["idempotentReplay"], true);
        assert_eq!(replayed["nodeHashes"], result["nodeHashes"]);
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        let mut stale = request.clone();
        stale.patch_id = "stale-image-at-current-head".into();
        stale.base_revision = 1;
        if let PatchOperation::TextSplice { precondition, .. } = &mut stale.operations[0] {
            precondition.node_hash = hash_bytes("Saved 中文 😀".as_bytes());
        }
        // Learning a fresh document revision cannot authorize an old image
        // snapshot. Even the otherwise valid text edit must not be committed.
        assert!(matches!(
            editor_edits(
                State(state.clone()),
                Path("doc".into()),
                edit_headers(&state, "write"),
                Json(stale)
            )
            .await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        assert_eq!(
            get_text_node(&bundle, &text.node_id).unwrap().node.text,
            "Saved 中文 😀"
        );
        assert!(matches!(
            move_image(
                State(state.clone()),
                Path(("doc".into(), image.node_id.clone())),
                edit_headers(&state, "write"),
                Json(ImageGeometryRequest {
                    expected_revision: 1,
                    expected_visual_hash: None,
                    geometry: geometry.clone()
                })
            )
            .await,
            Err(ApiError(StatusCode::PRECONDITION_REQUIRED, _))
        ));
        assert!(matches!(
            move_image(
                State(state.clone()),
                Path(("doc".into(), image.node_id)),
                edit_headers(&state, "write"),
                Json(ImageGeometryRequest {
                    expected_revision: 1,
                    expected_visual_hash: Some(image.visual_hash),
                    geometry
                })
            )
            .await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        assert_eq!(bundle.manifest().unwrap().revision, 1);
    }

    fn projection() -> EditorProjection {
        EditorProjection {
            document_id: "doc".to_string(),
            revision: 1,
            blocks: vec![EditorBlockView {
                block_id: "block".to_string(),
                block_hash: "block-hash".to_string(),
                region: "body".to_string(),
                read_only: false,
                content: EditorBlockContent {
                    kind: EditorBlockKind::Paragraph,
                    level: None,
                    inlines: vec![EditorInline {
                        text: "Secret 123".to_string(),
                        node_id: Some("n_0123456789abcdef0123456789abcdef".to_string()),
                        bold: true,
                        italic: false,
                        link: None,
                        text_color: None,
                        background_color: None,
                        border: None,
                        ..Default::default()
                    }],
                    ..Default::default()
                },
                read_only_html: None,
            }],
            tracked_changes: Vec::new(),
            comments: Vec::new(),
        }
    }

    #[tokio::test]
    async fn pdf_layout_upgrade_rejects_read_only_tokens_before_storage_access() {
        let root = tempfile::tempdir().unwrap();
        let secret = vec![b'x'; 32];
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize;
        let token = encode(
            &Header::new(Algorithm::HS256),
            &Claims {
                doc: "pdf-doc".into(),
                scope: "read".into(),
                sub: Some("reader".into()),
                name: None,
                aud: "hcd-core".into(),
                iat: now,
                exp: now + 60,
            },
            &EncodingKey::from_secret(&secret),
        )
        .unwrap();
        let state = ServerState {
            root: root.path().to_path_buf(),
            secret: Arc::new(secret),
            remote: None,
            collaboration_lock: Arc::new(Mutex::new(())),
            revisions: RevisionHub::default(),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        let result = upgrade_pdf_layout(
            State(state),
            Path("pdf-doc".into()),
            headers,
            Json(ExpectedRevision {
                expected_revision: 0,
            }),
        )
        .await;
        assert!(matches!(result, Err(ApiError(StatusCode::FORBIDDEN, _))));
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn old_snapshots_cannot_erase_typography_and_size_changes_do_not_use_text_patch() {
        let mut current = projection();
        assert!(require_typography_support(&current, None).is_ok());
        current.blocks[0].content.inlines[0].typography = Some(hcd_core::TextTypography {
            size_pt: Some(14.0),
            family: Some("Arial,serif".into()),
            ..Default::default()
        });
        assert!(matches!(
            require_typography_support(&current, None),
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        assert!(require_typography_support(&current, Some(2)).is_ok());
        assert!(require_typography_support(&current, Some(1)).is_err());
        let mut desired = normalized(current.blocks[0].content.clone());
        desired.inlines[0].text = "Changed text".into();
        let snapshot = vec![SnapshotBlock {
            block_id: Some("block".into()),
            content: desired.clone(),
        }];
        assert!(text_only_operations(&current, &snapshot).is_some());
        desired.inlines[0].typography.as_mut().unwrap().size_pt = Some(20.0);
        let snapshot = vec![SnapshotBlock {
            block_id: Some("block".into()),
            content: desired,
        }];
        assert!(text_only_operations(&current, &snapshot).is_none());
        assert!(presentation_style_operations(&current, &snapshot).is_none());
    }

    #[test]
    fn unchanged_runs_use_source_text_patch_and_format_changes_do_not() {
        let mut current = projection();
        let mut untouched = current.blocks[0].clone();
        untouched.block_id = "untouched".to_string();
        untouched.content.inlines[0].text = "Adjacent ".to_string();
        untouched.content.inlines.push(EditorInline {
            text: "runs".to_string(),
            node_id: Some("n_fedcba9876543210fedcba9876543210".to_string()),
            bold: true,
            italic: false,
            link: None,
            text_color: None,
            background_color: None,
            border: None,
            ..Default::default()
        });
        current.blocks.push(untouched);
        let mut requested: Vec<_> = current
            .blocks
            .iter()
            .map(|block| SnapshotBlock {
                block_id: Some(block.block_id.clone()),
                content: block.content.clone(),
            })
            .collect();
        requested[0].content.inlines[0].text = "Secret ***".to_string();
        let operations = text_only_operations(&current, &requested).unwrap();
        assert_eq!(operations.len(), 1);
        match &operations[0] {
            PatchOperation::TextSplice {
                node_id,
                start,
                delete_count,
                insert_text,
                precondition,
            } => {
                assert_eq!(node_id, "n_0123456789abcdef0123456789abcdef");
                assert_eq!((*start, *delete_count), (7, 3));
                assert_eq!(insert_text, "***");
                assert_eq!(precondition.node_hash, hash_bytes(b"Secret 123"));
            }
            _ => panic!("expected text splice"),
        }

        requested[0].content.inlines[0].bold = false;
        assert!(text_only_operations(&current, &requested).is_none());
        requested[0].content.inlines[0].bold = true;
        requested[0].block_id = None;
        assert!(text_only_operations(&current, &requested).is_none());
    }

    #[test]
    fn nested_list_text_edits_keep_source_anchors() {
        let mut current = projection();
        let original = current.blocks[0].content.clone();
        current.blocks[0].content = EditorBlockContent {
            kind: EditorBlockKind::ListItem,
            level: Some(1),
            list_start: Some(4),
            children: vec![
                original.clone(),
                EditorBlockContent {
                    kind: EditorBlockKind::BulletList,
                    children: vec![EditorBlockContent {
                        kind: EditorBlockKind::ListItem,
                        level: Some(0),
                        inlines: Vec::new(),
                        ..Default::default()
                    }],
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let mut content = current.blocks[0].content.clone();
        content.children[0].inlines[0].text = "changed nested text".into();
        let operations = text_only_operations(
            &current,
            &[SnapshotBlock {
                block_id: Some(current.blocks[0].block_id.clone()),
                content,
            }],
        )
        .unwrap();
        assert_eq!(operations.len(), 1);
        assert_eq!(
            operations[0].node_id(),
            original.inlines[0].node_id.as_deref()
        );
    }

    #[test]
    fn opaque_table_text_stays_on_the_source_splice_path() {
        let mut current = projection();
        current.blocks[0].read_only = true;
        current.blocks[0].content.kind = EditorBlockKind::Opaque;
        let mut requested = vec![SnapshotBlock {
            block_id: Some(current.blocks[0].block_id.clone()),
            content: current.blocks[0].content.clone(),
        }];
        requested[0].content.inlines[0].text = "Cell".to_string();
        let operations = text_only_operations(&current, &requested).unwrap();
        assert!(matches!(
            operations[0],
            PatchOperation::TextSplice { ref insert_text, .. } if insert_text == "Cell"
        ));
        requested[0].content.inlines[0].text_color = Some("#d70015".to_string());
        assert!(text_only_operations(&current, &requested).is_none());
    }

    #[test]
    fn header_text_stays_on_the_source_splice_path() {
        let mut current = projection();
        current.blocks.push(EditorBlockView {
            block_id: "header-block".to_string(),
            block_hash: "header-hash".to_string(),
            region: "header".to_string(),
            read_only: true,
            content: EditorBlockContent {
                kind: EditorBlockKind::Paragraph,
                level: None,
                inlines: vec![EditorInline {
                    text: "Page".to_string(),
                    node_id: Some("n_fedcba9876543210fedcba9876543210".to_string()),
                    bold: false,
                    italic: false,
                    link: None,
                    text_color: None,
                    background_color: None,
                    border: None,
                    ..Default::default()
                }],
                ..Default::default()
            },
            read_only_html: None,
        });
        let mut requested: Vec<_> = current
            .blocks
            .iter()
            .map(|block| SnapshotBlock {
                block_id: Some(block.block_id.clone()),
                content: block.content.clone(),
            })
            .collect();
        requested[1].content.inlines[0].text = "Page 2".to_string();
        let operations = text_only_operations(&current, &requested).unwrap();
        assert_eq!(operations.len(), 1);
        assert!(matches!(
            &operations[0],
            PatchOperation::TextSplice { node_id, start:4, delete_count:0, insert_text, .. }
                if node_id == "n_fedcba9876543210fedcba9876543210" && insert_text == " 2"
        ));
        requested.pop();
        assert!(text_only_operations(&current, &requested).is_none());
    }

    #[test]
    fn color_only_edits_become_node_style_operations() {
        let current = projection();
        let mut requested = vec![SnapshotBlock {
            block_id: Some(current.blocks[0].block_id.clone()),
            content: current.blocks[0].content.clone(),
        }];
        requested[0].content.inlines[0].text_color = Some("#0A84FF".to_string());
        assert!(text_only_operations(&current, &requested).is_none());
        let operations = presentation_style_operations(&current, &requested).unwrap();
        match &operations[0] {
            PatchOperation::NodeStyle { node_id, style, .. } => {
                assert_eq!(node_id, "n_0123456789abcdef0123456789abcdef");
                assert_eq!(style.text_color.as_deref(), Some("#0A84FF"));
                assert!(style.background_color.is_none());
            }
            _ => panic!("expected node.style"),
        }
        requested[0].content.inlines[0].text_color = None;
        requested[0].content.inlines[0].text = "changed".to_string();
        assert!(presentation_style_operations(&current, &requested).is_none());
    }

    #[test]
    fn border_only_edits_become_node_style_operations() {
        let current = projection();
        let mut requested = vec![SnapshotBlock {
            block_id: Some(current.blocks[0].block_id.clone()),
            content: current.blocks[0].content.clone(),
        }];
        requested[0].content.inlines[0].border = Some(hcd_core::NodeBorder {
            color: "#1F2328".to_string(),
            width_pt: 1.0,
            style: hcd_core::NodeBorderStyle::Solid,
        });
        assert!(text_only_operations(&current, &requested).is_none());
        let operations = presentation_style_operations(&current, &requested).unwrap();
        match &operations[0] {
            PatchOperation::NodeStyle { style, .. } => {
                let border = style.border.as_ref().unwrap();
                assert_eq!(border.color, "#1F2328");
                assert_eq!(border.style, hcd_core::NodeBorderStyle::Solid);
                assert!(style.text_color.is_none());
            }
            _ => panic!("expected node.style"),
        }
    }

    #[test]
    fn collaboration_service_records_contributors_and_user_tokens_win() {
        let user = Claims {
            doc: "doc".to_string(),
            scope: "write".to_string(),
            sub: Some("editor-1".to_string()),
            name: Some("Editor 1".to_string()),
            aud: "hcd-core".to_string(),
            iat: 0,
            exp: 1,
        };
        let actor = author_actor(
            &user,
            &[Contributor {
                user_id: "other".to_string(),
                display_name: "Other".to_string(),
            }],
        );
        assert_eq!(actor.get("userId").map(String::as_str), Some("editor-1"));
        assert_eq!(
            actor.get("displayName").map(String::as_str),
            Some("Editor 1")
        );

        let service = Claims {
            sub: Some("hcd-collaboration".to_string()),
            name: Some("Collaboration autosave".to_string()),
            ..user
        };
        let actor = author_actor(
            &service,
            &[
                Contributor {
                    user_id: "editor-1".to_string(),
                    display_name: "Editor 1".to_string(),
                },
                Contributor {
                    user_id: "editor-2".to_string(),
                    display_name: "Editor 2".to_string(),
                },
            ],
        );
        assert_eq!(actor.get("userId").map(String::as_str), Some("editor-1"));
        assert_eq!(
            actor.get("displayName").map(String::as_str),
            Some("Editor 1, Editor 2")
        );
    }

    #[test]
    fn contributor_names_never_panic_when_the_utf8_budget_splits_a_character() {
        let service = Claims {
            doc: "doc".into(),
            scope: "write".into(),
            sub: Some("hcd-collaboration".into()),
            name: None,
            aud: "hcd-core".into(),
            iat: 0,
            exp: 1,
        };
        let contributors: Vec<_> = (0..4)
            .map(|index| Contributor {
                user_id: format!("user-{index}"),
                display_name: "中".repeat(21),
            })
            .collect();
        let actor = author_actor(&service, &contributors);
        assert_eq!(actor["displayName"].len(), 255);
        assert!(hcd_core::revision_author(&actor).is_ok());
    }

    #[test]
    fn text_endpoint_accepts_splices_and_stamps_the_token_actor() {
        let actor = BTreeMap::from([
            ("userId".to_string(), "editor-1".to_string()),
            ("displayName".to_string(), "Editor 1".to_string()),
        ]);
        let splice = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION.to_string(),
            document_id: "doc".to_string(),
            patch_id: "patch-1".to_string(),
            base_revision: 3,
            actor: BTreeMap::from([("client".to_string(), "spoofed".to_string())]),
            operations: vec![PatchOperation::TextSplice {
                node_id: "n_0123456789abcdef0123456789abcdef".to_string(),
                start: 0,
                delete_count: 1,
                insert_text: "A".to_string(),
                precondition: NodePrecondition {
                    node_hash: "a".repeat(64),
                },
            }],
            metadata: BTreeMap::from([("rootHash".to_string(), "ignored".to_string())]),
        };
        let prepared = prepare_text_patch(splice, "doc", actor.clone()).unwrap();
        assert_eq!(
            prepared.actor.get("userId").map(String::as_str),
            Some("editor-1")
        );
        assert!(!prepared.actor.contains_key("client"));
        assert!(prepared.metadata.is_empty());

        let styled = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION.to_string(),
            document_id: "doc".to_string(),
            patch_id: "patch-2".to_string(),
            base_revision: 3,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::NodeStyle {
                node_id: "n_0123456789abcdef0123456789abcdef".to_string(),
                style: NodeStylePatch {
                    text_color: Some("#112233".to_string()),
                    background_color: None,
                    border: None,
                },
                precondition: NodePrecondition {
                    node_hash: "a".repeat(64),
                },
            }],
            metadata: BTreeMap::new(),
        };
        let error = prepare_text_patch(styled, "doc", actor).unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn revision_hub_notifies_only_the_subscribed_document() {
        let hub = RevisionHub::default();
        let mut first = hub.subscribe("doc");
        let mut other = hub.subscribe("other");
        hub.publish("doc", 4);
        assert_eq!(first.try_recv().unwrap(), 4);
        assert!(other.try_recv().is_err());
    }
}
