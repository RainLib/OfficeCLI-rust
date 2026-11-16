//! Read-only workspace administration. Content mutations keep document authorization.
use super::*;
use std::sync::OnceLock;

static STARTED_AT: OnceLock<u64> = OnceLock::new();

pub(super) fn started_at() -> u64 {
    *STARTED_AT.get_or_init(agent_now)
}

pub(super) async fn session(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let actor = authorize_admin(&state, &headers)?;
    Ok(Json(json!({"scope": actor.scope, "documentId": actor.doc,
        "userId": actor.sub, "displayName": actor.name, "expiresAt": actor.exp})))
}

pub(super) async fn workspace(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers)?;
    let documents = tokio::task::spawn_blocking(move || workspace_documents(&state))
        .await
        .map_err(internal)??;
    Ok(Json(json!({"documents": documents})))
}

fn workspace_documents(state: &ServerState) -> Result<Vec<Value>, ApiError> {
    let records = read_jobs(state)?;
    let mut titles = HashMap::new();
    for job in records["jobs"].as_array().into_iter().flatten() {
        if job["kind"] == "import" {
            if let (Some(id), Some(filename)) =
                (job["documentId"].as_str(), job["filename"].as_str())
            {
                let title: String = filename
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or(filename)
                    .chars()
                    .filter(|character| !character.is_control())
                    .take(256)
                    .collect();
                if !title.is_empty() {
                    titles.entry(id.to_string()).or_insert(title);
                }
            }
        }
    }
    list_documents(&state.root)
        .map_err(hcd_error)?
        .into_iter()
        .map(|summary| {
            let bundle = open(state, &summary.document_id)?;
            let manifest = bundle.manifest().map_err(hcd_error)?;
            let revision = if summary.state == "COMPLETE" {
                Some(bundle.revision(summary.revision).map_err(hcd_error)?)
            } else {
                bundle.revision(summary.revision).ok()
            };
            let mut value = serde_json::to_value(&summary).map_err(internal)?;
            value["title"] = json!(titles
                .get(&summary.document_id)
                .unwrap_or(&summary.document_id));
            value["updatedAtEpochMs"] = json!(revision
                .as_ref()
                .map(|revision| revision.created_at_epoch_ms));
            value["sizeBytes"] = json!(manifest.source.size_bytes);
            value["authorName"] =
                json!(revision.and_then(|revision| revision.author_name.or(revision.author_id)));
            Ok(value)
        })
        .collect()
}

pub(super) async fn service(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers)?;
    let config = agent_runs::Config::load();
    Ok(Json(json!({
        "startedAtEpochMs": started_at(), "documentsRoot": state.root,
        "catalogRoot": state.catalog.root(), "defaultThemeRevisionId": state.default_theme,
        "storage": if state.remote.is_some() {"remote-cache"} else {"local"},
        "api": true, "mcp": true,
        "agentAvailable": config.is_ok(), "agentModel": config.ok().map(|c| c.model),
        "collaboration": "document-scoped", "exportConcurrency": 2,
        "version": env!("CARGO_PKG_VERSION")
    })))
}

pub(super) async fn agent_runs(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers)?;
    let mut runs: Vec<_> = state.agent_runs.lock().await.values().cloned().collect();
    runs.sort_by_key(|run| std::cmp::Reverse(run.updated_at_epoch_ms));
    let truncated = runs.len() > 200;
    runs.truncate(200);
    Ok(Json(json!({"runs": runs, "truncated": truncated,
        "persistence": "process", "startedAtEpochMs": started_at()})))
}

pub(super) async fn jobs(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers)?;
    tokio::task::spawn_blocking(move || read_jobs(&state))
        .await
        .map_err(internal)?
        .map(Json)
}

