//! Regional owner fencing for native processes sharing the same local root.
//! The OS lock survives an HTTP request; a checkpoint retains an Arc until its
//! mutation completes. Expiry can never unlock beneath an admitted mutation.
use super::*;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

const TTL_MS: u64 = 15_000;
type OwnerRegistry = Arc<StdMutex<HashMap<(String, u64), Arc<Lease>>>>;
#[derive(Clone, Default)]
pub(super) struct WordOwners {
    inner: OwnerRegistry,
}
pub(super) struct Lease {
    file: File,
    owner_id: String,
    store_id: String,
    lease_id: String,
    deadline: StdMutex<Instant>,
    journal_hash: StdMutex<String>,
    binding_path: PathBuf,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}
impl Lease {
    fn live(&self) -> bool {
        self.deadline
            .lock()
            .is_ok_and(|until| *until > Instant::now())
    }
    fn response(&self, epoch: u64) -> Result<Value, ApiError> {
        let remaining = self
            .deadline
            .lock()
            .map_err(internal)?
            .saturating_duration_since(Instant::now())
            .as_millis();
        Ok(
            json!({"version":1,"epoch":epoch,"ownerId":self.owner_id,"storeId":self.store_id,"leaseId":self.lease_id,"remainingMs":remaining,"journalHash":*self.journal_hash.lock().map_err(internal)?}),
        )
    }
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Action {
    Acquire,
    Renew,
    Release,
    Record,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    version: u32,
    epoch: u64,
    owner_id: String,
    store_id: String,
    action: Action,
    lease_id: Option<String>,
    #[serde(default)]
    journal_hashes: Vec<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreBinding {
    version: u32,
    document_id: String,
    epoch: u64,
    store_id: String,
    #[serde(default = "empty_journal")]
    journal_hash: String,
}
fn empty_journal() -> String {
    "none".into()
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn hex(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn conflict(reason: &str) -> ApiError {
    ApiError(StatusCode::CONFLICT, reason.into())
}
fn open_private(path: &std::path::Path, create: bool) -> Result<File, ApiError> {
    let mut options = OpenOptions::new();
    options.read(true);
    if create {
        options.write(true).create(true).truncate(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(internal)?;
    if !file.metadata().map_err(internal)?.is_file() {
        return Err(internal("invalid Word owner file"));
    }
    Ok(file)
}
fn binding(
    root: &std::path::Path,
    id: &str,
    epoch: u64,
    store_id: &str,
) -> Result<(File, PathBuf, StoreBinding), ApiError> {
    let directory = root.join("collaboration/word-owners");
    std::fs::create_dir_all(&directory).map_err(internal)?;
    for path in [root.join("collaboration"), directory.clone()] {
        let meta = std::fs::symlink_metadata(path).map_err(internal)?;
        if !meta.is_dir() || meta.is_symlink() {
            return Err(internal("invalid Word owner directory"));
        }
    }
    let file = open_private(&directory.join(format!("{id}.{epoch}.lock")), true)?;
    match file.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => return Err(conflict("word-owner-busy")),
        Err(std::fs::TryLockError::Error(error)) => return Err(internal(error)),
    }
    let path = directory.join(format!("{id}.{epoch}.store.json"));
    if !path.try_exists().map_err(internal)? {
        let value = StoreBinding {
            version: 1,
            document_id: id.into(),
            epoch,
            store_id: store_id.into(),
            journal_hash: empty_journal(),
        };
        let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut output = open_private(&temporary, true)?;
            output
                .write_all(&serde_json::to_vec(&value).map_err(internal)?)
                .map_err(internal)?;
            output.sync_all().map_err(internal)?;
            std::fs::hard_link(&temporary, &path).map_err(internal)?;
            Ok::<_, ApiError>(())
        })();
        let _ = std::fs::remove_file(&temporary);
        result?;
        #[cfg(unix)]
        File::open(&directory)
            .and_then(|dir| dir.sync_all())
            .map_err(internal)?;
    }
    let input = open_private(&path, false)?;
    if input.metadata().map_err(internal)?.len() > 4096 {
        return Err(internal("invalid Word recovery binding"));
    }
    let value: StoreBinding = serde_json::from_reader(input).map_err(internal)?;
    if value.version != 1
        || value.document_id != id
        || value.epoch != epoch
        || !hex(&value.store_id)
        || value.journal_hash != "none" && !valid_hash(&value.journal_hash)
    {
        return Err(internal("invalid Word recovery binding"));
    }
    if value.store_id != store_id {
        return Err(conflict("word-owner-recovery-store-mismatch"));
    }
    Ok((file, path, value))
}
fn cancelled_path(
    root: &std::path::Path,
    id: &str,
    epoch: u64,
    transaction: &str,
) -> Result<PathBuf, ApiError> {
    if !hex(transaction) {
        return Err(conflict("word-topology-invalid"));
    }
    let directory = root.join("collaboration/word-owners");
    for path in [root.join("collaboration"), directory.clone()] {
        let meta = std::fs::symlink_metadata(path).map_err(internal)?;
        if !meta.is_dir() || meta.is_symlink() {
            return Err(internal("invalid Word owner directory"));
        }
    }
    Ok(directory.join(format!("{id}.{epoch}.{transaction}.cancel")))
}
pub(super) fn topology_cancelled(
    root: &std::path::Path,
    id: &str,
    epoch: u64,
    transaction: &str,
) -> Result<bool, ApiError> {
    let path = cancelled_path(root, id, epoch, transaction)?;
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(internal(error)),
        Ok(meta) if meta.is_symlink() || !meta.is_file() || meta.len() > 128 => {
            return Err(internal("invalid Word cancellation"))
        }
        Ok(_) => {}
    }
    let mut file = open_private(&path, false)?;
    let mut value = String::new();
    file.read_to_string(&mut value).map_err(internal)?;
    if value != "hcd-word-topology-cancel/1" {
        return Err(internal("invalid Word cancellation"));
    }
    Ok(true)
}
pub(super) fn seal_topology_cancel(
    root: &std::path::Path,
    id: &str,
    epoch: u64,
    transaction: &str,
) -> Result<(), ApiError> {
    if topology_cancelled(root, id, epoch, transaction)? {
        return Ok(());
    }
    let path = cancelled_path(root, id, epoch, transaction)?;
    let directory = path
        .parent()
        .ok_or_else(|| internal("invalid Word cancellation path"))?;
    let temp = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = open_private(&temp, true)?;
        file.write_all(b"hcd-word-topology-cancel/1")
            .map_err(internal)?;
        file.sync_all().map_err(internal)?;
        match std::fs::hard_link(&temp, &path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(internal(error)),
        }
        #[cfg(unix)]
        File::open(directory)
            .and_then(|dir| dir.sync_all())
            .map_err(internal)?;
        if !topology_cancelled(root, id, epoch, transaction)? {
            return Err(internal("Word cancellation was not sealed"));
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(temp);
    result
}
pub(super) fn checkpoint_cancelled(
    root: &std::path::Path,
    id: &str,
    epoch: u64,
    checkpoint: &str,
) -> Result<bool, ApiError> {
    let path = cancelled_path(root, id, epoch, checkpoint)?.with_extension("checkpoint-cancel");
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(internal(error)),
        Ok(meta) if meta.is_symlink() || !meta.is_file() || meta.len() > 128 => {
            return Err(internal("invalid Word checkpoint cancellation"));
        }
        Ok(_) => {}
    }
    let mut file = open_private(&path, false)?;
    let mut value = String::new();
    file.read_to_string(&mut value).map_err(internal)?;
    if value != "hcd-word-checkpoint-cancel/1" {
        return Err(internal("invalid Word checkpoint cancellation"));
    }
    Ok(true)
}
pub(super) fn seal_checkpoint_cancel(
    root: &std::path::Path,
    id: &str,
    epoch: u64,
    checkpoint: &str,
) -> Result<(), ApiError> {
    if checkpoint_cancelled(root, id, epoch, checkpoint)? {
        return Ok(());
    }
    let path = cancelled_path(root, id, epoch, checkpoint)?.with_extension("checkpoint-cancel");
    let directory = path
        .parent()
        .ok_or_else(|| internal("invalid Word cancellation path"))?;
    let temp = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = open_private(&temp, true)?;
        file.write_all(b"hcd-word-checkpoint-cancel/1")
            .map_err(internal)?;
        file.sync_all().map_err(internal)?;
        match std::fs::hard_link(&temp, &path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(internal(error)),
        }
        #[cfg(unix)]
        File::open(directory)
            .and_then(|dir| dir.sync_all())
            .map_err(internal)?;
        if !checkpoint_cancelled(root, id, epoch, checkpoint)? {
            return Err(internal("Word checkpoint cancellation was not sealed"));
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(temp);
    result
}
/// Durable evidence for an unchanged checkpoint, which has no revision record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct UnchangedCheckpoint {
    pub patch_id: String,
    pub journal_hash: String,
    pub request_hash: String,
    pub revision: u64,
    pub root_hash: String,
    pub signature: String,
}
pub(super) fn checkpoint_unchanged(
    root: &std::path::Path,
    id: &str,
    epoch: u64,
    checkpoint: &str,
) -> Result<Option<UnchangedCheckpoint>, ApiError> {
    let path = cancelled_path(root, id, epoch, checkpoint)?.with_extension("checkpoint-unchanged");
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(internal(error)),
        Ok(meta) if meta.is_symlink() || !meta.is_file() || meta.len() > 4096 => {
            return Err(internal("invalid Word unchanged checkpoint"))
        }
        Ok(_) => {}
    }
    let mut bytes = Vec::new();
    open_private(&path, false)?
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(internal)?;
    if bytes.len() > 4096 {
        return Err(internal("invalid Word unchanged checkpoint"));
    }
    let value: UnchangedCheckpoint = serde_json::from_slice(&bytes).map_err(internal)?;
    let parts: Vec<_> = value.patch_id.split(':').collect();
    if parts.len() != 6
        || parts[0] != "hcdsave6"
        || !hex(parts[1])
        || parts[2] != checkpoint
        || !valid_hash(parts[3])
        || !valid_hash(parts[4])
        || parts[5].len() != 43
        || !parts[5]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || !valid_hash(&value.journal_hash)
        || !valid_hash(&value.request_hash)
        || !valid_hash(&value.root_hash)
        || value.signature.len() != 43
        || !value
            .signature
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(internal("invalid Word unchanged checkpoint"));
    }
    // A previous publication may have linked the file but failed before its
    // directory sync. A retry must establish durability before using it.
    #[cfg(unix)]
    File::open(
        path.parent()
            .ok_or_else(|| internal("invalid Word checkpoint path"))?,
    )
    .and_then(|dir| dir.sync_all())
    .map_err(internal)?;
    Ok(Some(value))
}
pub(super) fn seal_checkpoint_unchanged(
    root: &std::path::Path,
    id: &str,
    epoch: u64,
    checkpoint: &str,
    value: &UnchangedCheckpoint,
) -> Result<(), ApiError> {
    if let Some(existing) = checkpoint_unchanged(root, id, epoch, checkpoint)? {
        return if existing == *value {
            Ok(())
        } else {
            Err(conflict("word-checkpoint-identity-used"))
        };
    }
    let path = cancelled_path(root, id, epoch, checkpoint)?.with_extension("checkpoint-unchanged");
    let directory = path
        .parent()
        .ok_or_else(|| internal("invalid Word checkpoint path"))?;
    let temp = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = open_private(&temp, true)?;
        file.write_all(&serde_json::to_vec(value).map_err(internal)?)
            .map_err(internal)?;
        file.sync_all().map_err(internal)?;
        match std::fs::hard_link(&temp, &path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(internal(error)),
        }
        #[cfg(unix)]
        File::open(directory)
            .and_then(|dir| dir.sync_all())
            .map_err(internal)?;
        if checkpoint_unchanged(root, id, epoch, checkpoint)?.as_ref() != Some(value) {
            return Err(conflict("word-checkpoint-identity-used"));
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(temp);
    result
}
fn record_binding(lease: &Lease, id: &str, epoch: u64, hash: &str) -> Result<(), ApiError> {
    let value = StoreBinding {
        version: 1,
        document_id: id.into(),
        epoch,
        store_id: lease.store_id.clone(),
        journal_hash: hash.into(),
    };
    let directory = lease
        .binding_path
        .parent()
        .ok_or_else(|| internal("invalid Word binding path"))?;
    let temp = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = open_private(&temp, true)?;
        file.write_all(&serde_json::to_vec(&value).map_err(internal)?)
            .map_err(internal)?;
        file.sync_all().map_err(internal)?;
        std::fs::rename(&temp, &lease.binding_path).map_err(internal)?;
        #[cfg(unix)]
        File::open(directory)
            .and_then(|dir| dir.sync_all())
            .map_err(internal)?;
        Ok(())
    })();
    let _ = std::fs::remove_file(temp);
    result
}
impl WordOwners {
    pub(super) fn start(&self) {
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let Some(inner) = weak.upgrade() else { break };
                if let Ok(mut leases) = inner.lock() {
                    leases.retain(|_, lease| lease.live());
                };
            }
        });
    }
    fn apply(
        &self,
        root: &std::path::Path,
        id: &str,
        request: &Request,
    ) -> Result<Value, ApiError> {
        if request.version != 1
            || !hex(&request.owner_id)
            || !hex(&request.store_id)
            || matches!(request.action, Action::Acquire) && request.lease_id.is_some()
            || !matches!(request.action, Action::Acquire)
                && request.lease_id.as_deref().is_none_or(|id| !hex(id))
        {
            return Err(bad("invalid Word owner request"));
        }
        if request.journal_hashes.len() > 4097
            || request
                .journal_hashes
                .iter()
                .any(|hash| hash != "none" && !valid_hash(hash))
        {
            return Err(bad("invalid recovery journal ancestry"));
        }
        let mut leases = self.inner.lock().map_err(internal)?;
        leases.retain(|_, lease| lease.live());
        let key = (id.to_string(), request.epoch);
        match request.action {
            Action::Acquire => {
                if let Some(lease) = leases.get(&key) {
                    if lease.owner_id != request.owner_id || lease.store_id != request.store_id {
                        return Err(conflict("word-owner-busy"));
                    }
                    return lease.response(request.epoch);
                }
                let (file, binding_path, binding) =
                    binding(root, id, request.epoch, &request.store_id)?;
                if binding.journal_hash != "none"
                    && !request.journal_hashes.contains(&binding.journal_hash)
                {
                    return Err(conflict("word-owner-recovery-chain-missing"));
                }
                let lease = Arc::new(Lease {
                    file,
                    owner_id: request.owner_id.clone(),
                    store_id: request.store_id.clone(),
                    lease_id: uuid::Uuid::new_v4().simple().to_string(),
                    journal_hash: StdMutex::new(binding.journal_hash),
                    binding_path,
                    deadline: StdMutex::new(Instant::now() + Duration::from_millis(TTL_MS)),
                });
                let response = lease.response(request.epoch)?;
                leases.insert(key, lease);
                Ok(response)
            }
            Action::Renew | Action::Release | Action::Record => {
                let lease = leases
                    .get(&key)
                    .ok_or_else(|| conflict("word-owner-lost"))?;
                if lease.owner_id != request.owner_id
                    || lease.store_id != request.store_id
                    || Some(&lease.lease_id) != request.lease_id.as_ref()
                {
                    return Err(conflict("word-owner-lost"));
                }
                if matches!(request.action, Action::Release) {
                    leases.remove(&key);
                    return Ok(json!({"version":1,"released":true}));
                }
                if matches!(request.action, Action::Record) {
                    let previous = lease.journal_hash.lock().map_err(internal)?.clone();
                    let next = request
                        .journal_hashes
                        .last()
                        .filter(|hash| valid_hash(hash))
                        .ok_or_else(|| bad("journal head required"))?;
                    if previous != "none" && !request.journal_hashes.contains(&previous) {
                        return Err(conflict("word-owner-recovery-chain-missing"));
                    }
                    record_binding(lease, id, request.epoch, next)?;
                    *lease.journal_hash.lock().map_err(internal)? = next.clone();
                }
                *lease.deadline.lock().map_err(internal)? =
                    Instant::now() + Duration::from_millis(TTL_MS);
                lease.response(request.epoch)
            }
        }
    }
    pub(super) fn guard(
        &self,
        id: &str,
        epoch: u64,
        headers: &HeaderMap,
    ) -> Result<Arc<Lease>, ApiError> {
        self.guard_inner(id, epoch, headers, false)
    }
    // Only the read-only editor bootstrap may use an empty journal binding.
    pub(super) fn guard_bootstrap(
        &self,
        id: &str,
        epoch: u64,
        headers: &HeaderMap,
    ) -> Result<Arc<Lease>, ApiError> {
        self.guard_inner(id, epoch, headers, true)
    }
    fn guard_inner(
        &self,
        id: &str,
        epoch: u64,
        headers: &HeaderMap,
        empty: bool,
    ) -> Result<Arc<Lease>, ApiError> {
        let leases = self.inner.lock().map_err(internal)?;
        let lease = leases
            .get(&(id.into(), epoch))
            .ok_or_else(|| conflict("word-owner-required"))?;
        let journal_hash = lease.journal_hash.lock().map_err(internal)?.clone();
        if !(if empty {
            journal_hash == "none"
        } else {
            valid_hash(&journal_hash)
        }) || headers
            .get("x-hcd-word-journal-hash")
            .and_then(|v| v.to_str().ok())
            != Some(&journal_hash)
            || !lease.live()
            || headers
                .get("x-hcd-word-owner")
                .and_then(|v| v.to_str().ok())
                != Some(&lease.lease_id)
            || headers
                .get("x-hcd-word-owner-id")
                .and_then(|v| v.to_str().ok())
                != Some(&lease.owner_id)
        {
            return Err(conflict("word-owner-lost"));
        }
        Ok(lease.clone())
    }
}
pub(super) async fn owner(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<Request>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize_claims(&state, &headers, &id)?;
    if !collaboration_service(&claims)
        || headers
            .get("x-hcd-coordinator-version")
            .and_then(|v| v.to_str().ok())
            != Some("5")
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Word owner requires coordinator 5".into(),
        ));
    }
    if state.remote.is_some() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "remote Word ownership adapter is not configured".into(),
        ));
    }
    let _guard = state.collaboration_lock.lock().await;
    let epoch = check_collaboration_epoch(&state, &id, &headers).await?;
    if epoch != request.epoch
        || !matches!(
            collaboration_metadata(&state, &id).await?.protocol,
            CollaborationProtocol::WordRegions1 | CollaborationProtocol::WordRegions2
        )
    {
        return Err(conflict("word-owner-session-changed"));
    }
    open(&state, &id)?;
    Ok(Json(state.word_owners.apply(&state.root, &id, &request)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn word_owner_checkpoint_cancel_is_durable_and_separate_from_topology() {
        let root = tempfile::tempdir().unwrap();
        let owners = WordOwners::default();
        owners
            .apply(root.path(), "doc", &request('a', 'c'))
            .unwrap();
        let checkpoint = "d".repeat(32);
        assert!(!checkpoint_cancelled(root.path(), "doc", 1, &checkpoint).unwrap());
        seal_checkpoint_cancel(root.path(), "doc", 1, &checkpoint).unwrap();
        seal_checkpoint_cancel(root.path(), "doc", 1, &checkpoint).unwrap();
        assert!(checkpoint_cancelled(root.path(), "doc", 1, &checkpoint).unwrap());
        assert!(!topology_cancelled(root.path(), "doc", 1, &checkpoint).unwrap());
        assert!(!checkpoint_cancelled(root.path(), "doc", 2, &checkpoint).unwrap());
        let path = cancelled_path(root.path(), "doc", 1, &checkpoint)
            .unwrap()
            .with_extension("checkpoint-cancel");
        std::fs::write(path, "tampered").unwrap();
        assert!(checkpoint_cancelled(root.path(), "doc", 1, &checkpoint).is_err());
    }
    #[test]
    fn word_owner_unchanged_checkpoint_binds_exact_identity() {
        let root = tempfile::tempdir().unwrap();
        WordOwners::default()
            .apply(root.path(), "doc", &request('a', 'c'))
            .unwrap();
        let checkpoint = "d".repeat(32);
        let patch = format!(
            "hcdsave6:{}:{checkpoint}:{}:{}:{}",
            "a".repeat(32),
            "b".repeat(64),
            "c".repeat(64),
            "D".repeat(43)
        );
        let value = UnchangedCheckpoint {
            patch_id: patch.clone(),
            journal_hash: "e".repeat(64),
            request_hash: "f".repeat(64),
            revision: 3,
            root_hash: "a".repeat(64),
            signature: "A".repeat(43),
        };
        assert_eq!(
            checkpoint_unchanged(root.path(), "doc", 1, &checkpoint).unwrap(),
            None
        );
        seal_checkpoint_unchanged(root.path(), "doc", 1, &checkpoint, &value).unwrap();
        seal_checkpoint_unchanged(root.path(), "doc", 1, &checkpoint, &value).unwrap();
        assert_eq!(
            checkpoint_unchanged(root.path(), "doc", 1, &checkpoint)
                .unwrap()
                .as_ref(),
            Some(&value)
        );
        let mut other = value.clone();
        other.journal_hash = "9".repeat(64);
        assert_eq!(
            seal_checkpoint_unchanged(root.path(), "doc", 1, &checkpoint, &other)
                .unwrap_err()
                .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            checkpoint_unchanged(root.path(), "doc", 2, &checkpoint).unwrap(),
            None
        );
    }
    fn request(owner: char, store: char) -> Request {
        Request {
            version: 1,
            epoch: 1,
            owner_id: owner.to_string().repeat(32),
            store_id: store.to_string().repeat(32),
            action: Action::Acquire,
            lease_id: None,
            journal_hashes: Vec::new(),
        }
    }
    fn headers(value: &Value) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-hcd-word-owner",
            value["leaseId"].as_str().unwrap().parse().unwrap(),
        );
        headers.insert(
            "x-hcd-word-owner-id",
            value["ownerId"].as_str().unwrap().parse().unwrap(),
        );
        headers.insert(
            "x-hcd-word-journal-hash",
            value["journalHash"].as_str().unwrap().parse().unwrap(),
        );
        headers
    }
    #[test]
    fn word_owner_os_lock_fences_separate_registries_and_inflight_guards() {
        let root = tempfile::tempdir().unwrap();
        let a = WordOwners::default();
        let b = WordOwners::default();
        let mut first = request('a', 'c');
        let acquired = a.apply(root.path(), "doc", &first).unwrap();
        first.action = Action::Record;
        first.lease_id = Some(acquired["leaseId"].as_str().unwrap().into());
        first.journal_hashes = vec!["none".into(), "e".repeat(64)];
        let acquired = a.apply(root.path(), "doc", &first).unwrap();
        let guard = a.guard("doc", 1, &headers(&acquired)).unwrap();
        assert_eq!(
            b.apply(root.path(), "doc", &request('b', 'c'))
                .unwrap_err()
                .0,
            StatusCode::CONFLICT
        );
        first.action = Action::Release;
        first.lease_id = Some(acquired["leaseId"].as_str().unwrap().into());
        a.apply(root.path(), "doc", &first).unwrap();
        assert!(b.apply(root.path(), "doc", &request('b', 'c')).is_err());
        drop(guard);
        let mut takeover = request('b', 'c');
        takeover.journal_hashes = first.journal_hashes.clone();
        let second = b.apply(root.path(), "doc", &takeover).unwrap();
        assert_ne!(acquired["leaseId"], second["leaseId"]);
        assert!(a.guard("doc", 1, &headers(&acquired)).is_err());
    }
    #[test]
    fn word_owner_expiry_does_not_allow_old_renewal_and_store_identity_is_sticky() {
        let root = tempfile::tempdir().unwrap();
        let a = WordOwners::default();
        let b = WordOwners::default();
        let mut first = request('a', 'c');
        let value = a.apply(root.path(), "doc", &first).unwrap();
        *a.inner
            .lock()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .deadline
            .lock()
            .unwrap() = Instant::now() - Duration::from_secs(1);
        first.action = Action::Renew;
        first.lease_id = Some(value["leaseId"].as_str().unwrap().into());
        assert!(a.apply(root.path(), "doc", &first).is_err());
        assert!(b
            .apply(root.path(), "doc", &request('b', 'd'))
            .unwrap_err()
            .1
            .contains("store-mismatch"));
        assert!(b.apply(root.path(), "doc", &request('b', 'c')).is_ok());
    }
    #[test]
    fn word_owner_requires_recorded_journal_ancestry_and_current_hash() {
        let root = tempfile::tempdir().unwrap();
        let a = WordOwners::default();
        let mut first = request('a', 'c');
        let acquired = a.apply(root.path(), "doc", &first).unwrap();
        assert!(a.guard("doc", 1, &headers(&acquired)).is_err());
        first.action = Action::Record;
        first.lease_id = Some(acquired["leaseId"].as_str().unwrap().into());
        first.journal_hashes = vec!["none".into(), "d".repeat(64)];
        let recorded = a.apply(root.path(), "doc", &first).unwrap();
        assert!(a.guard("doc", 1, &headers(&recorded)).is_ok());
        first.journal_hashes = vec!["none".into(), "e".repeat(64)];
        assert!(a
            .apply(root.path(), "doc", &first)
            .unwrap_err()
            .1
            .contains("chain-missing"));
        first.journal_hashes.insert(1, "d".repeat(64));
        let advanced = a.apply(root.path(), "doc", &first).unwrap();
        assert!(a.guard("doc", 1, &headers(&recorded)).is_err());
        assert!(a.guard("doc", 1, &headers(&advanced)).is_ok());
        first.action = Action::Release;
        a.apply(root.path(), "doc", &first).unwrap();
        let b = WordOwners::default();
        let mut copied_identity = request('b', 'c');
        copied_identity.journal_hashes = vec!["none".into(), "d".repeat(64)];
        assert!(b
            .apply(root.path(), "doc", &copied_identity)
            .unwrap_err()
            .1
            .contains("chain-missing"));
        copied_identity.journal_hashes.push("e".repeat(64));
        assert_eq!(
            b.apply(root.path(), "doc", &copied_identity).unwrap()["journalHash"],
            "e".repeat(64)
        );
    }
    #[test]
    fn word_owner_binding_and_lock_symlinks_are_not_followed() {
        let root = tempfile::tempdir().unwrap();
        let a = WordOwners::default();
        let directory = root.path().join("collaboration/word-owners");
        std::fs::create_dir_all(&directory).unwrap();
        #[cfg(unix)]
        {
            let outside = root.path().join("outside");
            std::fs::write(&outside, b"keep").unwrap();
            std::os::unix::fs::symlink(&outside, directory.join("doc.1.lock")).unwrap();
            assert!(a.apply(root.path(), "doc", &request('a', 'c')).is_err());
            assert_eq!(std::fs::read(outside).unwrap(), b"keep");
        }
    }
}
