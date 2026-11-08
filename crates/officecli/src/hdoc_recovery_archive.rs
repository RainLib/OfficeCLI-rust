//! Read-only verification of the canonical archive carried by a recovery file.
//! No draft, ACL, receipt or collaboration state is adopted by this endpoint.
use super::*;
use crate::commands::hdoc_archive;

pub(super) const MAX_ARCHIVE_BYTES: usize = 48 * 1024 * 1024;
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InspectQuery {
    revision: u64,
    root_hash: String,
    epoch: u64,
}
fn valid_query(query: &InspectQuery) -> bool {
    query.revision <= hcd_core::MAX_REVISION
        && query.epoch <= hcd_core::MAX_REVISION
        && query.root_hash.len() == 64
        && query
            .root_hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn check_archive(bytes: &[u8], id: &str, query: &InspectQuery) -> Result<(), ApiError> {
    if bytes.is_empty() || bytes.len() > MAX_ARCHIVE_BYTES || !valid_query(query) {
        return Err(bad("invalid recovery canonical archive or scope"));
    }
    let staging = tempfile::tempdir().map_err(internal)?;
    let archive = staging.path().join("input.hcdz");
    let output = staging.path().join("verified.hcd");
    std::fs::write(&archive, bytes).map_err(internal)?;
    hdoc_archive::unpack(&archive, &output).map_err(bad)?;
    let bundle = Bundle::open(output).map_err(bad)?;
    let manifest = bundle.manifest().map_err(bad)?;
    if manifest.document_id != id
        || manifest.revision != query.revision
        || manifest.root_hash != query.root_hash
    {
        return Err(bad("recovery canonical archive does not match its scope"));
    }
    Ok(())
}
pub(super) async fn inspect(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<InspectQuery>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    if !valid_query(&query) {
        return Err(bad("invalid recovery canonical scope"));
    }
    if collaboration_epoch(&state, &id).await? != query.epoch {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "recovery epoch differs from current access".into(),
        ));
    }
    let bundle = open(&state, &id)?;
    let head = bundle.manifest().map_err(internal)?;
    let (baseline, _) =
        manifest_at_revision(&bundle, &head, Some(query.revision)).map_err(hcd_error)?;
    if baseline.root_hash != query.root_hash {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "recovery baseline is not in this document history".into(),
        ));
    }
    // Reuse the export concurrency limit. The permit stays with the blocking
    // verifier even if its requester disconnects; all extraction is temporary.
    let permit = export_process::reserve_slot()?;
    let verify_id = id.clone();
    let verify_query = query.clone();
    let sha256 = hash_bytes(&bytes);
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        check_archive(&bytes, &verify_id, &verify_query)
    })
    .await
    .map_err(internal)??;
    authorize(&state, &headers, &id, false)?;
    if collaboration_epoch(&state, &id).await? != query.epoch {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "recovery epoch changed during verification".into(),
        ));
    }
    Ok(Json(
        json!({"schemaVersion":"hcd-recovery-canonical/1","documentId":id,"revision":query.revision,"rootHash":query.root_hash,"epoch":query.epoch,"sha256":sha256,"verified":true}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(root: &std::path::Path, id: &str) -> Bundle {
        let source = root.join(format!("{id}.md"));
        std::fs::write(&source, "# Recovery\n\nCanonical content").unwrap();
        let output = root.join(format!("{id}.hcd"));
        hcd_formats::import_document(
            &source,
            &output,
            &hcd_formats::ImportOptions::new(id),
            |_| Ok(()),
        )
        .unwrap();
        Bundle::open(output).unwrap()
    }
    fn state(root: &std::path::Path) -> ServerState {
        ServerState {
            root: root.to_owned(),
            secret: Arc::new(vec![b'x'; 32]),
            remote: None,
            collaboration_lock: Arc::new(Mutex::new(())),
            revisions: RevisionHub::default(),
            word_owners: word_owner::WordOwners::default(),
        }
    }
    fn headers(state: &ServerState, doc: &str, scope: &str) -> HeaderMap {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize;
        let claims = Claims {
            doc: doc.into(),
            scope: scope.into(),
            sub: Some("reader".into()),
            name: None,
            aud: "hcd-core".into(),
            iat: now,
            exp: now + 3600,
        };
        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
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
    async fn reader_verifies_real_archive_without_changing_document_or_collaboration() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = fixture(temp.path(), "doc");
        let manifest = bundle.manifest().unwrap();
        let output = temp.path().join("doc.hcdz");
        hdoc_archive::pack(&bundle, &output, None).unwrap();
        let bytes = std::fs::read(output).unwrap();
        let state = state(temp.path());
        let headers = headers(&state, "doc", "read");
        let response = inspect(
            State(state.clone()),
            Path("doc".into()),
            Query(InspectQuery {
                revision: manifest.revision,
                root_hash: manifest.root_hash.clone(),
                epoch: 0,
            }),
            headers,
            Bytes::from(bytes.clone()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(response["sha256"], hash_bytes(&bytes));
        assert_eq!(response["verified"], true);
        assert_eq!(bundle.manifest().unwrap().root_hash, manifest.root_hash);
        assert!(!temp.path().join("collaboration").exists());
    }
    #[tokio::test]
    async fn wrong_token_history_epoch_and_malformed_archive_never_change_head() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = fixture(temp.path(), "doc");
        let manifest = bundle.manifest().unwrap();
        let state = state(temp.path());
        let mut query = InspectQuery {
            revision: manifest.revision,
            root_hash: manifest.root_hash.clone(),
            epoch: 0,
        };
        assert_eq!(
            inspect(
                State(state.clone()),
                Path("doc".into()),
                Query(query.clone()),
                HeaderMap::new(),
                Bytes::from_static(b"bad")
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert!(inspect(
            State(state.clone()),
            Path("doc".into()),
            Query(query.clone()),
            headers(&state, "other", "read"),
            Bytes::from_static(b"bad")
        )
        .await
        .is_err());
        query.epoch = 1;
        assert_eq!(
            inspect(
                State(state.clone()),
                Path("doc".into()),
                Query(query.clone()),
                headers(&state, "doc", "read"),
                Bytes::from_static(b"bad")
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::CONFLICT
        );
        query.epoch = 0;
        query.root_hash = "b".repeat(64);
        assert_eq!(
            inspect(
                State(state.clone()),
                Path("doc".into()),
                Query(query.clone()),
                headers(&state, "doc", "read"),
                Bytes::from_static(b"bad")
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::CONFLICT
        );
        query.root_hash = manifest.root_hash.clone();
        assert!(inspect(
            State(state.clone()),
            Path("doc".into()),
            Query(query),
            headers(&state, "doc", "read"),
            Bytes::from_static(b"not a ZIP")
        )
        .await
        .is_err());
        assert_eq!(bundle.manifest().unwrap().root_hash, manifest.root_hash);
    }
    #[test]
    fn archive_content_cannot_be_relabelled_as_the_requested_document() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = fixture(temp.path(), "other");
        let manifest = bundle.manifest().unwrap();
        let output = temp.path().join("other.hcdz");
        hdoc_archive::pack(&bundle, &output, None).unwrap();
        let query = InspectQuery {
            revision: manifest.revision,
            root_hash: manifest.root_hash,
            epoch: 0,
        };
        assert!(check_archive(&std::fs::read(output).unwrap(), "doc", &query).is_err());
    }
}
