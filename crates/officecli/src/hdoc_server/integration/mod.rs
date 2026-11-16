//! Host-owned identity/files, engine-owned durable editing state.
mod policy;
mod provider;
mod publication;
mod store;
#[cfg(test)]
mod tests;

use super::*;
use provider::{Descriptor, Provider};
use store::{Mapping, Publication, Session};
use subtle::ConstantTimeEq;

pub(super) use policy::guard;
pub(super) use publication::{publication_status, publish, start_events};
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

pub(super) struct Integration {
    provider: Provider,
    store: store::Store,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_secs()
}
fn external_id(value: &str) -> bool {
    !value.is_empty() && value.chars().count() <= 256 && !value.chars().any(char::is_control)
}
fn valid_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
fn sha256_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
fn denied(message: &str) -> ApiError {
    ApiError(StatusCode::FORBIDDEN, message.into())
}
fn unavailable(message: &str) -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE, message.into())
}
fn conflict(message: &str) -> ApiError {
    ApiError(StatusCode::CONFLICT, message.into())
}
fn configured(state: &ServerState) -> Result<&Integration, ApiError> {
    state.integration.as_deref().ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            "host integration is not configured".into(),
        )
    })
}

impl Integration {
    pub(super) fn open(path: &std::path::Path, root: &std::path::Path) -> Result<Self> {
        let provider = Provider::load(path)?;
        let store = store::Store::open(root, &provider.config)?;
        Ok(Self {
            provider,
            store,
            locks: Default::default(),
        })
    }

    async fn lock(&self, document_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = self
            .locks
            .lock()
            .await
            .entry(document_id.into())
            .or_default()
            .clone();
        lock.lock_owned().await
    }

    pub(super) fn validate_actor(&self, actor: &Claims) -> Result<(), ApiError> {
        let managed = self.store.mapping(&actor.doc).is_some();
        if actor.integration_session.is_none() && !managed {
            return Ok(());
        }
        if actor.integration_session.is_none() && actor.sub.as_deref() == Some("hcd-collaboration")
        {
            // The HTTP middleware restricts this trusted service to persistence
            // of already accepted updates and projection/room maintenance.
            return Ok(());
        }
        let session = self.store.session(
            actor
                .integration_session
                .as_deref()
                .ok_or_else(|| denied("managed documents require a host session"))?,
        )?;
        if !managed
            || session.document_id != actor.doc
            || actor.sub.as_deref() != Some(session.subject().as_str())
            || actor.exp as u64 > session.expires_at
            || actor.exp as u64 <= now()
        {
            return Err(denied("host session binding mismatch"));
        }
        Ok(())
    }

    fn service(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        if headers.contains_key(header::ORIGIN) {
            return Err(denied("session exchange is server-to-server"));
        }
        let token = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or("");
        if !bool::from(token.as_bytes().ct_eq(&self.provider.service_secret)) {
            return Err(ApiError(
                StatusCode::UNAUTHORIZED,
                "integration service credential required".into(),
            ));
        }
        Ok(())
    }

    fn session(
        &self,
        state: &ServerState,
        headers: &HeaderMap,
        id: &str,
    ) -> Result<Session, ApiError> {
        let actor = claims(state, headers, id)?;
        self.store.session(
            actor
                .integration_session
                .as_deref()
                .ok_or_else(|| denied("host session required"))?,
        )
    }

