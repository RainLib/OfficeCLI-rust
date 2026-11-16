//! Explicit, owner-scoped continuation of a durable execution, never a replay
//! of the original user prompt. The review is invalidated by any document,
//! task, protocol, model or process change before authorization.
use super::*;
use std::sync::atomic::AtomicBool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    fingerprint: String,
    expected_revision: u64,
    collaboration_epoch: u64,
    authorize_remaining: bool,
}

fn owned(
    run: Option<&agent_runs::Run>,
    id: &str,
    actor: &Claims,
) -> Result<agent_runs::Run, ApiError> {
    run.filter(|run| run.document_id == id && Some(&run.owner) == actor.sub.as_ref())
        .cloned()
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Agent task not found".into()))
}

fn blocker(run: &agent_runs::Run) -> Option<&'static str> {
    if !matches!(run.status.as_str(), "interrupted" | "failed" | "cancelled") {
        return Some("只有已停止的未完成任务可以核对续跑。");
    }
    let Some(invocation) = &run.invocation else {
        return Some("旧任务没有保存完整执行位置，请根据已提交修订单独规划剩余工作。");
    };
    if invocation.attempt >= 16 {
        return Some("此任务已达到 16 次续跑限制，请核对修订后规划剩余工作。");
    }
    // These independent-image writes do not yet have a durable call receipt.
    // A lost response must never be guessed or repeated automatically.
    for cursor in invocation.executions.values() {
        if let Some(call) = cursor
            .output
            .get(cursor.next_item)
            .filter(|_| cursor.current_call.is_some())
        {
            if call["name"] == "hcd_image_edit" {
                let args: Value = serde_json::from_str(call["arguments"].as_str().unwrap_or("{}"))
                    .unwrap_or(Value::Null);
                if !matches!(
                    args["action"].as_str(),
                    Some("info" | "content" | "jobs" | "cancel")
                ) {
                    return Some(
                        "图片操作的返回结果不确定，请先核对候选或已提交修订，不能自动重放这一步。",
                    );
                }
            }
        }
    }
    None
}

fn receipts(
    bundle: &Bundle,
    run: &agent_runs::Run,
) -> Result<(Vec<u64>, Option<String>), ApiError> {
    let mut revisions = run.committed_revisions.clone();
    let mut deck_error = None;
    if let Some(invocation) = &run.invocation {
        for cursor in invocation.executions.values() {
            if let Some(call) = cursor.output.get(cursor.next_item).filter(|call| {
                call["name"] == "hcd_patch"
                    && call["call_id"].as_str() == cursor.current_call.as_deref()
            }) {
                let args = serde_json::from_str(
                    call["arguments"]
                        .as_str()
                        .ok_or_else(|| bad("保存的修改缺少参数"))?,
                )
                .map_err(bad)?;
                let author = cursor
                    .actor_id
                    .as_deref()
                    .ok_or_else(|| bad("保存的修改缺少执行身份"))?;
                if let Some(receipt) = agent_execution::committed_patch(bundle, &args, author)? {
                    if let Some(revision) = receipt["revision"].as_u64() {
                        revisions.push(revision);
                    }
                }
            }
        }
        if let Some(deck) = &invocation.deck {
            for prepared in deck.patches.iter().skip(deck.next) {
                let author = prepared["agentId"]
                    .as_str()
                    .ok_or_else(|| bad("保存的新稿缺少执行身份"))?;
                if let Some(receipt) =
                    agent_execution::committed_patch(bundle, &prepared["args"], author)?
                {
                    if let Some(revision) = receipt["revision"].as_u64() {
                        revisions.push(revision);
                    }
                } else {
                    if prepared["args"]["expected_revision"].as_u64()
                        != Some(bundle.manifest().map_err(hcd_error)?.revision)
                    {
                        deck_error=Some("新稿分批提交期间文档已被其他操作更新；不能直接续用原替换队列，请核对保留的部分与人工修改后重新规划。".into());
                    }
                    break;
                }
            }
        }
    }
    revisions.sort_unstable();
    revisions.dedup();
    Ok((revisions, deck_error))
}

