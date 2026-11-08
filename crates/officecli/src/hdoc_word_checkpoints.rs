//! Explicit regional coordinator contract. Legacy snapshots remain closed for
//! flow documents; this route does not activate a browser/CRDT room by itself.
use super::*;
use hcd_core::{FlowRegionEdits, FlowStructurePatchBatch, FLOW_REGION_LAYOUT_SCHEMA};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WordSnapshotRegion {
    region_id: String,
    blocks: Vec<SnapshotBlock>,
    #[serde(default)]
    images: Vec<SnapshotImage>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WordCheckpointRequest {
    coordinator_version: u32,
    coordinator_id: String,
    checkpoint_id: String,
    coordinator_digest: String,
    expected_revision: u64,
    layout_hash: String,
    #[serde(default)]
    typography_version: Option<u32>,
    regions: Vec<WordSnapshotRegion>,
    contributors: Vec<Contributor>,
    #[serde(default)]
    reference_authors: Vec<ReferenceAuthor>,
    #[serde(default)]
    reference_version: Option<u32>,
    #[serde(default)]
    extension_version: Option<u32>,
}
fn hex(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn story_checkpoint_header(headers: &HeaderMap) -> bool {
    headers
        .get("x-hcd-coordinator-version")
        .and_then(|v| v.to_str().ok())
        == Some("7")
        && headers
            .get("x-hcd-word-story-version")
            .and_then(|v| v.to_str().ok())
            == Some("1")
}
fn validate_checkpoint_story_capability(
    head: &hcd_core::HcdManifest,
    headers: &HeaderMap,
) -> Result<(), ApiError> {
    if head.capabilities.word_layout_edits == Some(2)
        || (head.capabilities.word_layout_edits == Some(3)) != story_checkpoint_header(headers)
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "story-aware Word checkpoint required".into(),
        ));
    }
    Ok(())
}
fn layout_coordinator_header(headers: &HeaderMap) -> bool {
    headers
        .get("x-hcd-word-layout-version")
        .and_then(|v| v.to_str().ok())
        == Some("1")
        && (headers
            .get("x-hcd-coordinator-version")
            .and_then(|v| v.to_str().ok())
            == Some("6")
            || story_checkpoint_header(headers))
}

fn validate_layout_story_capability(
    head: &hcd_core::HcdManifest,
    headers: &HeaderMap,
) -> Result<(), ApiError> {
    if !matches!(head.capabilities.word_layout_edits, None | Some(1 | 3)) {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "unsupported Word layout model".into(),
        ));
    }
    validate_checkpoint_story_capability(head, headers)
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WordLayoutReceiptRequest {
    coordinator_id: String,
    transaction: hcd_core::FlowLayoutTransaction,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoryReceiptRequest {
    api_hash: String,
    coordinator_id: String,
    pending_hash: String,
    initial_update_hash: String,
    request: StoryReceiptTransaction,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoryReceiptTransaction {
    document_id: String,
    transaction_id: String,
    expected_revision: u64,
    base_layout_hash: String,
    candidate_hash: String,
    actor: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoryTransactionRequest {
    coordinator_id: String,
    request: StoryReceiptTransaction,
    intent: hcd_core::FlowStoryUnlinkRequest,
    story: hcd_core::FlowStory,
    copy_choices: hcd_core::StoryCopyChoices,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoryPreflightRequest {
    coordinator_id: String,
    expected_revision: u64,
    actor: BTreeMap<String, String>,
    intent: hcd_core::FlowStoryUnlinkRequest,
    story: hcd_core::FlowStory,
}

/// Build a bounded, revision-pinned candidate. Publishing independently
/// replays the source and copy choices under the owner and document lock.
pub(super) async fn story_preflight(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<StoryPreflightRequest>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    if claims.sub.as_deref() != Some("hcd-collaboration")
        || headers
            .get("x-hcd-coordinator-version")
            .and_then(|v| v.to_str().ok())
            != Some("7")
        || headers
            .get("x-hcd-word-story-version")
            .and_then(|v| v.to_str().ok())
            != Some("1")
        || !hex(&input.coordinator_id, 32)
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "story-aware Word coordinator required".into(),
        ));
    }
    if state.remote.is_some() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "remote Word ownership adapter is not configured".into(),
        ));
    }
    if input.actor.len() != 2 || !hex(&input.intent.base_layout_hash, 64) {
        return Err(bad("invalid Word story preflight"));
    }
    let actor_id = input
        .actor
        .get("userId")
        .ok_or_else(|| bad("missing story author"))?;
    let actor_name = input
        .actor
        .get("displayName")
        .ok_or_else(|| bad("missing story author name"))?;
    if !access_policy::valid_subject(actor_id) || !valid_display_name(actor_name) {
        return Err(bad("invalid story author"));
    }
    let _lock = state.collaboration_lock.lock().await;
    let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
    if collaboration_metadata(&state, &id).await?.protocol != CollaborationProtocol::WordRegions2 {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "story-aware Word room required".into(),
        ));
    }
    let _owner = state.word_owners.guard(&id, epoch, &headers)?;
    let access = load_access(&state, &id)?;
    if access.restricted() && !access.can_write(Some(actor_id)) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "story author no longer has write access".into(),
        ));
    }
    let bundle = open(&state, &id)?;
    let manifest = bundle.manifest().map_err(hcd_error)?;
    if manifest.schema_version != hcd_core::HCD_SCHEMA_VERSION
        || manifest.profile != "semantic-flow"
        || manifest.source.format != "docx"
        || !matches!(manifest.capabilities.word_layout_edits, None | Some(1 | 3))
    {
        return Err(bad("supported layout-aware Word document required"));
    }
    if manifest.revision != input.expected_revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Word story preflight head changed".into(),
        ));
    }
    if manifest.revision >= hcd_core::MAX_REVISION {
        return Err(bad("Word revision limit reached"));
    }
    let source = state.root.join("sources").join(format!("{id}.docx"));
    let candidate = hcd_docx::prepare_source_story_unlink(
        &bundle,
        &source,
        input.expected_revision,
        &input.intent,
        &input.story,
        |reference| {
            let seed = serde_json::to_vec(&(
                "hcd-story-reference-copy/1",
                &id,
                input.expected_revision,
                &input.story.id,
                &reference.mention_id,
            ))?;
            Ok(format!("m_{}", &hcd_core::hash_bytes(&seed)[..32]))
        },
        |_| {
            Err(hcd_core::HcdError::Unsupported(
                "story extension copy policy unavailable".into(),
            ))
        },
    )
    .map_err(hcd_error)?;
    candidate.verify_current(&bundle).map_err(hcd_error)?;
    let prepared = &candidate.prepared;
    let response = json!({"revision":prepared.revision,"rootHash":prepared.root_hash,
        "baseLayoutHash":input.intent.base_layout_hash,"candidateHash":prepared.commitment().map_err(hcd_error)?,
        "impact":prepared.impact,"blocks":prepared.blocks,"copyChoices":prepared.copy_choices().map_err(hcd_error)?});
    // The private pending story record is limited to 1 MiB. Leave room for
    // actor, request and envelope fields rather than offering an unpersistable candidate.
    if serde_json::to_vec(&response).map_err(internal)?.len() > 900 * 1024 {
        return Err(ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Word story candidate exceeds recovery limit".into(),
        ));
    }
    Ok(Json(response))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TopologyCancelRequest {
    transaction_id: String,
    actor: BTreeMap<String, String>,
}

/// Atomically fence an unprepared identity at the native commit boundary.
/// The trusted coordinator first checks its signed journal under the lease.
pub(super) async fn topology_cancel(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<TopologyCancelRequest>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    if claims.sub.as_deref() != Some("hcd-collaboration")
        || headers
            .get("x-hcd-coordinator-version")
            .and_then(|v| v.to_str().ok())
            != Some("7")
        || headers
            .get("x-hcd-word-story-version")
            .and_then(|v| v.to_str().ok())
            != Some("1")
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "story-aware Word coordinator required".into(),
        ));
    }
    if state.remote.is_some() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "remote Word ownership adapter is not configured".into(),
        ));
    }
    if !hex(&input.transaction_id, 32) || input.actor.len() != 2 {
        return Err(bad("invalid Word cancellation"));
    }
    let actor_id = input
        .actor
        .get("userId")
        .ok_or_else(|| bad("missing cancellation author"))?;
    let actor_name = input
        .actor
        .get("displayName")
        .ok_or_else(|| bad("missing cancellation author name"))?;
    if !access_policy::valid_subject(actor_id) || !valid_display_name(actor_name) {
        return Err(bad("invalid cancellation author"));
    }
    let _lock = state.collaboration_lock.lock().await;
    let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
    if collaboration_metadata(&state, &id).await?.protocol != CollaborationProtocol::WordRegions2 {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "layout-aware Word room required".into(),
        ));
    }
    let _owner = if headers
        .get("x-hcd-word-journal-hash")
        .and_then(|v| v.to_str().ok())
        == Some("none")
    {
        state.word_owners.guard_bootstrap(&id, epoch, &headers)?
    } else {
        state.word_owners.guard(&id, epoch, &headers)?
    };
    let access = load_access(&state, &id)?;
    if access.restricted() && !access.can_write(Some(actor_id)) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "cancellation author no longer has write access".into(),
        ));
    }
    let bundle = open(&state, &id)?;
    let manifest = bundle.manifest().map_err(hcd_error)?;
    let story_id = format!("word-story-unlink-{}", input.transaction_id);
    let layout_id = format!("word-layout-{}", input.transaction_id);
    let link_id = format!("word-story-link-{}", input.transaction_id);
    for revision in 1..=manifest.revision {
        let record = bundle.revision(revision).map_err(hcd_error)?;
        if record
            .patch_id
            .as_deref()
            .is_some_and(|value| value == story_id || value == layout_id || value == link_id)
        {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Word transaction already committed".into(),
            ));
        }
    }
    word_owner::seal_topology_cancel(&state.root, &id, epoch, &input.transaction_id)?;
    Ok(Json(
        json!({"transactionId":input.transaction_id,"status":"not-prepared"}),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CheckpointCancelRequest {
    checkpoint_id: String,
    actor: BTreeMap<String, String>,
}

/// The coordinator must first seal the same identity in its signed journal.
pub(super) async fn checkpoint_cancel(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<CheckpointCancelRequest>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    if claims.sub.as_deref() != Some("hcd-collaboration")
        || headers
            .get("x-hcd-coordinator-version")
            .and_then(|v| v.to_str().ok())
            != Some("7")
        || headers
            .get("x-hcd-word-story-version")
            .and_then(|v| v.to_str().ok())
            != Some("1")
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "story-aware Word coordinator required".into(),
        ));
    }
    if state.remote.is_some() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "remote Word ownership adapter is not configured".into(),
        ));
    }
    if !hex(&input.checkpoint_id, 32) || input.actor.len() != 2 {
        return Err(bad("invalid Word checkpoint cancellation"));
    }
    let actor_id = input
        .actor
        .get("userId")
        .ok_or_else(|| bad("missing cancellation author"))?;
    let actor_name = input
        .actor
        .get("displayName")
        .ok_or_else(|| bad("missing cancellation author name"))?;
    if !access_policy::valid_subject(actor_id) || !valid_display_name(actor_name) {
        return Err(bad("invalid cancellation author"));
    }
    let _lock = state.collaboration_lock.lock().await;
    let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
    if collaboration_metadata(&state, &id).await?.protocol != CollaborationProtocol::WordRegions2 {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "layout-aware Word room required".into(),
        ));
    }
    let _owner = state.word_owners.guard(&id, epoch, &headers)?;
    let access = load_access(&state, &id)?;
    if access.restricted() && !access.can_write(Some(actor_id)) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "cancellation author no longer has write access".into(),
        ));
    }
    let bundle = open(&state, &id)?;
    let manifest = bundle.manifest().map_err(hcd_error)?;
    if word_owner::checkpoint_unchanged(&state.root, &id, epoch, &input.checkpoint_id)?.is_some() {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Word checkpoint already completed".into(),
        ));
    }
    for revision in 1..=manifest.revision {
        let record = bundle.revision(revision).map_err(hcd_error)?;
        if record.patch_id.as_deref().is_some_and(|value| {
            let parts: Vec<_> = value.split(':').collect();
            parts.len() == 6
                && matches!(parts[0], "hcdsave5" | "hcdsave6")
                && parts[2] == input.checkpoint_id
        }) {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Word checkpoint already committed".into(),
            ));
        }
    }
    word_owner::seal_checkpoint_cancel(&state.root, &id, epoch, &input.checkpoint_id)?;
    Ok(Json(
        json!({"checkpointId":input.checkpoint_id,"status":"not-prepared"}),
    ))
}

