//! Authenticated local HCD core API. Bundles stay private under the configured root.
//! The HTTP surface only returns decoded, verified objects requested by the client.
use crate::commands::hdoc::{HdocIssueTokenCommand, HdocServeCommand, HdocTokenScope};
use crate::hdoc_collaboration::{
    Metadata as CollaborationMetadata, MigrationReceipt, Protocol as CollaborationProtocol,
};
use crate::hdoc_remote::RemoteStore;
use anyhow::{anyhow, Context, Result};
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
#[cfg(test)]
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
#[path = "hdoc_access.rs"]
mod access_policy;
use access_policy::{DocumentAccess, DocumentAccessPolicy, FileAccessPolicy};
#[path = "hdoc_restore.rs"]
mod coordinated_restore;
#[path = "hdoc_export_capabilities.rs"]
mod export_capabilities;
#[path = "hdoc_export_process.rs"]
mod export_process;
#[path = "hdoc_people.rs"]
mod people;
#[path = "hdoc_recovery_archive.rs"]
mod recovery_archive;
#[path = "hdoc_word_checkpoints.rs"]
mod word_checkpoints;
#[path = "hdoc_word_link_preflight.rs"]
mod word_link_preflight;
#[path = "hdoc_word_link_transactions.rs"]
mod word_link_transactions;
#[path = "hdoc_word_owner.rs"]
mod word_owner;
#[path = "hdoc_word_source_proof.rs"]
mod word_source_proof;
#[path = "hdoc_xlsx_formula_proof.rs"]
mod xlsx_formula_proof;
#[path = "hdoc_xlsx_grid_create.rs"]
mod xlsx_grid_create;

#[derive(Clone)]
struct ServerState {
    root: PathBuf,
    secret: Arc<Vec<u8>>,
    remote: Option<RemoteStore>,
    collaboration_lock: Arc<Mutex<()>>,
    revisions: RevisionHub,
    word_owners: word_owner::WordOwners,
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
    if matches!(command.scope, HdocTokenScope::Manage)
        && command
            .user_id
            .as_deref()
            .is_none_or(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control))
    {
        return Err(anyhow!("manage tokens require a stable --user-id"));
    }
    let claims = Claims {
        doc: command.document_id.clone(),
        scope: match command.scope {
            HdocTokenScope::Manage => "manage",
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
    export_process::timeout_from_env().map_err(|error| anyhow!(error.1))?;
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
            ));
        }
    };
    let state = ServerState {
        root,
        secret,
        remote,
        collaboration_lock: Arc::new(Mutex::new(())),
        revisions: RevisionHub::default(),
        word_owners: word_owner::WordOwners::default(),
    };
    state.word_owners.start();
    let router = Router::new()
        .route("/health", get(|| async { Json(json!({"ok": true})) }))
        .route("/v1/documents/{id}", get(manifest))
        .route("/v1/documents/{id}/head", get(document_head))
        .route("/v1/import", post(import_document))
        .route("/v1/jobs/{job_id}", get(job_status))
        .route("/v1/documents/{id}/editor", get(editor))
        .route(
            "/v1/documents/{id}/xlsx/formula-audit",
            get(xlsx_formula_audit).post(xlsx_formula_proof_create),
        )
        .route("/v1/documents/{id}/xlsx/source", post(xlsx_restore_source))
        .route(
            "/v1/documents/{id}/word/source",
            get(word_source_status).post(word_restore_source),
        )
        .route("/v1/documents/{id}/word/layout", get(word_layout))
        .route("/v1/documents/{id}/word/story-index", get(word_story_index))
        .route(
            "/v1/documents/{id}/word/link-preflight",
            post(word_link_preflight::preview),
        )
        .route(
            "/v1/documents/{id}/word/link-transactions",
            post(word_link_transactions::transaction),
        )
        .route(
            "/v1/documents/{id}/word/link-receipt",
            post(word_link_transactions::receipt),
        )
        .route("/v1/documents/{id}/export-options", get(export_options))
        .route(
            "/v1/documents/{id}/export-capabilities",
            get(export_capabilities::options),
        )
        .route("/v1/documents/{id}/project", post(project))
        .route(
            "/v1/documents/{id}/pdf/layout",
            get(pdf_layout_status).post(upgrade_pdf_layout),
        )
        .route("/v1/documents/{id}/patch", post(patch))
        .route("/v1/documents/{id}/checkpoints", post(checkpoint))
        .route(
            "/v1/documents/{id}/word/checkpoints",
            post(word_checkpoints::checkpoint_http),
        )
        .route(
            "/v1/documents/{id}/word/checkpoint-receipt",
            post(word_checkpoints::checkpoint_receipt),
        )
        .route(
            "/v1/documents/{id}/word/layout-receipt",
            post(word_checkpoints::layout_receipt),
        )
        .route(
            "/v1/documents/{id}/word/story-receipt",
            post(word_checkpoints::story_receipt),
        )
        .route(
            "/v1/documents/{id}/word/story-transactions",
            post(word_checkpoints::story_transaction),
        )
        .route(
            "/v1/documents/{id}/word/story-preflight",
            post(word_checkpoints::story_preflight),
        )
        .route(
            "/v1/documents/{id}/word/topology-cancel",
            post(word_checkpoints::topology_cancel),
        )
        .route(
            "/v1/documents/{id}/word/checkpoint-cancel",
            post(word_checkpoints::checkpoint_cancel),
        )
        .route(
            "/v1/documents/{id}/word/layout-transactions",
            post(word_checkpoints::layout_transaction),
        )
        .route(
            "/v1/documents/{id}/word/layout-preflight",
            post(word_checkpoints::layout_preflight),
        )
        .route(
            "/v1/documents/{id}/collaboration/word-owner",
            post(word_owner::owner),
        )
        .route("/v1/documents/{id}/revisions", get(revisions))
        .route("/v1/documents/{id}/revisions/{revision}", get(revision))
        .route("/v1/documents/{id}/restore/{revision}", post(restore))
        .route(
            "/v1/documents/{id}/collaboration/restore/{revision}",
            post(coordinated_restore::restore),
        )
        .route("/v1/documents/{id}/index/{page}", get(index_page))
        .route("/v1/documents/{id}/mention-options", get(people::options))
        .route(
            "/v1/documents/{id}/references/resolve",
            post(people::resolve),
        )
        .route("/v1/documents/{id}/references", get(people::references))
        .route("/v1/documents/{id}/chunks/{sequence}", get(chunk))
        .route("/v1/documents/{id}/assets/{hash}", get(asset))
        .route("/v1/documents/{id}/staged-assets", post(stage_image))
        .route("/v1/documents/{id}/staged-assets/{hash}", get(staged_image))
        .route("/v1/documents/{id}/resources", post(stage_resource))
        .route("/v1/documents/{id}/resources/reuse", post(restage_resource))
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
            "/v1/documents/{id}/grid/cells",
            post(xlsx_grid_create::create),
        )
        .route(
            "/v1/documents/{id}/grid/cells/inspect",
            post(xlsx_grid_create::inspect),
        )
        .route(
            "/v1/documents/{id}/grid/cells/compare",
            post(xlsx_grid_create::compare),
        )
        .route(
            "/v1/documents/{id}/grid/cells/receipt",
            post(xlsx_grid_create::receipt),
        )
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
        .route(
            "/v1/documents/{id}/recovery/canonical/inspect",
            post(recovery_archive::inspect)
                .layer(DefaultBodyLimit::max(recovery_archive::MAX_ARCHIVE_BYTES)),
        )
        .route("/v1/documents/{id}/auth", get(auth_check))
        .route(
            "/v1/documents/{id}/access",
            get(get_access).post(set_access),
        )
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
            "/v1/documents/{id}/collaboration/migrate",
            post(collaboration_migrate),
        )
        .route(
            "/v1/documents/{id}/collaboration/reset",
            post(collaboration_reset),
        )
        .layer(DefaultBodyLimit::max(MAX_PATCH_JSON_BYTES as usize))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            access_gate,
        ))
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
    validation.leeway = 0;
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
        let field_protected = self.0 == StatusCode::UNPROCESSABLE_ENTITY
            && self.1.starts_with("DOCX_SOURCE_TEXT_READ_ONLY");
        let block_id = self
            .1
            .strip_prefix("DOCX_SOURCE_TEXT_READ_ONLY:")
            .filter(|id| {
                id.len() == 34
                    && id.starts_with("n_")
                    && id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
            .and_then(|id| header::HeaderValue::from_str(id).ok());
        let source_required =
            self.0 == StatusCode::UNPROCESSABLE_ENTITY && self.1 == "DOCX_SOURCE_REQUIRED";
        let mut response = (self.0, Json(json!({"error": self.1}))).into_response();
        if source_required {
            response.headers_mut().insert(
                "x-hcd-error-code",
                header::HeaderValue::from_static("DOCX_SOURCE_REQUIRED"),
            );
        }
        if field_protected {
            response.headers_mut().insert(
                "x-hcd-error-code",
                header::HeaderValue::from_static("DOCX_SOURCE_TEXT_READ_ONLY"),
            );
            if let Some(id) = block_id {
                response.headers_mut().insert("x-hcd-protected-block", id);
            }
        }
        response
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

fn token_claims(state: &ServerState, headers: &HeaderMap, id: &str) -> Result<Claims, ApiError> {
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
    validation.leeway = 0;
    let claims = decode::<Claims>(token, &DecodingKey::from_secret(&state.secret), &validation)
        .map_err(|_| {
            ApiError(
                StatusCode::UNAUTHORIZED,
                "invalid or expired token".to_string(),
            )
        })?
        .claims;
    if claims.doc != id || !matches!(claims.scope.as_str(), "read" | "write" | "manage") {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "token document or scope mismatch".to_string(),
        ));
    }
    Ok(claims)
}

fn collaboration_service(claims: &Claims) -> bool {
    claims.scope == "write" && claims.sub.as_deref() == Some("hcd-collaboration")
}
fn claims(state: &ServerState, headers: &HeaderMap, id: &str) -> Result<Claims, ApiError> {
    let claims = token_claims(state, headers, id)?;
    let access = load_access(state, id)?;
    if claims.scope == "manage"
        || !collaboration_service(&claims) && !access.can_read(claims.sub.as_deref())
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "document access policy does not allow reading".into(),
        ));
    }
    Ok(claims)
}
fn manage_claims(state: &ServerState, headers: &HeaderMap, id: &str) -> Result<Claims, ApiError> {
    let claims = token_claims(state, headers, id)?;
    if claims.scope != "manage"
        || claims.sub.as_deref().is_none_or(str::is_empty)
        || claims.sub.as_deref() == Some("hcd-collaboration")
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "policy management token required".into(),
        ));
    }
    Ok(claims)
}
async fn access_gate(
    State(state): State<ServerState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let Some(rest) = request.uri().path().strip_prefix("/v1/documents/") else {
        return next.run(request).await;
    };
    let (id, route) = rest
        .split_once('/')
        .map_or((rest, ""), |(id, route)| (id, route));
    if !valid_id(id) {
        return bad("invalid document ID").into_response();
    }
    // The management handlers own the exclusive gate; never upgrade a read lock.
    if matches!(route, "access" | "collaboration/migrate")
        || route.starts_with("collaboration/restore/")
    {
        return next.run(request).await;
    }
    let guard = access_policy::gate(&state.root, id).read_owned().await;
    if route == "events/ws" && request.method() == axum::http::Method::GET {
        let response = next.run(request).await;
        drop(guard);
        return response;
    }
    let identity = match claims(&state, request.headers(), id) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    let story_receipt = route == "word/story-receipt"
        && request.method() == axum::http::Method::POST
        && collaboration_service(&identity);
    let story_recovery_owner = route == "collaboration/word-owner"
        && request.method() == axum::http::Method::POST
        && collaboration_service(&identity)
        && request
            .headers()
            .get("x-hcd-word-story-recovery")
            .and_then(|value| value.to_str().ok())
            == Some("1");
    let story_transaction = matches!(
        route,
        "word/story-transactions"
            | "word/story-preflight"
            | "word/topology-cancel"
            | "word/checkpoint-cancel"
    ) && request.method() == axum::http::Method::POST
        && collaboration_service(&identity)
        && request
            .headers()
            .get("x-hcd-coordinator-version")
            .and_then(|value| value.to_str().ok())
            == Some("7")
        && request
            .headers()
            .get("x-hcd-word-story-version")
            .and_then(|value| value.to_str().ok())
            == Some("1");
    // Story-aware layout requests remain subject to the handler's epoch,
    // owner, actor and current-head capability checks.
    let story_layout = matches!(
        route,
        "word/layout-preflight"
            | "word/layout-transactions"
            | "word/layout-receipt"
            | "word/link-preflight"
            | "word/link-transactions"
            | "word/link-receipt"
    ) && request.method() == axum::http::Method::POST
        && collaboration_service(&identity)
        && request
            .headers()
            .get("x-hcd-coordinator-version")
            .and_then(|v| v.to_str().ok())
            == Some("7")
        && request
            .headers()
            .get("x-hcd-word-story-version")
            .and_then(|v| v.to_str().ok())
            == Some("1")
        && request
            .headers()
            .get("x-hcd-word-layout-version")
            .and_then(|v| v.to_str().ok())
            == Some("1")
        && (!matches!(
            route,
            "word/link-preflight" | "word/link-transactions" | "word/link-receipt"
        ) || request
            .headers()
            .get("x-hcd-word-link-version")
            .and_then(|v| v.to_str().ok())
            == Some("1"));
    // The actual checkpoint handlers still verify document capability,
    // collaboration epoch, owner lease, journal and all contributors.
    let story_checkpoint = matches!(route, "word/checkpoints" | "word/checkpoint-receipt")
        && request.method() == axum::http::Method::POST
        && collaboration_service(&identity)
        && request
            .headers()
            .get("x-hcd-coordinator-version")
            .and_then(|v| v.to_str().ok())
            == Some("7")
        && request
            .headers()
            .get("x-hcd-word-story-version")
            .and_then(|v| v.to_str().ok())
            == Some("1");
    if request.method() != axum::http::Method::GET
        && route != "collaboration/recovery"
        && !story_receipt
        && !story_recovery_owner
        && !story_transaction
        && !story_checkpoint
        && !story_layout
    {
        match open(&state, id)
            .and_then(|bundle| bundle.manifest().map_err(hcd_error))
            .and_then(|head| require_story_link_editor_safe(&head))
        {
            Ok(()) => {}
            Err(error) => return error.into_response(),
        }
    }
    if request.method() != axum::http::Method::GET && coordinated_restore::pending(&state, id).await
    {
        return ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "document restore is being reconciled".into(),
        )
        .into_response();
    }
    if collaboration_service(&identity) && request.method() != axum::http::Method::GET {
        let allowed = matches!(
            (request.method().as_str(), route),
            ("PUT", "collaboration/state")
                | (
                    "POST",
                    "checkpoints"
                        | "word/checkpoints"
                        | "word/checkpoint-receipt"
                        | "word/layout-receipt"
                        | "word/story-receipt"
                        | "word/story-transactions"
                        | "word/story-preflight"
                        | "word/link-preflight"
                        | "word/link-transactions"
                        | "word/link-receipt"
                        | "word/topology-cancel"
                        | "word/checkpoint-cancel"
                        | "word/layout-transactions"
                        | "word/layout-preflight"
                        | "collaboration/word-owner"
                        | "collaboration/recovery"
                        | "project"
                )
        );
        if !allowed {
            return ApiError(
                StatusCode::FORBIDDEN,
                "collaboration service cannot use this mutation route".into(),
            )
            .into_response();
        }
    }
    if collaboration_service(&identity)
        && request.method() == axum::http::Method::POST
        && route == "project"
    {
        match collaboration_metadata(&state, id).await {
            Ok(metadata) if metadata.protocol != CollaborationProtocol::Default1 => {
                if let Err(error) = check_collaboration_epoch(&state, id, request.headers()).await {
                    return error.into_response();
                }
            }
            Err(error) => return error.into_response(),
            _ => {}
        }
    }
    let private_references = route == "mention-options"
        || route == "references"
        || route.starts_with("references/")
        || route == "collaboration/word-owner";
    let mut response = next.run(request).await;
    if private_references {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            "no-store".parse().expect("static cache directive"),
        );
        response.headers_mut().insert(
            header::VARY,
            "Authorization".parse().expect("static vary directive"),
        );
    }
    drop(guard);
    response
}

fn authorize(
    state: &ServerState,
    headers: &HeaderMap,
    id: &str,
    write: bool,
) -> Result<(), ApiError> {
    let claims = claims(state, headers, id)?;
    if write {
        require_write(state, id, &claims)?;
    }
    Ok(())
}

fn load_access(state: &ServerState, id: &str) -> Result<DocumentAccess, ApiError> {
    FileAccessPolicy::new(&state.root)
        .load(id)
        .map_err(internal)
}
#[cfg(test)]
fn store_access(state: &ServerState, id: &str, access: &DocumentAccess) -> Result<(), ApiError> {
    if !FileAccessPolicy::new(&state.root)
        .compare_replace(id, access.generation.saturating_sub(1), access)
        .map_err(internal)?
    {
        return Err(ApiError(StatusCode::CONFLICT, "policy changed".into()));
    }
    Ok(())
}
fn write_allowed(claims: &Claims, access: &DocumentAccess) -> bool {
    claims.scope == "write" && access.can_write(claims.sub.as_deref())
}
fn require_write(state: &ServerState, id: &str, claims: &Claims) -> Result<(), ApiError> {
    if collaboration_service(claims) {
        return Ok(());
    }
    if !write_allowed(claims, &load_access(state, id)?) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "document access policy does not allow this token to write".into(),
        ));
    }
    Ok(())
}
#[cfg(test)]
fn update_access(
    current: &DocumentAccess,
    writers: Option<Vec<String>>,
) -> Result<DocumentAccess, ApiError> {
    current
        .replace(current.readers.clone(), writers)
        .map_err(bad)
}

async fn auth_check(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let claims = claims(&state, &headers, &id)?;
    open(&state, &id)?;
    let access = load_access(&state, &id)?;
    let revoked = !collaboration_service(&claims)
        && claims.scope == "write"
        && !write_allowed(&claims, &access);
    let scope = if revoked {
        "read"
    } else {
        claims.scope.as_str()
    };
    let collaboration = collaboration_metadata(&state, &id).await?;
    Ok(Json(
        json!({"documentId": id, "scope": scope, "access": if revoked { "revoked" } else { "active" },
        "accessGeneration": access.generation, "userId": claims.sub,
        "displayName": claims.name, "expiresAt": claims.exp, "collaborationEpoch": collaboration.epoch,"collaborationProtocol":collaboration.protocol,"coordinatedRestore":state.remote.is_none(),
        "wordNumericFields":if state.remote.is_none() && collaboration.protocol==CollaborationProtocol::WordRegions2 {Some("inline-v1")}else{None}}),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccessUpdate {
    expected_generation: u64,
    readers: Option<Vec<String>>,
    writers: Option<Vec<String>>,
}
async fn get_access(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    manage_claims(&state, &headers, &id)?;
    let _guard = access_policy::gate(&state.root, &id).read_owned().await;
    manage_claims(&state, &headers, &id)?;
    open(&state, &id)?;
    Ok(Json(
        json!({"schemaVersion":"hcd-access/1","policy":load_access(&state,&id)?,"collaborationEpoch":collaboration_epoch(&state,&id).await?}),
    ))
}
async fn set_access(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    manage_claims(&state, &headers, &id)?;
    if state.remote.is_some() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "remote access policy requires a shared atomic policy/epoch adapter".into(),
        ));
    }
    if !value.as_object().is_some_and(|value| {
        ["expectedGeneration", "readers", "writers"]
            .iter()
            .all(|key| value.contains_key(*key))
    }) {
        return Err(bad(
            "expectedGeneration, readers and writers are required; null explicitly retains token-based membership",
        ));
    }
    let update: AccessUpdate = serde_json::from_value(value).map_err(bad)?;
    let _gate = access_policy::gate(&state.root, &id).write_owned().await;
    manage_claims(&state, &headers, &id)?;
    open(&state, &id)?;
    let current = load_access(&state, &id)?;
    if current.generation != update.expected_generation {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "document access generation changed".into(),
        ));
    }
    let next = current
        .replace(update.readers, update.writers)
        .map_err(bad)?;
    let _guard = state.collaboration_lock.lock().await;
    // Fence old owners before publishing membership. Failure leaves old access
    // in place, with a safe epoch advance and preserved recovery if necessary.
    let epoch = if next.revokes(&current) {
        reset_collaboration_locked(&state, &id).await?
    } else {
        collaboration_epoch(&state, &id).await?
    };
    if !FileAccessPolicy::new(&state.root)
        .compare_replace(&id, current.generation, &next)
        .map_err(internal)?
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "document access generation changed".into(),
        ));
    }
    Ok(Json(
        json!({"schemaVersion":"hcd-access/1","policy":next,"collaborationEpoch":epoch}),
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
    let metadata = collaboration_metadata(state, id).await?;
    let name = if metadata.epoch == epoch {
        metadata
            .migration
            .as_ref()
            .map(|receipt| format!("{id}.epoch-{epoch}.{}.bin", receipt.id))
    } else {
        None
    };
    let path = state
        .root
        .join("collaboration")
        .join(name.unwrap_or_else(|| format!("{id}.epoch-{epoch}.bin")));
    let legacy = collaboration_path(state, id);
    // Called under the collaboration lock. Migrate the old unversioned name
    // once; subsequent epochs cannot accidentally load an older binary after
    // a crash between generation advancement and file deletion.
    if metadata.protocol == CollaborationProtocol::Default1
        && !tokio::fs::try_exists(&path).await.map_err(internal)?
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

async fn collaboration_metadata(
    state: &ServerState,
    id: &str,
) -> Result<CollaborationMetadata, ApiError> {
    if let Some(remote) = &state.remote {
        return remote.collaboration_metadata(id).await.map_err(internal);
    }
    match tokio::fs::read_to_string(collaboration_epoch_path(state, id)).await {
        Ok(value) => CollaborationMetadata::decode(&value).map_err(internal),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(CollaborationMetadata::default())
        }
        Err(error) => Err(internal(error)),
    }
}
async fn collaboration_epoch(state: &ServerState, id: &str) -> Result<u64, ApiError> {
    Ok(collaboration_metadata(state, id).await?.epoch)
}
async fn write_collaboration_metadata(
    state: &ServerState,
    id: &str,
    metadata: &CollaborationMetadata,
) -> Result<(), ApiError> {
    let path = collaboration_epoch_path(state, id);
    durable_collaboration_file(&path, metadata.encode().map_err(internal)?.as_bytes()).await
}
async fn durable_collaboration_file(path: &std::path::Path, bytes: &[u8]) -> Result<(), ApiError> {
    let directory = path
        .parent()
        .ok_or_else(|| internal("collaboration parent missing"))?;
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(internal)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = async {
        let mut file = tokio::fs::File::create(&temporary)
            .await
            .map_err(internal)?;
        file.write_all(bytes).await.map_err(internal)?;
        file.sync_all().await.map_err(internal)?;
        tokio::fs::rename(&temporary, path)
            .await
            .map_err(internal)?;
        sync_collaboration_directory(directory).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
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
    let metadata = collaboration_metadata(state, id).await?;
    if requested != metadata.epoch {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "collaboration generation changed; reload the editor".into(),
        ));
    }
    if headers
        .get("x-hcd-node-edits-version")
        .is_some_and(|value| {
            !matches!(
                value.to_str().ok(),
                Some("1" | "2" | "3" | "4" | "5" | "6" | "7")
            )
        })
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "unsupported collaboration node edit model".into(),
        ));
    }
    if metadata.node_edits.is_some_and(|required| {
        headers
            .get("x-hcd-node-edits-version")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u32>().ok())
            .is_none_or(|version| version < required)
    }) {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "node-edit-aware coordinator required; shared drafts were not changed".into(),
        ));
    }
    let protocol = headers
        .get("x-hcd-collaboration-protocol")
        .and_then(|value| value.to_str().ok());
    if (metadata.protocol != CollaborationProtocol::Default1 || protocol.is_some())
        && protocol != Some(metadata.protocol.name())
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "collaboration protocol changed; reload a compatible editor".into(),
        ));
    }
    if metadata.protocol == CollaborationProtocol::Inline1 {
        require_inline_containers_support(true, headers)?;
        if headers
            .get("x-hcd-extension-version")
            .and_then(|value| value.to_str().ok())
            != Some("3")
        {
            return Err(ApiError(
                StatusCode::UPGRADE_REQUIRED,
                "inline collaboration envelope 3 required".into(),
            ));
        }
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
    let metadata = collaboration_metadata(state, id).await?;
    let previous_state = collaboration_current_path(state, id, metadata.epoch).await?;
    match tokio::fs::read(&previous_state).await {
        Ok(bytes) => {
            save_collaboration_recovery(state, id, metadata.epoch, &bytes).await?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(internal(error)),
    }
    let next = metadata
        .reset()
        .ok_or_else(|| internal("collaboration epoch limit reached"))?;
    write_collaboration_metadata(state, id, &next).await?;
    let next = next.epoch;
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

fn migration_response(metadata: &CollaborationMetadata, replayed: bool) -> Json<Value> {
    Json(
        json!({"collaborationEpoch":metadata.epoch,"collaborationProtocol":metadata.protocol,"migration":metadata.migration,"idempotentReplay":replayed}),
    )
}

/// The trusted sidecar must quiesce its old room before calling this CAS. This
/// endpoint does not parse Yjs or declare an in-memory room migration complete.
async fn collaboration_migrate(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>, ApiError> {
    let _authority = access_policy::gate(&state.root, &id).write_owned().await;
    let claims = authorize_claims(&state, &headers, &id)?;
    require_story_link_editor_safe(&open(&state, &id)?.manifest().map_err(hcd_error)?)?;
    if !collaboration_service(&claims)
        || headers
            .get("x-hcd-coordinator-version")
            .and_then(|value| value.to_str().ok())
            != Some("4")
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "migration requires the collaboration coordinator".into(),
        ));
    }
    let target = match headers
        .get("x-hcd-target-protocol")
        .and_then(|value| value.to_str().ok())
    {
        Some("hcd-semantic-blocks/3") => CollaborationProtocol::Structure3,
        Some("hcd-semantic-inline/1") => CollaborationProtocol::Inline1,
        _ => return Err(bad("unsupported target collaboration protocol")),
    };
    if target == CollaborationProtocol::Inline1 {
        require_inline_containers_support(true, &headers)?;
        if headers
            .get("x-hcd-extension-version")
            .and_then(|value| value.to_str().ok())
            != Some("3")
            || headers
                .get("x-hcd-node-edits-version")
                .and_then(|value| value.to_str().ok())
                != Some("7")
        {
            return Err(ApiError(
                StatusCode::UPGRADE_REQUIRED,
                "inline bootstrap model acknowledgement required".into(),
            ));
        }
        if state.remote.is_some() {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "inline bootstrap requires the local coordinator".into(),
            ));
        }
    }
    if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
        return Err(bad("migration state must be 1-8 MiB"));
    }
    let hex = |value: &str, size| {
        value.len() == size
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    let field = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let request = MigrationReceipt {
        id: field("x-hcd-migration-id")
            .filter(|value| hex(value, 32))
            .ok_or_else(|| bad("X-HCD-Migration-Id required"))?
            .into(),
        from_epoch: requested_collaboration_epoch(&headers)?,
        source_hash: field("x-hcd-state-hash")
            .filter(|value| *value == "none" || hex(value, 64))
            .ok_or_else(|| bad("X-HCD-State-Hash required"))?
            .into(),
        base_revision: field("x-hcd-base-revision")
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| bad("X-HCD-Base-Revision required"))?,
        state_hash: hash_bytes(&bytes),
    };
    let _guard = state.collaboration_lock.lock().await;
    open(&state, &id)?;
    if field("x-hcd-collaboration-protocol")
        .is_some_and(|value| value != CollaborationProtocol::Default1.name())
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "migration requires the legacy source protocol".into(),
        ));
    }
    if let Some(remote) = &state.remote {
        use crate::hdoc_remote::MigrationResult;
        return match remote
            .collaboration_migrate(&id, &request, &bytes)
            .await
            .map_err(internal)?
        {
            MigrationResult::Saved(metadata, replayed) => {
                Ok(migration_response(&metadata, replayed))
            }
            MigrationResult::SourceChanged => Err(ApiError(
                StatusCode::PRECONDITION_FAILED,
                "migration source state changed".into(),
            )),
            MigrationResult::HeadChanged => Err(ApiError(
                StatusCode::CONFLICT,
                "migration canonical head changed".into(),
            )),
            MigrationResult::SessionChanged => Err(ApiError(
                StatusCode::CONFLICT,
                "migration session or request changed".into(),
            )),
        };
    }
    let metadata = collaboration_metadata(&state, &id).await?;
    if metadata
        .migration
        .as_ref()
        .is_some_and(|receipt| receipt.id == request.id)
    {
        if metadata.migration.as_ref() != Some(&request) || metadata.protocol != target {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "migration request ID reused with different contents".into(),
            ));
        }
        return Ok(migration_response(&metadata, true));
    }
    check_collaboration_epoch(&state, &id, &headers).await?;
    if metadata.protocol != CollaborationProtocol::Default1 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "collaboration protocol already migrated".into(),
        ));
    }
    let bundle = open(&state, &id)?;
    if bundle.manifest().map_err(internal)?.revision != request.base_revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "migration canonical head changed".into(),
        ));
    }
    let previous =
        match tokio::fs::read(collaboration_current_path(&state, &id, metadata.epoch).await?).await
        {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(internal(error)),
        };
    let actual = previous
        .as_ref()
        .map(|bytes| hash_bytes(bytes))
        .unwrap_or_else(|| "none".into());
    if actual != request.source_hash {
        return Err(ApiError(
            StatusCode::PRECONDITION_FAILED,
            "migration source state changed".into(),
        ));
    }
    if target == CollaborationProtocol::Inline1 {
        let head = bundle.manifest().map_err(internal)?;
        if request.source_hash != "none" || previous.is_some() {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "inline initialization cannot replace an existing collaboration state".into(),
            ));
        }
        if head.capabilities.extension_nodes != Some(3)
            || hcd_core::read_flow_document_layout(&bundle, &head)
                .map_err(hcd_error)?
                .is_some()
        {
            return Err(ApiError(StatusCode::UPGRADE_REQUIRED, "inline initialization requires an explicit non-regional canonical model 3 document".into()));
        }
    }
    let next = CollaborationMetadata {
        epoch: metadata
            .epoch
            .checked_add(1)
            .ok_or_else(|| internal("collaboration epoch limit reached"))?,
        protocol: target,
        node_edits: if target == CollaborationProtocol::Inline1 {
            Some(7)
        } else {
            metadata.node_edits
        },
        migration: Some(request.clone()),
    };
    if let Some(previous) = previous {
        save_collaboration_recovery(&state, &id, metadata.epoch, &previous).await?;
    }
    // An unpublished state uses an owner-specific filename. If publication
    // fails, a later reset must never adopt that orphan as its legacy state.
    let destination = state
        .root
        .join("collaboration")
        .join(format!("{id}.epoch-{}.{}.bin", next.epoch, request.id));
    durable_collaboration_file(&destination, &bytes).await?;
    write_collaboration_metadata(&state, &id, &next).await?;
    Ok(migration_response(&next, false))
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
    if matches!(
        collaboration_metadata(&state, &id).await?.protocol,
        CollaborationProtocol::WordRegions1 | CollaborationProtocol::WordRegions2
    ) {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "regional room persistence requires its private checkpoint journal".into(),
        ));
    }
    if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
        return Err(bad("collaboration state must be 1-8 MiB"));
    }
    let node_edits = headers
        .get("x-hcd-node-edits-version")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u32>().ok());
    if let Some(remote) = &state.remote {
        match remote
            .collaboration_put(&id, epoch, expected_hash, &bytes, node_edits)
            .await
            .map_err(internal)?
        {
            crate::hdoc_remote::CollaborationPut::EpochChanged => {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "collaboration generation changed; reload the editor".to_string(),
                ));
            }
            crate::hdoc_remote::CollaborationPut::StateChanged => {
                return Err(ApiError(
                    StatusCode::PRECONDITION_FAILED,
                    "collaboration state changed in another owner".into(),
                ));
            }
            crate::hdoc_remote::CollaborationPut::ModelRequired => {
                return Err(ApiError(
                    StatusCode::UPGRADE_REQUIRED,
                    "node-edit-aware coordinator required".into(),
                ));
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
    if let Some(version) = node_edits {
        let mut metadata = collaboration_metadata(&state, &id).await?;
        if metadata.node_edits.is_none_or(|current| current < version) {
            metadata.node_edits = Some(version);
            write_collaboration_metadata(&state, &id, &metadata).await?;
        }
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
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    let (manifest, _) = manifest_at_revision(&bundle, &head, query.revision).map_err(bad)?;
    Ok(Json(serde_json::to_value(manifest).map_err(internal)?))
}

/// Small, non-cacheable head check for actions that must not mistake a
/// delayed revision event for the current saved document.
async fn document_head(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let head = open(&state, &id)?.manifest().map_err(internal)?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(json!({
            "documentId": head.document_id, "revision": head.revision, "sourceSha256": head.source.sha256
        })),
    ))
}

