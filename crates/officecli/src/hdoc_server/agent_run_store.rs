//! Private task checkpoints. Public Run serialization deliberately omits owner,
//! resource mappings and lease tokens; those belong only in this local store.
use super::*;
use agent_runs::Run;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::ops::{Deref, DerefMut};
use std::sync::atomic::Ordering;

const SCHEMA: &str = "hcd-agent-checkpoint/1";
const MAX_CHECKPOINT_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Default)]
pub(super) struct RunStore {
    inner: Arc<Mutex<HashMap<String, Run>>>,
    disk: Option<Arc<Disk>>,
}

struct Disk {
    directory: PathBuf,
    // An OS lock is released on process death. A second API must not recover
    // these leases while the previous process still has live workers.
    _process_lock: std::fs::File,
    hashes: std::sync::Mutex<HashMap<String, Vec<u8>>>,
    failed: std::sync::Mutex<bool>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Checkpoint {
    schema_version: String,
    run: Run,
    owner: String,
    cancelled: bool,
    team: Option<agent_team::TeamCheckpoint>,
    #[serde(default)]
    invocation: Option<agent_execution::Invocation>,
}

impl From<HashMap<String, Run>> for RunStore {
    fn from(runs: HashMap<String, Run>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(runs)),
            disk: None,
        }
    }
}

impl RunStore {
    pub(super) fn acquire_root(root: &std::path::Path) -> Result<std::fs::File> {
        let process_lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join(".officecli-agent-runs.lock"))?;
        process_lock.try_lock().map_err(|_| anyhow!("this HCD root already has a running API; task recovery requires its previous process to exit"))?;
        Ok(process_lock)
    }

    #[cfg(test)]
    pub(super) fn open(root: &std::path::Path) -> Result<Self> {
        Self::recover(root, Self::acquire_root(root)?)
    }

    pub(super) fn recover(root: &std::path::Path, process_lock: std::fs::File) -> Result<Self> {
        let directory = root.join("agent-runs");
        std::fs::create_dir_all(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
        }
        let disk = Arc::new(Disk {
            directory,
            _process_lock: process_lock,
            hashes: Default::default(),
            failed: Default::default(),
        });
        let mut paths = std::fs::read_dir(&disk.directory)?
            .map(|entry| {
                let entry = entry?;
                Ok((entry.metadata()?.modified()?, entry.path()))
            })
            .collect::<std::io::Result<Vec<_>>>()?;
        paths.retain(|(_, path)| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        });
        paths.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
        let mut runs = HashMap::new();
        // Older checkpoints remain on disk. The interactive store is bounded
        // to the newest 128 tasks, matching the existing in-memory limit.
        for (_, path) in paths.into_iter().take(128) {
            if std::fs::metadata(&path)?.len() > MAX_CHECKPOINT_BYTES {
                return Err(anyhow!(
                    "Agent checkpoint exceeds 32 MiB: {}",
                    path.display()
                ));
            }
            let checkpoint: Checkpoint = serde_json::from_slice(&std::fs::read(&path)?)
                .with_context(|| format!("invalid Agent checkpoint: {}", path.display()))?;
            if checkpoint.schema_version != SCHEMA
                || !valid_id(&checkpoint.run.document_id)
                || uuid::Uuid::parse_str(&checkpoint.run.run_id).is_err()
                || path.file_stem().and_then(|s| s.to_str()) != Some(&checkpoint.run.run_id)
                || checkpoint.owner.is_empty()
            {
                return Err(anyhow!(
                    "invalid Agent checkpoint identity: {}",
                    path.display()
                ));
            }
            let mut run = checkpoint.run;
            run.invocation = checkpoint.invocation;
            run.owner = checkpoint.owner;
            run.cancelled.store(checkpoint.cancelled, Ordering::SeqCst);
            run.team = checkpoint
                .team
                .map(agent_team::Team::from_checkpoint)
                .transpose()?;
            if matches!(run.status.as_str(), "running" | "cancelling") {
                run.status = "interrupted".into();
                run.cancelled.store(true, Ordering::SeqCst);
                run.result = "服务已重启，任务已中断；已提交修改保留。请核对执行记录和剩余工作，再明确授权续跑，避免重复计算或修改。".into();
                run.updated_at_epoch_ms = agent_now();
                if run.events.len() >= 512 {
                    run.events.remove(0);
                }
                run.events.push(
                    json!({"type":"interrupted","reason":"service_restart","at":agent_now()}),
                );
                if let Some(team) = &mut run.team {
                    team.interrupt();
                }
            }
            // A process may die after a document commit but before its task
            // receipt. Reconcile from immutable author-tagged revisions.
            reconcile_receipts(root, &mut run)?;
            runs.insert(run.run_id.clone(), run);
        }
        disk.save(&runs)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(runs)),
            disk: Some(disk),
        })
    }

    pub(super) async fn lock(&self) -> RunGuard<'_> {
        RunGuard {
            guard: self.inner.lock().await,
            disk: self.disk.as_deref(),
            changed: false,
        }
    }

    pub(super) fn ensure_healthy(&self) -> Result<(), ApiError> {
        if self
            .disk
            .as_ref()
            .is_some_and(|disk| *disk.failed.lock().unwrap_or_else(|e| e.into_inner()))
        {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "Agent 任务记录保存失败，已停止后续写入。请检查服务存储后重新启动。".into(),
            ));
        }
        Ok(())
    }
}

