use crate::bundle::{read_bytes_bounded, Bundle};
use crate::{
    hash_bytes, AssetDescriptor, HcdError, HcdManifest, MAX_CHUNK_BYTES, MAX_CONTROL_PART_BYTES,
};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCategory {
    pub files: usize,
    pub stored_bytes: u64,
    pub decoded_bytes: u64,
    /// Decoded bytes divided by stored bytes; 1.0 means no size reduction.
    pub compression_ratio: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleStats {
    pub revision_count: u64,
    pub total_stored_bytes: u64,
    pub referenced_stored_bytes: u64,
    pub orphan_stored_bytes: u64,
    pub latest_revision_added_bytes: u64,
    pub categories: BTreeMap<String, StorageCategory>,
    pub orphan_hrefs: Vec<String>,
}

pub fn bundle_stats(bundle: &Bundle) -> Result<BundleStats, HcdError> {
    let head = bundle.manifest()?;
    let mut referenced = HashSet::from(["manifest.json".to_string(), "styles.css".to_string()]);
    let mut previous_references = HashSet::new();
    let mut latest_revision_added_bytes = 0u64;
    for revision in 0..=head.revision {
        if revision == head.revision {
            previous_references = referenced.clone();
        }
        collect_revision_references(bundle, &head, revision, &mut referenced)?;
    }
    let mut categories = BTreeMap::<String, StorageCategory>::new();
    let mut all_files = Vec::new();
    collect_files(bundle.root(), bundle.root(), &mut all_files)?;
    let mut total_stored_bytes = 0u64;
    let mut referenced_stored_bytes = 0u64;
    let mut orphan_stored_bytes = 0u64;
    let mut orphan_hrefs = Vec::new();
    for (href, path) in all_files {
        let stored = fs::metadata(&path)?.len();
        total_stored_bytes = total_stored_bytes.saturating_add(stored);
        let category = href.split('/').next().unwrap_or("other").to_string();
        let logical = if href.ends_with(".gz") && referenced.contains(&href) {
            let limit = if category == "chunks" {
                MAX_CHUNK_BYTES as u64
            } else {
                MAX_CONTROL_PART_BYTES
            };
            read_bytes_bounded(&path, limit, "compressed HCD object")?.len() as u64
        } else if href.ends_with(".gz") {
            0
        } else {
            stored
        };
        let group = categories.entry(category).or_default();
        group.files += 1;
        group.stored_bytes = group.stored_bytes.saturating_add(stored);
        group.decoded_bytes = group.decoded_bytes.saturating_add(logical);
        if referenced.contains(&href) {
            referenced_stored_bytes = referenced_stored_bytes.saturating_add(stored);
            if !previous_references.contains(&href) {
                latest_revision_added_bytes = latest_revision_added_bytes.saturating_add(stored);
            }
        } else if eligible_for_gc(&href) {
            orphan_stored_bytes = orphan_stored_bytes.saturating_add(stored);
            orphan_hrefs.push(href);
        }
    }
    orphan_hrefs.sort();
    for category in categories.values_mut() {
        category.compression_ratio = if category.stored_bytes == 0 {
            1.0
        } else {
            category.decoded_bytes as f64 / category.stored_bytes as f64
        };
    }
    Ok(BundleStats {
        revision_count: head.revision.saturating_add(1),
        total_stored_bytes,
        referenced_stored_bytes,
        orphan_stored_bytes,
        latest_revision_added_bytes,
        categories,
        orphan_hrefs,
    })
}

pub fn remove_orphan_objects(bundle: &Bundle) -> Result<BundleStats, HcdError> {
    let _lock = bundle.acquire_write_lock()?;
    let validation = crate::validate_bundle(bundle)?;
    if !validation.valid {
        return Err(HcdError::InvalidBundle(format!(
            "cannot clean a bundle with {} validation issue(s)",
            validation.issues.len()
        )));
    }
    let stats = bundle_stats(bundle)?;
    for href in &stats.orphan_hrefs {
        fs::remove_file(bundle.resolve_href(href)?)?;
    }
    bundle_stats(bundle)
}

fn collect_revision_references(
    bundle: &Bundle,
    head: &HcdManifest,
    revision: u64,
    referenced: &mut HashSet<String>,
) -> Result<(), HcdError> {
    referenced.insert(format!("revisions/{revision:020}.json"));
    let record = bundle.revision(revision)?;
    let mut view = head.clone();
    view.revision = revision;
    view.index_prefix = record.index_prefix;
    view.index_root_href = record.index_root_href;
    if let Some(root) = &view.index_root_href {
        referenced.extend(bundle.index_tree_objects(root)?);
    } else {
        for page in 0..view.index_page_count {
            referenced.insert(format!(
                "{}/{page:06}.json{}",
                view.index_prefix,
                view.storage_codec.suffix()
            ));
        }
    }
    for page in 0..view.index_page_count {
        for descriptor in bundle.read_index_page(&view, page)?.chunks {
            referenced.insert(descriptor.html_href);
            referenced.insert(descriptor.map_href);
        }
    }
    referenced.insert(record.asset_index_href.clone());
    let index: Vec<AssetDescriptor> = crate::bundle::read_json_bounded(
        &bundle.resolve_href(&record.asset_index_href)?,
        MAX_CONTROL_PART_BYTES,
        "asset index",
    )?;
    referenced.extend(index.into_iter().map(|asset| asset.href));
    if record.annotation_root_hash != hash_bytes(b"[]") {
        referenced.insert(format!(
            "annotations/sha256/{}.json{}",
            record.annotation_root_hash,
            view.storage_codec.suffix()
        ));
    }
    Ok(())
}

fn collect_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<(String, std::path::PathBuf)>,
) -> Result<(), HcdError> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(HcdError::InvalidBundle(format!(
                "bundle contains a symbolic link: {}",
                path.display()
            )));
        }
        if kind.is_dir() {
            collect_files(root, &path, files)?;
        } else if kind.is_file() {
            let href = path
                .strip_prefix(root)
                .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
                .to_str()
                .ok_or_else(|| HcdError::InvalidBundle("bundle path is not UTF-8".to_string()))?
                .replace(std::path::MAIN_SEPARATOR, "/");
            files.push((href, path));
        }
    }
    Ok(())
}

fn eligible_for_gc(href: &str) -> bool {
    [
        "chunks/sha256/",
        "maps/sha256/",
        "indexes/pages/sha256/",
        "indexes/nodes/sha256/",
        "annotations/sha256/",
        "assets/sha256/",
        "assets/indexes/sha256/",
    ]
    .iter()
    .any(|prefix| href.starts_with(prefix))
}