fn read_jobs(state: &ServerState) -> Result<Value, ApiError> {
    let entries = match std::fs::read_dir(state.root.join("jobs")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({"jobs": [], "unreadable": 0, "truncated": false}));
        }
        Err(error) => return Err(internal(error)),
    };
    let mut files = Vec::new();
    let mut unreadable = 0;
    for entry in entries {
        let entry = entry.map_err(internal)?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let meta = entry.metadata().map_err(internal)?;
        if !meta.is_file() || meta.len() > 1024 * 1024 {
            unreadable += 1;
            continue;
        }
        let updated = meta
            .modified()
            .map_err(internal)?
            .duration_since(UNIX_EPOCH)
            .map_err(internal)?
            .as_millis() as u64;
        files.push((updated, path));
    }
    files.sort_by_key(|(updated, _)| std::cmp::Reverse(*updated));
    let truncated = files.len() > 500;
    files.truncate(500);
    let mut jobs = Vec::new();
    for (updated, path) in files {
        let parsed = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .filter(|job| {
                job.is_object()
                    && job["jobId"].is_string()
                    && job["documentId"].is_string()
                    && job["state"].is_string()
            });
        let Some(mut job) = parsed else {
            unreadable += 1;
            continue;
        };
        job["updatedAtEpochMs"] = json!(updated);
        if job["kind"].is_null() {
            job["kind"] = json!("import");
        }
        if matches!(job["state"].as_str(), Some("running" | "queued")) && updated < started_at() {
            job["state"] = json!("interrupted");
            job["error"] = json!("服务重启后任务已中断，请检查文档后重新发起。");
        }
        jobs.push(job);
    }
    Ok(json!({"jobs": jobs, "unreadable": unreadable, "truncated": truncated}))
}

/// Track real export outcomes on disk; never invent a percentage for an opaque exporter.
struct ExportOutcome {
    path: PathBuf,
    job: Value,
    finished: bool,
}

impl Drop for ExportOutcome {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        self.job["state"] = json!("interrupted");
        self.job["error"] =
            json!("Export request ended before completion was confirmed; prepare the file again.");
        let temporary = self.path.with_extension("interrupted.tmp");
        if let Ok(bytes) = serde_json::to_vec(&self.job) {
            if std::fs::write(&temporary, bytes).is_ok() {
                let _ = std::fs::rename(temporary, &self.path);
            }
        }
    }
}

pub(super) async fn track_export<T>(
    state: &ServerState,
    id: &str,
    format: &str,
    revision: Option<u64>,
    actor: &Claims,
    work: impl std::future::Future<Output = Result<T, ApiError>>,
) -> Result<T, ApiError> {
    let revision = revision.unwrap_or(open(state, id)?.manifest().map_err(hcd_error)?.revision);
    let job_id = format!("export-{}", uuid::Uuid::new_v4());
    let directory = state.root.join("jobs");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(internal)?;
    let path = directory.join(format!("{job_id}.json"));
    let mut job = json!({"jobId": job_id, "documentId": id, "kind": "export",
        "format": format, "revision": revision, "state": "running",
        "createdAtEpochMs": agent_now(), "actor": actor.name.as_ref().or(actor.sub.as_ref())});
    let mut outcome = ExportOutcome {
        path: path.clone(),
        job: job.clone(),
        finished: false,
    };
    persist_job(&path, &job).await.map_err(internal)?;
    let result = work.await;
    job["state"] = json!(if result.is_ok() {
        "completed"
    } else {
        "failed"
    });
    if let Err(error) = &result {
        job["error"] = json!(error.1);
    }
    match persist_job(&path, &job).await {
        Ok(()) => outcome.finished = true,
        Err(error) => eprintln!("could not persist export outcome {job_id}: {error}"),
    }
    result
}

