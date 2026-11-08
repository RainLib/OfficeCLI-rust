//! Authoritative document membership adapter and per-document authorization gate.
//! Policy mutation is serialized with requests that may publish document writes.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tokio::sync::RwLock;

const MAX_POLICY_BYTES: u64 = 256 * 1024;
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DocumentAccess {
    pub generation: u64,
    #[serde(default)]
    pub readers: Option<Vec<String>>,
    pub writers: Option<Vec<String>>,
}
impl DocumentAccess {
    pub fn can_read(&self, subject: Option<&str>) -> bool {
        member(&self.readers, subject)
    }
    pub fn can_write(&self, subject: Option<&str>) -> bool {
        self.can_read(subject) && member(&self.writers, subject)
    }
    pub fn restricted(&self) -> bool {
        self.readers.is_some() || self.writers.is_some()
    }
    pub fn revokes(&self, previous: &Self) -> bool {
        fn effective(
            readers: &Option<Vec<String>>,
            writers: &Option<Vec<String>>,
        ) -> Option<Vec<String>> {
            match (readers, writers) {
                (None, None) => None,
                (Some(ids), None) | (None, Some(ids)) => Some(ids.clone()),
                (Some(readers), Some(writers)) => Some(
                    writers
                        .iter()
                        .filter(|id| readers.contains(id))
                        .cloned()
                        .collect(),
                ),
            }
        }
        fn contains_all(next: &Option<Vec<String>>, old: &Option<Vec<String>>) -> bool {
            match (next, old) {
                (None, _) => true,
                (Some(_), None) => false,
                (Some(next), Some(old)) => old.iter().all(|id| next.contains(id)),
            }
        }
        !contains_all(&self.readers, &previous.readers)
            || !contains_all(
                &effective(&self.readers, &self.writers),
                &effective(&previous.readers, &previous.writers),
            )
    }
    pub fn replace(
        &self,
        readers: Option<Vec<String>>,
        writers: Option<Vec<String>>,
    ) -> Result<Self, String> {
        fn normalize(ids: Option<Vec<String>>) -> Result<Option<Vec<String>>, String> {
            let Some(mut ids) = ids else { return Ok(None) };
            if ids.len() > 256
                || ids.iter().any(|id| !valid_subject(id))
                || ids.iter().collect::<HashSet<_>>().len() != ids.len()
            {
                return Err("membership must contain at most 256 unique, nonempty subject IDs of at most 256 bytes".into());
            }
            ids.sort();
            Ok(Some(ids))
        }
        Ok(Self {
            generation: self
                .generation
                .checked_add(1)
                .ok_or("access generation limit reached")?,
            readers: normalize(readers)?,
            writers: normalize(writers)?,
        })
    }
}
fn member(members: &Option<Vec<String>>, subject: Option<&str>) -> bool {
    members
        .as_ref()
        .is_none_or(|ids| subject.is_some_and(|subject| ids.iter().any(|id| id == subject)))
}
pub(super) fn valid_subject(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
}

pub(super) trait DocumentAccessPolicy: Send + Sync {
    fn load(&self, document_id: &str) -> Result<DocumentAccess, String>;
    fn compare_replace(
        &self,
        document_id: &str,
        expected_generation: u64,
        next: &DocumentAccess,
    ) -> Result<bool, String>;
}
pub(super) struct FileAccessPolicy {
    root: PathBuf,
}
impl FileAccessPolicy {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.join("access"),
        }
    }
    fn path(&self, id: &str) -> Result<PathBuf, String> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err("invalid document ID".into());
        }
        Ok(self.root.join(format!("{id}.json")))
    }
}
impl DocumentAccessPolicy for FileAccessPolicy {
    fn load(&self, id: &str) -> Result<DocumentAccess, String> {
        let file = match std::fs::File::open(self.path(id)?) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(DocumentAccess::default())
            }
            Err(error) => return Err(error.to_string()),
        };
        let mut bytes = Vec::new();
        file.take(MAX_POLICY_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_POLICY_BYTES {
            return Err("document access policy is too large".into());
        }
        let access: DocumentAccess =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        // Persisted data is subject to the same bounded membership validation.
        DocumentAccess::default().replace(access.readers.clone(), access.writers.clone())?;
        Ok(access)
    }
    fn compare_replace(
        &self,
        id: &str,
        expected: u64,
        next: &DocumentAccess,
    ) -> Result<bool, String> {
        static STORE: Mutex<()> = Mutex::new(());
        let _guard = STORE
            .lock()
            .map_err(|_| "access policy store unavailable")?;
        if self.load(id)?.generation != expected {
            return Ok(false);
        }
        if expected.checked_add(1) != Some(next.generation) {
            return Err("invalid access generation transition".into());
        }
        DocumentAccess::default().replace(next.readers.clone(), next.writers.clone())?;
        let path = self.path(id)?;
        std::fs::create_dir_all(&self.root).map_err(|error| error.to_string())?;
        let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .map_err(|error| error.to_string())?;
            file.write_all(&serde_json::to_vec(next).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            std::fs::File::open(&self.root)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| error.to_string())?;
            Ok(true)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temporary);
        }
        result
    }
}

