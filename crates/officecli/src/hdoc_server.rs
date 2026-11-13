//! Authenticated local HCD core API. Bundles stay private under the configured root.
//! The HTTP surface only returns decoded, verified objects requested by the client.
use crate::commands::hdoc::{HdocIssueTokenCommand, HdocServeCommand, HdocTokenScope};
use crate::hdoc_remote::RemoteStore;
use anyhow::{anyhow, Context, Result};
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::Engine;
use futures::StreamExt;
use hcd_core::{
    apply_patch, apply_structure_patch, audit_action, detect_font_format, editor_projection,
    hash_file, list_documents, manifest_at_revision, pin_document_theme, project_editor,
    resolve_document_theme, restore_revision, search_bundle, theme_documents, unpin_document_theme,
    AuditRecord, BlockPrecondition, Bundle, DiskCatalog, DocumentSummary, EditorBlockContent,
    EditorInline, FontDeleteReport, FontFace, FontFileFormat, FontLicense, FontRevision,
    FontScript, FontStretch, FontStyle, HcdError, PatchBatch, StructureOperation,
    StructurePatchBatch, ThemeDocumentRef, ThemeFontSlots, ThemeRevision, FONT_CATALOG_SCHEMA,
    HCD_PATCH_SCHEMA_VERSION_4, MAX_AUDIT_LIMIT, MAX_FONT_BYTES, MAX_PATCH_JSON_BYTES,
    THEME_SCHEMA,
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
    catalog: DiskCatalog,
    secret: Arc<Vec<u8>>,
    remote: Option<RemoteStore>,
    /// Theme pinned onto newly imported documents; `None` keeps today's unpinned behavior.
    default_theme: Option<String>,
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
        || command.document_id == "*"
            && matches!(
                command.scope,
                HdocTokenScope::Upload | HdocTokenScope::Admin
            ))
    {
        return Err(anyhow!(
            "document ID must be 1-128 ASCII letters, digits, _ or -, or '*' for an upload or admin token"
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
            HdocTokenScope::Admin => "admin",
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
    let catalog = DiskCatalog::open(match &command.catalog {
        Some(path) => path.clone(),
        None => root.join("catalog"),
    })?;
    let default_theme = configured_default_theme(command.default_theme.clone())?;
    let state = ServerState {
        root,
        catalog,
        secret,
        remote,
        default_theme,
        collaboration_lock: Arc::new(Mutex::new(())),
        downloads: Arc::new(Mutex::new(HashMap::new())),
    };
    let router = Router::new()
        .route("/health", get(|| async { Json(json!({"ok": true})) }))
        .route("/admin", get(catalog_admin))
        .route("/v1/documents", get(catalog_documents))
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
        .route(
            "/v1/documents/{id}/theme",
            get(document_theme).put(pin_theme),
        )
        .route(
            "/v1/documents/{id}/theme/files/{sha256}",
            get(document_theme_file),
        )
        .route("/v1/themes/{theme_revision_id}", get(theme_revision))
        .route(
            "/v1/themes/{theme_revision_id}/files/{font_id}/{font_revision_id}/{sha256}",
            get(theme_file),
        )
        .route("/v1/catalog/audit", get(catalog_audit))
        .route("/v1/catalog/fonts", get(catalog_fonts))
        .route(
            "/v1/catalog/fonts/{font_id}",
            get(catalog_font).delete(catalog_delete_font),
        )
        .route(
            "/v1/catalog/fonts/{font_id}/blobs",
            post(catalog_put_blob).route_layer(DefaultBodyLimit::max(MAX_FONT_BYTES as usize)),
        )
        .route(
            "/v1/catalog/fonts/{font_id}/revisions",
            post(catalog_put_font_revision),
        )
        .route(
            "/v1/catalog/fonts/{font_id}/revisions/{revision}",
            delete(catalog_delete_font_revision),
        )
        .route(
            "/v1/catalog/themes",
            get(catalog_themes).post(catalog_put_theme),
        )
        .route("/v1/catalog/themes/retired", get(catalog_retired_themes))
        .route(
            "/v1/catalog/themes/{theme_revision_id}/retire",
            post(catalog_retire_theme).delete(catalog_unretire_theme),
        )
        .route(
            "/v1/catalog/themes/{theme_revision_id}/documents",
            get(catalog_theme_documents),
        )
        .route(
            "/v1/catalog/themes/{theme_revision_id}",
            delete(catalog_delete_theme),
        )
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

/// Upload routes need a token of their own scope, and the claims are handed back
/// so a default-theme auto-pin can record who imported the document.
fn authorize_upload(state: &ServerState, headers: &HeaderMap) -> Result<Claims, ApiError> {
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
    Ok(claims)
}

/// `--default-theme` names a catalog theme revision, so it must be a 64-character lowercase digest.
fn configured_default_theme(value: Option<String>) -> Result<Option<String>> {
    match value {
        None => Ok(None),
        Some(id) if valid_digest_hex(&id) => Ok(Some(id)),
        Some(_) => Err(anyhow!(
            "--default-theme must be a 64-character lowercase theme revision id"
        )),
    }
}

/// Pin the service default theme onto a freshly imported bundle.
///
/// A bundle that already carries a pin — an HCD archive re-imported with its own brand —
/// keeps it, because the default only fills in for documents that have no theme yet.
/// A stale, retired, or unreadable theme must not strand the document an operator just
/// uploaded, so the failure becomes a job warning instead of a failed import.
///
/// `actor` is who uploaded the document: the pin itself is the service's policy
/// (`--default-theme`), but the operation log should say whose import caused it.
/// Here a refused audit line degrades to a job warning rather than a failed
/// request, because the pin is already committed and the import is best-effort.
fn pin_default_theme(
    catalog: &DiskCatalog,
    default_theme: Option<&str>,
    destination: &std::path::Path,
    actor: &str,
) -> Option<String> {
    let theme_id = default_theme?;
    let bundle = match Bundle::open(destination) {
        Ok(bundle) => bundle,
        Err(error) => {
            return Some(format!("default theme {theme_id} was not pinned: {error}"));
        }
    };
    if bundle
        .manifest()
        .map(|manifest| manifest.theme_revision_id.is_some())
        .unwrap_or(false)
    {
        return None;
    }
    match pin_document_theme(catalog, &bundle, theme_id) {
        Ok(manifest) => catalog
            .record_audit(AuditRecord {
                action: audit_action::DOCUMENT_THEME_PIN,
                target: &manifest.document_id,
                actor,
                detail: &format!(
                    "导入时按服务默认主题自动钉上 {theme_id}，写入修订 r{}",
                    manifest.revision
                ),
            })
            .err()
            .map(|error| format!("默认主题已钉上，但操作记录没有写入: {error}")),
        Err(error) => Some(format!("default theme {theme_id} was not pinned: {error}")),
    }
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
    let claims = authorize_upload(&state, &headers)?;
    // Resolved before the job is spawned: the background task cannot reach the
    // request headers, but the auto-pin it may perform still needs an actor.
    let actor = audit_actor(&claims);
    let extension = std::path::Path::new(&query.filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "docx" | "html" | "htm" | "md" | "markdown" | "txt" | "pdf" | "pptx" | "xlsx" | "hcd"
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
    if extension == "hcd" {
        return import_hcd_archive(state, temporary, job_id, actor).await;
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
    let catalog = state.catalog.clone();
    let default_theme = state.default_theme.clone();
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
            let mut warnings = Vec::new();
            if let Some(warning) =
                pin_default_theme(&catalog, default_theme.as_deref(), &destination, &actor)
            {
                warnings.push(warning);
            }
            if let Some(remote) = &remote {
                remote
                    .publish(&job_document_id, &destination, Some(&source), None)
                    .await?;
            }
            Result::<Vec<String>>::Ok(warnings)
        }
        .await;
        let (status, error, warnings) = match run {
            Ok(warnings) => ("completed", None, warnings),
            Err(error) => ("failed", Some(error.to_string()), Vec::new()),
        };
        let _ = write_job(&job_path, remote.as_ref(), &spawned_job_id,
            json!({"jobId": spawned_job_id, "documentId": job_document_id, "state": status, "error": error, "warnings": warnings})).await;
    });
    Ok(Json(
        json!({"jobId": job_id, "documentId": document_id, "state": "queued"}),
    ))
}

async fn import_hcd_archive(
    state: ServerState,
    archive: PathBuf,
    job_id: String,
    actor: String,
) -> Result<Json<Value>, ApiError> {
    let inspected = match hcd_core::inspect_archive(&archive) {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = tokio::fs::remove_file(&archive).await;
            return Err(bad(error));
        }
    };
    if !valid_id(&inspected.document_id) {
        tokio::fs::remove_file(&archive).await.map_err(internal)?;
        return Err(bad("invalid HCD document ID"));
    }
    let document_id = inspected.document_id;
    let destination = state.root.join(format!("{document_id}.hcd"));
    let jobs = state.root.join("jobs");
    tokio::fs::create_dir_all(&jobs).await.map_err(internal)?;
    let job_path = jobs.join(format!("{job_id}.json"));
    if destination.exists() {
        tokio::fs::remove_file(&archive).await.map_err(internal)?;
        return Err(ApiError(
            StatusCode::CONFLICT,
            format!("document {document_id} already exists"),
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
    let remote = state.remote.clone();
    let spawned_job_id = job_id.clone();
    let job_document_id = document_id.clone();
    let catalog = state.catalog.clone();
    let default_theme = state.default_theme.clone();
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
                .arg("unpack")
                .arg(&archive)
                .arg("--output")
                .arg(&destination)
                .output()
                .await?;
            if !output.status.success() {
                return Err(anyhow!(
                    "HCD archive import failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            let mut warnings = Vec::new();
            if let Some(warning) =
                pin_default_theme(&catalog, default_theme.as_deref(), &destination, &actor)
            {
                warnings.push(warning);
            }
            if let Some(remote) = &remote {
                remote
                    .publish(&job_document_id, &destination, None, None)
                    .await?;
            }
            Result::<Vec<String>>::Ok(warnings)
        }
        .await;
        let _ = tokio::fs::remove_file(&archive).await;
        let (status, error, warnings) = match run {
            Ok(warnings) => ("completed", None, warnings),
            Err(error) => ("failed", Some(error.to_string()), Vec::new()),
        };
        let _ = write_job(&job_path, remote.as_ref(), &spawned_job_id,
            json!({"jobId": spawned_job_id, "documentId": job_document_id, "state": status, "error": error, "warnings": warnings})).await;
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
        HcdError::NodeNotFound(_) | HcdError::NotFound(_) => StatusCode::NOT_FOUND,
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

/// Which token may change the theme a document pins.
///
/// A theme pin is a brand decision about the document rather than an edit of its
/// text: it commits managed stylesheet lines and touches no node, so the
/// management console has to be able to retarget documents with the operator
/// token it already holds instead of minting a short-lived write token per
/// document. Every route that changes content still requires a token written for
/// that document, so this is the one place the admin token reaches a document.
fn authorize_theme(state: &ServerState, headers: &HeaderMap, id: &str) -> Result<Claims, ApiError> {
    // The claims are returned, not just checked: the pin has to record who made it.
    if let Ok(claims) = authorize_admin(state, headers) {
        return Ok(claims);
    }
    write_claims(state, headers, id)
}

fn authorize_catalog(state: &ServerState, headers: &HeaderMap) -> Result<(), ApiError> {
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
    if claims.scope == "admin" && claims.doc == "*" {
        // The management console previews themes and font files.
        return Ok(());
    }
    if !matches!(claims.scope.as_str(), "read" | "write") || !valid_id(&claims.doc) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "catalog read requires a document read or write token".to_string(),
        ));
    }
    Ok(())
}

/// Catalog administration requires an operator token: scope `admin` issued for
/// `doc: "*"`. Document-scoped read or write tokens never reach these routes.
fn authorize_admin(state: &ServerState, headers: &HeaderMap) -> Result<Claims, ApiError> {
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
    let actor = decode::<Claims>(token, &DecodingKey::from_secret(&state.secret), &validation)
        .map_err(|_| {
            ApiError(
                StatusCode::UNAUTHORIZED,
                "invalid or expired token".to_string(),
            )
        })?
        .claims;
    if actor.scope != "admin" || actor.doc != "*" {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "catalog management requires an admin token".to_string(),
        ));
    }
    Ok(actor)
}

/// Who a token belongs to, as the audit log records it.
///
/// Tokens already carry `--user-id` and `--display-name`, so an operator who
/// mints one for themselves shows up by name. Control characters are stripped
/// rather than rejected: they come from whatever the token said, and one must
/// not be able to forge a second log line or break a record that was already
/// written. A token with no identity still says which kind of credential acted.
fn audit_actor(claims: &Claims) -> String {
    let clean = |value: &str| -> String {
        value
            .chars()
            .filter(|character| !character.is_control())
            .take(64)
            .collect::<String>()
            .trim()
            .to_string()
    };
    let name = claims.name.as_deref().map(str::trim).map(clean);
    let id = claims.sub.as_deref().map(str::trim).map(clean);
    match (
        name.filter(|value| !value.is_empty()),
        id.filter(|value| !value.is_empty()),
    ) {
        (Some(name), Some(id)) if name != id => format!("{name} ({id})"),
        (Some(name), _) => name,
        (_, Some(id)) => id,
        (None, None) => format!("{}:{}", clean(&claims.scope), clean(&claims.doc)),
    }
}

/// Append one finished catalog operation to the audit log.
///
/// Called after the change took effect, so a record never describes work that
/// did not happen. The flip side is chosen deliberately: if the line cannot be
/// written the request still reports failure, because an operation that changed
/// the catalog without leaving a trace is the hole this log exists to close.
fn record_catalog_audit(
    catalog: &DiskCatalog,
    claims: &Claims,
    action: &str,
    target: &str,
    detail: String,
) -> Result<(), ApiError> {
    catalog
        .record_audit(AuditRecord {
            action,
            target,
            actor: &audit_actor(claims),
            detail: &detail,
        })
        .map(|_| ())
        .map_err(|error| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("变更已经生效，但操作记录没有写入：{error}"),
            )
        })
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

/// `GET /v1/documents/{id}/theme`. `faces=only` returns just the `@font-face`
/// rules: the pin writes the variables and the family rules into the document's
/// own stylesheet as a content revision, so a surface that renders that
/// stylesheet asks for the font bytes alone instead of getting the same
/// declarations twice.
#[derive(Deserialize)]
struct ThemeQuery {
    revision: Option<u64>,
    faces: Option<String>,
}

/// Keep only the `@font-face` lines of a resolved theme stylesheet. Each rule is
/// emitted on its own line by `DiskCatalog::resolve`, and the declarations that
/// belong to the document are the rest.
fn font_faces_only(css: &str) -> String {
    css.lines()
        .filter(|line| line.starts_with("@font-face{"))
        .fold(String::new(), |mut kept, line| {
            kept.push_str(line);
            kept.push('\n');
            kept
        })
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

fn document_font_href(
    document_id: &str,
    _font_id: &str,
    _font_revision_id: &str,
    sha256: &str,
) -> String {
    format!("/v1/documents/{document_id}/theme/files/{sha256}")
}

fn theme_font_href(
    theme_revision_id: &str,
    font_id: &str,
    font_revision_id: &str,
    sha256: &str,
) -> String {
    format!("/v1/themes/{theme_revision_id}/files/{font_id}/{font_revision_id}/{sha256}")
}

async fn document_theme(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<ThemeQuery>,
    headers: HeaderMap,
) -> Result<Json<hcd_core::DocumentThemeResolution>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let mut resolved = resolve_document_theme(
        &state.catalog,
        &bundle,
        query.revision,
        |font_id, revision, sha| document_font_href(&id, font_id, revision, sha),
    )
    .map_err(hcd_error)?;
    match query.faces.as_deref() {
        None | Some("") => {}
        Some("only") => resolved.theme.css = font_faces_only(&resolved.theme.css),
        Some(other) => {
            return Err(bad(format!(
                "unknown faces value {other}; only faces=only is supported"
            )))
        }
    }
    Ok(Json(resolved))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PinThemeBody {
    /// The catalog theme to pin. `null` removes the current pin and leaves the
    /// document on the faces it carries itself. The field must be present: an empty
    /// `{}` body silently unpinning a document would make a typo destructive.
    #[serde(deserialize_with = "explicit_theme_pin")]
    theme_revision_id: Option<String>,
}

/// Reads `themeRevisionId` so that a string pins, an explicit `null` unpins, and an
/// absent field is a bad request. Plain `Option<String>` would treat absent and
/// null alike, and the two mean opposite things here.
fn explicit_theme_pin<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

async fn pin_theme(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PinThemeBody>,
) -> Result<Json<hcd_core::DocumentThemeResolution>, ApiError> {
    let claims = authorize_theme(&state, &headers, &id)?;
    let bundle = open(&state, &id)?;
    // A re-pin of the theme already on the head, or an unpin of a document that
    // carries nothing, is a no-op the commit path reports with the same revision
    // number. Those requests are not recorded: the log answers "who changed
    // what", and a repeated click on an unchanged document changed nothing.
    let before = bundle.manifest().map_err(internal)?.revision;
    let (manifest, action, detail) = match body.theme_revision_id.as_deref() {
        Some(theme_revision_id) => {
            let manifest = pin_document_theme(&state.catalog, &bundle, theme_revision_id)
                .map_err(hcd_error)?;
            // The name comes from the catalog, which the pin already proved
            // resolves; a theme deleted out from under us still leaves the digest.
            let named = state
                .catalog
                .get_theme(theme_revision_id)
                .map(|theme| format!("「{}」", theme.name))
                .unwrap_or_default();
            (
                manifest,
                audit_action::DOCUMENT_THEME_PIN,
                format!("钉上主题{named}（{}）", short_digest(theme_revision_id)),
            )
        }
        None => (
            unpin_document_theme(&state.catalog, &bundle).map_err(hcd_error)?,
            audit_action::DOCUMENT_THEME_UNPIN,
            "取消钉版，文档回到自己的样式".to_string(),
        ),
    };
    if manifest.revision != before {
        record_catalog_audit(
            &state.catalog,
            &claims,
            action,
            &manifest.document_id,
            format!("{}，修订 r{before} → r{}", detail, manifest.revision),
        )?;
    }
    if body.theme_revision_id.is_none() {
        // An unpin leaves nothing to resolve: resolve_document_theme reports a
        // missing pin as 404, and answering a successful call with that would
        // make the console show an error for work that is done. Report the new
        // revision with an empty theme instead.
        return Ok(Json(hcd_core::DocumentThemeResolution {
            document_id: manifest.document_id,
            revision: manifest.revision,
            theme_revision_id: String::new(),
            theme: hcd_core::ResolvedTheme {
                theme_revision_id: String::new(),
                name: String::new(),
                css: String::new(),
                faces: Vec::new(),
                warnings: Vec::new(),
            },
        }));
    }
    let resolved =
        resolve_document_theme(&state.catalog, &bundle, None, |font_id, revision, sha| {
            document_font_href(&id, font_id, revision, sha)
        })
        .map_err(hcd_error)?;
    Ok(Json(resolved))
}

async fn document_theme_file(
    State(state): State<ServerState>,
    Path((id, sha256)): Path<(String, String)>,
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let resolved = resolve_document_theme(
        &state.catalog,
        &bundle,
        query.revision,
        |font_id, revision, sha| document_font_href(&id, font_id, revision, sha),
    )
    .map_err(hcd_error)?;
    let face = resolved
        .theme
        .faces
        .iter()
        .find(|face| face.sha256 == sha256 && face.web_preview)
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                "preview face is not in the pinned theme".to_string(),
            )
        })?;
    let (bytes, format) = state
        .catalog
        .read_web_face(
            &resolved.theme_revision_id,
            &face.font_id,
            &face.font_revision_id,
            &sha256,
        )
        .map_err(hcd_error)?;
    font_response(bytes, format)
}

