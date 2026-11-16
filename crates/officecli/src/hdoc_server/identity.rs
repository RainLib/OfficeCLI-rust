//! Stable local service identity for browser recovery namespaces. A URL can
//! point at a different document root after a deployment or proxy change.
use anyhow::{Context, Result};
use std::{io::Write, path::Path};

pub(super) fn service_id(root: &Path) -> Result<String> {
    let path = root.join(".officecli-service-id");
    if !path.try_exists()? {
        let mut temporary = tempfile::NamedTempFile::new_in(root)?;
        temporary.write_all(uuid::Uuid::new_v4().to_string().as_bytes())?;
        temporary.as_file().sync_all()?;
        match temporary.persist_noclobber(&path) {
            Ok(_) => {}
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.error.into()),
        }
    }
    let value = std::fs::read_to_string(path).context("read HCD service identity")?;
    Ok(uuid::Uuid::parse_str(value.trim())
        .context("invalid HCD service identity")?
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_is_stable_and_concurrent_initialization_never_exposes_a_partial_id() {
        let root = tempfile::tempdir().unwrap();
        let ids = std::thread::scope(|scope| {
            (0..8)
                .map(|_| scope.spawn(|| service_id(root.path()).unwrap()))
                .collect::<Vec<_>>()
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(ids.iter().all(|id| id == &ids[0]));
        let other = tempfile::tempdir().unwrap();
        assert_ne!(ids[0], service_id(other.path()).unwrap());
    }
}
