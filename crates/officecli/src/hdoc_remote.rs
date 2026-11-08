//! Optional single-instance PostgreSQL/S3 durability for the HCD core API.
//! Objects are uploaded before a PostgreSQL compare-and-swap advances head.
use crate::hdoc_collaboration::{
    Metadata as CollaborationMetadata, MigrationReceipt, Protocol as CollaborationProtocol,
};
use anyhow::{anyhow, Context, Result};
use hcd_core::{hash_bytes, hash_file, Bundle};
use object_store::aws::AmazonS3Builder;
use object_store::path::Path as ObjectPath;
use object_store::{ObjectStore, PutMode, PutOptions};
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_postgres::{Client, NoTls};

#[derive(Clone)]
pub struct RemoteStore {
    db: Arc<Mutex<Client>>,
    objects: Arc<dyn ObjectStore>,
    root: PathBuf,
}

pub enum CollaborationPut {
    Saved,
    EpochChanged,
    StateChanged,
    ModelRequired,
}

pub enum MigrationResult {
    Saved(CollaborationMetadata, bool),
    SourceChanged,
    HeadChanged,
    SessionChanged,
}
fn collaboration_metadata_row(row: &tokio_postgres::Row) -> Result<CollaborationMetadata> {
    let protocol: String = row.get(1);
    let receipt: Option<String> = row.get(2);
    let value = serde_json::json!({"epoch":row.get::<_,i64>(0),"protocol":protocol,"nodeEdits":row.get::<_,Option<i32>>(3),"migration":receipt.map(|value|serde_json::from_str::<MigrationReceipt>(&value)).transpose()?});
    Ok(CollaborationMetadata::decode(&value.to_string())?)
}