fn shifted_grid(bundle: &Bundle, run: &agent_runs::Run) -> Result<Option<String>, ApiError> {
    let manifest = bundle.manifest().map_err(hcd_error)?;
    if manifest.source.format != "xlsx" {
        return Ok(None);
    }
    let Some(invocation) = &run.invocation else {
        return Ok(None);
    };
    if manifest.revision.saturating_sub(invocation.base_revision) > 10_000 {
        return Ok(Some(
            "任务开始后的修订过多，请核对当前工作表并重新规划剩余工作。".into(),
        ));
    }
    for number in invocation.base_revision.saturating_add(1)..=manifest.revision {
        let revision = bundle.revision(number).map_err(hcd_error)?;
        if !revision.grid_row_insertions.is_empty()
            || !revision.grid_row_deletions.is_empty()
            || !revision.grid_column_insertions.is_empty()
            || !revision.grid_column_deletions.is_empty()
            || !revision.sheet_renames.is_empty()
            || !revision.sheet_additions.is_empty()
            || !revision.sheet_removals.is_empty()
        {
            return Ok(Some("任务开始后工作表的行列或工作表结构已变化；原位置/分工可能已改变，请核对已提交内容并重新规划剩余工作。".into()));
        }
    }
    Ok(None)
}

pub(super) async fn snapshot(
    state: &ServerState,
    id: &str,
    run: &agent_runs::Run,
) -> Result<Value, ApiError> {
    state.agent_runs.ensure_healthy()?;
    let bundle = open(state, id)?;
    let manifest = bundle.manifest().map_err(hcd_error)?;
    let (committed, receipt_error) = match receipts(&bundle, run) {
        Ok(summary) => summary,
        Err(error) => (run.committed_revisions.clone(), Some(error.1)),
    };
    let epoch = collaboration_epoch(state, id).await?;
    let config = agent_runs::Config::load();
    let reason = receipt_error
        .or(shifted_grid(&bundle, run)?)
        .or_else(|| blocker(run).map(str::to_string))
        .or_else(|| config.as_ref().err().map(|e| e.1.clone()));
    let model = config.as_ref().ok().map(|c| c.model.as_str());
    let fingerprint=hcd_core::hash_bytes(&serde_json::to_vec(&json!({
        "runId":run.run_id,"status":run.status,"updatedAt":run.updated_at_epoch_ms,"invocation":run.invocation,
        "team":run.team.as_ref().map(agent_team::Team::checkpoint),"receipts":run.committed_revisions,
        "manifest":manifest,"epoch":epoch,"model":model,"imageModel":image_jobs::model(),
        "protocol":crate::capabilities::fingerprint(),"process":state.worker_generation.as_ref(),
    })).map_err(internal)?);
    let team = serde_json::to_value(&run.team).map_err(internal)?;
    let units:Vec<_>=team["units"].as_array().into_iter().flatten().map(|unit|json!({"unitId":unit["unitId"],"title":unit["title"],"status":unit["status"],"agentId":unit["agentId"]})).collect();
    let executions = run
        .invocation
        .as_ref()
        .map(|i| i.executions.len())
        .unwrap_or(0);
    let finished = run
        .invocation
        .as_ref()
        .map(|i| i.executions.values().filter(|c| c.finished).count())
        .unwrap_or(0);
    let deck = run
        .invocation
        .as_ref()
        .and_then(|i| i.deck.as_ref())
        .map(|d| json!({"applied":d.next,"total":d.patches.len()}));
    let mut message =
        "保留已提交内容、原分工和共享发现；重新领取剩余区域的工作锁，继续保存的工具步骤。"
            .to_string();
    if run.invocation.as_ref().is_some_and(|i| {
        i.generate_images
            || i.executions.values().any(|c| {
                c.input
                    .iter()
                    .chain(&c.output)
                    .any(|item| item["name"] == "hcd_generate_image")
            })
    }) {
        message.push_str("中断的图片请求可能重新生成并产生费用。");
    }
    Ok(
        json!({"protocolVersion":crate::capabilities::AGENT_CONTINUATION_PROTOCOL,"runId":run.run_id,"canContinue":reason.is_none(),"reason":reason,"fingerprint":fingerprint,
        "revision":manifest.revision,"collaborationEpoch":epoch,"model":model,"previousModel":run.model,
        "committedRevisions":committed,"units":units,"savedExecutions":executions,"finishedExecutions":finished,"deck":deck,
        "message":message}),
    )
}