/// Bounded layout metadata only. Navigation must not load the full editor
/// projection merely to discover Word sections and shared story bindings.
async fn word_layout(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(hcd_error)?;
    let (manifest, revision) =
        manifest_at_revision(&bundle, &head, query.revision).map_err(hcd_error)?;
    let layout = hcd_core::read_flow_document_layout(&bundle, &manifest).map_err(hcd_error)?;
    require_flow_layout_support(layout.as_ref().map(flow_layout_protocol), &headers)?;
    let layout_hash = layout
        .as_ref()
        .map(hcd_core::flow_layout_hash)
        .transpose()
        .map_err(hcd_error)?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(json!({"revision":revision,"layout":layout,"layoutHash":layout_hash})),
    )
        .into_response())
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

async fn xlsx_formula_audit(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let source = state.root.join("sources").join(format!("{id}.xlsx"));
    let outcome = tokio::task::spawn_blocking(move || {
        let snapshot = hcd_core::create_portable_snapshot(&bundle, query.revision)?;
        if snapshot.manifest.source.format != "xlsx" {
            return Err(HcdError::Unsupported(
                "XLSX formula audit requires a workbook".into(),
            ));
        }
        if !source.try_exists()? {
            return Err(HcdError::InvalidPatch("XLSX_SOURCE_MISSING".into()));
        }
        let frozen = Bundle::open(snapshot.directory.path())?;
        let count = hcd_formats::audit_xlsx_editable_formula_map(&frozen, &source)?;
        Ok((snapshot.manifest.revision, count))
    })
    .await
    .map_err(internal)?;
    authorize(&state, &headers, &id, false)?;
    let result = outcome.map_err(|error: HcdError| match error {
        HcdError::InvalidPatch(reason) if reason.starts_with("XLSX_MERGED_CELL_READ_ONLY") => {
            ApiError(
                StatusCode::UNPROCESSABLE_ENTITY,
                "XLSX_MERGED_CELL_READ_ONLY".into(),
            )
        }
        HcdError::InvalidPatch(reason) if reason == "XLSX_SHEET_PROTECTED" => {
            ApiError(StatusCode::UNPROCESSABLE_ENTITY, reason)
        }
        HcdError::InvalidPatch(reason) if reason.starts_with("XLSX_FORMULA_READ_ONLY") => ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "XLSX_FORMULA_READ_ONLY".into(),
        ),
        HcdError::InvalidPatch(reason) if reason == "XLSX_SOURCE_CHANGED" => {
            ApiError(StatusCode::UNPROCESSABLE_ENTITY, reason)
        }
        HcdError::InvalidPatch(reason) if reason == "XLSX_SOURCE_MISSING" => {
            ApiError(StatusCode::NOT_FOUND, "XLSX_SOURCE_MISSING".into())
        }
        other => hcd_error(other),
    })?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(json!({"revision":result.0,"editableCellsChecked":result.1,"sourceFreeEditsAuthorized":false})),
    ).into_response())
}

/// Restore only the exact imported source. Existing files are never replaced;
/// a competing identical restore is idempotent and a conflicting one fails.
async fn xlsx_restore_source(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<Value>, ApiError> {
    restore_imported_source(state, id, headers, body, "xlsx").await
}

async fn word_restore_source(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<Value>, ApiError> {
    restore_imported_source(state, id, headers, body, "docx").await
}

async fn word_source_status(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let manifest = open(&state, &id)?.manifest().map_err(internal)?;
    if manifest.source.format != "docx" {
        return Err(bad("Word source status requires a DOCX"));
    }
    if state.remote.is_some() {
        return Ok((
            [(header::CACHE_CONTROL, "private, no-store")],
            Json(json!({"status":"unavailable"})),
        ));
    }
    let path = state.root.join("sources").join(format!("{id}.docx"));
    let source = manifest.source;
    let status = tokio::task::spawn_blocking(move || match std::fs::metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("missing"),
        Err(error) => Err(error),
        Ok(metadata)
            if !metadata.is_file()
                || metadata.len() != source.size_bytes
                || metadata.len() > 256 * 1024 * 1024 =>
        {
            Ok("invalid")
        }
        Ok(_) => hash_file(&path)
            .map(|hash| {
                if hash == source.sha256 {
                    "present"
                } else {
                    "invalid"
                }
            })
            .map_err(|error| std::io::Error::other(error.to_string())),
    })
    .await
    .map_err(internal)?
    .map_err(internal)?;
    let source_free_protected = if status == "missing" {
        let bundle = open(&state, &id)?;
        let root = state.root.clone();
        let secret = state.secret.clone();
        tokio::task::spawn_blocking(move || {
            word_source_proof::read(&bundle, &root, &secret)
                .ok()
                .flatten()
                .is_some()
        })
        .await
        .map_err(internal)?
    } else {
        false
    };
    authorize(&state, &headers, &id, false)?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(json!({"status":status,"sourceFreeProtected":source_free_protected})),
    ))
}

async fn restore_imported_source(
    state: ServerState,
    id: String,
    headers: HeaderMap,
    body: Body,
    format: &'static str,
) -> Result<Json<Value>, ApiError> {
    use sha2::{Digest, Sha256};
    use std::sync::OnceLock;
    static UPLOADS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    authorize(&state, &headers, &id, true)?;
    if state.remote.is_some() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            format!(
                "{} source restore requires shared source storage",
                format.to_uppercase()
            ),
        ));
    }
    let bundle = open(&state, &id)?;
    let initial = bundle.manifest().map_err(internal)?;
    if initial.source.format != format {
        return Err(bad("source format does not match the document"));
    }
    if initial.source.size_bytes == 0 || initial.source.size_bytes > 256 * 1024 * 1024 {
        return Err(bad("source size exceeds limit"));
    }
    let _slot = UPLOADS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "too many source uploads".into(),
            )
        })?;
    let directory = state.root.join("sources");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(internal)?;
    let temp = tempfile::Builder::new()
        .prefix(".hcd-source-")
        .tempfile_in(&directory)
        .map_err(internal)?;
    let mut output = tokio::fs::File::from_std(temp.reopen().map_err(internal)?);
    let mut stream = body.into_data_stream();
    let mut size = 0u64;
    let mut digest = Sha256::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(300);
    while let Some(chunk) = tokio::time::timeout_at(deadline, stream.next())
        .await
        .map_err(|_| {
            ApiError(
                StatusCode::REQUEST_TIMEOUT,
                "source upload timed out".into(),
            )
        })?
    {
        let chunk = chunk.map_err(bad)?;
        size = size
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| bad("source size overflow"))?;
        if size > initial.source.size_bytes {
            return Err(ApiError(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("{}_SOURCE_CHANGED", format.to_uppercase()),
            ));
        }
        digest.update(&chunk);
        output.write_all(&chunk).await.map_err(internal)?;
    }
    output.sync_all().await.map_err(internal)?;
    drop(output);
    if size != initial.source.size_bytes
        || format!("{:x}", digest.finalize()) != initial.source.sha256
    {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("{}_SOURCE_CHANGED", format.to_uppercase()),
        ));
    }
    authorize(&state, &headers, &id, true)?;
    let latest = bundle.manifest().map_err(internal)?;
    if latest.source != initial.source {
        return Err(ApiError(
            StatusCode::CONFLICT,
            format!("{}_SOURCE_IDENTITY_CHANGED", format.to_uppercase()),
        ));
    }
    let target = directory.join(format!("{id}.{format}"));
    let already_present = match temp.persist_noclobber(&target) {
        Ok(_) => false,
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            let expected_hash = initial.source.sha256.clone();
            let existing = target.clone();
            let valid = tokio::task::spawn_blocking(move || {
                std::fs::metadata(&existing)
                    .is_ok_and(|metadata| metadata.is_file() && metadata.len() == size)
                    && hash_file(&existing).is_ok_and(|hash| hash == expected_hash)
            })
            .await
            .map_err(internal)?;
            if !valid {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    format!("{}_SOURCE_CONFLICT", format.to_uppercase()),
                ));
            }
            true
        }
        Err(error) => return Err(internal(error.error)),
    };
    Ok(Json(
        json!({"revision":latest.revision,"sourceRestored":true,"alreadyPresent":already_present}),
    ))
}

/// Create a local proof only after the exact saved revision and retained
/// source have been independently audited. Never accept a proof from a client.
async fn xlsx_formula_proof_create(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ExpectedRevision>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, true)?;
    if state.remote.is_some() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "XLSX proof storage is not shared across hosts".into(),
        ));
    }
    let bundle = open(&state, &id)?;
    if bundle.manifest().map_err(internal)?.revision != request.expected_revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "XLSX_AUDIT_REVISION_CHANGED".into(),
        ));
    }
    let source = state.root.join("sources").join(format!("{id}.xlsx"));
    if !source.is_file() {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "XLSX_SOURCE_MISSING".into(),
        ));
    }
    let root = state.root.clone();
    let secret = state.secret.clone();
    let checked = bundle.clone();
    let count = tokio::task::spawn_blocking(move || {
        xlsx_formula_proof::create(&checked, &source, &root, &secret, request.expected_revision)
    })
    .await
    .map_err(internal)?
    .map_err(|error| match error {
        HcdError::InvalidPatch(reason) if reason.starts_with("XLSX_MERGED_CELL_READ_ONLY") => {
            ApiError(
                StatusCode::UNPROCESSABLE_ENTITY,
                "XLSX_MERGED_CELL_READ_ONLY".into(),
            )
        }
        HcdError::InvalidPatch(reason) if reason == "XLSX_SHEET_PROTECTED" => {
            ApiError(StatusCode::UNPROCESSABLE_ENTITY, reason)
        }
        HcdError::InvalidPatch(reason) if reason.starts_with("XLSX_FORMULA_READ_ONLY") => ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "XLSX_FORMULA_READ_ONLY".into(),
        ),
        HcdError::InvalidPatch(reason) if reason == "XLSX_SOURCE_CHANGED" => {
            ApiError(StatusCode::UNPROCESSABLE_ENTITY, reason)
        }
        other => hcd_error(other),
    })?;
    authorize(&state, &headers, &id, true)?;
    if bundle.manifest().map_err(internal)?.revision != request.expected_revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "XLSX_AUDIT_REVISION_CHANGED".into(),
        ));
    }
    Ok(Json(
        json!({"revision":request.expected_revision,"editableCellsChecked":count,"sourceFreeEditsAuthorized":true,"scope":"this-server"}),
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
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    let current_story_head = head.capabilities.word_layout_edits == Some(3)
        && query
            .revision
            .is_none_or(|revision| revision >= head.revision);
    if !current_story_head
        && query
            .revision
            .is_none_or(|revision| revision >= head.revision)
    {
        require_story_link_editor_safe(&head)?;
    }
    // Pin the implicit head to the revision whose capabilities were checked.
    // A concurrent commit must not turn this into a different projection.
    let revision = query.revision.or(Some(head.revision));
    let layout_aware_head = head.capabilities.word_layout_edits.is_some()
        && query
            .revision
            .is_none_or(|revision| revision >= head.revision);
    // Only a fenced layout-aware coordinator can read the current projection
    // after a layout revision. Legacy clients retain their existing history
    // reads, but cannot mistake the new head for a writable old-model room.
    let _guard = if layout_aware_head {
        Some(state.collaboration_lock.lock().await)
    } else {
        None
    };
    let _owner = if layout_aware_head {
        let claims = claims(&state, &headers, &id)?;
        let coordinator = headers
            .get("x-hcd-coordinator-version")
            .and_then(|v| v.to_str().ok());
        let story_aware = current_story_head
            && coordinator == Some("7")
            && headers
                .get("x-hcd-word-story-version")
                .and_then(|v| v.to_str().ok())
                == Some("1");
        if claims.sub.as_deref() != Some("hcd-collaboration")
            || !(story_aware || !current_story_head && coordinator == Some("6"))
            || headers
                .get("x-hcd-word-layout-version")
                .and_then(|v| v.to_str().ok())
                != Some("1")
        {
            return Err(ApiError(
                StatusCode::UPGRADE_REQUIRED,
                "layout-aware Word coordinator required".into(),
            ));
        }
        require_write(&state, &id, &claims)?;
        let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
        if collaboration_metadata(&state, &id).await?.protocol
            != CollaborationProtocol::WordRegions2
        {
            return Err(ApiError(
                StatusCode::UPGRADE_REQUIRED,
                "layout-aware Word room required".into(),
            ));
        }
        Some(
            if headers
                .get("x-hcd-word-bootstrap")
                .and_then(|v| v.to_str().ok())
                == Some("1")
            {
                state.word_owners.guard_bootstrap(&id, epoch, &headers)?
            } else {
                state.word_owners.guard(&id, epoch, &headers)?
            },
        )
    } else {
        None
    };
    require_inline_containers_support(
        bundle
            .manifest()
            .map_err(internal)?
            .capabilities
            .extension_nodes
            == Some(3),
        &headers,
    )?;
    require_custom_marks_support(
        bundle
            .manifest()
            .map_err(internal)?
            .capabilities
            .custom_marks
            .is_some(),
        &headers,
    )?;
    let projection = editor_projection(&bundle, revision).map_err(bad)?;
    require_flow_layout_support(
        projection.flow_layout.as_ref().map(flow_layout_protocol),
        &headers,
    )?;
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
    if hcd_core::read_flow_document_layout(&bundle, &bundle.manifest().map_err(internal)?)
        .map_err(hcd_error)?
        .is_some()
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "region-aware structural protocol required; no content was saved".into(),
        ));
    }
    let result = project_editor(&bundle, request.expected_revision).map_err(hcd_error)?;
    publish_mutation(&state, &id, &bundle, request.expected_revision).await?;
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}

async fn patch(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(mut patch): Json<StructurePatchBatch>,
) -> Result<Json<Value>, ApiError> {
    let identity = authorize_claims(&state, &headers, &id)?;
    patch.actor = author_actor(&identity, &[]);
    if patch.document_id != id {
        return Err(bad("patch document ID mismatch"));
    }
    let bundle = open(&state, &id)?;
    if hcd_core::read_flow_document_layout(&bundle, &bundle.manifest().map_err(internal)?)
        .map_err(hcd_error)?
        .is_some()
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "region-aware structural protocol required; no content was saved".into(),
        ));
    }
    let existing_extensions = hcd_core::projection_extensions(
        &hcd_core::editor_projection(&bundle, None).map_err(hcd_error)?,
    )
    .map_err(hcd_error)?;
    let mut custom_marks = bundle
        .manifest()
        .map_err(internal)?
        .capabilities
        .custom_marks
        .is_some();
    let mut proposed_extensions = Vec::new();
    for operation in &patch.operations {
        if let StructureOperation::Insert { block, .. }
        | StructureOperation::Replace { block, .. } = operation
        {
            custom_marks |= hcd_core::content_custom_marks(block).map_err(hcd_error)?;
            proposed_extensions.extend(hcd_core::content_extensions(block).map_err(hcd_error)?);
        }
    }
    require_custom_marks_support(custom_marks, &headers)?;
    let required_extension = existing_extensions
        .iter()
        .chain(&proposed_extensions)
        .map(|n| n.envelope_version())
        .max()
        .unwrap_or(0);
    if required_extension > 0
        && headers
            .get("x-hcd-extension-version")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u32>().ok())
            .is_none_or(|v| ![1, 2, 3].contains(&v) || v < required_extension)
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "extension-aware client required; no content was saved".into(),
        ));
    }
    require_inline_containers_support(required_extension == 3, &headers)?;
    let before = hcd_core::document_references(&bundle, None).map_err(hcd_error)?;
    let mut after = Vec::new();
    if !before.is_empty()
        && headers
            .get("x-hcd-reference-version")
            .and_then(|v| v.to_str().ok())
            != Some("1")
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "reference-aware patch client required".into(),
        ));
    }
    for operation in &patch.operations {
        if let StructureOperation::Insert { block, .. }
        | StructureOperation::Replace { block, .. } = operation
        {
            after.extend(hcd_core::content_references("", block).map_err(hcd_error)?);
        }
    }
    if !after.is_empty() {
        let identity = claims(&state, &headers, &id)?;
        let actor = identity
            .sub
            .as_deref()
            .ok_or_else(|| bad("reference writes require a stable actor"))?;
        people::validate_targets(&state, &id, actor, &before, &after)?;
    }
    let head = bundle.manifest().map_err(internal)?;
    if patch.base_revision == head.revision
        && patch.operations.iter().any(|operation| {
            matches!(
                operation,
                StructureOperation::Delete { .. }
                    | StructureOperation::Move { .. }
                    | StructureOperation::Replace { .. }
            )
        })
    {
        let protected = legacy_word_protected_nodes(&state, &id, &bundle, &head).await?;
        if !protected.is_empty() {
            let current = editor_projection(&bundle, None).map_err(hcd_error)?;
            let protected_blocks: HashSet<_> = current
                .blocks
                .iter()
                .filter(|block| {
                    snapshot_source_inlines(&block.content)
                        .iter()
                        .any(|inline| {
                            inline
                                .node_id
                                .as_ref()
                                .is_some_and(|node| protected.contains(node))
                        })
                })
                .map(|block| block.block_id.as_str())
                .collect();
            if patch.operations.iter().any(|operation| match operation {
                StructureOperation::Delete { block_id, .. }
                | StructureOperation::Move { block_id, .. }
                | StructureOperation::Replace { block_id, .. } => {
                    protected_blocks.contains(block_id.as_str())
                }
                _ => false,
            }) {
                return Err(ApiError(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "DOCX_SOURCE_TEXT_READ_ONLY".into(),
                ));
            }
        }
    }
    let result = apply_structure_patch(&bundle, &patch, patch.base_revision).map_err(hcd_error)?;
    if !result.idempotent_replay {
        publish_mutation(&state, &id, &bundle, patch.base_revision).await?;
        reset_collaboration(&state, &id).await?;
    }
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}

fn require_custom_marks_support(required: bool, headers: &HeaderMap) -> Result<(), ApiError> {
    let version = headers
        .get("x-hcd-custom-marks-version")
        .and_then(|value| value.to_str().ok());
    if version.is_some_and(|v| v != "1") || required && version != Some("1") {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "custom-text-mark-aware client required; no content was saved".into(),
        ));
    }
    Ok(())
}

fn flow_layout_protocol(layout: &hcd_core::FlowDocumentLayout) -> u32 {
    if layout.schema_version == hcd_core::FLOW_REGION_LAYOUT_SCHEMA {
        2
    } else {
        1
    }
}

// Layout-only revisions need a new coordinated room protocol. A legacy room
// cannot adopt the new fence or preserve its pending edits safely, even if it
// happens to supply the older flow-layout/2 header. Keep recovery and export
// reads available until that protocol is implemented.
fn require_legacy_word_layout_safe(manifest: &hcd_core::HcdManifest) -> Result<(), ApiError> {
    if manifest.capabilities.word_layout_edits.is_some() {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "Word layout revision requires a coordinated layout-aware editor; no content was saved"
                .into(),
        ));
    }
    Ok(())
}