impl RemoteStore {
    pub async fn connect(
        database_url: &str,
        bucket: &str,
        endpoint: Option<&str>,
        root: PathBuf,
    ) -> Result<Self> {
        let (db, connection) = tokio_postgres::connect(database_url, NoTls)
            .await
            .context("connect to HCD PostgreSQL")?;
        tokio::spawn(async move {
            if let Err(error) = connection.await {
                eprintln!("HCD PostgreSQL connection stopped: {error}");
            }
        });
        db.batch_execute("CREATE TABLE IF NOT EXISTS hcd_documents (
            document_id text PRIMARY KEY, head_revision bigint NOT NULL, root_hash text NOT NULL,
            head_key text NOT NULL,
            source_key text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
            CREATE TABLE IF NOT EXISTS hcd_objects (
            document_id text NOT NULL, relative_path text NOT NULL, object_key text NOT NULL,
            PRIMARY KEY(document_id, relative_path));
            CREATE TABLE IF NOT EXISTS hcd_jobs (
            job_id text PRIMARY KEY, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
            CREATE TABLE IF NOT EXISTS hcd_collaboration (
            document_id text PRIMARY KEY, state bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
            CREATE TABLE IF NOT EXISTS hcd_collaboration_meta (
            document_id text PRIMARY KEY, epoch bigint NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS hcd_collaboration_recovery (
            document_id text NOT NULL, recovery_id text NOT NULL, epoch bigint NOT NULL,
            state bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY(document_id,recovery_id));
            ALTER TABLE hcd_collaboration_meta ADD COLUMN IF NOT EXISTS protocol text NOT NULL DEFAULT 'hcd-default/1';
            ALTER TABLE hcd_collaboration_meta ADD COLUMN IF NOT EXISTS migration_receipt text;
            ALTER TABLE hcd_collaboration_meta ADD COLUMN IF NOT EXISTS node_edits integer;")
            .await.context("initialize HCD PostgreSQL schema")?;
        let mut builder = AmazonS3Builder::from_env().with_bucket_name(bucket);
        if let Some(endpoint) = endpoint {
            builder = builder
                .with_endpoint(endpoint)
                .with_allow_http(endpoint.starts_with("http://"));
        }
        let objects: Arc<dyn ObjectStore> =
            Arc::new(builder.build().context("connect to HCD object store")?);
        Ok(Self {
            db: Arc::new(Mutex::new(db)),
            objects,
            root,
        })
    }

    async fn put_immutable(&self, key: &str, bytes: Vec<u8>) -> Result<bool> {
        let result = self
            .objects
            .put_opts(
                &ObjectPath::from(key),
                bytes.into(),
                PutOptions {
                    mode: PutMode::Create,
                    ..Default::default()
                },
            )
            .await;
        match result {
            Ok(_) => Ok(true),
            Err(object_store::Error::AlreadyExists { .. }) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    /// Uploads every new immutable HCD object, then atomically advances the DB head.
    /// A failed CAS removes newly uploaded objects after checking DB references.
    pub async fn publish(
        &self,
        id: &str,
        bundle_path: &Path,
        source: Option<&Path>,
        expected_head: Option<u64>,
    ) -> Result<()> {
        let bundle = Bundle::open(bundle_path)?;
        let manifest = bundle.manifest()?;
        if manifest.document_id != id {
            return Err(anyhow!("HCD document ID mismatch"));
        }
        let existing: HashSet<String> = self
            .db
            .lock()
            .await
            .query(
                "SELECT relative_path FROM hcd_objects WHERE document_id=$1",
                &[&id],
            )
            .await?
            .into_iter()
            .map(|row| row.get(0))
            .collect();
        let mut files = Vec::new();
        collect_files(bundle_path, bundle_path, &mut files)?;
        files.sort();
        let mut uploaded = Vec::new();
        let mut created_keys = Vec::new();
        for relative in files {
            if relative == "manifest.json"
                || relative.split('/').any(|part| part.starts_with('.'))
                || existing.contains(&relative)
            {
                continue;
            }
            let path = bundle_path.join(&relative);
            let bytes = tokio::fs::read(&path).await?;
            if bytes.len() > 64 * 1024 * 1024 {
                return Err(anyhow!("HCD remote object exceeds 64 MiB: {relative}"));
            }
            let key = format!("hcd/{id}/objects/{}", hash_bytes(&bytes));
            if self.put_immutable(&key, bytes).await? {
                created_keys.push(key.clone());
            }
            uploaded.push((relative, key));
        }
        let source_key = if let Some(source) = source {
            let extension = source
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("bin");
            let key = format!("hcd/{id}/source/{}.{}", manifest.source.sha256, extension);
            if hash_file(source)? != manifest.source.sha256 {
                return Err(anyhow!("immutable source SHA-256 mismatch"));
            }
            if self
                .put_immutable(&key, tokio::fs::read(source).await?)
                .await?
            {
                created_keys.push(key.clone());
            }
            key
        } else {
            self.db
                .lock()
                .await
                .query_opt(
                    "SELECT source_key FROM hcd_documents WHERE document_id=$1",
                    &[&id],
                )
                .await?
                .map(|row| row.get(0))
                .ok_or_else(|| anyhow!("remote document has no immutable source"))?
        };
        let head_bytes = tokio::fs::read(bundle_path.join("manifest.json")).await?;
        let head_key = format!("hcd/{id}/manifests/{}.json", hash_bytes(&head_bytes));
        if self.put_immutable(&head_key, head_bytes).await? {
            created_keys.push(head_key.clone());
        }
        let revision = i64::try_from(manifest.revision)?;
        let mut db = self.db.lock().await;
        let transaction = db.transaction().await?;
        let changed = match expected_head {
            None => transaction.execute("INSERT INTO hcd_documents (document_id,head_revision,root_hash,head_key,source_key)
                VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
                &[&id, &revision, &manifest.root_hash, &head_key, &source_key]).await?,
            Some(expected) => transaction.execute("UPDATE hcd_documents SET head_revision=$2,root_hash=$3,head_key=$4,updated_at=now()
                WHERE document_id=$1 AND head_revision=$5",
                &[&id, &revision, &manifest.root_hash, &head_key, &i64::try_from(expected)?]).await?,
        };
        if changed != 1 {
            if expected_head.is_none() {
                if let Some(row) = transaction
                    .query_opt(
                        "SELECT head_revision,root_hash FROM hcd_documents WHERE document_id=$1",
                        &[&id],
                    )
                    .await?
                {
                    let stored_revision: i64 = row.get(0);
                    let stored_hash: String = row.get(1);
                    if stored_revision == revision && stored_hash == manifest.root_hash {
                        return Ok(());
                    }
                }
            }
            drop(transaction);
            drop(db);
            self.cleanup_unreferenced(&created_keys).await?;
            return Err(anyhow!("PostgreSQL head compare-and-swap conflict"));
        }
        for (relative, key) in uploaded {
            transaction
                .execute(
                    "INSERT INTO hcd_objects (document_id, relative_path, object_key)
                VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
                    &[&id, &relative, &key],
                )
                .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    async fn cleanup_unreferenced(&self, keys: &[String]) -> Result<()> {
        for key in keys {
            let used = self
                .db
                .lock()
                .await
                .query_one(
                    "SELECT EXISTS(SELECT 1 FROM hcd_objects WHERE object_key=$1)
                 OR EXISTS(SELECT 1 FROM hcd_documents WHERE head_key=$1 OR source_key=$1)",
                    &[&key],
                )
                .await?
                .get::<_, bool>(0);
            if !used {
                self.objects.delete(&ObjectPath::from(key.as_str())).await?;
            }
        }
        Ok(())
    }

    pub async fn hydrate_all(&self) -> Result<()> {
        let rows = {
            let db = self.db.lock().await;
            db.query(
                "SELECT document_id,head_revision,head_key,source_key FROM hcd_documents",
                &[],
            )
            .await?
        };
        for row in rows {
            let id: String = row.get(0);
            let revision: i64 = row.get(1);
            let head_key: String = row.get(2);
            let source_key: String = row.get(3);
            self.hydrate(&id, revision as u64, &head_key, &source_key)
                .await?;
        }
        Ok(())
    }

    /// Notifications must not expose a local candidate before its remote CAS.
    pub async fn published_head(&self, id: &str) -> Result<(u64, String)> {
        let row = self
            .db
            .lock()
            .await
            .query_opt(
                "SELECT head_revision,root_hash FROM hcd_documents WHERE document_id=$1",
                &[&id],
            )
            .await?
            .ok_or_else(|| anyhow!("remote document missing"))?;
        let revision: i64 = row.get(0);
        Ok((
            revision.try_into().context("invalid remote revision")?,
            row.get(1),
        ))
    }

    pub async fn refresh(&self, id: &str) -> Result<()> {
        let row = self
            .db
            .lock()
            .await
            .query_opt(
                "SELECT head_revision,head_key,source_key FROM hcd_documents WHERE document_id=$1",
                &[&id],
            )
            .await?
            .ok_or_else(|| anyhow!("remote document missing"))?;
        let revision: i64 = row.get(0);
        let head_key: String = row.get(1);
        let source_key: String = row.get(2);
        self.hydrate(id, revision as u64, &head_key, &source_key)
            .await
    }

    async fn hydrate(
        &self,
        id: &str,
        revision: u64,
        head_key: &str,
        source_key: &str,
    ) -> Result<()> {
        let destination = self.root.join(format!("{id}.hcd"));
        if destination.join("manifest.json").is_file() {
            let local = Bundle::open(&destination)?.manifest()?;
            if local.revision == revision {
                return Ok(());
            }
        }
        tokio::fs::create_dir_all(&destination).await?;
        for row in self
            .db
            .lock()
            .await
            .query(
                "SELECT relative_path,object_key FROM hcd_objects WHERE document_id=$1",
                &[&id],
            )
            .await?
        {
            let relative: String = row.get(0);
            let key: String = row.get(1);
            if !safe_relative(&relative) {
                return Err(anyhow!("unsafe remote HCD object path"));
            }
            let output = destination.join(&relative);
            if output.is_file() {
                continue;
            }
            let bytes = self
                .objects
                .get(&ObjectPath::from(key))
                .await?
                .bytes()
                .await?;
            if let Some(parent) = output.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::write(output, bytes).await?;
        }
        let manifest = self
            .objects
            .get(&ObjectPath::from(head_key))
            .await?
            .bytes()
            .await?;
        let temporary = destination.join("manifest.json.remote.tmp");
        tokio::fs::write(&temporary, manifest).await?;
        tokio::fs::rename(&temporary, destination.join("manifest.json")).await?;
        let source_name = source_key
            .rsplit('/')
            .next()
            .ok_or_else(|| anyhow!("invalid source key"))?;
        let extension = source_name.rsplit('.').next().unwrap_or("bin");
        let source_path = self.root.join("sources").join(format!("{id}.{extension}"));
        if !source_path.is_file() {
            let bytes = self
                .objects
                .get(&ObjectPath::from(source_key))
                .await?
                .bytes()
                .await?;
            tokio::fs::create_dir_all(source_path.parent().expect("source parent")).await?;
            tokio::fs::write(source_path, bytes).await?;
        }
        let hydrated = Bundle::open(destination)?.manifest()?;
        if hydrated.document_id != id || hydrated.revision != revision {
            return Err(anyhow!("hydrated HCD head mismatch"));
        }
        Ok(())
    }

    pub async fn job_set(&self, job_id: &str, payload: &serde_json::Value) -> Result<()> {
        self.db
            .lock()
            .await
            .execute(
                "INSERT INTO hcd_jobs(job_id,payload) VALUES($1,($2::text)::jsonb)
            ON CONFLICT(job_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()",
                &[&job_id, &payload.to_string()],
            )
            .await?;
        Ok(())
    }

    pub async fn job_get(&self, job_id: &str) -> Result<Option<serde_json::Value>> {
        let row = self
            .db
            .lock()
            .await
            .query_opt(
                "SELECT payload::text FROM hcd_jobs WHERE job_id=$1",
                &[&job_id],
            )
            .await?;
        row.map(|value| {
            serde_json::from_str::<serde_json::Value>(&value.get::<_, String>(0))
                .map_err(Into::into)
        })
        .transpose()
    }

    pub async fn collaboration_get(&self, id: &str) -> Result<Option<Vec<u8>>> {
        Ok(self
            .db
            .lock()
            .await
            .query_opt(
                "SELECT state FROM hcd_collaboration WHERE document_id=$1",
                &[&id],
            )
            .await?
            .map(|row| row.get(0)))
    }

    pub async fn collaboration_put(
        &self,
        id: &str,
        epoch: u64,
        expected_hash: &str,
        bytes: &[u8],
        node_edits: Option<u32>,
    ) -> Result<CollaborationPut> {
        let mut db = self.db.lock().await;
        let transaction = db.transaction().await?;
        transaction.execute(
            "INSERT INTO hcd_collaboration_meta(document_id,epoch) VALUES($1,0) ON CONFLICT DO NOTHING",
            &[&id],
        ).await?;
        let current = transaction.query_one("SELECT epoch,node_edits FROM hcd_collaboration_meta WHERE document_id=$1 FOR UPDATE", &[&id]).await?;
        if current.get::<_, i64>(0) as u64 != epoch {
            return Ok(CollaborationPut::EpochChanged);
        }
        let model = current.get::<_, Option<i32>>(1);
        if node_edits.is_some_and(|version| !matches!(version, 1..=7))
            || model.is_some_and(|version| {
                !(1..=7).contains(&version)
                    || node_edits.is_none_or(|requested| requested < version as u32)
            })
        {
            return Ok(CollaborationPut::ModelRequired);
        }
        let previous = transaction
            .query_opt(
                "SELECT state FROM hcd_collaboration WHERE document_id=$1",
                &[&id],
            )
            .await?
            .map(|row| row.get::<_, Vec<u8>>(0));
        let actual_hash = previous
            .as_ref()
            .map(|bytes| hash_bytes(bytes))
            .unwrap_or_else(|| "none".into());
        if actual_hash != expected_hash && actual_hash != hash_bytes(bytes) {
            return Ok(CollaborationPut::StateChanged);
        }
        if let Some(version) = node_edits {
            let version = version as i32;
            transaction
                .execute(
                    "UPDATE hcd_collaboration_meta SET node_edits=$2 WHERE document_id=$1",
                    &[&id, &version],
                )
                .await?;
        }
        transaction
            .execute(
                "INSERT INTO hcd_collaboration(document_id,state) VALUES($1,$2)
            ON CONFLICT(document_id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()",
                &[&id, &bytes],
            )
            .await?;
        transaction.commit().await?;
        Ok(CollaborationPut::Saved)
    }

    pub async fn collaboration_metadata(&self, id: &str) -> Result<CollaborationMetadata> {
        let row=self.db.lock().await.query_opt("SELECT epoch,protocol,migration_receipt,node_edits FROM hcd_collaboration_meta WHERE document_id=$1",&[&id]).await?;
        row.as_ref()
            .map(collaboration_metadata_row)
            .transpose()
            .map(|value| value.unwrap_or_default())
    }

    pub async fn collaboration_migrate(
        &self,
        id: &str,
        request: &MigrationReceipt,
        bytes: &[u8],
    ) -> Result<MigrationResult> {
        let mut db = self.db.lock().await;
        let transaction = db.transaction().await?;
        transaction.execute("INSERT INTO hcd_collaboration_meta(document_id,epoch) VALUES($1,0) ON CONFLICT DO NOTHING",&[&id]).await?;
        let row=transaction.query_one("SELECT epoch,protocol,migration_receipt,node_edits FROM hcd_collaboration_meta WHERE document_id=$1 FOR UPDATE",&[&id]).await?;
        let current = collaboration_metadata_row(&row)?;
        if let Some(receipt) = &current.migration {
            if receipt.id == request.id {
                return Ok(if receipt == request {
                    MigrationResult::Saved(current, true)
                } else {
                    MigrationResult::SessionChanged
                });
            }
        }
        if current.epoch != request.from_epoch
            || current.protocol != CollaborationProtocol::Default1
        {
            return Ok(MigrationResult::SessionChanged);
        }
        let head = transaction
            .query_opt(
                "SELECT head_revision FROM hcd_documents WHERE document_id=$1 FOR UPDATE",
                &[&id],
            )
            .await?
            .ok_or_else(|| anyhow!("migration document not found"))?;
        if head.get::<_, i64>(0) != i64::try_from(request.base_revision)? {
            return Ok(MigrationResult::HeadChanged);
        }
        let previous = transaction
            .query_opt(
                "SELECT state FROM hcd_collaboration WHERE document_id=$1",
                &[&id],
            )
            .await?
            .map(|row| row.get::<_, Vec<u8>>(0));
        let actual = previous
            .as_ref()
            .map(|bytes| hash_bytes(bytes))
            .unwrap_or_else(|| "none".into());
        if actual != request.source_hash {
            return Ok(MigrationResult::SourceChanged);
        }
        let next = CollaborationMetadata {
            epoch: current
                .epoch
                .checked_add(1)
                .ok_or_else(|| anyhow!("collaboration epoch limit reached"))?,
            protocol: CollaborationProtocol::Structure3,
            node_edits: current.node_edits,
            migration: Some(request.clone()),
        };
        if let Some(previous) = previous {
            let recovery_id = format!(
                "e{}-{}-{}",
                current.epoch,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_millis(),
                uuid::Uuid::new_v4().simple()
            );
            transaction.execute("INSERT INTO hcd_collaboration_recovery(document_id,recovery_id,epoch,state) VALUES($1,$2,$3,$4)",&[&id,&recovery_id,&i64::try_from(current.epoch)?,&previous]).await?;
        }
        transaction.execute("INSERT INTO hcd_collaboration(document_id,state) VALUES($1,$2) ON CONFLICT(document_id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()",&[&id,&bytes]).await?;
        transaction.execute("UPDATE hcd_collaboration_meta SET epoch=$2,protocol=$3,migration_receipt=$4 WHERE document_id=$1",&[&id,&i64::try_from(next.epoch)?,&next.protocol.name(),&serde_json::to_string(request)?]).await?;
        transaction.commit().await?;
        Ok(MigrationResult::Saved(next, false))
    }

    pub async fn collaboration_reset(&self, id: &str) -> Result<u64> {
        let mut db = self.db.lock().await;
        let transaction = db.transaction().await?;
        let row = transaction
            .query_one(
                "INSERT INTO hcd_collaboration_meta(document_id,epoch) VALUES($1,1)
             ON CONFLICT(document_id) DO UPDATE SET epoch=hcd_collaboration_meta.epoch+1,migration_receipt=NULL
             RETURNING epoch",
                &[&id],
            )
            .await?;
        transaction
            .execute(
                "INSERT INTO hcd_collaboration_recovery(document_id,recovery_id,epoch,state)
             SELECT document_id,$2,$3,state FROM hcd_collaboration WHERE document_id=$1",
                &[
                    &id,
                    &format!(
                        "e{}-{}-{}",
                        row.get::<_, i64>(0) - 1,
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)?
                            .as_millis(),
                        uuid::Uuid::new_v4().simple()
                    ),
                    &(row.get::<_, i64>(0) - 1),
                ],
            )
            .await?;
        transaction
            .execute("DELETE FROM hcd_collaboration WHERE document_id=$1", &[&id])
            .await?;
        transaction.commit().await?;
        Ok(row.get::<_, i64>(0) as u64)
    }

    pub async fn collaboration_recover(
        &self,
        id: &str,
        recovery_id: &str,
        epoch: u64,
        bytes: &[u8],
    ) -> Result<()> {
        let epoch = i64::try_from(epoch)?;
        self.db.lock().await.execute("INSERT INTO hcd_collaboration_recovery(document_id,recovery_id,epoch,state) VALUES($1,$2,$3,$4)", &[&id, &recovery_id, &epoch, &bytes]).await?;
        Ok(())
    }

    pub async fn collaboration_recoveries(&self, id: &str) -> Result<Vec<String>> {
        Ok(self.db.lock().await.query("SELECT recovery_id FROM hcd_collaboration_recovery WHERE document_id=$1 ORDER BY created_at DESC,recovery_id DESC LIMIT 50", &[&id]).await?.iter().map(|row| row.get(0)).collect())
    }

    pub async fn collaboration_recovery(
        &self,
        id: &str,
        recovery_id: &str,
    ) -> Result<Option<Vec<u8>>> {
        Ok(self.db.lock().await.query_opt("SELECT state FROM hcd_collaboration_recovery WHERE document_id=$1 AND recovery_id=$2", &[&id,&recovery_id]).await?.map(|row| row.get(0)))
    }
}

fn safe_relative(relative: &str) -> bool {
    !relative.is_empty()
        && Path::new(relative)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn collect_files(root: &Path, directory: &Path, output: &mut Vec<String>) -> Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(anyhow!("symlink in HCD remote bundle"));
        }
        if metadata.is_dir() {
            collect_files(root, &path, output)?;
        } else if metadata.is_file() {
            let relative = path
                .strip_prefix(root)?
                .to_str()
                .ok_or_else(|| anyhow!("non-UTF8 HCD object path"))?
                .replace('\\', "/");
            if !safe_relative(&relative) {
                return Err(anyhow!("unsafe HCD object path"));
            }
            output.push(relative);
        }
    }
    Ok(())
}
