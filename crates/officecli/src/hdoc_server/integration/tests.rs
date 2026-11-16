use super::*;

fn config() -> provider::Config {
    provider::Config {
        schema_version: "officecli-integration/1".into(),
        tenant_id: "tenant-a".into(),
        app_id: "app-a".into(),
        provider_url: "http://127.0.0.1:19999".into(),
        key_id: "key-a".into(),
        provider_secret_env: "unused".into(),
        service_secret_env: "unused".into(),
        transfer_origins: vec!["http://127.0.0.1:19999".into()],
        events: None,
    }
}

fn fixture(root: &std::path::Path) -> (ServerState, Session) {
    let mut state =
        crate::hdoc_server::tests::test_state(b"host-tests-need-at-least-32-byte-secret", root);
    let config = config();
    let store = store::Store::open(root, &config).unwrap();
    store
        .save_mapping(&Mapping {
            document_id: "managed".into(),
            tenant_id: config.tenant_id.clone(),
            app_id: config.app_id.clone(),
            external_file_id: "file-1".into(),
            external_head: "v1".into(),
            last_published_revision: None,
            sequence: 0,
            pending_publication: None,
            source: Descriptor {
                id: "file-1".into(),
                version: "v1".into(),
                name: "document.txt".into(),
                media_type: "text/plain".into(),
                size_bytes: 0,
                sha256: hcd_core::hash_bytes(b""),
                created_at: provider::date_now(),
                modified_at: provider::date_now(),
                creator_id: "alice".into(),
                modifier_id: "alice".into(),
            },
        })
        .unwrap();
    let session = Session {
        session_id: uuid::Uuid::new_v4().to_string(),
        exchange_id: uuid::Uuid::new_v4().to_string(),
        credential_hash: hcd_core::hash_bytes(b"illustrative-code"),
        external_file_id: "file-1".into(),
        document_id: "managed".into(),
        actor: provider::User {
            id: "alice".into(),
            display_name: "Alice".into(),
            avatar_url: None,
            deleted: false,
        },
        expires_at: now() + 300,
        host_expires_at: now() + 3600,
        closed: false,
    };
    store.save_session(&session).unwrap();
    state.integration = Some(Arc::new(Integration {
        provider: Provider::testing(config),
        store,
        locks: Default::default(),
    }));
    (state, session)
}

fn headers(state: &ServerState, session: &Session) -> HeaderMap {
    let token = encode(
        &Header::new(Algorithm::HS256),
        &Claims {
            doc: session.document_id.clone(),
            scope: "write".into(),
            sub: Some(session.subject()),
            name: Some("Alice".into()),
            aud: "hcd-core".into(),
            iat: now() as usize,
            exp: session.expires_at as usize,
            worker_generation: None,
            integration_session: Some(session.session_id.clone()),
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

#[test]
fn legacy_write_tokens_cannot_open_managed_documents() {
    let temp = tempfile::tempdir().unwrap();
    let (state, session) = fixture(temp.path());
    let legacy = crate::hdoc_server::tests::bearer_as(
        &state.secret,
        "managed",
        "write",
        Some("alice"),
        None,
    );
    assert_eq!(
        claims(&state, &legacy, "managed").unwrap_err().0,
        StatusCode::FORBIDDEN
    );
    assert!(claims(&state, &headers(&state, &session), "managed").is_ok());
    assert!(claims(&state, &headers(&state, &session), "another-doc").is_err());
}

#[test]
fn closing_a_session_invalidates_its_already_issued_token_and_survives_restart() {
    let temp = tempfile::tempdir().unwrap();
    let (state, mut session) = fixture(temp.path());
    let bearer = headers(&state, &session);
    assert!(claims(&state, &bearer, "managed").is_ok());
    session.closed = true;
    let integration = state.integration.as_ref().unwrap();
    integration.store.save_session(&session).unwrap();
    assert_eq!(
        claims(&state, &bearer, "managed").unwrap_err().0,
        StatusCode::UNAUTHORIZED
    );
    let recovered = store::Store::open(temp.path(), &config()).unwrap();
    assert!(recovered.session(&session.session_id).is_err());
    assert!(
        recovered
            .session_record(&session.session_id)
            .unwrap()
            .unwrap()
            .closed
    );
    assert_eq!(recovered.mapping("managed").unwrap().source.version, "v1");
}

#[test]
fn a_root_cannot_silently_change_provider_or_tenant() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path());
    let mut changed = config();
    changed.tenant_id = "tenant-b".into();
    assert!(store::Store::open(temp.path(), &changed).is_err());
    changed = config();
    changed.provider_url = "http://127.0.0.1:29999".into();
    assert!(store::Store::open(temp.path(), &changed).is_err());
}

#[test]
fn durable_records_reject_path_ids_and_corruption() {
    let temp = tempfile::tempdir().unwrap();
    let (state, _) = fixture(temp.path());
    let integration = state.integration.as_ref().unwrap();
    assert!(integration.store.publication("../../other").is_err());
    assert!(integration.store.session_record("../../other").is_err());
    std::fs::write(
        integration.store.root.join("documents/managed.json"),
        b"broken",
    )
    .unwrap();
    assert!(store::Store::open(temp.path(), &config()).is_err());
}

#[test]
fn file_descriptors_reject_unbounded_or_unidentified_sources() {
    let temp = tempfile::tempdir().unwrap();
    let (state, _) = fixture(temp.path());
    let mut descriptor = state
        .integration
        .as_ref()
        .unwrap()
        .store
        .mapping("managed")
        .unwrap()
        .source;
    assert_eq!(descriptor.format().unwrap(), "txt");
    descriptor.size_bytes = MAX_FILE_BYTES + 1;
    assert!(descriptor.format().is_err());
    descriptor.size_bytes = 1;
    descriptor.sha256 = "incorrect".into();
    assert!(descriptor.format().is_err());
    descriptor.sha256 = "a".repeat(64);
    descriptor.name = "payload.exe".into();
    assert!(descriptor.format().is_err());
}

#[test]
fn corrupt_publication_records_fail_startup_even_with_events_disabled() {
    let temp = tempfile::tempdir().unwrap();
    let (state, _) = fixture(temp.path());
    let root = &state.integration.as_ref().unwrap().store.root;
    std::fs::write(
        root.join("publications")
            .join(format!("{}.json", uuid::Uuid::new_v4())),
        b"broken",
    )
    .unwrap();
    assert!(store::Store::open(temp.path(), &config()).is_err());
}