fn require_story_link_editor_safe(manifest: &hcd_core::HcdManifest) -> Result<(), ApiError> {
    if matches!(manifest.capabilities.word_layout_edits, Some(2 | 3)) {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "Word story link history requires a newer collaboration protocol; no content was saved"
                .into(),
        ));
    }
    Ok(())
}

async fn require_legacy_word_room_safe(state: &ServerState, id: &str) -> Result<(), ApiError> {
    if collaboration_metadata(state, id).await?.protocol == CollaborationProtocol::WordRegions2 {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "layout-aware Word coordinator required; no content was saved".into(),
        ));
    }
    Ok(())
}

fn require_flow_layout_support(required: Option<u32>, headers: &HeaderMap) -> Result<(), ApiError> {
    let version = headers
        .get("x-hcd-flow-layout-version")
        .and_then(|value| value.to_str().ok());
    if version.is_some_and(|value| !["1", "2"].contains(&value))
        || required.is_some_and(|required| version != Some(if required == 2 { "2" } else { "1" }))
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "section/story-aware client required; no content was saved".into(),
        ));
    }
    Ok(())
}

fn require_inline_containers_support(required: bool, headers: &HeaderMap) -> Result<(), ApiError> {
    let version = headers
        .get("x-hcd-inline-containers-version")
        .and_then(|value| value.to_str().ok());
    if version.is_some_and(|value| value != "1") || required && version != Some("1") {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "editable-inline-container-aware client required; no content was saved".into(),
        ));
    }
    Ok(())
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
    #[serde(default)]
    reference_authors: Vec<ReferenceAuthor>,
    #[serde(default)]
    reference_version: Option<u32>,
    #[serde(default)]
    extension_version: Option<u32>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReferenceAuthor {
    mention_id: String,
    user_id: String,
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

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Contributor {
    user_id: String,
    display_name: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotBlock {
    block_id: Option<String>,
    content: EditorBlockContent,
}

fn normalized(content: EditorBlockContent) -> EditorBlockContent {
    normalize_content(content, false)
}

fn normalize_content(mut content: EditorBlockContent, retain_sources: bool) -> EditorBlockContent {
    let mut inlines: Vec<EditorInline> = Vec::new();
    for mut inline in content.inlines {
        if let Some(body) = inline.content.take() {
            inline.content = Some(Box::new(normalize_content(*body, retain_sources)));
        }
        if !retain_sources {
            inline.node_id = None;
        }
        if inline
            .typography
            .as_ref()
            .is_some_and(|font| font.is_empty())
        {
            inline.typography = None;
        }
        if inline.text.is_empty() && inline.content.is_none() {
            continue;
        }
        if let Some(previous) = inlines.last_mut() {
            if (!retain_sources || previous.node_id == inline.node_id)
                && previous.custom_marks == inline.custom_marks
                && previous.bold == inline.bold
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
                && previous.extension.is_none()
                && inline.extension.is_none()
                && previous.reference.is_none()
                && inline.reference.is_none()
                && previous.content.is_none()
                && inline.content.is_none()
            {
                previous.text.push_str(&inline.text);
                continue;
            }
        }
        inlines.push(inline);
    }
    content.inlines = inlines;
    content.children = content
        .children
        .into_iter()
        .map(|child| normalize_content(child, retain_sources))
        .collect();
    content
}

fn snapshot_source_inlines(content: &EditorBlockContent) -> Vec<&EditorInline> {
    fn visit<'a>(content: &'a EditorBlockContent, output: &mut Vec<&'a EditorInline>) {
        for inline in &content.inlines {
            output.push(inline);
            if let Some(body) = &inline.content {
                visit(body, output);
            }
        }
        for child in &content.children {
            visit(child, output);
        }
    }
    let mut output = Vec::new();
    visit(content, &mut output);
    output
}

fn validate_legacy_word_snapshot(
    current: &EditorProjection,
    requested: &[SnapshotBlock],
    protected: &HashSet<String>,
) -> Result<(), ApiError> {
    for block in editor_surface(current) {
        if !snapshot_source_inlines(&block.content)
            .iter()
            .any(|inline| {
                inline
                    .node_id
                    .as_ref()
                    .is_some_and(|id| protected.contains(id))
            })
        {
            continue;
        }
        let mut matching = requested
            .iter()
            .filter(|candidate| candidate.block_id.as_deref() == Some(block.block_id.as_str()));
        let preserved = matching.next().is_some_and(|candidate| {
            normalized(candidate.content.clone()) == normalized(block.content.clone())
        }) && matching.next().is_none();
        if !preserved {
            return Err(ApiError(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("DOCX_SOURCE_TEXT_READ_ONLY:{}", block.block_id),
            ));
        }
    }
    Ok(())
}

async fn legacy_word_protected_nodes(
    state: &ServerState,
    id: &str,
    bundle: &Bundle,
    manifest: &hcd_core::HcdManifest,
) -> Result<HashSet<String>, ApiError> {
    if manifest.source.format != "docx" || manifest.capabilities.flow_layout.is_some() {
        return Ok(HashSet::new());
    }
    let source = state.root.join("sources").join(format!("{id}.docx"));
    match std::fs::metadata(&source) {
        Ok(metadata) if metadata.is_file() => {
            let bundle = bundle.clone();
            let root = state.root.clone();
            let secret = state.secret.clone();
            let local = state.remote.is_none();
            tokio::task::spawn_blocking(move || {
                let protected = hcd_docx::legacy_read_only_nodes(&bundle, &source)?;
                // Failure to record a proof must not block a source-verified save.
                if local
                    && !matches!(word_source_proof::read(&bundle, &root, &secret), Ok(Some(existing)) if existing == protected)
                {
                    let _ = word_source_proof::create(&bundle, &source, &root, &secret);
                }
                Ok::<_, HcdError>(protected)
            })
            .await
            .map_err(internal)?
            .map_err(hcd_error)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if state.remote.is_none() {
                let bundle = bundle.clone();
                let root = state.root.clone();
                let secret = state.secret.clone();
                if let Some(protected) = tokio::task::spawn_blocking(move || {
                    word_source_proof::read(&bundle, &root, &secret)
                })
                .await
                .map_err(internal)?
                .map_err(hcd_error)?
                {
                    return Ok(protected);
                }
            }
            Err(ApiError(
                StatusCode::UNPROCESSABLE_ENTITY,
                "DOCX_SOURCE_REQUIRED".into(),
            ))
        }
        Ok(_) => Err(internal("DOCX source is not a file")),
        Err(error) => Err(internal(error)),
    }
}

/// Source ownership may move only out of roots changed by this snapshot. An
/// existing owner keeps a shared split ID; otherwise the first target keeps it.
/// All other fragments receive fresh IDs, and native apply validates the same
/// changed-root scope and final global uniqueness before publication.
fn snapshot_source_plans(
    current: &EditorProjection,
    requested: &[SnapshotBlock],
) -> Result<HashMap<usize, EditorBlockContent>, HcdError> {
    let originals: HashMap<_, _> = current
        .blocks
        .iter()
        .filter(|block| block.region == "body")
        .map(|block| (block.block_id.as_str(), block))
        .collect();
    let retained: HashSet<_> = requested
        .iter()
        .filter_map(|block| block.block_id.as_deref())
        .filter(|id| originals.contains_key(id))
        .collect();
    let marginal_ids: HashSet<_> = current
        .blocks
        .iter()
        .filter(|block| marginal_region(&block.region))
        .map(|block| block.block_id.as_str())
        .collect();
    let indices: Vec<_> = requested
        .iter()
        .enumerate()
        .filter(|(_, block)| {
            if let Some(original) = block.block_id.as_deref().and_then(|id| originals.get(id)) {
                normalized(block.content.clone()) != normalized(original.content.clone())
            } else {
                !block
                    .block_id
                    .as_deref()
                    .is_some_and(|id| marginal_ids.contains(id))
            }
        })
        .map(|(index, _)| index)
        .collect();
    let changed: HashSet<_> = indices
        .iter()
        .filter_map(|index| requested[*index].block_id.as_deref())
        .filter(|id| originals.contains_key(id))
        .collect();
    let wanted: HashSet<_> = indices
        .iter()
        .flat_map(|index| {
            snapshot_source_inlines(&requested[*index].content)
                .into_iter()
                .filter_map(|inline| inline.node_id.clone())
        })
        .collect();
    let scope = hcd_core::ReplacementSources::capture(
        current
            .blocks
            .iter()
            .filter(|block| {
                block.region == "body"
                    && (!retained.contains(block.block_id.as_str())
                        || changed.contains(block.block_id.as_str()))
            })
            .map(|block| &block.content),
        &wanted,
    );
    let mut plans = HashMap::new();
    for index in &indices {
        plans.insert(
            *index,
            scope.retain(normalize_content(requested[*index].content.clone(), true))?,
        );
    }
    let mut owners = HashMap::new();
    for block in originals.values() {
        for inline in snapshot_source_inlines(&block.content) {
            if let Some(id) = &inline.node_id {
                owners.insert(id.as_str(), block.block_id.as_str());
            }
        }
    }
    let mut winners: HashMap<String, usize> = HashMap::new();
    for index in indices {
        for inline in snapshot_source_inlines(&plans[&index]) {
            if let Some(id) = &inline.node_id {
                if owners.get(id.as_str()).copied() == requested[index].block_id.as_deref() {
                    winners.insert(id.clone(), index);
                } else {
                    winners.entry(id.clone()).or_insert(index);
                }
            }
        }
    }
    fn clear_other(
        content: &mut EditorBlockContent,
        index: usize,
        winners: &HashMap<String, usize>,
    ) {
        for inline in &mut content.inlines {
            if let Some(body) = &mut inline.content {
                clear_other(body, index, winners);
            }
            if inline
                .node_id
                .as_ref()
                .is_some_and(|id| winners.get(id) != Some(&index))
            {
                inline.node_id = None;
            }
        }
        for child in &mut content.children {
            clear_other(child, index, winners);
        }
    }
    for (index, content) in &mut plans {
        clear_other(content, *index, &winners);
    }
    Ok(plans)
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
        || before.extension != after.extension
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
                || before.content != after.content
                || before.custom_marks != after.custom_marks
                || before.italic != after.italic
                || before.link != after.link
                || before.reference != after.reference
                || before.extension != after.extension
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
            if before.reference.is_some() || before.extension.is_some() {
                return None;
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
    // A block atom's fallback is not independently editable source text. Any
    // envelope change must take the complete structural replacement path.
    if before.extension.is_some() || after.extension.is_some() {
        return Ok(false);
    }
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
                && inline.reference.is_none()
                && inline.extension.is_none()
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
        if before
            .iter()
            .any(|inline| inline.reference.is_some() || inline.extension.is_some())
            && before != after
        {
            return Ok(false);
        }
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
            || desired.extension != original.content.extension
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
                || before.content != after.content
                || before.custom_marks != after.custom_marks
                || before.bold != after.bold
                || before.italic != after.italic
                || before.link != after.link
                || before.reference != after.reference
                || before.extension != after.extension
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
        if let Some(id) = claims
            .sub
            .clone()
            .filter(|id| access_policy::valid_subject(id))
        {
            let name = claims
                .name
                .clone()
                .filter(|name| valid_display_name(name))
                .unwrap_or_else(|| id.clone());
            people.push((id, name));
        }
    } else {
        for person in contributors.iter().take(16) {
            if !access_policy::valid_subject(&person.user_id)
                || !valid_display_name(&person.display_name)
            {
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
                .content
                .as_ref()
                .is_some_and(|body| has_typography(body))
                || inline
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
    let body = if !request.reference_authors.is_empty() {
        serde_json::to_vec(
            &json!({"blocks":request.blocks,"images":request.images,"referenceAuthors":request.reference_authors}),
        )
    } else if request.images.is_empty() {
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
    let access = load_access(&state, &id)?;
    if access.restricted()
        && (request.contributors.is_empty()
            || request
                .contributors
                .iter()
                .any(|person| !access.can_write(Some(&person.user_id))))
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "checkpoint contributors no longer have document write access".into(),
        ));
    }
    let checkpoint_id = coordinator_patch_id(&state, &id, epoch, &request)?;
    let mut actor = author_actor(&claims, &request.contributors);
    if !request.reference_authors.is_empty() {
        let authors: BTreeMap<_, _> = request
            .reference_authors
            .iter()
            .map(|entry| (entry.mention_id.clone(), entry.user_id.clone()))
            .collect();
        actor.insert(
            "referenceAuthors".into(),
            serde_json::to_string(&authors).map_err(internal)?,
        );
    }
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
    if hcd_core::read_flow_document_layout(&bundle, &head)
        .map_err(hcd_error)?
        .is_some()
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "region-aware coordinated snapshot required; no content was saved".into(),
        ));
    }
    let mut custom_marks = head.capabilities.custom_marks.is_some();
    let mut inline_containers = head.capabilities.extension_nodes == Some(3);
    for block in &request.blocks {
        custom_marks |= hcd_core::content_custom_marks(&block.content).map_err(hcd_error)?;
        inline_containers |= hcd_core::content_extensions(&block.content)
            .map_err(hcd_error)?
            .iter()
            .any(|node| node.envelope_version() == 3);
    }
    require_inline_containers_support(inline_containers, &headers)?;
    require_custom_marks_support(custom_marks, &headers)?;
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
    people::validate_snapshot(&state, &id, &current, &request)?;
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
    // Older imports did not mark field caches read-only. Authenticate the
    // retained original and check the whole snapshot before choosing either
    // the text or structural save path. Replays have already returned above.
    let protected = legacy_word_protected_nodes(&state, &id, &bundle, &head).await?;
    validate_legacy_word_snapshot(&current, &request.blocks, &protected)?;
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
    let mut operations = plan_snapshot_structure(&current, &request.blocks)?;
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

/// Shared structural planning for a complete semantic surface. Regional
/// callers provide one validated scope, never a body assembled across stories.
fn plan_snapshot_structure(
    current: &EditorProjection,
    requested: &[SnapshotBlock],
) -> Result<Vec<StructureOperation>, ApiError> {
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
    for block in requested {
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
    let source_plans = snapshot_source_plans(current, requested).map_err(hcd_error)?;
    let mut operations = Vec::new();
    let live: Vec<String> = current
        .blocks
        .iter()
        .filter(|block| block.region == "body" && desired_seen.contains(block.block_id.as_str()))
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
        }
    }
    // Plan reorders as a linked sequence. Repeated Vec::position would turn
    // a text edit in a large, otherwise unchanged document into quadratic work.
    let mut previous: HashMap<String, Option<String>> = live
        .iter()
        .enumerate()
        .map(|(index, id)| {
            (
                id.clone(),
                index.checked_sub(1).map(|index| live[index].clone()),
            )
        })
        .collect();
    let mut next: HashMap<String, Option<String>> = live
        .iter()
        .enumerate()
        .map(|(index, id)| (id.clone(), live.get(index + 1).cloned()))
        .collect();
    let mut first = live.first().cloned();
    for (target, block_id) in desired_known.iter().enumerate() {
        let anchor = target
            .checked_sub(1)
            .map(|index| desired_known[index].clone());
        let old_previous = previous
            .get(block_id)
            .ok_or_else(|| internal("snapshot retained block disappeared"))?
            .clone();
        if old_previous == anchor {
            continue;
        }
        let original = existing[block_id.as_str()];
        if original.read_only {
            return Err(bad("read-only block cannot move"));
        }
        operations.push(StructureOperation::Move {
            block_id: block_id.clone(),
            after_block_id: anchor.clone(),
            precondition: BlockPrecondition {
                block_hash: original.block_hash.clone(),
            },
        });
        let old_next = next[block_id].clone();
        if let Some(id) = &old_previous {
            next.insert(id.clone(), old_next.clone());
        } else {
            first = old_next.clone();
        }
        if let Some(id) = old_next {
            previous.insert(id, old_previous);
        }
        let following = if let Some(id) = &anchor {
            next[id].clone()
        } else {
            first.clone()
        };
        if let Some(id) = &anchor {
            next.insert(id.clone(), Some(block_id.clone()));
        } else {
            first = Some(block_id.clone());
        }
        if let Some(id) = &following {
            previous.insert(id.clone(), Some(block_id.clone()));
        }
        previous.insert(block_id.clone(), anchor);
        next.insert(block_id.clone(), following);
    }
    for (request_index, block) in requested.iter().enumerate() {
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
                block: source_plans
                    .get(&request_index)
                    .ok_or_else(|| internal("replacement source plan missing"))?
                    .clone(),
                precondition: BlockPrecondition {
                    block_hash: original.block_hash.clone(),
                },
            });
        }
    }
    for index in (0..requested.len()).rev() {
        let block = &requested[index];
        if block.block_id.as_ref().is_some_and(|value| {
            existing.contains_key(value.as_str()) || marginal.contains_key(value.as_str())
        }) {
            continue;
        }
        let previous = requested[..index].iter().rev().find_map(|value| {
            value
                .block_id
                .as_ref()
                .filter(|id| existing.contains_key(id.as_str()))
                .cloned()
        });
        operations.push(StructureOperation::Insert {
            after_block_id: previous,
            block: source_plans
                .get(&index)
                .ok_or_else(|| internal("insert source plan missing"))?
                .clone(),
        });
    }
    Ok(operations)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetExtensionQuery {
    extension: String,
}

use crate::hdoc_asset_mime::image_magic;

fn resource_stage_error(error: HcdError) -> ApiError {
    match error {
        HcdError::RevisionConflict(ref reason)
            if reason == "another local HCD mutation is already in progress" =>
        {
            ApiError(StatusCode::CONFLICT, "HCD_RESOURCE_BUSY".into())
        }
        other => hcd_error(other),
    }
}

