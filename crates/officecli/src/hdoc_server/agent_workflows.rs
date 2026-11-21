//! A persisted DAG above document-scoped Harness runs. Shared facts are read
//! by the server from declared resources, with immutable provenance. Workers
//! never receive another document's credentials or authority.
use super::*;
use std::collections::BTreeMap;
use std::sync::atomic::Ordering;

pub(super) const PROTOCOL: &str = crate::capabilities::AGENT_WORKFLOW_PROTOCOL;
const GRANTS_HEADER: &str = "x-hcd-document-grants";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Plan {
    name: String,
    documents: Vec<Document>,
    #[serde(default)]
    facts: Vec<Selection>,
    steps: Vec<Step>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    document_id: String,
    access: String,
    expected_revision: u64,
    collaboration_epoch: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    key: String,
    document_id: String,
    resource: String,
    number: Option<u64>,
    node_id: Option<String>,
    pointer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity: Option<SelectionIdentity>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectionIdentity {
    pointer: String,
    value: String,
}

fn valid_pointer(pointer: &str) -> bool {
    pointer.len() <= 512
        && pointer.starts_with('/')
        && !pointer.split('/').skip(1).any(|segment| {
            let bytes = segment.as_bytes();
            bytes
                .iter()
                .enumerate()
                .any(|(i, b)| *b == b'~' && !matches!(bytes.get(i + 1), Some(b'0' | b'1')))
        })
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Step {
    step_id: String,
    document_id: String,
    task: String,
    #[serde(default)]
    depends_on: Vec<String>,
    #[serde(default)]
    consumes: Vec<String>,
    #[serde(default)]
    produces: Vec<Selection>,
    #[serde(default = "one")]
    agent_count: usize,
    #[serde(default = "edit")]
    mode: String,
    #[serde(default)]
    generate_images: bool,
    target: Option<Value>,
}
fn one() -> usize {
    1
}
fn edit() -> String {
    "edit".into()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Position {
    revision: u64,
    root_hash: String,
    epoch: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fact {
    selection: Selection,
    revision: u64,
    root_hash: String,
    value_hash: String,
    value: Value,
    produced_by: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Progress {
    status: String,
    run_id: Option<String>,
    base_revision: Option<u64>,
    result: String,
    committed_revisions: Vec<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Compensation {
    step_id: String,
    document_id: String,
    target_revision: u64,
    expected_revision: Option<u64>,
    expected_epoch: Option<u64>,
    revision: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Workflow {
    protocol_version: String,
    pub(super) workflow_id: String,
    anchor_document_id: String,
    owner: String,
    plan: Plan,
    pub(super) status: String,
    pub(super) message: String,
    pub(super) generation: u64,
    created_at_epoch_ms: u64,
    updated_at_epoch_ms: u64,
    positions: BTreeMap<String, Position>,
    facts: BTreeMap<String, Fact>,
    progress: BTreeMap<String, Progress>,
    completion_order: Vec<String>,
    compensations: Vec<Compensation>,
    stop_status: String,
}

fn conflict(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::CONFLICT, message.into())
}

impl Plan {
    fn validate(&self, anchor: &str) -> Result<Vec<String>, ApiError> {
        if self.name.trim().is_empty()
            || self.name.chars().count() > 120
            || !(2..=16).contains(&self.documents.len())
            || !(1..=32).contains(&self.steps.len())
            || serde_json::to_vec(self).map_err(bad)?.len() > 256 * 1024
        {
            return Err(bad(
                "工作流需要名称、2–16 份文档和 1–32 个步骤；计划上限 256 KiB。",
            ));
        }
        let mut documents = HashMap::new();
        for doc in &self.documents {
            if !valid_id(&doc.document_id)
                || !matches!(doc.access.as_str(), "read" | "write")
                || documents
                    .insert(doc.document_id.as_str(), doc.access.as_str())
                    .is_some()
            {
                return Err(bad("工作流文档 ID、权限或重复声明无效。"));
            }
        }
        if !documents.contains_key(anchor) {
            return Err(bad("协调文档必须包含在计划中。"));
        }
        let mut steps = HashMap::new();
        for step in &self.steps {
            if !valid_id(&step.step_id)
                || steps.insert(step.step_id.as_str(), step).is_some()
                || documents.get(step.document_id.as_str()) != Some(&"write")
                || step.task.trim().is_empty()
                || step.task.chars().count() > 4000
                || !(1..=4).contains(&step.agent_count)
                || !matches!(step.mode.as_str(), "edit" | "rebuild")
                || serde_json::to_vec(&step.target).map_err(bad)?.len() > 16_384
                || step
                    .target
                    .as_ref()
                    .is_some_and(|target| !target.is_object())
                || step.depends_on.len() > 32
                || step.consumes.len() > 64
            {
                return Err(bad("工作流步骤、写权限、任务长度或 Agent 数量无效。"));
            }
        }
        let mut order: Vec<String> = Vec::new();
        let mut ancestors: HashMap<&str, HashSet<&str>> = HashMap::new();
        while order.len() < steps.len() {
            let next = self.steps.iter().find(|step| {
                !ancestors.contains_key(step.step_id.as_str())
                    && step
                        .depends_on
                        .iter()
                        .all(|dep| ancestors.contains_key(dep.as_str()))
            });
            let Some(step) = next else {
                return Err(bad("步骤依赖存在环或引用未知步骤。"));
            };
            let mut seen = HashSet::new();
            let mut all = HashSet::new();
            for dep in &step.depends_on {
                if !seen.insert(dep) {
                    return Err(bad("步骤依赖不能重复。"));
                }
                all.insert(dep.as_str());
                all.extend(ancestors[dep.as_str()].iter().copied());
            }
            ancestors.insert(&step.step_id, all);
            order.push(step.step_id.clone());
        }
        for (i, a) in self.steps.iter().enumerate() {
            for b in self.steps.iter().skip(i + 1) {
                if a.document_id == b.document_id
                    && !ancestors[a.step_id.as_str()].contains(b.step_id.as_str())
                    && !ancestors[b.step_id.as_str()].contains(a.step_id.as_str())
                {
                    return Err(bad(
                        "同一文档的步骤必须用依赖明确排序，不能并发认领整份文档。",
                    ));
                }
            }
        }
        let mut facts: HashMap<&str, Option<&str>> = HashMap::new();
        for (selection, producer) in self.facts.iter().map(|s| (s, None)).chain(
            self.steps
                .iter()
                .flat_map(|s| s.produces.iter().map(move |f| (f, Some(s)))),
        ) {
            if !valid_id(&selection.key)
                || !documents.contains_key(selection.document_id.as_str())
                || producer.is_some_and(|step| selection.document_id != step.document_id)
                || !matches!(
                    selection.resource.as_str(),
                    "manifest" | "editor" | "sheet" | "index" | "chunk" | "node"
                )
                || !valid_pointer(&selection.pointer)
                || selection.identity.as_ref().is_some_and(|identity| {
                    !valid_pointer(&identity.pointer)
                        || identity.value.is_empty()
                        || identity.value.len() > 512
                })
                || matches!(selection.resource.as_str(), "sheet" | "index" | "chunk")
                    && selection.number.is_none()
                || selection.resource == "node" && selection.node_id.is_none()
                || facts
                    .insert(&selection.key, producer.map(|s| s.step_id.as_str()))
                    .is_some()
            {
                return Err(bad("共享事实需要唯一名称、有效读取位置及 JSON Pointer；产出必须来自当前步骤的文档。"));
            }
        }
        if facts.len() > 64 {
            return Err(bad("每个工作流最多声明 64 个共享事实。"));
        }
        for step in &self.steps {
            let mut seen = HashSet::new();
            for key in &step.consumes {
                if !seen.insert(key) {
                    return Err(bad("消费的事实不能重复。"));
                }
                match facts.get(key.as_str()) {
                    Some(None) => {}
                    Some(Some(producer)) if ancestors[step.step_id.as_str()].contains(producer) => {
                    }
                    _ => return Err(bad("消费的事实必须来自初始快照或依赖祖先的已验证产出。")),
                }
            }
        }
        Ok(order)
    }
}

impl Workflow {
    pub(super) fn validate_checkpoint(&self) -> Result<()> {
        self.plan
            .validate(&self.anchor_document_id)
            .map_err(|e| anyhow!(e.1))?;
        if self.protocol_version != PROTOCOL
            || uuid::Uuid::parse_str(&self.workflow_id).is_err()
            || self.owner.is_empty()
            || self.positions.len() != self.plan.documents.len()
            || self.progress.len() != self.plan.steps.len()
            || self
                .plan
                .documents
                .iter()
                .any(|doc| !self.positions.contains_key(&doc.document_id))
            || self
                .plan
                .steps
                .iter()
                .any(|step| !self.progress.contains_key(&step.step_id))
            || self.progress.values().any(|p| {
                p.run_id
                    .as_ref()
                    .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
            })
        {
            return Err(anyhow!("invalid Agent workflow checkpoint identity"));
        }
        Ok(())
    }

    fn public(&self) -> Result<Value, ApiError> {
        let mut value = serde_json::to_value(self).map_err(internal)?;
        value.as_object_mut().unwrap().remove("owner");
        Ok(value)
    }
}

type Grants = HashMap<String, HeaderMap>;

fn principal(actor: &Claims) -> Result<&str, ApiError> {
    if actor.worker_generation.is_some() || actor.integration_session.is_some() {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "委派 worker 和宿主会话不能创建或授权跨文档工作流。".into(),
        ));
    }
    actor
        .sub
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| bad("工作流需要签名用户身份。"))
}

fn grants(
    state: &ServerState,
    anchor: &str,
    headers: &HeaderMap,
    plan: &Plan,
) -> Result<(String, Grants), ApiError> {
    use base64::Engine;
    let actor = claims(state, headers, anchor)?;
    let owner = principal(&actor)?.to_string();
    let additional: HashMap<String, String> = match headers.get(GRANTS_HEADER) {
        None => HashMap::new(),
        Some(raw) => {
            if raw.len() > 65_536 {
                return Err(bad("文档授权头超出 64 KiB。"));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(raw.as_bytes())
                .map_err(|_| bad("文档授权头必须为 Base64 JSON。"))?;
            serde_json::from_slice(&bytes).map_err(|_| bad("文档授权头格式无效。"))?
        }
    };
    if additional
        .keys()
        .any(|id| !plan.documents.iter().any(|doc| &doc.document_id == id))
    {
        return Err(bad("授权头包含计划以外的文档。"));
    }
    let mut grants = HashMap::new();
    for doc in &plan.documents {
        let mut document_headers = HeaderMap::new();
        let authorization = if doc.document_id == anchor {
            headers
                .get(header::AUTHORIZATION)
                .cloned()
                .ok_or_else(|| bad("bearer token required"))?
        } else {
            let token = additional.get(&doc.document_id).ok_or_else(|| {
                ApiError(
                    StatusCode::FORBIDDEN,
                    "缺少计划中某份文档的独立授权。".into(),
                )
            })?;
            format!("Bearer {token}")
                .parse()
                .map_err(|_| bad("无效的文档授权。"))?
        };
        document_headers.insert(header::AUTHORIZATION, authorization);
        let actor = claims(state, &document_headers, &doc.document_id)?;
        if principal(&actor)? != owner || doc.access == "write" && actor.scope != "write" {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "所有文档授权必须属于同一用户，且满足声明的读写权限。".into(),
            ));
        }
        let manifest = open(state, &doc.document_id)?
            .manifest()
            .map_err(hcd_error)?;
        if !matches!(
            manifest.source.format.as_str(),
            "docx" | "xlsx" | "pptx" | "pdf" | "html" | "md" | "txt"
        ) {
            return Err(bad("此工作流使用文档 Harness；独立图片文档尚未接入。"));
        }
        grants.insert(doc.document_id.clone(), document_headers);
    }
    Ok((owner, grants))
}

async fn position(state: &ServerState, id: &str) -> Result<Position, ApiError> {
    let manifest = open(state, id)?.manifest().map_err(hcd_error)?;
    Ok(Position {
        revision: manifest.revision,
        root_hash: manifest.root_hash,
        epoch: collaboration_epoch(state, id).await?,
    })
}

async fn extract(
    state: &ServerState,
    selection: &Selection,
    grant: &HeaderMap,
    producer: Option<String>,
) -> Result<Fact, ApiError> {
    let before = position(state, &selection.document_id).await?;
    let data = agent_tools::call(state.clone(), selection.document_id.clone(), grant.clone(), "hcd_read", json!({
        "document_id":selection.document_id,"resource":selection.resource,"number":selection.number,"node_id":selection.node_id
    })).await?;
    if let Some(identity) = &selection.identity {
        if data.pointer(&identity.pointer).and_then(Value::as_str) != Some(identity.value.as_str())
        {
            return Err(conflict(format!(
                "共享内容 {} 的段落或单元格位置已变化，请重新选择；不会读取该位置的其他内容。",
                selection.key
            )));
        }
    }
    let value = data
        .pointer(&selection.pointer)
        .ok_or_else(|| bad(format!("共享事实 {} 的读取位置不存在。", selection.key)))?
        .clone();
    if let Some((prefix, _)) = selection.pointer.split_once("/calculation/") {
        if data
            .pointer(&format!("{prefix}/calculation/status"))
            .and_then(Value::as_str)
            != Some("calculated")
        {
            return Err(conflict("不能把未核验的公式缓存发布为已计算事实。"));
        }
    }
    let bytes = serde_json::to_vec(&value).map_err(internal)?;
    if bytes.len() > 8192 {
        return Err(bad("单条共享事实超过 8 KiB，请选择更精确的读取位置。"));
    }
    let after = position(state, &selection.document_id).await?;
    if before.revision != after.revision
        || before.root_hash != after.root_hash
        || before.epoch != after.epoch
    {
        return Err(conflict("读取共享事实期间文档已变化。"));
    }
    Ok(Fact {
        selection: selection.clone(),
        revision: after.revision,
        root_hash: after.root_hash,
        value_hash: hcd_core::hash_bytes(&bytes),
        value,
        produced_by: producer,
    })
}

fn owned<'a>(
    all: &'a HashMap<String, Workflow>,
    anchor: &str,
    workflow_id: &str,
    owner: &str,
) -> Result<&'a Workflow, ApiError> {
    all.get(workflow_id)
        .filter(|w| w.anchor_document_id == anchor && w.owner == owner)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "跨文档工作流不存在。".into()))
}

