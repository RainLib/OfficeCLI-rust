//! Shared image production. Generation stages immutable assets; insertion is a
//! separate, revision/epoch guarded document operation. No model URL is fetched.
use super::*;
use base64::Engine;
use std::sync::atomic::{AtomicBool, Ordering};
pub(super) type JobStore = image_job_store::JobStore<Job>;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Job {
    pub(super) job_id: String,
    pub(super) document_id: String,
    pub(super) status: String,
    pub(super) prompt: String,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) model: String,
    pub(super) asset_hash: Option<String>,
    pub(super) error: Option<String>,
    pub(super) run_id: Option<String>,
    pub(super) created_at_epoch_ms: u64,
    #[serde(skip)]
    owner: String,
    #[serde(skip)]
    request_key: Option<String>,
    #[serde(skip)]
    request_hash: Option<String>,
    #[serde(skip)]
    request_attempt: u32,
    #[serde(skip)]
    href: Option<String>,
    #[serde(skip)]
    cancelled: Arc<AtomicBool>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Checkpoint {
    job: Job,
    owner: String,
    href: Option<String>,
    cancelled: bool,
    #[serde(default)]
    request_key: Option<String>,
    #[serde(default)]
    request_hash: Option<String>,
    #[serde(default)]
    request_attempt: u32,
}
impl image_job_store::JobRecord for Job {
    fn id(&self) -> &str {
        &self.job_id
    }
    fn fence(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
    fn checkpoint(&self) -> Result<Value> {
        Ok(serde_json::to_value(Checkpoint {
            job: self.clone(),
            owner: self.owner.clone(),
            href: self.href.clone(),
            cancelled: self.cancelled.load(Ordering::SeqCst),
            request_key: self.request_key.clone(),
            request_hash: self.request_hash.clone(),
            request_attempt: self.request_attempt,
        })?)
    }
    fn recover(value: Value, root: &std::path::Path) -> Result<Self> {
        let saved: Checkpoint = serde_json::from_value(value)?;
        let mut job = saved.job;
        anyhow::ensure!(
            valid_id(&job.document_id) && !saved.owner.is_empty(),
            "invalid image generation identity"
        );
        anyhow::ensure!(
            matches!(
                job.status.as_str(),
                "queued"
                    | "generating"
                    | "ready"
                    | "interrupted"
                    | "unavailable"
                    | "failed"
                    | "cancelled"
            ),
            "invalid image generation checkpoint"
        );
        job.owner = saved.owner;
        job.request_key = saved.request_key;
        job.request_hash = saved.request_hash;
        job.request_attempt = saved.request_attempt;
        job.href = saved.href;
        job.cancelled.store(saved.cancelled, Ordering::SeqCst);
        if matches!(job.status.as_str(), "queued" | "generating") {
            job.status = "interrupted".into();
            job.error =
                Some("服务已重启，图片生成已中断；不会自动重新请求模型。请核对后重新生成。".into());
            job.cancelled.store(true, Ordering::SeqCst);
        }
        if job.status == "ready" {
            let path = root.join(format!("{}.hcd", job.document_id));
            if !path.try_exists()? {
                job.status = "unavailable".into();
                job.error = Some("文档已移除或本地副本不可用；保留任务记录，不会自动重试。".into());
                job.cancelled.store(true, Ordering::SeqCst);
                return Ok(job);
            }
            let bundle = Bundle::open(path)?;
            let bytes = std::fs::read(
                bundle.resolve_href(
                    job.href
                        .as_deref()
                        .ok_or_else(|| anyhow!("missing generated image"))?,
                )?,
            )?;
            anyhow::ensure!(
                job.asset_hash.as_deref() == Some(hcd_core::hash_bytes(&bytes).as_str()),
                "generated image checksum differs"
            );
        }
        Ok(job)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    pub(super) prompt: String,
    pub(super) width: u32,
    pub(super) height: u32,
}
pub(super) fn model() -> String {
    std::env::var("HCD_OPENAI_IMAGE_MODEL").unwrap_or_else(|_| "gpt-image-2".into())
}
fn valid_request(r: &Request) -> Result<(), ApiError> {
    if r.prompt.trim().is_empty()
        || r.prompt.chars().count() > 8000
        || !(256..=3840).contains(&r.width)
        || !(256..=3840).contains(&r.height)
        || !r.width.is_multiple_of(16)
        || !r.height.is_multiple_of(16)
        || !(655360..=8294400).contains(&(u64::from(r.width) * u64::from(r.height)))
        || r.width.max(r.height) > r.width.min(r.height) * 3
    {
        return Err(bad("图片提示词及尺寸无效；尺寸须为 16 的倍数、长宽比不超过 3:1，像素数在 655360–8294400 之间。"));
    }
    Ok(())
}
pub(super) async fn list(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    state.image_jobs.ensure_healthy()?;
    open(&state, &id)?;
    let mut jobs: Vec<_> = state
        .image_jobs
        .lock()
        .await
        .values()
        .filter(|j| j.document_id == id)
        .cloned()
        .collect();
    jobs.sort_by_key(|j| j.created_at_epoch_ms);
    Ok(Json(
        json!({"model":model(),"available":agent_runs::Config::load().is_ok(),"jobs":jobs}),
    ))
}
pub(super) async fn start(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<Request>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let job = create(&state, &id, &headers, request, None).await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::to_value(job).map_err(internal)?),
    ))
}
pub(super) async fn create(
    state: &ServerState,
    id: &str,
    headers: &HeaderMap,
    request: Request,
    run_id: Option<String>,
) -> Result<Job, ApiError> {
    valid_request(&request)?;
    state.image_jobs.ensure_healthy()?;
    let actor = write_claims(state, headers, id)?;
    let manifest = open(state, id)?.manifest().map_err(hcd_error)?;
    if !matches!(
        manifest.source.format.as_str(),
        "docx" | "xlsx" | "pptx" | "pdf" | "md" | "html"
    ) {
        return Err(bad("此格式不支持插图。"));
    }
    let config = agent_runs::Config::load()?;
    let owner = actor
        .sub
        .clone()
        .ok_or_else(|| bad("image generation requires a signed identity"))?;
    let request_key = headers
        .get("x-hcd-tool-call-id")
        .and_then(|value| value.to_str().ok())
        .map(|value| hcd_core::hash_bytes(value.as_bytes()));
    if run_id.is_some() && request_key.is_none() {
        return Err(bad("missing Harness image request identity"));
    }
    let (request_attempt, request_expired) = if request_key.is_some() {
        let run_id = run_id
            .as_ref()
            .ok_or_else(|| bad("missing image task identity"))?;
        let attempt = headers
            .get("x-hcd-resume-attempt")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u32>().ok())
            .ok_or_else(|| bad("missing continuation attempt"))?;
        let runs = state.agent_runs.lock().await;
        let run = runs
            .get(run_id)
            .filter(|run| {
                run.document_id == id
                    && run.status == "running"
                    && !run.cancelled.load(Ordering::SeqCst)
                    && (run.agent_id == owner
                        || run.team.as_ref().is_some_and(|t| t.has_member(&owner)))
            })
            .ok_or_else(|| bad("image request does not belong to an active task"))?;
        if actor.worker_generation.is_none()
            || run.invocation.as_ref().is_none_or(|i| i.attempt != attempt)
        {
            return Err(bad("stale image worker"));
        }
        (
            attempt,
            agent_now().saturating_sub(run.created_at_epoch_ms) >= 3_600_000,
        )
    } else {
        (0, false)
    };
    let request_hash=request_key.as_ref().map(|_|hcd_core::hash_bytes(&serde_json::to_vec(&json!({"prompt":request.prompt,"width":request.width,"height":request.height,"model":model()})).expect("image request serialization")));
    let mut job = Job {
        job_id: uuid::Uuid::new_v4().to_string(),
        document_id: id.into(),
        status: "queued".into(),
        prompt: request.prompt,
        width: request.width,
        height: request.height,
        model: model(),
        asset_hash: None,
        error: None,
        run_id,
        created_at_epoch_ms: agent_now(),
        owner,
        request_key,
        request_hash,
        request_attempt,
        href: None,
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    {
        let mut jobs = state.image_jobs.lock().await;
        if let Some(previous) = jobs.values().find(|previous| {
            job.request_key.is_some()
                && previous.request_key == job.request_key
                && previous.document_id == id
                && previous.owner == job.owner
        }) {
            if previous.request_hash != job.request_hash {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "图片请求标识已用于其他生成内容".into(),
                ));
            }
            if matches!(previous.status.as_str(), "ready" | "queued" | "generating")
                || job.request_attempt <= previous.request_attempt
            {
                return Ok(previous.clone());
            }
            job.job_id = previous.job_id.clone();
        } else if request_expired {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "无法核对超过一小时保留期的图片请求；请检查已有候选并为剩余图片建立新任务。".into(),
            ));
        }
        jobs.retain(|_, job| {
            !matches!(
                job.status.as_str(),
                "ready" | "failed" | "cancelled" | "interrupted" | "unavailable"
            ) || agent_now().saturating_sub(job.created_at_epoch_ms) < 3600000
        });
        if jobs.len() >= 128
            || jobs
                .values()
                .filter(|job| matches!(job.status.as_str(), "queued" | "generating"))
                .count()
                >= 40
        {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "图片任务过多，请等待当前生成完成。".into(),
            ));
        }
        jobs.insert(job.job_id.clone(), job.clone());
        jobs.flush()?;
    }
    let worker_state = state.clone();
    let worker_job = job.clone();
    tokio::spawn(async move {
        let result = generate(&worker_state, &worker_job, config).await;
        let mut jobs = worker_state.image_jobs.lock().await;
        if let Some(job) = jobs.get_mut(&worker_job.job_id) {
            // An old provider response cannot overwrite a newly authorized
            // attempt that deliberately reuses this logical job identity.
            if !Arc::ptr_eq(&job.cancelled, &worker_job.cancelled) {
                return;
            }
            if job.cancelled.load(Ordering::SeqCst) {
                job.status = "cancelled".into();
                return;
            }
            match result {
                Ok((hash, href)) => {
                    job.asset_hash = Some(hash);
                    job.href = Some(href);
                    job.status = "ready".into();
                }
                Err(error) => {
                    job.error = Some(error.1);
                    job.status = "failed".into();
                }
            }
        }
    });
    Ok(job)
}
async fn generate(
    state: &ServerState,
    job: &Job,
    config: agent_runs::Config,
) -> Result<(String, String), ApiError> {
    let cancelled = async {
        loop {
            if job.cancelled.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    let production = async {
        let _permit = state.image_slots.acquire().await.map_err(internal)?;
        if let Some(current) = state.image_jobs.lock().await.get_mut(&job.job_id) {
            current.status = "generating".into();
        }
        state.image_jobs.ensure_healthy()?;
        let endpoint = std::env::var("HCD_OPENAI_IMAGE_BASE_URL")
            .unwrap_or_else(|_| config.endpoint.trim_end_matches("/responses").into());
        let endpoint =
            reqwest::Url::parse(&endpoint).map_err(|_| bad("invalid image API endpoint"))?;
        if !(endpoint.scheme() == "https"
            || endpoint.scheme() == "http"
                && matches!(
                    endpoint.host_str(),
                    Some("localhost" | "127.0.0.1" | "[::1]")
                ))
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(bad("image endpoint requires HTTPS or loopback HTTP"));
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(internal)?;
        let response=client.post(format!("{}/images/generations",endpoint.as_str().trim_end_matches('/'))).bearer_auth(config.key).json(&json!({"model":job.model,"prompt":job.prompt,"size":format!("{}x{}",job.width,job.height),"quality":"medium","output_format":"png","n":1})).send().await.map_err(|_|bad("图片生成连接失败，请重试。"))?;
        if !response.status().is_success() {
            return Err(bad(format!(
                "图片模型请求失败（HTTP {}）；图片尚未插入。",
                response.status().as_u16()
            )));
        }
        if response
            .content_length()
            .is_some_and(|n| n > 32 * 1024 * 1024)
        {
            return Err(bad("生成图片响应过大。"));
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| bad("图片生成响应中断。"))?
        {
            if bytes.len() + chunk.len() > 32 * 1024 * 1024 {
                return Err(bad("生成图片响应过大。"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| bad("图片服务响应无效。"))?;
        let encoded = value
            .pointer("/data/0/b64_json")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("图片服务没有返回图片数据；未插入任何内容。"))?;
        let png = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| bad("生成图片编码无效。"))?;
        if png.len() > 16 * 1024 * 1024 || !png.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err(bad("生成图片须为不超过 16 MiB 的 PNG。"));
        }
        let reader = image::ImageReader::new(std::io::Cursor::new(&png))
            .with_guessed_format()
            .map_err(|_| bad("生成图片格式无效。"))?;
        let (width, height) = reader
            .into_dimensions()
            .map_err(|_| bad("生成图片尺寸无效。"))?;
        if width != job.width || height != job.height {
            return Err(bad("图片服务返回的尺寸与请求不一致，未插入。"));
        }
        let asset = open(state, &job.document_id)?
            .stage_asset_from_reader("png", &mut std::io::Cursor::new(png))
            .map_err(hcd_error)?;
        Ok((asset.hash, asset.href))
    };
    tokio::select! {result=production=>result,()=cancelled=>Err(bad("图片生成已停止。"))}
}
pub(super) async fn ready(state: &ServerState, id: &str, job_id: &str) -> Result<Job, ApiError> {
    state.image_jobs.ensure_healthy()?;
    let jobs = state.image_jobs.lock().await;
    let job = jobs
        .get(job_id)
        .filter(|j| j.document_id == id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "图片任务不存在。".into()))?;
    if job.status != "ready" {
        return Err(bad(job
            .error
            .clone()
            .unwrap_or_else(|| "图片尚未生成完成。".into())));
    }
    Ok(job.clone())
}
pub(super) async fn wait(
    state: &ServerState,
    id: &str,
    job_id: &str,
    cancelled: &AtomicBool,
) -> Result<Job, ApiError> {
    loop {
        state.image_jobs.ensure_healthy()?;
        if cancelled.load(Ordering::SeqCst) {
            cancel_run(state, id, job_id).await;
            return Err(bad("图片任务已停止。"));
        }
        let job = state
            .image_jobs
            .lock()
            .await
            .get(job_id)
            .cloned()
            .ok_or_else(|| bad("图片任务丢失。"))?;
        match job.status.as_str() {
            "ready" => return Ok(job),
            "failed" | "cancelled" | "interrupted" | "unavailable" => {
                return Err(bad(job.error.unwrap_or_else(|| "图片生成未完成。".into())))
            }
            _ => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}
pub(super) async fn cancel_run(state: &ServerState, id: &str, run_or_job: &str) {
    for job in state.image_jobs.lock().await.values_mut().filter(|j| {
        j.document_id == id && (j.run_id.as_deref() == Some(run_or_job) || j.job_id == run_or_job)
    }) {
        if matches!(job.status.as_str(), "queued" | "generating") {
            job.cancelled.store(true, Ordering::SeqCst);
            job.status = "cancelled".into();
        }
    }
}
pub(super) async fn cancel(
    State(state): State<ServerState>,
    Path((id, job_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let actor = write_claims(&state, &headers, &id)?;
    {
        let jobs = state.image_jobs.lock().await;
        let job = jobs
            .get(&job_id)
            .filter(|j| j.document_id == id)
            .ok_or_else(|| bad("image job not found"))?;
        if actor.sub.as_deref() != Some(&job.owner) {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "仅发起者可以停止此图片任务。".into(),
            ));
        }
    }
    cancel_run(&state, &id, &job_id).await;
    state.image_jobs.ensure_healthy()?;
    Ok(Json(json!({"ok":true})))
}
pub(super) async fn content(
    State(state): State<ServerState>,
    Path((id, job_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let job = ready(&state, &id, &job_id).await?;
    let bundle = open(&state, &id)?;
    let path = bundle
        .resolve_href(job.href.as_deref().unwrap())
        .map_err(hcd_error)?;
    let bytes = tokio::fs::read(path).await.map_err(internal)?;
    if hcd_core::hash_bytes(&bytes) != job.asset_hash.unwrap() {
        return Err(internal("generated image checksum differs"));
    }
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "private, no-store"),
        ],
        bytes,
    )
        .into_response())
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Insert {
    expected_revision: u64,
    collaboration_epoch: u64,
    chunk_id: String,
    geometry: hcd_core::ImageGeometry,
    alt: String,
}
pub(super) async fn insert(
    State(state): State<ServerState>,
    Path((id, job_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(request): Json<Insert>,
) -> Result<Json<Value>, ApiError> {
    write_claims(&state, &headers, &id)?;
    let job = ready(&state, &id, &job_id).await?;
    let result=agent_tools::call(state,id.clone(),headers,"hcd_patch",json!({"document_id":id,"mode":"node","expected_revision":request.expected_revision,"collaboration_epoch":request.collaboration_epoch,"patch":{"schemaVersion":"hcd-patch/47","documentId":id,"patchId":format!("image-{}",hcd_core::hash_bytes(format!("{job_id}:{}",serde_json::to_string(&request).map_err(internal)?).as_bytes())),"baseRevision":request.expected_revision,"operations":[{"op":"image.insert","chunkId":request.chunk_id,"assetHash":job.asset_hash,"geometry":request.geometry,"alt":request.alt}]}})).await?;
    Ok(Json(result))
}
