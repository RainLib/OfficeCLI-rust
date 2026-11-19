use super::*;
use crate::bundle::{finalize_root_hash, hash_descriptor, now_epoch_ms, read_bytes_bounded};
use crate::{
    hash_bytes, ApplyResult, AssetDescriptor, Bundle, BundleWriter, HcdError, MAX_REVISION,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::Sha256;
use std::collections::BTreeMap;

const SCENE_PART: &str = "canvas/scene.json";

fn file_bytes(file: &serde_json::Value) -> Result<(Vec<u8>, &'static str), HcdError> {
    let data = file["dataURL"]
        .as_str()
        .and_then(|s| s.split_once(','))
        .ok_or_else(|| HcdError::InvalidPatch("canvas image needs dataURL".into()))?;
    let ext = match file["mimeType"].as_str() {
        Some("image/png") => "png",
        Some("image/jpeg") => "jpg",
        Some("image/webp") => "webp",
        Some("image/gif") => "gif",
        _ => {
            return Err(HcdError::InvalidPatch(
                "unsupported canvas image type".into(),
            ))
        }
    };
    let bytes = STANDARD
        .decode(data.1)
        .map_err(|_| HcdError::InvalidPatch("invalid canvas image base64".into()))?;
    let valid = match ext {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" => bytes.starts_with(b"\xff\xd8\xff"),
        "webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        _ => false,
    };
    if !valid {
        return Err(HcdError::InvalidPatch(
            "canvas image signature differs from its MIME type".into(),
        ));
    }
    Ok((bytes, ext))
}

fn strip_data(file: &mut serde_json::Value, hash: &str) {
    let object = file.as_object_mut().expect("validated image record");
    object.remove("dataURL");
    object.insert("assetHash".into(), hash.into());
}

pub fn store_initial_scene(
    writer: &BundleWriter,
    scene: &Scene,
) -> Result<Vec<AssetDescriptor>, HcdError> {
    canvas_core::validate_scene(scene).map_err(error)?;
    let mut stored = scene.clone();
    let mut assets = vec![];
    for (id, file) in &mut stored.files {
        let (bytes, ext) = file_bytes(file)?;
        let (href, hash, byte_length) =
            writer.write_asset_from_reader(ext, &mut bytes.as_slice())?;
        strip_data(file, &hash);
        assets.push(AssetDescriptor {
            source_part: format!("canvas/files/{id}"),
            hash,
            href,
            byte_length,
        });
    }
    let bytes = serde_json::to_vec(&stored)?;
    let (href, hash, byte_length) =
        writer.write_asset_from_reader("json", &mut bytes.as_slice())?;
    assets.push(AssetDescriptor {
        source_part: SCENE_PART.into(),
        hash,
        href,
        byte_length,
    });
    Ok(assets)
}

fn read_stored(bundle: &Bundle, revision: u64) -> Result<(Scene, Vec<AssetDescriptor>), HcdError> {
    let manifest = bundle.manifest()?;
    if manifest.source.format != "excalidraw" {
        return Err(HcdError::Unsupported("document is not a canvas".into()));
    }
    if revision > manifest.revision {
        return Err(HcdError::NotFound("canvas revision".into()));
    }
    let assets = bundle.read_asset_index_for_revision(revision)?;
    let asset = assets
        .iter()
        .find(|a| a.source_part == SCENE_PART)
        .ok_or_else(|| HcdError::InvalidBundle("canvas scene is missing".into()))?;
    let bytes = read_bytes_bounded(
        &bundle.resolve_href(&asset.href)?,
        canvas_core::MAX_SCENE_BYTES as u64,
        "canvas scene",
    )?;
    if hash_bytes(&bytes) != asset.hash {
        return Err(HcdError::InvalidBundle("canvas scene hash mismatch".into()));
    }
    let scene: Scene = serde_json::from_slice(&bytes)?;
    canvas_core::validate_scene(&scene).map_err(error)?;
    Ok((scene, assets))
}

pub fn read_scene(bundle: &Bundle, revision: Option<u64>) -> Result<Scene, HcdError> {
    let (mut scene, assets) = read_stored(bundle, revision.unwrap_or(bundle.manifest()?.revision))?;
    for (id, file) in &mut scene.files {
        let asset = assets
            .iter()
            .find(|a| {
                a.source_part == format!("canvas/files/{id}")
                    && Some(a.hash.as_str()) == file["assetHash"].as_str()
            })
            .ok_or_else(|| {
                HcdError::InvalidBundle("canvas image is not in this revision".into())
            })?;
        let bytes = read_bytes_bounded(
            &bundle.resolve_href(&asset.href)?,
            16 * 1024 * 1024,
            "canvas image",
        )?;
        if hash_bytes(&bytes) != asset.hash {
            return Err(HcdError::InvalidBundle("canvas image hash mismatch".into()));
        }
        let data = format!(
            "data:{};base64,{}",
            file["mimeType"].as_str().unwrap(),
            STANDARD.encode(bytes)
        );
        let object = file.as_object_mut().unwrap();
        object.remove("assetHash");
        object.insert("dataURL".into(), data.into());
    }
    canvas_core::validate_scene(&scene).map_err(error)?;
    Ok(scene)
}

/// Object-field compare-and-set permits independent edits against a stale head.
/// This takes the same process lock as every HCD mutation, writes immutable
/// objects and the revision first, and publishes the manifest last.
pub fn apply_batch(
    bundle: &Bundle,
    batch: &Batch,
    selection: Option<&Selection>,
    author: &BTreeMap<String, String>,
) -> Result<ApplyResult, HcdError> {
    apply_batch_with_rewrite(bundle, batch, selection, author, None)
}

pub fn apply_batch_with_rewrite(
    bundle: &Bundle,
    batch: &Batch,
    selection: Option<&Selection>,
    author: &BTreeMap<String, String>,
    rewrite: Option<(&str, u64)>,
) -> Result<ApplyResult, HcdError> {
    let _guard = bundle.acquire_write_lock()?;
    let mut manifest = bundle.manifest()?;
    if manifest.source.format != "excalidraw" || batch.document_id != manifest.document_id {
        return Err(HcdError::InvalidPatch("canvas document mismatch".into()));
    }
    if batch.base_revision > manifest.revision || manifest.revision - batch.base_revision > 10_000 {
        return Err(HcdError::RevisionConflict(
            "reread the current canvas revision".into(),
        ));
    }
    let hash = hash_bytes(&serde_json::to_vec(batch)?);
    for n in (batch.base_revision.saturating_add(1)..=manifest.revision).rev() {
        let record = bundle.revision(n)?;
        if record.patch_id.as_deref() == Some(&batch.patch_id) {
            if record.patch_hash.as_deref() != Some(&hash)
                || record.author_id.as_ref() != author.get("id")
            {
                return Err(HcdError::RevisionConflict(
                    "canvas patch ID was used for different content or author".into(),
                ));
            }
            return Ok(ApplyResult {
                document_id: manifest.document_id,
                patch_id: batch.patch_id.clone(),
                base_revision: batch.base_revision,
                revision: n,
                root_hash: record.root_hash,
                annotation_root_hash: record.annotation_root_hash,
                dirty_node_ids: record.dirty_node_ids,
                dirty_chunk_ids: record.dirty_chunk_ids,
                dirty_source_parts: record.dirty_source_parts,
                warnings: vec![],
                idempotent_replay: true,
            });
        }
    }
    if manifest.revision >= MAX_REVISION {
        return Err(HcdError::ResourceLimit("revision limit reached".into()));
    }
    let (stored, old_assets) = read_stored(bundle, manifest.revision)?;
    // Hydrate only file.add records already stored under the same ID, making a
    // network retry compare the same immutable representation.
    let mut normalized = batch.clone();
    let mut added_assets = vec![];
    for op in &mut normalized.operations {
        if let Operation::File { id, file } = op {
            let mut check = Scene::default();
            check.files.insert(id.clone(), file.clone());
            canvas_core::validate_scene(&check).map_err(error)?;
            let (bytes, ext) = file_bytes(file)?;
            let mut asset = bundle.stage_asset_from_reader(ext, &mut bytes.as_slice())?;
            asset.source_part = format!("canvas/files/{id}");
            strip_data(file, &asset.hash);
            added_assets.push(asset);
        }
    }
    let needs_base = normalized.operations.iter().any(|op| match op {
        Operation::SpecSplice { .. } => true,
        Operation::Update { id, changes, .. }
            if changes.contains_key("text") || changes.contains_key("originalText") =>
        {
            stored
                .elements
                .iter()
                .any(|el| el["id"] == *id && canvas_core::spec::is_spec(el))
        }
        _ => false,
    });
    let historical = if needs_base && batch.base_revision != manifest.revision {
        Some(read_stored(bundle, batch.base_revision)?.0)
    } else {
        None
    };
    let (next, effect) = canvas_core::apply_with_receipt(
        &stored,
        &normalized,
        selection,
        historical.as_ref().unwrap_or(&stored),
        rewrite.is_some(),
    )
    .map_err(error)?;
    let bytes = serde_json::to_vec(&next)?;
    let mut scene_asset = bundle.stage_asset_from_reader("json", &mut bytes.as_slice())?;
    scene_asset.source_part = SCENE_PART.into();
    let mut assets: Vec<_> = old_assets
        .into_iter()
        .filter(|a| a.source_part != SCENE_PART)
        .collect();
    for asset in added_assets {
        if !assets.iter().any(|a| a.source_part == asset.source_part) {
            assets.push(asset);
        }
    }
    assets.push(scene_asset);
    // Hydration embeds every image as base64. Bound the exported/readable scene
    // before committing so many individually valid file.add batches cannot
    // create a head that exceeds the reader's native-scene limit.
    let hydrated_bytes = assets
        .iter()
        .filter(|asset| asset.source_part.starts_with("canvas/files/"))
        .fold(bytes.len() as u64, |total, asset| {
            total.saturating_add(asset.byte_length.div_ceil(3).saturating_mul(4) + 64)
        });
    if hydrated_bytes > canvas_core::MAX_SCENE_BYTES as u64 {
        return Err(HcdError::ResourceLimit(
            "canvas including embedded images exceeds 32 MiB".into(),
        ));
    }
    let (asset_index_href, _) = bundle.write_json_object("assets/indexes", &assets)?;
    let revision = manifest.revision + 1;
    let mut index = bundle.read_index_page(&manifest, 0)?;
    index.revision = revision;
    let descriptor = index
        .chunks
        .first_mut()
        .ok_or_else(|| HcdError::InvalidBundle("canvas preview is missing".into()))?;
    let html = preview_html(&next);
    let (href, html_hash) = bundle.write_chunk_object(&html)?;
    descriptor.html_href = href;
    descriptor.html_hash = html_hash;
    descriptor.byte_length = html.len() as u64;
    let chunk_id = descriptor.chunk_id.clone();
    let mut root_hasher = Sha256::default();
    hash_descriptor(&mut root_hasher, descriptor);
    let index_root = bundle.replace_index_page(
        manifest
            .index_root_href
            .as_deref()
            .ok_or_else(|| HcdError::InvalidBundle("canvas index root is missing".into()))?,
        0,
        &index,
    )?;
    let root_hash = finalize_root_hash(
        bundle,
        root_hasher,
        &asset_index_href,
        &manifest.styles_href,
    )?;
    let mut record = bundle.revision(manifest.revision)?;
    record.canvas_rewrite = match (effect, rewrite) {
        (Some(effect), Some((owner, epoch))) => Some(crate::CanvasRewriteReceipt {
            owner: owner.into(), epoch, cursor: effect.cursor,
            inverse_href: bundle.write_json_object("canvas/inverses", &effect.inverse)?.0,
        }),
        _ => None,
    };
    record.parent_revision = Some(manifest.revision);
    record.revision = revision;
    record.patch_id = Some(batch.patch_id.clone());
    record.patch_hash = Some(hash);
    record.patch_base_revision = Some(batch.base_revision);
    record.author_id = author.get("id").cloned();
    record.author_name = author.get("name").cloned();
    record.root_hash = root_hash.clone();
    record.index_root_href = Some(index_root.clone());
    record.asset_index_href = asset_index_href;
    record.created_at_epoch_ms = now_epoch_ms();
    record.dirty_node_ids = batch
        .operations
        .iter()
        .filter_map(|o| {
            o.element_id()
                .map(|id| super::node_id(&batch.document_id, id))
        })
        .collect();
    if record.dirty_node_ids.is_empty() {
        record
            .dirty_node_ids
            .push(super::node_id(&batch.document_id, "scene"));
    }
    record.removed_node_ids = vec![];
    record.dirty_chunk_ids = vec![chunk_id.clone()];
    record.dirty_source_parts = vec![SCENE_PART.into()];
    record.structural_change = false;
    bundle.write_revision(&record)?;
    manifest.revision = revision;
    manifest.root_hash = root_hash;
    manifest.index_root_href = Some(index_root);
    bundle.write_manifest(&manifest)?;
    Ok(ApplyResult {
        document_id: manifest.document_id,
        patch_id: batch.patch_id.clone(),
        base_revision: batch.base_revision,
        revision,
        root_hash: manifest.root_hash,
        annotation_root_hash: manifest.annotation_root_hash,
        dirty_node_ids: record.dirty_node_ids,
        dirty_chunk_ids: vec![chunk_id],
        dirty_source_parts: record.dirty_source_parts,
        warnings: vec![],
        idempotent_replay: false,
    })
}

/// Replaying the same immutable inverse carries the same CRDT item IDs.
pub fn rewrite_inverse(bundle: &Bundle, receipt: &crate::CanvasRewriteReceipt) -> Result<String, HcdError> {
    let bytes = crate::bundle::read_bytes_bounded(&bundle.resolve_href(&receipt.inverse_href)?, crate::MAX_CONTROL_PART_BYTES, "Spec rewrite inverse")?;
    let object = format!("canvas/inverses/sha256/{}.json", hash_bytes(&bytes));
    if receipt.inverse_href != object && receipt.inverse_href != format!("{object}.gz") {
        return Err(HcdError::InvalidBundle("Spec rewrite inverse hash mismatch".into()));
    }
    Ok(serde_json::from_slice(&bytes)?)
}