pub(super) async fn create(
    State(state): State<ServerState>,
    Path(anchor): Path<String>,
    headers: HeaderMap,
    Json(plan): Json<Plan>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    plan.validate(&anchor)?;
    let (owner, grants) = grants(&state, &anchor, &headers, &plan)?;
    let _content = state.collaboration_lock.lock().await;
    let mut all = state.agent_workflows.inner.lock().await;
    state.agent_workflows.healthy()?;
    agent_workflow_store::Store::capacity(all.len())?;
    let mut positions = BTreeMap::new();
    for doc in &plan.documents {
        let current = position(&state, &doc.document_id).await?;
        if current.revision != doc.expected_revision || current.epoch != doc.collaboration_epoch {
            return Err(conflict(
                "创建计划时文档修订或协同 epoch 已变化，请重新读取。",
            ));
        }
        positions.insert(doc.document_id.clone(), current);
    }
    let mut facts = BTreeMap::new();
    for selection in &plan.facts {
        facts.insert(
            selection.key.clone(),
            extract(&state, selection, &grants[&selection.document_id], None).await?,
        );
    }
    let now = agent_now();
    let workflow = Workflow {
        protocol_version: PROTOCOL.into(),
        workflow_id: uuid::Uuid::new_v4().to_string(),
        anchor_document_id: anchor,
        owner,
        status: "ready".into(),
        message: "计划已保存；核对后执行。".into(),
        generation: 0,
        created_at_epoch_ms: now,
        updated_at_epoch_ms: now,
        progress: plan
            .steps
            .iter()
            .map(|s| {
                (
                    s.step_id.clone(),
                    Progress {
                        status: "pending".into(),
                        ..Default::default()
                    },
                )
            })
            .collect(),
        plan,
        positions,
        facts,
        completion_order: vec![],
        compensations: vec![],
        stop_status: "failed".into(),
    };
    state.agent_workflows.save(&workflow)?;
    let response = workflow.public()?;
    all.insert(workflow.workflow_id.clone(), workflow);
    Ok((StatusCode::CREATED, Json(response)))
}

