//! Persist intent before external effects; reconcile the same ID after uncertainty.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::hdoc_server) struct PublishRequest {
    publication_id: String,
    expected_revision: u64,
    #[serde(default = "source_mode")]
    export_mode: String,
}
fn source_mode() -> String {
    "source-backed".into()
}

fn public_record(record: &Publication) -> Value {
    json!({"publicationId":record.publication_id,"documentId":record.document_id,
        "revision":record.revision,"expectedVersion":record.expected_version,"state":record.state,
        "receipt":record.receipt,"error":record.error,"fidelity":record.fidelity,
        "canStartNew":record.intent.is_none() && matches!(record.state.as_str(),"failed"|"rejected"),
        "eventDelivery":{"configured":record.event.is_some(),"attempts":record.event_attempts,
            "delivered":record.event_delivered,"deadLetter":record.event_dead_letter}})
}

pub(in crate::hdoc_server) async fn publication_status(
    State(state): State<ServerState>,
    Path((id, publication_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let integration = configured(&state)?;
    let session = integration.session(&state, &headers, &id)?;
    let record = integration
        .store
        .publication(&publication_id)?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "publication not found".into()))?;
    if record.document_id != id || record.actor_id != session.actor.id {
        return Err(denied("publication belongs to another document or actor"));
    }
    Ok(Json(public_record(&record)))
}

pub(in crate::hdoc_server) async fn publish(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<PublishRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    // Own the future even if a browser disconnects while commit is in flight.
    tokio::spawn(async move { run_publication(&state, &id, &headers, request).await })
        .await
        .map_err(internal)?
}

async fn run_publication(
    state: &ServerState,
    id: &str,
    headers: &HeaderMap,
    request: PublishRequest,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let integration = configured(state)?;
    let session = integration.session(state, headers, id)?;
    if !valid_uuid(&request.publication_id)
        || !matches!(
            request.export_mode.as_str(),
            "source-backed" | "semantic" | "visual"
        )
    {
        return Err(bad("invalid publication ID or export mode"));
    }
    let _guard = integration.lock(id).await;
    let mut mapping = integration
        .store
        .mapping(id)
        .ok_or_else(|| bad("unmanaged document"))?;
    let mut record = match integration.store.publication(&request.publication_id)? {
        Some(record) => {
            if record.document_id != id
                || record.actor_id != session.actor.id
                || record.revision != request.expected_revision
                || record.export_mode != request.export_mode
            {
                return Err(conflict(
                    "publication ID was used with a different immutable intent",
                ));
            }
            if record.state == "committed" {
                return Ok((StatusCode::OK, Json(public_record(&record))));
            }
            record
        }
        None => {
            if let Some(pending) = &mapping.pending_publication {
                if pending != &request.publication_id
                    && integration.store.publication(pending)?.is_some()
                {
                    return Err(conflict(
                        "another publication needs reconciliation before creating a new one",
                    ));
                }
            }
            let head = open(state, id)?.manifest().map_err(hcd_error)?;
            if head.revision != request.expected_revision {
                return Err(conflict("HCD revision changed before publication"));
            }
            if mapping.last_published_revision == Some(head.revision) {
                return Err(conflict("this revision has already been published"));
            }
            require_clean_collaboration(state, id, headers).await?;
            require_publish(integration, &session).await?;
            mapping.pending_publication = Some(request.publication_id.clone());
            integration.store.save_mapping(&mapping)?;
            Publication {
                publication_id: request.publication_id,
                document_id: id.into(),
                actor_id: session.actor.id.clone(),
                revision: request.expected_revision,
                expected_version: mapping.external_head.clone(),
                state: "queued".into(),
                export_mode: request.export_mode,
                intent: None,
                receipt: None,
                error: None,
                fidelity: None,
                event: None,
                event_attempts: 0,
                event_next_at: 0,
                event_delivered: false,
                event_dead_letter: false,
                created_at: now(),
            }
        }
    };
    integration.store.save_publication(&record)?;
    let outcome = execute(state, integration, &session, &mapping, &mut record).await;
    match outcome {
        Ok(receipt) => finish(integration, &mut mapping, &mut record, receipt)?,
        Err(error) => {
            record.state = match error.0 {
                StatusCode::CONFLICT => "conflict",
                StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED => "rejected",
                StatusCode::SERVICE_UNAVAILABLE | StatusCode::GATEWAY_TIMEOUT => "retrying",
                _ => "failed",
            }
            .into();
            record.error = Some(error.1);
            integration.store.save_publication(&record)?;
            // An uncertain external effect retains the document's pending marker.
            // Terminal failures also retain it when an intent reached the host.
            if record.intent.is_none() && record.state != "retrying" {
                mapping.pending_publication = None;
                integration.store.save_mapping(&mapping)?;
            }
        }
    }
    let status = match record.state.as_str() {
        "committed" => StatusCode::OK,
        "retrying" => StatusCode::ACCEPTED,
        "conflict" => StatusCode::CONFLICT,
        "rejected" => StatusCode::FORBIDDEN,
        _ => StatusCode::UNPROCESSABLE_ENTITY,
    };
    Ok((status, Json(public_record(&record))))
}

