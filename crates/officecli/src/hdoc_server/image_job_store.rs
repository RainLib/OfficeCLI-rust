//! Private image job checkpoints. The API root lock is held by RunStore before
//! these stores are opened. Recovery never restarts a provider request.
use super::*;
use std::io::Write;
use std::ops::{Deref, DerefMut};

const SCHEMA: &str = "hcd-image-jobs/1";
const MAX_BYTES: u64 = 16 * 1024 * 1024;

pub(super) trait JobRecord: Clone {
    fn id(&self) -> &str;
    fn checkpoint(&self) -> Result<Value>;
    fn recover(value: Value, root: &std::path::Path) -> Result<Self>;
    fn fence(&self);
}

#[derive(Clone)]
pub(super) struct JobStore<J: JobRecord> {
    inner: Arc<Mutex<HashMap<String, J>>>,
    disk: Option<Arc<Disk>>,
}

impl<J: JobRecord> Default for JobStore<J> {
    fn default() -> Self {
        Self {
            inner: Default::default(),
            disk: None,
        }
    }
}

struct Disk {
    directory: PathBuf,
    path: PathBuf,
    previous: std::sync::Mutex<Vec<u8>>,
    failed: std::sync::atomic::AtomicBool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    schema_version: String,
    jobs: std::collections::BTreeMap<String, Value>,
}

impl<J: JobRecord> JobStore<J> {
    pub(super) fn recover(root: &std::path::Path, name: &str) -> Result<Self> {
        anyhow::ensure!(
            matches!(name, "generation" | "inpaint"),
            "invalid image store"
        );
        let directory = root.join("image-jobs");
        std::fs::create_dir_all(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
        }
        let disk = Arc::new(Disk {
            path: directory.join(format!("{name}.json")),
            directory,
            previous: Default::default(),
            failed: Default::default(),
        });
        let mut jobs = HashMap::new();
        if disk.path.try_exists()? {
            anyhow::ensure!(
                std::fs::metadata(&disk.path)?.len() <= MAX_BYTES,
                "image checkpoint exceeds 16 MiB"
            );
            let snapshot: Snapshot = serde_json::from_slice(&std::fs::read(&disk.path)?)
                .context("invalid image job checkpoint; the original file has been retained")?;
            anyhow::ensure!(
                snapshot.schema_version == SCHEMA && snapshot.jobs.len() <= 128,
                "invalid image checkpoint schema or job count"
            );
            for (id, value) in snapshot.jobs {
                let job = J::recover(value, root)?;
                anyhow::ensure!(
                    job.id() == id && uuid::Uuid::parse_str(&id).is_ok(),
                    "invalid image job identity"
                );
                jobs.insert(id, job);
            }
        }
        disk.save(&jobs)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(jobs)),
            disk: Some(disk),
        })
    }

    pub(super) async fn lock(&self) -> JobGuard<'_, J> {
        JobGuard {
            guard: self.inner.lock().await,
            disk: self.disk.as_deref(),
            changed: false,
        }
    }

    pub(super) fn ensure_healthy(&self) -> Result<(), ApiError> {
        if self
            .disk
            .as_ref()
            .is_some_and(|disk| disk.failed.load(std::sync::atomic::Ordering::SeqCst))
        {
            return Err(unavailable());
        }
        Ok(())
    }
}

fn unavailable() -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "图片任务记录保存失败，已停止生成和提交；请检查服务存储后重新启动。".into(),
    )
}

impl Disk {
    fn save<J: JobRecord>(&self, jobs: &HashMap<String, J>) -> Result<()> {
        anyhow::ensure!(
            !self.failed.load(std::sync::atomic::Ordering::SeqCst),
            "image job storage is fenced"
        );
        let snapshot = Snapshot {
            schema_version: SCHEMA.into(),
            jobs: jobs
                .iter()
                .map(|(id, job)| Ok((id.clone(), job.checkpoint()?)))
                .collect::<Result<_>>()?,
        };
        let bytes = serde_json::to_vec(&snapshot)?;
        anyhow::ensure!(
            bytes.len() as u64 <= MAX_BYTES && jobs.len() <= 128,
            "image checkpoint budget exceeded"
        );
        let mut previous = self.previous.lock().unwrap_or_else(|e| e.into_inner());
        if *previous == bytes {
            return Ok(());
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&self.directory)?;
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        temporary.persist(&self.path)?;
        #[cfg(unix)]
        std::fs::File::open(&self.directory)?.sync_all()?;
        *previous = bytes;
        Ok(())
    }
}

pub(super) struct JobGuard<'a, J: JobRecord> {
    guard: tokio::sync::MutexGuard<'a, HashMap<String, J>>,
    disk: Option<&'a Disk>,
    changed: bool,
}

impl<J: JobRecord> JobGuard<'_, J> {
    pub(super) fn flush(&mut self) -> Result<(), ApiError> {
        if !self.changed {
            return Ok(());
        }
        self.changed = false;
        if let Some(disk) = self.disk {
            if let Err(error) = disk.save(&self.guard) {
                disk.failed.store(true, std::sync::atomic::Ordering::SeqCst);
                for job in self.guard.values() {
                    job.fence();
                }
                tracing::error!("Image job checkpoint failed; workers fenced: {error}");
                return Err(unavailable());
            }
        }
        Ok(())
    }
}

impl<J: JobRecord> Deref for JobGuard<'_, J> {
    type Target = HashMap<String, J>;
    fn deref(&self) -> &Self::Target {
        &self.guard
    }
}
impl<J: JobRecord> DerefMut for JobGuard<'_, J> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.changed = true;
        &mut self.guard
    }
}
impl<J: JobRecord> Drop for JobGuard<'_, J> {
    fn drop(&mut self) {
        let _ = self.flush();
    }
}