async fn stage_resource(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<AssetExtensionQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, true)?;
    let extension = query.extension.to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "bin" | "png" | "jpg" | "jpeg" | "gif" | "webp"
    ) || body.is_empty()
        || body.len() > 8 * 1024 * 1024
        || extension != "bin" && !image_magic(&extension, &body)
    {
        return Err(bad("invalid resource type, size or image signature"));
    }
    let descriptor = open(&state, &id)?
        .stage_asset_from_reader(&extension, &mut std::io::Cursor::new(body.as_ref()))
        .map_err(resource_stage_error)?;
    Ok(Json(serde_json::to_value(descriptor).map_err(internal)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceReuseRequest {
    hash: String,
    extension: String,
    byte_length: u64,
}

async fn restage_resource(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ResourceReuseRequest>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, true)?;
    let bundle = open(&state, &id)?;
    let descriptor = tokio::task::spawn_blocking(move || {
        bundle.restage_existing_resource(
            &request.hash,
            &request.extension.to_ascii_lowercase(),
            request.byte_length,
        )
    })
    .await
    .map_err(internal)?
    .map_err(resource_stage_error)?
    .ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            "resource not found in this document".into(),
        )
    })?;
    authorize(&state, &headers, &id, true)?;
    Ok(Json(serde_json::to_value(descriptor).map_err(internal)?))
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
        .map_err(resource_stage_error)?;
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
    require_legacy_word_room_safe(&state, &id).await?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    require_legacy_word_layout_safe(&head)?;
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
    require_legacy_word_room_safe(&state, &id).await?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    require_legacy_word_layout_safe(&head)?;
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
    let bundle = open(&state, &id)?;
    require_flow_layout_support(
        hcd_core::read_flow_document_layout(&bundle, &bundle.manifest().map_err(internal)?)
            .map_err(hcd_error)?
            .as_ref()
            .map(flow_layout_protocol),
        &headers,
    )?;
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
    let bundle = open(&state, &id)?;
    require_flow_layout_support(
        hcd_core::read_flow_document_layout(&bundle, &bundle.manifest().map_err(internal)?)
            .map_err(hcd_error)?
            .as_ref()
            .map(flow_layout_protocol),
        &headers,
    )?;
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
    let text_ids: Vec<String> = text_ids.into_iter().cloned().collect();
    for (id, node) in
        hcd_core::get_text_node_receipts_in_manifest(bundle, &text_ids, &saved_manifest)
            .map_err(hcd_error)?
    {
        hashes.insert(id.clone(), json!(node.node_hash));
        formats.insert(id, json!(node.format_hash));
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
    require_legacy_word_room_safe(state, id).await?;
    let bundle = open(state, id)?;
    let previous = patch.base_revision;
    let manifest = bundle.manifest().map_err(internal)?;
    require_legacy_word_layout_safe(&manifest)?;
    let (base_manifest, _) =
        manifest_at_revision(&bundle, &manifest, Some(previous)).map_err(hcd_error)?;
    if previous == manifest.revision
        && patch.operations.iter().any(|operation| {
            matches!(
                operation,
                PatchOperation::TextSplice { .. }
                    | PatchOperation::TextRuns { .. }
                    | PatchOperation::NodeStyle { .. }
            )
        })
    {
        let protected = legacy_word_protected_nodes(state, id, &bundle, &manifest).await?;
        if patch
            .operations
            .iter()
            .filter_map(PatchOperation::node_id)
            .any(|node| protected.contains(node))
        {
            return Err(ApiError(
                StatusCode::UNPROCESSABLE_ENTITY,
                "DOCX_SOURCE_TEXT_READ_ONLY".into(),
            ));
        }
    }
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
    // Older XLSX projections may mark formula results editable. When the
    // original source is retained, verify its formula cells and ranges before
    // publishing a new version. The core still performs the final CAS under
    // its write lock; old-base requests must reach its idempotent replay path.
    if manifest.source.format == "xlsx" && previous == manifest.revision {
        let source = state.root.join("sources").join(format!("{id}.xlsx"));
        let source_present = match std::fs::metadata(&source) {
            Ok(metadata) if metadata.is_file() => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Ok(_) => return Err(internal("XLSX source is not a file")),
            Err(error) => return Err(internal(error)),
        };
        if source_present {
            let checked_bundle = bundle.clone();
            let operations = patch.operations.clone();
            tokio::task::spawn_blocking(move || {
                hcd_formats::validate_xlsx_source_text_edits(&checked_bundle, &source, &operations)
            })
            .await
            .map_err(internal)?
            .map_err(|error| match error {
                HcdError::InvalidPatch(reason)
                    if reason.starts_with("XLSX_MERGED_CELL_READ_ONLY") =>
                {
                    ApiError(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "XLSX_MERGED_CELL_READ_ONLY".into(),
                    )
                }
                HcdError::InvalidPatch(reason) if reason == "XLSX_SHEET_PROTECTED" => {
                    ApiError(StatusCode::UNPROCESSABLE_ENTITY, reason)
                }
                HcdError::InvalidPatch(reason) if reason.starts_with("XLSX_FORMULA_READ_ONLY") => {
                    ApiError(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "XLSX_FORMULA_READ_ONLY".into(),
                    )
                }
                HcdError::InvalidPatch(reason) if reason == "XLSX_SOURCE_CHANGED" => {
                    ApiError(StatusCode::UNPROCESSABLE_ENTITY, reason)
                }
                other => hcd_error(other),
            })?;
        } else if patch.operations.iter().any(|operation| {
            matches!(
                operation,
                PatchOperation::TextSplice { .. } | PatchOperation::TextRuns { .. }
            )
        }) {
            if state.remote.is_some() {
                return Err(ApiError(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "XLSX_FORMULA_PROOF_REQUIRED".into(),
                ));
            }
            let checked_bundle = bundle.clone();
            let root = state.root.clone();
            let secret = state.secret.clone();
            let verified = tokio::task::spawn_blocking(move || {
                xlsx_formula_proof::matches(&checked_bundle, &root, &secret)
            })
            .await
            .map_err(internal)?
            .unwrap_or(false);
            if !verified {
                return Err(ApiError(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "XLSX_FORMULA_PROOF_REQUIRED".into(),
                ));
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
    require_legacy_word_room_safe(&state, &id).await?;
    let accept = match request.action.as_str() {
        "accept" => true,
        "reject" => false,
        _ => return Err(bad("action must be accept or reject")),
    };
    let bundle = open(&state, &id)?;
    require_legacy_word_layout_safe(&bundle.manifest().map_err(internal)?)?;
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
    require_legacy_word_room_safe(&state, &id).await?;
    let bundle = open(&state, &id)?;
    require_legacy_word_layout_safe(&bundle.manifest().map_err(internal)?)?;
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
    require_write(state, id, &claims)?;
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
    if collaboration_metadata(&state, &id).await?.protocol != CollaborationProtocol::Default1 {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "restore requires the collaboration coordinator".into(),
        ));
    }
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexPageQuery {
    revision: Option<u64>,
    word_regions: Option<bool>,
    word_bodies: Option<bool>,
}

/// Locate stories without transferring the entire body index to the client.
async fn word_story_index(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(hcd_error)?;
    let (manifest, revision) =
        manifest_at_revision(&bundle, &head, query.revision).map_err(hcd_error)?;
    require_flow_layout_support(manifest.capabilities.flow_layout, &headers)?;
    let result = tokio::task::spawn_blocking(move || {
        if manifest.index_page_count != manifest.chunk_count.div_ceil(hcd_core::INDEX_PAGE_SIZE) {
            return Err(HcdError::InvalidBundle("invalid Word index page count".into()));
        }
        let catalog = hcd_core::WordRegionIndex::new(&bundle, &manifest)?;
        let mut stories = Vec::new();
        for page in 0..manifest.index_page_count {
            let index = bundle.read_index_page(&manifest, page)?;
            let start = page.checked_mul(hcd_core::INDEX_PAGE_SIZE)
                .ok_or_else(|| HcdError::InvalidBundle("invalid index page".into()))?;
            let expected = manifest.chunk_count.checked_sub(start)
                .ok_or_else(|| HcdError::InvalidBundle("invalid index count".into()))?
                .min(hcd_core::INDEX_PAGE_SIZE);
            if index.page != page || index.chunks.len() != expected
                || index.chunks.iter().enumerate().any(|(offset, chunk)| chunk.sequence != start + offset) {
                return Err(HcdError::InvalidBundle("invalid Word story index page".into()));
            }
            let regions = catalog.page(&index)?;
            for (chunk, region) in index.chunks.iter().zip(regions) {
                if ["header", "footer"].contains(&chunk.region.as_str()) && region.is_none() {
                    return Err(HcdError::InvalidBundle("missing Word story identity".into()));
                }
                if let Some(region) = region {
                    if stories.len() >= 65_536 {
                        return Err(HcdError::ResourceLimit("Word story index limit".into()));
                    }
                    stories.push(json!({"sequence":chunk.sequence,"region":chunk.region,"wordRegionId":region}));
                }
            }
        }
        Ok::<_, HcdError>(json!({"schemaVersion":"hcd-word-story-index/1","revision":revision,"chunkCount":manifest.chunk_count,"wordRegionsVerified":true,"stories":stories}))
    }).await.map_err(internal)?.map_err(hcd_error)?;
    Ok(([(header::CACHE_CONTROL, "private, no-store")], Json(result)).into_response())
}

async fn index_page(
    State(state): State<ServerState>,
    Path((id, page)): Path<(String, usize)>,
    Query(query): Query<IndexPageQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    let (manifest, _) = manifest_at_revision(&bundle, &head, query.revision).map_err(bad)?;
    let index = bundle.read_index_page(&manifest, page).map_err(bad)?;
    if query.word_regions != Some(true) {
        // A restore reuses the target's content-addressed index objects, which
        // carry the older stored revision stamp. Echo the resolved revision so
        // this route matches /chunks and clients can trust the page identity.
        let mut value = serde_json::to_value(index).map_err(internal)?;
        value["revision"] = serde_json::json!(manifest.revision);
        return Ok(Json(value));
    }
    let result = tokio::task::spawn_blocking(move || {
        let regions = if query.word_bodies == Some(true) {
            hcd_core::WordRegionIndex::new(&bundle, &manifest)?.page_all(&index)?
        } else {
            hcd_core::word_region_index_page(&bundle, &manifest, &index)?
        };
        let mut value = serde_json::to_value(index)?;
        value["revision"] = json!(manifest.revision);
        let chunks = value["chunks"]
            .as_array_mut()
            .ok_or_else(|| HcdError::InvalidBundle("invalid index".into()))?;
        for (chunk, region) in chunks.iter_mut().zip(regions) {
            if let Some(region) = region {
                chunk["wordRegionId"] = json!(region);
            }
        }
        value["wordRegionsVerified"] = json!(true);
        if query.word_bodies == Some(true) {
            value["wordBodiesVerified"] = json!(true);
        }
        Ok::<_, HcdError>(value)
    })
    .await
    .map_err(internal)?
    .map_err(hcd_error)?;
    Ok(Json(result))
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
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let mime = crate::hdoc_asset_mime::asset_mime(extension, &bytes)
        .parse::<axum::http::HeaderValue>()
        .map_err(internal)?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(header::CONTENT_TYPE, mime);
    response.headers_mut().insert(
        "x-content-type-options",
        "nosniff".parse().map_err(internal)?,
    );
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
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    let (manifest, _) = manifest_at_revision(&bundle, &head, query.revision).map_err(bad)?;
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
    let (selected, _) =
        manifest_at_revision(&bundle, &manifest, Some(revision)).map_err(hcd_error)?;
    let pdf_overlay_blocked =
        hcd_formats::pdf_has_unpainted_text(&bundle, revision).map_err(hcd_error)?;
    let flow_model = hcd_core::read_flow_document_layout(&bundle, &selected).map_err(hcd_error)?;
    let flow_layout = flow_model.is_some();
    let region_docx = flow_layout;
    let region_html = flow_model
        .as_ref()
        .is_some_and(|layout| layout.schema_version == hcd_core::FLOW_REGION_LAYOUT_SCHEMA);
    let source_path = state
        .root
        .join("sources")
        .join(format!("{id}.{}", manifest.source.format));
    let source_available = source_path.is_file();
    let blocker = if manifest.source.format == "docx" {
        let story_link_candidate = (2..=4097).contains(&revision)
            && selected.capabilities.word_layout_edits == Some(2)
            && source_available
            && bundle
                .revision(revision)
                .map_err(hcd_error)?
                .patch_id
                .as_deref()
                .is_some_and(|id| id.starts_with("word-story-link-"));
        let region_text_candidate =
            region_docx && source_available && (1..=4097).contains(&revision);
        let slot = if story_link_candidate || region_text_candidate {
            Some(export_process::reserve_slot()?)
        } else {
            None
        };
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            let blocked = hcd_docx::requires_semantic_rebuild(&bundle, revision)?;
            if blocked
                && ((story_link_candidate
                    && hcd_docx::verify_source_story_link(&bundle, &source_path, revision).is_ok())
                    || (region_text_candidate
                        && hcd_docx::verify_source_region_text_export(
                            &bundle,
                            &source_path,
                            revision,
                        )
                        .is_ok()))
            {
                Ok(None)
            } else {
                Ok(blocked.then_some("DOCX_REBUILD_REQUIRED"))
            }
        })
        .await
        .map_err(internal)?
        .map_err(hcd_error)?
    } else if matches!(manifest.source.format.as_str(), "pptx" | "xlsx" | "pdf") {
        let pptx_source =
            (manifest.source.format == "pptx" && source_available).then_some(source_path);
        tokio::task::spawn_blocking(move || {
            if let Some(source) = pptx_source {
                hcd_formats::source_export_edit_blocker_with_source(&bundle, &source, revision)
            } else {
                hcd_formats::source_export_edit_blocker(&bundle, revision)
            }
        })
        .await
        .map_err(internal)?
        .map_err(hcd_error)?
    } else {
        None
    };
    Ok(Json(
        json!({"revision":revision,"sourceAvailable":source_available,"sourceEditsSupported":blocker.is_none(),
        "semanticExportSupported":!flow_layout && !pdf_overlay_blocked,
        "semanticWordFields":if region_html {Some("numeric-v1")} else {None},
        "semanticFormats":if pdf_overlay_blocked {vec![]} else if !flow_layout {vec!["docx","xlsx","pptx","pdf","html","md","txt"]} else if region_html {vec!["docx","html","txt"]} else if region_docx {vec!["docx"]} else {vec![]},
        "semanticReasonCode":if pdf_overlay_blocked {Some("PDF_UNPAINTED_TEXT")} else if region_docx {Some("WORD_REGION_EXPORT_PARTIAL")} else if flow_layout{Some("WORD_REGION_LAYOUT_UNSUPPORTED")}else{None},
        "reasonCode": if !source_available { Some("SOURCE_UNAVAILABLE") } else { blocker }}),
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
        "docx" | "xlsx" | "pptx" | "pdf" | "html" | "md" | "txt" | "hcdz"
    ) {
        return Err(bad("unsupported export format"));
    }
    let mime = match format.as_str() {
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pdf" => "application/pdf",
        "hcdz" => "application/vnd.officecli.hcd+zip",
        "html" => "text/html; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        _ => "text/plain; charset=utf-8",
    };
    let source_backed = query.source.unwrap_or(false);
    let (selected, _) = manifest_at_revision(&bundle, &head, Some(requested)).map_err(hcd_error)?;
    if format != "hcdz"
        && !(source_backed && format == "pdf" && selected.source.format == "pdf")
        && hcd_formats::pdf_has_unpainted_text(&bundle, requested).map_err(hcd_error)?
    {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "PDF_UNPAINTED_TEXT".into(),
        ));
    }
    let flow_layout = hcd_core::read_flow_document_layout(&bundle, &selected).map_err(hcd_error)?;
    let regional_docx = format == "docx" && flow_layout.is_some();
    let regional_html = format == "html"
        && flow_layout
            .as_ref()
            .is_some_and(|layout| layout.schema_version == hcd_core::FLOW_REGION_LAYOUT_SCHEMA);
    let regional_text = format == "txt"
        && flow_layout
            .as_ref()
            .is_some_and(|layout| layout.schema_version == hcd_core::FLOW_REGION_LAYOUT_SCHEMA);
    if format != "hcdz"
        && !(source_backed && format == "docx" && head.source.format == "docx")
        && flow_layout.is_some()
        && !regional_docx
        && !regional_html
        && !regional_text
    {
        return Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY,"This Word region format is not supported yet. Project Word regions for semantic DOCX export, or use an offline HCD archive to retain all regions".into()));
    }
    if format == "hcdz" && source_backed {
        return Err(bad("offline archives use saved canonical content"));
    }
    let (bytes, fidelity_level) = if format == "hcdz" {
        let _slot = export_process::reserve_slot()?;
        let temp = tempfile::tempdir().map_err(internal)?;
        let output = temp.path().join("document.hcdz");
        let mut command = tokio::process::Command::new(std::env::current_exe().map_err(internal)?);
        command
            .env("TMPDIR", temp.path())
            .env("TMP", temp.path())
            .env("TEMP", temp.path())
            .arg("hdoc")
            .arg("pack")
            .arg(bundle.root())
            .arg("--output")
            .arg(&output)
            .arg("--revision")
            .arg(requested.to_string());
        let result = export_process::run(&mut command, export_process::timeout_from_env()?).await?;
        if !result.status.success() {
            return Err(bad(format!(
                "offline archive failed: {}",
                String::from_utf8_lossy(&result.stderr)
            )));
        }
        if tokio::fs::metadata(&output).await.map_err(internal)?.len() > 256 * 1024 * 1024 {
            return Err(bad("export exceeds 256 MiB HTTP limit"));
        }
        (
            tokio::fs::read(&output).await.map_err(internal)?,
            "NATIVE".to_owned(),
        )
    } else if format == "html" && !source_backed {
        let mut output = Vec::new();
        crate::hdoc_export_html::render(&bundle, requested, &mut output).map_err(bad)?;
        (output, "SEMANTIC".to_string())
    } else {
        let _export_slot = export_process::reserve_slot()?;
        let temp = tempfile::tempdir().map_err(internal)?;
        let output = temp.path().join(format!("export.{format}"));
        let fidelity_path = temp.path().join("fidelity.json");
        let mut command = tokio::process::Command::new(std::env::current_exe().map_err(internal)?);
        command
            // Validation/layout can create its own scratch directories. Keep
            // all child-owned temporary files inside the request's directory,
            // so killing an exporter cannot strand them in the system temp.
            .env("TMPDIR", temp.path())
            .env("TMP", temp.path())
            .env("TEMP", temp.path())
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
        let result = export_process::run(&mut command, export_process::timeout_from_env()?).await?;
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
    authorize(&state, &headers, &id, false)?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "private, no-store".parse().map_err(internal)?,
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        "nosniff".parse().map_err(internal)?,
    );
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

    #[tokio::test]
    async fn head_check_is_authorized_non_cacheable_and_identifies_source() {
        let root = tempfile::tempdir().unwrap();
        let bundle = word_image_bundle(root.path());
        let state = edit_state(root.path());
        let response = document_head(
            State(state.clone()),
            Path("doc".into()),
            edit_headers(&state, "read"),
        )
        .await
        .unwrap()
        .into_response();
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let head = bundle.manifest().unwrap();
        assert_eq!(body["documentId"], "doc");
        assert_eq!(body["revision"], head.revision);
        assert_eq!(body["sourceSha256"], head.source.sha256);
        assert!(matches!(
            document_head(State(state), Path("doc".into()), HeaderMap::new()).await,
            Err(ApiError(StatusCode::UNAUTHORIZED, _))
        ));
    }

    #[test]
    fn calculated_field_save_error_has_a_stable_code() {
        let response = ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "DOCX_SOURCE_TEXT_READ_ONLY: a calculated field cannot be changed or removed".into(),
        )
        .into_response();
        assert_eq!(
            response.headers()["x-hcd-error-code"],
            "DOCX_SOURCE_TEXT_READ_ONLY"
        );
        let id = format!("n_{}", "a".repeat(32));
        let response = ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("DOCX_SOURCE_TEXT_READ_ONLY:{id}"),
        )
        .into_response();
        assert_eq!(response.headers()["x-hcd-protected-block"], id);
        let invalid = ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "DOCX_SOURCE_TEXT_READ_ONLY:n_invalid".into(),
        )
        .into_response();
        assert!(!invalid.headers().contains_key("x-hcd-protected-block"));
        let other = ApiError(StatusCode::UNPROCESSABLE_ENTITY, "other".into()).into_response();
        assert!(!other.headers().contains_key("x-hcd-error-code"));
    }

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
    async fn export_feature_declarations_are_authorized_revision_pinned_and_do_not_publish() {
        use axum::body::to_bytes;
        let root = tempfile::tempdir().unwrap();
        let bundle = word_image_bundle(root.path());
        let projection = editor_projection(&bundle, None).unwrap();
        let payload = json!({"schemaVersion":"hcd.extension/1","instanceId":format!("x_{:032x}",1),"type":"future.business","version":77,"display":"block","data":{"private":"never-return-this-data"},"fallback":{"text":"可读业务节点"}});
        let block: EditorBlockContent = serde_json::from_value(
            json!({"kind":"extension","extension":payload,"inlines":[{"text":"可读业务节点"}]}),
        )
        .unwrap();
        apply_structure_patch(
            &bundle,
            &StructurePatchBatch {
                schema_version: HCD_PATCH_SCHEMA_VERSION_4.into(),
                document_id: "doc".into(),
                patch_id: "export-inventory-test".into(),
                base_revision: 1,
                actor: BTreeMap::new(),
                operations: vec![StructureOperation::Insert {
                    after_block_id: Some(projection.blocks[0].block_id.clone()),
                    block,
                }],
            },
            1,
        )
        .unwrap();
        let state = edit_state(root.path());
        let head = std::fs::read(root.path().join("doc.hcd/manifest.json")).unwrap();
        assert!(export_capabilities::options(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(2) }),
            HeaderMap::new()
        )
        .await
        .is_err());
        for (revision, count) in [(1, 0), (2, 1)] {
            let response = export_capabilities::options(
                State(state.clone()),
                Path("doc".into()),
                Query(RevisionQuery {
                    revision: Some(revision),
                }),
                edit_headers(&state, "read"),
            )
            .await
            .unwrap();
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "private, no-store"
            );
            let value: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await.unwrap())
                    .unwrap();
            assert_eq!(value["revision"], revision);
            assert_eq!(value["features"].as_array().unwrap().len(), count);
            assert!(!value.to_string().contains("never-return-this-data"));
            if count > 0 {
                assert_eq!(value["features"][0]["formats"]["docx"]["support"], "static");
                assert_eq!(
                    value["features"][0]["formats"]["html"]["dataRetention"],
                    "embedded"
                );
                assert_eq!(value["features"][0]["source"]["support"], "unsupported");
            }
        }
        assert!(export_capabilities::options(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(3) }),
            edit_headers(&state, "read")
        )
        .await
        .is_err());
        let policy = load_access(&state, "doc")
            .unwrap()
            .replace(Some(vec!["another-reader".into()]), None)
            .unwrap();
        store_access(&state, "doc", &policy).unwrap();
        assert!(export_capabilities::options(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(2) }),
            edit_headers(&state, "read")
        )
        .await
        .is_err());
        assert_eq!(
            std::fs::read(root.path().join("doc.hcd/manifest.json")).unwrap(),
            head
        );
    }

    #[tokio::test]
    async fn historical_manifest_and_styles_read_the_requested_revision_without_changing_head() {
        let root = tempfile::tempdir().unwrap();
        let bundle = word_image_bundle(root.path());
        let state = edit_state(root.path());
        let head = bundle.manifest().unwrap();
        assert_eq!(head.revision, 1);
        let Json(historical) = manifest(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(0) }),
            edit_headers(&state, "read"),
        )
        .await
        .unwrap();
        assert_eq!(historical["revision"], 0);
        assert_eq!(
            historical["rootHash"],
            bundle.revision(0).unwrap().root_hash
        );
        let Json(current) = manifest(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: None }),
            edit_headers(&state, "read"),
        )
        .await
        .unwrap();
        assert_eq!(current["revision"], head.revision);
        let css = styles(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(0) }),
            edit_headers(&state, "read"),
        )
        .await
        .unwrap();
        assert_eq!(
            css.headers()[header::CONTENT_TYPE],
            "text/css; charset=utf-8"
        );
        assert!(!axum::body::to_bytes(css.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .is_empty());
        assert!(manifest(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(2) }),
            edit_headers(&state, "read")
        )
        .await
        .is_err());
        assert!(styles(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(2) }),
            edit_headers(&state, "read")
        )
        .await
        .is_err());
        assert_eq!(bundle.manifest().unwrap().revision, head.revision);
    }

    #[tokio::test]
    async fn regional_identity_retains_service_scope_and_fences_legacy_persistence() {
        let root = tempfile::tempdir().unwrap();
        word_image_bundle(root.path());
        let state = edit_state(root.path());
        let access = DocumentAccess::default()
            .replace(None, Some(vec!["alice".into()]))
            .unwrap();
        store_access(&state, "doc", &access).unwrap();
        write_collaboration_metadata(
            &state,
            "doc",
            &CollaborationMetadata {
                epoch: 1,
                protocol: CollaborationProtocol::WordRegions1,
                node_edits: Some(7),
                migration: None,
            },
        )
        .await
        .unwrap();
        let mut headers = edit_headers_for(&state, "write", "hcd-collaboration");
        let Json(auth) = auth_check(State(state.clone()), Path("doc".into()), headers.clone())
            .await
            .unwrap();
        assert_eq!(auth["scope"], "write");
        assert_eq!(auth["collaborationProtocol"], "hcd-word-regions/1");
        headers.insert("x-hcd-collaboration-epoch", "1".parse().unwrap());
        headers.insert(
            "x-hcd-collaboration-protocol",
            "hcd-word-regions/1".parse().unwrap(),
        );
        headers.insert("x-hcd-coordinator-version", "4".parse().unwrap());
        headers.insert("x-hcd-state-hash", "none".parse().unwrap());
        let error = collaboration_put(
            State(state),
            Path("doc".into()),
            headers,
            Bytes::from_static(b"legacy"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::UPGRADE_REQUIRED);
    }

    #[tokio::test]
    async fn generic_assets_use_safe_raster_signatures_without_enabling_active_content() {
        let root = tempfile::tempdir().unwrap();
        let bundle = word_image_bundle(root.path());
        let baseline = bundle.manifest().unwrap();
        let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
        for (bytes, expected) in [
            (png.as_slice(), "image/png"),
            (
                b"<svg xmlns='http://www.w3.org/2000/svg'/>".as_slice(),
                "application/octet-stream",
            ),
            (
                b"ordinary attachment".as_slice(),
                "application/octet-stream",
            ),
        ] {
            let asset = bundle
                .stage_asset_from_reader("bin", &mut std::io::Cursor::new(bytes))
                .unwrap();
            let response = asset_response(&bundle, &asset, &asset.hash).await.unwrap();
            assert_eq!(response.headers()[header::CONTENT_TYPE], expected);
            assert_eq!(response.headers()["x-content-type-options"], "nosniff");
            assert_eq!(
                axum::body::to_bytes(response.into_body(), 1024)
                    .await
                    .unwrap()
                    .as_ref(),
                bytes
            );
        }
        let after = bundle.manifest().unwrap();
        assert_eq!(after.revision, baseline.revision);
        assert_eq!(after.root_hash, baseline.root_hash);
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
            std::fs::create_dir(root.path().join("sources")).unwrap();
            std::fs::copy(
                root.path().join("source.docx"),
                root.path().join("sources/doc.docx"),
            )
            .unwrap();
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
            word_owners: word_owner::WordOwners::default(),
        }
    }

    #[test]
    fn resource_busy_code_is_limited_to_local_lock_contention() {
        let busy = resource_stage_error(HcdError::RevisionConflict(
            "another local HCD mutation is already in progress".into(),
        ));
        assert_eq!(busy.0, StatusCode::CONFLICT);
        assert_eq!(busy.1, "HCD_RESOURCE_BUSY");
        let other = resource_stage_error(HcdError::RevisionConflict("different conflict".into()));
        assert_eq!(other.0, StatusCode::CONFLICT);
        assert_ne!(other.1, "HCD_RESOURCE_BUSY");
    }

    #[tokio::test]
    async fn resource_reuse_repins_only_verified_document_owned_bytes() {
        let root = tempfile::tempdir().unwrap();
        let bundle = image_bundle(root.path());
        let state = edit_state(root.path());
        let write = edit_headers_for(&state, "write", "alice");
        let read = edit_headers_for(&state, "read", "alice");
        let canonical = bundle
            .read_asset_index_for_revision(0)
            .unwrap()
            .into_iter()
            .find(|asset| asset.source_part.ends_with("image.png"))
            .unwrap();
        let Json(reused_canonical) = restage_resource(
            State(state.clone()),
            Path("doc".into()),
            write.clone(),
            Json(ResourceReuseRequest {
                hash: canonical.hash.clone(),
                extension: "png".into(),
                byte_length: canonical.byte_length,
            }),
        )
        .await
        .unwrap();
        assert_eq!(reused_canonical["hash"], canonical.hash);
        assert_eq!(
            bundle.staged_asset(&canonical.hash).unwrap().byte_length,
            canonical.byte_length
        );
        let bytes = b"private attachment";
        let staged = bundle
            .stage_asset_from_reader("bin", &mut std::io::Cursor::new(bytes))
            .unwrap();
        let request = || ResourceReuseRequest {
            hash: staged.hash.clone(),
            extension: "bin".into(),
            byte_length: bytes.len() as u64,
        };
        let initial = bundle.manifest().unwrap().revision;
        assert!(matches!(
            restage_resource(
                State(state.clone()),
                Path("doc".into()),
                read,
                Json(request())
            )
            .await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        let Json(result) = restage_resource(
            State(state.clone()),
            Path("doc".into()),
            write.clone(),
            Json(request()),
        )
        .await
        .unwrap();
        assert_eq!(result["hash"], staged.hash);
        assert_eq!(result["byteLength"], bytes.len());
        assert_eq!(
            bundle.staged_asset(&staged.hash).unwrap().byte_length,
            bytes.len() as u64
        );
        let missing = ResourceReuseRequest {
            hash: "a".repeat(64),
            extension: "bin".into(),
            byte_length: 1,
        };
        assert!(matches!(
            restage_resource(
                State(state.clone()),
                Path("doc".into()),
                write.clone(),
                Json(missing)
            )
            .await,
            Err(ApiError(StatusCode::NOT_FOUND, _))
        ));
        let wrong_type = ResourceReuseRequest {
            extension: "png".into(),
            ..request()
        };
        assert!(restage_resource(
            State(state.clone()),
            Path("doc".into()),
            write.clone(),
            Json(wrong_type)
        )
        .await
        .is_err());
        std::fs::write(
            bundle.resolve_href(&staged.href).unwrap(),
            b"tampered bytes!",
        )
        .unwrap();
        assert!(
            restage_resource(State(state), Path("doc".into()), write, Json(request()))
                .await
                .is_err()
        );
        assert_eq!(bundle.manifest().unwrap().revision, initial);
    }

    #[tokio::test]
    async fn recovery_repin_survives_current_revision_restoring_away_the_resource() {
        let root = tempfile::tempdir().unwrap();
        let bundle = image_bundle(root.path());
        let image = hcd_core::extract_image_page(&bundle, None, 10)
            .unwrap()
            .entries
            .remove(0)
            .node;
        let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC").unwrap();
        let staged = bundle
            .stage_asset_from_reader("png", &mut std::io::Cursor::new(png))
            .unwrap();
        assert_ne!(Some(&staged.hash), image.asset_hash.as_ref());
        let replace = |id: &str, base: u64, visual: String| PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION_3.into(),
            document_id: "doc".into(),
            patch_id: id.into(),
            base_revision: base,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::ImageReplace {
                node_id: image.node_id.clone(),
                asset_hash: staged.hash.clone(),
                precondition: VisualPrecondition {
                    visual_hash: visual,
                },
            }],
        };
        apply_patch(
            &bundle,
            &replace("first-image", 0, image.visual_hash.clone()),
            0,
        )
        .unwrap();
        let pin = bundle
            .resolve_href(&format!("assets/staged/{}.json", staged.hash))
            .unwrap();
        std::fs::remove_file(&pin).unwrap();
        let state = edit_state(root.path());
        let Json(_) = restage_resource(
            State(state.clone()),
            Path("doc".into()),
            edit_headers_for(&state, "write", "alice"),
            Json(ResourceReuseRequest {
                hash: staged.hash.clone(),
                extension: "png".into(),
                byte_length: staged.byte_length,
            }),
        )
        .await
        .unwrap();
        assert!(pin.exists());
        restore_revision(&bundle, 0, 1, None, None).unwrap();
        assert!(!bundle
            .read_asset_index_for_revision(2)
            .unwrap()
            .iter()
            .any(|asset| asset.hash == staged.hash));
        let current = get_image_node(&bundle, &image.node_id).unwrap().node;
        apply_patch(
            &bundle,
            &replace("recovered-image", 2, current.visual_hash),
            2,
        )
        .unwrap();
        assert_eq!(
            get_image_node(&bundle, &image.node_id)
                .unwrap()
                .node
                .asset_hash,
            Some(staged.hash)
        );
    }

    #[tokio::test]
    async fn region_text_export_options_verify_actual_source_rewrite() {
        let root = tempfile::tempdir().unwrap();
        let source_dir = root.path().join("sources");
        std::fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("doc.docx");
        std::fs::copy(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../docs/assets/hcd-flow-regions-2026-10-26/image-source.docx"),
            &source,
        )
        .unwrap();
        let path = root.path().join("doc.hcd");
        let mut options = hcd_docx::ImportOptions::new("doc");
        options.flow_layout = true;
        hcd_docx::import_docx(&source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(&path).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        let entry = hcd_core::extract_text_page(&bundle, None, 100)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.editable && entry.source.node_kind == "text")
            .unwrap();
        let other = hcd_core::extract_text_page(&bundle, None, 100)
            .unwrap()
            .entries
            .into_iter()
            .find(|candidate| {
                candidate.source.editable
                    && candidate.source.node_kind == "text"
                    && candidate.node_id != entry.node_id
            })
            .unwrap();
        let patch = hcd_core::PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.into(),
            document_id: "doc".into(),
            patch_id: "text-edit".into(),
            base_revision: 1,
            actor: Default::default(),
            metadata: Default::default(),
            operations: vec![hcd_core::PatchOperation::TextSplice {
                node_id: entry.node_id,
                start: 0,
                delete_count: entry.text.chars().count(),
                insert_text: "Changed".into(),
                precondition: hcd_core::NodePrecondition {
                    node_hash: entry.node_hash,
                },
            }],
        };
        hcd_core::apply_patch(&bundle, &patch, 1).unwrap();
        let state = edit_state(root.path());
        let headers = edit_headers_for(&state, "read", "alice");
        let Json(initial) = export_options(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(1) }),
            headers.clone(),
        )
        .await
        .unwrap();
        assert_eq!(initial["sourceEditsSupported"], true);
        assert!(initial["reasonCode"].is_null());
        let Json(available) = export_options(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(2) }),
            headers.clone(),
        )
        .await
        .unwrap();
        assert_eq!(available["sourceEditsSupported"], true);
        assert!(available["reasonCode"].is_null());
        let stale = hcd_core::PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.into(),
            document_id: "doc".into(),
            patch_id: "stale-other-edit".into(),
            base_revision: 1,
            actor: Default::default(),
            metadata: Default::default(),
            operations: vec![hcd_core::PatchOperation::TextSplice {
                node_id: other.node_id,
                start: 0,
                delete_count: other.text.chars().count(),
                insert_text: "Other changed".into(),
                precondition: hcd_core::NodePrecondition {
                    node_hash: other.node_hash,
                },
            }],
        };
        hcd_core::apply_patch(&bundle, &stale, 2).unwrap();
        let Json(merged) = export_options(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(3) }),
            headers.clone(),
        )
        .await
        .unwrap();
        assert_eq!(merged["sourceEditsSupported"], true);
        std::fs::write(&source, b"wrong source").unwrap();
        let Json(blocked) = export_options(
            State(state),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(2) }),
            headers,
        )
        .await
        .unwrap();
        assert_eq!(blocked["sourceEditsSupported"], false);
    }

    #[tokio::test]
    async fn story_link_export_options_verify_retained_source_and_styles() {
        let root = tempfile::tempdir().unwrap();
        let source_dir = root.path().join("sources");
        std::fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("doc.docx");
        std::fs::copy(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../docs/assets/hcd-flow-regions-2026-10-26/image-source.docx"),
            &source,
        )
        .unwrap();
        let path = root.path().join("doc.hcd");
        let mut options = hcd_docx::ImportOptions::new("doc");
        options.flow_layout = true;
        hcd_docx::import_docx(&source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(&path).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        let layout = hcd_core::editor_projection(&bundle, None)
            .unwrap()
            .flow_layout
            .unwrap();
        hcd_core::apply_flow_story_link_transaction(
            &bundle,
            &hcd_core::FlowStoryLinkTransaction {
                schema_version: hcd_core::FLOW_STORY_LINK_TRANSACTION_SCHEMA.into(),
                document_id: "doc".into(),
                transaction_id: "0123456789abcdef0123456789abcdef".into(),
                expected_revision: 1,
                actor: Default::default(),
                link: hcd_core::FlowStoryLinkRequest {
                    base_layout_hash: hcd_core::flow_layout_hash(&layout).unwrap(),
                    section_id: layout.sections[1].id.clone(),
                    kind: hcd_core::FlowStoryKind::Header,
                    variant: hcd_core::FlowStoryVariant::Even,
                    expected_direct_story_id: layout.sections[1].headers.even.clone().unwrap(),
                },
            },
        )
        .unwrap();
        let state = edit_state(root.path());
        let headers = edit_headers_for(&state, "read", "alice");
        let Json(available) = export_options(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(2) }),
            headers.clone(),
        )
        .await
        .unwrap();
        assert_eq!(available["sourceEditsSupported"], true);
        assert!(available["reasonCode"].is_null());
        let current = hcd_core::editor_projection(&bundle, None)
            .unwrap()
            .flow_layout
            .unwrap();
        hcd_core::apply_flow_story_link_transaction(
            &bundle,
            &hcd_core::FlowStoryLinkTransaction {
                schema_version: hcd_core::FLOW_STORY_LINK_TRANSACTION_SCHEMA.into(),
                document_id: "doc".into(),
                transaction_id: "1123456789abcdef0123456789abcdef".into(),
                expected_revision: 2,
                actor: Default::default(),
                link: hcd_core::FlowStoryLinkRequest {
                    base_layout_hash: hcd_core::flow_layout_hash(&current).unwrap(),
                    section_id: current.sections[1].id.clone(),
                    kind: hcd_core::FlowStoryKind::Footer,
                    variant: hcd_core::FlowStoryVariant::First,
                    expected_direct_story_id: current.sections[1].footers.first.clone().unwrap(),
                },
            },
        )
        .unwrap();
        let Json(second_available) = export_options(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(3) }),
            headers.clone(),
        )
        .await
        .unwrap();
        assert_eq!(second_available["sourceEditsSupported"], true);
        let styles = bundle
            .resolve_href(&bundle.manifest().unwrap().styles_href)
            .unwrap();
        std::fs::write(styles, "body { color: red; }").unwrap();
        let Json(blocked) = export_options(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(3) }),
            headers.clone(),
        )
        .await
        .unwrap();
        assert_eq!(blocked["sourceEditsSupported"], false);
        assert_eq!(blocked["reasonCode"], "DOCX_REBUILD_REQUIRED");
        std::fs::remove_file(source).unwrap();
        let Json(missing) = export_options(
            State(state),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(2) }),
            headers,
        )
        .await
        .unwrap();
        assert_eq!(missing["reasonCode"], "SOURCE_UNAVAILABLE");
    }

    #[tokio::test]
    async fn xlsx_save_checks_legacy_mapped_formula_ranges_against_retained_source() {
        use std::io::Write;
        fn workbook(path: &std::path::Path, formula: bool, merged: bool, protected: bool) {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
            let options = zip::write::SimpleFileOptions::default();
            let parts = [
                (
                    "[Content_Types].xml",
                    r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
                ),
                (
                    "_rels/.rels",
                    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
                ),
                (
                    "xl/workbook.xml",
                    r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
                ),
                (
                    "xl/_rels/workbook.xml.rels",
                    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
                ),
            ];
            for (name, value) in parts {
                zip.start_file(name, options).unwrap();
                zip.write_all(value.as_bytes()).unwrap();
            }
            let anchor = if formula {
                r#"<c r="A1"><f t="array" ref="A1:B1">1</f><v>1</v></c>"#
            } else {
                r#"<c r="A1"><v>1</v></c>"#
            };
            let merges = if merged {
                r#"<mergeCells><mergeCell ref="A1:B1"/></mergeCells>"#
            } else {
                ""
            };
            let protection = if protected {
                r#"<sheetProtection sheet="1"/>"#
            } else {
                ""
            };
            zip.start_file("xl/worksheets/sheet1.xml", options).unwrap();
            write!(zip, r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">{anchor}<c r="B1"><v>4</v></c><c r="C1" t="inlineStr"><is><t>original</t></is></c></row></sheetData>{protection}{merges}</worksheet>"#).unwrap();
            zip.finish().unwrap();
        }
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.xlsx");
        workbook(&source, false, false, false);
        let path = root.path().join("doc.hcd");
        hcd_formats::import_document(
            &source,
            &path,
            &hcd_formats::ImportOptions::new("doc"),
            |_| Ok(()),
        )
        .unwrap();
        // Simulate an old importer that incorrectly mapped B1 as editable.
        workbook(&source, true, false, false);
        let bytes = std::fs::read(&source).unwrap();
        let manifest_path = path.join("manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest["source"]["sha256"] = json!(hash_bytes(&bytes));
        manifest["source"]["sizeBytes"] = json!(bytes.len());
        std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        std::fs::create_dir(root.path().join("sources")).unwrap();
        std::fs::copy(&source, root.path().join("sources/doc.xlsx")).unwrap();
        let bundle = Bundle::open(&path).unwrap();
        let page = hcd_core::extract_text_page(&bundle, None, 20).unwrap();
        let make_patch = |address: &str, patch_id: &str| {
            let node = page
                .entries
                .iter()
                .find(|entry| entry.source.paragraph_id.as_deref() == Some(address))
                .unwrap();
            assert!(node.source.editable);
            PatchBatch {
                schema_version: HCD_PATCH_SCHEMA_VERSION_3.into(),
                document_id: "doc".into(),
                patch_id: patch_id.into(),
                base_revision: 0,
                actor: BTreeMap::new(),
                operations: vec![PatchOperation::TextSplice {
                    node_id: node.node_id.clone(),
                    start: 0,
                    delete_count: 0,
                    insert_text: "new".into(),
                    precondition: hcd_core::NodePrecondition {
                        node_hash: node.node_hash.clone(),
                    },
                }],
                metadata: BTreeMap::new(),
            }
        };
        let state = edit_state(root.path());
        let headers = edit_headers(&state, "read");
        assert!(matches!(
            xlsx_formula_audit(
                State(state.clone()),
                Path("doc".into()),
                Query(RevisionQuery { revision: Some(0) }),
                headers.clone(),
            ).await,
            Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, code)) if code == "XLSX_FORMULA_READ_ONLY"
        ));
        assert!(matches!(
            xlsx_formula_audit(
                State(state.clone()),
                Path("doc".into()),
                Query(RevisionQuery { revision: None }),
                HeaderMap::new(),
            )
            .await,
            Err(ApiError(StatusCode::UNAUTHORIZED, _))
        ));
        // The same policy applies to retained sources, audits and proof creation.
        let protected_source = root.path().join("protected.xlsx");
        workbook(&protected_source, false, false, false);
        let protected_path = root.path().join("protected.hcd");
        hcd_formats::import_document(
            &protected_source,
            &protected_path,
            &hcd_formats::ImportOptions::new("protected"),
            |_| Ok(()),
        )
        .unwrap();
        // Simulate an older import whose protected cells were mapped editable.
        workbook(&protected_source, false, false, true);
        let bytes = std::fs::read(&protected_source).unwrap();
        let manifest_path = protected_path.join("manifest.json");
        let mut metadata: Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        metadata["source"]["sha256"] = json!(hash_bytes(&bytes));
        metadata["source"]["sizeBytes"] = json!(bytes.len());
        std::fs::write(&manifest_path, serde_json::to_vec(&metadata).unwrap()).unwrap();
        std::fs::copy(
            &protected_source,
            root.path().join("sources/protected.xlsx"),
        )
        .unwrap();
        let protected_bundle = Bundle::open(&protected_path).unwrap();
        let protected_node = hcd_core::extract_text_page(&protected_bundle, None, 20)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("C1"))
            .unwrap();
        let protected_patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION_3.into(),
            document_id: "protected".into(),
            patch_id: "protected-edit".into(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: protected_node.node_id,
                start: 0,
                delete_count: 0,
                insert_text: "local".into(),
                precondition: NodePrecondition {
                    node_hash: protected_node.node_hash,
                },
            }],
        };
        let protected_read = edit_headers_for_doc(&state, "protected", "read", "reader");
        let protected_write = edit_headers_for_doc(&state, "protected", "write", "editor");
        assert!(
            matches!(xlsx_formula_audit(State(state.clone()), Path("protected".into()), Query(RevisionQuery { revision: Some(0) }), protected_read).await,
            Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, code)) if code == "XLSX_SHEET_PROTECTED")
        );
        assert!(
            matches!(xlsx_formula_proof_create(State(state.clone()), Path("protected".into()), protected_write, Json(ExpectedRevision { expected_revision: 0 })).await,
            Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, code)) if code == "XLSX_SHEET_PROTECTED")
        );
        assert!(
            matches!(apply_editor_edits(&state, "protected", protected_patch).await,
            Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, code)) if code == "XLSX_SHEET_PROTECTED")
        );
        assert_eq!(protected_bundle.manifest().unwrap().revision, 0);
        // Simulate a legacy editable B1 mapping against a source where B1 is
        // covered by a merged range. All three API paths return the same code.
        let merged_source = root.path().join("merged.xlsx");
        workbook(&merged_source, false, false, false);
        let merged_path = root.path().join("merged.hcd");
        hcd_formats::import_document(
            &merged_source,
            &merged_path,
            &hcd_formats::ImportOptions::new("merged"),
            |_| Ok(()),
        )
        .unwrap();
        workbook(&merged_source, false, true, false);
        let merged_bytes = std::fs::read(&merged_source).unwrap();
        let merged_manifest = merged_path.join("manifest.json");
        let mut metadata: Value =
            serde_json::from_slice(&std::fs::read(&merged_manifest).unwrap()).unwrap();
        metadata["source"]["sha256"] = json!(hash_bytes(&merged_bytes));
        metadata["source"]["sizeBytes"] = json!(merged_bytes.len());
        std::fs::write(&merged_manifest, serde_json::to_vec(&metadata).unwrap()).unwrap();
        std::fs::copy(&merged_source, root.path().join("sources/merged.xlsx")).unwrap();
        let merged_bundle = Bundle::open(&merged_path).unwrap();
        let merged_node = hcd_core::extract_text_page(&merged_bundle, None, 20)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("B1"))
            .unwrap();
        let merged_patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION_3.into(),
            document_id: "merged".into(),
            patch_id: "merged-covered".into(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: merged_node.node_id,
                start: 0,
                delete_count: 0,
                insert_text: "local".into(),
                precondition: NodePrecondition {
                    node_hash: merged_node.node_hash,
                },
            }],
        };
        let merged_read = edit_headers_for_doc(&state, "merged", "read", "reader");
        let merged_write = edit_headers_for_doc(&state, "merged", "write", "editor");
        assert!(
            matches!(xlsx_formula_audit(State(state.clone()), Path("merged".into()), Query(RevisionQuery { revision: Some(0) }), merged_read).await, Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, code)) if code == "XLSX_MERGED_CELL_READ_ONLY")
        );
        assert!(
            matches!(xlsx_formula_proof_create(State(state.clone()), Path("merged".into()), merged_write, Json(ExpectedRevision { expected_revision: 0 })).await, Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, code)) if code == "XLSX_MERGED_CELL_READ_ONLY")
        );
        assert!(
            matches!(apply_editor_edits(&state, "merged", merged_patch).await, Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, code)) if code == "XLSX_MERGED_CELL_READ_ONLY")
        );
        assert_eq!(merged_bundle.manifest().unwrap().revision, 0);
        let clean_source = root.path().join("clean.xlsx");
        workbook(&clean_source, false, false, false);
        hcd_formats::import_document(
            &clean_source,
            &root.path().join("clean.hcd"),
            &hcd_formats::ImportOptions::new("clean"),
            |_| Ok(()),
        )
        .unwrap();
        std::fs::copy(&clean_source, root.path().join("sources/clean.xlsx")).unwrap();
        let clean_headers = edit_headers_for_doc(&state, "clean", "read", "editor");
        let response = xlsx_formula_audit(
            State(state.clone()),
            Path("clean".into()),
            Query(RevisionQuery { revision: None }),
            clean_headers.clone(),
        )
        .await
        .unwrap();
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["revision"], 0);
        assert_eq!(body["sourceFreeEditsAuthorized"], false);
        assert!(matches!(
            xlsx_formula_proof_create(
                State(state.clone()),
                Path("clean".into()),
                clean_headers.clone(),
                Json(ExpectedRevision {
                    expected_revision: 0
                }),
            )
            .await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        let write = edit_headers_for_doc(&state, "clean", "write", "editor");
        let Json(proof) = xlsx_formula_proof_create(
            State(state.clone()),
            Path("clean".into()),
            write,
            Json(ExpectedRevision {
                expected_revision: 0,
            }),
        )
        .await
        .unwrap();
        assert_eq!(proof["sourceFreeEditsAuthorized"], true);
        std::fs::remove_file(root.path().join("sources/clean.xlsx")).unwrap();
        assert!(matches!(xlsx_formula_audit(
            State(state.clone()), Path("clean".into()),
            Query(RevisionQuery { revision: None }), clean_headers,
        ).await, Err(ApiError(StatusCode::NOT_FOUND, code)) if code == "XLSX_SOURCE_MISSING"));
        let clean = Bundle::open(root.path().join("clean.hcd")).unwrap();
        let clean_node = hcd_core::extract_text_page(&clean, None, 20)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("C1"))
            .unwrap();
        let clean_patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION_3.into(),
            document_id: "clean".into(),
            patch_id: "safe-sourceless".into(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: clean_node.node_id.clone(),
                start: 0,
                delete_count: 0,
                insert_text: "offline ".into(),
                precondition: NodePrecondition {
                    node_hash: clean_node.node_hash.clone(),
                },
            }],
        };
        let proof_path = root.path().join("xlsx-formula-proofs/clean.jwt");
        let signed = std::fs::read(&proof_path).unwrap();
        xlsx_formula_proof::downgrade_for_test(root.path(), "clean", &state.secret);
        assert!(
            matches!(apply_editor_edits(&state, "clean", clean_patch.clone()).await,
            Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, code)) if code == "XLSX_FORMULA_PROOF_REQUIRED")
        );
        assert_eq!(clean.manifest().unwrap().revision, 0);
        std::fs::write(&proof_path, b"tampered").unwrap();
        assert!(
            matches!(apply_editor_edits(&state, "clean", clean_patch.clone()).await,
            Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, code)) if code == "XLSX_FORMULA_PROOF_REQUIRED")
        );
        assert_eq!(clean.manifest().unwrap().revision, 0);
        std::fs::write(proof_path, signed).unwrap();
        let Json(saved_clean) = apply_editor_edits(&state, "clean", clean_patch.clone())
            .await
            .unwrap();
        assert_eq!(saved_clean["revision"], 1);
        let Json(replayed_clean) = apply_editor_edits(&state, "clean", clean_patch)
            .await
            .unwrap();
        assert_eq!(replayed_clean["idempotentReplay"], true);
        let latest_node = hcd_core::get_text_node(&clean, &clean_node.node_id).unwrap();
        let latest_patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION_3.into(),
            document_id: "clean".into(),
            patch_id: "different-secret".into(),
            base_revision: 1,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: clean_node.node_id.clone(),
                start: 0,
                delete_count: 0,
                insert_text: "more ".into(),
                precondition: NodePrecondition {
                    node_hash: latest_node.node.node_hash,
                },
            }],
        };
        let mut changed_key = state.clone();
        changed_key.secret = Arc::new(vec![b'y'; 32]);
        assert!(
            matches!(apply_editor_edits(&changed_key, "clean", latest_patch.clone()).await,
            Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, code)) if code == "XLSX_FORMULA_PROOF_REQUIRED")
        );
        assert_eq!(clean.manifest().unwrap().revision, 1);
        let Json(second_save) = apply_editor_edits(&state, "clean", latest_patch)
            .await
            .unwrap();
        assert_eq!(second_save["revision"], 2);
        let original = std::fs::read(&clean_source).unwrap();
        let clean_read = edit_headers_for_doc(&state, "clean", "read", "editor");
        let clean_write = edit_headers_for_doc(&state, "clean", "write", "editor");
        assert!(matches!(
            xlsx_restore_source(
                State(state.clone()),
                Path("clean".into()),
                clean_read,
                Body::from(original.clone())
            )
            .await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        assert!(
            matches!(xlsx_restore_source(State(state.clone()), Path("clean".into()), clean_write.clone(), Body::from("wrong source")).await,
            Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, code)) if code == "XLSX_SOURCE_CHANGED")
        );
        assert!(!root.path().join("sources/clean.xlsx").exists());
        let Json(restored) = xlsx_restore_source(
            State(state.clone()),
            Path("clean".into()),
            clean_write.clone(),
            Body::from(original.clone()),
        )
        .await
        .unwrap();
        assert_eq!(restored["revision"], 2);
        assert_eq!(restored["alreadyPresent"], false);
        let Json(repeated) = xlsx_restore_source(
            State(state.clone()),
            Path("clean".into()),
            clean_write.clone(),
            Body::from(original.clone()),
        )
        .await
        .unwrap();
        assert_eq!(repeated["alreadyPresent"], true);
        assert_eq!(
            std::fs::read(root.path().join("sources/clean.xlsx")).unwrap(),
            original
        );
        std::fs::remove_file(root.path().join("sources/clean.xlsx")).unwrap();
        let (left, right) = tokio::join!(
            xlsx_restore_source(
                State(state.clone()),
                Path("clean".into()),
                clean_write.clone(),
                Body::from(original.clone())
            ),
            xlsx_restore_source(
                State(state.clone()),
                Path("clean".into()),
                clean_write.clone(),
                Body::from(original.clone())
            )
        );
        assert_ne!(
            left.unwrap().0["alreadyPresent"],
            right.unwrap().0["alreadyPresent"]
        );
        std::fs::write(root.path().join("sources/clean.xlsx"), b"existing mismatch").unwrap();
        assert!(
            matches!(xlsx_restore_source(State(state.clone()), Path("clean".into()), clean_write, Body::from(original)).await,
            Err(ApiError(StatusCode::CONFLICT, code)) if code == "XLSX_SOURCE_CONFLICT")
        );
        assert_eq!(
            std::fs::read(root.path().join("sources/clean.xlsx")).unwrap(),
            b"existing mismatch"
        );
        let doc_write = edit_headers_for_doc(&state, "doc", "write", "editor");
        assert!(
            matches!(xlsx_formula_proof_create(State(state.clone()), Path("doc".into()), doc_write,
            Json(ExpectedRevision { expected_revision: 0 })).await,
            Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, code)) if code == "XLSX_FORMULA_READ_ONLY")
        );
        assert!(
            matches!(apply_editor_edits(&state, "doc", make_patch("B1", "formula-edit")).await,
            Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, code)) if code == "XLSX_FORMULA_READ_ONLY")
        );
        assert_eq!(bundle.manifest().unwrap().revision, 0);
        let ordinary = make_patch("C1", "ordinary-edit");
        let retained_source = root.path().join("sources/doc.xlsx");
        std::fs::remove_file(&retained_source).unwrap();
        assert!(
            matches!(apply_editor_edits(&state, "doc", ordinary.clone()).await,
            Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, code)) if code == "XLSX_FORMULA_PROOF_REQUIRED")
        );
        std::fs::copy(&source, &retained_source).unwrap();
        std::fs::write(&retained_source, b"changed source").unwrap();
        assert!(matches!(xlsx_formula_audit(
            State(state.clone()), Path("doc".into()),
            Query(RevisionQuery { revision: None }), headers,
        ).await, Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, code)) if code == "XLSX_SOURCE_CHANGED"));
        assert!(
            matches!(apply_editor_edits(&state, "doc", ordinary.clone()).await,
            Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, code)) if code == "XLSX_SOURCE_CHANGED")
        );
        assert_eq!(bundle.manifest().unwrap().revision, 0);
        std::fs::copy(&source, &retained_source).unwrap();
        let Json(saved) = apply_editor_edits(&state, "doc", ordinary.clone())
            .await
            .unwrap();
        assert_eq!(saved["revision"], 1);
        // A stale recovered request must reach receipt/CAS handling even when
        // the source disappeared. Only an exact committed request may replay;
        // a different stale request targeting the formula range must not edit it.
        std::fs::remove_file(&retained_source).unwrap();
        assert!(matches!(
            apply_editor_edits(&state, "doc", make_patch("B1", "stale-formula-recovery")).await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        let Json(replayed) = apply_editor_edits(&state, "doc", ordinary).await.unwrap();
        assert_eq!(replayed["revision"], 1);
        assert_eq!(replayed["idempotentReplay"], true);
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        std::fs::copy(&source, &retained_source).unwrap();
        let part = "xl/worksheets/sheet1.xml";
        let create_request = hcd_core::GridCreateRequest {
            document_id: "doc".into(),
            patch_id: "create-blank".into(),
            base_revision: 1,
            source_sha256: bundle.manifest().unwrap().source.sha256,
            actor: BTreeMap::new(),
            cells: vec![hcd_core::GridCellCreate {
                sheet_id: hcd_core::stable_node_id(&["doc", part, "worksheet"])
                    .replacen("n_", "s_", 1),
                sheet_part: part.into(),
                row: 3,
                column: 3,
                text: "created".into(),
            }],
        };
        let writer = edit_headers_for_doc(&state, "doc", "write", "alice");
        let reader = edit_headers_for_doc(&state, "doc", "read", "alice");
        let other = edit_headers_for_doc(&state, "doc", "read", "bob");
        assert!(matches!(
            xlsx_grid_create::create(
                State(state.clone()),
                Path("doc".into()),
                reader.clone(),
                Json(create_request.clone())
            )
            .await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        let Json(missing) = xlsx_grid_create::receipt(
            State(state.clone()),
            Path("doc".into()),
            reader.clone(),
            Json(create_request.clone()),
        )
        .await
        .unwrap();
        assert_eq!(missing["status"], "missing");
        let mut events = state.revisions.subscribe("doc");
        let Json(created) = xlsx_grid_create::create(
            State(state.clone()),
            Path("doc".into()),
            writer.clone(),
            Json(create_request.clone()),
        )
        .await
        .unwrap();
        assert_eq!(created["revision"], 2);
        assert_eq!(events.try_recv().unwrap(), 2);
        let Json(receipt) = xlsx_grid_create::receipt(
            State(state.clone()),
            Path("doc".into()),
            reader.clone(),
            Json(create_request.clone()),
        )
        .await
        .unwrap();
        assert_eq!(receipt["status"], "committed");
        assert_eq!(receipt["revision"], 2);
        let compare_request = serde_json::from_value(json!({"expectedRevision":2,"sourceSha256":create_request.source_sha256,"cells":[{"sheetId":create_request.cells[0].sheet_id,"row":3,"column":3},{"sheetId":create_request.cells[0].sheet_id,"row":3,"column":4}]})).unwrap();
        let Json(compared) = xlsx_grid_create::compare(
            State(state.clone()),
            Path("doc".into()),
            reader.clone(),
            Json(compare_request),
        )
        .await
        .unwrap();
        assert_eq!(compared["revision"], 2);
        assert_eq!(compared["cells"][0]["mapped"]["text"], "created");
        assert!(compared["cells"][1]["mapped"].is_null());
        let stale_compare = serde_json::from_value(json!({"expectedRevision":1,"sourceSha256":create_request.source_sha256,"cells":[{"sheetId":create_request.cells[0].sheet_id,"row":3,"column":3}]})).unwrap();
        assert!(matches!(
            xlsx_grid_create::compare(
                State(state.clone()),
                Path("doc".into()),
                reader.clone(),
                Json(stale_compare)
            )
            .await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        let mut superseded = create_request.clone();
        superseded.patch_id = "stale-uncommitted".into();
        superseded.cells[0].column = 4;
        let Json(expired) = xlsx_grid_create::receipt(
            State(state.clone()),
            Path("doc".into()),
            reader.clone(),
            Json(superseded.clone()),
        )
        .await
        .unwrap();
        assert_eq!(expired["status"], "superseded");
        assert_eq!(expired["baseRevision"], 1);
        assert_eq!(expired["observedRevision"], 2);
        assert!(xlsx_grid_create::create(
            State(state.clone()),
            Path("doc".into()),
            writer.clone(),
            Json(superseded)
        )
        .await
        .is_err());
        assert!(matches!(
            xlsx_grid_create::receipt(
                State(state.clone()),
                Path("doc".into()),
                other,
                Json(create_request.clone())
            )
            .await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        let mut changed = create_request.clone();
        changed.cells[0].text = "different".into();
        assert!(matches!(
            xlsx_grid_create::receipt(
                State(state.clone()),
                Path("doc".into()),
                reader,
                Json(changed)
            )
            .await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        std::fs::remove_file(&retained_source).unwrap();
        let mut missing_source = create_request.clone();
        missing_source.patch_id = "create-without-source".into();
        missing_source.base_revision = 2;
        missing_source.cells[0].column = 4;
        assert!(
            matches!(xlsx_grid_create::create(State(state.clone()), Path("doc".into()), writer.clone(), Json(missing_source)).await, Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, code)) if code == "XLSX_SOURCE_REQUIRED")
        );
        let Json(replay) = xlsx_grid_create::create(
            State(state.clone()),
            Path("doc".into()),
            writer,
            Json(create_request),
        )
        .await
        .unwrap();
        assert_eq!(replay["idempotentReplay"], true);
        assert_eq!(replay["revision"], 2);
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn independent_story_head_blocks_legacy_editor_and_writes_but_retains_history() {
        let temp = tempfile::tempdir().unwrap();
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-regions-2026-10-26/image-source.docx");
        let mut options = hcd_docx::ImportOptions::new("doc");
        options.flow_layout = true;
        let path = temp.path().join("doc.hcd");
        hcd_docx::import_docx(&source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(path).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        let projection = hcd_core::editor_projection(&bundle, Some(1)).unwrap();
        let layout = projection.flow_layout.as_ref().unwrap();
        let request = hcd_core::FlowStoryUnlinkRequest {
            base_layout_hash: projection.flow_layout_hash.clone().unwrap(),
            section_id: layout.sections[1].id.clone(),
            kind: hcd_core::FlowStoryKind::Header,
            variant: hcd_core::FlowStoryVariant::First,
            expected_inherited_story_id: layout.sections[0].headers.first.clone(),
        };
        let story = hcd_core::FlowStory {
            id: format!("n_{:032x}", 999995),
            kind: hcd_core::FlowStoryKind::Header,
            source_part: "word/independent-server.xml".into(),
        };
        let candidate = hcd_docx::prepare_source_story_unlink(
            &bundle,
            &source,
            1,
            &request,
            &story,
            |_| unreachable!(),
            |_| unreachable!(),
        )
        .unwrap();
        hcd_core::apply_prepared_story_unlink(
            &bundle,
            &candidate.prepared,
            "cccccccccccccccccccccccccccccccc",
            &Default::default(),
        )
        .unwrap();
        let before = std::fs::read(bundle.root().join("manifest.json")).unwrap();
        let state = edit_state(temp.path());
        let mut headers = edit_headers(&state, "read");
        headers.insert("x-hcd-flow-layout-version", "2".parse().unwrap());
        assert!(matches!(
            editor(
                State(state.clone()),
                Path("doc".into()),
                Query(RevisionQuery { revision: None }),
                headers.clone()
            )
            .await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        assert!(editor(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(1) }),
            headers.clone()
        )
        .await
        .is_ok());
        assert!(word_layout(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: None }),
            headers
        )
        .await
        .is_ok());
        let stale = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.into(),
            document_id: "doc".into(),
            patch_id: "legacy-write".into(),
            base_revision: 2,
            actor: Default::default(),
            operations: vec![],
            metadata: Default::default(),
        };
        assert!(matches!(
            apply_editor_edits(&state, "doc", stale).await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        assert_eq!(
            std::fs::read(bundle.root().join("manifest.json")).unwrap(),
            before
        );
    }

    #[tokio::test]
    async fn word_layout_reads_only_bounded_metadata_and_negotiates_historical_models() {
        let temp = tempfile::tempdir().unwrap();
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-layout-2026-10-26/source.docx");
        let mut options = hcd_docx::ImportOptions::new("doc");
        options.flow_layout = true;
        let path = temp.path().join("doc.hcd");
        hcd_docx::import_docx(source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(path).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        let state = edit_state(temp.path());
        let mut headers = edit_headers(&state, "read");
        let manifest_path = bundle.root().join("manifest.json");
        let original_manifest = std::fs::read(&manifest_path).unwrap();
        let mut link_manifest: Value = serde_json::from_slice(&original_manifest).unwrap();
        link_manifest["capabilities"]["wordLayoutEdits"] = json!(2);
        std::fs::write(&manifest_path, serde_json::to_vec(&link_manifest).unwrap()).unwrap();
        assert!(matches!(
            editor(
                State(state.clone()),
                Path("doc".into()),
                Query(RevisionQuery { revision: None }),
                headers.clone(),
            )
            .await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        std::fs::write(&manifest_path, original_manifest).unwrap();
        assert!(matches!(
            word_layout(
                State(state.clone()),
                Path("doc".into()),
                Query(RevisionQuery { revision: None }),
                headers.clone()
            )
            .await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        headers.insert("x-hcd-flow-layout-version", "2".parse().unwrap());
        let Json(legacy_index) = index_page(
            State(state.clone()),
            Path(("doc".into(), 0)),
            Query(IndexPageQuery {
                revision: Some(1),
                word_regions: None,
                word_bodies: None,
            }),
            headers.clone(),
        )
        .await
        .unwrap();
        assert!(legacy_index.get("wordRegionsVerified").is_none());
        let Json(index) = index_page(
            State(state.clone()),
            Path(("doc".into(), 0)),
            Query(IndexPageQuery {
                revision: Some(1),
                word_regions: Some(true),
                word_bodies: None,
            }),
            headers.clone(),
        )
        .await
        .unwrap();
        assert_eq!(index["wordRegionsVerified"], true);
        let Json(body_index) = index_page(
            State(state.clone()),
            Path(("doc".into(), 0)),
            Query(IndexPageQuery {
                revision: Some(1),
                word_regions: Some(true),
                word_bodies: Some(true),
            }),
            headers.clone(),
        )
        .await
        .unwrap();
        assert_eq!(body_index["wordBodiesVerified"], true);
        assert!(body_index["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|chunk| chunk["region"] == "body")
            .all(|chunk| chunk["wordRegionId"].as_str().is_some()));
        let story_response = word_story_index(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(1) }),
            headers.clone(),
        )
        .await
        .unwrap();
        let story_body = axum::body::to_bytes(story_response.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap();
        let story_index: Value = serde_json::from_slice(&story_body).unwrap();
        assert_eq!(story_index["revision"], 1);
        assert_eq!(story_index["wordRegionsVerified"], true);
        assert!(story_index["stories"]
            .as_array()
            .unwrap()
            .iter()
            .any(|story| story["region"] == "header"));
        assert!(story_index["stories"]
            .as_array()
            .unwrap()
            .iter()
            .all(|story| story["region"] != "body"));
        assert!(word_story_index(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(1) }),
            HeaderMap::new()
        )
        .await
        .is_err());
        assert!(word_story_index(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(0) }),
            headers.clone()
        )
        .await
        .is_err());
        let layout = hcd_core::read_flow_document_layout(&bundle, &bundle.manifest().unwrap())
            .unwrap()
            .unwrap();
        let scopes: std::collections::HashSet<_> = hcd_core::flow_regions(&layout)
            .into_iter()
            .map(|region| region.id)
            .collect();
        let chunks = index["chunks"].as_array().unwrap();
        assert!(chunks.iter().any(|chunk| chunk["region"] == "header"));
        for chunk in chunks
            .iter()
            .filter(|chunk| ["header", "footer"].contains(&chunk["region"].as_str().unwrap()))
        {
            assert!(scopes.contains(chunk["wordRegionId"].as_str().unwrap()));
        }
        assert!(index_page(
            State(state.clone()),
            Path(("doc".into(), 0)),
            Query(IndexPageQuery {
                revision: Some(0),
                word_regions: Some(true),
                word_bodies: None,
            }),
            headers.clone()
        )
        .await
        .is_err());
        assert!(chunks
            .iter()
            .filter(|chunk| chunk["region"] == "body")
            .all(|chunk| chunk.get("wordRegionId").is_none()));
        let descriptors = bundle
            .read_index_page(&bundle.manifest().unwrap(), 0)
            .unwrap()
            .chunks;
        // A multi-page scan retains one validated layout snapshot; each page
        // still verifies the story chunks against that same catalog.
        let manifest = bundle.manifest().unwrap();
        let page = bundle.read_index_page(&manifest, 0).unwrap();
        let catalog = hcd_core::WordRegionIndex::new(&bundle, &manifest).unwrap();
        let expected_regions = catalog.page(&page).unwrap();
        let asset = bundle
            .read_asset_index_for_revision(manifest.revision)
            .unwrap()
            .into_iter()
            .find(|asset| asset.source_part == "word/_hcd/flow-layout-v2.json")
            .unwrap();
        let layout_path = bundle.root().join(&asset.href);
        let layout_bytes = std::fs::read(&layout_path).unwrap();
        std::fs::write(&layout_path, b"corrupt layout").unwrap();
        assert_eq!(catalog.page(&page).unwrap(), expected_regions);
        assert!(hcd_core::WordRegionIndex::new(&bundle, &manifest).is_err());
        std::fs::write(layout_path, layout_bytes).unwrap();
        let body = descriptors
            .iter()
            .find(|chunk| chunk.region == "body")
            .unwrap();
        let body_path = bundle.root().join(&body.html_href);
        let original_body = std::fs::read(&body_path).unwrap();
        std::fs::write(&body_path, b"corrupted body").unwrap();
        assert!(index_page(
            State(state.clone()),
            Path(("doc".into(), 0)),
            Query(IndexPageQuery {
                revision: Some(1),
                word_regions: Some(true),
                word_bodies: Some(true)
            }),
            headers.clone()
        )
        .await
        .is_err());
        assert!(word_story_index(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(1) }),
            headers.clone()
        )
        .await
        .is_ok());
        assert!(index_page(
            State(state.clone()),
            Path(("doc".into(), 0)),
            Query(IndexPageQuery {
                revision: Some(1),
                word_regions: Some(true),
                word_bodies: None,
            }),
            headers.clone()
        )
        .await
        .is_ok());
        std::fs::write(body_path, original_body).unwrap();
        let first = descriptors
            .into_iter()
            .find(|chunk| chunk.region == "header")
            .unwrap();
        let chunk_path = bundle.root().join(first.html_href);
        let original_chunk = std::fs::read(&chunk_path).unwrap();
        std::fs::write(&chunk_path, b"corrupted").unwrap();
        assert!(word_story_index(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(1) }),
            headers.clone()
        )
        .await
        .is_err());
        assert!(index_page(
            State(state.clone()),
            Path(("doc".into(), 0)),
            Query(IndexPageQuery {
                revision: Some(1),
                word_regions: Some(true),
                word_bodies: None,
            }),
            headers.clone()
        )
        .await
        .is_err());
        std::fs::write(chunk_path, original_chunk).unwrap();
        // Removing body chunks proves this endpoint does not materialize the
        // editor just to discover page geometry and story bindings.
        std::fs::remove_dir_all(bundle.root().join("chunks")).unwrap();
        let response = word_layout(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: None }),
            headers.clone(),
        )
        .await
        .unwrap();
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        let bytes = axum::body::to_bytes(
            response.into_body(),
            hcd_core::MAX_FLOW_LAYOUT_BYTES as usize + 4096,
        )
        .await
        .unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["revision"], 1);
        assert_eq!(value["layout"]["schemaVersion"], "hcd-flow-layout/2");
        assert_eq!(value["layout"]["stories"].as_array().unwrap().len(), 6);
        assert!(matches!(
            word_layout(
                State(state.clone()),
                Path("doc".into()),
                Query(RevisionQuery { revision: Some(0) }),
                headers.clone()
            )
            .await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        headers.insert("x-hcd-flow-layout-version", "1".parse().unwrap());
        assert!(word_layout(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: Some(0) }),
            headers
        )
        .await
        .is_ok());
        assert!(matches!(
            word_layout(
                State(state),
                Path("doc".into()),
                Query(RevisionQuery { revision: None }),
                HeaderMap::new()
            )
            .await,
            Err(ApiError(StatusCode::UNAUTHORIZED, _))
        ));
    }

    fn edit_headers(state: &ServerState, scope: &str) -> HeaderMap {
        edit_headers_for(state, scope, "editor")
    }

    fn people_fixture(root: &std::path::Path) {
        std::fs::create_dir_all(root.join("people")).unwrap();
        std::fs::write(root.join("people/doc.json"),serde_json::to_vec(&json!({"schemaVersion":"hcd-people/1","generation":1,"people":[
            {"id":"person-a","label":"同名","detail":"一部","active":true,"visibleTo":["alice"],"mentionableBy":["alice"]},
            {"id":"person-b","label":"同名","detail":"二部","active":true,"visibleTo":["bob"]},
            {"id":"offline","label":"Offline person","active":true},
            {"id":"disabled","label":"Disabled secret","active":false},
            {"id":"outsider","label":"Private outsider","active":true}
        ]})).unwrap()).unwrap();
    }
    fn people_query(limit: usize, cursor: Option<String>) -> people::OptionsQuery {
        people::OptionsQuery {
            kind: Some("person".into()),
            q: None,
            limit: Some(limit),
            cursor,
        }
    }
    #[test]
    fn reference_event_source_requires_an_immutable_restore_receipt_not_a_patch_id_prefix() {
        let root = tempfile::tempdir().unwrap();
        let bundle = word_image_bundle(root.path());
        let mut record = bundle.revision(1).unwrap();
        record.revision = 2;
        record.parent_revision = Some(1);
        record.patch_id = Some("restore-0-2".into());
        record.patch_hash = Some(hash_bytes(b"an ordinary client patch"));
        assert_eq!(people::reference_source(&record), "content");
        record.patch_hash = Some(hash_bytes(b"restore:0:1"));
        assert_eq!(people::reference_source(&record), "restore");
    }
    #[tokio::test]
    async fn people_search_scopes_offline_candidates_and_binds_paging_to_the_actor_and_directory() {
        let root = tempfile::tempdir().unwrap();
        let _bundle = word_image_bundle(root.path());
        let state = edit_state(root.path());
        people_fixture(root.path());
        let policy = DocumentAccess::default()
            .replace(
                Some(vec![
                    "alice".into(),
                    "bob".into(),
                    "person-a".into(),
                    "person-b".into(),
                    "offline".into(),
                    "disabled".into(),
                ]),
                None,
            )
            .unwrap();
        store_access(&state, "doc", &policy).unwrap();
        let alice = edit_headers_for(&state, "write", "alice");
        let bob = edit_headers_for(&state, "write", "bob");
        let Json(first) = people::options(
            State(state.clone()),
            Path("doc".into()),
            Query(people_query(1, None)),
            alice.clone(),
        )
        .await
        .unwrap();
        assert_eq!(first["items"].as_array().unwrap().len(), 1);
        let cursor = first["nextCursor"].as_str().unwrap().to_string();
        let Json(second) = people::options(
            State(state.clone()),
            Path("doc".into()),
            Query(people_query(1, Some(cursor.clone()))),
            alice.clone(),
        )
        .await
        .unwrap();
        let ids = [
            first["items"][0]["id"].as_str().unwrap(),
            second["items"][0]["id"].as_str().unwrap(),
        ];
        assert!(ids.contains(&"person-a") && ids.contains(&"offline"));
        assert!(second["nextCursor"].is_null());
        assert!(matches!(
            people::options(
                State(state.clone()),
                Path("doc".into()),
                Query(people_query(1, Some(cursor.clone()))),
                bob.clone()
            )
            .await,
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        let Json(other) = people::options(
            State(state.clone()),
            Path("doc".into()),
            Query(people_query(50, None)),
            bob,
        )
        .await
        .unwrap();
        let ids: Vec<_> = other["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"person-b"));
        assert!(!ids.contains(&"person-a"));
        let path = root.path().join("people/doc.json");
        let bytes = std::fs::read_to_string(&path).unwrap();
        std::fs::write(path, bytes.replace("一部", "已改名")).unwrap();
        assert!(matches!(
            people::options(
                State(state.clone()),
                Path("doc".into()),
                Query(people_query(1, Some(cursor))),
                alice
            )
            .await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        assert_eq!(load_access(&state, "doc").unwrap(), policy);
    }
    #[tokio::test]
    async fn people_resolution_hides_restricted_names_and_does_not_invent_an_online_directory() {
        let root = tempfile::tempdir().unwrap();
        let _bundle = word_image_bundle(root.path());
        let state = edit_state(root.path());
        let alice = edit_headers_for(&state, "read", "alice");
        assert!(matches!(
            people::options(
                State(state.clone()),
                Path("doc".into()),
                Query(people_query(20, None)),
                alice.clone()
            )
            .await,
            Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, _))
        ));
        people_fixture(root.path());
        let request=serde_json::from_value(json!({"targets":[{"kind":"person","id":"person-b"},{"kind":"person","id":"missing"},{"kind":"person","id":"disabled"},{"kind":"document","id":"reserved"},{"kind":"person","id":"offline"}]})).unwrap();
        let Json(result) = people::resolve(
            State(state.clone()),
            Path("doc".into()),
            alice,
            Json(request),
        )
        .await
        .unwrap();
        assert_eq!(result["items"][0]["status"], "restricted");
        assert_eq!(result["items"][1]["status"], "restricted");
        assert_eq!(result["items"][2]["status"], "inactive");
        assert_eq!(result["items"][3]["status"], "unsupported");
        assert_eq!(result["items"][4]["status"], "active");
        assert_eq!(result["items"][4]["canMention"], false);
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("Disabled secret"));
        assert!(result["items"][0].get("label").is_none());
        let path = root.path().join("people/doc.json");
        std::fs::write(path,"{\"schemaVersion\":\"hcd-people/1\",\"generation\":1,\"people\":[{\"id\":\"a\",\"label\":\"A\",\"active\":true},{\"id\":\"a\",\"label\":\"B\",\"active\":true}]}").unwrap();
        assert!(matches!(
            people::options(
                State(state.clone()),
                Path("doc".into()),
                Query(people_query(20, None)),
                edit_headers_for(&state, "read", "alice")
            )
            .await,
            Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, _))
        ));
    }
    #[test]
    fn new_references_need_per_occurrence_authority_and_unaware_snapshots_cannot_remove_them() {
        let root = tempfile::tempdir().unwrap();
        let bundle = word_image_bundle(root.path());
        let state = edit_state(root.path());
        people_fixture(root.path());
        let mut current = editor_projection(&bundle, None).unwrap();
        let content:EditorBlockContent=serde_json::from_value(json!({"kind":"paragraph","inlines":[{"text":"@同名","reference":{"type":"hcd.mention","version":1,"mentionId":format!("m_{:032x}",1),"target":{"kind":"person","id":"person-a"},"snapshot":{"label":"同名"}}}]})).unwrap();
        let mut request:SnapshotRequest=serde_json::from_value(json!({"expectedRevision":1,"referenceVersion":1,"blocks":[{"blockId":null,"content":content}],"contributors":[{"userId":"alice","displayName":"Alice"},{"userId":"bob","displayName":"Bob"}]})).unwrap();
        assert!(matches!(
            people::validate_snapshot(&state, "doc", &current, &request),
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        request.reference_authors = vec![ReferenceAuthor {
            mention_id: format!("m_{:032x}", 1),
            user_id: "bob".into(),
        }];
        assert!(matches!(
            people::validate_snapshot(&state, "doc", &current, &request),
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        request.reference_authors[0].user_id = "alice".into();
        people::validate_snapshot(&state, "doc", &current, &request).unwrap();
        current.blocks[0].content = content;
        request.blocks.clear();
        request.reference_version = None;
        assert!(matches!(
            people::validate_snapshot(&state, "doc", &current, &request),
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        request.reference_version = Some(1);
        request.blocks = vec![SnapshotBlock {
            block_id: Some(current.blocks[0].block_id.clone()),
            content: current.blocks[0].content.clone(),
        }];
        request.reference_authors.clear();
        std::fs::remove_file(root.path().join("people/doc.json")).unwrap();
        people::validate_snapshot(&state, "doc", &current, &request).unwrap();
    }

    #[tokio::test]
    async fn coordinated_restore_replays_after_head_commit_and_rotates_epoch_once() {
        let root = tempfile::tempdir().unwrap();
        let bundle = word_image_bundle(root.path());
        let state = edit_state(root.path());
        write_collaboration_metadata(
            &state,
            "doc",
            &CollaborationMetadata {
                epoch: 0,
                protocol: CollaborationProtocol::Structure3,
                node_edits: Some(1),
                migration: None,
            },
        )
        .await
        .unwrap();
        let bytes = b"persisted shared content before restore";
        let path = collaboration_current_path(&state, "doc", 0).await.unwrap();
        durable_collaboration_file(&path, bytes).await.unwrap();
        let request = coordinated_restore::Request {
            request_id: "a".repeat(32),
            expected_revision: 1,
            from_epoch: 0,
            from_protocol: None,
            source_hash: hash_bytes(bytes),
            author_id: "alice".into(),
            author_name: "Alice".into(),
        };
        let dir = root.path().join("collaboration/doc.restores");
        let intent = serde_json::to_vec(&json!({"target":0,"request":request})).unwrap();
        durable_collaboration_file(&dir.join("pending.json"), &intent)
            .await
            .unwrap();
        // Crash after appending the canonical head, before publishing the epoch.
        restore_revision(&bundle, 0, 1, Some("alice".into()), Some("Alice".into())).unwrap();
        assert!(coordinated_restore::pending(&state, "doc").await);
        let restarted = edit_state(root.path());
        let mut service = edit_headers_for(&restarted, "write", "hcd-collaboration");
        service.insert("x-hcd-coordinator-version", "4".parse().unwrap());
        service.insert("x-hcd-node-edits-version", "1".parse().unwrap());
        service.insert("x-hcd-collaboration-epoch", "0".parse().unwrap());
        service.insert(
            "x-hcd-collaboration-protocol",
            CollaborationProtocol::Structure3.name().parse().unwrap(),
        );
        for _ in 0..2 {
            let Json(receipt) = coordinated_restore::restore(
                State(restarted.clone()),
                Path(("doc".into(), 0)),
                service.clone(),
                Json(request.clone()),
            )
            .await
            .unwrap();
            assert_eq!(receipt["revision"], 2);
            assert_eq!(receipt["collaborationEpoch"], 1);
            assert_eq!(bundle.manifest().unwrap().revision, 2);
        }
        assert!(!coordinated_restore::pending(&restarted, "doc").await);
        // Crash after recording success, before removing the native fence.
        durable_collaboration_file(&dir.join("pending.json"), &intent)
            .await
            .unwrap();
        let _ = coordinated_restore::restore(
            State(restarted.clone()),
            Path(("doc".into(), 0)),
            service.clone(),
            Json(request.clone()),
        )
        .await
        .unwrap();
        assert!(!coordinated_restore::pending(&restarted, "doc").await);
        assert_eq!(collaboration_epoch(&restarted, "doc").await.unwrap(), 1);
        assert_eq!(
            collaboration_metadata(&restarted, "doc")
                .await
                .unwrap()
                .node_edits,
            Some(1)
        );
        let mut changed = request;
        changed.author_id = "bob".into();
        assert!(matches!(
            coordinated_restore::restore(
                State(restarted),
                Path(("doc".into(), 0)),
                service,
                Json(changed)
            )
            .await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        assert_eq!(
            bundle.manifest().unwrap().root_hash,
            bundle.revision(0).unwrap().root_hash
        );
    }

    #[tokio::test]
    async fn inline_coordinated_restore_pins_model_and_preserves_epoch_wire_on_replay() {
        let root = tempfile::tempdir().unwrap();
        let bundle = word_image_bundle(root.path());
        let state = edit_state(root.path());
        write_collaboration_metadata(
            &state,
            "doc",
            &CollaborationMetadata {
                epoch: 0,
                protocol: CollaborationProtocol::Inline1,
                node_edits: Some(7),
                migration: None,
            },
        )
        .await
        .unwrap();
        let bytes = b"inline room before restore";
        durable_collaboration_file(
            &collaboration_current_path(&state, "doc", 0).await.unwrap(),
            bytes,
        )
        .await
        .unwrap();
        let request = coordinated_restore::Request {
            request_id: "c".repeat(32),
            expected_revision: 1,
            from_epoch: 0,
            from_protocol: Some(CollaborationProtocol::Inline1),
            source_hash: hash_bytes(bytes),
            author_id: "alice".into(),
            author_name: "Alice".into(),
        };
        let mut service = edit_headers_for(&state, "write", "hcd-collaboration");
        for (key, value) in [
            ("x-hcd-coordinator-version", "4"),
            ("x-hcd-collaboration-epoch", "0"),
            ("x-hcd-collaboration-protocol", "hcd-semantic-inline/1"),
            ("x-hcd-inline-containers-version", "1"),
            ("x-hcd-extension-version", "3"),
            ("x-hcd-node-edits-version", "7"),
            ("x-hcd-custom-marks-version", "1"),
        ] {
            service.insert(key, value.parse().unwrap());
        }
        for key in [
            "x-hcd-inline-containers-version",
            "x-hcd-extension-version",
            "x-hcd-node-edits-version",
            "x-hcd-custom-marks-version",
        ] {
            let mut old = service.clone();
            old.remove(key);
            assert!(matches!(
                coordinated_restore::restore(
                    State(state.clone()),
                    Path(("doc".into(), 0)),
                    old,
                    Json(request.clone())
                )
                .await,
                Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
            ));
        }
        // An old durable intent cannot be silently upgraded by current metadata.
        let mut legacy = request.clone();
        legacy.from_protocol = None;
        let dir = root.path().join("collaboration/doc.restores");
        durable_collaboration_file(
            &dir.join("pending.json"),
            &serde_json::to_vec(&json!({"target":0,"request":legacy})).unwrap(),
        )
        .await
        .unwrap();
        let mut old = service.clone();
        old.insert(
            "x-hcd-collaboration-protocol",
            "hcd-semantic-blocks/3".parse().unwrap(),
        );
        assert!(matches!(
            coordinated_restore::restore(
                State(state.clone()),
                Path(("doc".into(), 0)),
                old,
                Json(legacy)
            )
            .await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        tokio::fs::remove_file(dir.join("pending.json"))
            .await
            .unwrap();
        // Recover a crash after canonical append, retaining the exact inline intent.
        durable_collaboration_file(
            &dir.join("pending.json"),
            &serde_json::to_vec(&json!({"target":0,"request":request})).unwrap(),
        )
        .await
        .unwrap();
        restore_revision(&bundle, 0, 1, Some("alice".into()), Some("Alice".into())).unwrap();
        for _ in 0..2 {
            let Json(receipt) = coordinated_restore::restore(
                State(edit_state(root.path())),
                Path(("doc".into(), 0)),
                service.clone(),
                Json(request.clone()),
            )
            .await
            .unwrap();
            assert_eq!(receipt["collaborationProtocol"], "hcd-semantic-inline/1");
            assert_eq!(receipt["collaborationEpoch"], 1);
            assert_eq!(receipt["revision"], 2);
        }
        let metadata = collaboration_metadata(&state, "doc").await.unwrap();
        assert_eq!(metadata.protocol, CollaborationProtocol::Inline1);
        assert_eq!(metadata.node_edits, Some(7));
        assert_eq!(metadata.epoch, 1);
        assert_eq!(bundle.manifest().unwrap().revision, 2);
        assert!(!coordinated_restore::pending(&state, "doc").await);
        assert_eq!(
            bundle.manifest().unwrap().root_hash,
            bundle.revision(0).unwrap().root_hash
        );
        // A downgraded client cannot even claim a committed inline receipt.
        service.remove("x-hcd-inline-containers-version");
        assert!(matches!(
            coordinated_restore::restore(
                State(state),
                Path(("doc".into(), 0)),
                service,
                Json(request)
            )
            .await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
    }

    #[tokio::test]
    async fn index_page_echoes_the_resolved_revision_after_restore_reuses_history() {
        let temp = tempfile::tempdir().unwrap();
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-layout-2026-10-26/source.docx");
        let mut options = hcd_docx::ImportOptions::new("doc");
        options.flow_layout = true;
        let path = temp.path().join("doc.hcd");
        hcd_docx::import_docx(source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(path).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        let state = edit_state(temp.path());
        let headers = edit_headers(&state, "read");
        // A restore copies the target's content-addressed index objects, whose
        // stored stamp still names the old revision; the route must answer with
        // the resolved revision so page identity matches /chunks.
        hcd_core::restore_revision(&bundle, 0, 1, Some("alice".into()), Some("Alice".into()))
            .unwrap();
        let Json(index) = index_page(
            State(state.clone()),
            Path(("doc".into(), 0)),
            Query(IndexPageQuery {
                revision: Some(2),
                word_regions: None,
                word_bodies: None,
            }),
            headers.clone(),
        )
        .await
        .unwrap();
        assert_eq!(index["revision"], 2);
        assert_eq!(index["page"], 0);
        assert_eq!(index["chunks"][0]["sequence"], 0);
    }

    #[tokio::test]
    async fn layout_coordinated_restore_pins_the_word_layout_model_and_rotates_the_epoch() {
        let root = tempfile::tempdir().unwrap();
        let bundle = word_image_bundle(root.path());
        let state = edit_state(root.path());
        write_collaboration_metadata(
            &state,
            "doc",
            &CollaborationMetadata {
                epoch: 0,
                protocol: CollaborationProtocol::WordRegions2,
                node_edits: Some(7),
                migration: None,
            },
        )
        .await
        .unwrap();
        let bytes = b"layout room before restore";
        durable_collaboration_file(
            &collaboration_current_path(&state, "doc", 0).await.unwrap(),
            bytes,
        )
        .await
        .unwrap();
        let request = coordinated_restore::Request {
            request_id: "d".repeat(32),
            expected_revision: 1,
            from_epoch: 0,
            from_protocol: Some(CollaborationProtocol::WordRegions2),
            source_hash: hash_bytes(bytes),
            author_id: "alice".into(),
            author_name: "Alice".into(),
        };
        let mut service = edit_headers_for(&state, "write", "hcd-collaboration");
        for (key, value) in [
            ("x-hcd-coordinator-version", "4"),
            ("x-hcd-collaboration-epoch", "0"),
            ("x-hcd-collaboration-protocol", "hcd-word-regions/2"),
            ("x-hcd-word-regions-version", "2"),
            ("x-hcd-word-layout-version", "1"),
            ("x-hcd-node-edits-version", "7"),
        ] {
            service.insert(key, value.parse().unwrap());
        }
        // A missing layout acknowledgement fails closed before any journal write.
        for key in [
            "x-hcd-word-regions-version",
            "x-hcd-word-layout-version",
            "x-hcd-node-edits-version",
        ] {
            let mut old = service.clone();
            old.remove(key);
            assert!(matches!(
                coordinated_restore::restore(
                    State(state.clone()),
                    Path(("doc".into(), 0)),
                    old,
                    Json(request.clone())
                )
                .await,
                Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
            ));
            assert!(!coordinated_restore::pending(&state, "doc").await);
        }
        let Json(receipt) = coordinated_restore::restore(
            State(state.clone()),
            Path(("doc".into(), 0)),
            service,
            Json(request),
        )
        .await
        .unwrap();
        assert_eq!(receipt["revision"], 2);
        assert_eq!(receipt["collaborationEpoch"], 1);
        assert_eq!(receipt["collaborationProtocol"], "hcd-word-regions/2");
        let metadata = collaboration_metadata(&state, "doc").await.unwrap();
        assert_eq!(metadata.protocol, CollaborationProtocol::WordRegions2);
        assert_eq!(metadata.node_edits, Some(7));
        assert_eq!(metadata.epoch, 1);
        assert_eq!(bundle.manifest().unwrap().revision, 2);
        assert!(!coordinated_restore::pending(&state, "doc").await);
        assert_eq!(
            bundle.manifest().unwrap().root_hash,
            bundle.revision(0).unwrap().root_hash
        );
    }

    #[tokio::test]
    async fn coordinated_restore_requires_matching_room_head_and_authority() {
        let root = tempfile::tempdir().unwrap();
        let bundle = word_image_bundle(root.path());
        let state = edit_state(root.path());
        write_collaboration_metadata(
            &state,
            "doc",
            &CollaborationMetadata {
                epoch: 0,
                protocol: CollaborationProtocol::Structure3,
                node_edits: None,
                migration: None,
            },
        )
        .await
        .unwrap();
        durable_collaboration_file(
            &collaboration_current_path(&state, "doc", 0).await.unwrap(),
            b"source",
        )
        .await
        .unwrap();
        let mut service = edit_headers_for(&state, "write", "hcd-collaboration");
        service.insert("x-hcd-coordinator-version", "4".parse().unwrap());
        service.insert("x-hcd-collaboration-epoch", "0".parse().unwrap());
        service.insert(
            "x-hcd-collaboration-protocol",
            CollaborationProtocol::Structure3.name().parse().unwrap(),
        );
        let mut request = coordinated_restore::Request {
            request_id: "b".repeat(32),
            expected_revision: 1,
            from_epoch: 0,
            from_protocol: None,
            source_hash: hash_bytes(b"wrong source"),
            author_id: "alice".into(),
            author_name: "Alice".into(),
        };
        assert!(matches!(
            coordinated_restore::restore(
                State(state.clone()),
                Path(("doc".into(), 0)),
                service.clone(),
                Json(request.clone())
            )
            .await,
            Err(ApiError(StatusCode::PRECONDITION_FAILED, _))
        ));
        request.source_hash = hash_bytes(b"source");
        request.expected_revision = 2;
        assert!(matches!(
            coordinated_restore::restore(
                State(state.clone()),
                Path(("doc".into(), 0)),
                service.clone(),
                Json(request.clone())
            )
            .await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        request.expected_revision = 1;
        let mut policy = load_access(&state, "doc").unwrap();
        policy = policy.replace(None, Some(vec!["bob".into()])).unwrap();
        store_access(&state, "doc", &policy).unwrap();
        assert!(matches!(
            coordinated_restore::restore(
                State(state.clone()),
                Path(("doc".into(), 0)),
                service.clone(),
                Json(request.clone())
            )
            .await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        assert!(!coordinated_restore::pending(&state, "doc").await);
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        assert!(matches!(
            restore(
                State(state),
                Path(("doc".into(), 0)),
                service,
                Json(ExpectedRevision {
                    expected_revision: 1
                })
            )
            .await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
    }

    fn edit_headers_for(state: &ServerState, scope: &str, user: &str) -> HeaderMap {
        edit_headers_for_doc(state, "doc", scope, user)
    }

    fn edit_headers_for_doc(
        state: &ServerState,
        document: &str,
        scope: &str,
        user: &str,
    ) -> HeaderMap {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize;
        let token = encode(
            &Header::new(Algorithm::HS256),
            &Claims {
                doc: document.into(),
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

    #[tokio::test]
    async fn access_policy_requires_manager_and_fences_only_revocations() {
        let root = tempfile::tempdir().unwrap();
        let bundle = text_bundle(root.path());
        let initial_revision = bundle.manifest().unwrap().revision;
        let state = edit_state(root.path());
        let policy = json!({"expectedGeneration":0,"readers":null,"writers":["alice"]});
        for scope in ["read", "write"] {
            let headers = edit_headers_for(&state, scope, "alice");
            assert!(matches!(
                set_access(
                    State(state.clone()),
                    Path("doc".into()),
                    headers,
                    Json(policy.clone())
                )
                .await,
                Err(ApiError(StatusCode::FORBIDDEN, _))
            ));
        }
        let manager = edit_headers_for(&state, "manage", "owner");
        assert!(authorize(&state, &manager, "doc", false).is_err());
        let Json(saved) = set_access(
            State(state.clone()),
            Path("doc".into()),
            manager.clone(),
            Json(policy.clone()),
        )
        .await
        .unwrap();
        assert_eq!(saved["collaborationEpoch"], 1);
        assert_eq!(saved["policy"]["generation"], 1);
        assert!(matches!(
            set_access(
                State(state.clone()),
                Path("doc".into()),
                manager.clone(),
                Json(policy)
            )
            .await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        let grant = json!({"expectedGeneration":1,"readers":null,"writers":["alice","bob"]});
        let Json(saved) = set_access(
            State(state.clone()),
            Path("doc".into()),
            manager.clone(),
            Json(grant),
        )
        .await
        .unwrap();
        assert_eq!(saved["collaborationEpoch"], 1);
        let revoke = json!({"expectedGeneration":2,"readers":["bob"],"writers":["bob"]});
        let Json(saved) = set_access(
            State(state.clone()),
            Path("doc".into()),
            manager,
            Json(revoke),
        )
        .await
        .unwrap();
        assert_eq!(saved["collaborationEpoch"], 2);
        assert!(authorize(
            &state,
            &edit_headers_for(&state, "write", "alice"),
            "doc",
            false
        )
        .is_err());
        authorize(
            &state,
            &edit_headers_for(&state, "write", "bob"),
            "doc",
            true,
        )
        .unwrap();
        assert_eq!(bundle.manifest().unwrap().revision, initial_revision);
    }

    #[test]
    fn revoked_access_rejects_the_same_write_token_and_keeps_reads() {
        let root = tempfile::tempdir().unwrap();
        let state = edit_state(root.path());
        let headers = edit_headers_for(&state, "write", "alice");
        authorize_claims(&state, &headers, "doc").unwrap();
        store_access(
            &state,
            "doc",
            &update_access(&load_access(&state, "doc").unwrap(), Some(vec![])).unwrap(),
        )
        .unwrap();
        let denied = authorize_claims(&state, &headers, "doc").unwrap_err();
        assert_eq!(denied.0, StatusCode::FORBIDDEN);
        assert_eq!(
            authorize_claims(&state, &headers, "doc").unwrap_err().0,
            StatusCode::FORBIDDEN
        );
        authorize(&state, &headers, "doc", false).unwrap();
        let expired = encode(
            &Header::new(Algorithm::HS256),
            &Claims {
                doc: "doc".into(),
                scope: "write".into(),
                sub: Some("alice".into()),
                name: None,
                aud: "hcd-core".into(),
                iat: 0,
                exp: 1,
            },
            &EncodingKey::from_secret(&state.secret),
        )
        .unwrap();
        let mut stale = HeaderMap::new();
        stale.insert(
            header::AUTHORIZATION,
            format!("Bearer {expired}").parse().unwrap(),
        );
        assert_eq!(
            authorize_claims(&state, &stale, "doc").unwrap_err().0,
            StatusCode::UNAUTHORIZED
        );
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
    async fn node_edit_storage_fence_rejects_unaware_reads_writes_and_checkpoints_and_survives_reset(
    ) {
        let root = tempfile::tempdir().unwrap();
        let bundle = text_bundle(root.path());
        let baseline = bundle.manifest().unwrap();
        let state = edit_state(root.path());
        let mut storage = edit_headers_for(&state, "write", "hcd-collaboration");
        storage.insert("x-hcd-collaboration-epoch", "0".parse().unwrap());
        storage.insert("x-hcd-coordinator-version", "4".parse().unwrap());
        storage.insert("x-hcd-state-hash", "none".parse().unwrap());
        storage.insert("x-hcd-node-edits-version", "1".parse().unwrap());
        let body = Bytes::from_static(b"retained node property candidates");
        let _ = collaboration_put(
            State(state.clone()),
            Path("doc".into()),
            storage.clone(),
            body.clone(),
        )
        .await
        .unwrap();
        assert_eq!(
            collaboration_metadata(&state, "doc")
                .await
                .unwrap()
                .node_edits,
            Some(1)
        );
        let path = collaboration_current_path(&state, "doc", 0).await.unwrap();
        let previous = tokio::fs::read(&path).await.unwrap();
        let mut unaware = storage.clone();
        unaware.remove("x-hcd-node-edits-version");
        unaware.insert("x-hcd-state-hash", hash_bytes(&body).parse().unwrap());
        assert!(matches!(
            collaboration_get(State(state.clone()), Path("doc".into()), unaware.clone()).await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        assert!(matches!(
            collaboration_put(
                State(state.clone()),
                Path("doc".into()),
                unaware.clone(),
                Bytes::from_static(b"must not replace candidates")
            )
            .await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        let request: SnapshotRequest = serde_json::from_value(
            json!({"expectedRevision":baseline.revision,"coordinatorVersion":4,"blocks":[]}),
        )
        .unwrap();
        assert!(matches!(
            checkpoint(
                State(state.clone()),
                Path("doc".into()),
                unaware.clone(),
                Json(request)
            )
            .await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        let mut future = storage.clone();
        future.insert("x-hcd-node-edits-version", "8".parse().unwrap());
        assert!(matches!(
            collaboration_get(State(state.clone()), Path("doc".into()), future).await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        assert_eq!(tokio::fs::read(&path).await.unwrap(), previous);
        assert_eq!(bundle.manifest().unwrap().root_hash, baseline.root_hash);
        assert_eq!(reset_collaboration(&state, "doc").await.unwrap(), 1);
        assert_eq!(
            collaboration_metadata(&state, "doc")
                .await
                .unwrap()
                .node_edits,
            Some(1)
        );
        unaware.insert("x-hcd-collaboration-epoch", "1".parse().unwrap());
        assert!(matches!(
            collaboration_get(State(state), Path("doc".into()), unaware).await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
    }

    #[test]
    fn snapshot_normalization_keeps_inline_bodies_and_never_uses_a_text_only_shortcut() {
        let content: EditorBlockContent = serde_json::from_value(json!({
            "kind":"paragraph","inlines":[{"text":"","content":{"kind":"extension","extension":{
                "schemaVersion":"hcd.extension/3","instanceId":format!("x_{:032x}",1),"type":"example.inline","version":1,
                "display":"inline","contentModel":"inline","data":{},"fallback":{"text":"Label"}
            },"inlines":[{"text":"Body","nodeId":format!("n_{:032x}",2)}]}}]
        })).unwrap();
        let plain = normalized(content.clone());
        assert!(plain.inlines[0].content.is_some());
        assert!(plain.inlines[0].content.as_ref().unwrap().inlines[0]
            .node_id
            .is_none());
        assert_eq!(normalize_content(content.clone(), true), content);
        let current = EditorProjection {
            flow_layout: None,
            flow_layout_hash: None,
            document_id: "inline".into(),
            revision: 1,
            blocks: vec![hcd_core::EditorBlockView {
                flow_region_id: None,
                block_id: format!("n_{:032x}", 1),
                block_hash: "hash".into(),
                region: "body".into(),
                read_only: false,
                content: content.clone(),
                read_only_html: None,
            }],
            tracked_changes: vec![],
            comments: vec![],
        };
        let mut after = content;
        after.inlines[0].content.as_mut().unwrap().inlines[0].text = "Edited".into();
        let requested = vec![SnapshotBlock {
            block_id: Some(current.blocks[0].block_id.clone()),
            content: after,
        }];
        assert!(text_only_operations(&current, &requested).is_none());
        assert!(presentation_style_operations(&current, &requested).is_none());
    }

    #[test]
    fn editable_inline_containers_require_explicit_model_acknowledgement() {
        let mut headers = HeaderMap::new();
        assert!(require_inline_containers_support(false, &headers).is_ok());
        assert!(matches!(
            require_inline_containers_support(true, &headers),
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        for version in ["0", "2", "3", "unknown"] {
            headers.insert("x-hcd-inline-containers-version", version.parse().unwrap());
            assert!(require_inline_containers_support(false, &headers).is_err());
        }
        headers.insert("x-hcd-inline-containers-version", "1".parse().unwrap());
        assert!(require_inline_containers_support(true, &headers).is_ok());
    }

    #[test]
    fn flow_layout_requires_explicit_acknowledgement_without_enabling_structural_snapshots() {
        let mut headers = HeaderMap::new();
        assert!(require_flow_layout_support(None, &headers).is_ok());
        assert!(matches!(
            require_flow_layout_support(Some(1), &headers),
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        for version in ["0", "3", "unknown"] {
            headers.insert("x-hcd-flow-layout-version", version.parse().unwrap());
            assert!(require_flow_layout_support(None, &headers).is_err());
        }
        headers.insert("x-hcd-flow-layout-version", "1".parse().unwrap());
        assert!(require_flow_layout_support(Some(1), &headers).is_ok());
        assert!(require_flow_layout_support(Some(2), &headers).is_err());
        headers.insert("x-hcd-flow-layout-version", "2".parse().unwrap());
        assert!(require_flow_layout_support(Some(2), &headers).is_ok());
        assert!(require_flow_layout_support(Some(1), &headers).is_err());
    }

    #[test]
    fn custom_text_marks_require_explicit_model_acknowledgement() {
        let mut headers = HeaderMap::new();
        assert!(require_custom_marks_support(false, &headers).is_ok());
        assert!(matches!(
            require_custom_marks_support(true, &headers),
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        headers.insert("x-hcd-custom-marks-version", "2".parse().unwrap());
        assert!(require_custom_marks_support(false, &headers).is_err());
        headers.insert("x-hcd-custom-marks-version", "1".parse().unwrap());
        assert!(require_custom_marks_support(true, &headers).is_ok());
    }

    #[tokio::test]
    async fn schema_transition_model_cannot_be_downgraded_by_a_property_only_coordinator() {
        for (required, older) in [
            (2, "1"),
            (3, "2"),
            (4, "3"),
            (4, "2"),
            (4, "1"),
            (5, "4"),
            (5, "3"),
            (5, "1"),
            (6, "5"),
            (6, "4"),
            (6, "3"),
            (6, "2"),
            (6, "1"),
            (7, "6"),
            (7, "5"),
            (7, "1"),
        ] {
            let root = tempfile::tempdir().unwrap();
            let bundle = text_bundle(root.path());
            let before = bundle.manifest().unwrap();
            let state = edit_state(root.path());
            let mut headers = edit_headers_for(&state, "write", "hcd-collaboration");
            for (key, value) in [
                ("x-hcd-collaboration-epoch", "0"),
                ("x-hcd-coordinator-version", "4"),
                ("x-hcd-state-hash", "none"),
                (
                    "x-hcd-node-edits-version",
                    match required {
                        2 => "2",
                        3 => "3",
                        4 => "4",
                        5 => "5",
                        6 => "6",
                        _ => "7",
                    },
                ),
            ] {
                headers.insert(key, value.parse().unwrap());
            }
            let body = Bytes::from_static(b"retained schema transition and old-version candidates");
            let _ = collaboration_put(
                State(state.clone()),
                Path("doc".into()),
                headers.clone(),
                body.clone(),
            )
            .await
            .unwrap();
            assert_eq!(
                collaboration_metadata(&state, "doc")
                    .await
                    .unwrap()
                    .node_edits,
                Some(required)
            );
            let path = collaboration_current_path(&state, "doc", 0).await.unwrap();
            headers.insert("x-hcd-state-hash", hash_bytes(&body).parse().unwrap());
            headers.insert("x-hcd-node-edits-version", older.parse().unwrap());
            assert!(matches!(
                collaboration_get(State(state.clone()), Path("doc".into()), headers.clone()).await,
                Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
            ));
            assert!(matches!(
                collaboration_put(
                    State(state.clone()),
                    Path("doc".into()),
                    headers.clone(),
                    Bytes::from_static(b"must not flatten schema candidates")
                )
                .await,
                Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
            ));
            let request = serde_json::from_value(
                json!({"expectedRevision":before.revision,"coordinatorVersion":4,"blocks":[]}),
            )
            .unwrap();
            assert!(matches!(
                checkpoint(
                    State(state.clone()),
                    Path("doc".into()),
                    headers.clone(),
                    Json(request)
                )
                .await,
                Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
            ));
            assert_eq!(tokio::fs::read(&path).await.unwrap(), body);
            assert_eq!(bundle.manifest().unwrap().root_hash, before.root_hash);
            assert_eq!(reset_collaboration(&state, "doc").await.unwrap(), 1);
            assert_eq!(
                collaboration_metadata(&state, "doc")
                    .await
                    .unwrap()
                    .node_edits,
                Some(required)
            );
            headers.insert("x-hcd-collaboration-epoch", "1".parse().unwrap());
            assert!(matches!(
                collaboration_get(State(state), Path("doc".into()), headers).await,
                Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
            ));
        }
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
        std::fs::create_dir(root.path().join("sources")).unwrap();
        std::fs::copy(&source, root.path().join("sources/doc.docx")).unwrap();
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

    #[test]
    fn snapshot_source_plans_support_join_split_and_prefer_the_surviving_owner_over_shared_fragments(
    ) {
        let mut current = projection();
        let first_id = format!("n_{:032x}", 1);
        let second_id = format!("n_{:032x}", 2);
        current.blocks[0].content.inlines[0].node_id = Some(first_id.clone());
        let mut second = current.blocks[0].clone();
        second.block_id = "second".into();
        second.content.inlines[0].text = "Second".into();
        second.content.inlines[0].node_id = Some(second_id.clone());
        current.blocks.push(second);
        let first = current.blocks[0].content.clone();
        let second = current.blocks[1].content.clone();
        let mut joined = first.clone();
        joined.inlines.extend(second.inlines.clone());
        let joined_request = vec![SnapshotBlock {
            block_id: Some(current.blocks[0].block_id.clone()),
            content: joined.clone(),
        }];
        let plan = snapshot_source_plans(&current, &joined_request).unwrap();
        assert_eq!(plan[&0].inlines[1].node_id, Some(second_id.clone()));
        current.blocks.truncate(1);
        current.blocks[0].content = joined;
        let split_request = vec![
            SnapshotBlock {
                block_id: Some(current.blocks[0].block_id.clone()),
                content: first.clone(),
            },
            SnapshotBlock {
                block_id: None,
                content: second,
            },
        ];
        let plan = snapshot_source_plans(&current, &split_request).unwrap();
        assert_eq!(plan[&1].inlines[0].node_id, Some(second_id));
        current.blocks[0].content = first.clone();
        let mut prefix = first.clone();
        prefix.inlines[0].text = "Prefix".into();
        let mut suffix = first;
        suffix.inlines[0].text = "Suffix".into();
        let plan = snapshot_source_plans(
            &current,
            &[
                SnapshotBlock {
                    block_id: Some(current.blocks[0].block_id.clone()),
                    content: prefix,
                },
                SnapshotBlock {
                    block_id: None,
                    content: suffix,
                },
            ],
        )
        .unwrap();
        assert_eq!(plan[&0].inlines[0].node_id, Some(first_id));
        assert_eq!(plan[&1].inlines[0].node_id, None);
    }

    fn projection() -> EditorProjection {
        EditorProjection {
            flow_layout: None,
            flow_layout_hash: None,
            document_id: "doc".to_string(),
            revision: 1,
            blocks: vec![EditorBlockView {
                flow_region_id: None,
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

    #[test]
    fn legacy_field_snapshot_cannot_change_or_remove_protected_block() {
        let current = projection();
        let protected = HashSet::from([current.blocks[0].content.inlines[0]
            .node_id
            .clone()
            .unwrap()]);
        let original = SnapshotBlock {
            block_id: Some("block".into()),
            content: current.blocks[0].content.clone(),
        };
        assert!(validate_legacy_word_snapshot(&current, &[original.clone()], &protected).is_ok());
        let mut edited = original.clone();
        edited.content.inlines[0].text = "changed".into();
        assert!(validate_legacy_word_snapshot(&current, &[edited], &protected).is_err());
        assert!(validate_legacy_word_snapshot(&current, &[], &protected).is_err());
        assert!(
            validate_legacy_word_snapshot(&current, &[original.clone(), original], &protected)
                .is_err()
        );
        assert!(validate_legacy_word_snapshot(&current, &[], &HashSet::new()).is_ok());
    }

    #[tokio::test]
    async fn legacy_docx_source_guard_rejects_field_patch_and_replays_normal_save() {
        use std::io::Write;
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("sources")).unwrap();
        let source = root.path().join("sources/doc.docx");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&source).unwrap());
        for (name, data) in [
            (
                "[Content_Types].xml",
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
            ),
            (
                "word/document.xml",
                r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Normal</w:t></w:r></w:p><w:p><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:body></w:document>"#,
            ),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(data.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        let fresh_path = root.path().join("fresh.hcd");
        let manifest = hcd_docx::import_docx(
            &source,
            &fresh_path,
            &hcd_docx::ImportOptions::new("doc"),
            |_| Ok(()),
        )
        .unwrap();
        let fresh = Bundle::open(fresh_path).unwrap();
        let descriptor = &fresh.read_index_page(&manifest, 0).unwrap().chunks[0];
        let mut map = fresh.read_map_verified(descriptor).unwrap();
        let field = map
            .entries
            .iter_mut()
            .find(|entry| entry.source.text_ordinal == 2)
            .unwrap();
        field.source.editable = true;
        let field_id = field.node_id.clone();
        let field_hash = field.node_hash.clone();
        let normal = map
            .entries
            .iter()
            .find(|entry| entry.source.text_ordinal == 1)
            .unwrap();
        let normal_id = normal.node_id.clone();
        let normal_hash = normal.node_hash.clone();
        let html = fresh
            .read_chunk_verified(descriptor)
            .unwrap()
            .replace(" data-hcd-computed-field=\"1\"", "");
        let mut writer = hcd_core::BundleWriter::create(root.path().join("doc.hcd")).unwrap();
        writer.write_styles("").unwrap();
        writer
            .write_chunk(map.chunk_id.clone(), "body".into(), html, map, 2, false)
            .unwrap();
        writer.finish(manifest).unwrap();
        let state = edit_state(root.path());
        let original_source = std::fs::read(&source).unwrap();
        std::fs::remove_file(&source).unwrap();
        let reader = edit_headers(&state, "read");
        let writer_headers = edit_headers(&state, "write");
        let status = word_source_status(State(state.clone()), Path("doc".into()), reader.clone())
            .await
            .unwrap()
            .into_response();
        let bytes = axum::body::to_bytes(status.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap()["status"],
            "missing"
        );
        assert!(matches!(
            word_restore_source(
                State(state.clone()),
                Path("doc".into()),
                reader,
                Body::from(original_source.clone())
            )
            .await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        assert!(
            matches!(word_restore_source(State(state.clone()), Path("doc".into()), writer_headers.clone(), Body::from("wrong file")).await, Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, reason)) if reason == "DOCX_SOURCE_CHANGED")
        );
        assert!(!source.exists());
        let Json(restored) = word_restore_source(
            State(state.clone()),
            Path("doc".into()),
            writer_headers.clone(),
            Body::from(original_source.clone()),
        )
        .await
        .unwrap();
        assert_eq!(restored["alreadyPresent"], false);
        let Json(replayed) = word_restore_source(
            State(state.clone()),
            Path("doc".into()),
            writer_headers.clone(),
            Body::from(original_source.clone()),
        )
        .await
        .unwrap();
        assert_eq!(replayed["alreadyPresent"], true);
        let status = word_source_status(
            State(state.clone()),
            Path("doc".into()),
            edit_headers(&state, "read"),
        )
        .await
        .unwrap()
        .into_response();
        let bytes = axum::body::to_bytes(status.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap()["status"],
            "present"
        );
        let mut wrong_existing = original_source.clone();
        wrong_existing[0] ^= 1;
        std::fs::write(&source, &wrong_existing).unwrap();
        let status = word_source_status(
            State(state.clone()),
            Path("doc".into()),
            edit_headers(&state, "read"),
        )
        .await
        .unwrap()
        .into_response();
        let bytes = axum::body::to_bytes(status.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap()["status"],
            "invalid"
        );
        assert!(
            matches!(word_restore_source(State(state.clone()), Path("doc".into()), writer_headers, Body::from(original_source.clone())).await,
            Err(ApiError(StatusCode::CONFLICT, reason)) if reason == "DOCX_SOURCE_CONFLICT")
        );
        assert_eq!(std::fs::read(&source).unwrap(), wrong_existing);
        std::fs::write(&source, &original_source).unwrap();
        let bundle = Bundle::open(root.path().join("doc.hcd")).unwrap();
        let current = editor_projection(&bundle, None).unwrap();
        let protected = hcd_docx::legacy_read_only_nodes(&bundle, &source).unwrap();
        let field_block = current
            .blocks
            .iter()
            .find(|block| {
                snapshot_source_inlines(&block.content)
                    .iter()
                    .any(|inline| inline.node_id.as_deref() == Some(field_id.as_str()))
            })
            .unwrap();
        let block_id = field_block.block_id.clone();
        let mut snapshot: Vec<_> = editor_surface(&current)
            .into_iter()
            .map(|block| SnapshotBlock {
                block_id: Some(block.block_id.clone()),
                content: block.content.clone(),
            })
            .collect();
        snapshot
            .iter_mut()
            .find(|block| block.block_id.as_deref() == Some(block_id.as_str()))
            .unwrap()
            .content
            .inlines[0]
            .text = "changed".into();
        let response = validate_legacy_word_snapshot(&current, &snapshot, &protected)
            .unwrap_err()
            .into_response();
        assert_eq!(response.headers()["x-hcd-protected-block"], block_id);
        let patch = |id: String, hash: String, patch_id: &str| PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION_3.into(),
            document_id: "doc".into(),
            patch_id: patch_id.into(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: id,
                start: 0,
                delete_count: 0,
                insert_text: "new ".into(),
                precondition: NodePrecondition { node_hash: hash },
            }],
        };
        std::fs::remove_file(&source).unwrap();
        let missing = apply_editor_edits(
            &state,
            "doc",
            patch(normal_id.clone(), normal_hash.clone(), "missing-source"),
        )
        .await
        .unwrap_err();
        assert_eq!(missing.0, StatusCode::UNPROCESSABLE_ENTITY);
        let missing = missing.into_response();
        assert_eq!(
            missing.headers()["x-hcd-error-code"],
            "DOCX_SOURCE_REQUIRED"
        );
        assert_eq!(bundle.manifest().unwrap().revision, 0);
        std::fs::write(&source, original_source.clone()).unwrap();
        assert!(
            matches!(apply_editor_edits(&state, "doc", patch(field_id.clone(), field_hash.clone(), "field")).await,
            Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, reason)) if reason == "DOCX_SOURCE_TEXT_READ_ONLY")
        );
        let proof = word_source_proof::read(&bundle, root.path(), &state.secret)
            .unwrap()
            .unwrap();
        assert!(proof.contains(&field_id));
        // The freshly imported map has the same source identity but a different
        // editable flag; an attestation for the legacy map cannot authorize it.
        assert!(word_source_proof::read(&fresh, root.path(), &state.secret)
            .unwrap()
            .is_none());
        assert!(
            word_source_proof::read(&bundle, root.path(), b"different secret")
                .unwrap()
                .is_none()
        );
        let proof_path = root.path().join("word-source-proofs/doc.jwt");
        let saved_proof = std::fs::read(&proof_path).unwrap();
        std::fs::write(&proof_path, [0xff, 0xfe]).unwrap();
        assert!(word_source_proof::read(&bundle, root.path(), &state.secret)
            .unwrap()
            .is_none());
        std::fs::remove_file(&source).unwrap();
        assert!(
            matches!(apply_editor_edits(&state, "doc", patch(normal_id.clone(), normal_hash.clone(), "corrupt-proof")).await,
            Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, reason)) if reason == "DOCX_SOURCE_REQUIRED")
        );
        std::fs::write(&proof_path, saved_proof).unwrap();
        assert!(
            matches!(apply_editor_edits(&state, "doc", patch(field_id, field_hash, "field-unsourced")).await,
            Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, reason)) if reason == "DOCX_SOURCE_TEXT_READ_ONLY")
        );
        let normal = patch(normal_id.clone(), normal_hash, "normal");
        let Json(saved) = apply_editor_edits(&state, "doc", normal.clone())
            .await
            .unwrap();
        assert_eq!(saved["revision"], 1);
        assert!(word_source_proof::read(&bundle, root.path(), &state.secret)
            .unwrap()
            .is_some());
        let current = hcd_core::get_text_node(&bundle, &normal_id).unwrap().node;
        let mut second = patch(normal_id, current.node_hash, "unsourced-second");
        second.base_revision = 1;
        let Json(next) = apply_editor_edits(&state, "doc", second).await.unwrap();
        assert_eq!(next["revision"], 2);
        let Json(replayed) = apply_editor_edits(&state, "doc", normal).await.unwrap();
        assert_eq!(replayed["idempotentReplay"], true);
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
            word_owners: word_owner::WordOwners::default(),
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
    fn structural_snapshot_normalization_preserves_distinct_sources_and_splits_only_one_binding() {
        let source = |number| format!("n_{number:032x}");
        let before = EditorBlockContent {
            inlines: vec![
                EditorInline {
                    text: "Repeated ".into(),
                    node_id: Some(source(1)),
                    ..Default::default()
                },
                EditorInline {
                    text: "Repeated".into(),
                    node_id: Some(source(2)),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        assert_eq!(normalized(before.clone()).inlines.len(), 1);
        let mut desired = before.clone();
        desired.kind = EditorBlockKind::Heading;
        desired.level = Some(2);
        desired.inlines.push(EditorInline {
            text: " tail".into(),
            node_id: Some(source(2)),
            italic: true,
            ..Default::default()
        });
        let replacement =
            hcd_core::retain_replacement_sources(&before, normalize_content(desired, true))
                .unwrap();
        assert_eq!(replacement.inlines[0].node_id, Some(source(1)));
        assert_eq!(replacement.inlines[1].node_id, Some(source(2)));
        assert_eq!(replacement.inlines[2].node_id, None);
        let mut unknown = before.clone();
        unknown.kind = EditorBlockKind::Heading;
        unknown.level = Some(1);
        unknown.inlines[1].node_id = Some(source(3));
        assert!(
            hcd_core::retain_replacement_sources(&before, normalize_content(unknown, true))
                .is_err()
        );
    }

    #[test]
    fn extension_payload_edits_never_use_text_only_or_source_run_shortcuts() {
        let envelope: hcd_core::ExtensionNode = serde_json::from_value(json!({
            "schemaVersion":"hcd.extension/1", "instanceId":format!("x_{}", "1".repeat(32)),
            "type":"example.task", "version":1, "display":"inline", "data":{"done":false},
            "fallback":{"text":"Task"}
        }))
        .unwrap();
        let mut current = projection();
        current.blocks[0].content.inlines[0].text = "Task".into();
        current.blocks[0].content.inlines[0].extension = Some(envelope.clone());
        let mut desired = current.blocks[0].content.clone();
        // Even when visible text is identical, changed business fields must be saved.
        desired.inlines[0].extension.as_mut().unwrap().data = json!({"done":true});
        let requested = vec![SnapshotBlock {
            block_id: Some("block".into()),
            content: desired.clone(),
        }];
        assert!(text_only_operations(&current, &requested).is_none());
        assert!(
            !source_changes(&current.blocks[0].content, &desired, &mut BTreeMap::new()).unwrap()
        );
        let mut before = current.blocks[0].content.clone();
        before.kind = EditorBlockKind::Extension;
        before.extension = Some(hcd_core::ExtensionNode {
            display: hcd_core::ExtensionDisplay::Block,
            ..envelope
        });
        before.inlines[0].extension = None;
        let mut after = before.clone();
        after.extension.as_mut().unwrap().data = json!({"done":true});
        after.extension.as_mut().unwrap().fallback.text = "Changed task".into();
        after.inlines[0].text = "Changed task".into();
        after.inlines[0].node_id = None;
        // A changed fallback has no source receipt yet, but is a valid atom.
        // Return structural fallback instead of rejecting missing text identity.
        assert!(!source_changes(&before, &after, &mut BTreeMap::new()).unwrap());
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
            flow_region_id: None,
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
    fn protocol_migration_headers(state: &ServerState, source_hash: &str, id: &str) -> HeaderMap {
        let mut headers = edit_headers_for(state, "write", "hcd-collaboration");
        for (name, value) in [
            ("x-hcd-coordinator-version", "4"),
            ("x-hcd-collaboration-epoch", "0"),
            ("x-hcd-state-hash", source_hash),
            ("x-hcd-target-protocol", "hcd-semantic-blocks/3"),
            ("x-hcd-base-revision", "1"),
            ("x-hcd-migration-id", id),
        ] {
            headers.insert(name, value.parse().unwrap());
        }
        headers
    }
    fn inline_bootstrap_headers(state: &ServerState) -> HeaderMap {
        let mut headers = protocol_migration_headers(state, "none", &"c".repeat(32));
        for (key, value) in [
            ("x-hcd-target-protocol", "hcd-semantic-inline/1"),
            ("x-hcd-inline-containers-version", "1"),
            ("x-hcd-extension-version", "3"),
            ("x-hcd-node-edits-version", "7"),
        ] {
            headers.insert(key, value.parse().unwrap());
        }
        headers
    }
    #[tokio::test]
    async fn inline_bootstrap_acknowledges_model_and_replays_without_replacing_newer_state() {
        let root = tempfile::tempdir().unwrap();
        let bundle = text_bundle(root.path());
        let state = edit_state(root.path());
        let mut manifest = bundle.manifest().unwrap();
        manifest.capabilities.extension_nodes = Some(3);
        bundle.write_manifest(&manifest).unwrap();
        let headers = inline_bootstrap_headers(&state);
        let bytes = Bytes::from_static(b"inline state validated by sidecar");
        for key in [
            "x-hcd-inline-containers-version",
            "x-hcd-extension-version",
            "x-hcd-node-edits-version",
        ] {
            let mut old = headers.clone();
            old.remove(key);
            assert!(matches!(
                collaboration_migrate(State(state.clone()), Path("doc".into()), old, bytes.clone())
                    .await,
                Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
            ));
        }
        let Json(result) = collaboration_migrate(
            State(state.clone()),
            Path("doc".into()),
            headers.clone(),
            bytes.clone(),
        )
        .await
        .unwrap();
        assert_eq!(result["collaborationProtocol"], "hcd-semantic-inline/1");
        assert_eq!(result["collaborationEpoch"], 1);
        let metadata = collaboration_metadata(&state, "doc").await.unwrap();
        assert_eq!(metadata.node_edits, Some(7));
        let Json(auth) = auth_check(
            State(state.clone()),
            Path("doc".into()),
            edit_headers(&state, "read"),
        )
        .await
        .unwrap();
        assert_eq!(auth["coordinatedRestore"], true);
        let mut current = headers.clone();
        current.insert("x-hcd-collaboration-epoch", "1".parse().unwrap());
        current.insert(
            "x-hcd-collaboration-protocol",
            "hcd-semantic-inline/1".parse().unwrap(),
        );
        let mut old = current.clone();
        old.remove("x-hcd-inline-containers-version");
        assert!(matches!(
            collaboration_get(State(state.clone()), Path("doc".into()), old).await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        let newer = Bytes::from_static(b"newer inline peer input");
        current.insert("x-hcd-state-hash", hash_bytes(&bytes).parse().unwrap());
        let _ = collaboration_put(
            State(state.clone()),
            Path("doc".into()),
            current.clone(),
            newer.clone(),
        )
        .await
        .unwrap();
        let Json(replay) = collaboration_migrate(
            State(state.clone()),
            Path("doc".into()),
            headers.clone(),
            bytes.clone(),
        )
        .await
        .unwrap();
        assert_eq!(replay["idempotentReplay"], true);
        let response = collaboration_get(State(state.clone()), Path("doc".into()), current)
            .await
            .unwrap();
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 1024)
                .await
                .unwrap(),
            newer
        );
        let mut cross = headers;
        cross.insert(
            "x-hcd-target-protocol",
            "hcd-semantic-blocks/3".parse().unwrap(),
        );
        assert!(matches!(
            collaboration_migrate(State(state.clone()), Path("doc".into()), cross, bytes).await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        assert_eq!(bundle.manifest().unwrap().revision, 1);
    }
    #[tokio::test]
    async fn inline_bootstrap_never_discards_durable_drafts_or_infers_model_three() {
        let root = tempfile::tempdir().unwrap();
        let bundle = text_bundle(root.path());
        let state = edit_state(root.path());
        let headers = inline_bootstrap_headers(&state);
        let bytes = Bytes::from_static(b"inline candidate");
        assert!(matches!(
            collaboration_migrate(
                State(state.clone()),
                Path("doc".into()),
                headers.clone(),
                bytes.clone()
            )
            .await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        let mut manifest = bundle.manifest().unwrap();
        manifest.capabilities.extension_nodes = Some(3);
        bundle.write_manifest(&manifest).unwrap();
        let old = Bytes::from_static(b"uncommitted existing draft");
        let _ = collaboration_put(
            State(state.clone()),
            Path("doc".into()),
            headers.clone(),
            old.clone(),
        )
        .await
        .unwrap();
        let mut attempt = headers;
        attempt.insert("x-hcd-state-hash", hash_bytes(&old).parse().unwrap());
        assert!(matches!(
            collaboration_migrate(State(state.clone()), Path("doc".into()), attempt, bytes).await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        assert_eq!(
            collaboration_metadata(&state, "doc").await.unwrap().epoch,
            0
        );
        assert_eq!(
            std::fs::read(collaboration_current_path(&state, "doc", 0).await.unwrap()).unwrap(),
            old
        );
    }
    #[tokio::test]
    async fn protocol_migration_fences_old_writers_preserves_recovery_and_replays_lost_responses() {
        let root = tempfile::tempdir().unwrap();
        let bundle = text_bundle(root.path());
        let state = edit_state(root.path());
        let old = Bytes::from_static(b"legacy durable draft");
        let new = Bytes::from_static(b"structural durable draft");
        let mut headers = protocol_migration_headers(&state, "none", &"a".repeat(32));
        let _ = collaboration_put(
            State(state.clone()),
            Path("doc".into()),
            headers.clone(),
            old.clone(),
        )
        .await
        .unwrap();
        headers.insert("x-hcd-state-hash", hash_bytes(&old).parse().unwrap());
        let Json(result) = collaboration_migrate(
            State(state.clone()),
            Path("doc".into()),
            headers.clone(),
            new.clone(),
        )
        .await
        .unwrap();
        assert_eq!(result["collaborationEpoch"], 1);
        assert_eq!(result["collaborationProtocol"], "hcd-semantic-blocks/3");
        assert_eq!(result["idempotentReplay"], false);
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        let Json(access) = auth_check(
            State(state.clone()),
            Path("doc".into()),
            edit_headers(&state, "read"),
        )
        .await
        .unwrap();
        assert_eq!(access["collaborationProtocol"], "hcd-semantic-blocks/3");
        assert!(matches!(
            collaboration_put(
                State(state.clone()),
                Path("doc".into()),
                headers.clone(),
                old.clone()
            )
            .await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        let mut current = headers.clone();
        current.insert("x-hcd-collaboration-epoch", "1".parse().unwrap());
        assert!(matches!(
            collaboration_get(State(state.clone()), Path("doc".into()), current.clone()).await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        let snapshot = serde_json::from_value(
            json!({"typographyVersion":2,"coordinatorVersion":4,"expectedRevision":1,"blocks":[]}),
        )
        .unwrap();
        assert!(matches!(
            checkpoint(
                State(state.clone()),
                Path("doc".into()),
                current.clone(),
                Json(snapshot)
            )
            .await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        current.insert(
            "x-hcd-collaboration-protocol",
            "hcd-default/1".parse().unwrap(),
        );
        assert!(matches!(
            collaboration_get(State(state.clone()), Path("doc".into()), current.clone()).await,
            Err(ApiError(StatusCode::UPGRADE_REQUIRED, _))
        ));
        current.insert(
            "x-hcd-collaboration-protocol",
            "hcd-semantic-blocks/3".parse().unwrap(),
        );
        current.insert("x-hcd-state-hash", hash_bytes(&new).parse().unwrap());
        let response = collaboration_get(State(state.clone()), Path("doc".into()), current.clone())
            .await
            .unwrap();
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 1024)
                .await
                .unwrap(),
            new
        );
        let Json(recoveries) = collaboration_recoveries(
            State(state.clone()),
            Path("doc".into()),
            edit_headers(&state, "read"),
        )
        .await
        .unwrap();
        let id = recoveries["recoveries"][0].as_str().unwrap().to_string();
        let response = collaboration_recovery(
            State(state.clone()),
            Path(("doc".into(), id)),
            edit_headers(&state, "read"),
        )
        .await
        .unwrap();
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 1024)
                .await
                .unwrap(),
            old
        );
        let newer = Bytes::from_static(b"structural newer peer input");
        let _ = collaboration_put(
            State(state.clone()),
            Path("doc".into()),
            current.clone(),
            newer.clone(),
        )
        .await
        .unwrap();
        let Json(replay) = collaboration_migrate(
            State(state.clone()),
            Path("doc".into()),
            headers.clone(),
            new.clone(),
        )
        .await
        .unwrap();
        assert_eq!(replay["idempotentReplay"], true);
        let response = collaboration_get(State(state.clone()), Path("doc".into()), current.clone())
            .await
            .unwrap();
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 1024)
                .await
                .unwrap(),
            newer
        );
        assert!(matches!(
            collaboration_migrate(
                State(state.clone()),
                Path("doc".into()),
                headers.clone(),
                Bytes::from_static(b"different body")
            )
            .await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        let _ = collaboration_reset(State(state.clone()), Path("doc".into()), current)
            .await
            .unwrap();
        let metadata = collaboration_metadata(&state, "doc").await.unwrap();
        assert_eq!(metadata.epoch, 2);
        assert_eq!(metadata.protocol, CollaborationProtocol::Structure3);
        assert!(metadata.migration.is_none());
        assert!(matches!(
            collaboration_migrate(State(state), Path("doc".into()), headers, new).await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
    }
    #[tokio::test]
    async fn protocol_migration_has_one_cas_winner_and_rejects_changed_heads_and_sources() {
        let root = tempfile::tempdir().unwrap();
        text_bundle(root.path());
        let state = edit_state(root.path());
        let new = Bytes::from_static(b"new structure");
        let headers = protocol_migration_headers(&state, "none", &"a".repeat(32));
        let mut invalid = headers.clone();
        invalid.insert("x-hcd-base-revision", "0".parse().unwrap());
        assert!(matches!(
            collaboration_migrate(
                State(state.clone()),
                Path("doc".into()),
                invalid,
                new.clone()
            )
            .await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        let mut invalid = headers.clone();
        invalid.insert("x-hcd-state-hash", "b".repeat(64).parse().unwrap());
        assert!(matches!(
            collaboration_migrate(
                State(state.clone()),
                Path("doc".into()),
                invalid,
                new.clone()
            )
            .await,
            Err(ApiError(StatusCode::PRECONDITION_FAILED, _))
        ));
        let mut unauthorized = headers.clone();
        unauthorized.insert(
            header::AUTHORIZATION,
            edit_headers(&state, "write")[header::AUTHORIZATION].clone(),
        );
        assert!(matches!(
            collaboration_migrate(
                State(state.clone()),
                Path("doc".into()),
                unauthorized,
                new.clone()
            )
            .await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        assert!(matches!(
            collaboration_migrate(
                State(state.clone()),
                Path("doc".into()),
                headers.clone(),
                Bytes::new()
            )
            .await,
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        assert_eq!(
            collaboration_metadata(&state, "doc").await.unwrap(),
            CollaborationMetadata::default()
        );
        let other = protocol_migration_headers(&state, "none", &"b".repeat(32));
        let (a, b) = tokio::join!(
            collaboration_migrate(
                State(state.clone()),
                Path("doc".into()),
                headers,
                new.clone()
            ),
            collaboration_migrate(State(state.clone()), Path("doc".into()), other, new)
        );
        assert!(a.is_ok() ^ b.is_ok());
        assert_eq!(collaboration_epoch(&state, "doc").await.unwrap(), 1);
        assert!(matches!(
            a.err().or(b.err()),
            Some(ApiError(StatusCode::CONFLICT, _))
        ));
    }
    #[tokio::test]
    async fn unpublished_migration_state_is_never_adopted_by_a_later_reset() {
        let root = tempfile::tempdir().unwrap();
        text_bundle(root.path());
        let state = edit_state(root.path());
        let orphan = state
            .root
            .join("collaboration")
            .join(format!("doc.epoch-1.{}.bin", "a".repeat(32)));
        durable_collaboration_file(&orphan, b"unpublished structural state")
            .await
            .unwrap();
        let epoch = reset_collaboration(&state, "doc").await.unwrap();
        assert_eq!(epoch, 1);
        assert_eq!(
            collaboration_metadata(&state, "doc")
                .await
                .unwrap()
                .protocol,
            CollaborationProtocol::Default1
        );
        assert_ne!(
            collaboration_current_path(&state, "doc", epoch)
                .await
                .unwrap(),
            orphan
        );
        let mut reader = edit_headers(&state, "read");
        reader.insert("x-hcd-collaboration-epoch", "1".parse().unwrap());
        assert!(matches!(
            collaboration_get(State(state), Path("doc".into()), reader).await,
            Err(ApiError(StatusCode::NOT_FOUND, _))
        ));
    }
}