fn reconcile_receipts(root: &std::path::Path, run: &mut Run) -> Result<()> {
    let bundle_path = root.join(format!("{}.hcd", run.document_id));
    if !bundle_path.try_exists()? {
        return Ok(());
    }
    let bundle = Bundle::open(&bundle_path)?;
    let head = bundle.manifest()?.revision;
    // Task UUIDs identify authors exactly; never infer another user's commit
    // from a matching title, timestamp or approximate revision number.
    for revision in (head.saturating_sub(10_000)..=head).rev() {
        let record = bundle.revision(revision)?;
        let matches_intent = record.author_id.is_none()
            && run.events.iter().any(|event| {
                event["type"] == "tool"
                    && event["name"] == "hcd_patch"
                    && event["patchId"]
                        .as_str()
                        .is_some_and(|id| record.patch_id.as_deref() == Some(id))
                    && event["expectedRevision"].as_u64() == record.patch_base_revision
                    && record.created_at_epoch_ms >= run.created_at_epoch_ms as u128
            });
        if matches_intent
            || record.author_id.as_deref().is_some_and(|author| {
                author == run.agent_id
                    || author
                        .strip_prefix(&run.agent_id)
                        .is_some_and(|suffix| suffix.starts_with('-'))
            })
        {
            run.committed_revisions.push(record.revision);
        }
        if record.created_at_epoch_ms < run.created_at_epoch_ms.saturating_sub(60_000) as u128 {
            break;
        }
    }
    run.committed_revisions.sort_unstable();
    run.committed_revisions.dedup();
    Ok(())
}

impl Disk {
    fn save(&self, runs: &HashMap<String, Run>) -> Result<()> {
        let mut hashes = self.hashes.lock().unwrap_or_else(|e| e.into_inner());
        for (id, run) in runs {
            let mut public_run = run.clone();
            public_run.team = None;
            let checkpoint = Checkpoint {
                schema_version: SCHEMA.into(),
                run: public_run,
                owner: run.owner.clone(),
                cancelled: run.cancelled.load(Ordering::SeqCst),
                team: run.team.as_ref().map(agent_team::Team::checkpoint),
                invocation: run.invocation.clone(),
            };
            let bytes = serde_json::to_vec(&checkpoint)?;
            if bytes.len() as u64 > MAX_CHECKPOINT_BYTES {
                return Err(anyhow!("Agent checkpoint exceeds 32 MiB"));
            }
            let hash = Sha256::digest(&bytes).to_vec();
            if hashes.get(id) == Some(&hash) {
                continue;
            }
            let mut temporary = tempfile::NamedTempFile::new_in(&self.directory)?;
            temporary.write_all(&bytes)?;
            temporary.as_file().sync_all()?;
            temporary.persist(self.directory.join(format!("{id}.json")))?;
            #[cfg(unix)]
            std::fs::File::open(&self.directory)?.sync_all()?;
            hashes.insert(id.clone(), hash);
        }
        Ok(())
    }
}