/// Single-host gate shared by all routers for the same canonical root. A policy
/// transition waits for earlier requests, then fences old collaboration epochs.
/// Distributed stores must provide their own atomic policy/epoch adapter.
pub(super) fn gate(root: &Path, id: &str) -> Arc<RwLock<()>> {
    type Gates = Mutex<HashMap<PathBuf, Weak<RwLock<()>>>>;
    static GATES: OnceLock<Gates> = OnceLock::new();
    let mut gates = GATES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    gates.retain(|_, gate| gate.strong_count() > 0);
    let key = root.join(format!("{id}.hcd"));
    if let Some(gate) = gates.get(&key).and_then(Weak::upgrade) {
        return gate;
    }
    let gate = Arc::new(RwLock::new(()));
    gates.insert(key, Arc::downgrade(&gate));
    gate
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn membership_intersects_and_only_restrictions_revoke() {
        let initial = DocumentAccess::default();
        let restricted = initial
            .replace(
                Some(vec!["张三".into(), "alice".into()]),
                Some(vec!["alice".into(), "outsider".into()]),
            )
            .unwrap();
        assert!(restricted.revokes(&initial));
        assert!(restricted.can_write(Some("alice")));
        assert!(!restricted.can_write(Some("outsider")));
        assert!(restricted.can_read(Some("张三")));
        assert!(!restricted.can_write(None));
        let grant = restricted
            .replace(None, Some(vec!["alice".into(), "outsider".into()]))
            .unwrap();
        assert!(!grant.revokes(&restricted));
        assert!(!restricted.revokes(&restricted));
    }
    #[test]
    fn membership_is_bounded_and_generation_cannot_wrap() {
        let base = DocumentAccess::default();
        for ids in [
            vec!["".into()],
            vec!["a\n".into()],
            vec!["a".into(), "a".into()],
            vec!["x".repeat(257)],
            (0..257).map(|i| i.to_string()).collect(),
        ] {
            assert!(base.replace(None, Some(ids)).is_err());
        }
        assert!(DocumentAccess {
            generation: u64::MAX,
            ..base
        }
        .replace(None, None)
        .is_err());
    }
    #[test]
    fn persisted_policy_has_compare_and_swap_and_fails_closed() {
        let root = tempfile::tempdir().unwrap();
        let store = FileAccessPolicy::new(root.path());
        let next = store
            .load("doc")
            .unwrap()
            .replace(Some(vec![]), None)
            .unwrap();
        assert!(store.compare_replace("doc", 0, &next).unwrap());
        assert!(!store.compare_replace("doc", 0, &next).unwrap());
        assert_eq!(
            FileAccessPolicy::new(root.path()).load("doc").unwrap(),
            next
        );
        assert!(store.load("../doc").is_err());
        std::fs::write(store.path("doc").unwrap(), b"invalid").unwrap();
        assert!(store.load("doc").is_err());
        std::fs::write(
            store.path("doc").unwrap(),
            vec![b' '; MAX_POLICY_BYTES as usize + 1],
        )
        .unwrap();
        assert!(store.load("doc").is_err());
    }
    #[tokio::test]
    async fn policy_gate_waits_for_in_flight_mutation() {
        let root = tempfile::tempdir().unwrap();
        let first = gate(root.path(), "doc");
        let second = gate(root.path(), "doc");
        assert!(Arc::ptr_eq(&first, &second));
        let pending = first.read().await;
        assert!(second.try_write().is_err());
        drop(pending);
        let policy = second.write().await;
        assert!(first.try_read().is_err());
        drop(policy);
        assert!(first.try_read().is_ok());
    }
}
