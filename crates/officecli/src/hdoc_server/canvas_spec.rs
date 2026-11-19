//! Sentence grants pin Unicode offsets to a historical revision. Presence uses
//! Yjs positions; the undo endpoint accepts only the identity of a saved edit.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use canvas_core::{spec::SpecCursor, Batch, Operation};

pub(super) fn valid_cursor(c: &SpecCursor) -> bool {
    !c.id.is_empty()
        && c.id.len() <= 256
        && [&c.anchor, &c.head]
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 128 && STANDARD.decode(p.as_bytes()).is_ok())
}
pub(super) async fn authorize_marker(
    state: &ServerState,
    id: &str,
    headers: &HeaderMap,
) -> Result<(), ApiError> {
    if let Some(decision) = integration::access(state, headers, id).await? {
        if !decision.constraints.selection_agent {
            decision.require(&["document.ai"])?;
        }
        decision.require(&["document.view", "document.edit"])?;
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Sentence {
    id: String,
    block: usize,
    start: usize,
    end: usize,
    expected: String,
    anchor: String,
    head: String,
    revision: u64,
    collaboration_epoch: u64,
}
pub(super) fn target(input: Option<&Value>) -> Result<Option<Sentence>, ApiError> {
    input
        .and_then(|v| v.get("specSentence"))
        .map(|v| serde_json::from_value(v.clone()).map_err(bad))
        .transpose()
}
impl Sentence {
    pub(super) fn cursor(&self) -> SpecCursor {
        SpecCursor {
            id: self.id.clone(),
            anchor: self.anchor.clone(),
            head: self.head.clone(),
        }
    }
    pub(super) fn validate(&self, bundle: &Bundle, epoch: u64) -> Result<SpecCursor, ApiError> {
        let head = bundle.manifest().map_err(hcd_error)?.revision;
        if self.revision > head
            || head - self.revision > 10_000
            || self.collaboration_epoch != epoch
            || !valid_cursor(&self.cursor())
            || self.end <= self.start
            || self.end - self.start > 8000
        {
            return Err(bad("无效的 Spec 文字选区。"));
        }
        let scene = hcd_core::canvas::read_scene(bundle, Some(self.revision)).map_err(hcd_error)?;
        let el = scene
            .elements
            .iter()
            .find(|e| {
                e["id"] == self.id
                    && canvas_core::spec::is_spec(e)
                    && e["isDeleted"] != true
                    && e["locked"] != true
            })
            .ok_or_else(|| bad("Spec 正文已不可用。"))?;
        let line = if let Some(lines) = el["customData"]["officeSpec"]["blocks"].as_array() {
            lines.get(self.block).and_then(Value::as_str)
        } else {
            el["originalText"]
                .as_str()
                .or_else(|| el["text"].as_str())
                .and_then(|s| s.split('\n').nth(self.block))
        };
        if self.expected.chars().count() != self.end - self.start
            || !line.is_some_and(|s| {
                s.chars()
                    .skip(self.start)
                    .take(self.end - self.start)
                    .eq(self.expected.chars())
            })
        {
            return Err(bad("选中的原句与文件不匹配。"));
        }
        canvas_core::spec::cursor_for_selection(el, self.block, self.start, self.end).map_err(bad)
    }
    pub(super) fn guard(&self, batch: &Batch, epoch: u64) -> Result<(), ApiError> {
        if self.collaboration_epoch == epoch
            && self.revision == batch.base_revision
            && matches!(batch.operations.as_slice(),
            [Operation::SpecSplice {id,block,start,end,expected,..}] if *id==self.id && *block==self.block && *start==self.start && *end==self.end && *expected==self.expected)
        {
            return Ok(());
        }
        Err(ApiError(
            StatusCode::FORBIDDEN,
            "此任务只允许改写原来选中的一句话。".into(),
        ))
    }
}

pub(super) fn announce_run(
    state: ServerState,
    doc: String,
    run_id: String,
    agent_id: String,
    name: String,
    cursor: Option<SpecCursor>,
    point: Option<(f64, f64)>,
) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(3));
        loop {
            tick.tick().await;
            let runs = state.agent_runs.lock().await;
            let Some(run) = runs.get(&run_id) else { break };
            let active =
                run.status == "running" && !run.cancelled.load(std::sync::atomic::Ordering::SeqCst);
            let committed = !run.committed_revisions.is_empty();
            drop(runs);
            if committed {
                break;
            } // The commit carries the replacement range.
            let _ = canvas::room(&state, &doc).await.send(json!({"type":"presence", "actorKind":"agent","actorId":agent_id,"name":name,"agentPhase":"idle","specCursor":if active {cursor.as_ref()} else {None},"pointer":point.map(|(x,y)|json!({"x":x,"y":y})),"specSeq":agent_now()}));
            if !active {
                break;
            }
        }
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct UndoRequest {
    revision: u64,
    id: String,
}
pub(super) async fn undo(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<UndoRequest>,
) -> Result<Json<Value>, ApiError> {
    let actor = canvas::access(&state, &id, &headers, true).await?;
    let _lock = state.collaboration_lock.lock().await;
    check_collaboration_epoch(&state, &id, &headers).await?;
    let bundle = open(&state, &id)?;
    let record = bundle.revision(request.revision).map_err(hcd_error)?;
    let receipt = record
        .canvas_rewrite
        .ok_or_else(|| bad("此修订不是独立的 AI 改写。"))?;
    if actor.sub.as_ref() != Some(&receipt.owner)
        || receipt.cursor.id != request.id
        || actor.worker_generation.is_some()
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "仅可撤销自己发起的这次改写。".into(),
        ));
    }
    if receipt.epoch != collaboration_epoch(&state, &id).await? {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "文件已恢复为其他版本。".into(),
        ));
    }
    let update = hcd_core::canvas::rewrite_inverse(&bundle, &receipt).map_err(hcd_error)?;
    let batch = Batch {
        schema_version: canvas_core::PROTOCOL.into(),
        document_id: id.clone(),
        base_revision: request.revision,
        patch_id: format!("spec-undo-{}", request.revision),
        operations: vec![Operation::SpecUpdate {
            id: request.id,
            update,
        }],
        vacant_regions: vec![],
    };
    let result = canvas::patch_locked(&state, &id, &headers, &actor, batch).await?;
    Ok(Json(serde_json::to_value(result).map_err(internal)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sentence_grant_does_not_authorize_another_occurrence_or_a_wider_edit() {
        let grant: Sentence=serde_json::from_value(json!({"id":"body","block":1,"start":5,"end":7,"expected":"原文","revision":4,"collaborationEpoch":1,"anchor":"AA==","head":"AQ=="})).unwrap();
        let op = json!({"op":"spec.splice","id":"body","block":1,"start":5,"end":7,"expected":"原文","insert":"新文"});
        let batch = |ops: Vec<Value>, revision: u64| {
            serde_json::from_value::<Batch>(json!({"schemaVersion":canvas_core::PROTOCOL,"documentId":"doc","baseRevision":revision,"patchId":"rewrite","operations":ops})).unwrap()
        };
        assert!(grant.guard(&batch(vec![op.clone()], 4), 1).is_ok());
        assert!(grant.guard(&batch(vec![op.clone()], 5), 1).is_err());
        assert!(grant.guard(&batch(vec![op.clone()], 4), 2).is_err());
        let mut other = op.clone();
        other["start"] = json!(0);
        other["end"] = json!(2);
        assert!(grant.guard(&batch(vec![other.clone()], 4), 1).is_err());
        assert!(grant.guard(&batch(vec![op, other], 4), 1).is_err());
    }
}
