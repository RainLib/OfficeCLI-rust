//! Independent image editing, candidate jobs and revision-scoped region leases.
//! Candidates never mutate a document until a guarded apply succeeds.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use hcd_core::image_layers::{self, ImageLayer, ImageLayerBlend};
use hcd_formats::images::{
    decode_raster, image_content, is_image_format, png_bytes, MAX_IMAGE_BYTES,
};
use image::{DynamicImage, RgbaImage};
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) type Store = image_job_store::JobStore<ImageJob>;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ImageJob {
    job_id: String,
    document_id: String,
    source_revision: u64,
    status: String,
    prompt: String,
    model: String,
    planning_model: String,
    shared_context: String,
    agents: Vec<Worker>,
    region: [u32; 4],
    width: u32,
    height: u32,
    created_at_epoch_ms: u64,
    expires_at_epoch_ms: u64,
    error: Option<String>,
    asset_hash: Option<String>,
    mask_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    applied_revision: Option<u64>,
    #[serde(skip)]
    mask_href: String,
    owner: String,
    #[serde(skip)]
    href: Option<String>,
    #[serde(skip)]
    cancelled: Arc<AtomicBool>,
    #[serde(skip)]
    apply_author: Option<ApplyAuthor>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Worker {
    name: String,
    role: String,
    status: String,
    message: String,
    position: [f64; 2],
}
#[derive(Clone, Serialize, Deserialize)]
struct ApplyAuthor {
    id: Option<String>,
    name: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Checkpoint {
    job: ImageJob,
    mask_href: String,
    href: Option<String>,
    cancelled: bool,
    apply_author: Option<ApplyAuthor>,
}
impl image_job_store::JobRecord for ImageJob {
    fn id(&self) -> &str {
        &self.job_id
    }
    fn fence(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
    fn checkpoint(&self) -> Result<Value> {
        Ok(serde_json::to_value(Checkpoint {
            job: self.clone(),
            mask_href: self.mask_href.clone(),
            href: self.href.clone(),
            cancelled: self.cancelled.load(Ordering::SeqCst),
            apply_author: self.apply_author.clone(),
        })?)
    }
    fn recover(value: Value, root: &std::path::Path) -> Result<Self> {
        let saved: Checkpoint = serde_json::from_value(value)?;
        let mut job = saved.job;
        anyhow::ensure!(
            valid_id(&job.document_id) && !job.owner.is_empty(),
            "invalid image editing identity"
        );
        anyhow::ensure!(
            job.source_revision < hcd_core::MAX_REVISION
                && matches!(
                    job.status.as_str(),
                    "queued"
                        | "planning"
                        | "generating"
                        | "checking"
                        | "ready"
                        | "applying"
                        | "applied"
                        | "interrupted"
                        | "unavailable"
                        | "failed"
                        | "cancelled"
                        | "discarded"
                ),
            "invalid image editing checkpoint"
        );
        job.href = saved.href;
        job.mask_href = saved.mask_href;
        job.apply_author = saved.apply_author;
        job.cancelled.store(saved.cancelled, Ordering::SeqCst);
        let path = root.join(format!("{}.hcd", job.document_id));
        if !path.try_exists()? {
            job.status = "unavailable".into();
            job.error = Some("图片文档已移除或本地副本不可用；保留任务记录，不会自动重试。".into());
            job.cancelled.store(true, Ordering::SeqCst);
            return Ok(job);
        }
        let bundle = Bundle::open(path)?;
        if job.status == "applying" {
            // Reconcile the commit/receipt crash window by exact immutable ID.
            // An absent commit becomes a candidate, never an automatic apply.
            job.status = "ready".into();
            let revision = job.source_revision + 1;
            if bundle.manifest()?.revision >= revision {
                let mut receipt = bundle.revision(revision)?;
                if receipt.patch_id.as_deref() == Some(&format!("image-apply-{}", job.job_id))
                    && receipt.patch_base_revision == Some(job.source_revision)
                {
                    job.status = "applied".into();
                    job.applied_revision = Some(revision);
                    if receipt.author_id.is_none() {
                        if let Some(author) = &job.apply_author {
                            receipt.author_id = author.id.clone();
                            receipt.author_name = author.name.clone();
                            bundle.write_revision(&receipt)?;
                        }
                    }
                }
            }
        }
        if matches!(
            job.status.as_str(),
            "queued" | "planning" | "generating" | "checking"
        ) {
            job.status = "interrupted".into();
            job.error =
                Some("服务已重启，任务已中断、区域锁已释放；蒙版已保留，请核对后重新生成。".into());
            job.cancelled.store(true, Ordering::SeqCst);
            for worker in &mut job.agents {
                if worker.status != "done" {
                    worker.status = "stopped".into();
                }
            }
        }
        let mask = std::fs::read(bundle.resolve_href(&job.mask_href)?)?;
        anyhow::ensure!(
            hcd_core::hash_bytes(&mask) == job.mask_hash,
            "image mask checksum differs"
        );
        if let Some(href) = &job.href {
            let bytes = std::fs::read(bundle.resolve_href(href)?)?;
            anyhow::ensure!(
                job.asset_hash.as_deref() == Some(hcd_core::hash_bytes(&bytes).as_str()),
                "image candidate checksum differs"
            );
        }
        Ok(job)
    }
}
fn active(j: &ImageJob) -> bool {
    matches!(j.status.as_str(), "planning" | "generating" | "checking")
        && j.expires_at_epoch_ms > agent_now()
        && !j.cancelled.load(Ordering::SeqCst)
}
fn conflict(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::CONFLICT, message.into())
}
fn image_bundle(state: &ServerState, id: &str) -> Result<Bundle, ApiError> {
    let b = open(state, id)?;
    if !is_image_format(&b.manifest().map_err(hcd_error)?.source.format) {
        return Err(bad("此操作需要独立图片文档"));
    }
    Ok(b)
}
fn bytes64(text: &str) -> Result<Vec<u8>, ApiError> {
    if text.len() > MAX_IMAGE_BYTES * 4 / 3 + 8 {
        return Err(bad("图片超过 32 MiB"));
    }
    STANDARD.decode(text).map_err(|_| bad("无效图片编码"))
}
fn guard_revision(bundle: &Bundle, expected: u64) -> Result<(), ApiError> {
    if bundle.manifest().map_err(hcd_error)?.revision != expected {
        return Err(conflict(
            "图片版本已更新，候选与本地草稿已保留；请读取最新版本后再应用。",
        ));
    }
    Ok(())
}

pub(super) async fn info(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let b = image_bundle(&state, &id)?;
    let m = b.manifest().map_err(hcd_error)?;
    let data = image_content(&b, Some(m.revision)).map_err(hcd_error)?;
    let (img, _) = decode_raster(&data).map_err(hcd_error)?;
    let layers =
        image_layers::snapshot(&b, m.revision, (img.width(), img.height())).map_err(hcd_error)?;
    if integration::access(&state, &headers, &id).await?.is_some() {
        return Ok(Json(
            json!({"documentId":id,"revision":m.revision,"width":img.width(),"height":img.height(),"format":m.source.format,"bytes":data.len(),"sourceBytes":m.source.size_bytes,"hasAlpha":img.to_rgba8().pixels().any(|p|p[3]<255),"imageModel":"","planningModel":"","aiAvailable":false,"aiReason":"当前宿主接入尚未启用 AI 委托","exportFormats":["png","jpeg","webp"],"maxAgents":0,"imageLayers":layers}),
        ));
    }
    let config = agent_runs::Config::load();
    Ok(Json(
        json!({"documentId":id,"revision":m.revision,"width":img.width(),"height":img.height(),"format":m.source.format,"bytes":data.len(),"sourceBytes":m.source.size_bytes,"hasAlpha":img.to_rgba8().pixels().any(|p|p[3]<255),"imageModel":image_jobs::model(),"planningModel":config.as_ref().map(|c|c.model.as_str()).unwrap_or("gpt-6.1-sol"),"aiAvailable":config.is_ok(),"aiReason":config.err().map(|e|e.1),"exportFormats":["png","jpeg","webp"],"maxAgents":4,"imageLayers":layers}),
    ))
}
pub(super) async fn content(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let b = image_bundle(&state, &id)?;
    let bytes = image_content(&b, query.revision).map_err(hcd_error)?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "private, no-store"),
        ],
        bytes,
    )
        .into_response())
}
pub(super) async fn layer_thumbnail(
    State(state): State<ServerState>,
    Path((id, hash)): Path<(String, String)>,
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = image_bundle(&state, &id)?;
    let head = bundle.manifest().map_err(hcd_error)?.revision;
    let revision = query.revision.unwrap_or(head);
    if revision > head {
        return Err(bad("图层版本超出当前文档版本"));
    }
    static THUMBNAILS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let _slot = THUMBNAILS.acquire().await.map_err(internal)?;
    let bytes =
        tokio::task::spawn_blocking(move || image_layers::thumbnail(&bundle, revision, &hash))
            .await
            .map_err(internal)?
            .map_err(hcd_error)?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "private, no-store"),
        ],
        bytes,
    )
        .into_response())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Commit {
    expected_revision: u64,
    png: String,
}
pub(super) async fn commit(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(r): Json<Commit>,
) -> Result<Json<Value>, ApiError> {
    let actor = write_claims(&state, &headers, &id)?;
    let bytes = bytes64(&r.png)?;
    let (img, ext) = decode_raster(&bytes).map_err(hcd_error)?;
    if ext != "png" {
        return Err(bad("编辑版本必须使用 PNG"));
    }
    let _guard = state.collaboration_lock.lock().await;
    check_collaboration_epoch(&state, &id, &headers).await?;
    check_agent_patch(&state, &id, &headers, &actor).await?;
    check_region(&state, &id, None).await?;
    let b = image_bundle(&state, &id)?;
    guard_revision(&b, r.expected_revision)?;
    let revision = commit_pixels(
        &state,
        &b,
        &actor,
        &img,
        &headers,
        PixelCommit {
            expected: r.expected_revision,
            patch_id: &uuid::Uuid::new_v4().to_string(),
            region: None,
        },
    )
    .await?;
    Ok(Json(json!({"revision":revision})))
}
struct PixelCommit<'a> {
    expected: u64,
    patch_id: &'a str,
    region: Option<[u32; 4]>,
}

