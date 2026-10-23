//! Revision notifications are hints; immutable history is the source of truth.
//! WebSockets avoid occupying HTTP/1.1 request slots in multi-window editors.
use super::*;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::response::sse::{Event, KeepAlive, Sse};
use hcd_core::{extract_html_text_nodes, node_bloom_might_contain};
use std::collections::BTreeSet;
use std::convert::Infallible;
use std::time::Duration;

const MAX_TRACKED: usize = 10_000;
const MAX_REPLAY: u64 = 256;
const MAX_TEXT_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMessage {
    #[serde(rename_all = "camelCase")]
    Auth {
        token: String,
        after_revision: Option<u64>,
        #[serde(default)]
        node_ids: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Track { node_ids: Vec<String> },
}

fn tracked_ids(ids: Vec<String>) -> Result<BTreeSet<String>, ApiError> {
    if ids.len() > MAX_TRACKED || ids.iter().any(|id| !valid_node_id(id)) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid revision tracking nodes".into(),
        ));
    }
    Ok(ids.into_iter().collect())
}

fn valid_node_id(id: &str) -> bool {
    id.len() == 34 && id.starts_with("n_") && id[2..].bytes().all(|c| c.is_ascii_hexdigit())
}

/// Read text and hashes from one captured manifest, never a moving head.
fn revision_snapshot(
    state: &ServerState,
    id: &str,
    after: Option<u64>,
    tracked: &BTreeSet<String>,
    refresh_tracked: bool,
    published: Option<(u64, String)>,
) -> Result<RevisionEvent, ApiError> {
    let bundle = open(state, id)?;
    let latest = bundle.manifest().map_err(internal)?;
    let manifest = if let Some((revision, root)) = published {
        let (manifest, _) =
            manifest_at_revision(&bundle, &latest, Some(revision)).map_err(internal)?;
        if manifest.root_hash != root {
            return Err(internal("local revision is not the published remote head"));
        }
        manifest
    } else {
        latest
    };
    let head = manifest.revision;
    let mut event = RevisionEvent {
        revision: head,
        ..Default::default()
    };
    if after == Some(head) && !refresh_tracked {
        return Ok(event);
    }
    let mut targets = tracked.clone();
    match after {
        Some(previous) if previous <= head && head - previous <= MAX_REPLAY => {
            for revision in previous + 1..=head {
                let record = bundle.revision(revision).map_err(internal)?;
                event.reset |= record.structural_change || record.layout_upgrade;
                if head == previous + 1 {
                    event.patch_id = record.patch_id.unwrap_or_default();
                    event.author_name = record.author_name;
                }
                targets.extend(record.dirty_node_ids);
                if targets.len() > MAX_TRACKED {
                    event.reset = true;
                    targets = tracked.clone();
                    break;
                }
            }
        }
        _ => event.reset = true,
    }
    event.node_hashes = targets.iter().map(|id| (id.clone(), None)).collect();
    if targets.is_empty() {
        return Ok(event);
    }
    let mut bytes = 0;
    for page in 0..manifest.index_page_count {
        for descriptor in bundle
            .read_index_page(&manifest, page)
            .map_err(internal)?
            .chunks
        {
            if !targets
                .iter()
                .any(|id| node_bloom_might_contain(&descriptor.node_bloom, id))
            {
                continue;
            }
            let map = bundle.read_map_verified(&descriptor).map_err(internal)?;
            let entries: Vec<_> = map
                .entries
                .iter()
                .filter(|entry| {
                    targets.contains(&entry.node_id) && entry.source.node_kind != "image"
                })
                .collect();
            if entries.is_empty() {
                continue;
            }
            let html = bundle.read_chunk_verified(&descriptor).map_err(internal)?;
            let texts = extract_html_text_nodes(&html).map_err(internal)?;
            for entry in entries {
                let text = texts
                    .get(&entry.node_id)
                    .ok_or_else(|| internal("missing revision text"))?;
                if hash_bytes(text.as_bytes()) != entry.node_hash {
                    return Err(internal("revision text hash mismatch"));
                }
                event
                    .node_hashes
                    .insert(entry.node_id.clone(), Some(entry.node_hash.clone()));
                if bytes + text.len() <= MAX_TEXT_BYTES {
                    bytes += text.len();
                    event.nodes.push(RevisionNode {
                        node_id: entry.node_id.clone(),
                        text: text.clone(),
                        node_hash: entry.node_hash.clone(),
                    });
                } else {
                    // Hashes still protect drafts; consumers reload omitted bodies lazily.
                    event.reset = true;
                }
            }
        }
    }
    // JSON escaping and per-node metadata also count against the wire limit.
    if serde_json::to_vec(&event).map_err(internal)?.len() > 8 * 1024 * 1024 {
        event.nodes.clear();
        event.reset = true;
    }
    Ok(event)
}