pub(super) async fn review(
    State(state): State<ServerState>,
    Path((id, run_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let actor = claims(&state, &headers, &id)?;
    let _guard = state.collaboration_lock.lock().await;
    let run = owned(state.agent_runs.lock().await.get(&run_id), &id, &actor)?;
    Ok(Json(snapshot(&state, &id, &run).await?))
}

pub(super) async fn resume(
    State(state): State<ServerState>,
    Path((id, run_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(request): Json<Request>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    resume_authorized(
        State(state),
        Path((id, run_id)),
        headers,
        Json(request),
        false,
    )
    .await
}

pub(super) async fn resume_authorized(
    State(state): State<ServerState>,
    Path((id, run_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(request): Json<Request>,
    workflow_authorized: bool,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let actor = write_claims(&state, &headers, &id)?;
    if actor.worker_generation.is_some() {
        return Err(bad("委派的 Agent 不能为自己授权续跑。"));
    }
    if !request.authorize_remaining {
        return Err(bad("需要明确授权剩余工作。"));
    }
    let config = agent_runs::Config::load()?;
    let response = {
        let _guard = state.collaboration_lock.lock().await;
        let run = owned(state.agent_runs.lock().await.get(&run_id), &id, &actor)?;
        if run.workflow_id.is_some() && !workflow_authorized {
            return Err(bad(
                "此任务属于跨文档工作流，请核对并授权整个工作流后继续。",
            ));
        }
        let reviewed = snapshot(&state, &id, &run).await?;
        if reviewed["fingerprint"] != request.fingerprint
            || reviewed["revision"] != request.expected_revision
            || reviewed["collaborationEpoch"] != request.collaboration_epoch
        {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "文档、任务或服务配置已变化，请重新核对剩余工作后再继续。".into(),
            ));
        }
        if reviewed["canContinue"] != true {
            return Err(ApiError(
                StatusCode::CONFLICT,
                reviewed["reason"].as_str().unwrap_or("任务不能续跑").into(),
            ));
        }
        let mut runs = state.agent_runs.lock().await;
        let current = owned(runs.get(&run_id), &id, &actor)?;
        if current.updated_at_epoch_ms != run.updated_at_epoch_ms || current.status != run.status {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "任务已变化，请重新核对。".into(),
            ));
        }
        if runs
            .values()
            .filter(|r| matches!(r.status.as_str(), "running" | "cancelling"))
            .map(|r| r.agent_count)
            .sum::<usize>()
            + run.agent_count
            > 4
        {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "最多同时运行 4 个 Agent，请稍后重新核对。".into(),
            ));
        }
        let run = runs.get_mut(&run_id).unwrap();
        run.invocation.as_mut().unwrap().attempt += 1;
        run.cancelled = Arc::new(AtomicBool::new(false));
        if let Some(team) = &mut run.team {
            team.interrupt();
        }
        run.status = "running".into();
        run.result.clear();
        run.model = config.model.clone();
        run.updated_at_epoch_ms = agent_now();
        if run.events.len() >= 512 {
            run.events.remove(0);
        }
        run.events.push(json!({"type":"continuation_authorized","attempt":run.invocation.as_ref().unwrap().attempt,"revision":request.expected_revision,"at":agent_now()}));
        serde_json::to_value(run).map_err(internal)?
    };
    state.agent_runs.ensure_healthy()?;
    agent_runs::launch(state, &actor, &run_id, config).await?;
    Ok((StatusCode::ACCEPTED, Json(response)))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run() -> agent_runs::Run {
        serde_json::from_value(json!({"runId":"r","documentId":"d","agentId":"a","name":"Agent","task":"x2","status":"interrupted","model":"test","createdAtEpochMs":0,"updatedAtEpochMs":0,"events":[],"result":"","committedRevisions":[],"agentCount":1,"mode":"edit","team":null})).unwrap()
    }
    #[test]
    fn cell_changes_allow_continuation_but_shifted_grid_addresses_require_a_new_plan() {
        let root = tempfile::tempdir().unwrap();
        let source =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/showcase/gradebook.xlsx");
        hcd_formats::import_document(
            &source,
            root.path().join("guard-grid.hcd"),
            &hcd_formats::ImportOptions::new("guard-grid"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(root.path().join("guard-grid.hcd")).unwrap();
        let mut task = run();
        task.invocation = Some(Default::default());
        let columns = spreadsheet::columns(&bundle).unwrap();
        let col = columns
            .iter()
            .find(|column| column.content["column"] == 3)
            .unwrap();
        let cell = col.content["cells"]
            .as_array()
            .unwrap()
            .iter()
            .find(|cell| cell["numberEditable"] == true)
            .unwrap();
        let patch=serde_json::from_value(json!({"schemaVersion":"hcd-patch/29","documentId":"guard-grid","patchId":"numeric","baseRevision":0,"operations":[{"op":"xlsx.number.set","sheetId":col.content["sheetId"],"nodeId":cell["nodeId"],"value":"100","precondition":{"nodeHash":cell["nodeHash"]}}]})).unwrap();
        apply_patch(&bundle, &patch, 0).unwrap();
        assert!(shifted_grid(&bundle, &task).unwrap().is_none());
        let patch=serde_json::from_value(json!({"schemaVersion":"hcd-patch/13","documentId":"guard-grid","patchId":"column-shift","baseRevision":1,"operations":[{"op":"xlsx.column.insert","sheetId":col.content["sheetId"],"beforeColumn":3}]})).unwrap();
        apply_patch(&bundle, &patch, 1).unwrap();
        assert!(shifted_grid(&bundle, &task)
            .unwrap()
            .unwrap()
            .contains("行列"));
        task.invocation.as_mut().unwrap().base_revision = 2;
        assert!(
            shifted_grid(&bundle, &task).unwrap().is_none(),
            "a new task may start after earlier structural edits"
        );
    }

    #[test]
    fn legacy_and_uncertain_image_writes_cannot_be_replayed() {
        let mut task = run();
        assert!(blocker(&task).unwrap().contains("旧任务"));
        task.invocation = Some(Default::default());
        assert!(blocker(&task).is_none());
        task.status = "running".into();
        assert!(blocker(&task).is_some());
        task.status = "interrupted".into();
        let cursor = agent_execution::Cursor {
            current_call: Some("call".into()),
            output: vec![json!({"name":"hcd_image_edit","arguments":"{\"action\":\"inpaint\"}"})],
            ..Default::default()
        };
        task.invocation
            .as_mut()
            .unwrap()
            .executions
            .insert("cursor".into(), cursor);
        assert!(blocker(&task).unwrap().contains("返回结果不确定"));
        task.invocation
            .as_mut()
            .unwrap()
            .executions
            .get_mut("cursor")
            .unwrap()
            .current_call = None;
        assert!(
            blocker(&task).is_none(),
            "an intent not dispatched yet is safe to execute"
        );
    }
}