async fn theme_revision(
    State(state): State<ServerState>,
    Path(theme_revision_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<hcd_core::ResolvedTheme>, ApiError> {
    authorize_catalog(&state, &headers)?;
    let theme = state
        .catalog
        .resolve(&theme_revision_id, |font_id, revision, sha| {
            theme_font_href(&theme_revision_id, font_id, revision, sha)
        })
        .map_err(hcd_error)?;
    Ok(Json(theme))
}

async fn theme_file(
    State(state): State<ServerState>,
    Path((theme_revision_id, font_id, font_revision_id, sha256)): Path<(
        String,
        String,
        String,
        String,
    )>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize_catalog(&state, &headers)?;
    let (bytes, format) = state
        .catalog
        .read_web_face(&theme_revision_id, &font_id, &font_revision_id, &sha256)
        .map_err(hcd_error)?;
    font_response(bytes, format)
}

fn font_response(bytes: Vec<u8>, format: hcd_core::FontFileFormat) -> Result<Response, ApiError> {
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        format.media_type().parse().map_err(internal)?,
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "private, immutable, max-age=31536000"
            .parse()
            .map_err(internal)?,
    );
    Ok(response)
}

/// Same-machine font catalog console. The built page is embedded so `hdoc serve`
/// serves it same-origin and the binary stays self-contained; every call carries
/// the pasted admin token.
///
/// Source: `examples/hdoc/admin-app` (React + Tailwind + shadcn/ui primitives),
/// built with `npm run build`, which inlines the bundle into this one HTML file.
/// The checked-in `embed/index.html` is what ships — edit the app and rebuild,
/// not the built file.
const CATALOG_ADMIN_HTML: &str = include_str!("../../../examples/hdoc/admin-app/embed/index.html");

async fn catalog_admin() -> Result<Response, ApiError> {
    let mut response = Response::new(Body::from(CATALOG_ADMIN_HTML));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        "text/html; charset=utf-8".parse().map_err(internal)?,
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().map_err(internal)?);
    Ok(response)
}

fn valid_font_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && !id.starts_with('-')
        && !id.ends_with('-')
}