fn pixels_patch(
    b: &Bundle,
    img: &DynamicImage,
    commit: &PixelCommit<'_>,
) -> Result<PatchBatch, ApiError> {
    let id = b.manifest().map_err(hcd_error)?.document_id;
    let expected = commit.expected;
    let patch_id = commit.patch_id;
    if let Some(mut snapshot) = image_layers::saved_snapshot(b, expected).map_err(hcd_error)? {
        let (name, x, y, raster) = if let Some([x, y, width, height]) = commit.region {
            if (img.width(), img.height()) != (snapshot.stack.width, snapshot.stack.height)
                || width == 0
                || height == 0
                || x.checked_add(width).is_none_or(|edge| edge > img.width())
                || y.checked_add(height).is_none_or(|edge| edge > img.height())
            {
                return Err(bad("重绘区域超出图片范围"));
            }
            (
                "局部重绘结果",
                x,
                y,
                std::borrow::Cow::Owned(img.crop_imm(x, y, width, height)),
            )
        } else {
            snapshot.stack.width = img.width();
            snapshot.stack.height = img.height();
            ("调整结果", 0, 0, std::borrow::Cow::Borrowed(img))
        };
        let bytes = png_bytes(&raster).map_err(hcd_error)?;
        let staged = b
            .stage_asset_from_reader("png", &mut bytes.as_slice())
            .map_err(hcd_error)?;
        let mut layer = ImageLayer::at(
            hcd_core::stable_node_id(&[&id, patch_id, "image-result"]),
            name.into(),
            staged.hash,
            (x as i32, y as i32, raster.width(), raster.height()),
        );
        layer.blend = ImageLayerBlend::Replace;
        snapshot.stack.layers.push(layer);
        return serde_json::from_value(json!({"schemaVersion":"hcd-patch/63","documentId":id,"patchId":patch_id,"baseRevision":expected,
            "operations":[{"op":"image.layers.set","nodeId":snapshot.node_id,"stack":snapshot.stack,"precondition":{"visualHash":snapshot.visual_hash}}]})).map_err(internal);
    }
    let node = hcd_core::extract_image_page(b, None, 1)
        .map_err(hcd_error)?
        .entries
        .into_iter()
        .next()
        .ok_or_else(|| bad("缺少图片节点"))?;
    let data = png_bytes(img).map_err(hcd_error)?;
    let staged = b
        .stage_asset_from_reader("png", &mut data.as_slice())
        .map_err(hcd_error)?;
    serde_json::from_value(json!({"schemaVersion":"hcd-patch/3","documentId":id,"patchId":patch_id,"baseRevision":expected,"operations":[{"op":"image.replace","nodeId":node.node.node_id,"assetHash":staged.hash,"precondition":{"visualHash":node.node.visual_hash}},{"op":"image.geometry","nodeId":node.node.node_id,"geometry":{"x":0,"y":0,"width":f64::from(img.width())*0.75,"height":f64::from(img.height())*0.75,"unit":"pt"},"precondition":{"visualHash":node.node.visual_hash}}]})).map_err(internal)
}