async fn persist_job(path: &std::path::Path, job: &Value) -> Result<()> {
    let temporary = path.with_extension("tmp");
    tokio::fs::write(&temporary, serde_json::to_vec(job)?).await?;
    tokio::fs::rename(&temporary, path).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::tests::{bearer_as, test_state};
    use super::*;
    const SECRET: &[u8] = b"admin-test-secret-must-have-at-least-32-bytes";

    #[tokio::test]
    async fn admin_metadata_requires_signed_admin_scope() {
        let root = tempfile::tempdir().unwrap();
        let state = test_state(SECRET, root.path());
        assert_eq!(
            service(State(state.clone()), HeaderMap::new())
                .await
                .unwrap_err()
                .0,
            StatusCode::UNAUTHORIZED
        );
        for (doc, scope) in [
            ("doc-1", "read"),
            ("doc-1", "write"),
            ("*", "upload"),
            ("doc-1", "admin"),
        ] {
            let headers = bearer_as(SECRET, doc, scope, None, None);
            assert_eq!(
                session(State(state.clone()), headers.clone())
                    .await
                    .unwrap_err()
                    .0,
                StatusCode::FORBIDDEN
            );
            assert_eq!(
                workspace(State(state.clone()), headers.clone())
                    .await
                    .unwrap_err()
                    .0,
                StatusCode::FORBIDDEN
            );
            assert_eq!(
                service(State(state.clone()), headers.clone())
                    .await
                    .unwrap_err()
                    .0,
                StatusCode::FORBIDDEN
            );
            assert_eq!(
                jobs(State(state.clone()), headers.clone())
                    .await
                    .unwrap_err()
                    .0,
                StatusCode::FORBIDDEN
            );
            assert_eq!(
                agent_runs(State(state.clone()), headers)
                    .await
                    .unwrap_err()
                    .0,
                StatusCode::FORBIDDEN
            );
        }
        let headers = bearer_as(SECRET, "*", "admin", Some("admin-user"), Some("Operator"));
        let current = session(State(state.clone()), headers.clone())
            .await
            .unwrap()
            .0;
        assert_eq!(current["scope"], "admin");
        assert_eq!(current["userId"], "admin-user");
        assert_eq!(current["displayName"], "Operator");
        assert!(current["expiresAt"].as_u64().unwrap() > agent_now() / 1000);
        assert!(service(State(state.clone()), headers.clone())
            .await
            .unwrap()
            .0["api"]
            .as_bool()
            .unwrap());
        assert!(workspace(State(state.clone()), headers.clone())
            .await
            .unwrap()
            .0["documents"]
            .as_array()
            .unwrap()
            .is_empty());
        // Administrator metadata access does not imply content read/write access.
        assert_eq!(
            authorize(&state, &headers, "doc-1", true).unwrap_err().0,
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn jobs_report_corrupt_records_and_interrupted_work() {
        let root = tempfile::tempdir().unwrap();
        let state = test_state(SECRET, root.path());
        let directory = root.path().join("jobs");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("bad.json"), "{").unwrap();
        std::fs::write(
            directory.join("good.json"),
            r#"{"jobId":"job-1","documentId":"doc-1","state":"completed"}"#,
        )
        .unwrap();
        let stale = directory.join("stale.json");
        std::fs::write(
            &stale,
            r#"{"jobId":"job-2","documentId":"doc-1","state":"running","kind":"export"}"#,
        )
        .unwrap();
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1)))
            .unwrap();
        let result = read_jobs(&state).unwrap();
        assert_eq!(result["unreadable"], 1);
        let records = result["jobs"].as_array().unwrap();
        let finished = records.iter().find(|job| job["jobId"] == "job-1").unwrap();
        assert_eq!(finished["kind"], "import");
        assert_eq!(finished["state"], "completed");
        let interrupted = records.iter().find(|job| job["jobId"] == "job-2").unwrap();
        assert_eq!(interrupted["state"], "interrupted");
        assert_eq!(interrupted["kind"], "export");
        assert!(interrupted["error"].is_string());
    }

    #[test]
    fn jobs_bound_history_and_disclose_truncation() {
        let root = tempfile::tempdir().unwrap();
        let state = test_state(SECRET, root.path());
        let directory = root.path().join("jobs");
        std::fs::create_dir(&directory).unwrap();
        for index in 0..501 {
            std::fs::write(
                directory.join(format!("{index}.json")),
                serde_json::to_vec(
                    &json!({"jobId": index.to_string(), "documentId":"doc-1", "state":"completed"}),
                )
                .unwrap(),
            )
            .unwrap();
        }
        let result = read_jobs(&state).unwrap();
        assert_eq!(result["truncated"], true);
        assert_eq!(result["jobs"].as_array().unwrap().len(), 500);
    }

    #[tokio::test]
    async fn real_exports_record_success_failure_and_selected_revision() {
        let root = tempfile::tempdir().unwrap();
        let state = test_state(SECRET, root.path());
        let sources = root.path().join("sources");
        std::fs::create_dir(&sources).unwrap();
        let source = sources.join("export-doc.txt");
        std::fs::write(&source, "Admin export acceptance").unwrap();
        hcd_formats::import_document(
            &source,
            root.path().join("export-doc.hcd"),
            &hcd_formats::ImportOptions::new("export-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let headers = bearer_as(SECRET, "export-doc", "read", Some("export-user"), None);
        let initial = open(&state, "export-doc")
            .unwrap()
            .manifest()
            .unwrap()
            .revision;
        let ticket = exports::prepare_download(
            State(state.clone()),
            Path(("export-doc".into(), "html".into())),
            Query(serde_json::from_value(json!({"revision": initial, "source": false})).unwrap()),
            headers.clone(),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(ticket["revision"], initial);
        assert!(ticket["url"]
            .as_str()
            .unwrap()
            .starts_with("/v1/downloads/"));
        let failure = exports::prepare_download(
            State(state.clone()),
            Path(("export-doc".into(), "invalid-format".into())),
            Query(serde_json::from_value(json!({"revision": initial})).unwrap()),
            headers,
        )
        .await;
        assert!(failure.is_err());
        let records = read_jobs(&state).unwrap();
        let jobs = records["jobs"].as_array().unwrap();
        assert_eq!(jobs.len(), 2);
        let success = jobs.iter().find(|job| job["format"] == "html").unwrap();
        assert_eq!(success["state"], "completed");
        assert_eq!(success["revision"], initial);
        assert_eq!(success["actor"], "export-user");
        let failed = jobs
            .iter()
            .find(|job| job["format"] == "invalid-format")
            .unwrap();
        assert_eq!(failed["state"], "failed");
        assert!(failed["error"].is_string());
    }

    #[tokio::test]
    async fn interrupted_export_requests_do_not_stay_running() {
        let root = tempfile::tempdir().unwrap();
        let state = test_state(SECRET, root.path());
        let actor = claims(
            &state,
            &bearer_as(SECRET, "doc-1", "read", None, None),
            "doc-1",
        )
        .unwrap();
        // The optional revision still validates the document before tracking.
        let source = root.path().join("source.txt");
        std::fs::write(&source, "Export interruption").unwrap();
        hcd_formats::import_document(
            &source,
            root.path().join("doc-1.hcd"),
            &hcd_formats::ImportOptions::new("doc-1"),
            |_| Ok(()),
        )
        .unwrap();
        let result = tokio::time::timeout(
            Duration::from_millis(20),
            track_export(
                &state,
                "doc-1",
                "txt",
                Some(0),
                &actor,
                std::future::pending::<Result<(), ApiError>>(),
            ),
        )
        .await;
        assert!(result.is_err());
        let jobs = read_jobs(&state).unwrap();
        assert_eq!(jobs["jobs"][0]["state"], "interrupted");
    }

    #[tokio::test]
    async fn global_runs_redact_internal_credentials_and_preserve_commits() {
        let root = tempfile::tempdir().unwrap();
        let state = test_state(SECRET, root.path());
        let run = super::super::agent_runs::Run {
            run_id: "run-1".into(),
            document_id: "doc-1".into(),
            agent_id: "agent-1".into(),
            name: "Review".into(),
            task: "Review the document".into(),
            status: "completed".into(),
            model: "test-model".into(),
            created_at_epoch_ms: 1,
            updated_at_epoch_ms: 2,
            events: vec![json!({"type":"verify", "revision":3})],
            result: "Verified".into(),
            committed_revisions: vec![2, 3],
            agent_count: 1,
            mode: "edit".into(),
            team: None,
            workflow_id: None,
            prepared_patches: Some(vec![json!({"internal":"private patch"})]),
            invocation: None,
            owner: "private-owner".into(),
            cancelled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        state.agent_runs.lock().await.insert("run-1".into(), run);
        let result = agent_runs(State(state), bearer_as(SECRET, "*", "admin", None, None))
            .await
            .unwrap()
            .0;
        assert_eq!(result["persistence"], "process");
        let record = &result["runs"][0];
        assert_eq!(record["committedRevisions"], json!([2, 3]));
        assert_eq!(record["events"][0]["revision"], 3);
        for field in ["owner", "cancelled", "preparedPatches", "prepared_patches"] {
            assert!(record.get(field).is_none());
        }
        assert!(!result.to_string().contains("private-owner"));
    }

    #[tokio::test]
    async fn job_updates_keep_import_metadata() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("job.json");
        write_job(&path, None, "job-1", json!({"jobId":"job-1", "documentId":"doc-1", "state":"queued", "kind":"import", "filename":"proposal.txt", "format":"txt"})).await.unwrap();
        write_job(
            &path,
            None,
            "job-1",
            json!({"jobId":"job-1", "documentId":"doc-1", "state":"completed"}),
        )
        .await
        .unwrap();
        let result: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(result["state"], "completed");
        assert_eq!(result["filename"], "proposal.txt");
        assert_eq!(result["kind"], "import");
        assert!(
            result["updatedAtEpochMs"].as_u64().unwrap()
                >= result["createdAtEpochMs"].as_u64().unwrap()
        );
    }
}