/// Restricted transaction for a stopped, layout-aware room. The trusted
/// owner must have durably recorded the exact request and quiesced all peers.
/// Business extensions remain closed until a trusted copy policy exists.
pub(super) async fn story_transaction(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<StoryTransactionRequest>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    if claims.sub.as_deref() != Some("hcd-collaboration")
        || headers
            .get("x-hcd-coordinator-version")
            .and_then(|v| v.to_str().ok())
            != Some("7")
        || headers
            .get("x-hcd-word-story-version")
            .and_then(|v| v.to_str().ok())
            != Some("1")
        || !hex(&input.coordinator_id, 32)
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "story-aware Word coordinator required".into(),
        ));
    }
    if state.remote.is_some() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "remote Word ownership adapter is not configured".into(),
        ));
    }
    let request = &input.request;
    if request.document_id != id
        || !hex(&request.transaction_id, 32)
        || !hex(&request.base_layout_hash, 64)
        || !hex(&request.candidate_hash, 64)
        || request.base_layout_hash != input.intent.base_layout_hash
        || request.actor.len() != 2
        || input.copy_choices.reference_ids.len() > 10000
        || !input.copy_choices.extensions.is_empty()
    {
        return Err(bad("invalid or unsupported Word story transaction"));
    }
    let actor_id = request
        .actor
        .get("userId")
        .ok_or_else(|| bad("missing story author"))?;
    let actor_name = request
        .actor
        .get("displayName")
        .ok_or_else(|| bad("missing story author name"))?;
    if !access_policy::valid_subject(actor_id) || !valid_display_name(actor_name) {
        return Err(bad("invalid story author"));
    }
    let _lock = state.collaboration_lock.lock().await;
    let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
    if collaboration_metadata(&state, &id).await?.protocol != CollaborationProtocol::WordRegions2 {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "story-aware Word room required".into(),
        ));
    }
    let _owner = state.word_owners.guard(&id, epoch, &headers)?;
    if word_owner::topology_cancelled(&state.root, &id, epoch, &request.transaction_id)? {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Word transaction cancelled".into(),
        ));
    }
    let access = load_access(&state, &id)?;
    if access.restricted() && !access.can_write(Some(actor_id)) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "story author no longer has write access".into(),
        ));
    }
    let bundle = open(&state, &id)?;
    let source = state.root.join("sources").join(format!("{id}.docx"));
    let candidate = hcd_docx::replay_source_story_unlink(
        &bundle,
        &source,
        request.expected_revision,
        &input.intent,
        &input.story,
        hcd_docx::StoryCopyReplay {
            choices: &input.copy_choices,
            expected_commitment: &request.candidate_hash,
        },
        |_, _| {
            Err(hcd_core::HcdError::Unsupported(
                "story extension copy policy unavailable".into(),
            ))
        },
    )
    .map_err(hcd_error)?;
    if bundle.manifest().map_err(hcd_error)?.revision == request.expected_revision {
        candidate.verify_current(&bundle).map_err(hcd_error)?;
    }
    let result = hcd_core::apply_prepared_story_unlink(
        &bundle,
        &candidate.prepared,
        &request.transaction_id,
        &request.actor,
    )
    .map_err(hcd_error)?;
    if !result.idempotent_replay {
        publish_mutation(&state, &id, &bundle, request.expected_revision).await?;
    }
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}

/// Sign evidence for an already committed native story transaction. The owner
/// must authenticate its pending journal and validate the Yjs state itself;
/// this route does not authorize or publish a topology migration.
pub(super) async fn story_receipt(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<StoryReceiptRequest>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    if claims.sub.as_deref() != Some("hcd-collaboration") || !hex(&input.coordinator_id, 32) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Word story receipt requires a coordinator".into(),
        ));
    }
    if state.remote.is_some() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "remote Word ownership adapter is not configured".into(),
        ));
    }
    let request = &input.request;
    if request.document_id != id
        || !hex(&request.transaction_id, 32)
        || ![
            &input.api_hash,
            &input.pending_hash,
            &input.initial_update_hash,
            &request.base_layout_hash,
            &request.candidate_hash,
        ]
        .iter()
        .all(|value| hex(value, 64))
        || request.actor.len() != 2
    {
        return Err(bad("invalid Word story receipt request"));
    }
    let actor_id = request
        .actor
        .get("userId")
        .ok_or_else(|| bad("missing story author"))?;
    let actor_name = request
        .actor
        .get("displayName")
        .ok_or_else(|| bad("missing story author name"))?;
    if !access_policy::valid_subject(actor_id) || !valid_display_name(actor_name) {
        return Err(bad("invalid story author"));
    }
    let _lock = state.collaboration_lock.lock().await;
    let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
    if !matches!(
        collaboration_metadata(&state, &id).await?.protocol,
        CollaborationProtocol::WordRegions1 | CollaborationProtocol::WordRegions2
    ) {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "Word regional owner required".into(),
        ));
    }
    let _owner = state.word_owners.guard(&id, epoch, &headers)?;
    let access = load_access(&state, &id)?;
    if access.restricted() && !access.can_write(Some(actor_id)) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "story author no longer has write access".into(),
        ));
    }
    let journal_hash = headers
        .get("x-hcd-word-journal-hash")
        .and_then(|v| v.to_str().ok())
        .filter(|v| hex(v, 64))
        .ok_or_else(|| bad("missing Word journal hash"))?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(hcd_error)?;
    let revision = request
        .expected_revision
        .checked_add(1)
        .filter(|revision| *revision <= head.revision)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "story receipt not found".into()))?;
    let record = bundle.revision(revision).map_err(hcd_error)?;
    let digest = hash_bytes(
        &serde_json::to_vec(&(&request.candidate_hash, &request.actor)).map_err(internal)?,
    );
    if !record.structural_change
        || record.word_layout_change
        || record.document_id != id
        || record.author_id.as_deref() != Some(actor_id.as_str())
        || record.author_name.as_deref() != Some(actor_name.as_str())
        || record.patch_base_revision != Some(request.expected_revision)
        || record.patch_id.as_deref()
            != Some(format!("word-story-unlink-{}", request.transaction_id).as_str())
        || record.patch_hash.as_deref() != Some(digest.as_str())
        || !hex(&record.root_hash, 64)
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "story receipt does not match prepared request".into(),
        ));
    }
    let base = editor_projection(&bundle, Some(request.expected_revision)).map_err(hcd_error)?;
    if base.flow_layout_hash.as_deref() != Some(request.base_layout_hash.as_str()) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "story receipt base layout changed".into(),
        ));
    }
    let projection = editor_projection(&bundle, Some(revision)).map_err(hcd_error)?;
    let layout_hash = projection
        .flow_layout_hash
        .as_ref()
        .filter(|hash| hex(hash, 64))
        .ok_or_else(|| internal("missing story layout hash"))?;
    let message = serde_json::to_vec(&json!([
        "hcd-word-story-receipt/1",
        input.api_hash,
        id,
        epoch,
        input.coordinator_id,
        journal_hash,
        request.expected_revision,
        revision,
        request.transaction_id,
        digest,
        input.pending_hash,
        record.root_hash,
        request.base_layout_hash,
        layout_hash,
        input.initial_update_hash
    ]))
    .map_err(internal)?;
    let signature = jsonwebtoken::crypto::sign(
        &message,
        &EncodingKey::from_secret(&state.secret),
        Algorithm::HS256,
    )
    .map_err(internal)?;
    Ok(Json(
        json!({"schemaVersion":"hcd-word-story-receipt/1","documentId":id,"epoch":epoch,"coordinatorId":input.coordinator_id,"journalHash":journal_hash,"expectedRevision":request.expected_revision,"revision":revision,"transactionId":request.transaction_id,"requestHash":digest,"pendingHash":input.pending_hash,"rootHash":record.root_hash,"layoutHash":layout_hash,"initialUpdateHash":input.initial_update_hash,"signature":signature,"projection":projection}),
    ))
}

/// Validate the exact proposed layout against the current native head before
/// the coordinator durably prepares it. This is read-only and is not a commit
/// promise: the subsequent transaction repeats every check under its own lock.
pub(super) async fn layout_preflight(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<WordLayoutReceiptRequest>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    if claims.sub.as_deref() != Some("hcd-collaboration")
        || !layout_coordinator_header(&headers)
        || !hex(&request.coordinator_id, 32)
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "layout-aware Word coordinator required".into(),
        ));
    }
    if state.remote.is_some() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "remote Word ownership adapter is not configured".into(),
        ));
    }
    let transaction = &request.transaction;
    if serde_json::to_vec(transaction).map_err(internal)?.len()
        > hcd_core::MAX_FLOW_LAYOUT_EDITS_BYTES
        || transaction.schema_version != hcd_core::FLOW_LAYOUT_TRANSACTION_SCHEMA
        || transaction.document_id != id
        || transaction.base_revision != transaction.expected_revision
        || transaction.actor.len() != 2
        || !hex(&transaction.transaction_id, 32)
    {
        return Err(bad("invalid Word layout transaction"));
    }
    let actor_id = transaction
        .actor
        .get("userId")
        .ok_or_else(|| bad("missing layout author"))?;
    let actor_name = transaction
        .actor
        .get("displayName")
        .ok_or_else(|| bad("missing layout author name"))?;
    if !access_policy::valid_subject(actor_id) || !valid_display_name(actor_name) {
        return Err(bad("invalid layout author"));
    }
    let _lock = state.collaboration_lock.lock().await;
    let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
    if collaboration_metadata(&state, &id).await?.protocol != CollaborationProtocol::WordRegions2 {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "layout-aware Word room required".into(),
        ));
    }
    let _owner = state.word_owners.guard(&id, epoch, &headers)?;
    let access = load_access(&state, &id)?;
    if access.restricted() && !access.can_write(Some(actor_id)) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "layout author no longer has write access".into(),
        ));
    }
    let bundle = open(&state, &id)?;
    let manifest = bundle.manifest().map_err(hcd_error)?;
    validate_layout_story_capability(&manifest, &headers)?;
    if manifest.schema_version != hcd_core::HCD_SCHEMA_VERSION
        || manifest.profile != "semantic-flow"
        || manifest.source.format != "docx"
    {
        return Err(bad("layout-aware Word document required"));
    }
    if manifest.revision != transaction.expected_revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Word layout transaction head changed".into(),
        ));
    }
    if manifest.revision >= hcd_core::MAX_REVISION {
        return Err(bad("Word revision limit reached"));
    }
    let patch_id = format!("word-layout-{}", transaction.transaction_id);
    for revision in 1..=manifest.revision {
        if bundle
            .revision(revision)
            .map_err(hcd_error)?
            .patch_id
            .as_deref()
            == Some(&patch_id)
        {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Word layout transaction ID already used".into(),
            ));
        }
    }
    let layout = hcd_core::read_flow_document_layout(&bundle, &manifest)
        .map_err(hcd_error)?
        .ok_or_else(|| bad("Word layout import required"))?;
    let preview = hcd_core::plan_flow_layout_edits(&layout, &layout, &transaction.edits)
        .map_err(hcd_error)?;
    Ok(Json(
        json!({"revision":manifest.revision,"rootHash":manifest.root_hash,"baseLayoutHash":transaction.edits.base_layout_hash,"layout":preview}),
    ))
}

