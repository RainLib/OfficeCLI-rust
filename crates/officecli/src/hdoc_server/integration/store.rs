//! Private atomic records, owned by the API root's existing process lock.
use super::*;
use std::io::Write;
use std::sync::RwLock;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Mapping {
    pub document_id: String,
    pub tenant_id: String,
    pub app_id: String,
    pub external_file_id: String,
    pub source: Descriptor,
    pub external_head: String,
    pub last_published_revision: Option<u64>,
    pub sequence: u64,
    pub pending_publication: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Session {
    pub session_id: String,
    pub exchange_id: String,
    pub credential_hash: String,
    pub external_file_id: String,
    pub document_id: String,
    pub actor: provider::User,
    pub host_expires_at: u64,
    pub expires_at: u64,
    pub closed: bool,
}

impl Session {
    pub fn subject(&self) -> String {
        format!(
            "host-{}",
            &hcd_core::hash_bytes(self.actor.id.as_bytes())[..32]
        )
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Publication {
    pub publication_id: String,
    pub document_id: String,
    pub actor_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_session_id: Option<String>,
    pub revision: u64,
    pub expected_version: String,
    pub state: String,
    pub export_mode: String,
    pub intent: Option<Value>,
    pub receipt: Option<Value>,
    pub error: Option<String>,
    pub fidelity: Option<Value>,
    pub event: Option<Value>,
    pub event_attempts: u32,
    pub event_next_at: u64,
    pub event_delivered: bool,
    pub event_dead_letter: bool,
    pub created_at: u64,
}

pub(super) struct Store {
    pub root: PathBuf,
    documents: RwLock<HashMap<String, Mapping>>,
    sessions: RwLock<HashMap<String, Session>>,
}

impl Store {
    pub fn open(root: &std::path::Path, config: &provider::Config) -> Result<Self> {
        let root = root.join("integration");
        for kind in ["documents", "sessions", "publications", "artifacts"] {
            let directory = root.join(kind);
            std::fs::create_dir_all(&directory)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        let identity = json!({"schemaVersion":"officecli-integration/1",
            "tenantId":config.tenant_id,"appId":config.app_id,"providerUrl":config.provider_url});
        let identity_path = root.join("identity.json");
        if identity_path.exists() {
            let recorded: Value = read(&identity_path)?;
            if recorded != identity {
                return Err(anyhow!("integration root belongs to a different Provider/app; explicit migration is required"));
            }
        } else {
            write_json(&identity_path, &identity)?;
        }
        let mut documents = HashMap::new();
        for path in records(&root.join("documents"))? {
            let mapping: Mapping = read(&path)?;
            if !valid_id(&mapping.document_id)
                || mapping.tenant_id != config.tenant_id
                || mapping.app_id != config.app_id
                || !external_id(&mapping.external_file_id)
                || mapping.source.id != mapping.external_file_id
                || path.file_stem().and_then(|p| p.to_str()) != Some(&mapping.document_id)
            {
                return Err(anyhow!("invalid integration document mapping"));
            }
            documents.insert(mapping.document_id.clone(), mapping);
        }
        let mut sessions = HashMap::new();
        for path in records(&root.join("sessions"))? {
            let session: Session = read(&path)?;
            if !valid_uuid(&session.session_id)
                || path.file_stem().and_then(|p| p.to_str()) != Some(&session.session_id)
                || !documents.contains_key(&session.document_id)
            {
                return Err(anyhow!("invalid integration session record"));
            }
            if !session.closed && session.expires_at > now() {
                sessions.insert(session.session_id.clone(), session);
            }
        }
        let store = Self {
            root,
            documents: RwLock::new(documents),
            sessions: RwLock::new(sessions),
        };
        // Do not start with an unreadable intent/receipt and silently skip it.
        // Pending mappings without a record are allowed: a crash may occur
        // between reserving a document and persisting its first queued record.
        for id in store.publication_ids()? {
            let record = store
                .publication(&id)
                .map_err(|e| anyhow!(e.1))?
                .ok_or_else(|| anyhow!("publication disappeared during startup"))?;
            if store.mapping(&record.document_id).is_none() {
                return Err(anyhow!("publication references an unregistered document"));
            }
        }
        Ok(store)
    }

    pub fn mapping(&self, id: &str) -> Option<Mapping> {
        self.documents
            .read()
            .expect("integration documents lock")
            .get(id)
            .cloned()
    }
    pub fn save_mapping(&self, mapping: &Mapping) -> Result<(), ApiError> {
        write_json(
            &self
                .root
                .join("documents")
                .join(format!("{}.json", mapping.document_id)),
            mapping,
        )
        .map_err(internal)?;
        self.documents
            .write()
            .expect("integration documents lock")
            .insert(mapping.document_id.clone(), mapping.clone());
        Ok(())
    }
    pub fn session(&self, id: &str) -> Result<Session, ApiError> {
        self.sessions
            .read()
            .expect("integration sessions lock")
            .get(id)
            .filter(|s| !s.closed && s.expires_at > now())
            .cloned()
            .ok_or_else(|| {
                ApiError(
                    StatusCode::UNAUTHORIZED,
                    "host session expired, closed or unavailable".into(),
                )
            })
    }
    pub fn session_record(&self, id: &str) -> Result<Option<Session>, ApiError> {
        if !valid_uuid(id) {
            return Err(bad("invalid session ID"));
        }
        let path = self.root.join("sessions").join(format!("{id}.json"));
        if !path.try_exists().map_err(internal)? {
            return Ok(None);
        }
        read(&path).map(Some).map_err(internal)
    }
    /// The original binding is used only to query an existing host receipt.
    pub fn publication_session(
        &self,
        record: &Publication,
        mapping: &Mapping,
    ) -> Result<Session, ApiError> {
        let matches = |session: &Session| {
            session.document_id == record.document_id
                && session.external_file_id == mapping.external_file_id
                && session.actor.id == record.actor_id
        };
        if let Some(origin) = &record.origin_session_id {
            if let Some(session) = self.session_record(origin)?.filter(matches) {
                return Ok(session);
            }
        } else {
            // Earlier records predate the explicit origin binding.
            for path in records(&self.root.join("sessions")).map_err(internal)? {
                let session: Session = read(&path).map_err(internal)?;
                if matches(&session) {
                    return Ok(session);
                }
            }
        }
        Err(conflict(
            "the original publication session binding is unavailable",
        ))
    }
    pub fn save_session(&self, session: &Session) -> Result<(), ApiError> {
        let mut sessions = self.sessions.write().expect("integration sessions lock");
        sessions.retain(|_, s| !s.closed && s.expires_at > now());
        if sessions.len() >= 1024 && !sessions.contains_key(&session.session_id) {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "too many host sessions".into(),
            ));
        }
        write_json(
            &self
                .root
                .join("sessions")
                .join(format!("{}.json", session.session_id)),
            session,
        )
        .map_err(internal)?;
        sessions.insert(session.session_id.clone(), session.clone());
        Ok(())
    }
    pub fn publication(&self, id: &str) -> Result<Option<Publication>, ApiError> {
        if !valid_uuid(id) {
            return Err(bad("invalid publication ID"));
        }
        let path = self.root.join("publications").join(format!("{id}.json"));
        if !path.try_exists().map_err(internal)? {
            return Ok(None);
        }
        let publication: Publication = read(&path).map_err(internal)?;
        if publication.publication_id != id || !valid_id(&publication.document_id) {
            return Err(internal("invalid publication record identity"));
        }
        Ok(Some(publication))
    }
    pub fn save_publication(&self, publication: &Publication) -> Result<(), ApiError> {
        write_json(
            &self
                .root
                .join("publications")
                .join(format!("{}.json", publication.publication_id)),
            publication,
        )
        .map_err(internal)
    }
    pub fn publication_ids(&self) -> Result<Vec<String>> {
        records(&self.root.join("publications"))?
            .into_iter()
            .map(|p| {
                p.file_stem()
                    .and_then(|s| s.to_str())
                    .filter(|s| valid_uuid(s))
                    .map(str::to_owned)
                    .ok_or_else(|| anyhow!("invalid publication filename"))
            })
            .collect()
    }
    pub fn artifact(&self, publication: &Publication) -> PathBuf {
        self.root
            .join("artifacts")
            .join(format!("{}.bin", publication.publication_id))
    }
}

fn records(directory: &std::path::Path) -> Result<Vec<PathBuf>> {
    std::fs::read_dir(directory)?
        .map(|entry| {
            let entry = entry?;
            Ok(entry.path())
        })
        .filter(|v: &Result<PathBuf>| {
            v.as_ref()
                .map_or(true, |p| p.extension().is_some_and(|e| e == "json"))
        })
        .collect()
}

fn read<T: serde::de::DeserializeOwned>(path: &std::path::Path) -> Result<T> {
    if std::fs::metadata(path)?.len() > 2 * 1024 * 1024 {
        return Err(anyhow!("integration record exceeds 2 MiB"));
    }
    serde_json::from_slice(&std::fs::read(path)?).context("invalid integration record")
}

pub(super) fn write_json(path: &std::path::Path, value: &impl Serialize) -> Result<()> {
    write_bytes(path, &serde_json::to_vec(value)?)
}

pub(super) fn write_bytes(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("record has no parent"))?;
    let temporary = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        #[cfg(unix)]
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}