async fn require_publish(integration: &Integration, session: &Session) -> Result<(), ApiError> {
    let current = integration.store.session(&session.session_id)?;
    integration.provider.permissions(&current).await?.require(&[
        "document.view",
        "document.edit",
        "document.publish",
    ])
}

async fn execute(
    state: &ServerState,
    integration: &Integration,
    session: &Session,
    mapping: &Mapping,
    record: &mut Publication,
) -> Result<Value, ApiError> {
    let context = integration.provider.context(session);
    if record.intent.is_some() {
        let status: Value = integration
            .provider
            .post(
                &integration
                    .provider
                    .file_path(&mapping.external_file_id, "/publications/status"),
                json!({"context":context,"publicationId":record.publication_id}),
            )
            .await?;
        if status["publicationId"] != record.publication_id {
            return Err(unavailable("publication status identity mismatch"));
        }
        match status["state"].as_str() {
            Some("committed") => {
                return validate_receipt(record, mapping, status["receipt"].clone())
            }
            Some("conflict" | "rejected") => {
                return Err(conflict(
                    "Provider publication requires explicit conflict handling",
                ))
            }
            Some("unknown" | "prepared" | "expired") => {}
            _ => return Err(unavailable("invalid publication status")),
        }
    }
    require_publish(integration, session).await?;
    let artifact = integration.store.artifact(record);
    if record.intent.is_none() {
        record.state = "exporting".into();
        integration.store.save_publication(record)?;
        ensure_imported(state, integration, session, mapping).await?;
        let format = mapping.source.format()?;
        if record.export_mode == "visual" && format != "pdf" {
            return Err(bad("visual publication is only supported for PDF"));
        }
        if record.export_mode == "semantic"
            && matches!(format.as_str(), "pdf" | "png" | "jpeg" | "webp")
        {
            return Err(bad(
                "choose the explicit source-backed or visual mode for this format",
            ));
        }
        let _permit = state
            .export_jobs
            .clone()
            .try_acquire_owned()
            .map_err(|_| unavailable("export workers are busy"))?;
        let temporary =
            tempfile::tempdir_in(integration.store.root.join("artifacts")).map_err(internal)?;
        let output = temporary.path().join(format!("output.{format}"));
        let report = temporary.path().join("fidelity.json");
        let mut command = tokio::process::Command::new(std::env::current_exe().map_err(internal)?);
        command
            .kill_on_drop(true)
            .arg("hdoc")
            .arg("export")
            .arg(state.root.join(format!("{}.hcd", record.document_id)))
            .arg("--output")
            .arg(&output)
            .arg("--to")
            .arg(&format)
            .arg("--revision")
            .arg(record.revision.to_string())
            .arg("--catalog")
            .arg(state.catalog.root())
            .arg("--fidelity-report")
            .arg(&report);
        if record.export_mode == "source-backed" {
            command.arg("--source").arg(
                state
                    .root
                    .join("sources")
                    .join(format!("{}.{format}", record.document_id)),
            );
        }
        let result = tokio::time::timeout(Duration::from_secs(90), command.output())
            .await
            .map_err(|_| {
                ApiError(
                    StatusCode::GATEWAY_TIMEOUT,
                    "publication export timed out".into(),
                )
            })?
            .map_err(internal)?;
        if !result.status.success() {
            // Diagnostics stay in service logs; the public error cannot leak local
            // paths, source contents or command environment.
            eprintln!(
                "publication {} export failed ({})",
                record.publication_id, result.status
            );
            return Err(bad(
                "this revision cannot be exported in the selected publication mode",
            ));
        }
        if tokio::fs::metadata(&output).await.map_err(internal)?.len() > MAX_FILE_BYTES {
            return Err(bad("publication output exceeds 256 MiB"));
        }
        let bytes = tokio::fs::read(&output).await.map_err(internal)?;
        let sha256 = hcd_core::hash_bytes(&bytes);
        store::write_bytes(&artifact, &bytes).map_err(internal)?;
        if report.is_file() && std::fs::metadata(&report).map_err(internal)?.len() <= 128 * 1024 {
            record.fidelity = Some(
                serde_json::from_slice(&std::fs::read(&report).map_err(internal)?)
                    .map_err(internal)?,
            );
        }
        record.intent = Some(
            json!({"publicationId":record.publication_id,"documentId":record.document_id,
            "revision":record.revision,"expectedVersion":record.expected_version,"trigger":"manual",
            "output":{"name":mapping.source.name,"mediaType":mapping.source.media_type,"format":format,
                "exportMode":record.export_mode,"sizeBytes":bytes.len(),"sha256":sha256}}),
        );
    }
    let intent = record.intent.clone().expect("exported intent");
    if !artifact.is_file()
        || hash_file(&artifact).map_err(internal)? != intent["output"]["sha256"]
        || std::fs::metadata(&artifact).map_err(internal)?.len()
            != intent["output"]["sizeBytes"].as_u64().unwrap_or(u64::MAX)
    {
        return Err(bad("immutable publication artifact is missing or changed; preserve records and restore its backup"));
    }
    record.state = "preparing".into();
    integration.store.save_publication(record)?;
    require_publish(integration, session).await?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Prepared {
        publication_id: String,
        upload_id: String,
        transfer: provider::Transfer,
    }
    let prepared: Prepared = integration
        .provider
        .post(
            &integration
                .provider
                .file_path(&mapping.external_file_id, "/publications/prepare"),
            json!({"context":context,"intent":intent}),
        )
        .await?;
    if prepared.publication_id != record.publication_id || !external_id(&prepared.upload_id) {
        return Err(unavailable("Provider prepared another publication"));
    }
    record.state = "uploading".into();
    integration.store.save_publication(record)?;
    integration
        .provider
        .upload(
            &prepared.transfer,
            tokio::fs::read(artifact).await.map_err(internal)?,
        )
        .await?;
    require_publish(integration, session).await?;
    record.state = "committing".into();
    integration.store.save_publication(record)?;
    let receipt: Value = integration.provider.post(&integration.provider.file_path(&mapping.external_file_id, "/publications/commit"),
        json!({"context":context,"publicationId":record.publication_id,"uploadId":prepared.upload_id})).await?;
    validate_receipt(record, mapping, receipt)
}