/// Layout-only commit for a future layout-aware coordinator. Protocol /2 has
/// no public room migration yet; the trusted owner must drain and durably
/// prepare its room before calling. Old /1 rooms can never use this route.
pub(super) async fn layout_transaction(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<WordLayoutReceiptRequest>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    if claims.sub.as_deref() != Some("hcd-collaboration")
        || !layout_coordinator_header(&headers)
        || !hex(&request.coordinator_id, 32)
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "layout-aware Word coordinator required".into(),
        ));
    }
    if state.remote.is_some() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "remote Word ownership adapter is not configured".into(),
        ));
    }
    let transaction = &request.transaction;
    if transaction.document_id != id
        || transaction.base_revision != transaction.expected_revision
        || transaction.actor.len() != 2
        || !hex(&transaction.transaction_id, 32)
    {
        return Err(bad("invalid Word layout transaction"));
    }
    let actor_id = transaction
        .actor
        .get("userId")
        .ok_or_else(|| bad("missing layout author"))?;
    let actor_name = transaction
        .actor
        .get("displayName")
        .ok_or_else(|| bad("missing layout author name"))?;
    if !access_policy::valid_subject(actor_id) || !valid_display_name(actor_name) {
        return Err(bad("invalid layout author"));
    }
    let _lock = state.collaboration_lock.lock().await;
    let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
    if collaboration_metadata(&state, &id).await?.protocol != CollaborationProtocol::WordRegions2 {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "layout-aware Word room required".into(),
        ));
    }
    let _owner = state.word_owners.guard(&id, epoch, &headers)?;
    if word_owner::topology_cancelled(&state.root, &id, epoch, &transaction.transaction_id)? {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Word transaction cancelled".into(),
        ));
    }
    let access = load_access(&state, &id)?;
    if access.restricted() && !access.can_write(Some(actor_id)) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "layout author no longer has write access".into(),
        ));
    }
    let bundle = open(&state, &id)?;
    validate_layout_story_capability(&bundle.manifest().map_err(hcd_error)?, &headers)?;
    let result =
        hcd_core::apply_flow_layout_transaction(&bundle, transaction).map_err(hcd_error)?;
    if !result.idempotent_replay {
        publish_mutation(&state, &id, &bundle, transaction.expected_revision).await?;
    }
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}

/// Read-only evidence for an already committed layout transaction. The room
/// owner is responsible for proving its own durable prepared journal and for
/// verifying the resulting layout before acknowledging any live document.
pub(super) async fn layout_receipt(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<WordLayoutReceiptRequest>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    if claims.sub.as_deref() != Some("hcd-collaboration") || !hex(&request.coordinator_id, 32) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Word layout receipt requires a coordinator".into(),
        ));
    }
    let transaction = &request.transaction;
    let encoded = serde_json::to_vec(transaction).map_err(internal)?;
    if encoded.len() > hcd_core::MAX_FLOW_LAYOUT_EDITS_BYTES
        || transaction.document_id != id
        || transaction.schema_version != hcd_core::FLOW_LAYOUT_TRANSACTION_SCHEMA
        || !hex(&transaction.transaction_id, 32)
        || transaction.base_revision != transaction.expected_revision
        || transaction.actor.len() != 2
    {
        return Err(bad("invalid Word layout receipt request"));
    }
    let actor_id = transaction
        .actor
        .get("userId")
        .ok_or_else(|| bad("missing layout author"))?;
    let actor_name = transaction
        .actor
        .get("displayName")
        .ok_or_else(|| bad("missing layout author name"))?;
    if !access_policy::valid_subject(actor_id) || !valid_display_name(actor_name) {
        return Err(bad("invalid layout author"));
    }
    let _lock = state.collaboration_lock.lock().await;
    let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
    if !matches!(
        collaboration_metadata(&state, &id).await?.protocol,
        CollaborationProtocol::WordRegions1 | CollaborationProtocol::WordRegions2
    ) {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "Word regional owner required".into(),
        ));
    }
    let _owner = state.word_owners.guard(&id, epoch, &headers)?;
    let access = load_access(&state, &id)?;
    if access.restricted() && !access.can_write(Some(actor_id)) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "layout author no longer has write access".into(),
        ));
    }
    let journal_hash = headers
        .get("x-hcd-word-journal-hash")
        .and_then(|v| v.to_str().ok())
        .filter(|v| hex(v, 64))
        .ok_or_else(|| bad("missing Word journal hash"))?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(hcd_error)?;
    if head
        .capabilities
        .word_layout_edits
        .is_some_and(|version| version != 1)
    {
        if !layout_coordinator_header(&headers) {
            return Err(ApiError(
                StatusCode::UPGRADE_REQUIRED,
                "story-aware Word coordinator required".into(),
            ));
        }
        validate_layout_story_capability(&head, &headers)?;
    }
    let revision = transaction
        .expected_revision
        .checked_add(1)
        .filter(|revision| *revision <= head.revision)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "layout receipt not found".into()))?;
    let record = bundle.revision(revision).map_err(hcd_error)?;
    let digest = hash_bytes(&encoded);
    if !record.word_layout_change
        || record.document_id != id
        || record.author_id.as_deref() != Some(actor_id.as_str())
        || record.author_name.as_deref() != Some(actor_name.as_str())
        || record.patch_base_revision != Some(transaction.base_revision)
        || record.patch_id.as_deref()
            != Some(format!("word-layout-{}", transaction.transaction_id).as_str())
        || record.patch_hash.as_deref() != Some(digest.as_str())
        || !hex(&record.root_hash, 64)
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "layout receipt does not match prepared request".into(),
        ));
    }
    let message = format!(
        "hcd-layout-receipt/1:{id}:{epoch}:{}:{journal_hash}:{}:{revision}:{}:{digest}:{}",
        request.coordinator_id,
        transaction.expected_revision,
        transaction.transaction_id,
        record.root_hash
    );
    let signature = jsonwebtoken::crypto::sign(
        message.as_bytes(),
        &EncodingKey::from_secret(&state.secret),
        Algorithm::HS256,
    )
    .map_err(internal)?;
    // Only the authenticated, fenced owner can obtain this fixed revision.
    // It is used to verify layout and content before advancing its journal.
    let projection = editor_projection(&bundle, Some(revision)).map_err(hcd_error)?;
    Ok(Json(
        json!({"schemaVersion":"hcd-layout-receipt/1","documentId":id,"epoch":epoch,"coordinatorId":request.coordinator_id,"journalHash":journal_hash,"expectedRevision":transaction.expected_revision,"revision":revision,"transactionId":transaction.transaction_id,"requestHash":digest,"rootHash":record.root_hash,"signature":signature,"projection":projection}),
    ))
}
fn checkpoint_id(
    state: &ServerState,
    id: &str,
    epoch: u64,
    request: &WordCheckpointRequest,
) -> Result<String, ApiError> {
    if !matches!(request.coordinator_version, 5 | 6)
        || !hex(&request.coordinator_id, 32)
        || !hex(&request.checkpoint_id, 32)
        || !hex(&request.coordinator_digest, 64)
        || !hex(&request.layout_hash, 64)
    {
        return Err(bad("invalid Word checkpoint identity/model"));
    }
    // Bind every accepted field, including layout, scope ordering, images,
    // actor attribution and declared models. Equal client digests cannot hide
    // a changed regional request. JSON whitespace/key order is immaterial.
    let encoded = serde_json::to_vec(request).map_err(internal)?;
    if encoded.len() as u64 > MAX_PATCH_JSON_BYTES {
        return Err(bad("Word checkpoint exceeds 8 MiB"));
    }
    let body = hash_bytes(&encoded);
    let unsigned = format!(
        "hcdsave{}:{}:{}:{}:{body}",
        request.coordinator_version,
        request.coordinator_id,
        request.checkpoint_id,
        request.coordinator_digest
    );
    let message = format!("{id}:{epoch}:{}:{unsigned}", request.expected_revision);
    let mac = jsonwebtoken::crypto::sign(
        message.as_bytes(),
        &EncodingKey::from_secret(&state.secret),
        Algorithm::HS256,
    )
    .map_err(internal)?;
    Ok(format!("{unsigned}:{mac}"))
}
/// Bind the exact JSON request to an already committed native record. This is
/// read-only; the owner still has to prove its private journal and projection.
pub(super) async fn checkpoint_receipt(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    if claims.sub.as_deref() != Some("hcd-collaboration")
        || !(headers
            .get("x-hcd-coordinator-version")
            .and_then(|v| v.to_str().ok())
            == Some("6")
            || story_checkpoint_header(&headers))
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
    if state.remote.is_some() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "remote Word ownership adapter is not configured".into(),
        ));
    }
    if body.len() as u64 > MAX_PATCH_JSON_BYTES {
        return Err(bad("Word checkpoint exceeds 8 MiB"));
    }
    let request: WordCheckpointRequest = serde_json::from_slice(&body).map_err(bad)?;
    if request.coordinator_version != 6 {
        return Err(bad("invalid Word checkpoint identity/model"));
    }
    validate_shape(&request)?;
    let _lock = state.collaboration_lock.lock().await;
    let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
    if collaboration_metadata(&state, &id).await?.protocol != CollaborationProtocol::WordRegions2 {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "layout-aware Word room required".into(),
        ));
    }
    let _owner = state.word_owners.guard(&id, epoch, &headers)?;
    contributors(&request, &load_access(&state, &id)?)?;
    let journal_hash = headers
        .get("x-hcd-word-journal-hash")
        .and_then(|v| v.to_str().ok())
        .filter(|v| hex(v, 64))
        .ok_or_else(|| bad("missing Word journal hash"))?;
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(hcd_error)?;
    validate_checkpoint_story_capability(&head, &headers)?;
    if let Some(unchanged) =
        word_owner::checkpoint_unchanged(&state.root, &id, epoch, &request.checkpoint_id)?
    {
        let valid = jsonwebtoken::crypto::verify(
            &unchanged.signature,
            unchanged_checkpoint_message(&id, epoch, &unchanged).as_bytes(),
            &DecodingKey::from_secret(&state.secret),
            Algorithm::HS256,
        )
        .map_err(internal)?;
        let base = bundle
            .revision(request.expected_revision)
            .map_err(hcd_error)?;
        if !valid
            || unchanged.patch_id != checkpoint_id(&state, &id, epoch, &request)?
            || unchanged.request_hash != hash_bytes(&body)
            || unchanged.revision != request.expected_revision
            || unchanged.revision > head.revision
            || unchanged.root_hash != base.root_hash
        {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Word unchanged checkpoint receipt does not match request".into(),
            ));
        }
        // Reads do not rewrite the immutable receipt to the owner's newer
        // journal tip. The coordinator must prove the original tip belongs to
        // its authenticated pending chain before acknowledging late input.
        return Ok(Json(unchanged_checkpoint_receipt(&id, epoch, &unchanged)));
    }
    let target = request
        .expected_revision
        .checked_add(1)
        .filter(|revision| *revision <= head.revision)
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                "Word checkpoint receipt not found".into(),
            )
        })?;
    let record = bundle.revision(target).map_err(hcd_error)?;
    let patch_id = checkpoint_id(&state, &id, epoch, &request)?;
    if record.patch_id.as_deref() != Some(&patch_id)
        || record.patch_base_revision != Some(request.expected_revision)
        || !hex(&record.root_hash, 64)
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Word checkpoint receipt does not match request".into(),
        ));
    }
    let request_hash = hash_bytes(&body);
    let message = format!("hcd-word-checkpoint-receipt/1:{id}:{epoch}:{journal_hash}:{request_hash}:{target}:{}:{patch_id}",record.root_hash);
    let signature = jsonwebtoken::crypto::sign(
        message.as_bytes(),
        &EncodingKey::from_secret(&state.secret),
        Algorithm::HS256,
    )
    .map_err(internal)?;
    Ok(Json(
        json!({"schemaVersion":"hcd-word-checkpoint-receipt/1","documentId":id,"epoch":epoch,"journalHash":journal_hash,"requestHash":request_hash,"revision":target,"rootHash":record.root_hash,"patchId":patch_id,"signature":signature}),
    ))
}
fn contributors(request: &WordCheckpointRequest, access: &DocumentAccess) -> Result<(), ApiError> {
    if request.contributors.is_empty() || request.contributors.len() > 1000 {
        return Err(bad("Word checkpoint requires bounded contributors"));
    }
    let mut seen = HashSet::new();
    for actor in &request.contributors {
        if !access_policy::valid_subject(&actor.user_id)
            || !valid_display_name(&actor.display_name)
            || !seen.insert(&actor.user_id)
        {
            return Err(bad("invalid/duplicate Word checkpoint contributor"));
        }
        if access.restricted() && !access.can_write(Some(&actor.user_id)) {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "Word checkpoint contributor no longer has write access".into(),
            ));
        }
    }
    Ok(())
}
fn validate_shape(request: &WordCheckpointRequest) -> Result<(), ApiError> {
    if request.regions.is_empty() || request.regions.len() > 12288 {
        return Err(bad("invalid Word checkpoint region count"));
    }
    let mut count = 0usize;
    let mut images = HashSet::new();
    let mut regions = HashSet::new();
    let mut blocks = HashSet::new();
    for region in &request.regions {
        if !regions.insert(&region.region_id) || region.blocks.is_empty() {
            return Err(bad("duplicate/empty Word checkpoint region"));
        }
        count = count.saturating_add(region.blocks.len());
        if count > 1_000_000 {
            return Err(bad("Word checkpoint block limit exceeded"));
        }
        for block in &region.blocks {
            if let Some(id) = &block.block_id {
                if id.is_empty() || id.len() > 256 || !blocks.insert(id) {
                    return Err(bad("invalid/duplicate Word checkpoint block ID"));
                }
            }
        }
        for image in &region.images {
            if !images.insert(&image.node_id) || images.len() > 1000 {
                return Err(bad("duplicate/excessive Word checkpoint images"));
            }
        }
    }
    Ok(())
}
fn flatten(request: &WordCheckpointRequest, current: &EditorProjection) -> SnapshotRequest {
    SnapshotRequest {
        coordinator_version: Some(5),
        coordinator_id: Some(request.coordinator_id.clone()),
        checkpoint_id: Some(request.checkpoint_id.clone()),
        coordinator_digest: Some(request.coordinator_digest.clone()),
        expected_revision: request.expected_revision,
        typography_version: request.typography_version,
        blocks: request
            .regions
            .iter()
            .flat_map(|region| region.blocks.clone())
            .chain(
                current
                    .blocks
                    .iter()
                    .filter(|block| block.flow_region_id.is_none())
                    .map(|block| SnapshotBlock {
                        block_id: Some(block.block_id.clone()),
                        content: block.content.clone(),
                    }),
            )
            .collect(),
        images: request
            .regions
            .iter()
            .flat_map(|region| region.images.clone())
            .collect(),
        contributors: request.contributors.clone(),
        reference_authors: request.reference_authors.clone(),
        reference_version: request.reference_version,
        extension_version: request.extension_version,
    }
}
fn plan(
    current: &EditorProjection,
    request: &WordCheckpointRequest,
) -> Result<Vec<FlowRegionEdits>, ApiError> {
    let layout = current
        .flow_layout
        .as_ref()
        .filter(|layout| layout.schema_version == FLOW_REGION_LAYOUT_SCHEMA)
        .ok_or_else(|| {
            ApiError(
                StatusCode::UPGRADE_REQUIRED,
                "project Word regions before regional checkpoints".into(),
            )
        })?;
    if current.flow_layout_hash.as_deref() != Some(&request.layout_hash) {
        return Err(ApiError(
            StatusCode::PRECONDITION_FAILED,
            "Word section/story layout changed".into(),
        ));
    }
    let catalog = hcd_core::flow_regions(layout);
    if catalog.len() != request.regions.len() {
        return Err(bad(
            "Word checkpoint must include every body section and story",
        ));
    }
    let known: HashMap<_, _> = current
        .blocks
        .iter()
        .map(|block| (block.block_id.as_str(), block.flow_region_id.as_deref()))
        .collect();
    let mut sources = HashMap::new();
    for block in &current.blocks {
        for inline in snapshot_source_inlines(&block.content) {
            if let Some(id) = &inline.node_id {
                sources.insert(id.as_str(), block.flow_region_id.as_deref());
            }
        }
    }
    let requested: HashMap<_, _> = request
        .regions
        .iter()
        .map(|group| (group.region_id.as_str(), group))
        .collect();
    let mut surfaces: HashMap<&str, Vec<EditorBlockView>> = HashMap::new();
    for block in &current.blocks {
        if let Some(region) = block.flow_region_id.as_deref() {
            surfaces.entry(region).or_default().push(block.clone());
        }
    }
    let mut output = Vec::new();
    for region in catalog {
        let desired = requested
            .get(region.id.as_str())
            .ok_or_else(|| bad("Word checkpoint has a missing/unknown region"))?;
        for block in &desired.blocks {
            if let Some(id) = block.block_id.as_deref() {
                match known.get(id) {
                    Some(owner) if *owner != Some(&region.id) => {
                        return Err(bad("canonical block belongs to another Word region"))
                    }
                    None if !id.starts_with("tmp_") => {
                        return Err(bad("unknown Word checkpoint block ID"))
                    }
                    _ => {}
                }
            }
            for inline in snapshot_source_inlines(&block.content) {
                if let Some(id) = inline.node_id.as_deref() {
                    if sources.get(id).copied().flatten() != Some(&region.id) {
                        return Err(bad("text source belongs to another or unknown Word region"));
                    }
                }
            }
        }
        let mut surface = EditorProjection {
            document_id: current.document_id.clone(),
            revision: current.revision,
            blocks: surfaces.remove(region.id.as_str()).unwrap_or_default(),
            flow_layout: None,
            flow_layout_hash: None,
            tracked_changes: Vec::new(),
            comments: Vec::new(),
        };
        // Reuse the same readonly, split/join/source-ownership and rich block
        // planner. This transient role never reaches canonical HTML or maps.
        for block in &mut surface.blocks {
            block.region = "body".into();
        }
        let all_new = desired.blocks.iter().all(|block| {
            block
                .block_id
                .as_deref()
                .is_none_or(|id| !known.contains_key(id))
        });
        let operations = plan_snapshot_structure(&surface, &desired.blocks)?;
        let mut operations = if all_new {
            // A region always needs a root for insertion addressing. Insert
            // new roots first when the full old surface is being replaced.
            let (mut inserts, rest): (Vec<_>, Vec<_>) = operations
                .into_iter()
                .partition(|op| matches!(op, StructureOperation::Insert { .. }));
            inserts.extend(rest);
            inserts
        } else {
            operations
        };
        operations.extend(desired.images.iter().map(|image| match &image.asset_hash {
            Some(hash) => StructureOperation::ImageReplace {
                node_id: image.node_id.clone(),
                asset_hash: hash.clone(),
                geometry: Some(image.geometry.clone()),
                precondition: image.precondition.clone(),
            },
            None => StructureOperation::ImageGeometry {
                node_id: image.node_id.clone(),
                geometry: image.geometry.clone(),
                precondition: image.precondition.clone(),
            },
        }));
        if !operations.is_empty() {
            output.push(FlowRegionEdits {
                region_id: region.id,
                operations,
            });
        }
    }
    Ok(output)
}

