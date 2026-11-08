//! Recoverable local restore transaction. The sidecar first drains its room;
//! this journal fences native writers across a crash between head and epoch.
use super::*;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    pub request_id: String,
    pub expected_revision: u64,
    pub from_epoch: u64,
    // Missing only in pre-inline journals; never infer Inline1 from metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_protocol: Option<CollaborationProtocol>,
    pub source_hash: String,
    pub author_id: String,
    pub author_name: String,
}
impl Request {
    fn protocol(&self) -> CollaborationProtocol {
        self.from_protocol
            .unwrap_or(CollaborationProtocol::Structure3)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    target: u64,
    request: Request,
}
fn directory(state: &ServerState, id: &str) -> PathBuf {
    state
        .root
        .join("collaboration")
        .join(format!("{id}.restores"))
}
pub(super) async fn pending(state: &ServerState, id: &str) -> bool {
    // A malformed or inaccessible journal must also fail closed.
    !matches!(tokio::fs::metadata(directory(state,id).join("pending.json")).await, Err(error) if error.kind()==std::io::ErrorKind::NotFound)
}
fn response(intent: &Intent, replay: bool) -> Json<Value> {
    Json(
        json!({"requestId":intent.request.request_id,"revision":intent.request.expected_revision+1,"restoredFrom":intent.target,"collaborationEpoch":intent.request.from_epoch+1,"collaborationProtocol":intent.request.protocol(),"idempotentReplay":replay}),
    )
}
pub(super) async fn restore(
    State(state): State<ServerState>,
    Path((id, target)): Path<(String, u64)>,
    headers: HeaderMap,
    Json(request): Json<Request>,
) -> Result<Json<Value>, ApiError> {
    let _authority = access_policy::gate(&state.root, &id).write_owned().await;
    let identity = authorize_claims(&state, &headers, &id)?;
    require_story_link_editor_safe(&open(&state, &id)?.manifest().map_err(hcd_error)?)?;
    if !collaboration_service(&identity)
        || headers
            .get("x-hcd-coordinator-version")
            .and_then(|value| value.to_str().ok())
            != Some("4")
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "restore requires the collaboration coordinator".into(),
        ));
    }
    if state.remote.is_some() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "remote coordinated restore requires a shared transaction adapter".into(),
        ));
    }
    let protocol = request.protocol();
    if !matches!(
        protocol,
        CollaborationProtocol::Structure3 | CollaborationProtocol::Inline1
    ) {
        return Err(bad("unsupported restore protocol"));
    }
    // Also require model acknowledgement on replay after the epoch has moved.
    if protocol == CollaborationProtocol::Inline1 {
        require_inline_containers_support(true, &headers)?;
        for (key, expected) in [
            ("x-hcd-extension-version", "3"),
            ("x-hcd-node-edits-version", "7"),
            ("x-hcd-custom-marks-version", "1"),
        ] {
            if headers.get(key).and_then(|value| value.to_str().ok()) != Some(expected) {
                return Err(ApiError(
                    StatusCode::UPGRADE_REQUIRED,
                    "inline restore model acknowledgement required".into(),
                ));
            }
        }
    }
    let hex = |s: &str, n| {
        s.len() == n
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if !hex(&request.request_id, 32)
        || !hex(&request.source_hash, 64)
        || !super::access_policy::valid_subject(&request.author_id)
        || request.author_name.len() > 256
        || target >= request.expected_revision
        || request.expected_revision >= hcd_core::MAX_REVISION
        || request.from_epoch.checked_add(1).is_none()
    {
        return Err(bad("invalid restore request"));
    }
    if requested_collaboration_epoch(&headers)? != request.from_epoch
        || headers
            .get("x-hcd-collaboration-protocol")
            .and_then(|value| value.to_str().ok())
            != Some(protocol.name())
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "restore request session changed".into(),
        ));
    }
    let _guard = state.collaboration_lock.lock().await;
    let dir = directory(&state, &id);
    let pending_path = dir.join("pending.json");
    let receipt_path = dir.join(format!("{}.json", request.request_id));
    let intent = Intent { target, request };
    let decode = |bytes: &[u8]| serde_json::from_slice::<Intent>(bytes).map_err(internal);
    match tokio::fs::read(&receipt_path).await {
        Ok(bytes) => {
            if decode(&bytes)? != intent {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "restore request ID reused".into(),
                ));
            }
            if tokio::fs::read(&pending_path)
                .await
                .ok()
                .as_deref()
                .map(decode)
                .transpose()?
                .as_ref()
                == Some(&intent)
            {
                tokio::fs::remove_file(&pending_path)
                    .await
                    .map_err(internal)?;
                sync_collaboration_directory(&dir).await?;
            }
            return Ok(response(&intent, true));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(internal(error)),
    }
    let prepared = match tokio::fs::read(&pending_path).await {
        Ok(bytes) => {
            if decode(&bytes)? != intent {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "another restore is pending".into(),
                ));
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(internal(error)),
    };
    let bundle = open(&state, &id)?;
    let metadata = collaboration_metadata(&state, &id).await?;
    // A prepared journal must not append a head under a different model/epoch.
    if metadata.protocol != protocol
        || (metadata.epoch != intent.request.from_epoch
            && (!prepared || metadata.epoch != intent.request.from_epoch + 1))
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "restore session changed".into(),
        ));
    }
    if !prepared {
        check_collaboration_epoch(&state, &id, &headers).await?;
        if metadata.epoch != intent.request.from_epoch {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "restore session changed".into(),
            ));
        }
        if !load_access(&state, &id)?.can_write(Some(&intent.request.author_id)) {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "restore author no longer has write access".into(),
            ));
        }
        if bundle.manifest().map_err(internal)?.revision != intent.request.expected_revision {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "restore comparison changed".into(),
            ));
        }
        let bytes = tokio::fs::read(collaboration_current_path(&state, &id, metadata.epoch).await?)
            .await
            .map_err(internal)?;
        if hash_bytes(&bytes) != intent.request.source_hash {
            return Err(ApiError(
                StatusCode::PRECONDITION_FAILED,
                "restore room changed".into(),
            ));
        }
        // Verify the immutable target before making a durable intent.
        bundle.revision(target).map_err(bad)?;
        durable_collaboration_file(
            &pending_path,
            &serde_json::to_vec(&intent).map_err(internal)?,
        )
        .await?;
    }
    let head = bundle.manifest().map_err(internal)?.revision;
    if metadata.epoch != intent.request.from_epoch && head != intent.request.expected_revision + 1 {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "restore epoch advanced without canonical commit".into(),
        ));
    }
    if head == intent.request.expected_revision {
        restore_revision(
            &bundle,
            target,
            head,
            Some(intent.request.author_id.clone()),
            Some(intent.request.author_name.clone()),
        )
        .map_err(internal)?;
    } else {
        let record = bundle
            .revision(intent.request.expected_revision + 1)
            .map_err(internal)?;
        let expected_id = format!("restore-{target}-{}", intent.request.expected_revision + 1);
        if head != intent.request.expected_revision + 1
            || record.patch_id.as_deref() != Some(&expected_id)
            || record.patch_hash.as_deref()
                != Some(&hash_bytes(
                    format!("restore:{target}:{}", intent.request.expected_revision).as_bytes(),
                ))
            || record.author_id.as_deref() != Some(&intent.request.author_id)
        {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "restore intent does not match canonical history".into(),
            ));
        }
    }
    if metadata.epoch == intent.request.from_epoch {
        reset_collaboration_locked(&state, &id).await?;
    } else if metadata.epoch != intent.request.from_epoch + 1 || metadata.protocol != protocol {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "restore epoch changed".into(),
        ));
    }
    durable_collaboration_file(
        &receipt_path,
        &serde_json::to_vec(&intent).map_err(internal)?,
    )
    .await?;
    tokio::fs::remove_file(&pending_path)
        .await
        .map_err(internal)?;
    sync_collaboration_directory(&dir).await?;
    state
        .revisions
        .publish(&id, intent.request.expected_revision + 1);
    Ok(response(&intent, prepared))
}
