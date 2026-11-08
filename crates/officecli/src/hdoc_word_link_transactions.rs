//! Native publication and signed evidence for a trusted, fenced Word owner.
//! The sidecar must durably prepare and drain members before publication;
//! these endpoints do not implement that lifecycle or expose a member action.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Prepared {
    coordinator_id: String,
    transaction: hcd_core::FlowStoryLinkTransaction,
    candidate_layout_hash: String,
    review_hash: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReceiptRequest {
    api_hash: String,
    pending_hash: String,
    initial_update_hash: String,
    prepared: Prepared,
}
fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn conflict(message: &str) -> ApiError {
    ApiError(StatusCode::CONFLICT, message.into())
}
fn authorize(
    state: &ServerState,
    id: &str,
    headers: &HeaderMap,
    input: &Prepared,
) -> Result<(), ApiError> {
    let claims = authorize_claims(state, headers, id)?;
    require_write(state, id, &claims)?;
    if !collaboration_service(&claims)
        || [
            ("x-hcd-coordinator-version", "7"),
            ("x-hcd-word-layout-version", "1"),
            ("x-hcd-word-story-version", "1"),
            ("x-hcd-word-link-version", "1"),
        ]
        .iter()
        .any(|(key, value)| headers.get(*key).and_then(|v| v.to_str().ok()) != Some(*value))
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "link-aware Word coordinator required".into(),
        ));
    }
    if state.remote.is_some() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "remote Word ownership adapter is not configured".into(),
        ));
    }
    let transaction = &input.transaction;
    if !hex(&input.coordinator_id, 32)
        || !hex(&input.candidate_layout_hash, 64)
        || !hex(&input.review_hash, 64)
        || transaction.schema_version != hcd_core::FLOW_STORY_LINK_TRANSACTION_SCHEMA
        || transaction.document_id != id
        || !hex(&transaction.transaction_id, 32)
        || !hex(&transaction.link.base_layout_hash, 64)
        || transaction.actor.len() != 2
        || !transaction
            .actor
            .get("userId")
            .is_some_and(|v| access_policy::valid_subject(v))
        || !transaction
            .actor
            .get("displayName")
            .is_some_and(|v| valid_display_name(v))
        || serde_json::to_vec(input).map_err(internal)?.len()
            > hcd_core::MAX_FLOW_LAYOUT_EDITS_BYTES
    {
        return Err(bad("invalid prepared Word link"));
    }
    Ok(())
}
async fn context(
    state: &ServerState,
    id: &str,
    headers: &HeaderMap,
    input: &Prepared,
) -> Result<(u64, String), ApiError> {
    let epoch = check_collaboration_epoch(state, id, headers).await?;
    if collaboration_metadata(state, id).await?.protocol != CollaborationProtocol::WordRegions2 {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "layout-aware Word room required".into(),
        ));
    }
    state.word_owners.guard(id, epoch, headers)?;
    let access = load_access(state, id)?;
    if access.restricted()
        && !access.can_write(input.transaction.actor.get("userId").map(String::as_str))
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "link author no longer has write access".into(),
        ));
    }
    let journal = headers
        .get("x-hcd-word-journal-hash")
        .and_then(|v| v.to_str().ok())
        .filter(|v| hex(v, 64))
        .ok_or_else(|| bad("missing Word journal hash"))?;
    Ok((epoch, journal.into()))
}
/// Rebuild the original review at its immutable base, including on a retry
/// after later ordinary saves or restore. A replay must not use today's head.
fn verify_review(bundle: &Bundle, id: &str, epoch: u64, input: &Prepared) -> Result<(), ApiError> {
    let head = bundle.manifest().map_err(hcd_error)?;
    if head.schema_version != hcd_core::HCD_SCHEMA_VERSION
        || head.profile != "semantic-flow"
        || head.source.format != "docx"
        || !matches!(head.capabilities.word_layout_edits, None | Some(1 | 3))
    {
        return Err(bad("supported coordinated Word layout required"));
    }
    let (base, _) =
        hcd_core::manifest_at_revision(bundle, &head, Some(input.transaction.expected_revision))
            .map_err(hcd_error)?;
    let layout = hcd_core::read_flow_document_layout(bundle, &base)
        .map_err(hcd_error)?
        .ok_or_else(|| bad("missing Word layout"))?;
    let plan =
        hcd_core::plan_flow_story_link(&layout, &input.transaction.link).map_err(hcd_error)?;
    let candidate = hcd_core::flow_layout_hash(&plan.layout).map_err(hcd_error)?;
    let review = hash_bytes(
        &serde_json::to_vec(&(
            "hcd-word-link-preflight/1",
            id,
            epoch,
            &input.coordinator_id,
            &base.root_hash,
            &input.transaction,
            &candidate,
        ))
        .map_err(internal)?,
    );
    if candidate != input.candidate_layout_hash || review != input.review_hash {
        return Err(conflict("Word link review changed"));
    }
    Ok(())
}

