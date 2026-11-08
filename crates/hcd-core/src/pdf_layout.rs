//! Append-only PDF presentation upgrades. Text, source maps and annotations are
//! immutable inputs; this path cannot submit arbitrary content edits.
use crate::bundle::{finalize_root_hash, hash_descriptor, now_epoch_ms};
use crate::{
    extract_html_image_nodes, extract_html_text_nodes, hash_bytes, hash_file, ApplyResult,
    AssetDescriptor, Bundle, HcdError, RevisionRecord, MAX_CHUNK_BYTES, MAX_REVISION,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfLayoutChunk {
    pub chunk_id: String,
    pub previous_html_hash: String,
    pub html_href: String,
    pub html_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfLayoutUpgrade {
    pub base_revision: u64,
    pub root_hash: String,
    pub chunks: Vec<PdfLayoutChunk>,
    pub assets: Vec<AssetDescriptor>,
}

fn verify_saved_image_positions(
    original: &str,
    before: &BTreeMap<String, crate::HtmlImageNode>,
    after: &BTreeMap<String, crate::HtmlImageNode>,
) -> Result<(), HcdError> {
    let mut reader = quick_xml::Reader::from_str(original);
    loop {
        let tag = match reader
            .read_event()
            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
        {
            quick_xml::events::Event::Start(tag) | quick_xml::events::Event::Empty(tag) => tag,
            quick_xml::events::Event::Eof => break,
            _ => continue,
        };
        let mut id = None;
        let mut saved = false;
        for attr in tag.attributes() {
            let attr = attr.map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
            match attr.key.as_ref() {
                b"data-hcd-id" => {
                    id = Some(
                        attr.decode_and_unescape_value(reader.decoder())
                            .map_err(|e| HcdError::InvalidBundle(e.to_string()))?
                            .into_owned(),
                    )
                }
                b"data-hcd-image-geometry-patched" => {
                    saved = attr
                        .decode_and_unescape_value(reader.decoder())
                        .map_err(|e| HcdError::InvalidBundle(e.to_string()))?
                        == "true"
                }
                _ => {}
            }
        }
        if let Some(id) = id.filter(|_| saved) {
            if before.get(&id).and_then(|image| image.geometry.as_ref())
                != after.get(&id).and_then(|image| image.geometry.as_ref())
            {
                return Err(HcdError::InvalidPatch(
                    "layout upgrade changed a saved picture position".into(),
                ));
            }
        }
    }
    Ok(())
}

/// Publish renderer-derived layout objects under a version/root compare-and-swap.
/// The plan is an internal typed API, not a JSON patch operation exposed to callers.
pub fn apply_pdf_layout_upgrade(
    bundle: &Bundle,
    plan: PdfLayoutUpgrade,
    actor: BTreeMap<String, String>,
) -> Result<ApplyResult, HcdError> {
    let _guard = bundle.acquire_write_lock()?;
    let mut head = bundle.manifest()?;
    if head.revision != plan.base_revision || head.root_hash != plan.root_hash {
        return Err(HcdError::RevisionConflict(
            "PDF changed while its layout was being upgraded".into(),
        ));
    }
    if head.source.format != "pdf" || head.profile != "fixed-layout" || plan.chunks.is_empty() {
        return Err(HcdError::InvalidPatch(
            "layout upgrades require a nonempty fixed-layout PDF plan".into(),
        ));
    }
    if head.revision >= MAX_REVISION {
        return Err(HcdError::ResourceLimit("revision limit reached".into()));
    }
    let plan_hash = hash_bytes(&serde_json::to_vec(&plan)?);
    let mut chunks = BTreeMap::new();
    for chunk in plan.chunks {
        if chunks.insert(chunk.chunk_id.clone(), chunk).is_some() {
            return Err(HcdError::InvalidPatch("duplicate layout chunk".into()));
        }
    }
    let mut assets: BTreeMap<_, _> = bundle
        .read_asset_index_for_revision(head.revision)?
        .into_iter()
        .map(|asset| (asset.hash.clone(), asset))
        .collect();
    for asset in plan.assets {
        let path = bundle.resolve_href(&asset.href)?;
        if asset.byte_length > crate::MAX_STAGED_ASSET_BYTES
            || std::fs::metadata(&path)?.len() != asset.byte_length
            || hash_file(path)? != asset.hash
        {
            return Err(HcdError::InvalidBundle(
                "layout asset does not match its immutable payload".into(),
            ));
        }
        assets.entry(asset.hash.clone()).or_insert(asset);
    }
    let asset_hashes: HashSet<_> = assets.keys().cloned().collect();
    let mut root = head.index_root_href.clone();
    let revision = head.revision + 1;
    let prefix = format!("indexes/rev-{revision:020}");
    if root.is_none() {
        std::fs::create_dir_all(bundle.root().join(&prefix))?;
    }
    let mut hasher = Sha256::new();
    let mut dirty_chunks = Vec::new();
    for index in 0..head.index_page_count {
        let mut page = bundle.read_index_page(&head, index)?;
        let mut changed = false;
        for descriptor in &mut page.chunks {
            if let Some(upgrade) = chunks.remove(&descriptor.chunk_id) {
                if descriptor.html_hash != upgrade.previous_html_hash {
                    return Err(HcdError::PreconditionFailed(
                        "PDF layout chunk changed".into(),
                    ));
                }
                let mut replacement = descriptor.clone();
                replacement.html_href = upgrade.html_href;
                replacement.html_hash = upgrade.html_hash;
                let html = bundle.read_chunk(&replacement)?;
                if hash_bytes(html.as_bytes()) != replacement.html_hash {
                    return Err(HcdError::InvalidBundle(
                        "upgraded HTML payload hash mismatch".into(),
                    ));
                }
                if html.len() > MAX_CHUNK_BYTES {
                    return Err(HcdError::ResourceLimit(
                        "upgraded HTML chunk exceeds the chunk limit".into(),
                    ));
                }
                crate::validate::validate_rewritten_html(&html, &asset_hashes)?;
                let original = bundle.read_chunk_verified(descriptor)?;
                let map = bundle.read_map_verified(descriptor)?;
                let before = extract_html_text_nodes(&original)?;
                let after = extract_html_text_nodes(&html)?;
                if before != after
                    || after.len() != map.entries.len()
                    || map.entries.iter().any(|entry| {
                        after
                            .get(&entry.node_id)
                            .is_none_or(|text| hash_bytes(text.as_bytes()) != entry.node_hash)
                    })
                {
                    return Err(HcdError::InvalidPatch(
                        "PDF layout upgrade must preserve every canonical node and text hash"
                            .into(),
                    ));
                }
                let before_images = extract_html_image_nodes(&original)?;
                let after_images = extract_html_image_nodes(&html)?;
                if before_images.len() != after_images.len()
                    || before_images.iter().any(|(id, image)| {
                        after_images
                            .get(id)
                            .is_none_or(|after| image.asset_hash != after.asset_hash)
                    })
                {
                    return Err(HcdError::InvalidPatch(
                        "PDF layout upgrade must preserve every image resource".into(),
                    ));
                }
                verify_saved_image_positions(&original, &before_images, &after_images)?;
                if replacement.html_hash == descriptor.html_hash {
                    hash_descriptor(&mut hasher, descriptor);
                    continue;
                }
                descriptor.html_href = replacement.html_href;
                descriptor.html_hash = replacement.html_hash;
                descriptor.byte_length = html.len() as u64;
                dirty_chunks.push(descriptor.chunk_id.clone());
                changed = true;
            }
            hash_descriptor(&mut hasher, descriptor);
        }
        if changed || root.is_none() {
            page.revision = revision;
            if let Some(current) = root {
                root = Some(bundle.replace_index_page(&current, index, &page)?);
            } else {
                crate::bundle::atomic_write_json_encoded(
                    &bundle
                        .root()
                        .join(&prefix)
                        .join(format!("{index:06}.json{}", head.storage_codec.suffix())),
                    &page,
                )?;
            }
        }
    }
    if !chunks.is_empty() {
        return Err(HcdError::InvalidPatch(
            "layout plan references missing chunks".into(),
        ));
    }
    if dirty_chunks.is_empty() {
        return Err(HcdError::InvalidPatch(
            "layout plan contains no presentation changes".into(),
        ));
    }
    let assets: Vec<_> = assets.into_values().collect();
    let asset_index_href = bundle.write_json_object("assets/indexes", &assets)?.0;
    let root_hash = finalize_root_hash(bundle, hasher, &asset_index_href)?;
    let (author_id, author_name) = crate::revision_author(&actor)?;
    let patch_id = format!("pdf-layout-{}-{}", plan.base_revision, &plan_hash[..16]);
    let record = RevisionRecord {
        schema_version: head.schema_version.clone(),
        document_id: head.document_id.clone(),
        revision,
        parent_revision: Some(head.revision),
        patch_id: Some(patch_id.clone()),
        patch_hash: Some(plan_hash),
        patch_base_revision: Some(head.revision),
        root_hash: root_hash.clone(),
        annotation_root_hash: head.annotation_root_hash.clone(),
        index_prefix: if root.is_some() {
            head.index_prefix.clone()
        } else {
            prefix.clone()
        },
        index_root_href: root.clone(),
        index_page_count: Some(head.index_page_count),
        chunk_count: Some(head.chunk_count),
        asset_index_href,
        created_at_epoch_ms: now_epoch_ms(),
        dirty_node_ids: vec![],
        dirty_chunk_ids: dirty_chunks.clone(),
        dirty_source_parts: vec![],
        structural_change: false,
        layout_upgrade: true,
        word_layout_change: false,
        author_id,
        author_name,
        reference_authors: std::collections::BTreeMap::new(),
    };
    head.revision = revision;
    head.root_hash = root_hash.clone();
    head.index_root_href = root;
    head.index_prefix = record.index_prefix.clone();
    if serde_json::to_vec(&record)?.len() as u64 > crate::MAX_CONTROL_PART_BYTES {
        return Err(HcdError::ResourceLimit(
            "layout revision metadata exceeds the control part limit".into(),
        ));
    }
    bundle.write_revision(&record)?;
    bundle.write_manifest(&head)?;
    Ok(ApplyResult {
        document_id: head.document_id,
        patch_id,
        base_revision: plan.base_revision,
        revision,
        root_hash,
        annotation_root_hash: head.annotation_root_hash,
        dirty_node_ids: vec![],
        dirty_chunk_ids: dirty_chunks,
        dirty_source_parts: vec![],
        warnings: vec![],
        idempotent_replay: false,
    })
}

/// The on-disk verifier independently checks content invariants; the layout
/// flag is not permission to hide an arbitrary content change in history.
pub(crate) fn validate_layout_history(
    bundle: &Bundle,
    head: &crate::HcdManifest,
    record: &RevisionRecord,
) -> Result<(), HcdError> {
    let previous = record
        .parent_revision
        .ok_or_else(|| HcdError::InvalidBundle("layout revision has no parent".into()))?;
    let before = crate::manifest_at_revision(bundle, head, Some(previous))?.0;
    let after = crate::manifest_at_revision(bundle, head, Some(record.revision))?.0;
    if before.chunk_count != after.chunk_count || before.index_page_count != after.index_page_count
    {
        return Err(HcdError::InvalidBundle(
            "layout revision changed the chunk sequence".into(),
        ));
    }
    let after_assets = bundle.read_asset_index_for_revision(record.revision)?;
    let assets: HashSet<_> = after_assets
        .iter()
        .map(|asset| asset.hash.clone())
        .collect();
    let original_assets = bundle.read_asset_index_for_revision(previous)?;
    let by_hash: BTreeMap<_, _> = after_assets
        .iter()
        .map(|asset| (asset.hash.as_str(), asset))
        .collect();
    if original_assets.iter().any(|asset| {
        by_hash
            .get(asset.hash.as_str())
            .is_none_or(|new| *new != asset)
    }) {
        return Err(HcdError::InvalidBundle(
            "layout revision removed or changed historical assets".into(),
        ));
    }
    let expected: HashSet<_> = record.dirty_chunk_ids.iter().map(String::as_str).collect();
    let mut changed = HashSet::new();
    for page in 0..before.index_page_count {
        let left = bundle.read_index_page(&before, page)?;
        let right = bundle.read_index_page(&after, page)?;
        if left.chunks.len() != right.chunks.len() {
            return Err(HcdError::InvalidBundle(
                "layout revision changed an index page's chunk count".into(),
            ));
        }
        for (old, new) in left.chunks.iter().zip(&right.chunks) {
            let mut allowed = old.clone();
            allowed.html_href = new.html_href.clone();
            allowed.html_hash = new.html_hash.clone();
            allowed.byte_length = new.byte_length;
            if serde_json::to_value(&allowed)? != serde_json::to_value(new)? {
                return Err(HcdError::InvalidBundle(
                    "layout revision changed source mapping or node metadata".into(),
                ));
            }
            if old.html_hash == new.html_hash {
                continue;
            }
            changed.insert(new.chunk_id.clone());
            let old_html = bundle.read_chunk_verified(old)?;
            let new_html = bundle.read_chunk_verified(new)?;
            crate::validate::validate_rewritten_html(&new_html, &assets)?;
            if extract_html_text_nodes(&old_html)? != extract_html_text_nodes(&new_html)? {
                return Err(HcdError::InvalidBundle(
                    "layout revision changed canonical text".into(),
                ));
            }
            let old_images = extract_html_image_nodes(&old_html)?;
            let new_images = extract_html_image_nodes(&new_html)?;
            verify_saved_image_positions(&old_html, &old_images, &new_images)?;
            if old_images.len() != new_images.len()
                || old_images.iter().any(|(id, image)| {
                    new_images
                        .get(id)
                        .is_none_or(|new| new.asset_hash != image.asset_hash)
                })
            {
                return Err(HcdError::InvalidBundle(
                    "layout revision changed canonical image resources".into(),
                ));
            }
        }
    }
    if changed.iter().map(String::as_str).collect::<HashSet<_>>() != expected {
        return Err(HcdError::InvalidBundle(
            "layout revision dirty chunks do not match the changed presentation".into(),
        ));
    }
    Ok(())
}
