//! Durable cross-document coordination. Credentials exist only in a live
//! driver's headers, never in the checkpoint or public workflow JSON.
use super::{agent_workflows::Workflow, *};
use std::io::Write;

const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_WORKFLOWS: usize = 128;

#[derive(Clone, Default)]
pub(super) struct Store {
    pub(super) inner: Arc<Mutex<HashMap<String, Workflow>>>,
    directory: Option<Arc<PathBuf>>,
    failed: Arc<std::sync::atomic::AtomicBool>,
    hashes: Arc<std::sync::Mutex<HashMap<String, String>>>,
}

impl Store {
    pub(super) fn recover(root: &std::path::Path) -> Result<Self> {
        let directory = root.join("agent-workflows");
        std::fs::create_dir_all(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
        }
        let store = Self {
            directory: Some(Arc::new(directory.clone())),
            ..Default::default()
        };
        let mut workflows = HashMap::new();
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            if entry.path().extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            if workflows.len() >= MAX_WORKFLOWS || entry.metadata()?.len() > MAX_BYTES {
                return Err(anyhow!("Agent workflow store exceeds its configured limit"));
            }
            let mut workflow: Workflow = serde_json::from_slice(&std::fs::read(entry.path())?)
                .with_context(|| format!("invalid Agent workflow: {}", entry.path().display()))?;
            workflow.validate_checkpoint()?;
            if entry.path().file_stem().and_then(|s| s.to_str()) != Some(&workflow.workflow_id) {
                return Err(anyhow!("Agent workflow filename/identity mismatch"));
            }
            if matches!(
                workflow.status.as_str(),
                "running" | "stopping" | "compensating"
            ) {
                workflow.status = "interrupted".into();
                workflow.message = "服务已重启；请核对各文档与提交记录后继续或补偿。".into();
                workflow.generation += 1;
                store.save(&workflow).map_err(|e| anyhow!(e.1))?;
            }
            workflows.insert(workflow.workflow_id.clone(), workflow);
        }
        Ok(Self {
            inner: Arc::new(Mutex::new(workflows)),
            ..store
        })
    }

    pub(super) fn healthy(&self) -> Result<(), ApiError> {
        if self.failed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "跨文档任务检查点保存失败，已停止后续写入；请检查存储后重启。".into(),
            ));
        }
        Ok(())
    }

    pub(super) fn save(&self, workflow: &Workflow) -> Result<(), ApiError> {
        self.healthy()?;
        let Some(directory) = &self.directory else {
            return Ok(());
        };
        let result = (|| -> Result<()> {
            let bytes = serde_json::to_vec(workflow)?;
            if bytes.len() as u64 > MAX_BYTES {
                return Err(anyhow!("Agent workflow checkpoint exceeds 8 MiB"));
            }
            let hash = hcd_core::hash_bytes(&bytes);
            let mut hashes = self.hashes.lock().unwrap_or_else(|e| e.into_inner());
            if hashes.get(&workflow.workflow_id) == Some(&hash) {
                return Ok(());
            }
            let mut file = tempfile::NamedTempFile::new_in(directory.as_ref())?;
            file.write_all(&bytes)?;
            file.as_file().sync_all()?;
            file.persist(directory.join(format!("{}.json", workflow.workflow_id)))?;
            #[cfg(unix)]
            std::fs::File::open(directory.as_ref())?.sync_all()?;
            hashes.insert(workflow.workflow_id.clone(), hash);
            Ok(())
        })();
        if let Err(error) = result {
            self.failed.store(true, std::sync::atomic::Ordering::SeqCst);
            tracing::error!("Agent workflow checkpoint failed: {error}");
            self.healthy()?;
        }
        Ok(())
    }

    pub(super) fn capacity(current: usize) -> Result<(), ApiError> {
        if current >= MAX_WORKFLOWS {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "跨文档任务历史已达到 128 项，暂不能新建；历史归档尚待建设。".into(),
            ));
        }
        Ok(())
    }
}