fn validate_receipt(
    record: &Publication,
    mapping: &Mapping,
    receipt: Value,
) -> Result<Value, ApiError> {
    if receipt["publicationId"] != record.publication_id
        || receipt["externalFileId"] != mapping.external_file_id
        || receipt["documentId"] != record.document_id
        || receipt["revision"].as_u64() != Some(record.revision)
        || &receipt["sha256"]
            != record
                .intent
                .as_ref()
                .map(|v| &v["output"]["sha256"])
                .unwrap_or(&Value::Null)
        || receipt["externalVersion"]
            .as_str()
            .is_none_or(|s| !external_id(s))
        || receipt["externalVersion"] == record.expected_version
        || receipt["committedAt"]
            .as_str()
            .and_then(|s| provider::timestamp(s).ok())
            .is_none()
    {
        return Err(unavailable(
            "Provider returned a mismatched publication receipt; reconciliation is required",
        ));
    }
    Ok(receipt)
}

fn finish(
    integration: &Integration,
    mapping: &mut Mapping,
    record: &mut Publication,
    receipt: Value,
) -> Result<(), ApiError> {
    if mapping
        .last_published_revision
        .is_none_or(|r| r < record.revision)
    {
        mapping.external_head = receipt["externalVersion"]
            .as_str()
            .expect("validated version")
            .into();
        mapping.last_published_revision = Some(record.revision);
    }
    if mapping.pending_publication.as_deref() == Some(&record.publication_id) {
        mapping.pending_publication = None;
    }
    if integration.provider.config.events.is_some() && record.event.is_none() {
        mapping.sequence += 1;
        record.event = Some(
            json!({"schemaVersion":"officecli-event/1","eventId":record.publication_id,
            "tenantId":mapping.tenant_id,"appId":mapping.app_id,"externalFileId":mapping.external_file_id,
            "documentId":mapping.document_id,"sequence":mapping.sequence,"occurredAt":provider::date_now(),
            "type":"publication.committed","payload":{"receipt":receipt}}),
        );
    }
    integration.store.save_mapping(mapping)?;
    record.state = "committed".into();
    record.receipt = Some(receipt);
    record.error = None;
    // The final receipt and pending event share a single durable record.
    integration.store.save_publication(record)
}

pub(in crate::hdoc_server) fn start_events(state: &ServerState) {
    let Some(integration) = state
        .integration
        .clone()
        .filter(|i| i.provider.config.events.is_some())
    else {
        return;
    };
    tokio::spawn(async move {
        loop {
            if let Err(error) = deliver_events(&integration).await {
                eprintln!("integration event delivery: {}", error.1);
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

async fn deliver_events(integration: &Integration) -> Result<(), ApiError> {
    for id in integration.store.publication_ids().map_err(internal)? {
        let Some(record) = integration.store.publication(&id)? else {
            continue;
        };
        if record.event.is_none()
            || record.event_delivered
            || record.event_dead_letter
            || record.event_next_at > now()
        {
            continue;
        }
        let _guard = integration.lock(&record.document_id).await;
        let mut record = integration
            .store
            .publication(&id)?
            .ok_or_else(|| internal("event record disappeared"))?;
        if record.event_delivered || record.state != "committed" {
            continue;
        }
        let status = integration
            .provider
            .event(record.event.as_ref().expect("pending event"))
            .await
            .ok();
        record.event_attempts += 1;
        record.event_delivered = status.is_some_and(|s| (200..300).contains(&s));
        record.event_dead_letter = !record.event_delivered
            && (now().saturating_sub(record.created_at) >= 86400
                || status.is_some_and(|s| (400..500).contains(&s) && !matches!(s, 408 | 429)));
        record.event_next_at =
            now() + (5u64.saturating_mul(1u64 << record.event_attempts.min(9))).min(3600);
        integration.store.save_publication(&record)?;
    }
    Ok(())
}