async fn snapshot(
    state: &ServerState,
    id: &str,
    after: Option<u64>,
    tracked: &BTreeSet<String>,
    refresh_tracked: bool,
) -> Result<RevisionEvent, ApiError> {
    let published = match &state.remote {
        Some(remote) => Some(remote.published_head(id).await.map_err(internal)?),
        None => None,
    };
    let (state, id, tracked) = (state.clone(), id.to_string(), tracked.clone());
    tokio::task::spawn_blocking(move || {
        revision_snapshot(&state, &id, after, &tracked, refresh_tracked, published)
    })
    .await
    .map_err(internal)?
}

pub(super) async fn revision_websocket(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    // Authentication travels in the first frame, never a URL/access log.
    ws.max_message_size(512 * 1024)
        .max_frame_size(512 * 1024)
        .on_upgrade(move |socket| socket_events(socket, state, id))
}

async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await;
}

async fn socket_events(mut socket: WebSocket, state: ServerState, id: String) {
    let first = tokio::time::timeout(Duration::from_secs(5), socket.recv()).await;
    let Ok(Some(Ok(Message::Text(first)))) = first else {
        close(&mut socket, 4401, "authentication required").await;
        return;
    };
    let Ok(ClientMessage::Auth {
        token,
        after_revision,
        node_ids,
    }) = serde_json::from_str(&first)
    else {
        close(&mut socket, 4401, "authentication required").await;
        return;
    };
    let mut headers = HeaderMap::new();
    let Ok(value) = format!("Bearer {token}").parse() else {
        close(&mut socket, 4401, "invalid authentication").await;
        return;
    };
    headers.insert(header::AUTHORIZATION, value);
    let identity = match claims(&state, &headers, &id) {
        Ok(claims) => claims,
        Err(error) => {
            close(
                &mut socket,
                if error.0 == StatusCode::FORBIDDEN {
                    4403
                } else {
                    4401
                },
                "authentication failed",
            )
            .await;
            return;
        }
    };
    drop(headers);
    let Ok(mut tracked) = tracked_ids(node_ids) else {
        close(&mut socket, 4400, "invalid tracking nodes").await;
        return;
    };
    let mut inbox = state.revisions.subscribe(&id);
    let mut after = after_revision;
    let mut force = true;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(2));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        if SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            >= identity.exp as u64
        {
            close(&mut socket, 4401, "session expired").await;
            return;
        }
        let event = match snapshot(&state, &id, after, &tracked, force).await {
            Ok(event) => event,
            Err(_) => {
                close(&mut socket, 1011, "revision unavailable").await;
                return;
            }
        };
        if force || after != Some(event.revision) {
            let Ok(json) = serde_json::to_string(&event) else {
                return;
            };
            if socket.send(Message::Text(json.into())).await.is_err() {
                return;
            }
            after = Some(event.revision);
            force = false;
        }
        tokio::select! {
            message = socket.recv() => match message {
                Some(Ok(Message::Text(text))) => match serde_json::from_str(&text) {
                    Ok(ClientMessage::Track { node_ids }) => match tracked_ids(node_ids) {
                        Ok(ids) => { tracked = ids; force = true; },
                        Err(_) => { close(&mut socket, 4400, "invalid tracking nodes").await; return; }
                    },
                    _ => { close(&mut socket, 4400, "invalid message").await; return; }
                },
                Some(Ok(Message::Ping(bytes))) => { if socket.send(Message::Pong(bytes)).await.is_err() { return; } },
                Some(Ok(Message::Pong(_))) => {},
                _ => return,
            },
            notification = inbox.recv() => if matches!(notification, Err(broadcast::error::RecvError::Closed)) { return; },
            _ = heartbeat.tick() => { if socket.send(Message::Ping(Vec::new().into())).await.is_err() { return; } },
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EventQuery {
    after_revision: Option<u64>,
}

pub(super) async fn revision_events(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<EventQuery>,
    headers: HeaderMap,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let identity = claims(&state, &headers, &id)?;
    let mut inbox = state.revisions.subscribe(&id);
    let after = query.after_revision.or_else(|| {
        headers
            .get("last-event-id")
            .and_then(|v| v.to_str().ok()?.parse().ok())
    });
    let initial = snapshot(&state, &id, after, &BTreeSet::new(), false).await?;
    let stream = async_stream::stream! {
        let mut after = Some(initial.revision);
        yield Ok(Event::default().event("revision").id(initial.revision.to_string()).data(serde_json::to_string(&initial).unwrap_or_default()));
        let mut heartbeat = tokio::time::interval(Duration::from_secs(2));
        loop {
            tokio::select! {
                result = inbox.recv() => if matches!(result, Err(broadcast::error::RecvError::Closed)) { break; },
                _ = heartbeat.tick() => {},
            }
            if SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() >= identity.exp as u64 { break; }
            match snapshot(&state, &id, after, &BTreeSet::new(), false).await {
                Ok(event) if after != Some(event.revision) => {
                    after = Some(event.revision);
                    yield Ok(Event::default().event("revision").id(event.revision.to_string()).data(serde_json::to_string(&event).unwrap_or_default()));
                },
                Ok(_) => {},
                Err(_) => break,
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::SinkExt;
    use hcd_core::get_text_node;
    use tokio_tungstenite::{connect_async, tungstenite::Message as ClientFrame};

    fn fixture() -> (tempfile::TempDir, ServerState, Bundle, String) {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("input.txt");
        std::fs::write(&source, "Original\nSecond paragraph").unwrap();
        hcd_formats::import_document(
            &source,
            root.path().join("doc.hcd"),
            &hcd_formats::ImportOptions::new("doc"),
            |_| Ok(()),
        )
        .unwrap();
        let state = ServerState {
            root: root.path().into(),
            secret: Arc::new(vec![b'x'; 32]),
            remote: None,
            collaboration_lock: Arc::new(Mutex::new(())),
            revisions: RevisionHub::default(),
        };
        let bundle = open(&state, "doc").unwrap();
        let node = hcd_core::extract_text_page(&bundle, None, 1)
            .unwrap()
            .entries
            .remove(0)
            .node_id;
        (root, state, bundle, node)
    }

    fn edit(bundle: &Bundle, node_id: &str, text: &str) {
        let node = get_text_node(bundle, node_id).unwrap();
        let revision = bundle.manifest().unwrap().revision;
        let patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION.into(),
            document_id: "doc".into(),
            patch_id: format!("edit-{revision}"),
            base_revision: revision,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: node_id.into(),
                start: 0,
                delete_count: node.node.text.chars().count(),
                insert_text: text.into(),
                precondition: NodePrecondition {
                    node_hash: node.node.node_hash,
                },
            }],
            metadata: BTreeMap::new(),
        };
        apply_patch(bundle, &patch, revision).unwrap();
    }

    #[test]
    fn history_recovers_missed_updates_and_does_not_mislabel_merged_own_patches() {
        let (_root, state, bundle, node) = fixture();
        edit(&bundle, &node, "Remote one");
        edit(&bundle, &node, "Remote two");
        let event =
            revision_snapshot(&state, "doc", Some(0), &BTreeSet::new(), false, None).unwrap();
        assert_eq!(event.revision, 2);
        assert_eq!(event.nodes[0].text, "Remote two");
        assert!(event.patch_id.is_empty());
        let single =
            revision_snapshot(&state, "doc", Some(1), &BTreeSet::new(), false, None).unwrap();
        assert_eq!(single.patch_id, "edit-1");
        assert!(!single.reset);
    }

    #[test]
    fn tracked_drafts_are_checked_even_at_the_same_revision_and_missing_nodes_are_explicit() {
        let (_root, state, bundle, node) = fixture();
        edit(&bundle, &node, "Changed while disconnected");
        let missing = format!("n_{}", "f".repeat(32));
        let tracked = BTreeSet::from([node.clone(), missing.clone()]);
        let event = revision_snapshot(&state, "doc", Some(1), &tracked, true, None).unwrap();
        assert_eq!(event.nodes[0].text, "Changed while disconnected");
        assert!(event.node_hashes[&node].is_some());
        assert_eq!(event.node_hashes[&missing], None);
        let idle = revision_snapshot(&state, "doc", Some(1), &tracked, false, None).unwrap();
        assert!(idle.nodes.is_empty());
    }

    #[test]
    fn reset_recovers_tracked_text_from_restored_history_and_bounds_large_bodies() {
        let (_root, state, bundle, node) = fixture();
        edit(&bundle, &node, "Changed");
        restore_revision(&bundle, 0, 1, None, None).unwrap();
        let event = revision_snapshot(
            &state,
            "doc",
            Some(1),
            &BTreeSet::from([node.clone()]),
            false,
            None,
        )
        .unwrap();
        assert!(event.reset);
        assert_eq!(event.nodes[0].text, "Original");
        edit(&bundle, &node, &"a".repeat(MAX_TEXT_BYTES + 1));
        let event = revision_snapshot(
            &state,
            "doc",
            Some(2),
            &BTreeSet::from([node.clone()]),
            false,
            None,
        )
        .unwrap();
        assert!(event.reset);
        assert!(event.nodes.is_empty());
        assert!(event.node_hashes[&node].is_some());
        let initial =
            revision_snapshot(&state, "doc", None, &BTreeSet::from([node]), true, None).unwrap();
        assert!(initial.reset);
    }

    #[tokio::test]
    async fn publication_wakes_local_subscribers_and_history_survives_broadcast_lag() {
        let (_root, state, bundle, node) = fixture();
        let mut inbox = state.revisions.subscribe("doc");
        edit(&bundle, &node, "Durable text");
        publish_mutation(&state, "doc", &bundle, 0).await.unwrap();
        assert_eq!(inbox.recv().await.unwrap(), 1);
        for _ in 0..100 {
            state.revisions.publish("doc", 1);
        }
        assert!(matches!(
            inbox.recv().await,
            Err(broadcast::error::RecvError::Lagged(_))
        ));
        assert_eq!(
            revision_snapshot(&state, "doc", Some(0), &BTreeSet::new(), false, None)
                .unwrap()
                .nodes[0]
                .text,
            "Durable text"
        );
    }

    fn token(state: &ServerState, doc: &str, exp: usize) -> String {
        encode(
            &Header::new(Algorithm::HS256),
            &Claims {
                doc: doc.into(),
                scope: "read".into(),
                sub: None,
                name: None,
                aud: "hcd-core".into(),
                iat: 0,
                exp,
            },
            &EncodingKey::from_secret(&state.secret),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn socket_authenticates_before_sending_data_and_expires_read_only_sessions() {
        let (_root, state, _bundle, node) = fixture();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "ws://{}/v1/documents/doc/events/ws",
            listener.local_addr().unwrap()
        );
        let app = Router::new()
            .route("/v1/documents/{id}/events/ws", get(revision_websocket))
            .with_state(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (mut invalid, _) = connect_async(&url).await.unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize;
        invalid
            .send(ClientFrame::Text(
                json!({"type":"auth","token":token(&state,"other",now+60)})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let response = invalid.next().await.unwrap().unwrap();
        assert!(
            matches!(response, ClientFrame::Close(Some(frame)) if u16::from(frame.code) == 4403)
        );
        let (mut valid, _) = connect_async(&url).await.unwrap();
        valid.send(ClientFrame::Text(json!({"type":"auth","token":token(&state,"doc",now+3),"afterRevision":0,"nodeIds":[node]}).to_string().into())).await.unwrap();
        let frame = valid.next().await.unwrap().unwrap();
        assert!(
            matches!(frame, ClientFrame::Text(text) if serde_json::from_str::<Value>(&text).unwrap()["nodes"][0]["text"] == "Original")
        );
        loop {
            let response = tokio::time::timeout(Duration::from_secs(5), valid.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            if let ClientFrame::Close(Some(frame)) = response {
                assert_eq!(u16::from(frame.code), 4401);
                break;
            }
        }
        server.abort();
    }

    #[test]
    fn unpublished_local_candidates_never_leak_into_remote_revision_events() {
        let (_root, state, bundle, node) = fixture();
        let published = (0, bundle.manifest().unwrap().root_hash);
        edit(&bundle, &node, "Candidate not published yet");
        let tracked = BTreeSet::from([node]);
        let event =
            revision_snapshot(&state, "doc", Some(0), &tracked, true, Some(published)).unwrap();
        assert_eq!(event.revision, 0);
        assert_eq!(event.nodes[0].text, "Original");
        assert!(revision_snapshot(
            &state,
            "doc",
            Some(0),
            &tracked,
            true,
            Some((1, "wrong-root".into()))
        )
        .is_err());
    }

    #[tokio::test]
    async fn sse_last_event_id_replays_history_with_an_explicit_revision_id() {
        let (_root, state, bundle, node) = fixture();
        edit(&bundle, &node, "Missed first edit");
        edit(&bundle, &node, "Missed second edit");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize;
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", token(&state, "doc", now + 60))
                .parse()
                .unwrap(),
        );
        headers.insert("last-event-id", "1".parse().unwrap());
        let response = revision_events(
            State(state),
            Path("doc".into()),
            Query(EventQuery::default()),
            headers,
        )
        .await
        .unwrap()
        .into_response();
        let mut body = response.into_body().into_data_stream();
        let frame = body.next().await.unwrap().unwrap();
        let text = std::str::from_utf8(&frame).unwrap();
        assert!(text.contains("id: 2"));
        assert!(text.contains("Missed second edit"));
        assert!(text.contains("edit-1"));
    }

    #[test]
    fn hub_prunes_unused_documents_and_tracking_is_bounded() {
        let hub = RevisionHub::default();
        hub.publish("unused", 1);
        assert!(hub.senders.lock().unwrap().is_empty());
        let receiver = hub.subscribe("old");
        drop(receiver);
        let _current = hub.subscribe("current");
        assert_eq!(hub.senders.lock().unwrap().len(), 1);
        assert!(tracked_ids(vec!["invalid".into()]).is_err());
        assert!(tracked_ids(vec![format!("n_{}", "a".repeat(32)); MAX_TRACKED + 1]).is_err());
    }
}