    fn response(
        &self,
        state: &ServerState,
        session: &Session,
        decision: &provider::Decision,
    ) -> Result<Value, ApiError> {
        let actor = Claims {
            doc: session.document_id.clone(),
            scope: if decision.granted.iter().any(|op| op == "document.edit") {
                "write"
            } else {
                "read"
            }
            .into(),
            sub: Some(session.subject()),
            name: Some(session.actor.display_name.clone()),
            aud: "hcd-core".into(),
            iat: now() as usize,
            exp: session.expires_at as usize,
            worker_generation: None,
            integration_session: Some(session.session_id.clone()),
        };
        let token = encode(
            &Header::new(Algorithm::HS256),
            &actor,
            &EncodingKey::from_secret(&state.secret),
        )
        .map_err(internal)?;
        Ok(
            json!({"sessionId":session.session_id,"documentId":session.document_id,"token":token,
            "expiresAt":session.expires_at,"scope":actor.scope,"actor":session.actor,
            "apiUrl":"/v1/documents","operations":decision.granted,
            "exportFormats":decision.constraints.export_formats,"protocolFingerprint":crate::capabilities::fingerprint(),
            "limitations":["host_ai_mcp_not_enabled","manual_publication_retry"]}),
        )
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OpenRequest {
    session_id: String,
    exchange_id: String,
    external_file_id: String,
    launch_code: String,
}

pub(super) async fn open_session(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(request): Json<OpenRequest>,
) -> Result<Json<Value>, ApiError> {
    exchange(&state, headers, request, false).await.map(Json)
}

pub(super) async fn refresh_session(
    State(state): State<ServerState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<OpenRequest>,
) -> Result<Json<Value>, ApiError> {
    if session_id != request.session_id {
        return Err(bad("session ID mismatch"));
    }
    exchange(&state, headers, request, true).await.map(Json)
}

async fn exchange(
    state: &ServerState,
    headers: HeaderMap,
    request: OpenRequest,
    refresh: bool,
) -> Result<Value, ApiError> {
    let integration = configured(state)?;
    integration.service(&headers)?;
    if !valid_uuid(&request.session_id)
        || !valid_uuid(&request.exchange_id)
        || !external_id(&request.external_file_id)
        || request.launch_code.is_empty()
        || request.launch_code.len() > 4096
    {
        return Err(bad("invalid host session request"));
    }
    let document_id = format!(
        "host-{}",
        &hcd_core::hash_bytes(
            &serde_json::to_vec(&json!([
                integration.provider.config.tenant_id,
                integration.provider.config.app_id,
                request.external_file_id
            ]))
            .map_err(internal)?
        )[..48]
    );
    // Serialize by both session and document, so concurrent one-time exchanges
    // cannot rebind a session to a different file or actor.
    let _session_guard = integration.lock(&request.session_id).await;
    let _document_guard = integration.lock(&document_id).await;
    let previous = integration.store.session_record(&request.session_id)?;
    if let Some(previous) = &previous {
        if previous.closed || previous.document_id != document_id {
            return Err(denied("session cannot be rebound or reopened"));
        }
        if previous.exchange_id == request.exchange_id {
            if previous.credential_hash != hcd_core::hash_bytes(request.launch_code.as_bytes()) {
                return Err(conflict("exchange ID was used with another credential"));
            }
            let session = integration.store.session(&request.session_id)?;
            let decision = integration.provider.permissions(&session).await?;
            return integration.response(state, &session, &decision);
        }
        if !refresh {
            return Err(conflict(
                "existing session requires refresh with a fresh exchange ID",
            ));
        }
    } else if refresh {
        return Err(denied("unknown host session"));
    }

    let resolved: provider::Resolved = integration.provider.post("/officecli-provider/v1/sessions/resolve", json!({
        "tenantId":integration.provider.config.tenant_id,"appId":integration.provider.config.app_id,
        "externalFileId":request.external_file_id,"sessionId":request.session_id,"exchangeId":request.exchange_id,
        "launchCode":request.launch_code,"purpose":if refresh {"refresh"} else {"open"}
    })).await?;
    if resolved.tenant_id != integration.provider.config.tenant_id
        || resolved.app_id != integration.provider.config.app_id
        || resolved.external_file_id != request.external_file_id
        || resolved.session_id != request.session_id
        || !external_id(&resolved.actor.id)
        || resolved.actor.display_name.is_empty()
        || resolved.actor.display_name.len() > 1024
        || resolved.actor.deleted
        || previous
            .as_ref()
            .is_some_and(|p| p.actor.id != resolved.actor.id)
    {
        return Err(denied("Provider returned a mismatched session identity"));
    }
    let host_expires_at = provider::timestamp(&resolved.expires_at)?;
    if host_expires_at <= now() {
        return Err(denied("host credential has expired"));
    }
    let session = Session {
        session_id: request.session_id,
        exchange_id: request.exchange_id,
        credential_hash: hcd_core::hash_bytes(request.launch_code.as_bytes()),
        external_file_id: request.external_file_id.clone(),
        document_id: document_id.clone(),
        actor: resolved.actor,
        host_expires_at,
        expires_at: host_expires_at.min(now() + 300),
        closed: false,
    };
    let decision = integration.provider.permissions(&session).await?;
    let descriptor: Descriptor = integration
        .provider
        .post(
            &integration
                .provider
                .file_path(&request.external_file_id, "/describe"),
            json!({"context":integration.provider.context(&session)}),
        )
        .await?;
    descriptor.format()?;
    if descriptor.id != request.external_file_id {
        return Err(bad("Provider descriptor ID mismatch"));
    }
    let mapping = if let Some(mapping) = integration.store.mapping(&document_id) {
        if mapping.external_file_id != request.external_file_id
            || mapping.external_head != descriptor.version
        {
            return Err(conflict("business file changed outside this HCD workspace; explicit conflict handling is required"));
        }
        mapping
    } else {
        if state.root.join(format!("{document_id}.hcd")).exists() {
            return Err(conflict(
                "unregistered document already occupies the managed ID",
            ));
        }
        let mapping = Mapping {
            document_id: document_id.clone(),
            tenant_id: integration.provider.config.tenant_id.clone(),
            app_id: integration.provider.config.app_id.clone(),
            external_file_id: request.external_file_id,
            external_head: descriptor.version.clone(),
            source: descriptor,
            last_published_revision: None,
            sequence: 0,
            pending_publication: None,
        };
        integration.store.save_mapping(&mapping)?;
        mapping
    };
    ensure_imported(state, integration, &session, &mapping).await?;
    integration.store.save_session(&session)?;
    integration.response(state, &session, &decision)
}

async fn ensure_imported(
    state: &ServerState,
    integration: &Integration,
    session: &Session,
    mapping: &Mapping,
) -> Result<(), ApiError> {
    let destination = state.root.join(format!("{}.hcd", mapping.document_id));
    let format = mapping.source.format()?;
    let sources = state.root.join("sources");
    tokio::fs::create_dir_all(&sources)
        .await
        .map_err(internal)?;
    let source = sources.join(format!("{}.{format}", mapping.document_id));
    let source_ok =
        source.is_file() && hash_file(&source).map_err(internal)? == mapping.source.sha256;
    if !source_ok {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Download {
            file: Descriptor,
            transfer: provider::Transfer,
        }
        let download: Download = integration.provider.post(&integration.provider.file_path(&mapping.external_file_id, "/download"),
            json!({"context":integration.provider.context(session),"version":mapping.source.version})).await?;
        if download.file.id != mapping.source.id
            || download.file.version != mapping.source.version
            || download.file.sha256 != mapping.source.sha256
            || download.file.size_bytes != mapping.source.size_bytes
        {
            return Err(bad("Provider substituted another source version"));
        }
        integration
            .provider
            .download(&download.transfer, &mapping.source, &source)
            .await?;
    }
    if destination.exists() {
        let manifest = open(state, &mapping.document_id)?
            .manifest()
            .map_err(hcd_error)?;
        if manifest.source.sha256 != mapping.source.sha256 {
            return Err(conflict("HCD source identity mismatch"));
        }
        return Ok(());
    }
    let staging = tempfile::Builder::new()
        .prefix(".host-import-")
        .tempdir_in(&state.root)
        .map_err(internal)?;
    let output = staging.path().join("document.hcd");
    let (job_source, job_output, job_id) =
        (source.clone(), output.clone(), mapping.document_id.clone());
    tokio::task::spawn_blocking(move || {
        hcd_formats::import_document(
            job_source,
            job_output,
            &hcd_formats::ImportOptions::new(job_id),
            |_| Ok(()),
        )
    })
    .await
    .map_err(internal)?
    .map_err(hcd_error)?;
    tokio::fs::rename(&output, &destination)
        .await
        .map_err(internal)?;
    if let Some(remote) = &state.remote {
        remote
            .publish(&mapping.document_id, &destination, Some(&source), None)
            .await
            .map_err(internal)?;
    }
    Ok(())
}

pub(super) async fn close_session(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let integration = configured(&state)?;
    integration.service(&headers)?;
    if !valid_uuid(&id) {
        return Err(bad("invalid session ID"));
    }
    let _guard = integration.lock(&id).await;
    let mut session = integration
        .store
        .session_record(&id)?
        .ok_or_else(|| bad("unknown session"))?;
    session.closed = true;
    integration.store.save_session(&session)?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn access(
    state: &ServerState,
    headers: &HeaderMap,
    id: &str,
) -> Result<Option<provider::Decision>, ApiError> {
    let Some(integration) = state.integration.as_deref() else {
        return Ok(None);
    };
    if integration.store.mapping(id).is_none() {
        return Ok(None);
    }
    let actor = claims(state, headers, id)?;
    if actor.integration_session.is_none() {
        return Ok(None);
    }
    let session = integration.session(state, headers, id)?;
    integration.provider.permissions(&session).await.map(Some)
}

pub(super) fn export_permission(
    state: &ServerState,
    id: &str,
    format: &str,
    decision: &provider::Decision,
) -> Result<(), ApiError> {
    policy::export_permission(state, id, format, decision)
}

pub(super) async fn document_status(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let integration = configured(&state)?;
    let session = integration.session(&state, &headers, &id)?;
    let decision = integration.provider.permissions(&session).await?;
    let mapping = integration
        .store
        .mapping(&id)
        .ok_or_else(|| bad("unmanaged document"))?;
    let revision = open(&state, &id)?.manifest().map_err(hcd_error)?.revision;
    let pending = mapping.pending_publication.as_deref().map(|id| integration.store.publication(id)).transpose()?.flatten()
        .filter(|p| p.actor_id == session.actor.id)
        .map(|p| json!({"publicationId":p.publication_id,"expectedRevision":p.revision,"exportMode":p.export_mode}));
    Ok(Json(
        json!({"externalFileId":mapping.external_file_id,"fileName":mapping.source.name,
        "importBaseVersion":mapping.source.version,"externalVersion":mapping.external_head,
        "revision":revision,"lastPublishedRevision":mapping.last_published_revision,
        "pending":mapping.last_published_revision != Some(revision),"operations":decision.granted,
        "pendingPublication":pending,
        "exportFormats":decision.constraints.export_formats,"sessionExpiresAt":session.expires_at,
        "supported":["manualPublication","sourceBackedPublication","sessionRefresh","sessionRevocation"],
        "unavailable":["ai","mcp","automaticPublicationRetry"]}),
    ))
}
