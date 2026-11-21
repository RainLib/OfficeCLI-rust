//! Short-lived, authenticated operation traces are independent of cursor focus.
//! A completed batch is replayed by the UI; no animation delays real writes.
use super::*;

pub(super) type OperationStore = Arc<Mutex<HashMap<(String, String), AgentOperation>>>;
const MAX_TARGETS: usize = 128;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OperationTarget {
    pub node_id: Option<String>,
    pub block_id: Option<String>,
    pub chunk_sequence: Option<usize>,
    pub sheet_id: Option<String>,
    pub row: Option<usize>,
    pub column: Option<usize>,
    pub label: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentOperation {
    operation_id: String,
    agent_id: String,
    name: String,
    status: String,
    revision: u64,
    collaboration_epoch: u64,
    updated_at_epoch_ms: u64,
    total_targets: usize,
    targets: Vec<OperationTarget>,
}

pub(super) fn from_operations(operations: &[Value]) -> Vec<OperationTarget> {
    operations
        .iter()
        .map(|op| OperationTarget {
            node_id: op["nodeId"].as_str().map(str::to_string),
            block_id: op["blockId"].as_str().map(str::to_string),
            chunk_sequence: op["chunkSequence"].as_u64().map(|v| v as usize),
            sheet_id: op["sheetId"].as_str().map(str::to_string),
            row: op["row"].as_u64().map(|v| v as usize),
            column: op["column"].as_u64().map(|v| v as usize),
            label: Some(
                match op["op"].as_str().unwrap_or("") {
                    "xlsx.formula.set" => "修改公式",
                    "xlsx.formula.create" => "新增公式",
                    "text.splice" => "修改文字",
                    "block.replace" => "修改段落",
                    "block.delete" => "删除段落",
                    "block.insert" => "新增段落",
                    "pptx.text.insert" => "新增文字框",
                    "pptx.slide.add" => "新增幻灯片",
                    "pptx.slide.delete" => "替换旧幻灯片",
                    "pptx.run.format" => "设置页面样式",
                    _ => "更新内容",
                }
                .into(),
            ),
        })
        .collect()
}

/// Insertions address a chunk before their server-minted node IDs exist. Resolve
/// that page for planning and the actual inserted text node after the commit.
pub(super) fn patch_targets(bundle: &Bundle, operations: &[Value]) -> Vec<OperationTarget> {
    let mut targets = from_operations(operations);
    let Ok(manifest) = bundle.manifest() else {
        return targets;
    };
    for (operation, target) in operations.iter().zip(&mut targets) {
        let Some(chunk_id) = operation["chunkId"].as_str() else {
            continue;
        };
        for page in 0..manifest.index_page_count {
            let Ok(index) = bundle.read_index_page(&manifest, page) else {
                continue;
            };
            let Some(descriptor) = index.chunks.into_iter().find(|d| d.chunk_id == chunk_id) else {
                continue;
            };
            target.chunk_sequence = Some(descriptor.sequence);
            if operation["op"] == "pptx.text.insert" {
                if let Ok(map) = bundle.read_map_verified(&descriptor) {
                    target.node_id = map
                        .entries
                        .iter()
                        .rev()
                        .find(|entry| {
                            entry.source.created_in_hcd
                                && hcd_core::get_text_node(bundle, &entry.node_id).is_ok_and(|n| {
                                    Some(n.node.text.as_str()) == operation["text"].as_str()
                                })
                        })
                        .map(|e| e.node_id.clone());
                }
            }
            break;
        }
    }
    targets
}

pub(super) fn validate_targets(
    bundle: &Bundle,
    targets: &[OperationTarget],
) -> Result<Vec<OperationTarget>, ApiError> {
    if targets.len() > MAX_TARGETS {
        return Err(bad("at most 128 activity targets"));
    }
    let manifest = bundle.manifest().map_err(hcd_error)?;
    let blocks = if targets.iter().any(|t| t.block_id.is_some()) {
        Some(editor_projection(bundle, None).map_err(hcd_error)?)
    } else {
        None
    };
    for target in targets {
        if target
            .label
            .as_ref()
            .is_some_and(|s| s.chars().count() > 80)
            || target.node_id.is_some() && target.block_id.is_some()
            || target.node_id.is_none()
                && target.block_id.is_none()
                && target.chunk_sequence.is_none()
            || target.sheet_id.is_some()
            || target.row.is_some()
            || target.column.is_some()
            || target
                .chunk_sequence
                .is_some_and(|v| v >= manifest.chunk_count)
        {
            return Err(bad(
                "invalid activity target; use a read nodeId, blockId or chunkSequence",
            ));
        }
        if let Some(id) = &target.node_id {
            if hcd_core::get_text_node(bundle, id).is_err() {
                hcd_core::get_image_node(bundle, id).map_err(hcd_error)?;
            }
        }
        if let Some(id) = &target.block_id {
            if !blocks
                .as_ref()
                .is_some_and(|p| p.blocks.iter().any(|b| &b.block_id == id))
            {
                return Err(bad("unknown activity blockId"));
            }
        }
    }
    Ok(targets.to_vec())
}

pub(super) async fn record(
    state: &ServerState,
    id: &str,
    actor: &Claims,
    status: &str,
    revision: u64,
    epoch: u64,
    targets: Vec<OperationTarget>,
) {
    let Some(agent_id) = actor
        .sub
        .as_ref()
        .filter(|s| !s.is_empty() && s.len() <= 128 && s.as_str() != "hcd-collaboration")
    else {
        return;
    };
    if targets.is_empty() {
        return;
    }
    let now = agent_now();
    let mut store = state.agent_operations.lock().await;
    store.retain(|_, op| now.saturating_sub(op.updated_at_epoch_ms) < 60_000);
    if store.len() >= 1024 && !store.contains_key(&(id.into(), agent_id.clone())) {
        return;
    }
    let total_targets = targets.len();
    store.insert(
        (id.into(), agent_id.clone()),
        AgentOperation {
            operation_id: uuid::Uuid::new_v4().to_string(),
            agent_id: agent_id.clone(),
            name: actor
                .name
                .as_ref()
                .unwrap_or(agent_id)
                .chars()
                .take(64)
                .collect(),
            status: status.into(),
            revision,
            collaboration_epoch: epoch,
            updated_at_epoch_ms: now,
            total_targets,
            targets: targets.into_iter().take(MAX_TARGETS).collect(),
        },
    );
}

pub(super) async fn result(
    state: &ServerState,
    id: &str,
    actor: &Claims,
    status: &str,
    revision: u64,
    epoch: u64,
    operations: Option<&Value>,
) {
    let Some(agent_id) = &actor.sub else {
        return;
    };
    if let Some(ops) = operations.and_then(Value::as_array) {
        record(
            state,
            id,
            actor,
            status,
            revision,
            epoch,
            open(state, id)
                .map(|bundle| patch_targets(&bundle, ops))
                .unwrap_or_else(|_| from_operations(ops)),
        )
        .await;
    } else if let Some(op) = state
        .agent_operations
        .lock()
        .await
        .get_mut(&(id.into(), agent_id.clone()))
    {
        // Cancellation/rejection must never relabel an earlier successful commit.
        if matches!(op.status.as_str(), "pending" | "editing") {
            op.status = status.into();
            op.revision = revision;
            op.collaboration_epoch = epoch;
            op.updated_at_epoch_ms = agent_now();
        }
    }
}

pub(super) async fn stop(state: &ServerState, id: &str, agent: &str, status: &str) {
    let mut store = state.agent_operations.lock().await;
    if let Some(op) = store.get_mut(&(id.into(), agent.into())) {
        if matches!(op.status.as_str(), "pending" | "editing") {
            op.status = if status == "cancelled" {
                "cancelled"
            } else {
                "rejected"
            }
            .into();
            op.updated_at_epoch_ms = agent_now();
        }
    }
    drop(store);
    if status != "completed" {
        state.agents.lock().await.remove(&(id.into(), agent.into()));
    }
}

pub(super) async fn list(
    state: &ServerState,
    id: &str,
    epoch: u64,
    revision: u64,
) -> Vec<AgentOperation> {
    let now = agent_now();
    let mut store = state.agent_operations.lock().await;
    store.retain(|_, op| now.saturating_sub(op.updated_at_epoch_ms) < 60_000);
    for ((doc, _), op) in store.iter_mut() {
        if doc == id && matches!(op.status.as_str(), "pending" | "editing") {
            if op.collaboration_epoch != epoch || op.revision != revision {
                op.status = "conflict".into();
            } else if now.saturating_sub(op.updated_at_epoch_ms) > 15_000 {
                let alive = state
                    .agents
                    .lock()
                    .await
                    .get(&(doc.clone(), op.agent_id.clone()))
                    .is_some_and(|a| now.saturating_sub(a.updated_at_epoch_ms) < 15_000);
                if !alive {
                    op.status = "expired".into();
                }
            }
        }
    }
    let mut items: Vec<_> = store
        .iter()
        .filter(|((doc, _), _)| doc == id)
        .map(|(_, op)| op.clone())
        .collect();
    items.sort_by(|a, b| {
        b.updated_at_epoch_ms
            .cmp(&a.updated_at_epoch_ms)
            .then_with(|| a.agent_id.cmp(&b.agent_id))
    });
    items
}