pub(super) async fn transaction(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<Prepared>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &id, &headers, &input)?;
    let _lock = state.collaboration_lock.lock().await;
    let (epoch, _) = context(&state, &id, &headers, &input).await?;
    if word_owner::topology_cancelled(&state.root, &id, epoch, &input.transaction.transaction_id)? {
        return Err(conflict("Word transaction cancelled"));
    }
    let bundle = open(&state, &id)?;
    verify_review(&bundle, &id, epoch, &input)?;
    state.word_owners.guard(&id, epoch, &headers)?;
    let result =
        hcd_core::apply_coordinated_flow_story_link_transaction(&bundle, &input.transaction)
            .map_err(hcd_error)?;
    if !result.idempotent_replay {
        publish_mutation(&state, &id, &bundle, input.transaction.expected_revision).await?;
    }
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}

pub(super) async fn receipt(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ReceiptRequest>,
) -> Result<Json<Value>, ApiError> {
    let prepared = &input.prepared;
    authorize(&state, &id, &headers, prepared)?;
    if [
        &input.api_hash,
        &input.pending_hash,
        &input.initial_update_hash,
    ]
    .iter()
    .any(|v| !hex(v, 64))
    {
        return Err(bad("invalid Word link receipt identity"));
    }
    let _lock = state.collaboration_lock.lock().await;
    let (epoch, journal_hash) = context(&state, &id, &headers, prepared).await?;
    let bundle = open(&state, &id)?;
    verify_review(&bundle, &id, epoch, prepared)?;
    let transaction = &prepared.transaction;
    let head = bundle.manifest().map_err(hcd_error)?;
    let revision = transaction
        .expected_revision
        .checked_add(1)
        .filter(|r| *r <= head.revision)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "link receipt not found".into()))?;
    let record = bundle.revision(revision).map_err(hcd_error)?;
    let request_hash =
        hcd_core::coordinated_flow_story_link_hash(transaction).map_err(hcd_error)?;
    if record.document_id != id
        || record.patch_base_revision != Some(transaction.expected_revision)
        || record.patch_id.as_deref()
            != Some(format!("word-story-link-{}", transaction.transaction_id).as_str())
        || record.patch_hash.as_deref() != Some(&request_hash)
        || record.author_id.as_ref() != transaction.actor.get("userId")
        || record.author_name.as_ref() != transaction.actor.get("displayName")
        || !hex(&record.root_hash, 64)
    {
        return Err(conflict("link receipt does not match prepared request"));
    }
    hcd_core::validate_flow_story_link_revision(&bundle, revision).map_err(hcd_error)?;
    let projection = editor_projection(&bundle, Some(revision)).map_err(hcd_error)?;
    if projection.flow_layout_hash.as_deref() != Some(prepared.candidate_layout_hash.as_str()) {
        return Err(conflict("link receipt candidate changed"));
    }
    let message = serde_json::to_vec(&json!([
        "hcd-word-link-receipt/1",
        input.api_hash,
        id,
        epoch,
        prepared.coordinator_id,
        journal_hash,
        transaction.expected_revision,
        revision,
        transaction.transaction_id,
        request_hash,
        input.pending_hash,
        record.root_hash,
        transaction.link.base_layout_hash,
        prepared.candidate_layout_hash,
        prepared.review_hash,
        input.initial_update_hash,
    ]))
    .map_err(internal)?;
    let signature = jsonwebtoken::crypto::sign(
        &message,
        &EncodingKey::from_secret(&state.secret),
        Algorithm::HS256,
    )
    .map_err(internal)?;
    state.word_owners.guard(&id, epoch, &headers)?;
    Ok(Json(
        json!({"schemaVersion":"hcd-word-link-receipt/1","documentId":id,"epoch":epoch,"coordinatorId":prepared.coordinator_id,"journalHash":journal_hash,"expectedRevision":transaction.expected_revision,"revision":revision,"transactionId":transaction.transaction_id,"requestHash":request_hash,"pendingHash":input.pending_hash,"rootHash":record.root_hash,"layoutHash":prepared.candidate_layout_hash,"reviewHash":prepared.review_hash,"initialUpdateHash":input.initial_update_hash,"signature":signature,"projection":projection}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hcd_core::FlowStoryLinkTransaction;

    async fn review(
        state: &ServerState,
        headers: &HeaderMap,
        mut transaction: FlowStoryLinkTransaction,
    ) -> Prepared {
        let bundle = open(state, "doc").unwrap();
        let base = editor_projection(&bundle, None).unwrap();
        transaction.expected_revision = base.revision;
        transaction.link.base_layout_hash = base.flow_layout_hash.unwrap();
        let input = serde_json::from_value(
            json!({"coordinatorId":"e".repeat(32),"transaction":transaction}),
        )
        .unwrap();
        let result = word_link_preflight::preview(
            State(state.clone()),
            Path("doc".into()),
            headers.clone(),
            Json(input),
        )
        .await
        .unwrap()
        .0;
        Prepared {
            coordinator_id: "e".repeat(32),
            transaction,
            candidate_layout_hash: result["candidateLayoutHash"].as_str().unwrap().into(),
            review_hash: result["reviewHash"].as_str().unwrap().into(),
        }
    }
    async fn fixture(image: bool) -> (tempfile::TempDir, ServerState, HeaderMap, Prepared) {
        let (root, state, headers, input) = word_link_preflight::tests::fixture(image).await;
        let value = serde_json::to_value(input).unwrap();
        let prepared = review(
            &state,
            &headers,
            serde_json::from_value(value["transaction"].clone()).unwrap(),
        )
        .await;
        (root, state, headers, prepared)
    }
    async fn commit(
        state: &ServerState,
        headers: &HeaderMap,
        input: &Prepared,
    ) -> Result<Value, ApiError> {
        transaction(
            State(state.clone()),
            Path("doc".into()),
            headers.clone(),
            Json(input.clone()),
        )
        .await
        .map(|v| v.0)
    }
    fn receipt_input(prepared: &Prepared) -> ReceiptRequest {
        ReceiptRequest {
            api_hash: "1".repeat(64),
            pending_hash: "2".repeat(64),
            initial_update_hash: "3".repeat(64),
            prepared: prepared.clone(),
        }
    }
    async fn proof(
        state: &ServerState,
        headers: &HeaderMap,
        input: &ReceiptRequest,
    ) -> Result<Value, ApiError> {
        receipt(
            State(state.clone()),
            Path("doc".into()),
            headers.clone(),
            Json(input.clone()),
        )
        .await
        .map(|v| v.0)
    }
    fn body_edit(bundle: &Bundle, label: &str) -> u64 {
        let projection = editor_projection(bundle, None).unwrap();
        let block = projection
            .blocks
            .iter()
            .find(|b| b.region == "body" && !b.content.inlines.is_empty())
            .unwrap();
        let mut content = block.content.clone();
        content.inlines[0].text.push_str(label);
        hcd_core::apply_flow_structure_patch(
            bundle,
            &hcd_core::FlowStructurePatchBatch {
                schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_6.into(),
                document_id: projection.document_id,
                patch_id: label.into(),
                base_revision: projection.revision,
                layout_hash: projection.flow_layout_hash.unwrap(),
                actor: Default::default(),
                regions: vec![hcd_core::FlowRegionEdits {
                    region_id: block.flow_region_id.clone().unwrap(),
                    operations: vec![hcd_core::StructureOperation::Replace {
                        block_id: block.block_id.clone(),
                        block: content,
                        precondition: hcd_core::BlockPrecondition {
                            block_hash: block.block_hash.clone(),
                        },
                    }],
                }],
            },
            projection.revision,
        )
        .unwrap()
        .revision
    }
    fn page_request(bundle: &Bundle, nonce: &str) -> hcd_core::FlowLayoutTransaction {
        let projection = editor_projection(bundle, None).unwrap();
        let layout = projection.flow_layout.as_ref().unwrap();
        let section = &layout.sections[0];
        let width = section.page.width_twips.unwrap();
        hcd_core::FlowLayoutTransaction {
            schema_version: hcd_core::FLOW_LAYOUT_TRANSACTION_SCHEMA.into(),
            document_id: projection.document_id,
            transaction_id: nonce.into(),
            base_revision: projection.revision,
            expected_revision: projection.revision,
            actor: Default::default(),
            edits: hcd_core::FlowLayoutEdits {
                schema_version: hcd_core::FLOW_LAYOUT_EDITS_SCHEMA.into(),
                base_layout_hash: projection.flow_layout_hash.unwrap(),
                changes: vec![hcd_core::FlowLayoutFieldChange {
                    section_id: Some(section.id.clone()),
                    field: hcd_core::FlowLayoutField::WidthTwips,
                    expected: json!(width),
                    value: json!(width + 100),
                }],
            },
        }
    }

    fn page_edit(bundle: &Bundle, nonce: &str) -> u64 {
        hcd_core::apply_flow_layout_transaction(bundle, &page_request(bundle, nonce))
            .unwrap()
            .revision
    }
    async fn cancel(
        state: &ServerState,
        headers: &HeaderMap,
        prepared: &Prepared,
    ) -> Result<Value, ApiError> {
        let input=serde_json::from_value(json!({"transactionId":prepared.transaction.transaction_id,"actor":prepared.transaction.actor})).unwrap();
        word_checkpoints::topology_cancel(
            State(state.clone()),
            Path("doc".into()),
            headers.clone(),
            Json(input),
        )
        .await
        .map(|v| v.0)
    }

    #[tokio::test]
    async fn coordinated_link_promotes_model_and_exact_retry_never_rewrites_content() {
        for image in [false, true] {
            let (_root, state, headers, prepared) = fixture(image).await;
            let bundle = open(&state, "doc").unwrap();
            let before = editor_projection(&bundle, None).unwrap();
            let first = commit(&state, &headers, &prepared).await.unwrap();
            assert_eq!(first["revision"], 2);
            assert_eq!(
                bundle.manifest().unwrap().capabilities.word_layout_edits,
                Some(3)
            );
            let after = editor_projection(&bundle, None).unwrap();
            assert_eq!(
                serde_json::to_value(&before.blocks).unwrap(),
                serde_json::to_value(&after.blocks).unwrap()
            );
            assert_eq!(
                before.flow_layout.unwrap().stories,
                after.flow_layout.unwrap().stories
            );
            hcd_core::validate_flow_story_link_revision(&bundle, 2).unwrap();
            let replay = commit(&state, &headers, &prepared).await.unwrap();
            assert_eq!(replay["idempotentReplay"], true);
            assert_eq!(replay["revision"], 2);
            assert_eq!(bundle.manifest().unwrap().revision, 2);
            let report = hcd_core::validate_bundle(&bundle).unwrap();
            assert!(report.valid, "{:?}", report.issues);
        }
    }

    #[tokio::test]
    async fn mixed_body_page_link_history_restore_and_historical_receipt_preserve_each_other() {
        let (_root, state, headers, prepared) = fixture(true).await;
        let bundle = open(&state, "doc").unwrap();
        body_edit(&bundle, "before-link");
        page_edit(&bundle, &"4".repeat(32));
        let prepared = review(&state, &headers, prepared.transaction).await;
        let base = prepared.transaction.expected_revision;
        commit(&state, &headers, &prepared).await.unwrap();
        let original = proof(&state, &headers, &receipt_input(&prepared))
            .await
            .unwrap();
        body_edit(&bundle, "after-link");
        let head = page_edit(&bundle, &"5".repeat(32));
        let replay = commit(&state, &headers, &prepared).await.unwrap();
        assert_eq!(replay["revision"], base + 1);
        assert_eq!(bundle.manifest().unwrap().revision, head);
        assert_eq!(
            proof(&state, &headers, &receipt_input(&prepared))
                .await
                .unwrap(),
            original
        );
        hcd_core::restore_revision(&bundle, base, head, None, None).unwrap();
        assert_eq!(
            proof(&state, &headers, &receipt_input(&prepared))
                .await
                .unwrap(),
            original
        );
        assert_eq!(
            commit(&state, &headers, &prepared).await.unwrap()["revision"],
            base + 1
        );
        assert_eq!(bundle.manifest().unwrap().revision, head + 1);
        let report = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{:?}", report.issues);
    }

    #[tokio::test]
    async fn signed_receipt_binds_fixed_request_owner_journal_and_pending_metadata() {
        let (_root, state, headers, prepared) = fixture(false).await;
        assert_eq!(
            proof(&state, &headers, &receipt_input(&prepared))
                .await
                .unwrap_err()
                .0,
            StatusCode::NOT_FOUND
        );
        commit(&state, &headers, &prepared).await.unwrap();
        let input = receipt_input(&prepared);
        let signed = proof(&state, &headers, &input).await.unwrap();
        let message = serde_json::to_vec(&json!([
            "hcd-word-link-receipt/1",
            input.api_hash,
            "doc",
            0,
            prepared.coordinator_id,
            signed["journalHash"],
            prepared.transaction.expected_revision,
            signed["revision"],
            prepared.transaction.transaction_id,
            signed["requestHash"],
            input.pending_hash,
            signed["rootHash"],
            prepared.transaction.link.base_layout_hash,
            prepared.candidate_layout_hash,
            prepared.review_hash,
            input.initial_update_hash
        ]))
        .unwrap();
        let expected = jsonwebtoken::crypto::sign(
            &message,
            &EncodingKey::from_secret(&state.secret),
            Algorithm::HS256,
        )
        .unwrap();
        assert_eq!(signed["signature"], expected);
        let mut changed = input.clone();
        changed.pending_hash = "6".repeat(64);
        let other = proof(&state, &headers, &changed).await.unwrap();
        assert_ne!(signed["signature"], other["signature"]);
        assert_eq!(signed["rootHash"], other["rootHash"]);
        let mut stale = headers.clone();
        stale.insert("x-hcd-word-journal-hash", "0".repeat(64).parse().unwrap());
        assert_eq!(
            proof(&state, &stale, &input).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
        let mut wrong = input;
        wrong
            .prepared
            .transaction
            .actor
            .insert("displayName".into(), "Changed".into());
        assert!(proof(&state, &headers, &wrong).await.is_err());
    }

    #[tokio::test]
    async fn cancellation_review_changes_and_stale_head_do_not_publish() {
        let (_root, state, headers, prepared) = fixture(false).await;
        let bundle = open(&state, "doc").unwrap();
        let mut wrong = prepared.clone();
        wrong.review_hash = "0".repeat(64);
        assert!(commit(&state, &headers, &wrong).await.is_err());
        wrong = prepared.clone();
        wrong.candidate_layout_hash = "0".repeat(64);
        assert!(commit(&state, &headers, &wrong).await.is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        assert_eq!(
            cancel(&state, &headers, &prepared).await.unwrap()["status"],
            "not-prepared"
        );
        assert_eq!(
            commit(&state, &headers, &prepared).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        let (_root, other, headers, prepared) = fixture(false).await;
        let bundle = open(&other, "doc").unwrap();
        body_edit(&bundle, "concurrent");
        assert_eq!(
            commit(&other, &headers, &prepared).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
        assert_eq!(bundle.manifest().unwrap().revision, 2);
    }

    #[tokio::test]
    async fn legacy_receipts_and_reused_topology_identifiers_are_not_coordinated_publications() {
        let (_root, state, headers, prepared) = fixture(false).await;
        let bundle = open(&state, "doc").unwrap();
        hcd_core::apply_flow_story_link_transaction(&bundle, &prepared.transaction).unwrap();
        assert_eq!(
            bundle.manifest().unwrap().capabilities.word_layout_edits,
            Some(2)
        );
        assert!(commit(&state, &headers, &prepared).await.is_err());
        assert!(proof(&state, &headers, &receipt_input(&prepared))
            .await
            .is_err());
        let (_root, state, headers, prepared) = fixture(false).await;
        let bundle = open(&state, "doc").unwrap();
        page_edit(&bundle, &prepared.transaction.transaction_id);
        let prepared = review(&state, &headers, prepared.transaction).await;
        assert!(commit(&state, &headers, &prepared).await.is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 2);
    }

    #[tokio::test]
    async fn committed_link_identity_cannot_be_cancelled_or_reused_by_page_or_story_creation() {
        let (root, state, headers, prepared) = fixture(false).await;
        let bundle = open(&state, "doc").unwrap();
        commit(&state, &headers, &prepared).await.unwrap();
        assert_eq!(
            cancel(&state, &headers, &prepared).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
        assert!(!word_owner::topology_cancelled(
            root.path(),
            "doc",
            0,
            &prepared.transaction.transaction_id
        )
        .unwrap());
        assert!(hcd_core::apply_flow_layout_transaction(
            &bundle,
            &page_request(&bundle, &prepared.transaction.transaction_id)
        )
        .is_err());
        let layout = editor_projection(&bundle, None)
            .unwrap()
            .flow_layout
            .unwrap();
        let intent = hcd_core::FlowStoryUnlinkRequest {
            base_layout_hash: hcd_core::flow_layout_hash(&layout).unwrap(),
            section_id: layout.sections[1].id.clone(),
            kind: hcd_core::FlowStoryKind::Footer,
            variant: hcd_core::FlowStoryVariant::Default,
            expected_inherited_story_id: layout.sections[0].footers.default.clone(),
        };
        let story = hcd_core::FlowStory {
            id: format!("n_{}", "f".repeat(32)),
            kind: hcd_core::FlowStoryKind::Footer,
            source_part: "word/new-footer.xml".into(),
        };
        let candidate = hcd_docx::prepare_source_story_unlink(
            &bundle,
            &root.path().join("source.docx"),
            2,
            &intent,
            &story,
            |_| unreachable!(),
            |_| unreachable!(),
        )
        .unwrap();
        assert!(hcd_core::apply_prepared_story_unlink(
            &bundle,
            &candidate.prepared,
            &prepared.transaction.transaction_id,
            &prepared.transaction.actor
        )
        .is_err());
        body_edit(&bundle, "later");
        hcd_core::restore_revision(&bundle, 1, 3, None, None).unwrap();
        assert_eq!(
            cancel(&state, &headers, &prepared).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
        assert_eq!(bundle.manifest().unwrap().revision, 4);
        assert_eq!(
            commit(&state, &headers, &prepared).await.unwrap()["revision"],
            2
        );
    }

    #[tokio::test]
    async fn real_http_transaction_and_receipt_keep_model_and_owner_gates() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (_root, state, headers, prepared) = fixture(false).await;
        let app = Router::new()
            .route(
                "/v1/documents/{id}/word/link-transactions",
                post(transaction),
            )
            .route("/v1/documents/{id}/word/link-receipt", post(receipt))
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
        for (route, mode, body, expected) in [
            (
                "word/link-transactions",
                0,
                serde_json::to_value(&prepared).unwrap(),
                426,
            ),
            (
                "word/link-transactions",
                1,
                serde_json::to_value(&prepared).unwrap(),
                200,
            ),
            (
                "word/link-transactions",
                1,
                serde_json::to_value(&prepared).unwrap(),
                200,
            ),
            (
                "word/link-receipt",
                1,
                serde_json::to_value(receipt_input(&prepared)).unwrap(),
                200,
            ),
            (
                "word/link-receipt",
                2,
                serde_json::to_value(receipt_input(&prepared)).unwrap(),
                409,
            ),
            ("patch", 1, json!({}), 426),
        ] {
            let body = serde_json::to_vec(&body).unwrap();
            let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
            let mut request=format!("POST /v1/documents/doc/{route} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",body.len());
            for (name, value) in &headers {
                if mode == 0 && name == "x-hcd-word-link-version"
                    || mode == 2 && name == "x-hcd-word-owner"
                {
                    continue;
                }
                request.push_str(&format!("{}: {}\r\n", name, value.to_str().unwrap()));
            }
            request.push_str("\r\n");
            stream.write_all(request.as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).await.unwrap();
            let response = String::from_utf8(bytes).unwrap();
            assert_eq!(
                response
                    .split_whitespace()
                    .nth(1)
                    .unwrap()
                    .parse::<u16>()
                    .unwrap(),
                expected,
                "{response}"
            );
        }
        assert_eq!(open(&state, "doc").unwrap().manifest().unwrap().revision, 2);
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn current_author_revocation_blocks_commit_retry_and_receipt_without_discarding_history()
    {
        let (root, state, headers, prepared) = fixture(false).await;
        let bundle = open(&state, "doc").unwrap();
        std::fs::create_dir(root.path().join("access")).unwrap();
        let policy = root.path().join("access/doc.json");
        let revoke = || {
            std::fs::write(&policy,serde_json::to_vec(&json!({"generation":1,"readers":["hcd-collaboration","bob"],"writers":["hcd-collaboration","bob"]})).unwrap()).unwrap()
        };
        revoke();
        assert_eq!(
            commit(&state, &headers, &prepared).await.unwrap_err().0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        std::fs::remove_file(&policy).unwrap();
        commit(&state, &headers, &prepared).await.unwrap();
        let original = proof(&state, &headers, &receipt_input(&prepared))
            .await
            .unwrap();
        revoke();
        assert_eq!(
            commit(&state, &headers, &prepared).await.unwrap_err().0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            proof(&state, &headers, &receipt_input(&prepared))
                .await
                .unwrap_err()
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(bundle.manifest().unwrap().revision, 2);
        std::fs::remove_file(&policy).unwrap();
        assert_eq!(
            proof(&state, &headers, &receipt_input(&prepared))
                .await
                .unwrap(),
            original
        );
    }
}
