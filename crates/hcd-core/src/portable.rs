//! Immutable, canonical-only offline snapshots. Runtime state and staging pins
//! are deliberately outside this graph; all history through the selected head
//! and the resource indexes of those revisions remain inside it.
use crate::{Bundle, HcdError, HcdManifest};
use std::collections::HashSet;
use std::io::Write;

pub const MAX_PORTABLE_FILES: usize = 100_000;
pub const MAX_PORTABLE_FILE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_PORTABLE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub struct PortableSnapshot {
    pub directory: tempfile::TempDir,
    pub manifest: HcdManifest,
    pub hrefs: Vec<String>,
}

/// Enumerate exactly the canonical objects required to read this head and all
/// its ancestors. Callers needing a stable copy should use create_portable_snapshot.
pub fn portable_bundle_hrefs(bundle: &Bundle, revision: u64) -> Result<Vec<String>, HcdError> {
    let head = bundle.manifest()?;
    crate::manifest_at_revision(bundle, &head, Some(revision))?;
    let mut files = HashSet::from(["manifest.json".to_string(), head.styles_href.clone()]);
    for at in 0..=revision {
        crate::stats::collect_revision_references(bundle, &head, at, &mut files)?;
        if files.len() > MAX_PORTABLE_FILES {
            return Err(HcdError::ResourceLimit("offline file count limit".into()));
        }
    }
    for href in &files {
        let canonical = href == "manifest.json"
            || href == "styles.css"
            || href == "assets/index.json"
            || [
                "revisions/",
                "chunks/",
                "maps/",
                "indexes/",
                "annotations/",
                "assets/indexes/",
                "assets/sha256/",
            ]
            .iter()
            .any(|prefix| href.starts_with(prefix));
        if !canonical
            || href.split('/').any(|part| {
                part.is_empty()
                    || part == "."
                    || part == ".."
                    || part.starts_with('.')
                    || !part
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            })
        {
            return Err(HcdError::InvalidBundle(
                "noncanonical offline object path".into(),
            ));
        }
        bundle.resolve_href(href)?;
    }
    let mut files: Vec<_> = files.into_iter().collect();
    files.sort();
    Ok(files)
}

pub fn create_portable_snapshot(
    bundle: &Bundle,
    revision: Option<u64>,
) -> Result<PortableSnapshot, HcdError> {
    let _guard = bundle.acquire_write_lock()?;
    let head = bundle.manifest()?;
    let (manifest, at) = crate::manifest_at_revision(bundle, &head, revision)?;
    let hrefs = portable_bundle_hrefs(bundle, at)?;
    let directory = tempfile::tempdir()?;
    let mut total = 0u64;
    for href in &hrefs {
        let target = directory.path().join(href);
        std::fs::create_dir_all(target.parent().expect("relative object parent"))?;
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
        let bytes = if href == "manifest.json" {
            let raw = serde_json::to_vec(&manifest)?;
            output.write_all(&raw)?;
            raw.len() as u64
        } else {
            let input = std::fs::File::open(bundle.resolve_href(href)?)?;
            if input.metadata()?.len() > MAX_PORTABLE_FILE_BYTES {
                return Err(HcdError::ResourceLimit("offline object byte limit".into()));
            }
            std::io::copy(
                &mut std::io::Read::take(input, MAX_PORTABLE_FILE_BYTES + 1),
                &mut output,
            )?
        };
        total = total
            .checked_add(bytes)
            .ok_or_else(|| HcdError::ResourceLimit("offline byte overflow".into()))?;
        if bytes > MAX_PORTABLE_FILE_BYTES || total > MAX_PORTABLE_BYTES {
            return Err(HcdError::ResourceLimit(
                "offline snapshot byte limit".into(),
            ));
        }
    }
    drop(_guard);
    let copied = Bundle::open(directory.path())?;
    validate_portable_bundle(&copied)?;
    Ok(PortableSnapshot {
        directory,
        manifest,
        hrefs,
    })
}

/// Check the current semantic bundle plus every historical root and dependency.
/// Hash reads are deduplicated across revisions; head validation alone would
/// miss corruption in an older chunk no longer used by the current version.
pub fn validate_portable_bundle(bundle: &Bundle) -> Result<(), HcdError> {
    let validation = crate::validate_bundle(bundle)?;
    if !validation.valid {
        return Err(HcdError::InvalidBundle(format!(
            "offline document has {} validation issue(s)",
            validation.issues.len()
        )));
    }
    let head = bundle.manifest()?;
    let mut checked = HashSet::new();
    for at in 0..=head.revision {
        let (view, _) = crate::manifest_at_revision(bundle, &head, Some(at))?;
        let record = bundle.revision(at)?;
        if let Some(layout) = crate::read_flow_document_layout(bundle, &view)?
            .filter(|layout| layout.schema_version == crate::FLOW_REGION_LAYOUT_SCHEMA)
        {
            crate::structure::flow_regions::validate_revision_regions(bundle, &view, &layout)?;
        }
        let mut root = sha2::Sha256::default();
        for page in 0..view.index_page_count {
            for descriptor in bundle.read_index_page(&view, page)?.chunks {
                if checked.insert((
                    descriptor.html_href.clone(),
                    descriptor.html_hash.clone(),
                    descriptor.byte_length,
                )) {
                    bundle.read_chunk_verified(&descriptor)?;
                }
                if checked.insert((descriptor.map_href.clone(), descriptor.map_hash.clone(), 0)) {
                    bundle.read_map_verified(&descriptor)?;
                }
                crate::bundle::hash_descriptor(&mut root, &descriptor);
            }
        }
        if crate::bundle::finalize_root_hash(bundle, root, &record.asset_index_href)?
            != record.root_hash
        {
            return Err(HcdError::InvalidBundle(format!(
                "offline history root mismatch at r{at}"
            )));
        }
        for asset in bundle.read_asset_index_for_revision(at)? {
            if checked.insert((asset.href.clone(), asset.hash.clone(), asset.byte_length)) {
                crate::patch::validate_staged_asset(bundle, &asset, &asset.hash)?;
            }
        }
        if let Some(href) = view.annotation_href {
            if checked.insert((href.clone(), view.annotation_root_hash.clone(), 0))
                && crate::bundle::hash_decoded_file(
                    &bundle.resolve_href(&href)?,
                    crate::MAX_CONTROL_PART_BYTES,
                )? != view.annotation_root_hash
            {
                return Err(HcdError::InvalidBundle(format!(
                    "offline annotation hash mismatch at r{at}"
                )));
            }
        }
    }
    Ok(())
}
