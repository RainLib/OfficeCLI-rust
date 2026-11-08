//! Read-only coordinator preflight for restoring inheritance. A review does
//! not prepare or publish a transaction, alter a room, or discard any story.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    coordinator_id: String,
    transaction: hcd_core::FlowStoryLinkTransaction,
}

fn hex(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn bad(message: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}

pub(super) async fn preview(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<Request>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    require_write(&state, &id, &claims)?;
    if claims.sub.as_deref() != Some("hcd-collaboration")
        || [
            ("x-hcd-coordinator-version", "7"),
            ("x-hcd-word-layout-version", "1"),
            ("x-hcd-word-story-version", "1"),
            ("x-hcd-word-link-version", "1"),
        ]
        .iter()
        .any(|(key, value)| headers.get(*key).and_then(|item| item.to_str().ok()) != Some(*value))
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
        || transaction.schema_version != hcd_core::FLOW_STORY_LINK_TRANSACTION_SCHEMA
        || transaction.document_id != id
        || !hex(&transaction.transaction_id, 32)
        || !hex(&transaction.link.base_layout_hash, 64)
        || serde_json::to_vec(transaction).map_err(internal)?.len()
            > hcd_core::MAX_FLOW_LAYOUT_EDITS_BYTES
        || transaction.actor.len() != 2
    {
        return Err(bad("invalid Word link preflight"));
    }
    let actor = transaction
        .actor
        .get("userId")
        .ok_or_else(|| bad("missing link author"))?;
    let name = transaction
        .actor
        .get("displayName")
        .ok_or_else(|| bad("missing link author name"))?;
    if !access_policy::valid_subject(actor) || !valid_display_name(name) {
        return Err(bad("invalid Word link author"));
    }
    let _collaboration = state.collaboration_lock.lock().await;
    let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
    if collaboration_metadata(&state, &id).await?.protocol != CollaborationProtocol::WordRegions2 {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "layout-aware Word room required".into(),
        ));
    }
    let _owner = state.word_owners.guard(&id, epoch, &headers)?;
    let access = load_access(&state, &id)?;
    if access.restricted() && !access.can_write(Some(actor)) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "link author no longer has write access".into(),
        ));
    }
    let bundle = open(&state, &id)?;
    let manifest = bundle.manifest().map_err(hcd_error)?;
    if manifest.profile != "semantic-flow"
        || manifest.source.format != "docx"
        || manifest.schema_version != hcd_core::HCD_SCHEMA_VERSION
        || !matches!(manifest.capabilities.word_layout_edits, None | Some(1 | 3))
    {
        return Err(bad("supported layout-aware Word document required"));
    }
    if manifest.revision != transaction.expected_revision
        || manifest.revision >= hcd_core::MAX_REVISION
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Word link preflight head changed".into(),
        ));
    }
    let preview =
        hcd_core::preview_flow_story_link_transaction(&bundle, transaction).map_err(hcd_error)?;
    let plan = &preview.plan;
    let candidate_layout_hash = &preview.candidate_layout_hash;
    let current = bundle.manifest().map_err(hcd_error)?;
    if current.revision != preview.revision || current.root_hash != preview.root_hash {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Word link preflight changed".into(),
        ));
    }
    let review_hash = hash_bytes(
        &serde_json::to_vec(&(
            "hcd-word-link-preflight/1",
            &id,
            epoch,
            &input.coordinator_id,
            &preview.root_hash,
            transaction,
            &candidate_layout_hash,
        ))
        .map_err(internal)?,
    );
    state.word_owners.guard(&id, epoch, &headers)?;
    Ok(Json(json!({
        "schemaVersion":"hcd-word-link-preflight/1", "documentId":id,
        "transactionId":transaction.transaction_id,"revision":preview.revision,
        "rootHash":preview.root_hash,"baseLayoutHash":transaction.link.base_layout_hash,
        "candidateLayoutHash":candidate_layout_hash,"reviewHash":review_hash,
        "retainedStoryId":plan.displaced_story_id,"inheritedStoryId":plan.inherited_story_id,
        "affected":plan.affected,
    })))
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::fs;

    fn headers(state: &ServerState, subject: &str) -> HeaderMap {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize;
        let claims = Claims {
            doc: "doc".into(),
            scope: "write".into(),
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
        let mut result = HeaderMap::new();
        for (key, value) in [
            ("authorization", format!("Bearer {token}")),
            ("x-hcd-collaboration-epoch", "0".into()),
            ("x-hcd-collaboration-protocol", "hcd-word-regions/2".into()),
            ("x-hcd-flow-layout-version", "2".into()),
            ("x-hcd-custom-marks-version", "1".into()),
            ("x-hcd-node-edits-version", "7".into()),
            ("x-hcd-coordinator-version", "5".into()),
        ] {
            result.insert(key, value.parse().unwrap());
        }
        result
    }

    pub(crate) async fn fixture(
        inherited_image: bool,
    ) -> (tempfile::TempDir, ServerState, HeaderMap, Request) {
        let root = tempfile::tempdir().unwrap();
        let original = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-regions-2026-10-26/image-source.docx");
        let source = root.path().join("source.docx");
        fs::copy(original, &source).unwrap();
        if inherited_image {
            let mut package = oxml::OxmlPackage::open(source.to_str().unwrap(), true).unwrap();
            let xml = package.read_part_xml("word/document.xml").unwrap();
            // Move the image binding to the preceding section and use the
            // plain story as the second section's independent even header.
            let xml = xml.replacen("<w:headerReference w:type=\"even\" r:id=\"he\"/>", "<w:headerReference w:type=\"even\" r:id=\"hd\"/>", 1)
                .replacen("<w:headerReference w:type=\"default\" r:id=\"hd\"/>", "<w:headerReference w:type=\"default\" r:id=\"hd\"/><w:headerReference w:type=\"even\" r:id=\"he\"/>", 1);
            package.write_part_xml("word/document.xml", &xml).unwrap();
            package.save().unwrap();
        }
        let mut options = hcd_docx::ImportOptions::new("doc");
        options.flow_layout = true;
        let path = root.path().join("doc.hcd");
        hcd_docx::import_docx(&source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(path).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        let manifest = bundle.manifest().unwrap();
        let layout = hcd_core::read_flow_document_layout(&bundle, &manifest)
            .unwrap()
            .unwrap();
        let request = Request {
            coordinator_id: "e".repeat(32),
            transaction: hcd_core::FlowStoryLinkTransaction {
                schema_version: hcd_core::FLOW_STORY_LINK_TRANSACTION_SCHEMA.into(),
                document_id: "doc".into(),
                transaction_id: "d".repeat(32),
                expected_revision: manifest.revision,
                actor: [
                    ("userId".into(), "alice".into()),
                    ("displayName".into(), "Alice 王".into()),
                ]
                .into(),
                link: hcd_core::FlowStoryLinkRequest {
                    base_layout_hash: hcd_core::flow_layout_hash(&layout).unwrap(),
                    section_id: layout.sections[1].id.clone(),
                    kind: hcd_core::FlowStoryKind::Header,
                    variant: hcd_core::FlowStoryVariant::Even,
                    expected_direct_story_id: layout.sections[1].headers.even.clone().unwrap(),
                },
            },
        };
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
        let mut service = headers(&state, "hcd-collaboration");
        let acquire = serde_json::from_value(json!({"version":1,"epoch":0,"ownerId":"a".repeat(32),"storeId":"b".repeat(32),"action":"acquire","journalHashes":["none"]})).unwrap();
        let lease = word_owner::owner(
            State(state.clone()),
            Path("doc".into()),
            service.clone(),
            Json(acquire),
        )
        .await
        .unwrap()
        .0;
        let record = serde_json::from_value(json!({"version":1,"epoch":0,"ownerId":"a".repeat(32),"storeId":"b".repeat(32),"action":"record","leaseId":lease["leaseId"],"journalHashes":["none","c".repeat(64)]})).unwrap();
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
        for (key, value) in [
            ("x-hcd-coordinator-version", "7"),
            ("x-hcd-word-layout-version", "1"),
            ("x-hcd-word-story-version", "1"),
            ("x-hcd-word-link-version", "1"),
        ] {
            service.insert(key, value.parse().unwrap());
        }
        (root, state, service, request)
    }

    async fn call(
        state: &ServerState,
        headers: HeaderMap,
        request: Request,
    ) -> Result<Value, ApiError> {
        preview(
            State(state.clone()),
            Path("doc".into()),
            headers,
            Json(request),
        )
        .await
        .map(|json| json.0)
    }

    #[tokio::test]
    async fn review_pins_scope_and_retains_image_story_without_creating_a_revision() {
        for inherited_image in [false, true] {
            let (_root, state, headers, request) = fixture(inherited_image).await;
            let bundle = open(&state, "doc").unwrap();
            let before = serde_json::to_value(editor_projection(&bundle, None).unwrap()).unwrap();
            let manifest = bundle.manifest().unwrap();
            let first = call(&state, headers.clone(), request.clone())
                .await
                .unwrap();
            let second = call(&state, headers, request.clone()).await.unwrap();
            assert_eq!(first, second);
            assert_eq!(first["revision"], manifest.revision);
            assert_eq!(first["rootHash"], manifest.root_hash);
            assert_eq!(
                first["retainedStoryId"],
                request.transaction.link.expected_direct_story_id
            );
            assert_ne!(first["candidateLayoutHash"], first["baseLayoutHash"]);
            assert_eq!(first["affected"].as_array().unwrap().len(), 1);
            if inherited_image {
                assert!(first["inheritedStoryId"].as_str().is_some());
            } else {
                assert!(first["inheritedStoryId"].is_null());
            }
            assert_eq!(
                serde_json::to_value(editor_projection(&bundle, None).unwrap()).unwrap(),
                before
            );
            assert!(bundle.revision(manifest.revision + 1).is_err());
        }
    }

    #[tokio::test]
    async fn declaration_service_and_owner_guards_cannot_be_bypassed() {
        let (_root, state, headers, request) = fixture(false).await;
        for key in [
            "x-hcd-coordinator-version",
            "x-hcd-word-layout-version",
            "x-hcd-word-story-version",
            "x-hcd-word-link-version",
        ] {
            let mut invalid = headers.clone();
            invalid.remove(key);
            assert_eq!(
                call(&state, invalid, request.clone()).await.unwrap_err().0,
                StatusCode::UPGRADE_REQUIRED
            );
        }
        let mut member = headers.clone();
        let user = self::headers(&state, "alice");
        member.insert("authorization", user["authorization"].clone());
        assert_eq!(
            call(&state, member, request.clone()).await.unwrap_err().0,
            StatusCode::UPGRADE_REQUIRED
        );
        let mut stale = headers.clone();
        stale.insert("x-hcd-word-journal-hash", "0".repeat(64).parse().unwrap());
        assert_eq!(
            call(&state, stale, request.clone()).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
        let mut missing = headers;
        missing.remove("x-hcd-word-owner");
        assert_eq!(
            call(&state, missing, request).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
    }

    #[tokio::test]
    async fn stale_head_hash_identity_and_first_section_are_rejected() {
        let (_root, state, headers, request) = fixture(false).await;
        for mode in 0..5 {
            let mut invalid = request.clone();
            match mode {
                0 => invalid.transaction.expected_revision += 1,
                1 => invalid.transaction.link.base_layout_hash = "0".repeat(64),
                2 => invalid.transaction.document_id = "other".into(),
                3 => {
                    invalid.transaction.link.expected_direct_story_id =
                        format!("n_{}", "0".repeat(32))
                }
                _ => {
                    let bundle = open(&state, "doc").unwrap();
                    let layout =
                        hcd_core::read_flow_document_layout(&bundle, &bundle.manifest().unwrap())
                            .unwrap()
                            .unwrap();
                    invalid.transaction.link.section_id = layout.sections[0].id.clone();
                }
            }
            assert!(call(&state, headers.clone(), invalid).await.is_err());
        }
        assert!(call(&state, headers, request).await.is_ok());
    }

    #[tokio::test]
    async fn current_author_permission_and_coordinator_identity_are_review_inputs() {
        let (root, state, headers, request) = fixture(false).await;
        let first = call(&state, headers.clone(), request.clone())
            .await
            .unwrap();
        let mut other = request.clone();
        other.coordinator_id = "f".repeat(32);
        assert_ne!(
            first["reviewHash"],
            call(&state, headers.clone(), other).await.unwrap()["reviewHash"]
        );
        fs::create_dir(root.path().join("access")).unwrap();
        fs::write(root.path().join("access/doc.json"),serde_json::to_vec(&json!({"generation":1,"readers":["hcd-collaboration","bob"],"writers":["hcd-collaboration","bob"]})).unwrap()).unwrap();
        assert_eq!(
            call(&state, headers, request).await.unwrap_err().0,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn actual_http_gate_allows_only_declared_link_review_and_keeps_other_routes_fenced() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (_root, state, headers, input) = fixture(false).await;
        let app = Router::new()
            .route("/v1/documents/{id}/word/link-preflight", post(preview))
            .route(
                "/v1/documents/{id}/patch",
                post(|| async { StatusCode::OK }),
            )
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                access_gate,
            ))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let body = serde_json::to_vec(
            &json!({"coordinatorId":input.coordinator_id,"transaction":input.transaction}),
        )
        .unwrap();
        for (route, model, expected) in [
            ("word/link-preflight", true, 200),
            ("word/link-preflight", false, 426),
            ("patch", true, 403),
        ] {
            let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
            let mut request=format!("POST /v1/documents/doc/{route} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",body.len());
            for (name, value) in &headers {
                if !model && name == "x-hcd-word-link-version" {
                    continue;
                }
                request.push_str(&format!("{}: {}\r\n", name, value.to_str().unwrap()));
            }
            request.push_str("\r\n");
            stream.write_all(request.as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).await.unwrap();
            let response = String::from_utf8(response).unwrap();
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
        server.abort();
        let _ = server.await;
    }
}
