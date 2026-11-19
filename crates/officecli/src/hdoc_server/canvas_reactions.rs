use super::*;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default, Serialize, Deserialize)]
struct Votes {
    epoch: u64,
    version: u64,
    elements: BTreeMap<String, BTreeMap<String, BTreeSet<String>>>,
}
async fn load(state: &ServerState, id: &str, epoch: u64) -> Result<Votes, ApiError> {
    if let Some(remote) = &state.remote {
        return match remote.canvas_reactions(id, epoch).await.map_err(internal)? {
            Some(data) => serde_json::from_str(&data).map_err(internal),
            None => Ok(Votes {
                epoch,
                ..Votes::default()
            }),
        };
    }
    let path = state
        .root
        .join("canvas-reactions")
        .join(format!("{id}.json"));
    match std::fs::read(path) {
        Ok(bytes) => {
            let book: Votes = serde_json::from_slice(&bytes).map_err(internal)?;
            if book.epoch == epoch {
                return Ok(book);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(internal(error)),
    }
    Ok(Votes {
        epoch,
        ..Votes::default()
    })
}
fn present(book: &Votes, actor: Option<&str>) -> Value {
    let mut elements = BTreeMap::new();
    for (id, votes) in &book.elements {
        let counts: BTreeMap<_, _> = votes
            .iter()
            .map(|(kind, owners)| {
                let mine = actor.is_some_and(|sub| owners.contains(sub));
                (kind, json!({"count": owners.len(), "mine": mine}))
            })
            .collect();
        elements.insert(id, counts);
    }
    json!({"epoch":book.epoch,"version":book.version,"elements":elements})
}
pub(super) async fn read(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let actor = canvas::access(&state, &id, &headers, false).await?;
    let _lock = state.collaboration_lock.lock().await;
    let book = load(&state, &id, collaboration_epoch(&state, &id).await?).await?;
    Ok(Json(present(&book, actor.sub.as_deref())))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    element_ids: Vec<String>,
    kind: String,
    active: bool,
}
pub(super) async fn set(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<Request>,
) -> Result<Json<Value>, ApiError> {
    let actor = canvas::access(&state, &id, &headers, true).await?;
    let sub = actor
        .sub
        .as_deref()
        .filter(|sub| !sub.is_empty())
        .ok_or_else(|| ApiError(StatusCode::FORBIDDEN, "需要已识别的协作者。".into()))?;
    if actor.worker_generation.is_some()
        || headers.contains_key("x-hcd-agent-run-id")
        || headers.contains_key("x-hcd-agent-edit")
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "反馈使用协作者本人身份。".into(),
        ));
    }
    if !canvas_core::materials::is_reaction(&req.kind) {
        return Err(bad("未知印章。"));
    }
    if req.element_ids.is_empty() || req.element_ids.len() > 2000 {
        return Err(bad("请选择画布元素。"));
    }
    let _lock = state.collaboration_lock.lock().await;
    let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
    let scene = hcd_core::canvas::read_scene(&open(&state, &id)?, None).map_err(hcd_error)?;
    let live: HashSet<_> = scene
        .elements
        .iter()
        .filter(|e| e["isDeleted"] != true)
        .filter_map(|e| e["id"].as_str())
        .collect();
    if req
        .element_ids
        .iter()
        .any(|key| !live.contains(key.as_str()))
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "选区已变化，请重新选择。".into(),
        ));
    }
    let mut book = load(&state, &id, epoch).await?;
    let mut changed = false;
    for element in req.element_ids {
        let votes = book.elements.entry(element.clone()).or_default();
        let owners = votes.entry(req.kind.clone()).or_default();
        changed |= if req.active {
            owners.insert(sub.to_owned())
        } else {
            owners.remove(sub)
        };
        if owners.is_empty() {
            votes.remove(&req.kind);
        }
        if votes.is_empty() {
            book.elements.remove(&element);
        }
    }
    if changed {
        book.elements.retain(|key, _| live.contains(key.as_str()));
        let previous = book.version;
        book.version += 1;
        if let Some(remote) = &state.remote {
            let data = serde_json::to_string(&book).map_err(internal)?;
            if !remote
                .save_canvas_reactions(&id, epoch, previous, &data)
                .await
                .map_err(internal)?
            {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "反馈已更新，请重试。".into(),
                ));
            }
        } else {
            let dir = state.root.join("canvas-reactions");
            std::fs::create_dir_all(&dir).map_err(internal)?;
            let tmp = tempfile::NamedTempFile::new_in(&dir).map_err(internal)?;
            serde_json::to_writer(tmp.as_file(), &book).map_err(internal)?;
            tmp.as_file().sync_all().map_err(internal)?;
            tmp.persist(dir.join(format!("{id}.json")))
                .map_err(internal)?;
        }
        let _ = canvas::room(&state, &id)
            .await
            .send(json!({"type":"reactions","epoch":epoch,"version":book.version}));
    }
    Ok(Json(present(&book, Some(sub))))
}