/// A content-addressed catalog id is a 64-character lowercase hex digest.
fn valid_digest_hex(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn parse_font_format(value: &str) -> Result<FontFileFormat, ApiError> {
    match value {
        "woff2" => Ok(FontFileFormat::Woff2),
        "otf" => Ok(FontFileFormat::Otf),
        "ttf" => Ok(FontFileFormat::Ttf),
        other => Err(bad(format!("unsupported font format {other}"))),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogFontEntry {
    font_id: String,
    family: String,
    revisions: Vec<FontRevision>,
}

async fn catalog_fonts(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<Vec<CatalogFontEntry>>, ApiError> {
    authorize_admin(&state, &headers)?;
    let mut fonts = Vec::new();
    for font_id in state.catalog.list_font_ids().map_err(hcd_error)? {
        let revisions = state.catalog.font_revisions(&font_id).map_err(hcd_error)?;
        let family = revisions
            .first()
            .map(|revision| revision.family.clone())
            .unwrap_or_default();
        fonts.push(CatalogFontEntry {
            font_id,
            family,
            revisions,
        });
    }
    Ok(Json(fonts))
}

async fn catalog_font(
    State(state): State<ServerState>,
    Path(font_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<FontRevision>>, ApiError> {
    authorize_admin(&state, &headers)?;
    if !valid_font_id(&font_id) {
        return Err(bad(
            "fontId must be 1-64 lowercase letters, digits, or hyphens",
        ));
    }
    Ok(Json(
        state.catalog.font_revisions(&font_id).map_err(hcd_error)?,
    ))
}

async fn catalog_delete_font(
    State(state): State<ServerState>,
    Path(font_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<FontDeleteReport>, ApiError> {
    let claims = authorize_admin(&state, &headers)?;
    if !valid_font_id(&font_id) {
        return Err(bad(
            "fontId must be 1-64 lowercase letters, digits, or hyphens",
        ));
    }
    let report = state.catalog.delete_font(&font_id).map_err(hcd_error)?;
    record_catalog_audit(
        &state.catalog,
        &claims,
        audit_action::FONT_DELETE,
        &font_id,
        format!(
            "删除 {} 个字体修订；{}{}。",
            report.removed_revisions.len(),
            if report.removed_blobs.is_empty() {
                "没有字库失去最后一个引用".to_string()
            } else {
                format!("回收 {} 个字库", report.removed_blobs.len())
            },
            // The ids are the log's own evidence, so a few are named in full.
            match report.removed_revisions.len() {
                0 => String::new(),
                1 => format!("（修订 {}）", short_digest(&report.removed_revisions[0])),
                count => format!(
                    "（含最近的 {}）",
                    short_digest(&report.removed_revisions[count - 1])
                ),
            }
        ),
    )?;
    Ok(Json(report))
}

async fn catalog_delete_font_revision(
    State(state): State<ServerState>,
    Path((font_id, revision)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<FontDeleteReport>, ApiError> {
    let claims = authorize_admin(&state, &headers)?;
    if !valid_font_id(&font_id) {
        return Err(bad(
            "fontId must be 1-64 lowercase letters, digits, or hyphens",
        ));
    }
    if !valid_digest_hex(&revision) {
        return Err(bad("fontRevisionId must be a lowercase SHA-256 digest"));
    }
    let report = state
        .catalog
        .delete_font_revision(&font_id, &revision)
        .map_err(hcd_error)?;
    record_catalog_audit(
        &state.catalog,
        &claims,
        audit_action::FONT_REVISION_DELETE,
        &format!("{font_id}/{revision}"),
        format!(
            "删除修订 {}；{}。字体其它修订不受影响",
            short_digest(&revision),
            if report.removed_blobs.is_empty() {
                "没有字库失去最后一个引用".to_string()
            } else {
                format!(
                    "回收 {} 个字库（{}）",
                    report.removed_blobs.len(),
                    short_digest(&report.removed_blobs[0])
                )
            }
        ),
    )?;
    Ok(Json(report))
}

#[derive(Deserialize)]
struct BlobQuery {
    format: String,
}

async fn catalog_put_blob(
    State(state): State<ServerState>,
    Path(font_id): Path<String>,
    Query(query): Query<BlobQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_admin(&state, &headers)?;
    if !valid_font_id(&font_id) {
        return Err(bad(
            "fontId must be 1-64 lowercase letters, digits, or hyphens",
        ));
    }
    let format = parse_font_format(&query.format)?;
    if body.is_empty() {
        return Err(bad("empty font file"));
    }
    match detect_font_format(&body) {
        Some(detected) if detected == format => {}
        Some(detected) => {
            return Err(bad(format!(
                "font file magic is {} but format={}",
                detected.media_type(),
                query.format
            )))
        }
        None => return Err(bad("unrecognized font file; expected woff2, otf, or ttf")),
    }
    let sha256 = state
        .catalog
        .put_font_bytes(&body, format)
        .map_err(hcd_error)?;
    record_catalog_audit(
        &state.catalog,
        &claims,
        audit_action::FONT_BYTES_PUT,
        &font_id,
        format!(
            "存入字库 {sha256}（{} 字节，{}）；同一摘要的重复上传不增加字节",
            body.len(),
            query.format
        ),
    )?;
    Ok(Json(json!({
        "sha256": sha256,
        "byteLength": body.len(),
        "format": query.format,
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UploadedFace {
    subfamily: String,
    weight: u16,
    style: FontStyle,
    stretch: FontStretch,
    scripts: Vec<FontScript>,
    format: FontFileFormat,
    sha256: String,
    byte_length: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NewFontRevisionBody {
    family: String,
    faces: Vec<UploadedFace>,
    license: FontLicense,
}

async fn catalog_put_font_revision(
    State(state): State<ServerState>,
    Path(font_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<NewFontRevisionBody>,
) -> Result<Json<FontRevision>, ApiError> {
    let claims = authorize_admin(&state, &headers)?;
    if !valid_font_id(&font_id) {
        return Err(bad(
            "fontId must be 1-64 lowercase letters, digits, or hyphens",
        ));
    }
    let family = body.family;
    let revision = FontRevision {
        schema_version: FONT_CATALOG_SCHEMA.to_string(),
        font_id: font_id.clone(),
        font_revision_id: String::new(),
        family: family.clone(),
        faces: body
            .faces
            .into_iter()
            .map(|face| FontFace {
                family: family.clone(),
                subfamily: face.subfamily,
                weight: face.weight,
                style: face.style,
                stretch: face.stretch,
                scripts: face.scripts,
                format: face.format,
                sha256: face.sha256,
                byte_length: face.byte_length,
            })
            .collect(),
        license: body.license,
    };
    let stored = state
        .catalog
        .put_font_revision(&revision)
        .map_err(hcd_error)?;
    let license = format!(
        "许可证 {}（网页预览{}，docx/pptx{}，pdf{}，再分发{}{}）",
        stored.license.name,
        if stored.license.web_preview {
            "可"
        } else {
            "不可"
        },
        if stored.license.ooxml_embed {
            "可"
        } else {
            "不可"
        },
        if stored.license.pdf_embed {
            "可"
        } else {
            "不可"
        },
        if stored.license.redistribution {
            "可"
        } else {
            "不可"
        },
        match stored.license.expires_at_epoch_ms {
            Some(expires) => format!("，到期 {expires}"),
            None => String::new(),
        }
    );
    record_catalog_audit(
        &state.catalog,
        &claims,
        audit_action::FONT_REVISION_PUT,
        &font_id,
        format!(
            "登记修订 {}，字族「{}」，{} 个 face；{license}",
            short_digest(&stored.font_revision_id),
            stored.family,
            stored.faces.len()
        ),
    )?;
    Ok(Json(stored))
}

/// First and last characters of a digest, for a log line a human reads.
fn short_digest(value: &str) -> String {
    if value.chars().count() <= 16 {
        return value.to_string();
    }
    let head: String = value.chars().take(8).collect();
    let tail: String = value
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("{head}…{tail}")
}

async fn catalog_themes(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ThemeRevision>>, ApiError> {
    authorize_admin(&state, &headers)?;
    Ok(Json(state.catalog.list_themes().map_err(hcd_error)?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NewThemeBody {
    name: String,
    major: ThemeFontSlots,
    minor: ThemeFontSlots,
    fallback_families: Vec<String>,
}

async fn catalog_put_theme(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<NewThemeBody>,
) -> Result<Json<ThemeRevision>, ApiError> {
    let claims = authorize_admin(&state, &headers)?;
    let theme = ThemeRevision {
        schema_version: THEME_SCHEMA.to_string(),
        theme_revision_id: String::new(),
        name: body.name,
        major: body.major,
        minor: body.minor,
        fallback_families: body.fallback_families,
    };
    let theme_revision_id = state.catalog.put_theme(&theme).map_err(hcd_error)?;
    let stored = state
        .catalog
        .get_theme(&theme_revision_id)
        .map_err(hcd_error)?;
    record_catalog_audit(
        &state.catalog,
        &claims,
        audit_action::THEME_PUT,
        &theme_revision_id,
        format!(
            "保存主题「{}」为修订 {}；标题槽位 {}，正文槽位 {}，回退 {}",
            stored.name,
            short_digest(&theme_revision_id),
            slot_count(&stored.major),
            slot_count(&stored.minor),
            if stored.fallback_families.is_empty() {
                "无".to_string()
            } else {
                stored.fallback_families.join(" / ")
            }
        ),
    )?;
    Ok(Json(stored))
}

/// How many script slots a theme pair fills.
fn slot_count(slots: &ThemeFontSlots) -> usize {
    [&slots.latin, &slots.east_asia, &slots.bidi]
        .into_iter()
        .flatten()
        .count()
}

async fn catalog_retired_themes(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<Vec<String>>, ApiError> {
    authorize_admin(&state, &headers)?;
    Ok(Json(
        state.catalog.list_retired_theme_ids().map_err(hcd_error)?,
    ))
}

async fn catalog_retire_theme(
    State(state): State<ServerState>,
    Path(theme_revision_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_admin(&state, &headers)?;
    if !valid_digest_hex(&theme_revision_id) {
        return Err(bad("themeRevisionId must be a lowercase SHA-256 digest"));
    }
    // Read before the change: a later build could refuse, and only the name
    // already fetched is safe to quote in the record.
    let name = state
        .catalog
        .get_theme(&theme_revision_id)
        .map_err(hcd_error)?
        .name;
    // Asked before the change, so a repeat call can say it changed nothing.
    let was_retired = state
        .catalog
        .is_theme_retired(&theme_revision_id)
        .map_err(hcd_error)?;
    state
        .catalog
        .retire_theme(&theme_revision_id)
        .map_err(hcd_error)?;
    record_catalog_audit(
        &state.catalog,
        &claims,
        audit_action::THEME_RETIRE,
        &theme_revision_id,
        format!(
            "退役主题「{}」（{}）；已钉住它的文档仍可正常解析，新钉版会被拒绝{}",
            name,
            short_digest(&theme_revision_id),
            if was_retired {
                "；此前已是退役状态，本次没有改变"
            } else {
                ""
            }
        ),
    )?;
    Ok(Json(json!({
        "themeRevisionId": theme_revision_id,
        "retired": true,
    })))
}

async fn catalog_unretire_theme(
    State(state): State<ServerState>,
    Path(theme_revision_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_admin(&state, &headers)?;
    if !valid_digest_hex(&theme_revision_id) {
        return Err(bad("themeRevisionId must be a lowercase SHA-256 digest"));
    }
    let was_retired = state
        .catalog
        .is_theme_retired(&theme_revision_id)
        .map_err(hcd_error)?;
    state
        .catalog
        .unretire_theme(&theme_revision_id)
        .map_err(hcd_error)?;
    // The theme may already be deleted, so the name is best effort: the record
    // must still be written for a state change nobody can name any more.
    let name = state.catalog.get_theme(&theme_revision_id).ok();
    record_catalog_audit(
        &state.catalog,
        &claims,
        audit_action::THEME_UNRETIRE,
        &theme_revision_id,
        format!(
            "取消退役{}（{}）；该主题可以重新被钉到文档上{}",
            match &name {
                Some(theme) => format!("主题「{}」", theme.name),
                None => "一个目录里已经没有记录的主题".to_string(),
            },
            short_digest(&theme_revision_id),
            if was_retired {
                ""
            } else {
                "；此前并没有退役，本次没有改变"
            }
        ),
    )?;
    Ok(Json(json!({
        "themeRevisionId": theme_revision_id,
        "retired": false,
    })))
}

/// Content side of the catalog: every bundle in this service's document root,
/// with the theme its head pins. A document read token only covers one document
/// (`claims.doc` must equal the id), so an operator with the admin token has no
/// way to see what the catalog changes actually reached without this listing.
async fn catalog_documents(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<Vec<DocumentSummary>>, ApiError> {
    authorize_admin(&state, &headers)?;
    Ok(Json(list_documents(&state.root).map_err(hcd_error)?))
}

/// Which documents pin this theme. The scan covers this service's own document
/// root only — head pins and revision history both count — so an empty answer
/// means "unreachable from the documents stored here", not "unused everywhere".
async fn catalog_theme_documents(
    State(state): State<ServerState>,
    Path(theme_revision_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<ThemeDocumentRef>>, ApiError> {
    authorize_admin(&state, &headers)?;
    if !valid_digest_hex(&theme_revision_id) {
        return Err(bad("themeRevisionId must be a lowercase SHA-256 digest"));
    }
    Ok(Json(
        theme_documents(&state.root, &theme_revision_id).map_err(hcd_error)?,
    ))
}

/// Drop a theme revision outright. Retirement only stops new pins; this is the
/// step that removes the theme, and it is refused with 422 while any document
/// here still reaches it, naming those documents.
async fn catalog_delete_theme(
    State(state): State<ServerState>,
    Path(theme_revision_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_admin(&state, &headers)?;
    if !valid_digest_hex(&theme_revision_id) {
        return Err(bad("themeRevisionId must be a lowercase SHA-256 digest"));
    }
    // Read the name first: after the delete there is nothing left to ask.
    let name = state
        .catalog
        .get_theme(&theme_revision_id)
        .map_err(hcd_error)?
        .name;
    state
        .catalog
        .delete_theme(&theme_revision_id, &state.root)
        .map_err(hcd_error)?;
    record_catalog_audit(
        &state.catalog,
        &claims,
        audit_action::THEME_DELETE,
        &theme_revision_id,
        format!(
            "彻底删除主题「{}」（{}）；删除前本服务的文档目录里没有文档钉住它，它引用的字体与字库保持不变",
            name,
            short_digest(&theme_revision_id)
        ),
    )?;
    Ok(Json(json!({
        "themeRevisionId": theme_revision_id,
        "deleted": true,
    })))
}

#[derive(Deserialize)]
struct AuditQuery {
    limit: Option<usize>,
    /// Inclusive first UTC day, `YYYY-MM-DD`.
    from: Option<String>,
    /// Inclusive last UTC day, `YYYY-MM-DD`.
    to: Option<String>,
}

/// The catalog operation log: who uploaded or deleted a font, who retired or
/// deleted a theme, who pinned or unpinned a document. Newest first.
///
/// The log only ever records what this service did through these routes; it is
/// admin-only because it names documents and operators.
///
/// `from` and `to` are inclusive UTC days, so `?from=&to=` answers "what
/// happened last week" without paging by hand. An empty bound is an open one —
/// a query string the browser left half-filled — but a bound that does not name
/// a real day is refused with 400 rather than treated as open: `from=2026-02-30`
/// matches no day file, and answering "nothing happened" to that would be a
/// false statement about the past. The same goes for `from` after `to`.
async fn catalog_audit(
    State(state): State<ServerState>,
    Query(query): Query<AuditQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers)?;
    let limit = query.limit.unwrap_or(100).clamp(1, MAX_AUDIT_LIMIT);
    let from = query.from.filter(|value| !value.trim().is_empty());
    let to = query.to.filter(|value| !value.trim().is_empty());
    for (name, bound) in [("from", &from), ("to", &to)] {
        if let Some(day) = bound {
            if !hcd_core::is_audit_calendar_day(day) {
                return Err(bad(format!(
                    "audit {name} must name a real UTC day as YYYY-MM-DD, got {day}"
                )));
            }
        }
    }
    if let (Some(first), Some(last)) = (&from, &to) {
        if first > last {
            return Err(bad(format!(
                "audit window from {first} is after to {last}"
            )));
        }
    }
    let page = state
        .catalog
        .audit_entries_in(
            hcd_core::AuditWindow {
                from: from.as_deref(),
                to: to.as_deref(),
            },
            limit,
        )
        .map_err(hcd_error)?;
    Ok(Json(json!({
        "entries": page.entries,
        "unreadable": page.unreadable,
        // Older lines inside the window that this page did not return, as
        // opposed to `unreadable`: those exist, they were just not read.
        "truncated": page.truncated,
        "limit": limit,
        "from": from,
        "to": to,
    })))
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
    if format == "hcd" && revision != head.revision {
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
    let mime = match format.as_str() {
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pdf" => "application/pdf",
        "hcd" => "application/zip",
        "html" => "text/html; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        _ => "text/plain; charset=utf-8",
    };
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
        if tokio::fs::metadata(&output).await.map_err(internal)?.len() > 256 * 1024 * 1024 {
            return Err(bad("HCD archive exceeds 256 MiB HTTP limit"));
        }
        tokio::fs::read(output).await.map_err(internal)?
    } else if format == "html" {
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
        let theme_stylesheet =
            hcd_core::theme_presentation_css(&state.catalog, &bundle, Some(requested))
                .map_err(hcd_error)?;
        let options = hcd_core::HtmlPresentationOptions {
            revision: Some(requested),
            max_output_bytes: 256 * 1024 * 1024,
            theme_stylesheet,
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

#[cfg(test)]
mod tests {
    use super::*;
    use hcd_core::FontRef;

    const TTF: &[u8] = b"\x00\x01\x00\x00glyh font";

    fn test_state(secret: &[u8], root: &std::path::Path) -> ServerState {
        ServerState {
            root: root.to_path_buf(),
            catalog: DiskCatalog::open(root.join("catalog")).unwrap(),
            secret: Arc::new(secret.to_vec()),
            remote: None,
            default_theme: None,
            collaboration_lock: Arc::new(Mutex::new(())),
            downloads: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn bearer(secret: &[u8], doc: &str, scope: &str) -> HeaderMap {
        bearer_as(secret, doc, scope, None, None)
    }

    /// The same token with the identity a real one carries (`--user-id`,
    /// `--display-name`), which is what makes the audit actor worth reading.
    fn bearer_as(
        secret: &[u8],
        doc: &str,
        scope: &str,
        sub: Option<&str>,
        name: Option<&str>,
    ) -> HeaderMap {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize;
        let jwt = encode(
            &Header::new(Algorithm::HS256),
            &Claims {
                doc: doc.to_string(),
                scope: scope.to_string(),
                sub: sub.map(str::to_string),
                name: name.map(str::to_string),
                aud: "hcd-core".to_string(),
                iat: now,
                exp: now + 600,
            },
            &EncodingKey::from_secret(secret),
        )
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {jwt}").parse().unwrap(),
        );
        headers
    }

    fn face(sha256: &str) -> UploadedFace {
        UploadedFace {
            subfamily: "Regular".to_string(),
            weight: 400,
            style: FontStyle::Normal,
            stretch: FontStretch::Normal,
            scripts: vec![FontScript::Latin, FontScript::Hans],
            format: FontFileFormat::Ttf,
            sha256: sha256.to_string(),
            byte_length: TTF.len() as u64,
        }
    }

    fn license() -> FontLicense {
        FontLicense {
            name: "OFL-1.1".to_string(),
            web_preview: true,
            ooxml_embed: true,
            pdf_embed: false,
            redistribution: false,
            expires_at_epoch_ms: None,
        }
    }

    #[tokio::test]
    async fn catalog_routes_require_an_admin_token() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let error = catalog_fonts(State(state.clone()), HeaderMap::new())
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::UNAUTHORIZED);
        for (doc, scope) in [
            ("doc-a", "read"),
            ("doc-a", "write"),
            ("*", "upload"),
            ("*", "write"),
        ] {
            let headers = bearer(secret, doc, scope);
            let error = catalog_fonts(State(state.clone()), headers.clone())
                .await
                .unwrap_err();
            assert_eq!(error.0, StatusCode::FORBIDDEN, "{doc}/{scope} leaked");
            let error = catalog_put_theme(
                State(state.clone()),
                headers.clone(),
                Json(NewThemeBody {
                    name: "x".to_string(),
                    major: ThemeFontSlots::default(),
                    minor: ThemeFontSlots::default(),
                    fallback_families: vec![],
                }),
            )
            .await
            .unwrap_err();
            assert_eq!(error.0, StatusCode::FORBIDDEN, "{doc}/{scope} wrote");
        }
        assert!(catalog_fonts(State(state), bearer(secret, "*", "admin"))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn admin_uploads_font_then_saves_and_lists_a_theme() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let admin = bearer(secret, "*", "admin");

        let error = catalog_put_blob(
            State(state.clone()),
            Path("demo-serif".to_string()),
            Query(BlobQuery {
                format: "woff2".to_string(),
            }),
            admin.clone(),
            Bytes::from_static(TTF),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert!(error.1.contains("magic"));

        let error = catalog_put_blob(
            State(state.clone()),
            Path("Demo-Serif".to_string()),
            Query(BlobQuery {
                format: "ttf".to_string(),
            }),
            admin.clone(),
            Bytes::from_static(TTF),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);

        let uploaded = catalog_put_blob(
            State(state.clone()),
            Path("demo-serif".to_string()),
            Query(BlobQuery {
                format: "ttf".to_string(),
            }),
            admin.clone(),
            Bytes::from_static(TTF),
        )
        .await
        .unwrap();
        let sha256 = uploaded.0["sha256"].as_str().unwrap().to_string();
        assert_eq!(sha256.len(), 64);

        let revision = catalog_put_font_revision(
            State(state.clone()),
            Path("demo-serif".to_string()),
            admin.clone(),
            Json(NewFontRevisionBody {
                family: "Demo Serif".to_string(),
                faces: vec![face(&sha256)],
                license: license(),
            }),
        )
        .await
        .unwrap();
        let font_revision_id = revision.0.font_revision_id.clone();
        assert_eq!(font_revision_id.len(), 64);
        assert_eq!(revision.0.faces[0].family, "Demo Serif");

        let theme = catalog_put_theme(
            State(state.clone()),
            admin.clone(),
            Json(NewThemeBody {
                name: "Brand default".to_string(),
                major: ThemeFontSlots {
                    latin: Some(FontRef {
                        font_id: "demo-serif".to_string(),
                        font_revision_id: font_revision_id.clone(),
                    }),
                    east_asia: None,
                    bidi: None,
                },
                minor: ThemeFontSlots {
                    latin: None,
                    east_asia: None,
                    bidi: None,
                },
                fallback_families: vec!["serif".to_string()],
            }),
        )
        .await
        .unwrap();
        let theme_revision_id = theme.0.theme_revision_id.clone();

        let fonts = catalog_fonts(State(state.clone()), admin.clone())
            .await
            .unwrap();
        assert_eq!(fonts.0.len(), 1);
        assert_eq!(fonts.0[0].font_id, "demo-serif");
        assert_eq!(fonts.0[0].family, "Demo Serif");

        let one = catalog_font(
            State(state.clone()),
            Path("demo-serif".to_string()),
            admin.clone(),
        )
        .await
        .unwrap();
        assert_eq!(one.0[0].font_revision_id, font_revision_id);
        assert!(!one.0[0].license.pdf_embed);

        let themes = catalog_themes(State(state), admin).await.unwrap();
        assert_eq!(themes.0.len(), 1);
        assert_eq!(themes.0[0].theme_revision_id, theme_revision_id);
    }

    #[tokio::test]
    async fn catalog_delete_refuses_referenced_fonts_and_removes_loose_ones() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let admin = bearer(secret, "*", "admin");

        let uploaded = catalog_put_blob(
            State(state.clone()),
            Path("demo-serif".to_string()),
            Query(BlobQuery {
                format: "ttf".to_string(),
            }),
            admin.clone(),
            Bytes::from_static(TTF),
        )
        .await
        .unwrap();
        let sha256 = uploaded.0["sha256"].as_str().unwrap().to_string();
        let demo_rev = catalog_put_font_revision(
            State(state.clone()),
            Path("demo-serif".to_string()),
            admin.clone(),
            Json(NewFontRevisionBody {
                family: "Demo Serif".to_string(),
                faces: vec![face(&sha256)],
                license: license(),
            }),
        )
        .await
        .unwrap()
        .0
        .font_revision_id;

        // A theme pins the demo-serif revision, so it is not removable.
        let _ = catalog_put_theme(
            State(state.clone()),
            admin.clone(),
            Json(NewThemeBody {
                name: "Brand default".to_string(),
                major: ThemeFontSlots {
                    latin: Some(FontRef {
                        font_id: "demo-serif".to_string(),
                        font_revision_id: demo_rev.clone(),
                    }),
                    east_asia: None,
                    bidi: None,
                },
                minor: ThemeFontSlots {
                    latin: None,
                    east_asia: None,
                    bidi: None,
                },
                fallback_families: vec!["serif".to_string()],
            }),
        )
        .await
        .unwrap();

        let error = catalog_delete_font_revision(
            State(state.clone()),
            Path(("demo-serif".to_string(), demo_rev.clone())),
            admin.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::UNPROCESSABLE_ENTITY);
        let error = catalog_delete_font(
            State(state.clone()),
            Path("demo-serif".to_string()),
            admin.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(catalog_font(
            State(state.clone()),
            Path("demo-serif".to_string()),
            admin.clone(),
        )
        .await
        .unwrap()
        .0
        .iter()
        .any(|revision| revision.font_revision_id == demo_rev));

        // A loose font that shares the same blob can be deleted.
        let _ = catalog_put_blob(
            State(state.clone()),
            Path("loose-font".to_string()),
            Query(BlobQuery {
                format: "ttf".to_string(),
            }),
            admin.clone(),
            Bytes::from_static(TTF),
        )
        .await
        .unwrap();
        let loose_rev = catalog_put_font_revision(
            State(state.clone()),
            Path("loose-font".to_string()),
            admin.clone(),
            Json(NewFontRevisionBody {
                family: "Loose Font".to_string(),
                faces: vec![face(&sha256)],
                license: license(),
            }),
        )
        .await
        .unwrap()
        .0
        .font_revision_id;

        let report = catalog_delete_font_revision(
            State(state.clone()),
            Path(("loose-font".to_string(), loose_rev.clone())),
            admin.clone(),
        )
        .await
        .unwrap();
        assert_eq!(report.0.removed_revisions, vec![loose_rev]);
        // The blob is still cited by demo-serif, so GC keeps it.
        assert!(report.0.removed_blobs.is_empty());
        let fonts = catalog_fonts(State(state.clone()), admin.clone())
            .await
            .unwrap();
        assert_eq!(fonts.0.len(), 1);
        assert_eq!(fonts.0[0].font_id, "demo-serif");

        // Malformed revision id is rejected before lookup.
        let error = catalog_delete_font_revision(
            State(state.clone()),
            Path(("demo-serif".to_string(), "nope".to_string())),
            admin.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        // A well-formed but unknown revision id is a 404.
        let error = catalog_delete_font_revision(
            State(state.clone()),
            Path(("demo-serif".to_string(), "cd".repeat(32))),
            admin.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::NOT_FOUND);

        // A non-admin token cannot delete.
        let reader = bearer(secret, "doc", "read");
        let error = catalog_delete_font(State(state), Path("demo-serif".to_string()), reader)
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn catalog_retire_lists_and_lifts_theme_retirement() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let admin = bearer(secret, "*", "admin");

        let uploaded = catalog_put_blob(
            State(state.clone()),
            Path("demo-serif".to_string()),
            Query(BlobQuery {
                format: "ttf".to_string(),
            }),
            admin.clone(),
            Bytes::from_static(TTF),
        )
        .await
        .unwrap();
        let sha256 = uploaded.0["sha256"].as_str().unwrap().to_string();
        let revision = catalog_put_font_revision(
            State(state.clone()),
            Path("demo-serif".to_string()),
            admin.clone(),
            Json(NewFontRevisionBody {
                family: "Demo Serif".to_string(),
                faces: vec![face(&sha256)],
                license: license(),
            }),
        )
        .await
        .unwrap()
        .0
        .font_revision_id;
        let theme_id = catalog_put_theme(
            State(state.clone()),
            admin.clone(),
            Json(NewThemeBody {
                name: "Brand default".to_string(),
                major: ThemeFontSlots {
                    latin: Some(FontRef {
                        font_id: "demo-serif".to_string(),
                        font_revision_id: revision,
                    }),
                    east_asia: None,
                    bidi: None,
                },
                minor: ThemeFontSlots {
                    latin: None,
                    east_asia: None,
                    bidi: None,
                },
                fallback_families: vec!["serif".to_string()],
            }),
        )
        .await
        .unwrap()
        .0
        .theme_revision_id;

        assert!(catalog_retired_themes(State(state.clone()), admin.clone())
            .await
            .unwrap()
            .0
            .is_empty());

        let retired =
            catalog_retire_theme(State(state.clone()), Path(theme_id.clone()), admin.clone())
                .await
                .unwrap();
        assert_eq!(retired.0["retired"], serde_json::json!(true));
        assert_eq!(
            catalog_retired_themes(State(state.clone()), admin.clone())
                .await
                .unwrap()
                .0,
            vec![theme_id.clone()]
        );

        // Re-retiring is idempotent; un-retiring clears it.
        let _ = catalog_retire_theme(State(state.clone()), Path(theme_id.clone()), admin.clone())
            .await
            .unwrap();
        let cleared =
            catalog_unretire_theme(State(state.clone()), Path(theme_id.clone()), admin.clone())
                .await
                .unwrap();
        assert_eq!(cleared.0["retired"], serde_json::json!(false));
        assert!(catalog_retired_themes(State(state.clone()), admin.clone())
            .await
            .unwrap()
            .0
            .is_empty());
        // Un-retiring a live theme is a harmless no-op.
        let _ = catalog_unretire_theme(State(state), Path(theme_id), admin)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn catalog_retire_validates_id_and_requires_admin() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let admin = bearer(secret, "*", "admin");

        let error = catalog_retire_theme(
            State(state.clone()),
            Path("nope".to_string()),
            admin.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);

        let error =
            catalog_retire_theme(State(state.clone()), Path("ab".repeat(32)), admin.clone())
                .await
                .unwrap_err();
        assert_eq!(error.0, StatusCode::NOT_FOUND);

        let reader = bearer(secret, "doc", "read");
        let error = catalog_retire_theme(State(state), Path("ab".repeat(32)), reader)
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn catalog_write_rejects_missing_blobs_and_unknown_fonts() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let admin = bearer(secret, "*", "admin");

        let error = catalog_put_font_revision(
            State(state.clone()),
            Path("demo-serif".to_string()),
            admin.clone(),
            Json(NewFontRevisionBody {
                family: "Demo Serif".to_string(),
                faces: vec![face(&"ab".repeat(32))],
                license: license(),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::NOT_FOUND);

        let error = catalog_put_theme(
            State(state.clone()),
            admin.clone(),
            Json(NewThemeBody {
                name: "Brand default".to_string(),
                major: ThemeFontSlots {
                    latin: Some(FontRef {
                        font_id: "demo-serif".to_string(),
                        font_revision_id: "cd".repeat(32),
                    }),
                    east_asia: None,
                    bidi: None,
                },
                minor: ThemeFontSlots {
                    latin: None,
                    east_asia: None,
                    bidi: None,
                },
                fallback_families: vec![],
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::NOT_FOUND);

        let error = catalog_font(
            State(state.clone()),
            Path("missing-font".to_string()),
            admin.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::NOT_FOUND);

        let error = catalog_font(State(state), Path("Bad Id".to_string()), admin)
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn theme_read_routes_accept_document_and_admin_tokens_only() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let unknown = || Path("ab".repeat(32));
        let error = theme_revision(
            State(state.clone()),
            unknown(),
            bearer(secret, "*", "upload"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::FORBIDDEN);
        let error = theme_revision(
            State(state.clone()),
            unknown(),
            bearer(secret, "*", "admin"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::NOT_FOUND);
        let error = theme_revision(State(state), unknown(), bearer(secret, "doc-a", "read"))
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn admin_console_is_served_same_origin() {
        let response = catalog_admin().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/html; charset=utf-8"
        );
        let body = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        let html = String::from_utf8(body.to_vec()).unwrap();
        assert!(html.contains("/v1/catalog/fonts"));
        assert!(html.contains("/v1/catalog/themes"));
        assert!(html.contains("--scope admin"));
        // The shipped page is the built React console, so these prove the
        // checked-in bundle — not a stale hand-written page — is embedded: the
        // admin-only document list it calls, and the sidebar labels that keep
        // catalogue management and document content in separate views.
        assert!(html.contains("<div id=\"root\">"));
        assert!(html.contains("/v1/documents"));
        assert!(html.contains("目录管理"));
        assert!(html.contains("上传登记"));
        // The operation log view is part of the same shipped bundle: it calls the
        // admin-only audit route and labels the sidebar group it lives under.
        assert!(html.contains("/v1/catalog/audit"));
        assert!(html.contains("操作记录"));
        assert!(html.contains("留痕"));
        // The window picker and the export are the reason the route grew `from`
        // and `to`, so the shipped bundle has to carry both halves.
        assert!(html.contains("导出 CSV"));
        assert!(html.contains("hcd-audit-"));
        assert!(html.contains("区间里还有更早的记录没列出"));
    }

    #[tokio::test]
    async fn pin_theme_route_records_a_content_revision() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let admin = bearer(secret, "*", "admin");

        // Seed a theme through the same admin write surface the console uses.
        let uploaded = catalog_put_blob(
            State(state.clone()),
            Path("demo-serif".to_string()),
            Query(BlobQuery {
                format: "ttf".to_string(),
            }),
            admin.clone(),
            Bytes::from_static(TTF),
        )
        .await
        .unwrap();
        let sha256 = uploaded.0["sha256"].as_str().unwrap().to_string();
        let revision = catalog_put_font_revision(
            State(state.clone()),
            Path("demo-serif".to_string()),
            admin.clone(),
            Json(NewFontRevisionBody {
                family: "Demo Serif".to_string(),
                faces: vec![face(&sha256)],
                license: license(),
            }),
        )
        .await
        .unwrap();
        let theme = catalog_put_theme(
            State(state.clone()),
            admin,
            Json(NewThemeBody {
                name: "Brand default".to_string(),
                major: ThemeFontSlots {
                    latin: Some(FontRef {
                        font_id: "demo-serif".to_string(),
                        font_revision_id: revision.0.font_revision_id.clone(),
                    }),
                    east_asia: None,
                    bidi: None,
                },
                minor: ThemeFontSlots::default(),
                fallback_families: vec!["serif".to_string()],
            }),
        )
        .await
        .unwrap();
        let theme_revision_id = theme.0.theme_revision_id.clone();

        // Create a document bundle the server can open by id.
        let id = "doc-a";
        let writer = hcd_core::BundleWriter::create(temp.path().join(format!("{id}.hcd"))).unwrap();
        writer.write_styles("article { color: #123456; }").unwrap();
        writer
            .finish(hcd_core::HcdManifest {
                schema_version: String::new(),
                storage_codec: hcd_core::StorageCodec::None,
                document_id: id.to_string(),
                profile: "semantic-flow".to_string(),
                revision: 0,
                source: hcd_core::SourceDescriptor {
                    format: "docx".to_string(),
                    sha256: "ab".repeat(32),
                    size_bytes: 1,
                },
                root_hash: String::new(),
                annotation_root_hash: String::new(),
                annotation_href: None,
                index_prefix: String::new(),
                index_root_href: None,
                index_page_count: 0,
                chunk_count: 0,
                styles_href: String::new(),
                theme_revision_id: None,
                capabilities: hcd_core::HcdCapabilities::default(),
                fidelity: None,
                state: "IMPORTING".to_string(),
                warnings: Vec::new(),
            })
            .unwrap();

        // A body has to say what it means: an absent field is refused rather than
        // read as an unpin, so a typo cannot strip a document's theme.
        assert!(serde_json::from_str::<PinThemeBody>("{}").is_err());
        assert!(
            serde_json::from_str::<PinThemeBody>("{\"themeRevisionId\":null}")
                .unwrap()
                .theme_revision_id
                .is_none()
        );

        // A read token cannot pin.
        let error = pin_theme(
            State(state.clone()),
            Path(id.to_string()),
            bearer(secret, id, "read"),
            Json(PinThemeBody {
                theme_revision_id: Some(theme_revision_id.clone()),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::FORBIDDEN);

        // A write token pins the theme and advances the head revision.
        let resolution = pin_theme(
            State(state.clone()),
            Path(id.to_string()),
            bearer(secret, id, "write"),
            Json(PinThemeBody {
                theme_revision_id: Some(theme_revision_id.clone()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(resolution.0.revision, 1);
        assert_eq!(resolution.0.theme_revision_id, theme_revision_id);

        let bundle = open(&state, id).unwrap();
        let manifest = bundle.manifest().unwrap();
        assert_eq!(manifest.revision, 1);
        assert!(manifest.styles_href.starts_with("styles/rev-"));
        let served = bundle.read_styles_part(&manifest.styles_href).unwrap();
        assert!(served.contains("article { color: #123456; }"));
        assert!(served.contains("--hcd-major-latin:'Demo Serif',serif"));

        // Re-pinning the same theme is idempotent and does not add a revision.
        let again = pin_theme(
            State(state.clone()),
            Path(id.to_string()),
            bearer(secret, id, "write"),
            Json(PinThemeBody {
                theme_revision_id: Some(theme_revision_id.clone()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(again.0.revision, 1);

        // The console's operator token may retarget a document's theme, because a
        // pin commits managed stylesheet lines and no node content.
        let retarget = pin_theme(
            State(state.clone()),
            Path(id.to_string()),
            bearer(secret, "*", "admin"),
            Json(PinThemeBody {
                theme_revision_id: Some(theme_revision_id.clone()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(retarget.0.revision, 1, "the same theme is still a no-op");

        // A read token cannot unpin either, and the admin token can.
        let error = pin_theme(
            State(state.clone()),
            Path(id.to_string()),
            bearer(secret, id, "read"),
            Json(PinThemeBody {
                theme_revision_id: None,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::FORBIDDEN);
        let cleared = pin_theme(
            State(state.clone()),
            Path(id.to_string()),
            bearer(secret, "*", "admin"),
            Json(PinThemeBody {
                theme_revision_id: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(cleared.0.revision, 2);
        assert!(
            cleared.0.theme_revision_id.is_empty(),
            "an unpin reports no theme"
        );
        assert!(cleared.0.theme.css.is_empty());
        let styles = bundle
            .read_styles_part(&bundle.manifest().unwrap().styles_href)
            .unwrap();
        assert_eq!(styles.trim(), "article { color: #123456; }");
        assert!(!styles.contains("hcd-theme-begin"));

        // Content routes still demand a token written for this document: the admin
        // token that retargets the theme cannot splice text.
        let error = node_patch(
            State(state),
            Path(id.to_string()),
            bearer(secret, "*", "admin"),
            Json(hcd_core::PatchBatch {
                schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_37.to_string(),
                document_id: id.to_string(),
                patch_id: "admin-must-not-edit".to_string(),
                base_revision: 2,
                actor: Default::default(),
                metadata: Default::default(),
                operations: vec![hcd_core::PatchOperation::TextSplice {
                    node_id: "n_00000000000000000000000000000001".to_string(),
                    start: 0,
                    delete_count: 0,
                    insert_text: "x".to_string(),
                    precondition: hcd_core::NodePrecondition {
                        node_hash: "0".repeat(64),
                    },
                }],
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::FORBIDDEN);
    }

    /// Seed a font revision and a theme through the same admin write surface the console uses.
    async fn seed_theme(state: &ServerState, secret: &[u8], font_id: &str) -> String {
        let admin = bearer(secret, "*", "admin");
        let uploaded = catalog_put_blob(
            State(state.clone()),
            Path(font_id.to_string()),
            Query(BlobQuery {
                format: "ttf".to_string(),
            }),
            admin.clone(),
            Bytes::from_static(TTF),
        )
        .await
        .unwrap();
        let sha256 = uploaded.0["sha256"].as_str().unwrap().to_string();
        let revision = catalog_put_font_revision(
            State(state.clone()),
            Path(font_id.to_string()),
            admin.clone(),
            Json(NewFontRevisionBody {
                family: "Demo Serif".to_string(),
                faces: vec![face(&sha256)],
                license: license(),
            }),
        )
        .await
        .unwrap();
        let theme = catalog_put_theme(
            State(state.clone()),
            admin,
            Json(NewThemeBody {
                name: "Brand default".to_string(),
                major: ThemeFontSlots {
                    latin: Some(FontRef {
                        font_id: font_id.to_string(),
                        font_revision_id: revision.0.font_revision_id.clone(),
                    }),
                    east_asia: None,
                    bidi: None,
                },
                minor: ThemeFontSlots::default(),
                fallback_families: vec!["serif".to_string()],
            }),
        )
        .await
        .unwrap();
        theme.0.theme_revision_id
    }

    /// Write a bundle the way a finished import leaves it: revision zero, its own pin or none.
    fn imported_bundle(path: &std::path::Path, id: &str, theme_revision_id: Option<String>) {
        let writer = hcd_core::BundleWriter::create(path).unwrap();
        writer.write_styles("article { color: #222222; }").unwrap();
        writer
            .finish(hcd_core::HcdManifest {
                schema_version: String::new(),
                storage_codec: hcd_core::StorageCodec::None,
                document_id: id.to_string(),
                profile: "semantic-flow".to_string(),
                revision: 0,
                source: hcd_core::SourceDescriptor {
                    format: "docx".to_string(),
                    sha256: "ab".repeat(32),
                    size_bytes: 1,
                },
                root_hash: String::new(),
                annotation_root_hash: String::new(),
                annotation_href: None,
                index_prefix: String::new(),
                index_root_href: None,
                index_page_count: 0,
                chunk_count: 0,
                styles_href: String::new(),
                theme_revision_id,
                capabilities: hcd_core::HcdCapabilities::default(),
                fidelity: None,
                state: "IMPORTING".to_string(),
                warnings: Vec::new(),
            })
            .unwrap();
    }

    #[test]
    fn configured_default_theme_requires_a_theme_revision_digest() {
        assert_eq!(configured_default_theme(None).unwrap(), None);
        let id = "a".repeat(64);
        assert_eq!(
            configured_default_theme(Some(id.clone())).unwrap(),
            Some(id.clone())
        );
        for rejected in ["", "abc", &"A".repeat(64), &"g".repeat(64), &"a".repeat(63)] {
            assert!(
                configured_default_theme(Some(rejected.to_string())).is_err(),
                "accepted {rejected}"
            );
        }
    }

    #[tokio::test]
    async fn default_theme_pins_a_freshly_imported_document() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let mut state = test_state(secret, temp.path());
        let theme = seed_theme(&state, secret, "demo-serif").await;
        state.default_theme = Some(theme.clone());
        let destination = temp.path().join("doc-new.hcd");
        imported_bundle(&destination, "doc-new", None);

        assert_eq!(
            pin_default_theme(
                &state.catalog,
                state.default_theme.as_deref(),
                &destination,
                "upload:test"
            ),
            None
        );

        let bundle = Bundle::open(&destination).unwrap();
        let manifest = bundle.manifest().unwrap();
        assert_eq!(manifest.revision, 1);
        assert_eq!(manifest.theme_revision_id.as_deref(), Some(theme.as_str()));
        assert!(manifest.styles_href.starts_with("styles/rev-"));
        let styles = bundle.read_styles_part(&manifest.styles_href).unwrap();
        assert!(styles.contains("article { color: #222222; }"));
        assert!(styles.contains("--hcd-major-latin:'Demo Serif',serif"));
    }

    #[tokio::test]
    async fn without_a_configured_default_theme_imports_stay_unpinned() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let theme = seed_theme(&state, secret, "demo-serif").await;
        let destination = temp.path().join("doc-none.hcd");
        imported_bundle(&destination, "doc-none", None);

        assert_eq!(
            pin_default_theme(
                &state.catalog,
                state.default_theme.as_deref(),
                &destination,
                "upload:test"
            ),
            None
        );

        let manifest = Bundle::open(&destination).unwrap().manifest().unwrap();
        assert_eq!(manifest.revision, 0);
        assert_eq!(manifest.theme_revision_id, None);
        // The catalog does hold a usable theme; only the missing config kept the document plain.
        let themes = state.catalog.list_themes().unwrap();
        assert_eq!(themes.len(), 1);
        assert_eq!(themes[0].theme_revision_id, theme);
    }

    #[tokio::test]
    async fn a_reimported_archive_keeps_its_own_theme_pin() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let mut state = test_state(secret, temp.path());
        let default = seed_theme(&state, secret, "demo-serif").await;
        state.default_theme = Some(default.clone());
        let own = "cd".repeat(32);
        let destination = temp.path().join("doc-brand.hcd");
        imported_bundle(&destination, "doc-brand", Some(own.clone()));

        assert_eq!(
            pin_default_theme(
                &state.catalog,
                state.default_theme.as_deref(),
                &destination,
                "upload:test"
            ),
            None
        );

        let manifest = Bundle::open(&destination).unwrap().manifest().unwrap();
        assert_eq!(manifest.revision, 0);
        assert_eq!(manifest.theme_revision_id.as_deref(), Some(own.as_str()));
        assert_ne!(default, own);
    }

    #[tokio::test]
    async fn a_stale_or_retired_default_theme_warns_instead_of_failing_the_import() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let theme = seed_theme(&state, secret, "demo-serif").await;

        let unknown = "f".repeat(64);
        let stale = temp.path().join("doc-stale.hcd");
        imported_bundle(&stale, "doc-stale", None);
        let warning =
            pin_default_theme(&state.catalog, Some(&unknown), &stale, "upload:test").unwrap();
        assert!(warning.contains("was not pinned"), "{warning}");
        let manifest = Bundle::open(&stale).unwrap().manifest().unwrap();
        assert_eq!(manifest.revision, 0);
        assert_eq!(manifest.theme_revision_id, None);

        state.catalog.retire_theme(&theme).unwrap();
        let retired = temp.path().join("doc-retired.hcd");
        imported_bundle(&retired, "doc-retired", None);
        let warning =
            pin_default_theme(&state.catalog, Some(&theme), &retired, "upload:test").unwrap();
        assert!(warning.contains("retired"), "{warning}");
        assert_eq!(
            Bundle::open(&retired)
                .unwrap()
                .manifest()
                .unwrap()
                .theme_revision_id,
            None
        );

        let warning = pin_default_theme(
            &state.catalog,
            Some(&theme),
            &temp.path().join("gone.hcd"),
            "upload:test",
        )
        .unwrap();
        assert!(warning.contains("was not pinned"), "{warning}");
    }

    #[tokio::test]
    async fn importing_a_document_that_already_exists_does_not_repin_it() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let mut state = test_state(secret, temp.path());
        let default = seed_theme(&state, secret, "demo-serif").await;
        state.default_theme = Some(default.clone());

        let body: &[u8] = b"brand new text";
        let hash = hcd_core::hash_bytes(body);
        let id = format!("doc-{}", &hash[..32]);
        let own = "cd".repeat(32);
        let destination = state.root.join(format!("{id}.hcd"));
        imported_bundle(&destination, &id, Some(own.clone()));

        let response = import_document(
            State(state.clone()),
            Query(ImportQuery {
                filename: "note.txt".to_string(),
            }),
            bearer(secret, "*", "upload"),
            Body::from(body.to_vec()),
        )
        .await
        .unwrap();
        assert_eq!(response.0["state"], "completed");
        assert!(response.0.get("warnings").is_none(), "{}", response.0);

        let manifest = Bundle::open(&destination).unwrap().manifest().unwrap();
        assert_eq!(manifest.revision, 0);
        assert_eq!(manifest.theme_revision_id.as_deref(), Some(own.as_str()));
    }

    #[tokio::test]
    async fn catalog_documents_lists_the_root_with_its_head_pins() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let admin = bearer(secret, "*", "admin");
        let theme = seed_theme(&state, secret, "demo-serif").await;

        imported_bundle(
            &temp.path().join("doc-own.hcd"),
            "doc-own",
            Some(theme.clone()),
        );
        imported_bundle(&temp.path().join("doc-plain.hcd"), "doc-plain", None);

        let listed = catalog_documents(State(state.clone()), admin.clone())
            .await
            .unwrap()
            .0;
        let ids: Vec<&str> = listed
            .iter()
            .map(|document| document.document_id.as_str())
            .collect();
        // The catalog directory shares this root and is not a document.
        assert_eq!(ids, vec!["doc-own", "doc-plain"]);
        assert_eq!(listed[0].theme_revision_id.as_deref(), Some(theme.as_str()));
        assert_eq!(listed[1].theme_revision_id, None);

        let body = serde_json::to_value(&listed).unwrap();
        assert_eq!(body[0]["documentId"], "doc-own");
        assert_eq!(body[0]["profile"], "semantic-flow");
        assert_eq!(body[0]["format"], "docx");
        assert_eq!(body[0]["revision"], 0);
        // `BundleWriter::finish` normalizes the state it wrote, so the console
        // sees a finished bundle, not the `IMPORTING` stub the helper passed in.
        assert_eq!(body[0]["state"], "COMPLETE");
        assert_eq!(body[0]["themeRevisionId"], theme.clone());
        assert!(
            body[1].get("themeRevisionId").is_none(),
            "an unpinned document omits the key instead of sending null"
        );
    }

    #[tokio::test]
    async fn catalog_documents_needs_admin_and_refuses_a_broken_bundle() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let admin = bearer(secret, "*", "admin");
        let theme = seed_theme(&state, secret, "demo-serif").await;
        imported_bundle(&temp.path().join("doc-own.hcd"), "doc-own", Some(theme));

        // A document token — even one scoped to the very document listed here —
        // is not a catalog administrator.
        let reader = bearer(secret, "doc-own", "read");
        assert_eq!(
            catalog_documents(State(state.clone()), reader)
                .await
                .unwrap_err()
                .0,
            StatusCode::FORBIDDEN
        );

        // A half-written bundle is named, not dropped from the list.
        std::fs::write(
            temp.path().join("doc-own.hcd").join("manifest.json"),
            b"{ this is not json",
        )
        .unwrap();
        let error = catalog_documents(State(state.clone()), admin)
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(
            error.1.contains("doc-own"),
            "the failing document is named: {}",
            error.1
        );
    }

    #[tokio::test]
    async fn catalog_theme_documents_name_the_pinning_documents() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let admin = bearer(secret, "*", "admin");
        let theme = seed_theme(&state, secret, "demo-serif").await;

        imported_bundle(
            &temp.path().join("doc-own.hcd"),
            "doc-own",
            Some(theme.clone()),
        );
        imported_bundle(&temp.path().join("doc-plain.hcd"), "doc-plain", None);

        let found =
            catalog_theme_documents(State(state.clone()), Path(theme.clone()), admin.clone())
                .await
                .unwrap()
                .0;
        assert_eq!(found.len(), 1, "only the pinned document is reachable");
        assert_eq!(found[0].document_id, "doc-own");
        assert!(found[0].head_pinned);
        // An import lands on revision 0 already carrying its pin.
        assert_eq!(found[0].pinned_revisions, vec![0]);
        let body = serde_json::to_value(&found).unwrap();
        assert_eq!(
            body,
            serde_json::json!([{
                "documentId": "doc-own",
                "headPinned": true,
                "pinnedRevisions": [0],
            }])
        );

        // The catalog lives in the same root as the documents and is not one.
        assert!(temp.path().join("catalog").is_dir());
        // A theme nothing pins has no documents to name.
        assert!(catalog_theme_documents(
            State(state.clone()),
            Path("ef".repeat(32)),
            admin.clone()
        )
        .await
        .unwrap()
        .0
        .is_empty());

        let error = catalog_theme_documents(State(state), Path("nope".to_string()), admin)
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn catalog_delete_theme_refuses_then_removes_an_unpinned_theme() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let admin = bearer(secret, "*", "admin");
        let theme = seed_theme(&state, secret, "demo-serif").await;
        imported_bundle(
            &temp.path().join("doc-own.hcd"),
            "doc-own",
            Some(theme.clone()),
        );

        let error = catalog_delete_theme(State(state.clone()), Path(theme.clone()), admin.clone())
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(error.1.contains("doc-own"), "{error:?}");
        assert_eq!(state.catalog.list_themes().unwrap().len(), 1);

        // Retirement stops new pins but frees nothing, so it does not unlock deletion.
        let _ = catalog_retire_theme(State(state.clone()), Path(theme.clone()), admin.clone())
            .await
            .unwrap();
        assert_eq!(
            catalog_delete_theme(State(state.clone()), Path(theme.clone()), admin.clone())
                .await
                .unwrap_err()
                .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );

        std::fs::remove_dir_all(temp.path().join("doc-own.hcd")).unwrap();
        let deleted =
            catalog_delete_theme(State(state.clone()), Path(theme.clone()), admin.clone())
                .await
                .unwrap();
        assert_eq!(deleted.0["deleted"], serde_json::json!(true));
        assert!(state.catalog.list_themes().unwrap().is_empty());
        assert!(state.catalog.list_retired_theme_ids().unwrap().is_empty());
        assert!(!state
            .catalog
            .root()
            .join("themes")
            .join(format!("{theme}.json"))
            .exists());
        // A theme is only slots: the font it cited stays for the next theme to reuse.
        assert_eq!(
            state.catalog.list_font_ids().unwrap(),
            vec!["demo-serif".to_string()]
        );

        let error = catalog_delete_theme(State(state), Path(theme), admin)
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn catalog_theme_reachability_and_delete_require_admin() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let admin = bearer(secret, "*", "admin");
        let unknown = "ab".repeat(32);

        // A non-admin token cannot read the reachability view or delete.
        let reader = bearer(secret, "*", "read");
        assert_eq!(
            catalog_theme_documents(State(state.clone()), Path(unknown.clone()), reader.clone())
                .await
                .unwrap_err()
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            catalog_delete_theme(State(state.clone()), Path(unknown.clone()), reader)
                .await
                .unwrap_err()
                .0,
            StatusCode::FORBIDDEN
        );

        // An unknown theme revision id is refused outright: no scan, no delete.
        assert_eq!(
            catalog_delete_theme(
                State(state.clone()),
                Path("nope".to_string()),
                admin.clone()
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            catalog_delete_theme(State(state), Path(unknown), admin)
                .await
                .unwrap_err()
                .0,
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn audit_route_is_admin_only_and_answers_newest_first() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());

        // The log names documents and operators, so no document token may read it,
        // whatever its scope.
        assert_eq!(
            catalog_audit(
                State(state.clone()),
                Query(AuditQuery {
                    limit: None,
                    from: None,
                    to: None,
                }),
                HeaderMap::new(),
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::UNAUTHORIZED
        );
        for (doc, scope) in [
            ("doc-a", "read"),
            ("doc-a", "write"),
            ("*", "read"),
            ("*", "upload"),
            ("*", "write"),
        ] {
            let error = catalog_audit(
                State(state.clone()),
                Query(AuditQuery {
                    limit: None,
                    from: None,
                    to: None,
                }),
                bearer(secret, doc, scope),
            )
            .await
            .unwrap_err();
            assert_eq!(error.0, StatusCode::FORBIDDEN, "{doc}/{scope} read the log");
        }

        // A catalog nobody has touched answers an empty log, not an error.
        let admin = bearer(secret, "*", "admin");
        let empty = catalog_audit(
            State(state.clone()),
            Query(AuditQuery {
                limit: None,
                from: None,
                to: None,
            }),
            admin.clone(),
        )
        .await
        .unwrap();
        assert_eq!(empty.0["entries"], json!([]));
        assert_eq!(empty.0["unreadable"], json!(0));
        assert_eq!(
            empty.0["limit"],
            json!(100),
            "the console asks without a limit and gets a page"
        );
        assert_eq!(
            catalog_audit(
                State(state.clone()),
                Query(AuditQuery {
                    limit: Some(0),
                    from: None,
                    to: None,
                }),
                admin.clone()
            )
            .await
            .unwrap()
            .0["limit"],
            json!(1),
            "a zero limit still answers something instead of nothing"
        );
        assert_eq!(
            catalog_audit(
                State(state.clone()),
                Query(AuditQuery {
                    limit: Some(9_999),
                    from: None,
                    to: None,
                }),
                admin.clone()
            )
            .await
            .unwrap()
            .0["limit"],
            json!(MAX_AUDIT_LIMIT),
            "the read stays bounded"
        );

        // Seeding through the same admin write surface the console uses leaves one
        // line per step, newest first.
        let theme = seed_theme(&state, secret, "demo-serif").await;
        let page = catalog_audit(
            State(state),
            Query(AuditQuery {
                limit: None,
                from: None,
                to: None,
            }),
            bearer(secret, "*", "admin"),
        )
        .await
        .unwrap();
        let entries = page.0["entries"].as_array().unwrap();
        let actions: Vec<&str> = entries
            .iter()
            .map(|entry| entry["action"].as_str().unwrap())
            .collect();
        assert_eq!(
            actions,
            vec![
                audit_action::THEME_PUT,
                audit_action::FONT_REVISION_PUT,
                audit_action::FONT_BYTES_PUT,
            ]
        );
        assert_eq!(entries[0]["target"], json!(theme));
        assert!(entries[0]["detail"]
            .as_str()
            .unwrap()
            .contains("Brand default"));
        assert_eq!(
            entries[0]["actor"],
            json!("admin:*"),
            "a token with no identity says which kind of credential acted"
        );
        let times: Vec<u64> = entries
            .iter()
            .map(|entry| entry["at"].as_u64().unwrap())
            .collect();
        assert!(
            times.windows(2).all(|pair| pair[0] >= pair[1]),
            "{times:?} is not newest first"
        );
    }

    /// The window is what lets the console answer "上周谁动过" without someone
    /// paging through the log by hand, so a bound that cannot be honoured has to
    /// fail loudly: an empty result for `from=2026-02-30` would read as a
    /// statement about the past.
    #[tokio::test]
    async fn audit_route_reads_a_utc_day_window_and_refuses_bounds_that_are_not_days() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let admin = bearer(secret, "*", "admin");
        let read = |query: AuditQuery| {
            let state = state.clone();
            let admin = admin.clone();
            async move { catalog_audit(State(state), Query(query), admin).await }
        };

        // The writer always stamps the current day, so an older day has to come
        // off disk: two lines in January 2020, newest first as appended.
        let older = state.catalog.root().join("audit").join("2020-01-01.jsonl");
        std::fs::create_dir_all(older.parent().unwrap()).unwrap();
        std::fs::write(
            &older,
            [
                json!({
                    // Appended oldest first, as the writer does: 2020-01-01 UTC.
                    "at": 1_577_836_800_000u64,
                    "action": audit_action::THEME_PUT,
                    "target": "old-theme",
                    "actor": "admin:*",
                    "detail": "一个老主题",
                }),
                json!({
                    "at": 1_577_836_860_000u64,
                    "action": audit_action::FONT_BYTES_PUT,
                    "target": "old-serif",
                    "actor": "admin:*",
                }),
            ]
            .iter()
            .map(|line| format!("{line}\n"))
            .collect::<String>()
            .as_bytes(),
        )
        .unwrap();
        let theme = seed_theme(&state, secret, "demo-serif").await;

        // No window reads across the files, newest day first.
        let all = read(AuditQuery {
            limit: None,
            from: None,
            to: None,
        })
        .await
        .unwrap()
        .0;
        assert_eq!(
            all["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["action"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                audit_action::THEME_PUT,
                audit_action::FONT_REVISION_PUT,
                audit_action::FONT_BYTES_PUT,
                audit_action::FONT_BYTES_PUT,
                audit_action::THEME_PUT,
            ],
            "the days are not stitched together newest-first"
        );
        assert_eq!(all["entries"][0]["target"], json!(theme));
        assert_eq!(all["entries"][4]["target"], json!("old-theme"));
        assert_eq!(all["from"], Value::Null, "an open bound stays open");
        assert_eq!(all["to"], Value::Null);
        assert_eq!(all["truncated"], json!(false), "five lines fit one page");

        // Both ends are inclusive, and the answer names the window it applied.
        let past = read(AuditQuery {
            limit: None,
            from: Some("2020-01-01".to_string()),
            to: Some("2020-01-01".to_string()),
        })
        .await
        .unwrap()
        .0;
        assert_eq!(past["entries"].as_array().unwrap().len(), 2);
        assert_eq!(past["from"], json!("2020-01-01"));
        assert_eq!(past["to"], json!("2020-01-01"));

        // A window with nothing in it is an honest empty, not an error.
        let quiet = read(AuditQuery {
            limit: None,
            from: Some("2015-01-01".to_string()),
            to: Some("2016-01-01".to_string()),
        })
        .await
        .unwrap()
        .0;
        assert_eq!(quiet["entries"], json!([]));
        assert_eq!(quiet["truncated"], json!(false));

        // `from` alone means "since", so the older day drops out.
        let since = read(AuditQuery {
            limit: None,
            from: Some("2024-01-01".to_string()),
            to: None,
        })
        .await
        .unwrap()
        .0;
        assert_eq!(since["entries"].as_array().unwrap().len(), 3);
        assert_eq!(since["from"], json!("2024-01-01"));
        assert_eq!(since["to"], Value::Null);

        // A limit that spends itself inside a window says so, because the rows
        // not shown are real rows the caller asked for.
        let tight = read(AuditQuery {
            limit: Some(1),
            from: Some("2020-01-01".to_string()),
            to: None,
        })
        .await
        .unwrap()
        .0;
        assert_eq!(tight["entries"].as_array().unwrap().len(), 1);
        assert_eq!(tight["truncated"], json!(true));

        // Half-filled query strings are the browser leaving a bound open, not a
        // request about a day that does not exist.
        for open in ["", "   "] {
            let answer = read(AuditQuery {
                limit: None,
                from: Some(open.to_string()),
                to: None,
            })
            .await
            .unwrap()
            .0;
            assert_eq!(answer["from"], Value::Null, "{open:?} closed the window");
            assert_eq!(answer["entries"].as_array().unwrap().len(), 5);
        }

        for rejected in ["2026-02-30", "2023-02-29", "2026-13-01", "2026-2-1", "next-tuesday"] {
            let error = read(AuditQuery {
                limit: None,
                from: Some(rejected.to_string()),
                to: None,
            })
            .await
            .unwrap_err();
            assert_eq!(error.0, StatusCode::BAD_REQUEST, "{rejected} accepted");
            let message = error.1.to_string();
            assert!(message.contains("from") && message.contains(rejected), "{message}");

            let error = read(AuditQuery {
                limit: None,
                from: None,
                to: Some(rejected.to_string()),
            })
            .await
            .unwrap_err();
            assert_eq!(error.0, StatusCode::BAD_REQUEST, "{rejected} accepted as `to`");
            assert!(error.1.to_string().contains("to"), "{}", error.1);
        }

        let inverted = read(AuditQuery {
            limit: None,
            from: Some("2024-06-01".to_string()),
            to: Some("2024-05-01".to_string()),
        })
        .await
        .unwrap_err();
        assert_eq!(inverted.0, StatusCode::BAD_REQUEST);
        assert!(
            inverted.1.to_string().contains("2024-06-01"),
            "{}",
            inverted.1
        );

        // A wrong window is still admin-only: the bounds are not read before the
        // caller is identified.
        let unauthorized = catalog_audit(
            State(state.clone()),
            Query(AuditQuery {
                limit: None,
                from: Some("nonsense".to_string()),
                to: None,
            }),
            HeaderMap::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(unauthorized.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn every_finished_catalog_change_appends_a_line_and_a_refusal_none() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let admin = bearer_as(secret, "*", "admin", Some("op-1"), Some("林运营"));

        let uploaded = catalog_put_blob(
            State(state.clone()),
            Path("demo-serif".to_string()),
            Query(BlobQuery {
                format: "ttf".to_string(),
            }),
            admin.clone(),
            Bytes::from_static(TTF),
        )
        .await
        .unwrap();
        let sha256 = uploaded.0["sha256"].as_str().unwrap().to_string();
        let revision = catalog_put_font_revision(
            State(state.clone()),
            Path("demo-serif".to_string()),
            admin.clone(),
            Json(NewFontRevisionBody {
                family: "Demo Serif".to_string(),
                faces: vec![face(&sha256)],
                license: license(),
            }),
        )
        .await
        .unwrap();
        let theme = catalog_put_theme(
            State(state.clone()),
            admin.clone(),
            Json(NewThemeBody {
                name: "Brand default".to_string(),
                major: ThemeFontSlots {
                    latin: Some(FontRef {
                        font_id: "demo-serif".to_string(),
                        font_revision_id: revision.0.font_revision_id.clone(),
                    }),
                    east_asia: None,
                    bidi: None,
                },
                minor: ThemeFontSlots::default(),
                fallback_families: vec!["serif".to_string()],
            }),
        )
        .await
        .unwrap()
        .0
        .theme_revision_id;

        // Retire it, retire it a second time, then bring it back.
        for _ in 0..2 {
            let _ = catalog_retire_theme(State(state.clone()), Path(theme.clone()), admin.clone())
                .await
                .unwrap();
        }
        let _ = catalog_unretire_theme(State(state.clone()), Path(theme.clone()), admin.clone())
            .await
            .unwrap();

        // A document pins it; pinning the same theme again changes nothing.
        let body = || {
            Json(PinThemeBody {
                theme_revision_id: Some(theme.clone()),
            })
        };
        imported_bundle(&temp.path().join("doc-a.hcd"), "doc-a", None);
        let _ = pin_theme(
            State(state.clone()),
            Path("doc-a".to_string()),
            admin.clone(),
            body(),
        )
        .await
        .unwrap();
        let _ = pin_theme(
            State(state.clone()),
            Path("doc-a".to_string()),
            admin.clone(),
            body(),
        )
        .await
        .unwrap();

        // Refused requests are not recorded: nothing was changed.
        let counted = state
            .catalog
            .audit_entries(MAX_AUDIT_LIMIT)
            .unwrap()
            .entries
            .len();
        assert_eq!(
            pin_theme(
                State(state.clone()),
                Path("doc-a".to_string()),
                bearer(secret, "doc-a", "read"),
                body(),
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            catalog_delete_theme(State(state.clone()), Path("cd".repeat(32)), admin.clone())
                .await
                .unwrap_err()
                .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            state
                .catalog
                .audit_entries(MAX_AUDIT_LIMIT)
                .unwrap()
                .entries
                .len(),
            counted,
            "a refusal left a line behind"
        );

        // The document's own writer unpins it, which frees the theme and then the
        // font for deletion.
        let writer = bearer_as(secret, "doc-a", "write", Some("editor-7"), Some("陈瑞"));
        let _ = pin_theme(
            State(state.clone()),
            Path("doc-a".to_string()),
            writer,
            Json(PinThemeBody {
                theme_revision_id: None,
            }),
        )
        .await
        .unwrap();
        // The document's history still cites the theme it pinned once, so the theme
        // stays reachable from here until the bundle itself goes.
        std::fs::remove_dir_all(temp.path().join("doc-a.hcd")).unwrap();
        let _ = catalog_delete_theme(State(state.clone()), Path(theme.clone()), admin.clone())
            .await
            .unwrap();
        let _ = catalog_delete_font(State(state.clone()), Path("demo-serif".to_string()), admin)
            .await
            .unwrap();

        let page = state.catalog.audit_entries(MAX_AUDIT_LIMIT).unwrap();
        let actions: Vec<&str> = page
            .entries
            .iter()
            .map(|entry| entry.action.as_str())
            .collect();
        assert_eq!(
            actions,
            vec![
                audit_action::FONT_DELETE,
                audit_action::THEME_DELETE,
                audit_action::DOCUMENT_THEME_UNPIN,
                audit_action::DOCUMENT_THEME_PIN,
                audit_action::THEME_UNRETIRE,
                audit_action::THEME_RETIRE,
                audit_action::THEME_RETIRE,
                audit_action::THEME_PUT,
                audit_action::FONT_REVISION_PUT,
                audit_action::FONT_BYTES_PUT,
            ],
            "one line per finished change, newest first, and no line for the no-op re-pin"
        );
        assert_eq!(page.unreadable, 0);
        assert_eq!(page.entries[0].actor, "林运营 (op-1)");
        assert_eq!(
            page.entries[2].actor, "陈瑞 (editor-7)",
            "the document's own writer is named, not the operator"
        );
        assert_eq!(page.entries[3].target, "doc-a");
        assert!(
            page.entries[3].detail.contains("修订 r0 → r1"),
            "{}",
            page.entries[3].detail
        );
        assert!(
            page.entries[3].detail.contains("Brand default"),
            "{}",
            page.entries[3].detail
        );
        assert!(
            page.entries[2].detail.contains("修订 r1 → r2"),
            "{}",
            page.entries[2].detail
        );
        // The repeat retire says out loud that it changed nothing, so two lines are
        // not read as two state flips.
        assert!(
            page.entries[5].detail.contains("本次没有改变"),
            "{}",
            page.entries[5].detail
        );
        assert!(
            !page.entries[6].detail.contains("本次没有改变"),
            "{}",
            page.entries[6].detail
        );
        assert!(page.entries[9].detail.contains(&sha256));
        assert_eq!(page.entries[9].target, "demo-serif");
    }

    #[tokio::test]
    async fn an_import_auto_pin_is_recorded_against_the_uploader() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let mut state = test_state(secret, temp.path());
        let theme = seed_theme(&state, secret, "demo-serif").await;
        state.default_theme = Some(theme.clone());

        let destination = temp.path().join("doc-new.hcd");
        imported_bundle(&destination, "doc-new", None);
        assert_eq!(
            pin_default_theme(
                &state.catalog,
                state.default_theme.as_deref(),
                &destination,
                "upload:op-9"
            ),
            None
        );

        let page = state.catalog.audit_entries(MAX_AUDIT_LIMIT).unwrap();
        let pin = &page.entries[0];
        assert_eq!(pin.action, audit_action::DOCUMENT_THEME_PIN);
        assert_eq!(pin.target, "doc-new");
        assert_eq!(
            pin.actor, "upload:op-9",
            "the upload that caused the pin is named, not the service"
        );
        assert!(pin.detail.contains("自动钉上"), "{}", pin.detail);
        assert!(pin.detail.contains(&theme), "{}", pin.detail);

        // A document that arrived carrying its own pin is not touched, and the log
        // does not claim it was.
        let counted = page.entries.len();
        let archive = temp.path().join("doc-own.hcd");
        imported_bundle(&archive, "doc-own", Some("cd".repeat(32)));
        assert_eq!(
            pin_default_theme(
                &state.catalog,
                state.default_theme.as_deref(),
                &archive,
                "upload:op-9"
            ),
            None
        );
        assert_eq!(
            state
                .catalog
                .audit_entries(MAX_AUDIT_LIMIT)
                .unwrap()
                .entries
                .len(),
            counted,
            "an untouched document was logged"
        );
    }

    #[test]
    fn font_faces_only_keeps_face_lines_and_drops_the_rest() {
        let css = "@font-face{font-family:'A';src:url(data:font/ttf;base64,AAA)}\n\
                   :root{--hcd-major-latin:'A',serif}\n\
                   body[data-hcd-profile=\"semantic-flow\"]{font-family:var(--hcd-major-latin)}\n";
        assert_eq!(
            font_faces_only(css),
            "@font-face{font-family:'A';src:url(data:font/ttf;base64,AAA)}\n"
        );
        // A theme with no web face stays empty: the caller asked for font bytes
        // alone, so nothing else may slip through.
        assert_eq!(font_faces_only(":root{--hcd-major-latin:'A',serif}\n"), "");
    }

    #[tokio::test]
    async fn theme_faces_only_query_serves_font_bytes_alone() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let theme = seed_theme(&state, secret, "demo-serif").await;
        let id = "doc-a";
        // A pin on the manifest whose stylesheet has no theme region — the shape a
        // surface that does not render `/styles` (the semantic editor) needs served
        // in full, and the shape `faces=only` is for everywhere else.
        imported_bundle(
            &temp.path().join(format!("{id}.hcd")),
            id,
            Some(theme.clone()),
        );

        let full = document_theme(
            State(state.clone()),
            Path(id.to_string()),
            Query(ThemeQuery {
                revision: None,
                faces: None,
            }),
            bearer(secret, id, "read"),
        )
        .await
        .unwrap();
        assert_eq!(full.0.theme_revision_id, theme);
        let full = full.0.theme.css;
        assert!(full.contains("@font-face{"), "{full}");
        assert!(full.contains("--hcd-major-latin:"), "{full}");

        let faces = document_theme(
            State(state.clone()),
            Path(id.to_string()),
            Query(ThemeQuery {
                revision: None,
                faces: Some("only".to_string()),
            }),
            bearer(secret, id, "read"),
        )
        .await
        .unwrap()
        .0
        .theme
        .css;
        assert!(faces.contains("@font-face{"), "{faces}");
        assert!(!faces.contains("--hcd-major-latin:"), "{faces}");

        // Any other value is refused instead of quietly serving the full block.
        assert_eq!(
            document_theme(
                State(state),
                Path(id.to_string()),
                Query(ThemeQuery {
                    revision: None,
                    faces: Some("all".to_string()),
                }),
                bearer(secret, id, "read"),
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn a_pinned_document_gets_theme_bytes_not_a_second_copy_of_its_rules() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"unit-test-catalog-secret-0123456789";
        let state = test_state(secret, temp.path());
        let theme = seed_theme(&state, secret, "demo-serif").await;
        let id = "doc-a";
        imported_bundle(&temp.path().join(format!("{id}.hcd")), id, None);

        // The pin the console and the CLI both go through: a content revision whose
        // stylesheet is the one copy of the theme's declarations.
        let pinned = pin_theme(
            State(state.clone()),
            Path(id.to_string()),
            bearer(secret, id, "write"),
            Json(PinThemeBody {
                theme_revision_id: Some(theme),
            }),
        )
        .await
        .unwrap();
        assert_eq!(pinned.0.revision, 1);

        let bundle = open(&state, id).unwrap();
        let manifest = bundle.manifest().unwrap();
        let styles = bundle.read_styles_part(&manifest.styles_href).unwrap();
        assert!(styles.contains("/* hcd-theme-begin */"), "{styles}");
        assert_eq!(styles.matches("--hcd-major-latin:").count(), 1, "{styles}");

        // What the HTML presentation adds on top of that stylesheet: the bytes, and
        // nothing that would make two stylesheets claim one document.
        let transport = hcd_core::theme_presentation_css(&state.catalog, &bundle, None)
            .unwrap()
            .unwrap();
        assert!(transport.contains("@font-face{"), "{transport}");
        assert!(transport.contains("Demo Serif"), "{transport}");
        assert!(!transport.contains("--hcd-major-latin:"), "{transport}");
        assert!(!transport.contains("body[data-hcd-profile"), "{transport}");
    }
}