pub(super) struct RunGuard<'a> {
    guard: tokio::sync::MutexGuard<'a, HashMap<String, Run>>,
    disk: Option<&'a Disk>,
    changed: bool,
}
impl Deref for RunGuard<'_> {
    type Target = HashMap<String, Run>;
    fn deref(&self) -> &Self::Target {
        &self.guard
    }
}
impl DerefMut for RunGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.changed = true;
        &mut self.guard
    }
}
impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        if !self.changed {
            return;
        }
        if let Some(disk) = self.disk {
            if let Err(error) = disk.save(&self.guard) {
                *disk.failed.lock().unwrap_or_else(|e| e.into_inner()) = true;
                for run in self.guard.values() {
                    run.cancelled.store(true, Ordering::SeqCst);
                }
                tracing::error!("Agent checkpoint failed; workers fenced: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(id: &str) -> Run {
        let mut run: Run = serde_json::from_value(json!({
            "runId":id,"documentId":"recovery-doc","agentId":format!("agent-{id}"),"name":"Recovery",
            "task":"update a paragraph","status":"running","model":"test-model","createdAtEpochMs":agent_now(),
            "updatedAtEpochMs":agent_now(),"events":[],"result":"","committedRevisions":[],"agentCount":1,"mode":"edit","team":null
        })).unwrap();
        run.owner = "authenticated-owner".into();
        run
    }

    #[tokio::test]
    async fn durable_runs_are_exclusive_restore_interrupted_and_keep_private_owner_out_of_public_json(
    ) {
        let root = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let store = RunStore::open(root.path()).unwrap();
        store.lock().await.insert(id.clone(), run(&id));
        assert!(store.ensure_healthy().is_ok());
        assert!(
            RunStore::open(root.path()).is_err(),
            "a live API must fence a second process"
        );
        drop(store);
        let restored = RunStore::open(root.path()).unwrap();
        {
            let guard = restored.lock().await;
            let run = &guard[&id];
            assert_eq!(run.status, "interrupted");
            assert!(run.cancelled.load(Ordering::SeqCst));
            assert_eq!(run.owner, "authenticated-owner");
            assert_eq!(run.events.last().unwrap()["reason"], "service_restart");
            let public = serde_json::to_string(run).unwrap();
            assert!(!public.contains("authenticated-owner"));
            assert!(!public.contains("cancelled"));
        }
        drop(restored);
        let again = RunStore::open(root.path()).unwrap();
        assert_eq!(
            again.lock().await[&id].events.len(),
            1,
            "restart markers must not repeat for inactive tasks"
        );
    }

    #[tokio::test]
    async fn tool_transcripts_recover_privately_with_an_exact_in_flight_cursor() {
        let root = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let store = RunStore::open(root.path()).unwrap();
        let mut task = run(&id);
        let mut invocation = agent_execution::Invocation::default();
        invocation.executions.insert(
            "unit".into(),
            agent_execution::Cursor {
                actor_id: Some("member".into()),
                input: vec![json!({"role":"user","content":"private-document-content"})],
                output: vec![json!({"name":"hcd_patch","call_id":"exact-call","arguments":"{}"})],
                current_call: Some("exact-call".into()),
                step: 9,
                ..Default::default()
            },
        );
        task.invocation = Some(invocation);
        store.lock().await.insert(id.clone(), task);
        let public = serde_json::to_string(&store.lock().await[&id]).unwrap();
        assert!(!public.contains("private-document-content"));
        drop(store);
        let restored = RunStore::open(root.path()).unwrap();
        let runs = restored.lock().await;
        let cursor = &runs[&id].invocation.as_ref().unwrap().executions["unit"];
        assert_eq!(cursor.current_call.as_deref(), Some("exact-call"));
        assert_eq!(cursor.step, 9);
        assert_eq!(cursor.next_item, 0);
        assert_eq!(cursor.input[0]["content"], "private-document-content");
    }

    #[tokio::test]
    async fn a_checkpoint_write_failure_cancels_workers_and_never_claims_durable_success() {
        let root = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let store = RunStore::open(root.path()).unwrap();
        let path = root.path().join("agent-runs").join(format!("{id}.json"));
        std::fs::create_dir(&path).unwrap();
        store.lock().await.insert(id.clone(), run(&id));
        assert_eq!(
            store.ensure_healthy().unwrap_err().0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert!(store.lock().await[&id].cancelled.load(Ordering::SeqCst));
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, "{broken").unwrap();
        drop(store);
        assert!(
            RunStore::open(root.path()).is_err(),
            "corrupt task state must not silently reset to an empty store"
        );
    }

    #[tokio::test]
    async fn restart_reconciles_a_commit_without_a_receipt_or_author_stamp_from_its_durable_intent()
    {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.txt");
        std::fs::write(&source, "Original paragraph.\n").unwrap();
        hcd_formats::import_document(
            &source,
            root.path().join("recovery-doc.hcd"),
            &hcd_formats::ImportOptions::new("recovery-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(root.path().join("recovery-doc.hcd")).unwrap();
        project_editor(&bundle, 0).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let patch_id = uuid::Uuid::new_v4().to_string();
        let store = RunStore::open(root.path()).unwrap();
        let mut task = run(&id);
        let before = bundle.manifest().unwrap().revision;
        task.events.push(
            json!({"type":"tool","name":"hcd_patch","patchId":patch_id,"expectedRevision":before}),
        );
        store.lock().await.insert(id.clone(), task);
        let projection = editor_projection(&bundle, None).unwrap();
        let block = &projection.blocks[0];
        let patch = serde_json::from_value(json!({"schemaVersion":"hcd-patch/4","documentId":"recovery-doc","patchId":patch_id,"baseRevision":before,
            "operations":[{"op":"block.replace","blockId":block.block_id,"block":{"kind":"paragraph","inlines":[{"text":"Committed before crash."}]},"precondition":{"blockHash":block.block_hash}}]})).unwrap();
        let committed = apply_structure_patch(&bundle, &patch, before).unwrap();
        assert!(bundle
            .revision(committed.revision)
            .unwrap()
            .author_id
            .is_none());
        // Deliberately omit updating the task receipt, like a process dying
        // between the document commit and the harness result callback.
        drop(store);
        let restored = RunStore::open(root.path()).unwrap();
        assert_eq!(
            restored.lock().await[&id].committed_revisions,
            vec![committed.revision]
        );
    }
}