async fn commit_pixels(
    state: &ServerState,
    b: &Bundle,
    actor: &Claims,
    img: &DynamicImage,
    headers: &HeaderMap,
    commit: PixelCommit<'_>,
) -> Result<u64, ApiError> {
    let id = &b.manifest().map_err(hcd_error)?.document_id;
    let expected = commit.expected;
    let patch = pixels_patch(b, img, &commit)?;
    agent_team::check_write(
        state,
        id,
        actor,
        headers,
        &serde_json::to_value(&patch.operations).map_err(internal)?,
    )
    .await?;
    let result = apply_patch(b, &patch, expected).map_err(hcd_error)?;
    stamp_revision_author(b, result.revision, actor)?;
    publish_mutation(state, id, b, expected).await?;
    Ok(result.revision)
}
// All full-image edits must use the same lease guard, including generic MCP patches.
pub(super) async fn check_region(
    state: &ServerState,
    id: &str,
    except: Option<&str>,
) -> Result<(), ApiError> {
    state.image_edits.ensure_healthy()?;
    if let Some(j) = state
        .image_edits
        .lock()
        .await
        .values()
        .find(|j| j.document_id == id && except != Some(j.job_id.as_str()) && active(j))
    {
        return Err(conflict(format!(
            "区域由 {} 的图片任务占用；请等待完成或由发起者取消。",
            j.owner
        )));
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CopyRequest {
    filename: String,
    data: String,
}
pub(super) async fn copy(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(r): Json<CopyRequest>,
) -> Result<Json<Value>, ApiError> {
    let actor = write_claims(&state, &headers, &id)?;
    image_bundle(&state, &id)?;
    create_copy(&state, &actor, r).await.map(Json)
}
pub(super) async fn upload(
    State(state): State<ServerState>,
    Query(query): Query<ImportQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let actor = authorize_upload(&state, &headers)?;
    create_copy(
        &state,
        &actor,
        CopyRequest {
            filename: query.filename,
            data: STANDARD.encode(&body),
        },
    )
    .await
    .map(Json)
}
async fn create_copy(
    state: &ServerState,
    actor: &Claims,
    r: CopyRequest,
) -> Result<Value, ApiError> {
    let data = bytes64(&r.data)?;
    let (_, ext) = decode_raster(&data).map_err(hcd_error)?;
    let requested = std::path::Path::new(&r.filename)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if requested != ext && !(requested == "jpeg" && ext == "jpg") {
        return Err(bad("文件扩展名与实际编码不一致"));
    }
    let id = format!("image-{}", uuid::Uuid::new_v4());
    let sources = state.root.join("sources");
    tokio::fs::create_dir_all(&sources)
        .await
        .map_err(internal)?;
    let source = sources.join(format!("{id}.{ext}"));
    tokio::fs::write(&source, &data).await.map_err(internal)?;
    let dest = state.root.join(format!("{id}.hcd"));
    let source_job = source.clone();
    let dest_job = dest.clone();
    let id_job = id.clone();
    let imported = tokio::task::spawn_blocking(move || {
        hcd_formats::import_document(
            &source_job,
            &dest_job,
            &hcd_formats::ImportOptions::new(&id_job),
            |_| Ok(()),
        )
    })
    .await
    .map_err(internal)?;
    if let Err(e) = imported {
        let _ = tokio::fs::remove_file(&source).await;
        let _ = tokio::fs::remove_dir_all(&dest).await;
        return Err(hcd_error(e));
    }
    if let Some(remote) = &state.remote {
        remote
            .publish(&id, &dest, Some(&source), None)
            .await
            .map_err(internal)?;
    }
    let now = (agent_now() / 1000) as usize;
    let derived = Claims {
        doc: id.clone(),
        scope: "write".into(),
        sub: Some(
            actor
                .sub
                .clone()
                .unwrap_or_else(|| format!("image-user-{}", uuid::Uuid::new_v4())),
        ),
        name: actor.name.clone(),
        aud: "hcd-core".into(),
        iat: now,
        exp: actor.exp.min(now + 3600),
        worker_generation: actor.worker_generation.clone(),
        integration_session: actor.integration_session.clone(),
    };
    let token = encode(
        &Header::new(Algorithm::HS256),
        &derived,
        &EncodingKey::from_secret(&state.secret),
    )
    .map_err(internal)?;
    let title = std::path::Path::new(&r.filename)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("图片.png")
        .chars()
        .take(256)
        .collect::<String>();
    Ok(json!({"documentId":id,"token":token,"title":title,"format":ext,"bytes":data.len()}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Inpaint {
    expected_revision: u64,
    mask: String,
    prompt: String,
    agents: usize,
    feather: f32,
}
fn feather_mask(mask: &RgbaImage, radius: f32) -> Result<image::GrayImage, ApiError> {
    let mut alpha = image::GrayImage::new(mask.width(), mask.height());
    for (x, y, p) in mask.enumerate_pixels() {
        alpha.put_pixel(x, y, image::Luma([p[3]]));
    }
    if !alpha.pixels().any(|p| p[0] > 0) {
        return Err(bad("请先涂抹需要修改的区域"));
    }
    Ok(if radius > 0. {
        image::imageops::blur(&alpha, radius / 2.)
    } else {
        alpha
    })
}
fn bounds(mask: &image::GrayImage) -> [u32; 4] {
    let (mut x0, mut y0, mut x1, mut y1) = (mask.width(), mask.height(), 0, 0);
    for (x, y, p) in mask.enumerate_pixels() {
        if p[0] > 0 {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x + 1);
            y1 = y1.max(y + 1);
        }
    }
    [x0, y0, x1 - x0, y1 - y0]
}
fn overlap(a: [u32; 4], b: [u32; 4]) -> bool {
    a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}
/// Integer compositing guarantees every zero-alpha source pixel is unchanged.
fn composite(source: &RgbaImage, generated: &RgbaImage, mask: &image::GrayImage) -> RgbaImage {
    let mut out = source.clone();
    for (x, y, p) in out.enumerate_pixels_mut() {
        let a = u32::from(mask.get_pixel(x, y)[0]);
        if a == 0 {
            continue;
        }
        let g = generated.get_pixel(x, y);
        for c in 0..4 {
            p[c] = ((u32::from(p[c]) * (255 - a) + u32::from(g[c]) * a + 127) / 255) as u8;
        }
    }
    out
}
pub(super) async fn jobs(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    state.image_edits.ensure_healthy()?;
    image_bundle(&state, &id)?;
    let mut jobs: Vec<_> = state
        .image_edits
        .lock()
        .await
        .values()
        .filter(|j| j.document_id == id)
        .cloned()
        .collect();
    jobs.sort_by_key(|j| j.created_at_epoch_ms);
    Ok(Json(json!({"jobs":jobs})))
}
pub(super) async fn start(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(r): Json<Inpaint>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    state.image_edits.ensure_healthy()?;
    let actor = write_claims(&state, &headers, &id)?;
    let owner = actor.sub.ok_or_else(|| bad("图片协作需要签名用户身份"))?;
    if r.prompt.trim().is_empty()
        || r.prompt.chars().count() > 8000
        || !(1..=4).contains(&r.agents)
        || !r.feather.is_finite()
        || !(0.0..=64.0).contains(&r.feather)
    {
        return Err(bad("提示词、Agent 数量或羽化参数无效"));
    }
    let config = agent_runs::Config::load()?;
    let _guard = state.collaboration_lock.lock().await;
    check_collaboration_epoch(&state, &id, &headers).await?;
    let b = image_bundle(&state, &id)?;
    guard_revision(&b, r.expected_revision)?;
    let source = decode_raster(&image_content(&b, None).map_err(hcd_error)?)
        .map_err(hcd_error)?
        .0
        .to_rgba8();
    let mask = decode_raster(&bytes64(&r.mask)?)
        .map_err(hcd_error)?
        .0
        .to_rgba8();
    if mask.dimensions() != source.dimensions() {
        return Err(bad("蒙版与原图尺寸必须一致"));
    }
    let mask = feather_mask(&mask, r.feather)?;
    let region = bounds(&mask);
    let mut shared_mask = RgbaImage::new(mask.width(), mask.height());
    for (x, y, p) in shared_mask.enumerate_pixels_mut() {
        *p = image::Rgba([255, 255, 255, mask.get_pixel(x, y)[0]]);
    }
    let mask_png = png_bytes(&DynamicImage::ImageRgba8(shared_mask)).map_err(hcd_error)?;
    let mask_asset = b
        .stage_asset_from_reader("png", &mut mask_png.as_slice())
        .map_err(hcd_error)?;
    let now = agent_now();
    let expires = now + 360_000;
    let center = [
        f64::from(region[0] + region[2] / 2) / f64::from(source.width()),
        f64::from(region[1] + region[3] / 2) / f64::from(source.height()),
    ];
    let roles = if r.agents == 1 {
        vec![("拾色", "局部重绘")]
    } else {
        let mut v = vec![("折线", "读取与规划"), ("拾色", "局部重绘")];
        if r.agents >= 3 {
            v.push(("尺规", "边界检查"));
        }
        if r.agents == 4 {
            v.push(("映光", "视觉核对"));
        }
        v
    };
    let mut job = ImageJob {
        job_id: uuid::Uuid::new_v4().to_string(),
        document_id: id.clone(),
        source_revision: r.expected_revision,
        status: "queued".into(),
        prompt: r.prompt,
        model: image_jobs::model(),
        planning_model: config.model.clone(),
        shared_context: "原图、来源修订和选择蒙版已共享；候选只在核对后由用户应用。".into(),
        agents: roles
            .into_iter()
            .map(|(n, r)| Worker {
                name: n.into(),
                role: r.into(),
                status: "waiting".into(),
                message: "等待前一步骤".into(),
                position: center,
            })
            .collect(),
        region,
        width: source.width(),
        height: source.height(),
        created_at_epoch_ms: now,
        expires_at_epoch_ms: expires,
        error: None,
        asset_hash: None,
        applied_revision: None,
        mask_hash: mask_asset.hash,
        mask_href: mask_asset.href,
        owner,
        href: None,
        cancelled: Arc::new(AtomicBool::new(false)),
        apply_author: None,
    };
    {
        let mut jobs = state.image_edits.lock().await;
        jobs.retain(|_, j| active(j) || now.saturating_sub(j.created_at_epoch_ms) < 3_600_000);
        let pending: Vec<_> = jobs
            .values()
            .filter(|j| active(j) || j.status == "queued")
            .collect();
        let pixels: u64 = pending
            .iter()
            .map(|j| u64::from(j.width) * u64::from(j.height))
            .sum();
        if jobs.len() >= 128
            || pending.len() >= 8
            || pixels + u64::from(source.width()) * u64::from(source.height()) > 64_000_000
        {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "图片任务过多，请稍后再试".into(),
            ));
        }
        if !jobs
            .values()
            .any(|j| j.document_id == id && active(j) && overlap(j.region, region))
        {
            job.status = "planning".into();
            if let Some(first) = job.agents.first_mut() {
                first.status = "running".into();
                first.message = "读取共享原图与蒙版".into();
            }
        }
        jobs.insert(job.job_id.clone(), job.clone());
        jobs.flush()?;
    }
    let state_job = state.clone();
    let work = job.clone();
    integration::backup::spawn(async move {
        let task = run(&state_job, &work, &source, &mask, config);
        let result = tokio::select! {v=tokio::time::timeout(Duration::from_secs(350),task)=>v.unwrap_or_else(|_|Err(bad("图片任务超时，区域锁已释放"))),_=cancelled(&work)=>Err(bad("已取消"))};
        let mut jobs = state_job.image_edits.lock().await;
        if let Some(j) = jobs.get_mut(&work.job_id) {
            if j.cancelled.load(Ordering::SeqCst) {
                j.status = "cancelled".into();
            } else {
                match result {
                    Ok((hash, href)) => {
                        j.status = "ready".into();
                        j.asset_hash = Some(hash);
                        j.href = Some(href);
                    }
                    Err(e) => {
                        j.status = "failed".into();
                        j.error = Some(e.1);
                    }
                }
            }
            for a in &mut j.agents {
                if a.status != "done" {
                    a.status = if j.status == "ready" {
                        "done"
                    } else {
                        "stopped"
                    }
                    .into();
                }
            }
        }
    });
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::to_value(job).map_err(internal)?),
    ))
}
async fn cancelled(job: &ImageJob) {
    loop {
        if job.cancelled.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
async fn stage(
    state: &ServerState,
    job: &ImageJob,
    status: &str,
    worker: usize,
    message: &str,
) -> Result<(), ApiError> {
    let mut jobs = state.image_edits.lock().await;
    if let Some(j) = jobs.get_mut(&job.job_id) {
        if j.cancelled.load(Ordering::SeqCst) {
            return Err(bad("图片任务已停止"));
        }
        j.status = status.into();
        for (i, a) in j.agents.iter_mut().enumerate() {
            if i == worker {
                a.status = "running".into();
                a.message = message.into();
                a.position = [
                    (a.position[0] + 0.018).min(0.98),
                    (a.position[1] + 0.012).min(0.98),
                ];
            } else if a.status == "running" && !(status == "checking" && i >= 2) {
                a.status = "done".into();
            }
        }
    }
    jobs.flush()
}
async fn bounded_json(response: reqwest::Response) -> Result<Value, ApiError> {
    let status = response.status();
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(b) = stream.next().await {
        let b = b.map_err(internal)?;
        if bytes.len() + b.len() > 48 * 1024 * 1024 {
            return Err(bad("图像服务响应过大"));
        }
        bytes.extend_from_slice(&b);
    }
    if !status.is_success() {
        return Err(ApiError(
            StatusCode::BAD_GATEWAY,
            format!("模型服务返回 {status}；请检查图像模型权限或稍后重试"),
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| bad("模型返回了无效数据"))
}
async fn reason(
    client: &reqwest::Client,
    config: &agent_runs::Config,
    prompt: &str,
    image: Option<&[u8]>,
) -> Result<String, ApiError> {
    let mut content = vec![json!({"type":"input_text","text":prompt})];
    if let Some(data) = image {
        content.push(json!({"type":"input_image","image_url":format!("data:image/png;base64,{}",STANDARD.encode(data)),"detail":"low"}));
    }
    let mut body = json!({"model":config.model,"input":[{"role":"user","content":content}],"max_output_tokens":700});
    if let Some(effort) = &config.reasoning_effort {
        body["reasoning"] = json!({"effort":effort});
    }
    let value = bounded_json(
        client
            .post(&config.endpoint)
            .bearer_auth(&config.key)
            .json(&body)
            .send()
            .await
            .map_err(|_| bad("规划模型连接失败"))?,
    )
    .await?;
    let text = value["output"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|v| v["content"].as_array().into_iter().flatten())
        .filter_map(|c| c["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        return Err(bad("规划模型没有返回可用内容"));
    }
    Ok(text)
}
async fn run(
    state: &ServerState,
    job: &ImageJob,
    source: &RgbaImage,
    mask: &image::GrayImage,
    config: agent_runs::Config,
) -> Result<(String, String), ApiError> {
    // Queued overlapping jobs acquire their lease atomically in deterministic order.
    loop {
        let mut jobs = state.image_edits.lock().await;
        let queued = jobs.get(&job.job_id).is_some_and(|j| j.status == "queued");
        let blocked = jobs.values().any(|j| {
            j.document_id == job.document_id
                && j.job_id != job.job_id
                && overlap(j.region, job.region)
                && (active(j)
                    || (queued
                        && j.status == "queued"
                        && (j.created_at_epoch_ms, &j.job_id)
                            < (job.created_at_epoch_ms, &job.job_id)))
        });
        if !blocked {
            if let Some(j) = jobs.get_mut(&job.job_id) {
                j.status = "planning".into();
            }
            break;
        }
        drop(jobs);
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    state.image_edits.ensure_healthy()?;
    guard_revision(&image_bundle(state, &job.document_id)?, job.source_revision)?;
    let _slot = state.image_slots.acquire().await.map_err(internal)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(290))
        .build()
        .map_err(internal)?;
    let src = png_bytes(&DynamicImage::ImageRgba8(source.clone())).map_err(hcd_error)?;
    let mut prompt = job.prompt.clone();
    let editor = usize::from(job.agents.len() > 1);
    if editor == 1 {
        stage(state, job, "planning", 0, "读取原图、蒙版和共享任务").await?;
        let plan=reason(&client,&config,&format!("为局部修图制定简短且可执行的提示词。只修改蒙版区域，保留其他内容。用户要求：{}。图像 {}×{}，像素区域 {:?}。直接输出提示词。",job.prompt,source.width(),source.height(),job.region),Some(&src)).await?;
        prompt = format!("{}\n规划：{plan}", job.prompt);
        if let Some(j) = state.image_edits.lock().await.get_mut(&job.job_id) {
            j.shared_context = plan;
        }
    }
    stage(state, job, "generating", editor, "持有区域锁，正在生成候选").await?;
    let mut api_mask = RgbaImage::new(source.width(), source.height());
    for (x, y, p) in api_mask.enumerate_pixels_mut() {
        *p = image::Rgba([255, 255, 255, 255 - mask.get_pixel(x, y)[0]]);
    }
    let mask_data = png_bytes(&DynamicImage::ImageRgba8(api_mask)).map_err(hcd_error)?;
    let endpoint = std::env::var("HCD_OPENAI_IMAGE_BASE_URL")
        .unwrap_or_else(|_| config.endpoint.trim_end_matches("/responses").into());
    let url = reqwest::Url::parse(&endpoint).map_err(|_| bad("图像服务地址无效"))?;
    if !(url.scheme() == "https"
        || url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(bad("图像服务地址需要 HTTPS 或本机 HTTP"));
    }
    let form = reqwest::multipart::Form::new()
        .text("model", job.model.clone())
        .text("prompt", prompt)
        .text("size", "auto")
        .text("output_format", "png")
        .part(
            "image",
            reqwest::multipart::Part::bytes(src)
                .file_name("source.png")
                .mime_str("image/png")
                .map_err(internal)?,
        )
        .part(
            "mask",
            reqwest::multipart::Part::bytes(mask_data)
                .file_name("mask.png")
                .mime_str("image/png")
                .map_err(internal)?,
        );
    let response = client
        .post(format!("{}/images/edits", endpoint.trim_end_matches('/')))
        .bearer_auth(&config.key)
        .multipart(form)
        .send()
        .await
        .map_err(|_| bad("图像生成连接失败或超时"))?;
    let value = bounded_json(response).await?;
    let data = bytes64(
        value["data"][0]["b64_json"]
            .as_str()
            .ok_or_else(|| bad("图像服务未返回图片，未应用任何修改"))?,
    )?;
    let generated = decode_raster(&data).map_err(hcd_error)?.0.to_rgba8();
    let generated = if generated.dimensions() != source.dimensions() {
        image::imageops::resize(
            &generated,
            source.width(),
            source.height(),
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        generated
    };
    let result = composite(source, &generated, mask);
    let png = png_bytes(&DynamicImage::ImageRgba8(result)).map_err(hcd_error)?;
    // Independent read-only reviews run concurrently over the same candidate.
    futures::future::try_join_all((2..job.agents.len()).map(|index| {
        let client = &client;
        let config = &config;
        let png = &png;
        async move {
            stage(
                state,
                job,
                "checking",
                index,
                if index == 2 {
                    "核对候选、保留要求和蒙版边界"
                } else {
                    "检查光线、纹理和局部一致性"
                },
            )
            .await?;
            let review = reason(
                client,
                config,
                &format!(
                    "{}。用户要求：{}。只描述观察，禁止宣称已提交；候选由用户决定是否应用。",
                    if index == 2 {
                        "核对这张局部修图候选是否符合要求和保留范围"
                    } else {
                        "独立核对光线、纹理和局部一致性"
                    },
                    job.prompt
                ),
                Some(png),
            )
            .await?;
            if let Some(j) = state.image_edits.lock().await.get_mut(&job.job_id) {
                j.agents[index].message = review;
                j.agents[index].status = "done".into();
            }
            Ok::<(), ApiError>(())
        }
    }))
    .await?;
    let b = image_bundle(state, &job.document_id)?;
    let asset = b
        .stage_asset_from_reader("png", &mut png.as_slice())
        .map_err(hcd_error)?;
    Ok((asset.hash, asset.href))
}
pub(super) async fn cancel(
    State(state): State<ServerState>,
    Path((id, job_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let actor = write_claims(&state, &headers, &id)?;
    let _guard = state.collaboration_lock.lock().await;
    state.image_edits.ensure_healthy()?;
    let mut jobs = state.image_edits.lock().await;
    let j = jobs
        .get_mut(&job_id)
        .filter(|j| j.document_id == id)
        .ok_or_else(|| bad("图片任务不存在"))?;
    if actor.sub.as_deref() != Some(&j.owner) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "只有发起者可以取消此任务".into(),
        ));
    }
    if j.status == "ready" {
        j.status = "discarded".into();
    } else if !matches!(
        j.status.as_str(),
        "applied" | "failed" | "cancelled" | "discarded"
    ) {
        j.cancelled.store(true, Ordering::SeqCst);
        j.status = "cancelled".into();
        for a in &mut j.agents {
            if a.status != "done" {
                a.status = "stopped".into();
            }
        }
    }
    jobs.flush()?;
    Ok(Json(json!({"ok":true})))
}
pub(super) async fn candidate(
    State(state): State<ServerState>,
    Path((id, job_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    state.image_edits.ensure_healthy()?;
    let j = state
        .image_edits
        .lock()
        .await
        .get(&job_id)
        .filter(|j| j.document_id == id)
        .cloned()
        .ok_or_else(|| bad("图片任务不存在"))?;
    let href = j.href.as_ref().ok_or_else(|| bad("候选尚不可用"))?;
    let b = image_bundle(&state, &id)?;
    let bytes = tokio::fs::read(b.resolve_href(href).map_err(hcd_error)?)
        .await
        .map_err(internal)?;
    if j.asset_hash.as_deref() != Some(hcd_core::hash_bytes(&bytes).as_str()) {
        return Err(internal("image candidate checksum differs"));
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
pub(super) async fn mask_content(
    State(state): State<ServerState>,
    Path((id, job_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    state.image_edits.ensure_healthy()?;
    let j = state
        .image_edits
        .lock()
        .await
        .get(&job_id)
        .filter(|j| j.document_id == id)
        .cloned()
        .ok_or_else(|| bad("图片任务不存在"))?;
    let b = image_bundle(&state, &id)?;
    let bytes = tokio::fs::read(b.resolve_href(&j.mask_href).map_err(hcd_error)?)
        .await
        .map_err(internal)?;
    if hcd_core::hash_bytes(&bytes) != j.mask_hash {
        return Err(internal("image mask checksum differs"));
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Apply {
    expected_revision: u64,
}
pub(super) async fn apply(
    State(state): State<ServerState>,
    Path((id, job_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(r): Json<Apply>,
) -> Result<Json<Value>, ApiError> {
    let actor = write_claims(&state, &headers, &id)?;
    let _guard = state.collaboration_lock.lock().await;
    check_collaboration_epoch(&state, &id, &headers).await?;
    check_agent_patch(&state, &id, &headers, &actor).await?;
    state.image_edits.ensure_healthy()?;
    let j = state
        .image_edits
        .lock()
        .await
        .get(&job_id)
        .filter(|j| j.document_id == id)
        .cloned()
        .ok_or_else(|| bad("图片任务不存在"))?;
    if j.status == "applied" && j.source_revision == r.expected_revision {
        return Ok(Json(
            json!({"revision":j.applied_revision.ok_or_else(||internal("missing image apply receipt"))?,"alreadyApplied":true}),
        ));
    }
    if j.status != "ready" || j.source_revision != r.expected_revision {
        return Err(conflict("候选来源版本不匹配或尚未完成"));
    }
    let b = image_bundle(&state, &id)?;
    guard_revision(&b, r.expected_revision)?;
    check_region(&state, &id, Some(&job_id)).await?;
    let bytes = tokio::fs::read(
        b.resolve_href(j.href.as_deref().ok_or_else(|| bad("候选缺失"))?)
            .map_err(hcd_error)?,
    )
    .await
    .map_err(internal)?;
    if j.asset_hash.as_deref() != Some(hcd_core::hash_bytes(&bytes).as_str()) {
        return Err(internal("image candidate checksum differs"));
    }
    let img = decode_raster(&bytes).map_err(hcd_error)?.0;
    {
        let mut jobs = state.image_edits.lock().await;
        let current = jobs.get_mut(&job_id).ok_or_else(|| bad("图片任务不存在"))?;
        current.status = "applying".into();
        current.apply_author = Some(ApplyAuthor {
            id: actor
                .sub
                .clone()
                .map(|s| s.trim().chars().take(128).collect()),
            name: actor
                .name
                .clone()
                .map(|s| s.trim().chars().take(128).collect()),
        });
        jobs.flush()?;
    }
    let outcome = commit_pixels(
        &state,
        &b,
        &actor,
        &img,
        &headers,
        PixelCommit {
            expected: r.expected_revision,
            patch_id: &format!("image-apply-{job_id}"),
            region: Some(j.region),
        },
    )
    .await;
    let mut jobs = state.image_edits.lock().await;
    let current = jobs.get_mut(&job_id).ok_or_else(|| bad("图片任务不存在"))?;
    // Even a publish/author-stamp failure can follow a successful document
    // commit. Keep its intent for restart reconciliation, never offer reapply.
    if let Ok(revision) = &outcome {
        current.status = "applied".into();
        current.applied_revision = Some(*revision);
    } else if b.manifest().map_err(hcd_error)?.revision == r.expected_revision {
        current.status = "ready".into();
        current.apply_author = None;
    }
    jobs.flush()?;
    let revision = outcome?;
    Ok(Json(json!({"revision":revision})))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recovery_fixture() -> (tempfile::TempDir, ImageJob) {
        let root = tempfile::tempdir().unwrap();
        let png = png_bytes(&DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            4,
            4,
            image::Rgba([10, 20, 30, 255]),
        )))
        .unwrap();
        let source = root.path().join("source.png");
        std::fs::write(&source, &png).unwrap();
        hcd_formats::import_document(
            &source,
            root.path().join("recovery-image.hcd"),
            &hcd_formats::ImportOptions::new("recovery-image"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(root.path().join("recovery-image.hcd")).unwrap();
        let asset = bundle
            .stage_asset_from_reader("png", &mut png.as_slice())
            .unwrap();
        let mut job: ImageJob = serde_json::from_value(json!({"jobId":uuid::Uuid::new_v4().to_string(),"documentId":"recovery-image","sourceRevision":0,"status":"ready","prompt":"Recovery","model":"scripted","planningModel":"scripted","sharedContext":"shared","agents":[],"region":[0,0,4,4],"width":4,"height":4,"createdAtEpochMs":agent_now(),"expiresAtEpochMs":agent_now()+360000,"error":null,"assetHash":asset.hash,"maskHash":asset.hash,"owner":"original-owner"})).unwrap();
        job.href = Some(asset.href.clone());
        job.mask_href = asset.href;
        (root, job)
    }

    #[tokio::test]
    async fn image_checkpoints_keep_candidates_interrupt_workers_and_do_not_resurrect_removed_jobs()
    {
        let (root, job) = recovery_fixture();
        let mut pending = job.clone();
        pending.job_id = uuid::Uuid::new_v4().to_string();
        pending.status = "generating".into();
        pending.href = None;
        pending.asset_hash = None;
        pending.cancelled = Default::default();
        let store = Store::recover(root.path(), "inpaint").unwrap();
        {
            let mut jobs = store.lock().await;
            jobs.insert(job.job_id.clone(), job.clone());
            jobs.insert(pending.job_id.clone(), pending.clone());
            jobs.flush().unwrap();
        }
        let public = serde_json::to_value(&job).unwrap();
        assert!(
            public.get("href").is_none()
                && public.get("maskHref").is_none()
                && public.get("applyAuthor").is_none()
        );
        drop(store);
        let store = Store::recover(root.path(), "inpaint").unwrap();
        {
            let jobs = store.lock().await;
            assert_eq!(jobs[&job.job_id].status, "ready");
            assert_eq!(jobs[&job.job_id].href, job.href);
            assert_eq!(jobs[&pending.job_id].status, "interrupted");
            assert!(!active(&jobs[&pending.job_id]));
            assert!(jobs[&pending.job_id].cancelled.load(Ordering::SeqCst));
        }
        {
            let mut jobs = store.lock().await;
            jobs.clear();
            jobs.flush().unwrap();
        }
        drop(store);
        assert!(Store::recover(root.path(), "inpaint")
            .unwrap()
            .lock()
            .await
            .is_empty());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(root.path().join("image-jobs"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(root.path().join("image-jobs/inpaint.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn image_apply_reconciles_a_committed_intent_and_returns_a_receipt_without_reapplying() {
        let (root, mut job) = recovery_fixture();
        job.status = "applying".into();
        job.apply_author = Some(ApplyAuthor {
            id: Some("applier".into()),
            name: Some("Applier".into()),
        });
        let store = Store::recover(root.path(), "inpaint").unwrap();
        {
            let mut jobs = store.lock().await;
            jobs.insert(job.job_id.clone(), job.clone());
            jobs.flush().unwrap();
        }
        let secret = b"isolated-image-recovery-unit-secret";
        let mut state = super::super::tests::test_state(secret, root.path());
        let actor: Claims = serde_json::from_value(json!({"doc":"recovery-image","scope":"write","sub":"applier","name":"Applier","aud":"hcd-core","iat":0,"exp":9999999999u64})).unwrap();
        let mut headers = super::super::tests::bearer_as(
            secret,
            "recovery-image",
            "write",
            Some("applier"),
            Some("Applier"),
        );
        headers.insert(
            "X-HCD-Collaboration-Epoch",
            header::HeaderValue::from_static("0"),
        );
        let bundle = Bundle::open(root.path().join("recovery-image.hcd")).unwrap();
        let png = std::fs::read(bundle.resolve_href(job.href.as_ref().unwrap()).unwrap()).unwrap();
        let image = decode_raster(&png).unwrap().0;
        assert_eq!(
            commit_pixels(
                &state,
                &bundle,
                &actor,
                &image,
                &headers,
                PixelCommit {
                    expected: 0,
                    patch_id: &format!("image-apply-{}", job.job_id),
                    region: Some(job.region),
                },
            )
            .await
            .unwrap(),
            1
        );
        let mut receipt = bundle.revision(1).unwrap();
        receipt.author_id = None;
        receipt.author_name = None;
        bundle.write_revision(&receipt).unwrap();
        drop(store);
        state.image_edits = Store::recover(root.path(), "inpaint").unwrap();
        assert_eq!(
            state.image_edits.lock().await[&job.job_id].status,
            "applied"
        );
        assert_eq!(
            bundle.revision(1).unwrap().author_id.as_deref(),
            Some("applier")
        );
        let Json(result) = apply(
            State(state),
            Path(("recovery-image".into(), job.job_id)),
            headers,
            Json(Apply {
                expected_revision: 0,
            }),
        )
        .await
        .unwrap();
        assert_eq!(result["alreadyApplied"], true);
        assert_eq!(result["revision"], 1);
        assert_eq!(bundle.manifest().unwrap().revision, 1);
    }

    #[tokio::test]
    async fn image_checkpoint_failures_fence_live_workers_and_corrupt_records_are_retained() {
        let (root, job) = recovery_fixture();
        let store = Store::recover(root.path(), "inpaint").unwrap();
        let path = root.path().join("image-jobs/inpaint.json");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        {
            let mut jobs = store.lock().await;
            jobs.insert(job.job_id.clone(), job.clone());
            assert!(jobs.flush().is_err());
        }
        assert!(store.ensure_healthy().is_err());
        assert!(job.cancelled.load(Ordering::SeqCst));
        drop(store);
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, "{broken").unwrap();
        assert!(Store::recover(root.path(), "inpaint").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{broken");
    }

    #[tokio::test]
    async fn an_uncommitted_image_intent_restores_a_candidate_without_applying_it() {
        let (root, mut job) = recovery_fixture();
        job.status = "applying".into();
        let store = Store::recover(root.path(), "inpaint").unwrap();
        {
            let mut jobs = store.lock().await;
            jobs.insert(job.job_id.clone(), job.clone());
            jobs.flush().unwrap();
        }
        drop(store);
        let store = Store::recover(root.path(), "inpaint").unwrap();
        assert_eq!(store.lock().await[&job.job_id].status, "ready");
        assert_eq!(
            Bundle::open(root.path().join("recovery-image.hcd"))
                .unwrap()
                .manifest()
                .unwrap()
                .revision,
            0
        );
    }
    #[test]
    fn inpaint_preserves_unselected_pixels_and_rejects_empty_mask() {
        let source = RgbaImage::from_pixel(10, 10, image::Rgba([10, 20, 30, 255]));
        let generated = RgbaImage::from_pixel(10, 10, image::Rgba([200, 80, 90, 255]));
        assert!(feather_mask(&RgbaImage::new(10, 10), 0.).is_err());
        let mut mask = image::GrayImage::new(10, 10);
        mask.put_pixel(4, 5, image::Luma([255]));
        mask.put_pixel(5, 5, image::Luma([128]));
        let result = composite(&source, &generated, &mask);
        assert_eq!(result.get_pixel(4, 5), generated.get_pixel(4, 5));
        assert_ne!(result.get_pixel(5, 5), source.get_pixel(5, 5));
        for (x, y, p) in result.enumerate_pixels() {
            if mask.get_pixel(x, y)[0] == 0 {
                assert_eq!(p, source.get_pixel(x, y));
            }
        }
        assert_eq!(bounds(&mask), [4, 5, 2, 1]);
        assert!(overlap([0, 0, 5, 5], [4, 4, 2, 2]));
        assert!(!overlap([0, 0, 4, 4], [4, 0, 2, 2]));
    }
}