pub(super) async fn checkpoint_http(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, ApiError> {
    if body.len() as u64 > MAX_PATCH_JSON_BYTES {
        return Err(bad("Word checkpoint exceeds 8 MiB"));
    }
    let request: WordCheckpointRequest = serde_json::from_slice(&body).map_err(bad)?;
    checkpoint_inner(state, id, headers, request, hash_bytes(&body)).await
}
#[cfg(test)]
async fn checkpoint(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<WordCheckpointRequest>,
) -> Result<Json<Value>, ApiError> {
    let value = serde_json::to_value(&request).map_err(internal)?;
    let hash = hash_bytes(&serde_json::to_vec(&value).map_err(internal)?);
    checkpoint_inner(state, id, headers, request, hash).await
}
fn unchanged_checkpoint_message(
    id: &str,
    epoch: u64,
    record: &word_owner::UnchangedCheckpoint,
) -> String {
    format!(
        "hcd-word-checkpoint-unchanged/2:{id}:{epoch}:{}:{}:{}:{}:{}",
        record.journal_hash,
        record.request_hash,
        record.revision,
        record.root_hash,
        record.patch_id
    )
}
fn unchanged_checkpoint_reply(
    id: &str,
    epoch: u64,
    record: &word_owner::UnchangedCheckpoint,
    projection: EditorProjection,
) -> Json<Value> {
    Json(
        json!({"saved":true,"revision":record.revision,"rootHash":record.root_hash,"projection":projection,"images":[],"saveMode":"word-regions-unchanged","unchangedReceipt":unchanged_checkpoint_receipt(id, epoch, record)}),
    )
}
fn unchanged_checkpoint_receipt(
    id: &str,
    epoch: u64,
    record: &word_owner::UnchangedCheckpoint,
) -> Value {
    json!({"schemaVersion":"hcd-word-checkpoint-unchanged/2","documentId":id,"epoch":epoch,"journalHash":record.journal_hash,"requestHash":record.request_hash,"revision":record.revision,"rootHash":record.root_hash,"patchId":record.patch_id,"signature":record.signature})
}
async fn checkpoint_inner(
    state: ServerState,
    id: String,
    headers: HeaderMap,
    request: WordCheckpointRequest,
    request_hash: String,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    if claims.sub.as_deref() != Some("hcd-collaboration")
        || !matches!(request.coordinator_version, 5 | 6)
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "regional snapshots require the Word save coordinator version 5".into(),
        ));
    }
    require_flow_layout_support(Some(2), &headers)?;
    validate_shape(&request)?;
    let _guard = state.collaboration_lock.lock().await;
    let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
    let protocol = collaboration_metadata(&state, &id).await?.protocol;
    let layout_aware = protocol == CollaborationProtocol::WordRegions2;
    if layout_aware
        && (request.coordinator_version != 6
            || !(headers
                .get("x-hcd-coordinator-version")
                .and_then(|v| v.to_str().ok())
                == Some("6")
                || story_checkpoint_header(&headers))
            || headers
                .get("x-hcd-word-layout-version")
                .and_then(|v| v.to_str().ok())
                != Some("1"))
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "layout-aware Word checkpoint required".into(),
        ));
    }
    if !layout_aware && request.coordinator_version != 5 {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "Word checkpoint protocol changed".into(),
        ));
    }
    let _owner = if matches!(
        protocol,
        CollaborationProtocol::WordRegions1 | CollaborationProtocol::WordRegions2
    ) {
        Some(state.word_owners.guard(&id, epoch, &headers)?)
    } else {
        None
    };
    if layout_aware
        && word_owner::checkpoint_cancelled(&state.root, &id, epoch, &request.checkpoint_id)?
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Word checkpoint was cancelled".into(),
        ));
    }
    contributors(&request, &load_access(&state, &id)?)?;
    let patch_id = checkpoint_id(&state, &id, epoch, &request)?;
    let unchanged = if layout_aware {
        word_owner::checkpoint_unchanged(&state.root, &id, epoch, &request.checkpoint_id)?
    } else {
        None
    };
    if let Some(record) = &unchanged {
        let journal_hash = headers
            .get("x-hcd-word-journal-hash")
            .and_then(|v| v.to_str().ok())
            .filter(|v| hex(v, 64))
            .ok_or_else(|| bad("missing Word journal hash"))?;
        let valid = jsonwebtoken::crypto::verify(
            &record.signature,
            unchanged_checkpoint_message(&id, epoch, record).as_bytes(),
            &DecodingKey::from_secret(&state.secret),
            Algorithm::HS256,
        )
        .map_err(internal)?;
        if !valid
            || record.patch_id != patch_id
            || record.journal_hash != journal_hash
            || record.request_hash != request_hash
            || record.revision != request.expected_revision
        {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Word checkpoint identity already used".into(),
            ));
        }
    }
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(hcd_error)?;
    if layout_aware {
        validate_checkpoint_story_capability(&head, &headers)?;
    }
    if !layout_aware {
        require_legacy_word_layout_safe(&head)?;
    }
    if let Some(record) = &unchanged {
        if record.revision > head.revision
            || bundle
                .revision(record.revision)
                .map_err(hcd_error)?
                .root_hash
                != record.root_hash
        {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Word unchanged checkpoint baseline changed".into(),
            ));
        }
        let projection = editor_projection(&bundle, Some(record.revision)).map_err(hcd_error)?;
        return Ok(unchanged_checkpoint_reply(&id, epoch, record, projection));
    }
    let images: Vec<_> = request
        .regions
        .iter()
        .flat_map(|region| region.images.clone())
        .collect();
    if let Some(revision) = request
        .expected_revision
        .checked_add(1)
        .filter(|revision| *revision <= head.revision)
    {
        let record = bundle.revision(revision).map_err(hcd_error)?;
        if record.patch_id.as_deref() == Some(&patch_id) {
            let projection = editor_projection(&bundle, Some(revision)).map_err(hcd_error)?;
            return Ok(Json(
                json!({"saved":true,"revision":revision,"rootHash":record.root_hash,"projection":projection,"images":checkpoint_images(&bundle,&images,revision)?,"saveMode":"word-regions-replayed","idempotentReplay":true}),
            ));
        }
    }
    if layout_aware {
        // A checkpoint ID is an attempt identity, not merely part of a hash.
        // Reusing it with a different payload must never create another version.
        for revision in 1..=head.revision {
            let record = bundle.revision(revision).map_err(hcd_error)?;
            if record.patch_id.as_deref().is_some_and(|value| {
                let parts: Vec<_> = value.split(':').collect();
                parts.len() == 6
                    && matches!(parts[0], "hcdsave5" | "hcdsave6")
                    && parts[2] == request.checkpoint_id
            }) {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "Word checkpoint identity already used".into(),
                ));
            }
        }
    }
    if head.revision != request.expected_revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Word checkpoint base revision changed".into(),
        ));
    }
    let current = editor_projection(&bundle, None).map_err(hcd_error)?;
    let regions = plan(&current, &request)?;
    let flat = flatten(&request, &current);
    people::validate_snapshot(&state, &id, &current, &flat)?;
    require_typography_support(&current, request.typography_version)?;
    let mut custom = head.capabilities.custom_marks.is_some();
    let mut inline = head.capabilities.extension_nodes == Some(3);
    for block in &flat.blocks {
        custom |= hcd_core::content_custom_marks(&block.content).map_err(hcd_error)?;
        inline |= hcd_core::content_extensions(&block.content)
            .map_err(hcd_error)?
            .iter()
            .any(|node| node.envelope_version() == 3);
    }
    require_inline_containers_support(inline, &headers)?;
    require_custom_marks_support(custom, &headers)?;
    if regions.is_empty() {
        if layout_aware {
            let journal_hash = headers
                .get("x-hcd-word-journal-hash")
                .and_then(|v| v.to_str().ok())
                .filter(|v| hex(v, 64))
                .ok_or_else(|| bad("missing Word journal hash"))?;
            let mut record = word_owner::UnchangedCheckpoint {
                patch_id,
                journal_hash: journal_hash.into(),
                request_hash,
                revision: current.revision,
                root_hash: head.root_hash,
                signature: String::new(),
            };
            record.signature = jsonwebtoken::crypto::sign(
                unchanged_checkpoint_message(&id, epoch, &record).as_bytes(),
                &EncodingKey::from_secret(&state.secret),
                Algorithm::HS256,
            )
            .map_err(internal)?;
            word_owner::seal_checkpoint_unchanged(
                &state.root,
                &id,
                epoch,
                &request.checkpoint_id,
                &record,
            )?;
            return Ok(unchanged_checkpoint_reply(&id, epoch, &record, current));
        }
        return Ok(Json(
            json!({"saved":true,"revision":current.revision,"rootHash":head.root_hash,"projection":current,"images":[],"saveMode":"word-regions-unchanged"}),
        ));
    }
    let mut actor = author_actor(&claims, &request.contributors);
    if !request.reference_authors.is_empty() {
        actor.insert(
            "referenceAuthors".into(),
            serde_json::to_string(
                &request
                    .reference_authors
                    .iter()
                    .map(|author| (author.mention_id.clone(), author.user_id.clone()))
                    .collect::<BTreeMap<_, _>>(),
            )
            .map_err(internal)?,
        );
    }
    let patch = FlowStructurePatchBatch {
        schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_6.into(),
        document_id: id.clone(),
        patch_id,
        base_revision: current.revision,
        layout_hash: request.layout_hash,
        actor,
        regions,
    };
    let result = hcd_core::apply_flow_structure_patch(&bundle, &patch, current.revision)
        .map_err(hcd_error)?;
    finish_checkpoint(
        &state,
        &id,
        &bundle,
        result,
        current.revision,
        &images,
        "word-regions",
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn story_checkpoint_requires_matching_versioned_capability() {
        let root = tempfile::tempdir().unwrap();
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-regions-2026-10-26/image-source.docx");
        let path = root.path().join("doc.hcd");
        hcd_docx::import_docx(&source, &path, &hcd_docx::ImportOptions::new("doc"), |_| {
            Ok(())
        })
        .unwrap();
        let mut manifest = Bundle::open(path).unwrap().manifest().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-hcd-coordinator-version", "6".parse().unwrap());
        headers.insert("x-hcd-word-layout-version", "1".parse().unwrap());
        manifest.capabilities.word_layout_edits = Some(3);
        assert!(layout_coordinator_header(&headers));
        assert!(validate_layout_story_capability(&manifest, &headers).is_err());
        assert!(validate_checkpoint_story_capability(&manifest, &headers).is_err());
        headers.insert("x-hcd-coordinator-version", "7".parse().unwrap());
        assert!(validate_checkpoint_story_capability(&manifest, &headers).is_err());
        headers.insert("x-hcd-word-story-version", "1".parse().unwrap());
        assert!(validate_checkpoint_story_capability(&manifest, &headers).is_ok());
        assert!(layout_coordinator_header(&headers));
        assert!(validate_layout_story_capability(&manifest, &headers).is_ok());
        manifest.capabilities.word_layout_edits = Some(4);
        assert!(validate_layout_story_capability(&manifest, &headers).is_err());
        manifest.capabilities.word_layout_edits = Some(2);
        assert!(validate_layout_story_capability(&manifest, &headers).is_err());
        assert!(validate_checkpoint_story_capability(&manifest, &headers).is_err());
        headers.insert("x-hcd-coordinator-version", "6".parse().unwrap());
        assert!(validate_checkpoint_story_capability(&manifest, &headers).is_err());
        manifest.capabilities.word_layout_edits = Some(1);
        assert!(validate_checkpoint_story_capability(&manifest, &headers).is_ok());
    }
    #[tokio::test]
    async fn story_transaction_requires_owner_and_replays_exact_candidate() {
        let root = tempfile::tempdir().unwrap();
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-regions-2026-10-26/image-source.docx");
        let mut options = hcd_docx::ImportOptions::new("doc");
        options.flow_layout = true;
        let path = root.path().join("doc.hcd");
        hcd_docx::import_docx(&source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(path).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        std::fs::create_dir(root.path().join("sources")).unwrap();
        std::fs::copy(&source, root.path().join("sources/doc.docx")).unwrap();
        let base = editor_projection(&bundle, Some(1)).unwrap();
        let layout = base.flow_layout.as_ref().unwrap();
        let intent = hcd_core::FlowStoryUnlinkRequest {
            base_layout_hash: base.flow_layout_hash.clone().unwrap(),
            section_id: layout.sections[1].id.clone(),
            kind: hcd_core::FlowStoryKind::Header,
            variant: hcd_core::FlowStoryVariant::First,
            expected_inherited_story_id: layout.sections[0].headers.first.clone(),
        };
        let story = hcd_core::FlowStory {
            id: format!("n_{:032x}", 999989),
            kind: hcd_core::FlowStoryKind::Header,
            source_part: "word/http-independent.xml".into(),
        };
        let candidate = hcd_docx::prepare_source_story_unlink(
            &bundle,
            &source,
            1,
            &intent,
            &story,
            |_| unreachable!(),
            |_| unreachable!(),
        )
        .unwrap();
        let input = json!({"coordinatorId":"e".repeat(32),"request":{"documentId":"doc","transactionId":"d".repeat(32),"expectedRevision":1,"baseLayoutHash":intent.base_layout_hash,"candidateHash":candidate.prepared.commitment().unwrap(),"actor":{"userId":"alice","displayName":"Alice"}},"intent":intent,"story":story,"copyChoices":candidate.prepared.copy_choices().unwrap()});
        let state = ServerState {
            root: root.path().into(),
            secret: Arc::new(vec![b'x'; 32]),
            remote: None,
            collaboration_lock: Arc::new(Mutex::new(())),
            revisions: RevisionHub::default(),
            word_owners: word_owner::WordOwners::default(),
        };
        write_collaboration_metadata(
            &state,
            "doc",
            &CollaborationMetadata {
                epoch: 0,
                protocol: CollaborationProtocol::WordRegions2,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut service = headers(&state, "write", "hcd-collaboration");
        service.insert("x-hcd-coordinator-version", "5".parse().unwrap());
        service.insert(
            "x-hcd-collaboration-protocol",
            "hcd-word-regions/2".parse().unwrap(),
        );
        let acquire:word_owner::Request=serde_json::from_value(json!({"version":1,"epoch":0,"ownerId":"a".repeat(32),"storeId":"b".repeat(32),"action":"acquire","journalHashes":["none"]})).unwrap();
        let lease = word_owner::owner(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(acquire),
        )
        .await
        .unwrap()
        .0;
        let record:word_owner::Request=serde_json::from_value(json!({"version":1,"epoch":0,"ownerId":"a".repeat(32),"storeId":"b".repeat(32),"action":"record","leaseId":lease["leaseId"],"journalHashes":["none","c".repeat(64)]})).unwrap();
        let lease = word_owner::owner(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(record),
        )
        .await
        .unwrap()
        .0;
        for (header, field) in [
            ("x-hcd-word-owner", "leaseId"),
            ("x-hcd-word-owner-id", "ownerId"),
            ("x-hcd-word-journal-hash", "journalHash"),
        ] {
            service.insert(header, lease[field].as_str().unwrap().parse().unwrap());
        }
        service.insert("x-hcd-coordinator-version", "7".parse().unwrap());
        service.insert("x-hcd-word-story-version", "1".parse().unwrap());
        let parse =
            |value: Value| serde_json::from_value::<StoryTransactionRequest>(value).unwrap();
        let mut stale = service.clone();
        stale.insert("x-hcd-word-journal-hash", "f".repeat(64).parse().unwrap());
        assert_eq!(
            story_transaction(
                State(state.clone()),
                Path("doc".into()),
                stale,
                Json(parse(input.clone()))
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::CONFLICT
        );
        let mut changed = input.clone();
        changed["request"]["candidateHash"] = json!("f".repeat(64));
        assert!(story_transaction(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(parse(changed))
        )
        .await
        .is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        let mut legacy = service.clone();
        legacy.insert("x-hcd-coordinator-version", "5".parse().unwrap());
        assert_eq!(
            story_transaction(
                State(state.clone()),
                Path("doc".into()),
                legacy,
                Json(parse(input.clone()))
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::UPGRADE_REQUIRED
        );
        std::fs::write(root.path().join("sources/doc.docx"), b"changed source").unwrap();
        assert!(story_transaction(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(parse(input.clone()))
        )
        .await
        .is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        std::fs::copy(&source, root.path().join("sources/doc.docx")).unwrap();
        let saved = story_transaction(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(parse(input.clone())),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(saved["revision"], 2);
        assert_eq!(saved["idempotentReplay"], false);
        let replay = story_transaction(
            State(state.clone()),
            Path("doc".into()),
            service,
            Json(parse(input)),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(replay["revision"], 2);
        assert_eq!(replay["idempotentReplay"], true);
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
    }
    #[tokio::test]
    async fn story_receipt_requires_committed_exact_transaction_and_owner() {
        let root = tempfile::tempdir().unwrap();
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-regions-2026-10-26/image-source.docx");
        let mut options = hcd_docx::ImportOptions::new("doc");
        options.flow_layout = true;
        let path = root.path().join("doc.hcd");
        hcd_docx::import_docx(&source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(path).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        let base = editor_projection(&bundle, Some(1)).unwrap();
        let layout = base.flow_layout.as_ref().unwrap();
        let intent = hcd_core::FlowStoryUnlinkRequest {
            base_layout_hash: base.flow_layout_hash.clone().unwrap(),
            section_id: layout.sections[1].id.clone(),
            kind: hcd_core::FlowStoryKind::Header,
            variant: hcd_core::FlowStoryVariant::First,
            expected_inherited_story_id: layout.sections[0].headers.first.clone(),
        };
        let story = hcd_core::FlowStory {
            id: format!("n_{:032x}", 999990),
            kind: hcd_core::FlowStoryKind::Header,
            source_part: "word/receipt-test.xml".into(),
        };
        let candidate = hcd_docx::prepare_source_story_unlink(
            &bundle,
            &source,
            1,
            &intent,
            &story,
            |_| unreachable!(),
            |_| unreachable!(),
        )
        .unwrap();
        let actor = BTreeMap::from([
            ("userId".into(), "alice".into()),
            ("displayName".into(), "Alice 王".into()),
        ]);
        let commitment = candidate.prepared.commitment().unwrap();
        let saved = hcd_core::apply_prepared_story_unlink(
            &bundle,
            &candidate.prepared,
            &"d".repeat(32),
            &actor,
        )
        .unwrap();
        let state = ServerState {
            root: root.path().into(),
            secret: Arc::new(vec![b'x'; 32]),
            remote: None,
            collaboration_lock: Arc::new(Mutex::new(())),
            revisions: RevisionHub::default(),
            word_owners: word_owner::WordOwners::default(),
        };
        write_collaboration_metadata(
            &state,
            "doc",
            &CollaborationMetadata {
                epoch: 0,
                protocol: CollaborationProtocol::WordRegions1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut service = headers(&state, "write", "hcd-collaboration");
        service.insert("x-hcd-coordinator-version", "5".parse().unwrap());
        service.insert(
            "x-hcd-collaboration-protocol",
            "hcd-word-regions/1".parse().unwrap(),
        );
        let acquire: word_owner::Request = serde_json::from_value(json!({"version":1,"epoch":0,"ownerId":"a".repeat(32),"storeId":"b".repeat(32),"action":"acquire","journalHashes":["none"]})).unwrap();
        let acquired = word_owner::owner(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(acquire),
        )
        .await
        .unwrap()
        .0;
        let journal = "c".repeat(64);
        let register: word_owner::Request = serde_json::from_value(json!({"version":1,"epoch":0,"ownerId":"a".repeat(32),"storeId":"b".repeat(32),"action":"record","leaseId":acquired["leaseId"],"journalHashes":["none",journal]})).unwrap();
        let lease = word_owner::owner(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(register),
        )
        .await
        .unwrap()
        .0;
        for (header, field) in [
            ("x-hcd-word-owner", "leaseId"),
            ("x-hcd-word-owner-id", "ownerId"),
            ("x-hcd-word-journal-hash", "journalHash"),
        ] {
            service.insert(header, lease[field].as_str().unwrap().parse().unwrap());
        }
        let request = StoryReceiptRequest {
            api_hash: "1".repeat(64),
            coordinator_id: "e".repeat(32),
            pending_hash: "2".repeat(64),
            initial_update_hash: "3".repeat(64),
            request: StoryReceiptTransaction {
                document_id: "doc".into(),
                transaction_id: "d".repeat(32),
                expected_revision: 1,
                base_layout_hash: intent.base_layout_hash,
                candidate_hash: commitment,
                actor,
            },
        };
        let proof = story_receipt(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(request.clone()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(proof["revision"], saved.revision);
        let message = serde_json::to_vec(&json!([
            "hcd-word-story-receipt/1",
            request.api_hash,
            "doc",
            0,
            request.coordinator_id,
            journal,
            1,
            saved.revision,
            request.request.transaction_id,
            proof["requestHash"],
            request.pending_hash,
            saved.root_hash,
            request.request.base_layout_hash,
            proof["layoutHash"],
            request.initial_update_hash
        ]))
        .unwrap();
        assert_eq!(
            proof["signature"],
            jsonwebtoken::crypto::sign(
                &message,
                &EncodingKey::from_secret(&state.secret),
                Algorithm::HS256
            )
            .unwrap()
        );
        // Exercise the real access middleware on a local HTTP listener, not
        // only the handler. Old clients cannot acquire the recovery lease or
        // use ordinary mutation paths on the new topology.
        let app = Router::new()
            .route(
                "/v1/documents/{id}/collaboration/word-owner",
                post(word_owner::owner),
            )
            .route("/v1/documents/{id}/word/story-receipt", post(story_receipt))
            .route(
                "/v1/documents/{id}/patch",
                post(|| async { StatusCode::OK }),
            )
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                access_gate,
            ))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        async fn http(
            address: std::net::SocketAddr,
            route: &str,
            headers: &HeaderMap,
            body: &Value,
        ) -> (u16, String) {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let body = serde_json::to_vec(body).unwrap();
            let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
            let mut request = format!("POST {route} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",body.len());
            for (name, value) in headers {
                request.push_str(&format!("{}: {}\r\n", name, value.to_str().unwrap()));
            }
            request.push_str("\r\n");
            stream.write_all(request.as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).await.unwrap();
            let response = String::from_utf8(response).unwrap();
            let status = response
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap()
                .parse()
                .unwrap();
            (status, response)
        }
        let renew = json!({"version":1,"epoch":0,"ownerId":"a".repeat(32),"storeId":"b".repeat(32),"action":"renew","leaseId":acquired["leaseId"],"journalHashes":[]});
        assert_eq!(
            http(
                address,
                "/v1/documents/doc/collaboration/word-owner",
                &service,
                &renew
            )
            .await
            .0,
            426
        );
        let mut recovery_headers = service.clone();
        recovery_headers.insert("x-hcd-word-story-recovery", "1".parse().unwrap());
        assert_eq!(
            http(
                address,
                "/v1/documents/doc/collaboration/word-owner",
                &recovery_headers,
                &renew
            )
            .await
            .0,
            200
        );
        let body = json!({"apiHash":request.api_hash,"coordinatorId":request.coordinator_id,"pendingHash":request.pending_hash,"initialUpdateHash":request.initial_update_hash,"request":{"documentId":"doc","transactionId":request.request.transaction_id,"expectedRevision":1,"baseLayoutHash":request.request.base_layout_hash,"candidateHash":request.request.candidate_hash,"actor":request.request.actor}});
        let (status, response) = http(
            address,
            "/v1/documents/doc/word/story-receipt",
            &service,
            &body,
        )
        .await;
        assert_eq!(status, 200);
        assert!(response.contains("\"projection\""));
        assert_eq!(
            http(
                address,
                "/v1/documents/doc/patch",
                &recovery_headers,
                &json!({})
            )
            .await
            .0,
            426
        );
        server.abort();
        let mut altered = request.clone();
        altered.request.candidate_hash = "f".repeat(64);
        assert_eq!(
            story_receipt(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(altered)
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::CONFLICT
        );
        let mut altered = request.clone();
        altered.request.base_layout_hash = "f".repeat(64);
        assert_eq!(
            story_receipt(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(altered)
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::CONFLICT
        );
        service.insert("x-hcd-word-journal-hash", "f".repeat(64).parse().unwrap());
        assert_eq!(
            story_receipt(
                State(state.clone()),
                Path("doc".into()),
                service,
                Json(request.clone())
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            story_receipt(
                State(state.clone()),
                Path("doc".into()),
                headers(&state, "write", "alice"),
                Json(request)
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(bundle.manifest().unwrap().revision, 2);
    }
    fn fixture() -> (tempfile::TempDir, ServerState, Bundle) {
        let root = tempfile::tempdir().unwrap();
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-layout-2026-10-26/source.docx");
        let mut options = hcd_docx::ImportOptions::new("doc");
        options.flow_layout = true;
        let path = root.path().join("doc.hcd");
        hcd_docx::import_docx(source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(path).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        let state = ServerState {
            root: root.path().into(),
            secret: Arc::new(vec![b'x'; 32]),
            remote: None,
            collaboration_lock: Arc::new(Mutex::new(())),
            revisions: RevisionHub::default(),
            word_owners: word_owner::WordOwners::default(),
        };
        (root, state, bundle)
    }
    fn headers(state: &ServerState, scope: &str, subject: &str) -> HeaderMap {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize;
        let claims = Claims {
            doc: "doc".into(),
            scope: scope.into(),
            sub: Some(subject.into()),
            name: Some(subject.into()),
            aud: "hcd-core".into(),
            iat: now,
            exp: now + 3600,
        };
        let token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(&state.secret),
        )
        .unwrap();
        let mut headers = HeaderMap::new();
        for (key, value) in [
            ("authorization", format!("Bearer {token}")),
            ("x-hcd-collaboration-epoch", "0".into()),
            ("x-hcd-flow-layout-version", "2".into()),
            ("x-hcd-custom-marks-version", "1".into()),
            ("x-hcd-node-edits-version", "7".into()),
        ] {
            headers.insert(key, value.parse().unwrap());
        }
        headers
    }
    fn request(projection: &EditorProjection) -> WordCheckpointRequest {
        WordCheckpointRequest {
            coordinator_version: 5,
            coordinator_id: "a".repeat(32),
            checkpoint_id: "b".repeat(32),
            coordinator_digest: "c".repeat(64),
            expected_revision: projection.revision,
            layout_hash: projection.flow_layout_hash.clone().unwrap(),
            typography_version: Some(2),
            contributors: vec![Contributor {
                user_id: "alice".into(),
                display_name: "Alice 王".into(),
            }],
            reference_authors: vec![],
            reference_version: Some(1),
            extension_version: Some(1),
            regions: hcd_core::flow_regions(projection.flow_layout.as_ref().unwrap())
                .into_iter()
                .map(|region| WordSnapshotRegion {
                    region_id: region.id.clone(),
                    blocks: projection
                        .blocks
                        .iter()
                        .filter(|block| block.flow_region_id.as_deref() == Some(&region.id))
                        .map(|block| SnapshotBlock {
                            block_id: Some(block.block_id.clone()),
                            content: block.content.clone(),
                        })
                        .collect(),
                    images: vec![],
                })
                .collect(),
        }
    }
    fn paragraph(text: &str) -> EditorBlockContent {
        serde_json::from_value(json!({"kind":"paragraph","inlines":[{"text":text,"bold":true}]}))
            .unwrap()
    }
    fn rich_request(projection: &EditorProjection) -> WordCheckpointRequest {
        let mut request = request(projection);
        for (kind, text) in [
            ("body", "Body rich"),
            ("header", "Header rich"),
            ("footer", "Footer rich"),
        ] {
            let block = projection
                .blocks
                .iter()
                .find(|block| block.region == kind && !block.read_only)
                .unwrap();
            request
                .regions
                .iter_mut()
                .find(|region| Some(region.region_id.as_str()) == block.flow_region_id.as_deref())
                .unwrap()
                .blocks
                .iter_mut()
                .find(|row| row.block_id.as_deref() == Some(&block.block_id))
                .unwrap()
                .content = paragraph(text);
        }
        request
    }
    async fn send(state: &ServerState, request: WordCheckpointRequest) -> Result<Value, ApiError> {
        checkpoint(
            State(state.clone()),
            Path("doc".into()),
            headers(state, "write", "hcd-collaboration"),
            Json(request),
        )
        .await
        .map(|result| result.0)
    }
    #[tokio::test]
    async fn layout_transaction_requires_v2_owner_and_replays_exact_request() {
        let (_root, state, bundle) = fixture();
        let projection = editor_projection(&bundle, None).unwrap();
        let layout = projection.flow_layout.as_ref().unwrap();
        let width = layout.sections[0].page.width_twips.unwrap();
        let transaction = hcd_core::FlowLayoutTransaction {
            schema_version: hcd_core::FLOW_LAYOUT_TRANSACTION_SCHEMA.into(),
            document_id: "doc".into(),
            transaction_id: "d".repeat(32),
            base_revision: projection.revision,
            expected_revision: projection.revision,
            actor: BTreeMap::from([
                ("userId".into(), "alice".into()),
                ("displayName".into(), "Alice".into()),
            ]),
            edits: hcd_core::FlowLayoutEdits {
                schema_version: hcd_core::FLOW_LAYOUT_EDITS_SCHEMA.into(),
                base_layout_hash: projection.flow_layout_hash.unwrap(),
                changes: vec![hcd_core::FlowLayoutFieldChange {
                    section_id: Some(layout.sections[0].id.clone()),
                    field: hcd_core::FlowLayoutField::WidthTwips,
                    expected: json!(width),
                    value: json!(width + 20),
                }],
            },
        };
        let body = WordLayoutReceiptRequest {
            coordinator_id: "e".repeat(32),
            transaction,
        };
        write_collaboration_metadata(
            &state,
            "doc",
            &CollaborationMetadata {
                epoch: 0,
                protocol: CollaborationProtocol::WordRegions1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut service = headers(&state, "write", "hcd-collaboration");
        service.insert("x-hcd-coordinator-version", "6".parse().unwrap());
        service.insert("x-hcd-word-layout-version", "1".parse().unwrap());
        service.insert(
            "x-hcd-collaboration-protocol",
            "hcd-word-regions/1".parse().unwrap(),
        );
        assert_eq!(
            layout_transaction(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(body.clone())
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::UPGRADE_REQUIRED
        );
        assert_eq!(
            layout_preflight(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(body.clone())
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::UPGRADE_REQUIRED
        );
        write_collaboration_metadata(
            &state,
            "doc",
            &CollaborationMetadata {
                epoch: 0,
                protocol: CollaborationProtocol::WordRegions2,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let comment = CommentReplyRequest {
            expected_revision: projection.revision,
            text: "old client".into(),
            patch_id: "old-comment".into(),
        };
        assert_eq!(
            reply_comment(
                State(state.clone()),
                Path("doc".into()),
                headers(&state, "write", "alice"),
                Json(comment)
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::UPGRADE_REQUIRED
        );
        service.insert(
            "x-hcd-collaboration-protocol",
            "hcd-word-regions/2".parse().unwrap(),
        );
        assert_eq!(
            layout_transaction(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(body.clone())
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            layout_preflight(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(body.clone())
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::CONFLICT
        );
        let mut owner_headers = service.clone();
        owner_headers.insert("x-hcd-coordinator-version", "5".parse().unwrap());
        let acquire:word_owner::Request=serde_json::from_value(json!({"version":1,"epoch":0,"ownerId":"a".repeat(32),"storeId":"b".repeat(32),"action":"acquire","journalHashes":["none"]})).unwrap();
        let lease = word_owner::owner(
            State(state.clone()),
            Path("doc".into()),
            owner_headers.clone(),
            Json(acquire),
        )
        .await
        .unwrap()
        .0;
        let record:word_owner::Request=serde_json::from_value(json!({"version":1,"epoch":0,"ownerId":"a".repeat(32),"storeId":"b".repeat(32),"action":"record","leaseId":lease["leaseId"],"journalHashes":["none","c".repeat(64)]})).unwrap();
        let lease = word_owner::owner(
            State(state.clone()),
            Path("doc".into()),
            owner_headers.clone(),
            Json(record),
        )
        .await
        .unwrap()
        .0;
        for (header, field) in [
            ("x-hcd-word-owner", "leaseId"),
            ("x-hcd-word-owner-id", "ownerId"),
            ("x-hcd-word-journal-hash", "journalHash"),
        ] {
            service.insert(header, lease[field].as_str().unwrap().parse().unwrap());
        }
        let before_preview = bundle.manifest().unwrap();
        let preview = layout_preflight(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(body.clone()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(preview["revision"], before_preview.revision);
        assert_eq!(preview["rootHash"], before_preview.root_hash);
        assert_eq!(
            preview["layout"]["sections"][0]["page"]["widthTwips"],
            width + 20
        );
        assert_eq!(
            bundle.manifest().unwrap().root_hash,
            before_preview.root_hash
        );
        let mut invalid = body.clone();
        invalid.transaction.edits.changes[0].expected = json!(width + 1);
        assert!(layout_preflight(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(invalid)
        )
        .await
        .is_err());
        assert_eq!(bundle.manifest().unwrap().revision, before_preview.revision);
        let saved = layout_transaction(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(body.clone()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(saved["revision"], 2);
        assert_eq!(saved["idempotentReplay"], false);
        let read = editor(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery { revision: None }),
            service.clone(),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(read["revision"], 2);
        assert_eq!(
            read["flowLayout"]["sections"][0]["page"]["widthTwips"],
            width + 20
        );
        let mut unfenced = service.clone();
        unfenced.remove("x-hcd-word-owner");
        assert_eq!(
            editor(
                State(state.clone()),
                Path("doc".into()),
                Query(RevisionQuery { revision: None }),
                unfenced
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::CONFLICT
        );
        let mut old_epoch = service.clone();
        old_epoch.insert("x-hcd-collaboration-epoch", "1".parse().unwrap());
        assert_eq!(
            editor(
                State(state.clone()),
                Path("doc".into()),
                Query(RevisionQuery { revision: None }),
                old_epoch
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::CONFLICT
        );
        let mut ordinary = service.clone();
        ordinary.insert(
            "authorization",
            headers(&state, "write", "alice")["authorization"].clone(),
        );
        assert_eq!(
            editor(
                State(state.clone()),
                Path("doc".into()),
                Query(RevisionQuery { revision: None }),
                ordinary
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::UPGRADE_REQUIRED
        );
        let replay = layout_transaction(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(body.clone()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(replay["revision"], 2);
        assert_eq!(replay["idempotentReplay"], true);
        let mut forged = body.clone();
        forged.transaction.edits.changes[0].value = json!(width + 40);
        assert!(layout_transaction(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(forged)
        )
        .await
        .is_err());
        let current = editor_projection(&bundle, None).unwrap();
        let mut snapshot = rich_request(&current);
        assert_eq!(
            checkpoint(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(snapshot.clone())
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::UPGRADE_REQUIRED
        );
        snapshot.coordinator_version = 6;
        let cancelled_id = "9".repeat(32);
        word_owner::seal_checkpoint_cancel(&state.root, "doc", 0, &cancelled_id).unwrap();
        let mut cancelled = snapshot.clone();
        cancelled.checkpoint_id = cancelled_id;
        assert_eq!(
            checkpoint(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(cancelled)
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(bundle.manifest().unwrap().revision, current.revision);
        let mut missing_owner = service.clone();
        missing_owner.remove("x-hcd-word-owner");
        assert_eq!(
            checkpoint(
                State(state.clone()),
                Path("doc".into()),
                missing_owner,
                Json(snapshot.clone())
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::CONFLICT
        );
        let mut bad_layout = snapshot.clone();
        bad_layout.layout_hash = "0".repeat(64);
        assert!(checkpoint(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(bad_layout)
        )
        .await
        .is_err());
        let saved_text = checkpoint(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(snapshot.clone()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(saved_text["revision"], 3);
        assert!(bundle
            .revision(3)
            .unwrap()
            .patch_id
            .unwrap()
            .starts_with("hcdsave6:"));
        let mut reused = snapshot.clone();
        reused.expected_revision = 3;
        reused.coordinator_digest = "e".repeat(64);
        let reused_error = checkpoint(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(reused),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(reused_error.0, StatusCode::CONFLICT);
        assert!(reused_error.1.contains("identity already used"));
        assert_eq!(
            checkpoint(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(snapshot)
            )
            .await
            .unwrap()
            .0["idempotentReplay"],
            true
        );
        let after = editor_projection(&bundle, None).unwrap();
        assert_eq!(after.flow_layout_hash, current.flow_layout_hash);
        let mut unchanged = request(&after);
        unchanged.coordinator_version = 6;
        unchanged.checkpoint_id = "6".repeat(32);
        let noop = checkpoint(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(unchanged.clone()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(noop["saveMode"], "word-regions-unchanged");
        let evidence_path = state.root.join("collaboration/word-owners").join(format!(
            "doc.0.{}.checkpoint-unchanged",
            unchanged.checkpoint_id
        ));
        let evidence_bytes = std::fs::read(&evidence_path).unwrap();
        let mut tampered: Value = serde_json::from_slice(&evidence_bytes).unwrap();
        tampered["rootHash"] = json!("0".repeat(64));
        std::fs::write(&evidence_path, serde_json::to_vec(&tampered).unwrap()).unwrap();
        assert!(checkpoint(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(unchanged.clone())
        )
        .await
        .is_err());
        std::fs::write(&evidence_path, evidence_bytes).unwrap();
        assert_eq!(
            checkpoint(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(unchanged.clone())
            )
            .await
            .unwrap()
            .0["saveMode"],
            "word-regions-unchanged"
        );
        let mut reused_noop = unchanged.clone();
        reused_noop.coordinator_digest = "e".repeat(64);
        let conflict = checkpoint(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(reused_noop),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(conflict.0, StatusCode::CONFLICT);
        assert!(conflict.1.contains("identity already used"));
        let mut cancel_headers = service.clone();
        cancel_headers.insert("x-hcd-coordinator-version", "7".parse().unwrap());
        cancel_headers.insert("x-hcd-word-story-version", "1".parse().unwrap());
        let cancel = CheckpointCancelRequest {
            checkpoint_id: unchanged.checkpoint_id.clone(),
            actor: BTreeMap::from([
                ("userId".into(), "alice".into()),
                ("displayName".into(), "Alice 王".into()),
            ]),
        };
        assert_eq!(
            checkpoint_cancel(
                State(state.clone()),
                Path("doc".into()),
                cancel_headers,
                Json(cancel)
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::CONFLICT
        );
        for text in ["Body rich", "Header rich", "Footer rich"] {
            assert!(hcd_core::extract_text_page(&bundle, None, 1000)
                .unwrap()
                .entries
                .iter()
                .any(|entry| entry.text == text));
        }
        let body_region = after
            .blocks
            .iter()
            .find(|block| block.region == "body" && !block.read_only)
            .unwrap()
            .flow_region_id
            .clone()
            .unwrap();
        let mut later = request(&after);
        later.coordinator_version = 6;
        later.checkpoint_id = "7".repeat(32);
        later
            .regions
            .iter_mut()
            .find(|region| region.region_id == body_region)
            .unwrap()
            .blocks[0]
            .content = paragraph("After unchanged checkpoint");
        assert_eq!(
            checkpoint(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(later)
            )
            .await
            .unwrap()
            .0["revision"],
            4
        );
        let recovered_noop = checkpoint(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(unchanged.clone()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(recovered_noop["revision"], 3);
        assert_eq!(recovered_noop["unchangedReceipt"], noop["unchangedReceipt"]);
        let record: word_owner::Request = serde_json::from_value(json!({"version":1,"epoch":0,"ownerId":"a".repeat(32),"storeId":"b".repeat(32),"action":"record","leaseId":lease["leaseId"],"journalHashes":["none","c".repeat(64),"d".repeat(64)]})).unwrap();
        let advanced_lease = word_owner::owner(
            State(state.clone()),
            Path("doc".into()),
            owner_headers.clone(),
            Json(record),
        )
        .await
        .unwrap()
        .0;
        service.insert(
            "x-hcd-word-journal-hash",
            advanced_lease["journalHash"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
        );
        let request_bytes = serde_json::to_vec(&serde_json::to_value(&unchanged).unwrap()).unwrap();
        let original_receipt = checkpoint_receipt(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            request_bytes.clone().into(),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(original_receipt, noop["unchangedReceipt"]);
        assert_eq!(original_receipt["journalHash"], "c".repeat(64));
        // Reading the receipt does not weaken submission's exact journal check.
        assert_eq!(
            checkpoint(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(unchanged.clone()),
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::CONFLICT
        );
        let mut mismatched = unchanged.clone();
        mismatched.coordinator_digest = "f".repeat(64);
        assert_eq!(
            checkpoint_receipt(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                serde_json::to_vec(&serde_json::to_value(mismatched).unwrap())
                    .unwrap()
                    .into(),
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::CONFLICT
        );
        let original_record = std::fs::read(&evidence_path).unwrap();
        let mut forged: Value = serde_json::from_slice(&original_record).unwrap();
        forged["rootHash"] = json!("0".repeat(64));
        std::fs::write(&evidence_path, serde_json::to_vec(&forged).unwrap()).unwrap();
        assert!(checkpoint_receipt(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            request_bytes.into(),
        )
        .await
        .is_err());
        std::fs::write(&evidence_path, original_record).unwrap();
        let mut stale = body;
        stale.transaction.transaction_id = "f".repeat(32);
        assert_eq!(
            layout_transaction(State(state), Path("doc".into()), service, Json(stale))
                .await
                .err()
                .unwrap()
                .0,
            StatusCode::CONFLICT
        );
        assert_eq!(bundle.manifest().unwrap().revision, 4);
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
    }
    #[tokio::test]
    async fn layout_revision_fences_legacy_coordinator_and_editor_but_keeps_history_readable() {
        let (_root, state, bundle) = fixture();
        let projection = editor_projection(&bundle, None).unwrap();
        let request = rich_request(&projection);
        let layout = projection.flow_layout.as_ref().unwrap();
        let width = layout.sections[0].page.width_twips.unwrap();
        let edit = hcd_core::FlowLayoutTransaction {
            schema_version: hcd_core::FLOW_LAYOUT_TRANSACTION_SCHEMA.into(),
            document_id: "doc".into(),
            transaction_id: "d".repeat(32),
            base_revision: projection.revision,
            expected_revision: projection.revision,
            actor: BTreeMap::from([
                ("userId".into(), "alice".into()),
                ("displayName".into(), "Alice 王".into()),
            ]),
            edits: hcd_core::FlowLayoutEdits {
                schema_version: hcd_core::FLOW_LAYOUT_EDITS_SCHEMA.into(),
                base_layout_hash: projection.flow_layout_hash.clone().unwrap(),
                changes: vec![hcd_core::FlowLayoutFieldChange {
                    section_id: Some(layout.sections[0].id.clone()),
                    field: hcd_core::FlowLayoutField::WidthTwips,
                    expected: json!(width),
                    value: json!(width + 20),
                }],
            },
        };
        let result = hcd_core::apply_flow_layout_transaction(&bundle, &edit).unwrap();
        assert_eq!(result.revision, projection.revision + 1);
        let before = bundle.manifest().unwrap();
        assert_eq!(
            send(&state, request).await.err().unwrap().0,
            StatusCode::UPGRADE_REQUIRED
        );
        let reader_headers = headers(&state, "read", "reader");
        assert_eq!(
            editor(
                State(state.clone()),
                Path("doc".into()),
                Query(RevisionQuery { revision: None }),
                reader_headers.clone()
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::UPGRADE_REQUIRED
        );
        assert_eq!(
            editor(
                State(state.clone()),
                Path("doc".into()),
                Query(RevisionQuery {
                    revision: Some(result.revision)
                }),
                reader_headers.clone()
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::UPGRADE_REQUIRED
        );
        assert!(editor(
            State(state.clone()),
            Path("doc".into()),
            Query(RevisionQuery {
                revision: Some(projection.revision)
            }),
            reader_headers
        )
        .await
        .is_ok());
        let patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION_3.into(),
            document_id: "doc".into(),
            patch_id: "legacy".into(),
            base_revision: result.revision,
            actor: BTreeMap::new(),
            operations: vec![],
            metadata: Default::default(),
        };
        assert_eq!(
            apply_editor_edits(&state, "doc", patch)
                .await
                .err()
                .unwrap()
                .0,
            StatusCode::UPGRADE_REQUIRED
        );
        let writer = headers(&state, "write", "alice");
        let image = ImageReplaceRequest {
            expected_revision: result.revision,
            expected_visual_hash: None,
            asset_hash: "a".repeat(64),
        };
        assert_eq!(
            replace_image(
                State(state.clone()),
                Path(("doc".into(), "image".into())),
                writer.clone(),
                Json(image)
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::UPGRADE_REQUIRED
        );
        let comment = CommentReplyRequest {
            expected_revision: result.revision,
            text: "comment".into(),
            patch_id: "legacy-comment".into(),
        };
        assert_eq!(
            reply_comment(
                State(state.clone()),
                Path("doc".into()),
                writer.clone(),
                Json(comment)
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::UPGRADE_REQUIRED
        );
        let change = TrackedChangeRequest {
            expected_revision: result.revision,
            change_id: "change".into(),
            action: "accept".into(),
            patch_id: "legacy-change".into(),
        };
        assert_eq!(
            resolve_change(
                State(state.clone()),
                Path("doc".into()),
                writer,
                Json(change)
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::UPGRADE_REQUIRED
        );
        assert_eq!(bundle.manifest().unwrap().root_hash, before.root_hash);
        assert_eq!(bundle.manifest().unwrap().revision, before.revision);
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
        write_collaboration_metadata(
            &state,
            "doc",
            &CollaborationMetadata {
                epoch: 0,
                protocol: CollaborationProtocol::WordRegions1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut service = headers(&state, "write", "hcd-collaboration");
        service.insert("x-hcd-coordinator-version", "5".parse().unwrap());
        service.insert(
            "x-hcd-collaboration-protocol",
            "hcd-word-regions/1".parse().unwrap(),
        );
        let owner_request: word_owner::Request = serde_json::from_value(json!({"version":1,"epoch":0,"ownerId":"a".repeat(32),"storeId":"b".repeat(32),"action":"acquire","journalHashes":["none"]})).unwrap();
        let acquired = word_owner::owner(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(owner_request),
        )
        .await
        .unwrap()
        .0;
        let journal = "c".repeat(64);
        let record_request: word_owner::Request = serde_json::from_value(json!({"version":1,"epoch":0,"ownerId":"a".repeat(32),"storeId":"b".repeat(32),"action":"record","leaseId":acquired["leaseId"],"journalHashes":["none",journal]})).unwrap();
        let lease = word_owner::owner(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(record_request),
        )
        .await
        .unwrap()
        .0;
        for (header, field) in [
            ("x-hcd-word-owner", "leaseId"),
            ("x-hcd-word-owner-id", "ownerId"),
            ("x-hcd-word-journal-hash", "journalHash"),
        ] {
            service.insert(header, lease[field].as_str().unwrap().parse().unwrap());
        }
        let proof_request = WordLayoutReceiptRequest {
            coordinator_id: "e".repeat(32),
            transaction: edit.clone(),
        };
        let proof = layout_receipt(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(proof_request.clone()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(proof["revision"], result.revision);
        let message = format!(
            "hcd-layout-receipt/1:doc:0:{}:{}:{}:{}:{}:{}:{}",
            "e".repeat(32),
            journal,
            edit.expected_revision,
            result.revision,
            edit.transaction_id,
            bundle
                .revision(result.revision)
                .unwrap()
                .patch_hash
                .unwrap(),
            result.root_hash
        );
        assert_eq!(
            proof["signature"],
            jsonwebtoken::crypto::sign(
                message.as_bytes(),
                &EncodingKey::from_secret(&state.secret),
                Algorithm::HS256
            )
            .unwrap()
        );
        let mut changed = proof_request;
        changed.transaction.edits.changes[0].value = json!(width + 21);
        assert_eq!(
            layout_receipt(
                State(state.clone()),
                Path("doc".into()),
                service.clone(),
                Json(changed)
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::CONFLICT
        );
        service.insert("x-hcd-word-journal-hash", "f".repeat(64).parse().unwrap());
        assert_eq!(
            layout_receipt(
                State(state),
                Path("doc".into()),
                service,
                Json(WordLayoutReceiptRequest {
                    coordinator_id: "e".repeat(32),
                    transaction: edit
                })
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::CONFLICT
        );
    }
    #[tokio::test]
    async fn rich_regions_commit_atomically_and_exact_replay_never_rewinds_a_restored_head() {
        let (_root, state, bundle) = fixture();
        let before = editor_projection(&bundle, None).unwrap();
        let request = rich_request(&before);
        let result = send(&state, request.clone()).await.unwrap();
        assert_eq!(result["revision"], 2);
        assert_eq!(result["saveMode"], "word-regions");
        let record = bundle.revision(2).unwrap();
        assert!(record.patch_id.as_ref().unwrap().starts_with("hcdsave5:"));
        assert!(record.patch_id.as_ref().unwrap().len() <= 256);
        assert_eq!(
            record
                .dirty_source_parts
                .iter()
                .cloned()
                .collect::<HashSet<_>>(),
            HashSet::from([
                "word/document.xml".into(),
                "word/header1.xml".into(),
                "word/footer1.xml".into()
            ])
        );
        for text in ["Body rich", "Header rich", "Footer rich"] {
            assert!(hcd_core::extract_text_page(&bundle, None, 1000)
                .unwrap()
                .entries
                .iter()
                .any(|entry| entry.text == text));
        }
        assert_eq!(
            send(&state, request.clone()).await.unwrap()["idempotentReplay"],
            true
        );
        hcd_core::restore_revision(&bundle, 0, 2, None, None).unwrap();
        let head = bundle.manifest().unwrap();
        assert_eq!(head.capabilities.flow_layout, Some(1));
        assert_eq!(send(&state, request).await.unwrap()["revision"], 2);
        assert_eq!(bundle.manifest().unwrap().root_hash, head.root_hash);
        assert_eq!(bundle.manifest().unwrap().revision, 3);
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
    }
    #[tokio::test]
    async fn scope_source_and_layout_failures_leave_all_regions_unchanged() {
        let (_root, state, bundle) = fixture();
        let projection = editor_projection(&bundle, None).unwrap();
        let request = rich_request(&projection);
        let root = bundle.manifest().unwrap().root_hash;
        let mut cases = Vec::new();
        let mut bad = request.clone();
        bad.regions.pop();
        cases.push(bad);
        let mut bad = request.clone();
        bad.regions.push(bad.regions[0].clone());
        cases.push(bad);
        let mut bad = request.clone();
        bad.regions[0].blocks.clear();
        cases.push(bad);
        let mut bad = request.clone();
        bad.layout_hash = "0".repeat(64);
        cases.push(bad);
        let mut bad = request.clone();
        bad.regions[0].blocks[0].block_id =
            request.regions.last().unwrap().blocks[0].block_id.clone();
        cases.push(bad);
        let foreign = projection
            .blocks
            .iter()
            .find(|block| block.region == "footer")
            .unwrap()
            .content
            .inlines[0]
            .node_id
            .clone()
            .unwrap();
        let mut bad = request.clone();
        bad.regions[0].blocks[0].content.inlines[0].node_id = Some(foreign);
        cases.push(bad);
        let mut bad = request.clone();
        bad.regions[0].blocks[0].content.inlines[0].node_id = Some(format!("n_{}", "f".repeat(32)));
        cases.push(bad);
        for request in cases {
            assert!(send(&state, request).await.is_err());
            assert_eq!(bundle.manifest().unwrap().root_hash, root);
            assert_eq!(bundle.manifest().unwrap().revision, 1);
        }
    }
    #[tokio::test]
    async fn snapshot_service_model_epoch_and_contributors_are_mandatory() {
        let (_root, state, bundle) = fixture();
        let request = rich_request(&editor_projection(&bundle, None).unwrap());
        for (scope, subject, status) in [
            ("read", "alice", StatusCode::FORBIDDEN),
            ("write", "alice", StatusCode::UPGRADE_REQUIRED),
        ] {
            assert!(
                matches!(checkpoint(State(state.clone()),Path("doc".into()),headers(&state,scope,subject),Json(request.clone())).await,Err(ApiError(code,_)) if code==status)
            );
        }
        for kind in 0..5 {
            let mut headers = headers(&state, "write", "hcd-collaboration");
            let mut bad = request.clone();
            match kind {
                0 => {
                    headers.remove("x-hcd-flow-layout-version");
                }
                1 => {
                    headers.insert("x-hcd-collaboration-epoch", "1".parse().unwrap());
                }
                2 => {
                    bad.coordinator_version = 4;
                }
                3 => {
                    bad.contributors.clear();
                }
                _ => {
                    bad.contributors.push(bad.contributors[0].clone());
                }
            }
            assert!(
                checkpoint(State(state.clone()), Path("doc".into()), headers, Json(bad))
                    .await
                    .is_err()
            );
        }
        FileAccessPolicy::new(&state.root)
            .compare_replace(
                "doc",
                0,
                &DocumentAccess {
                    generation: 1,
                    readers: None,
                    writers: Some(vec!["bob".into()]),
                },
            )
            .unwrap();
        assert!(matches!(
            send(&state, request).await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        assert_eq!(bundle.manifest().unwrap().revision, 1);
    }
    #[tokio::test]
    async fn new_surface_can_replace_all_old_roots_without_losing_region_addressing() {
        let (_root, state, bundle) = fixture();
        let projection = editor_projection(&bundle, None).unwrap();
        let mut request = request(&projection);
        let region = request
            .regions
            .iter_mut()
            .find(|region| region.blocks.len() == 1)
            .unwrap();
        let identity = region.region_id.clone();
        region.blocks = vec![
            SnapshotBlock {
                block_id: None,
                content: paragraph("First new root"),
            },
            SnapshotBlock {
                block_id: Some("tmp_new-root".into()),
                content: paragraph("Second new root"),
            },
        ];
        send(&state, request).await.unwrap();
        let after = editor_projection(&bundle, None).unwrap();
        let content: Vec<_> = after
            .blocks
            .iter()
            .filter(|block| block.flow_region_id.as_deref() == Some(&identity))
            .map(|block| block.content.inlines[0].text.clone())
            .collect();
        assert_eq!(content, vec!["First new root", "Second new root"]);
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
    }
    #[test]
    fn signature_binds_every_regional_request_field_and_enforces_native_patch_id_limit() {
        let (_root, state, bundle) = fixture();
        let request = request(&editor_projection(&bundle, None).unwrap());
        let original = checkpoint_id(&state, "doc", 0, &request).unwrap();
        assert!(original.len() <= 256);
        let mut changes = Vec::new();
        let mut changed = request.clone();
        changed.contributors[0].display_name = "Other".into();
        changes.push(changed);
        let mut changed = request.clone();
        changed.layout_hash = "d".repeat(64);
        changes.push(changed);
        let mut changed = request.clone();
        changed.regions.reverse();
        changes.push(changed);
        let mut changed = request.clone();
        changed.regions[0].blocks[0].content = paragraph("Different body");
        changes.push(changed);
        let mut changed = request.clone();
        changed.extension_version = None;
        changes.push(changed);
        for changed in changes {
            assert_ne!(checkpoint_id(&state, "doc", 0, &changed).unwrap(), original);
        }
        assert_ne!(checkpoint_id(&state, "doc", 1, &request).unwrap(), original);
    }
}