pub(super) async fn list(
    State(state): State<ServerState>,
    Path(anchor): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let actor = claims(&state, &headers, &anchor)?;
    let owner = principal(&actor)?;
    state.agent_workflows.healthy()?;
    let all = state.agent_workflows.inner.lock().await;
    let summaries: Vec<_> = all.values().filter(|w| w.anchor_document_id == anchor && w.owner == owner)
        .map(|w| json!({"workflowId":w.workflow_id,"status":w.status,"updatedAtEpochMs":w.updated_at_epoch_ms})).collect();
    Ok(Json(
        json!({"protocolVersion":PROTOCOL,"workflows":summaries}),
    ))
}

pub(super) async fn read(
    State(state): State<ServerState>,
    Path((anchor, workflow_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let actor = claims(&state, &headers, &anchor)?;
    let all = state.agent_workflows.inner.lock().await;
    let workflow = owned(&all, &anchor, &workflow_id, principal(&actor)?)?;
    grants(&state, &anchor, &headers, &workflow.plan)?;
    state.agent_workflows.healthy()?;
    Ok(Json(workflow.public()?))
}

/// Every new write is checked while holding collaboration_lock. The ledger
/// accepts only the declared child runs, not arbitrary edits by the same user.
async fn verify_positions(
    state: &ServerState,
    workflow: &Workflow,
) -> Result<BTreeMap<String, Position>, ApiError> {
    let mut current = BTreeMap::new();
    for doc in &workflow.plan.documents {
        let id = &doc.document_id;
        let now = position(state, id).await?;
        let mut pending_headers = HeaderMap::new();
        pending_headers.insert(
            "x-hcd-collaboration-epoch",
            now.epoch.to_string().parse().map_err(bad)?,
        );
        require_clean_collaboration(state, id, &pending_headers).await?;
        let previous = &workflow.positions[id];
        if now.revision < previous.revision
            || now.revision.saturating_sub(previous.revision) > 10_000
        {
            return Err(conflict("文档修订跨度异常，请核对后重新规划。"));
        }
        if now.revision == previous.revision {
            if now.root_hash != previous.root_hash || now.epoch != previous.epoch {
                return Err(conflict(format!(
                    "文档 {id} 的内容或协同房间已被其他操作更新。"
                )));
            }
        } else {
            let bundle = open(state, id)?;
            for number in previous.revision + 1..=now.revision {
                let record = bundle.revision(number).map_err(hcd_error)?;
                let mut ours = workflow
                    .plan
                    .steps
                    .iter()
                    .filter(|s| &s.document_id == id)
                    .any(|step| {
                        workflow.progress[&step.step_id]
                            .run_id
                            .as_ref()
                            .is_some_and(|run_id| {
                                let prefix = format!("agent-{run_id}");
                                record.author_id.as_deref().is_some_and(|author| {
                                    author == prefix || author.starts_with(&format!("{prefix}-"))
                                })
                            })
                    });
                if !ours && record.author_id.is_none() {
                    // A crash can happen after commit and before its author
                    // stamp. Accept only a canonical patch from this child's
                    // persisted model output, never a similar title or value.
                    let runs = state.agent_runs.lock().await;
                    for step in workflow.plan.steps.iter().filter(|s| &s.document_id == id) {
                        if let Some(invocation) = workflow.progress[&step.step_id]
                            .run_id
                            .as_ref()
                            .and_then(|run_id| runs.get(run_id))
                            .and_then(|r| r.invocation.as_ref())
                        {
                            for cursor in invocation.executions.values() {
                                if let Some(actor) = &cursor.actor_id {
                                    for call in
                                        cursor.input.iter().chain(&cursor.output).filter(|item| {
                                            item["type"] == "function_call"
                                                && item["name"] == "hcd_patch"
                                        })
                                    {
                                        let args: Value = serde_json::from_str(
                                            call["arguments"]
                                                .as_str()
                                                .ok_or_else(|| bad("保存的修改缺少参数。"))?,
                                        )
                                        .map_err(bad)?;
                                        if args["expected_revision"].as_u64() == Some(number - 1)
                                            && agent_execution::committed_patch(
                                                &bundle, &args, actor,
                                            )?
                                            .is_some_and(|r| r["revision"] == number)
                                        {
                                            ours = true;
                                        }
                                    }
                                }
                            }
                            if let Some(deck) = &invocation.deck {
                                for prepared in &deck.patches {
                                    if prepared["args"]["expected_revision"].as_u64()
                                        == Some(number - 1)
                                    {
                                        if let Some(actor) = prepared["agentId"].as_str() {
                                            if agent_execution::committed_patch(
                                                &bundle,
                                                &prepared["args"],
                                                actor,
                                            )?
                                            .is_some_and(|r| r["revision"] == number)
                                            {
                                                ours = true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                let compensating = workflow.compensations.iter().any(|c| {
                    &c.document_id == id
                        && c.expected_revision == Some(number - 1)
                        && record.patch_id.as_deref()
                            == Some(format!("restore-{}-{number}", c.target_revision).as_str())
                        && record.patch_hash.as_deref()
                            == Some(
                                hcd_core::hash_bytes(
                                    format!("restore:{}:{}", c.target_revision, number - 1)
                                        .as_bytes(),
                                )
                                .as_str(),
                            )
                        && record.root_hash
                            == bundle
                                .revision(c.target_revision)
                                .map(|r| r.root_hash)
                                .unwrap_or_default()
                        && record
                            .author_id
                            .as_deref()
                            .is_none_or(|author| author == workflow.owner)
                });
                if !ours && !compensating {
                    return Err(conflict(format!(
                        "文档 {id} 含有工作流以外的修订 {number}，已停止；不会覆盖人工修改。"
                    )));
                }
            }
            if now.epoch < previous.epoch
                || now.epoch - previous.epoch > now.revision - previous.revision
            {
                return Err(conflict("协同房间变化与任务提交不符，请重新核对。"));
            }
        }
        current.insert(id.clone(), now);
    }
    Ok(current)
}

fn verify_facts(
    workflow: &Workflow,
    step: &Step,
    positions: &BTreeMap<String, Position>,
) -> Result<(), ApiError> {
    for key in &step.consumes {
        let fact = workflow
            .facts
            .get(key)
            .ok_or_else(|| conflict(format!("依赖事实 {key} 尚未生成。")))?;
        let head = &positions[&fact.selection.document_id];
        let own_write = fact.selection.document_id == step.document_id
            && workflow.progress[&step.step_id].base_revision == Some(fact.revision);
        if !own_write && (fact.revision != head.revision || fact.root_hash != head.root_hash) {
            return Err(conflict(format!(
                "共享事实 {key} 的来源已更新，必须重新读取并规划，不能使用旧值。"
            )));
        }
    }
    Ok(())
}

pub(super) async fn guard_write(
    state: &ServerState,
    id: &str,
    actor: &Claims,
) -> Result<(), ApiError> {
    state.agent_workflows.healthy()?;
    let all = state.agent_workflows.inner.lock().await;
    for workflow in all.values() {
        for step in workflow.plan.steps.iter().filter(|s| s.document_id == id) {
            if workflow.progress[&step.step_id]
                .run_id
                .as_ref()
                .is_some_and(|run_id| {
                    let prefix = format!("agent-{run_id}");
                    actor.sub.as_deref().is_some_and(|author| {
                        author == prefix || author.starts_with(&format!("{prefix}-"))
                    })
                })
            {
                if workflow.status != "running" {
                    return Err(conflict("跨文档工作流已停止，此 worker 不再拥有写入权。"));
                }
                let positions = verify_positions(state, workflow).await?;
                verify_facts(workflow, step, &positions)?;
                return Ok(());
            }
        }
    }
    Ok(())
}

async fn review_value(state: &ServerState, workflow: &Workflow) -> Result<Value, ApiError> {
    state.agent_workflows.healthy()?;
    let position_check = verify_positions(state, workflow).await;
    let mut children = BTreeMap::new();
    let runs = state.agent_runs.lock().await;
    let mut reason = position_check.as_ref().err().map(|e| e.1.clone());
    let mut live = false;
    for (step_id, progress) in &workflow.progress {
        if let Some(run_id) = &progress.run_id {
            if let Some(run) = runs.get(run_id) {
                live |= matches!(run.status.as_str(), "running" | "cancelling");
                if matches!(run.status.as_str(), "interrupted" | "failed" | "cancelled") {
                    let child = agent_continuation::snapshot(state, &run.document_id, run).await?;
                    if child["canContinue"] != true && reason.is_none() {
                        reason = Some(format!(
                            "步骤 {step_id}：{}",
                            child["reason"].as_str().unwrap_or("不能续跑")
                        ));
                    }
                    children.insert(step_id.clone(), child);
                }
            } else if !matches!(progress.status.as_str(), "completed" | "starting")
                && reason.is_none()
            {
                reason = Some(format!(
                    "步骤 {step_id} 的私有执行记录不在当前任务列表，请核对历史；不能重发原任务。"
                ));
            }
        }
    }
    let inactive = !matches!(
        workflow.status.as_str(),
        "running" | "stopping" | "compensating" | "compensated"
    ) && !live;
    let mut actual = BTreeMap::new();
    for doc in &workflow.plan.documents {
        actual.insert(
            doc.document_id.clone(),
            position(state, &doc.document_id).await?,
        );
    }
    if let Ok(positions) = &position_check {
        for step in &workflow.plan.steps {
            if workflow.progress[&step.step_id].status != "completed"
                && step.consumes.iter().all(|k| workflow.facts.contains_key(k))
            {
                if let Err(error) = verify_facts(workflow, step, positions) {
                    reason.get_or_insert(error.1);
                }
            }
        }
    }
    let compensation_reason = position_check.as_ref().err().map(|e| e.1.clone());
    let has_writes = workflow.progress.iter().any(|(step_id, p)| {
        let doc = &workflow
            .plan
            .steps
            .iter()
            .find(|s| &s.step_id == step_id)
            .unwrap()
            .document_id;
        p.base_revision
            .is_some_and(|base| actual[doc].revision > base)
    });
    let config = agent_runs::Config::load();
    if config.is_err() && reason.is_none() {
        reason = Some("尚未配置模型，不能执行剩余步骤。".into());
    }
    let fingerprint = hcd_core::hash_bytes(&serde_json::to_vec(&json!({
        "workflow":workflow,"positions":actual,"children":children,"process":state.worker_generation.as_ref(),
        "protocol":crate::capabilities::fingerprint(),"model":config.ok().map(|c|c.model),"imageModel":image_jobs::model()
    })).map_err(internal)?);
    Ok(
        json!({"protocolVersion":PROTOCOL,"workflow":workflow.public()?,"positions":actual,
        "children":children,"fingerprint":fingerprint,
        "canContinue":inactive && reason.is_none() && workflow.compensations.is_empty() && workflow.status!="completed",
        "continueReason":reason,"canCompensate":inactive && has_writes && compensation_reason.is_none(),
        "compensationReason":compensation_reason,
        "message":"只共享声明的事实及来源修订；继续会保留已完成步骤。补偿按逆序创建新修订，不删除历史；存在人工或其他任务修订时停止，不覆盖它们。图片请求在明确重试时可能再次计费。"}),
    )
}

pub(super) async fn review(
    State(state): State<ServerState>,
    Path((anchor, workflow_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let actor = claims(&state, &headers, &anchor)?;
    let _content = state.collaboration_lock.lock().await;
    let all = state.agent_workflows.inner.lock().await;
    let workflow = owned(&all, &anchor, &workflow_id, principal(&actor)?)?;
    grants(&state, &anchor, &headers, &workflow.plan)?;
    Ok(Json(review_value(&state, workflow).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Action {
    action: String,
    fingerprint: String,
    authorize: bool,
}

pub(super) async fn execute(
    State(state): State<ServerState>,
    Path((anchor, workflow_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(request): Json<Action>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if !request.authorize || !matches!(request.action.as_str(), "continue" | "compensate") {
        return Err(bad("需要明确授权继续或补偿。"));
    }
    let actor = claims(&state, &headers, &anchor)?;
    let generation;
    let response;
    let driver_grants;
    {
        let _content = state.collaboration_lock.lock().await;
        let mut all = state.agent_workflows.inner.lock().await;
        let mut workflow = owned(&all, &anchor, &workflow_id, principal(&actor)?)?.clone();
        driver_grants = grants(&state, &anchor, &headers, &workflow.plan)?.1;
        let reviewed = review_value(&state, &workflow).await?;
        if reviewed["fingerprint"] != request.fingerprint {
            return Err(conflict("工作流、文档或服务已变化，请重新核对。"));
        }
        let allowed = if request.action == "continue" {
            "canContinue"
        } else {
            "canCompensate"
        };
        if reviewed[allowed] != true {
            return Err(conflict("当前状态不能执行此操作，请查看核对摘要。"));
        }
        if workflow.generation >= 32 {
            return Err(conflict("工作流已达到 32 轮授权限制，请核对后建立新计划。"));
        }
        workflow.generation += 1;
        generation = workflow.generation;
        workflow.status = if request.action == "continue" {
            "running"
        } else {
            "compensating"
        }
        .into();
        workflow.message.clear();
        workflow.stop_status = "failed".into();
        workflow.updated_at_epoch_ms = agent_now();
        workflow.positions = verify_positions(&state, &workflow).await?;
        if request.action == "continue" {
            for progress in workflow.progress.values_mut() {
                if progress.status != "completed" && progress.status != "starting" {
                    progress.status = "resume_pending".into();
                }
            }
        }
        if request.action == "compensate" && workflow.compensations.is_empty() {
            let order = workflow.plan.validate(&workflow.anchor_document_id)?;
            for step_id in order.into_iter().rev() {
                let progress = &workflow.progress[&step_id];
                if let Some(base) = progress.base_revision {
                    let step = workflow
                        .plan
                        .steps
                        .iter()
                        .find(|s| s.step_id == step_id)
                        .unwrap();
                    // Even a failed child can have a valid partial commit.
                    if open(&state, &step.document_id)?
                        .manifest()
                        .map_err(hcd_error)?
                        .revision
                        > base
                    {
                        workflow.compensations.push(Compensation {
                            step_id,
                            document_id: step.document_id.clone(),
                            target_revision: base,
                            expected_revision: None,
                            expected_epoch: None,
                            revision: None,
                        });
                    }
                }
            }
        }
        state.agent_workflows.save(&workflow)?;
        response = workflow.public()?;
        all.insert(workflow_id.clone(), workflow);
    }
    integration::backup::spawn(drive(state, workflow_id, generation, driver_grants));
    Ok((StatusCode::ACCEPTED, Json(response)))
}

pub(super) async fn cancel(
    State(state): State<ServerState>,
    Path((anchor, workflow_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let actor = claims(&state, &headers, &anchor)?;
    let _content = state.collaboration_lock.lock().await;
    let mut all = state.agent_workflows.inner.lock().await;
    let mut workflow = owned(&all, &anchor, &workflow_id, principal(&actor)?)?.clone();
    grants(&state, &anchor, &headers, &workflow.plan)?;
    if workflow.status == "compensating" {
        return Err(conflict("补偿正在提交，需等待当前补偿结果后核对。"));
    }
    if workflow.status == "running" {
        workflow.status = "stopping".into();
        workflow.stop_status = "cancelled".into();
        workflow.message = "已停止后续依赖步骤；保留已提交修改。".into();
        state.agent_workflows.save(&workflow)?;
        all.insert(workflow_id, workflow.clone());
    }
    stop_children(&state, &workflow).await;
    Ok(Json(workflow.public()?))
}

async fn stop_children(state: &ServerState, workflow: &Workflow) {
    let runs = state.agent_runs.lock().await;
    for p in workflow.progress.values() {
        if let Some(run) = p.run_id.as_ref().and_then(|id| runs.get(id)) {
            run.cancelled.store(true, Ordering::SeqCst);
        }
    }
}

async fn fail(state: &ServerState, workflow_id: &str, generation: u64, error: ApiError) {
    let mut all = state.agent_workflows.inner.lock().await;
    if let Some(workflow) = all
        .get_mut(workflow_id)
        .filter(|w| w.generation == generation)
    {
        workflow.status = "stopping".into();
        workflow.stop_status = "failed".into();
        workflow.message = error.1;
        let _ = state.agent_workflows.save(workflow);
        stop_children(state, workflow).await;
    }
}

async fn drive(state: ServerState, workflow_id: String, generation: u64, grants: Grants) {
    loop {
        match tick(&state, &workflow_id, generation, &grants).await {
            Ok(true) => return,
            Ok(false) => {}
            Err(error) => fail(&state, &workflow_id, generation, error).await,
        }
        if state.agent_workflows.healthy().is_err() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

struct ChildState {
    document_id: String,
    status: String,
    result: String,
    committed_revisions: Vec<u64>,
}

async fn child_states(state: &ServerState) -> HashMap<String, ChildState> {
    state
        .agent_runs
        .lock()
        .await
        .iter()
        .map(|(id, run)| {
            (
                id.clone(),
                ChildState {
                    document_id: run.document_id.clone(),
                    status: run.status.clone(),
                    result: run.result.clone(),
                    committed_revisions: run.committed_revisions.clone(),
                },
            )
        })
        .collect()
}

async fn tick(
    state: &ServerState,
    workflow_id: &str,
    generation: u64,
    grants: &Grants,
) -> Result<bool, ApiError> {
    let _content = state.collaboration_lock.lock().await;
    let mut all = state.agent_workflows.inner.lock().await;
    state.agent_workflows.healthy()?;
    let Some(mut workflow) = all
        .get(workflow_id)
        .filter(|w| w.generation == generation)
        .cloned()
    else {
        return Ok(true);
    };
    if !matches!(
        workflow.status.as_str(),
        "running" | "stopping" | "compensating"
    ) {
        return Ok(true);
    }
    let runs = child_states(state).await;
    if workflow.status == "stopping" {
        stop_children(state, &workflow).await;
        if workflow.progress.values().any(|p| {
            p.run_id
                .as_ref()
                .and_then(|id| runs.get(id))
                .is_some_and(|r| matches!(r.status.as_str(), "running" | "cancelling"))
        }) {
            return Ok(false);
        }
        workflow.status = workflow.stop_status.clone();
        state.agent_workflows.save(&workflow)?;
        all.insert(workflow_id.into(), workflow);
        return Ok(true);
    }
    for doc in &workflow.plan.documents {
        let actor = claims(state, &grants[&doc.document_id], &doc.document_id)?;
        if principal(&actor)? != workflow.owner || doc.access == "write" && actor.scope != "write" {
            return Err(conflict("跨文档授权已失效。"));
        }
    }
    let positions = verify_positions(state, &workflow).await?;
    if workflow.status == "compensating" {
        if runs.values().any(|r| {
            workflow
                .plan
                .documents
                .iter()
                .any(|d| d.document_id == r.document_id)
                && matches!(r.status.as_str(), "running" | "cancelling")
        }) {
            return Err(conflict("参与文档还有运行中的任务，不能补偿。"));
        }
        compensate_one(state, &mut workflow, &positions, grants).await?;
        let done = workflow.status == "compensated";
        state.agent_workflows.save(&workflow)?;
        all.insert(workflow_id.into(), workflow);
        return Ok(done);
    }
    for step in &workflow.plan.steps.clone() {
        let p = &workflow.progress[&step.step_id];
        if p.status == "completed" {
            continue;
        }
        if let Some(run_id) = &p.run_id {
            let Some(run) = runs.get(run_id) else {
                if p.status == "starting" {
                    continue;
                }
                return Err(conflict("步骤的执行记录缺失，不能重发任务。"));
            };
            if run.status == "completed" {
                for selection in &step.produces {
                    let fact = extract(
                        state,
                        selection,
                        &grants[&selection.document_id],
                        Some(step.step_id.clone()),
                    )
                    .await?;
                    workflow.facts.insert(selection.key.clone(), fact);
                }
                let progress = workflow.progress.get_mut(&step.step_id).unwrap();
                progress.status = "completed".into();
                progress.result = run.result.clone();
                progress.committed_revisions = run.committed_revisions.clone();
                workflow.completion_order.push(step.step_id.clone());
            } else if matches!(run.status.as_str(), "failed" | "cancelled" | "interrupted") {
                // Only an explicit new workflow authorization may resume it.
                if p.status == "running" {
                    return Err(conflict(format!(
                        "步骤 {} 已停止：{}",
                        step.step_id, run.result
                    )));
                }
            }
        }
    }
    workflow.positions = positions.clone();
    if workflow.progress.values().all(|p| p.status == "completed") {
        workflow.status = "completed".into();
        workflow.message = "所有依赖步骤已完成并回读；各文档独立提交，历史保留。".into();
        state.agent_workflows.save(&workflow)?;
        all.insert(workflow_id.into(), workflow);
        return Ok(true);
    }
    let order = workflow.plan.validate(&workflow.anchor_document_id)?;
    let mut selected = None;
    for key in order {
        let step = workflow
            .plan
            .steps
            .iter()
            .find(|s| s.step_id == key)
            .unwrap();
        let p = &workflow.progress[&key];
        if p.status == "completed"
            || p.run_id
                .as_ref()
                .and_then(|id| runs.get(id))
                .is_some_and(|r| matches!(r.status.as_str(), "running" | "cancelling"))
        {
            continue;
        }
        if step
            .depends_on
            .iter()
            .all(|dep| workflow.progress[dep].status == "completed")
        {
            verify_facts(&workflow, step, &positions)?;
            selected = Some(step.clone());
            break;
        }
    }
    if let Some(step) = selected {
        let existing = workflow.progress[&step.step_id]
            .run_id
            .as_ref()
            .and_then(|id| runs.get(id).map(|_| id))
            .cloned();
        if let Some(run_id) = existing {
            let run = state
                .agent_runs
                .lock()
                .await
                .get(&run_id)
                .cloned()
                .ok_or_else(|| conflict("步骤执行记录已变化，请重新核对。"))?;
            let reviewed = agent_continuation::snapshot(state, &step.document_id, &run).await?;
            if reviewed["canContinue"] != true {
                return Err(conflict(
                    reviewed["reason"]
                        .as_str()
                        .unwrap_or("子任务不能安全续跑。"),
                ));
            }
            // Reserve this round before dropping locks. New writes still pass
            // the workflow guard and the child's exact receipt checks.
            workflow.progress.get_mut(&step.step_id).unwrap().status = "running".into();
            state.agent_workflows.save(&workflow)?;
            all.insert(workflow_id.into(), workflow);
            drop(all);
            drop(_content);
            let request=serde_json::from_value(json!({"fingerprint":reviewed["fingerprint"],"expectedRevision":reviewed["revision"],"collaborationEpoch":reviewed["collaborationEpoch"],"authorizeRemaining":true})).map_err(bad)?;
            let _ = agent_continuation::resume_authorized(
                State(state.clone()),
                Path((step.document_id.clone(), run.run_id)),
                grants[&step.document_id].clone(),
                Json(request),
                true,
            )
            .await?;
            return Ok(false);
        }
        let shared: Vec<_> = step
            .consumes
            .iter()
            .map(|key| &workflow.facts[key])
            .collect();
        let shared = serde_json::to_value(&shared).map_err(internal)?;
        agent_execution::task_with_facts(&step.task, Some(&shared))?;
        let run_id = workflow.progress[&step.step_id]
            .run_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let progress = workflow.progress.get_mut(&step.step_id).unwrap();
        progress.status = "starting".into();
        progress.run_id = Some(run_id.clone());
        progress.base_revision = Some(positions[&step.document_id].revision);
        workflow.updated_at_epoch_ms = agent_now();
        state.agent_workflows.save(&workflow)?;
        all.insert(workflow_id.into(), workflow.clone());
        // The intent and exact child ID are durable before creating the run.
        let request=serde_json::from_value(json!({"task":step.task,"name":format!("{} · {}",workflow.plan.name,step.step_id),"agentCount":step.agent_count,"mode":step.mode,"target":step.target,"generateImages":step.generate_images})).map_err(bad)?;
        match agent_runs::start_identified(
            State(state.clone()),
            Path(step.document_id.clone()),
            grants[&step.document_id].clone(),
            Json(request),
            run_id,
            Some(workflow_id.into()),
            Some(shared),
        )
        .await
        {
            Ok(_) => workflow.progress.get_mut(&step.step_id).unwrap().status = "running".into(),
            Err(error) if error.0 == StatusCode::TOO_MANY_REQUESTS => return Ok(false),
            Err(error) => return Err(error),
        }
    }
    state.agent_workflows.save(&workflow)?;
    all.insert(workflow_id.into(), workflow);
    Ok(false)
}

async fn compensate_one(
    state: &ServerState,
    workflow: &mut Workflow,
    positions: &BTreeMap<String, Position>,
    grants: &Grants,
) -> Result<(), ApiError> {
    let Some(index) = workflow
        .compensations
        .iter()
        .position(|c| c.revision.is_none())
    else {
        workflow.status = "compensated".into();
        workflow.message = "已按逆序创建补偿修订，原任务与修订历史保留。".into();
        return Ok(());
    };
    let id = workflow.compensations[index].document_id.clone();
    let bundle = open(state, &id)?;
    let actor = write_claims(state, &grants[&id], &id)?;
    let mut guarded = grants[&id].clone();
    guarded.insert("x-hcd-agent-edit", "true".parse().unwrap());
    guarded.insert(
        "x-hcd-collaboration-epoch",
        positions[&id].epoch.to_string().parse().map_err(bad)?,
    );
    require_clean_collaboration(state, &id, &guarded).await?;
    let head = positions[&id].revision;
    let item = &mut workflow.compensations[index];
    let expected = *item.expected_revision.get_or_insert(head);
    let expected_epoch = *item.expected_epoch.get_or_insert(positions[&id].epoch);
    let target = item.target_revision;
    let already = if head == expected + 1 {
        let record = bundle.revision(head).map_err(hcd_error)?;
        record.patch_id.as_deref() == Some(format!("restore-{target}-{head}").as_str())
            && record.patch_hash.as_deref()
                == Some(
                    hcd_core::hash_bytes(format!("restore:{target}:{expected}").as_bytes())
                        .as_str(),
                )
            && record.root_hash == bundle.revision(target).map_err(hcd_error)?.root_hash
            && record
                .author_id
                .as_deref()
                .is_none_or(|id| id == workflow.owner)
    } else {
        false
    };
    state.agent_workflows.save(workflow)?;
    let revision = if already {
        head
    } else {
        if head != expected {
            return Err(conflict("补偿提交位置已变化，不能重放。"));
        }
        restore_revision(&bundle, target, expected)
            .map_err(hcd_error)?
            .revision
    };
    stamp_revision_author(&bundle, revision, &actor)?;
    publish_mutation(state, &id, &bundle, expected).await?;
    let epoch = collaboration_epoch(state, &id).await?;
    if epoch == expected_epoch {
        reset_collaboration_locked(state, &id).await?;
    } else if epoch != expected_epoch + 1 {
        return Err(conflict("补偿期间协同房间已变化，请重新核对。"));
    }
    workflow.compensations[index].revision = Some(revision);
    workflow
        .progress
        .get_mut(&workflow.compensations[index].step_id)
        .unwrap()
        .status = "compensated".into();
    workflow
        .positions
        .insert(id.clone(), position(state, &id).await?);
    Ok(())
}

/// Transport dispatch is deliberately absent from the model worker dispatcher.
pub(super) async fn call(
    state: ServerState,
    anchor: String,
    headers: HeaderMap,
    args: Value,
) -> Result<Value, ApiError> {
    if args["document_id"].as_str() != Some(&anchor)
        || args.get("token_env").is_some()
        || args.get("token_envs").is_some()
    {
        return Err(bad(
            "HTTP 工作流使用当前文档会话与传输授权头，不能使用 token_env/token_envs。",
        ));
    }
    let action = args["action"]
        .as_str()
        .ok_or_else(|| bad("action required"))?;
    if action == "create" {
        return create(
            State(state),
            Path(anchor),
            headers,
            Json(serde_json::from_value(args["plan"].clone()).map_err(bad)?),
        )
        .await
        .map(|v| v.1 .0);
    }
    if action == "list" {
        return list(State(state), Path(anchor), headers).await.map(|v| v.0);
    }
    let workflow_id = args["workflow_id"]
        .as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or_else(|| bad("workflow_id required"))?
        .to_string();
    let path = Path((anchor, workflow_id));
    match action {
        "read"=>read(State(state),path,headers).await.map(|v|v.0),
        "review"=>review(State(state),path,headers).await.map(|v|v.0),
        "cancel"=>cancel(State(state),path,headers).await.map(|v|v.0),
        "continue"|"compensate"=>execute(State(state),path,headers,Json(serde_json::from_value(json!({"action":action,"fingerprint":args["fingerprint"],"authorize":args["authorize"]})).map_err(bad)?)).await.map(|v|v.1.0),
        _=>Err(bad("unknown workflow action")),
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{bearer_as, test_state};
    use super::*;
    const SECRET: &[u8] = b"workflow-test-secret-with-32-bytes-minimum";

    fn plan() -> Plan {
        serde_json::from_value(json!({"name":"Workbook to report","documents":[
            {"documentId":"source","access":"read","expectedRevision":1,"collaborationEpoch":0},
            {"documentId":"report","access":"write","expectedRevision":1,"collaborationEpoch":0}],
            "facts":[{"key":"title","documentId":"source","resource":"editor","pointer":"/blocks/0/content/inlines/0/text"}],
            "steps":[{"stepId":"write","documentId":"report","task":"Use the title","consumes":["title"],"produces":[]},
            {"stepId":"review","documentId":"report","task":"Review the report","dependsOn":["write"]}]
        })).unwrap()
    }

    fn setup() -> (tempfile::TempDir, ServerState, HeaderMap) {
        use base64::Engine;
        let root = tempfile::tempdir().unwrap();
        let state = test_state(SECRET, root.path());
        for id in ["source", "report"] {
            let file = root.path().join(format!("{id}.txt"));
            std::fs::write(&file, "Original title.\n").unwrap();
            hcd_formats::import_document(
                &file,
                root.path().join(format!("{id}.hcd")),
                &hcd_formats::ImportOptions::new(id),
                |_| Ok(()),
            )
            .unwrap();
            project_editor(&open(&state, id).unwrap(), 0).unwrap();
        }
        let mut headers = bearer_as(SECRET, "report", "write", Some("owner"), None);
        let source = bearer_as(SECRET, "source", "read", Some("owner"), None);
        let token = source[header::AUTHORIZATION]
            .to_str()
            .unwrap()
            .strip_prefix("Bearer ")
            .unwrap();
        headers.insert(
            GRANTS_HEADER,
            base64::engine::general_purpose::STANDARD
                .encode(serde_json::to_vec(&json!({"source":token})).unwrap())
                .parse()
                .unwrap(),
        );
        (root, state, headers)
    }

    async fn workflow(state: &ServerState, headers: &HeaderMap) -> Workflow {
        let created = create(
            State(state.clone()),
            Path("report".into()),
            headers.clone(),
            Json(plan()),
        )
        .await
        .unwrap()
        .1
         .0;
        state.agent_workflows.inner.lock().await[created["workflowId"].as_str().unwrap()].clone()
    }

    fn mutate(state: &ServerState, id: &str, author: &str, text: &str) -> u64 {
        let bundle = open(state, id).unwrap();
        let projection = editor_projection(&bundle, None).unwrap();
        let b = &projection.blocks[0];
        let patch=serde_json::from_value(json!({"schemaVersion":"hcd-patch/4","documentId":id,"patchId":uuid::Uuid::new_v4().to_string(),"baseRevision":projection.revision,
            "operations":[{"op":"block.replace","blockId":b.block_id,"block":{"kind":"paragraph","inlines":[{"text":text}]},"precondition":{"blockHash":b.block_hash}}]})).unwrap();
        let result = apply_structure_patch(&bundle, &patch, projection.revision).unwrap();
        let actor = Claims {
            doc: id.into(),
            scope: "write".into(),
            sub: Some(author.into()),
            name: None,
            aud: "hcd-core".into(),
            iat: 0,
            exp: usize::MAX,
            worker_generation: None,
            integration_session: None,
        };
        stamp_revision_author(&bundle, result.revision, &actor).unwrap();
        result.revision
    }

    #[test]
    fn dag_rejects_cycles_unknown_producers_and_unordered_same_document_writers() {
        assert_eq!(plan().validate("report").unwrap(), vec!["write", "review"]);
        let mut p = plan();
        p.steps[0].depends_on = vec!["review".into()];
        assert!(p.validate("report").is_err());
        let mut p = plan();
        p.steps[1].depends_on.clear();
        assert!(p.validate("report").is_err());
        let mut p = plan();
        p.steps[0].consumes = vec!["not-published".into()];
        assert!(p.validate("report").is_err());
        let mut p = plan();
        let mut selection = p.facts[0].clone();
        selection.key = "later".into();
        selection.document_id = "report".into();
        p.steps[1].produces.push(selection);
        p.steps[0].consumes = vec!["later".into()];
        assert!(p.validate("report").is_err());
        let mut p = plan();
        p.facts[0].pointer = "/bad~2escape".into();
        assert!(p.validate("report").is_err());
    }

    #[tokio::test]
    async fn shared_identity_preserves_block_edits_and_rejects_shifted_selections() {
        let (_root, state, headers) = setup();
        let source = grants(&state, "report", &headers, &plan()).unwrap().1;
        let projection = editor_projection(&open(&state, "source").unwrap(), None).unwrap();
        let mut selection = plan().facts[0].clone();
        selection.identity = Some(SelectionIdentity {
            pointer: "/blocks/0/blockId".into(),
            value: projection.blocks[0].block_id.clone(),
        });
        let fact = extract(&state, &selection, &source["source"], None)
            .await
            .unwrap();
        assert_eq!(fact.value, "Original title.");
        mutate(&state, "source", "owner", "Updated title.");
        let fact = extract(&state, &selection, &source["source"], Some("write".into()))
            .await
            .unwrap();
        assert_eq!(fact.value, "Updated title.");
        selection.identity.as_mut().unwrap().value = "another-block".into();
        let failure = extract(&state, &selection, &source["source"], None)
            .await
            .err()
            .unwrap();
        assert_eq!(failure.0, StatusCode::CONFLICT);
        assert!(failure.1.contains("位置已变化"));
        selection.identity.as_mut().unwrap().pointer = "/bad~2escape".into();
        let mut invalid = plan();
        invalid.facts[0] = selection;
        assert!(invalid.validate("report").is_err());
    }

    #[tokio::test]
    async fn grants_are_independent_same_principal_and_never_enter_shared_facts_or_checkpoints() {
        let (_root, state, headers) = setup();
        let w = workflow(&state, &headers).await;
        assert_eq!(w.facts["title"].value, "Original title.");
        let public = w.public().unwrap();
        assert!(public.get("owner").is_none());
        let private = serde_json::to_string(&w).unwrap();
        assert!(!private.contains("Bearer"));
        assert!(!private.contains("eyJhbGci"));
        let missing = bearer_as(SECRET, "report", "write", Some("owner"), None);
        assert_eq!(
            grants(&state, "report", &missing, &plan()).err().unwrap().0,
            StatusCode::FORBIDDEN
        );
        let different = bearer_as(SECRET, "report", "write", Some("other-user"), None);
        let mut different = different;
        different.insert(GRANTS_HEADER, headers[GRANTS_HEADER].clone());
        assert_eq!(
            grants(&state, "report", &different, &plan())
                .err()
                .unwrap()
                .0,
            StatusCode::FORBIDDEN
        );
        let mut read_only = bearer_as(SECRET, "report", "read", Some("owner"), None);
        read_only.insert(GRANTS_HEADER, headers[GRANTS_HEADER].clone());
        assert_eq!(
            grants(&state, "report", &read_only, &plan())
                .err()
                .unwrap()
                .0,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn live_source_changes_and_stopped_workflows_fence_child_writes() {
        let (_root, state, headers) = setup();
        let mut w = workflow(&state, &headers).await;
        let run = uuid::Uuid::new_v4().to_string();
        w.status = "running".into();
        w.progress.get_mut("write").unwrap().run_id = Some(run.clone());
        let actor = Claims {
            doc: "report".into(),
            scope: "write".into(),
            sub: Some(format!("agent-{run}")),
            name: None,
            aud: "hcd-core".into(),
            iat: 0,
            exp: usize::MAX,
            worker_generation: Some("fence".into()),
            integration_session: None,
        };
        state
            .agent_workflows
            .inner
            .lock()
            .await
            .insert(w.workflow_id.clone(), w.clone());
        guard_write(&state, "report", &actor).await.unwrap();
        mutate(&state, "source", "human", "Human update.");
        let error = guard_write(&state, "report", &actor).await.unwrap_err();
        assert!(error.1.contains("人工修改"));
        w.status = "cancelled".into();
        state
            .agent_workflows
            .inner
            .lock()
            .await
            .insert(w.workflow_id.clone(), w);
        assert!(guard_write(&state, "report", &actor)
            .await
            .unwrap_err()
            .1
            .contains("已停止"));
        assert_eq!(
            open(&state, "report").unwrap().manifest().unwrap().revision,
            1
        );
    }

    #[tokio::test]
    async fn compensation_reconciles_a_lost_restore_receipt_without_another_revision_or_epoch_reset(
    ) {
        let (_root, state, headers) = setup();
        let mut w = workflow(&state, &headers).await;
        let run = uuid::Uuid::new_v4().to_string();
        w.progress.get_mut("write").unwrap().run_id = Some(run.clone());
        w.progress.get_mut("write").unwrap().base_revision = Some(1);
        mutate(&state, "report", &format!("agent-{run}"), "Agent update.");
        w.positions
            .insert("report".into(), position(&state, "report").await.unwrap());
        w.compensations.push(Compensation {
            step_id: "write".into(),
            document_id: "report".into(),
            target_revision: 1,
            expected_revision: Some(2),
            expected_epoch: Some(0),
            revision: None,
        });
        let bundle = open(&state, "report").unwrap();
        restore_revision(&bundle, 1, 2).unwrap();
        reset_collaboration_locked(&state, "report").await.unwrap();
        let positions = verify_positions(&state, &w).await.unwrap();
        let g = grants(&state, "report", &headers, &w.plan).unwrap().1;
        compensate_one(&state, &mut w, &positions, &g)
            .await
            .unwrap();
        assert_eq!(bundle.manifest().unwrap().revision, 3);
        assert_eq!(collaboration_epoch(&state, "report").await.unwrap(), 1);
        assert_eq!(w.compensations[0].revision, Some(3));
        assert_eq!(
            bundle.revision(3).unwrap().author_id.as_deref(),
            Some("owner")
        );
        assert_eq!(
            editor_projection(&bundle, None).unwrap().blocks[0]
                .content
                .inlines[0]
                .text,
            "Original title."
        );
    }

    #[tokio::test]
    async fn checkpoint_restart_requires_review_and_storage_failure_fences_further_writes() {
        let (root, mut state, headers) = setup();
        let mut w = workflow(&state, &headers).await;
        state.agent_workflows = agent_workflow_store::Store::recover(root.path()).unwrap();
        w.status = "running".into();
        state.agent_workflows.save(&w).unwrap();
        let restored = agent_workflow_store::Store::recover(root.path()).unwrap();
        assert_eq!(
            restored.inner.lock().await[&w.workflow_id].status,
            "interrupted"
        );
        let path = root
            .path()
            .join("agent-workflows")
            .join(format!("{}.json", w.workflow_id));
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        w.generation += 1;
        assert!(restored.save(&w).is_err());
        assert!(restored.healthy().is_err());
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, "{broken").unwrap();
        assert!(agent_workflow_store::Store::recover(root.path()).is_err());
    }
}
