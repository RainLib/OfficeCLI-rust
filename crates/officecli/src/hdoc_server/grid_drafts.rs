//! Reconcile a durable grid write intent without replaying it or trusting a
//! client-supplied receipt. Hash the same typed payload as apply_patch.
use super::*;

pub(super) async fn review(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(patch): Json<PatchBatch>,
) -> Result<Json<Value>, ApiError> {
    let actor = write_claims(&state, &headers, &id)?;
    let _guard = state.collaboration_lock.lock().await;
    check_collaboration_epoch(&state, &id, &headers).await?;
    if patch.document_id != id || patch.patch_id.trim().is_empty() {
        return Err(bad("patch identity mismatch"));
    }
    crate::capabilities::validate_patch(
        crate::capabilities::runtime(),
        "/node-patch",
        &serde_json::to_value(&patch).map_err(internal)?,
    )
    .map_err(bad)?;
    let bytes = serde_json::to_vec(&patch).map_err(internal)?;
    if bytes.len() as u64 > MAX_PATCH_JSON_BYTES {
        return Err(bad("patch exceeds HCD size limit"));
    }
    let bundle = open(&state, &id)?;
    let manifest = bundle.manifest().map_err(hcd_error)?;
    if !manifest.source.is_spreadsheet() {
        return Err(bad(
            "node patch review currently supports spreadsheets only",
        ));
    }
    let mut result = json!({"protocolVersion":"hcd-node-patch-review/1", "documentId":id,
        "patchId":patch.patch_id,"revision":manifest.revision,"rootHash":manifest.root_hash,
        "state":"conflict"});
    if patch.base_revision == manifest.revision {
        if patch
            .metadata
            .get("rootHash")
            .is_none_or(|hash| hash == &manifest.root_hash)
        {
            // This is a current-version intent, not a dry-run validation of
            // every cell. The actual write still checks hashes and leases.
            result["state"] = json!("ready");
        }
    } else if patch.base_revision < manifest.revision {
        let record = bundle
            .revision(patch.base_revision + 1)
            .map_err(hcd_error)?;
        let hash = hcd_core::hash_bytes(&bytes);
        if actor.sub.is_some()
            && record.author_id == actor.sub
            && record.patch_id.as_deref() == Some(patch.patch_id.as_str())
            && record.patch_hash.as_deref() == Some(hash.as_str())
            && record.patch_base_revision == Some(patch.base_revision)
        {
            result["state"] = json!("applied");
            result["appliedRevision"] = json!(record.revision);
        }
    }
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn delimited_grid_intents_can_be_reviewed_and_reconciled() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"delimited-grid-recovery-unit-secret";
        let state = super::super::tests::test_state(secret, temp.path());
        for (format, source_text) in [
            ("csv", "name,value\nAlpha,1\n"),
            ("tsv", "name\tvalue\nAlpha\t1\n"),
        ] {
            let id = format!("grid-{format}");
            let source = temp.path().join(format!("source.{format}"));
            std::fs::write(&source, source_text).unwrap();
            hcd_formats::import_document(
                &source,
                temp.path().join(format!("{id}.hcd")),
                &hcd_formats::ImportOptions::new(&id),
                |_| Ok(()),
            )
            .unwrap();
            let bundle = open(&state, &id).unwrap();
            let node = hcd_core::extract_text_page(&bundle, None, 100)
                .unwrap()
                .entries
                .into_iter()
                .find(|entry| entry.text == "Alpha")
                .unwrap();
            let mut headers =
                super::super::tests::bearer_as(secret, &id, "write", Some("owner"), None);
            headers.insert("x-hcd-collaboration-epoch", "0".parse().unwrap());
            let patch: PatchBatch = serde_json::from_value(json!({"schemaVersion":"hcd-patch/1",
                "documentId":id,"patchId":"durable-grid-intent","baseRevision":0,
                "operations":[{"op":"text.splice","nodeId":node.node_id,"start":0,"deleteCount":0,
                    "insertText":"New ","precondition":{"nodeHash":node.node_hash}}]}))
            .unwrap();
            let inspect = || {
                review(
                    State(state.clone()),
                    Path(id.clone()),
                    headers.clone(),
                    Json(patch.clone()),
                )
            };
            assert_eq!(inspect().await.unwrap().0["state"], "ready");
            let _ = node_patch(
                State(state.clone()),
                Path(id.clone()),
                headers.clone(),
                Json(patch.clone()),
            )
            .await
            .unwrap();
            assert_eq!(inspect().await.unwrap().0["state"], "applied");
        }
    }

    #[tokio::test]
    async fn review_proves_exact_payload_author_and_commit_without_writing_or_replaying() {
        let temp = tempfile::tempdir().unwrap();
        let secret = b"grid-draft-review-test-secret-0123456789";
        let state = super::super::tests::test_state(secret, temp.path());
        let id = "grid-recovery";
        let source =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/showcase/gradebook.xlsx");
        hcd_formats::import_document(
            source,
            temp.path().join(format!("{id}.hcd")),
            &hcd_formats::ImportOptions::new(id),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = open(&state, id).unwrap();
        let node = hcd_core::extract_text_page(&bundle, None, 100)
            .unwrap()
            .entries
            .into_iter()
            .find(|n| n.source.editable && n.source.node_kind == "cell")
            .unwrap();
        let headers = |user, scope, epoch: &'static str| {
            let mut h = super::super::tests::bearer_as(secret, id, scope, Some(user), None);
            h.insert("x-hcd-collaboration-epoch", epoch.parse().unwrap());
            h
        };
        let patch: PatchBatch = serde_json::from_value(json!({"schemaVersion":"hcd-patch/50",
            "documentId":id,"patchId":"durable-grid-intent","baseRevision":0,
            "operations":[{"op":"xlsx.richText.set","nodeId":node.node_id,
                "runs":[{"text":"Recovered","properties":{"b":{"val":"1"}}}],
                "precondition":{"nodeHash":node.node_hash}}],
            "metadata":{"rootHash":bundle.manifest().unwrap().root_hash}}))
        .unwrap();
        let inspect = |p, h| review(State(state.clone()), Path(id.into()), h, Json(p));
        assert_eq!(
            inspect(patch.clone(), headers("owner", "write", "0"))
                .await
                .unwrap()
                .0["state"],
            "ready"
        );
        assert_eq!(bundle.manifest().unwrap().revision, 0);
        assert_eq!(
            inspect(patch.clone(), headers("owner", "read", "0"))
                .await
                .unwrap_err()
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            inspect(patch.clone(), headers("owner", "write", "1"))
                .await
                .unwrap_err()
                .0,
            StatusCode::CONFLICT
        );
        let _ = node_patch(
            State(state.clone()),
            Path(id.into()),
            headers("owner", "write", "0"),
            Json(patch.clone()),
        )
        .await
        .unwrap();
        let receipt = inspect(patch.clone(), headers("owner", "write", "0"))
            .await
            .unwrap()
            .0;
        assert_eq!(receipt["state"], "applied");
        assert_eq!(receipt["appliedRevision"], 1);
        assert_eq!(
            inspect(patch.clone(), headers("other", "write", "0"))
                .await
                .unwrap()
                .0["state"],
            "conflict"
        );
        let mut altered = patch.clone();
        altered.metadata.insert("tampered".into(), "yes".into());
        assert_eq!(
            inspect(altered, headers("owner", "write", "0"))
                .await
                .unwrap()
                .0["state"],
            "conflict"
        );
        let mut later = patch.clone();
        later.patch_id = "later-edit".into();
        later.base_revision = 1;
        later.metadata.clear();
        if let hcd_core::PatchOperation::XlsxRichTextSet { precondition, .. } =
            &mut later.operations[0]
        {
            precondition.node_hash = hcd_core::hash_bytes(b"Recovered");
        }
        let _ = node_patch(
            State(state.clone()),
            Path(id.into()),
            headers("owner", "write", "0"),
            Json(later),
        )
        .await
        .unwrap();
        let receipt = inspect(patch.clone(), headers("owner", "write", "0"))
            .await
            .unwrap()
            .0;
        assert_eq!(receipt["state"], "applied");
        assert_eq!(receipt["revision"], 2);
        let mut stale = patch;
        stale.patch_id = "never-committed".into();
        assert_eq!(
            inspect(stale, headers("owner", "write", "0"))
                .await
                .unwrap()
                .0["state"],
            "conflict"
        );
        assert_eq!(bundle.manifest().unwrap().revision, 2);
    }
}
