use crate::hash::{hash_bytes, node_bloom};
use crate::{
    AssetDescriptor, ChunkDescriptor, ChunkIndexPage, ChunkSourceMap, HcdError, HcdManifest,
    RevisionRecord, StorageCodec, HCD_SCHEMA_VERSION, MAX_CHUNK_BYTES, MAX_CONTROL_PART_BYTES,
};
use flate2::read::MultiGzDecoder;
use flate2::{Compression, GzBuilder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const INDEX_PAGE_SIZE: usize = 128;
const INDEX_TREE_FANOUT: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IndexTreeNode {
    first_page: usize,
    child_span: usize,
    children: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Bundle {
    root: PathBuf,
}

impl Bundle {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, HcdError> {
        let root = root.as_ref().to_path_buf();
        if !root.is_dir() {
            return Err(HcdError::InvalidBundle(format!(
                "bundle directory does not exist: {}",
                root.display()
            )));
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn manifest(&self) -> Result<HcdManifest, HcdError> {
        read_json_bounded(
            &self.resolve_href("manifest.json")?,
            MAX_CONTROL_PART_BYTES,
            "manifest",
        )
    }

    pub fn read_index_page(
        &self,
        manifest: &HcdManifest,
        page: usize,
    ) -> Result<ChunkIndexPage, HcdError> {
        if page >= manifest.index_page_count {
            return Err(HcdError::InvalidBundle(format!(
                "index page {page} exceeds page count {}",
                manifest.index_page_count
            )));
        }
        if let Some(root) = &manifest.index_root_href {
            let href = self.index_page_href(root, page)?;
            return self.read_index_object(&href);
        }
        let href = format!(
            "{}/{page:06}.json{}",
            manifest.index_prefix,
            manifest.storage_codec.suffix()
        );
        read_json_bounded(
            &self.resolve_href(&href)?,
            MAX_CONTROL_PART_BYTES,
            "index page",
        )
    }

    fn read_index_object<T: serde::de::DeserializeOwned>(&self, href: &str) -> Result<T, HcdError> {
        let path = self.resolve_href(href)?;
        let hash = href
            .rsplit_once('/')
            .and_then(|(_, name)| name.split_once('.'))
            .map(|(hash, _)| hash)
            .ok_or_else(|| HcdError::InvalidBundle(format!("invalid index object href {href}")))?;
        let decoded = read_bytes_bounded(&path, MAX_CONTROL_PART_BYTES, "index object")?;
        if hash_bytes(&decoded) != hash {
            return Err(HcdError::InvalidBundle(format!(
                "index object {href} does not match its content hash"
            )));
        }
        Ok(serde_json::from_slice(&decoded)?)
    }

    pub(crate) fn index_page_href(&self, root: &str, page: usize) -> Result<String, HcdError> {
        let mut href = root.to_string();
        for _ in 0..12 {
            let node: IndexTreeNode = self.read_index_object(&href)?;
            if node.children.is_empty()
                || node.children.len() > INDEX_TREE_FANOUT
                || node.child_span == 0
                || page < node.first_page
            {
                return Err(HcdError::InvalidBundle(format!(
                    "invalid index tree node {href}"
                )));
            }
            let child = (page - node.first_page) / node.child_span;
            let next = node
                .children
                .get(child)
                .ok_or_else(|| HcdError::InvalidBundle(format!("index tree has no page {page}")))?;
            if node.child_span == 1 {
                return Ok(next.clone());
            }
            href = next.clone();
        }
        Err(HcdError::ResourceLimit(
            "index tree exceeds depth 12".to_string(),
        ))
    }

    pub(crate) fn index_tree_objects(&self, root: &str) -> Result<HashSet<String>, HcdError> {
        let mut objects = HashSet::new();
        self.collect_index_tree_objects(root, &mut objects, 0)?;
        Ok(objects)
    }

    fn collect_index_tree_objects(
        &self,
        href: &str,
        objects: &mut HashSet<String>,
        depth: usize,
    ) -> Result<(), HcdError> {
        if depth >= 12 || objects.len() > 1_000_000 {
            return Err(HcdError::ResourceLimit(
                "index tree exceeds traversal limit".to_string(),
            ));
        }
        if !objects.insert(href.to_string()) {
            return Ok(());
        }
        let node: IndexTreeNode = self.read_index_object(href)?;
        if node.children.is_empty()
            || node.children.len() > INDEX_TREE_FANOUT
            || node.child_span == 0
        {
            return Err(HcdError::InvalidBundle(format!(
                "invalid index tree node {href}"
            )));
        }
        for child in node.children {
            if node.child_span == 1 {
                objects.insert(child);
            } else {
                self.collect_index_tree_objects(&child, objects, depth + 1)?;
            }
        }
        Ok(())
    }

    pub fn replace_index_page(
        &self,
        root: &str,
        page_number: usize,
        page: &ChunkIndexPage,
    ) -> Result<String, HcdError> {
        if page.page != page_number {
            return Err(HcdError::InvalidBundle(
                "index page number mismatch".to_string(),
            ));
        }
        let codec = self.manifest()?.storage_codec;
        let page_href = write_index_object(&self.root, codec, "pages", page)?;
        self.replace_index_path(root, page_number, &page_href, codec, 0)
    }

    fn replace_index_path(
        &self,
        href: &str,
        page: usize,
        replacement: &str,
        codec: StorageCodec,
        depth: usize,
    ) -> Result<String, HcdError> {
        if depth >= 12 {
            return Err(HcdError::ResourceLimit(
                "index tree exceeds depth 12".to_string(),
            ));
        }
        let mut node: IndexTreeNode = self.read_index_object(href)?;
        if node.child_span == 0 || page < node.first_page {
            return Err(HcdError::InvalidBundle(format!(
                "invalid index tree node {href}"
            )));
        }
        let child = (page - node.first_page) / node.child_span;
        let old = node
            .children
            .get(child)
            .ok_or_else(|| HcdError::InvalidBundle(format!("index tree has no page {page}")))?
            .clone();
        node.children[child] = if node.child_span == 1 {
            replacement.to_string()
        } else {
            self.replace_index_path(&old, page, replacement, codec, depth + 1)?
        };
        write_index_object(&self.root, codec, "nodes", &node)
    }

    /// Append a page after the last page the tree already reaches.
    ///
    /// `replace_index_page` rewrites a page in place. A patch that mints a new
    /// chunk fills the last page first, and only then needs one more page, so
    /// this walks to the node owning the tail of the tree, opens a slot for
    /// `page_number`, and returns the new root href. Every object is content
    /// addressed, so the root the previous revision pointed at stays reachable
    /// from its own revision record.
    pub fn append_index_page(
        &self,
        root: &str,
        page_number: usize,
        page: &ChunkIndexPage,
    ) -> Result<String, HcdError> {
        if page.page != page_number {
            return Err(HcdError::InvalidBundle(
                "index page number mismatch".to_string(),
            ));
        }
        let codec = self.manifest()?.storage_codec;
        let page_href = write_index_object(&self.root, codec, "pages", page)?;
        self.append_index_path(root, page_number, &page_href, codec, 0)
    }

    fn append_index_path(
        &self,
        href: &str,
        page: usize,
        page_href: &str,
        codec: StorageCodec,
        depth: usize,
    ) -> Result<String, HcdError> {
        if depth >= 12 {
            return Err(HcdError::ResourceLimit(
                "index tree exceeds depth 12".to_string(),
            ));
        }
        let mut node: IndexTreeNode = self.read_index_object(href)?;
        if node.child_span == 0 || node.children.len() > INDEX_TREE_FANOUT || page < node.first_page
        {
            return Err(HcdError::InvalidBundle(format!(
                "invalid index tree node {href}"
            )));
        }
        let end = node
            .children
            .len()
            .checked_mul(node.child_span)
            .and_then(|cover| node.first_page.checked_add(cover))
            .ok_or_else(|| HcdError::ResourceLimit("index tree page range overflow".to_string()))?;
        if page < end {
            // A child already claims this page. Leaf nodes hold pages directly,
            // so reaching one means the page exists and cannot be appended.
            let child = (page - node.first_page) / node.child_span;
            if node.child_span == 1 {
                return Err(HcdError::InvalidBundle(format!(
                    "index tree already has page {page}"
                )));
            }
            let old =
                node.children.get(child).cloned().ok_or_else(|| {
                    HcdError::InvalidBundle(format!("index tree has no page {page}"))
                })?;
            node.children[child] =
                self.append_index_path(&old, page, page_href, codec, depth + 1)?;
        } else if page == end {
            if node.children.len() == INDEX_TREE_FANOUT {
                return Err(HcdError::ResourceLimit(
                    "index tree is full; growing a level is not supported".to_string(),
                ));
            }
            node.children.push(if node.child_span == 1 {
                page_href.to_string()
            } else {
                // The new page starts a run of leaf children under this node.
                write_index_object(
                    &self.root,
                    codec,
                    "nodes",
                    &IndexTreeNode {
                        first_page: page,
                        child_span: 1,
                        children: vec![page_href.to_string()],
                    },
                )?
            });
        } else {
            return Err(HcdError::InvalidBundle(format!(
                "index tree ends before page {page}"
            )));
        }
        write_index_object(&self.root, codec, "nodes", &node)
    }

    /// Rewrite the pages the tree `root` reaches, page for page, and return the
    /// new root.
    ///
    /// A removal takes chunks out of the middle of the index, and every page
    /// after the hole changes with it: their descriptors are renumbered and
    /// re-split, so the page that lost a chunk takes one from the head of the
    /// next. Only pages whose chunk list actually differs are written, so a
    /// rewrite that begins halfway through the index keeps the objects in front
    /// of it and costs one node per page behind the change.
    ///
    /// The tree keeps the shape it has, which means the page count cannot fall:
    /// a removal that empties the last page leaves that page in place with
    /// nothing on it, and it is reclaimed once the index can shrink. Every
    /// object is content addressed, so the root an earlier revision pointed at
    /// still resolves the pages that revision described.
    pub fn replace_index_pages(
        &self,
        root: &str,
        pages: &[ChunkIndexPage],
    ) -> Result<String, HcdError> {
        let mut current = root.to_string();
        for page in pages {
            let href = self.index_page_href(&current, page.page)?;
            let existing: ChunkIndexPage = self.read_index_object(&href)?;
            if existing.chunks == page.chunks {
                continue;
            }
            current = self.replace_index_page(&current, page.page, page)?;
        }
        Ok(current)
    }

    pub fn read_map(&self, descriptor: &ChunkDescriptor) -> Result<ChunkSourceMap, HcdError> {
        read_json_bounded(
            &self.resolve_href(&descriptor.map_href)?,
            MAX_CONTROL_PART_BYTES,
            "source map",
        )
    }

    pub fn read_map_verified(
        &self,
        descriptor: &ChunkDescriptor,
    ) -> Result<ChunkSourceMap, HcdError> {
        let bytes = read_bytes_bounded(
            &self.resolve_href(&descriptor.map_href)?,
            MAX_CONTROL_PART_BYTES,
            "source map",
        )?;
        if hash_bytes(&bytes) != descriptor.map_hash {
            return Err(HcdError::InvalidBundle(format!(
                "source map {} does not match its descriptor hash",
                descriptor.map_href
            )));
        }
        Ok(serde_json::from_slice(&bytes)?)
    }

    pub fn read_asset_index(&self) -> Result<Vec<AssetDescriptor>, HcdError> {
        read_json_bounded(
            &self.resolve_href("assets/index.json")?,
            MAX_CONTROL_PART_BYTES,
            "asset index",
        )
    }

    pub fn asset_index_href_for_revision(&self, revision: u64) -> Result<String, HcdError> {
        Ok(self.revision(revision)?.asset_index_href)
    }

    pub fn read_asset_index_for_revision(
        &self,
        revision: u64,
    ) -> Result<Vec<AssetDescriptor>, HcdError> {
        let href = self.asset_index_href_for_revision(revision)?;
        read_json_bounded(
            &self.resolve_href(&href)?,
            MAX_CONTROL_PART_BYTES,
            "revision asset index",
        )
    }

    /// Write an unindexed immutable asset object. It becomes visible to a
    /// revision only when an `image.replace` patch references its hash.
    pub fn stage_asset_from_reader(
        &self,
        extension: &str,
        reader: &mut (impl std::io::Read + ?Sized),
    ) -> Result<AssetDescriptor, HcdError> {
        let (href, hash, byte_length) =
            write_asset_payload(&self.root, extension, reader, crate::MAX_STAGED_ASSET_BYTES)?;
        let source_part = format!("html/uploads/{hash}");
        let descriptor = AssetDescriptor {
            source_part,
            hash: hash.clone(),
            href,
            byte_length,
        };
        let path = self.root.join("assets/staged").join(format!("{hash}.json"));
        atomic_write_json(&path, &descriptor)?;
        Ok(descriptor)
    }

    pub(crate) fn staged_asset(&self, hash: &str) -> Result<AssetDescriptor, HcdError> {
        read_json_bounded(
            &self.resolve_href(&format!("assets/staged/{hash}.json"))?,
            MAX_CONTROL_PART_BYTES,
            "staged asset",
        )
    }

    pub fn read_chunk(&self, descriptor: &ChunkDescriptor) -> Result<String, HcdError> {
        read_text_bounded(
            &self.resolve_href(&descriptor.html_href)?,
            MAX_CHUNK_BYTES as u64,
            "HTML chunk",
        )
    }

    pub fn read_chunk_verified(&self, descriptor: &ChunkDescriptor) -> Result<String, HcdError> {
        let html = self.read_chunk(descriptor)?;
        if html.len() as u64 != descriptor.byte_length
            || hash_bytes(html.as_bytes()) != descriptor.html_hash
        {
            return Err(HcdError::InvalidBundle(format!(
                "HTML chunk {} does not match its descriptor length/hash",
                descriptor.chunk_id
            )));
        }
        Ok(html)
    }

    pub fn resolve_href(&self, href: &str) -> Result<PathBuf, HcdError> {
        let relative = safe_relative_path(href)?;
        let mut resolved = self.root.clone();
        for component in relative.components() {
            let Component::Normal(component) = component else {
                return Err(HcdError::InvalidBundle(format!(
                    "unsafe relative path: {href}"
                )));
            };
            resolved.push(component);
            match fs::symlink_metadata(&resolved) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(HcdError::InvalidBundle(format!(
                        "bundle href traverses a symbolic link: {href}"
                    )));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(HcdError::Io(error)),
            }
        }
        Ok(resolved)
    }

    pub fn revision(&self, revision: u64) -> Result<RevisionRecord, HcdError> {
        if revision > crate::MAX_REVISION {
            return Err(HcdError::ResourceLimit(format!(
                "revision {revision} exceeds the maximum {}",
                crate::MAX_REVISION
            )));
        }
        read_json_bounded(
            &self.resolve_href(&format!("revisions/{revision:020}.json"))?,
            MAX_CONTROL_PART_BYTES,
            "revision record",
        )
    }

    pub fn write_json_object<T: serde::Serialize>(
        &self,
        directory: &str,
        value: &T,
    ) -> Result<(String, String), HcdError> {
        let bytes = serde_json::to_vec(value)?;
        if bytes.len() as u64 > MAX_CONTROL_PART_BYTES {
            return Err(HcdError::ResourceLimit(format!(
                "{directory} object exceeds the {MAX_CONTROL_PART_BYTES} byte limit"
            )));
        }
        let hash = hash_bytes(&bytes);
        let codec = self.manifest()?.storage_codec;
        let href = format!("{directory}/sha256/{hash}.json{}", codec.suffix());
        write_content_addressed(&self.root, &href, &bytes)?;
        Ok((href, hash))
    }

    pub fn write_chunk_object(&self, html: &str) -> Result<(String, String), HcdError> {
        if html.len() > MAX_CHUNK_BYTES {
            return Err(HcdError::ResourceLimit(format!(
                "HTML chunk is {} bytes; maximum is {}",
                html.len(),
                MAX_CHUNK_BYTES
            )));
        }
        let hash = hash_bytes(html.as_bytes());
        let codec = self.manifest()?.storage_codec;
        let href = format!("chunks/sha256/{hash}.html{}", codec.suffix());
        write_content_addressed(&self.root, &href, html.as_bytes())?;
        Ok((href, hash))
    }

    pub fn write_revision(&self, record: &RevisionRecord) -> Result<(), HcdError> {
        if record.revision > crate::MAX_REVISION {
            return Err(HcdError::ResourceLimit(format!(
                "revision {} exceeds the maximum {}",
                record.revision,
                crate::MAX_REVISION
            )));
        }
        atomic_write_json(
            &self
                .root
                .join("revisions")
                .join(format!("{:020}.json", record.revision)),
            record,
        )
    }

    pub fn write_manifest(&self, manifest: &HcdManifest) -> Result<(), HcdError> {
        atomic_write_json(&self.root.join("manifest.json"), manifest)
    }

    pub(crate) fn acquire_write_lock(&self) -> Result<BundleWriteGuard, HcdError> {
        let path = self.root.join(".hcd-write-lock");
        let mut lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(HcdError::Io)?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(fs::TryLockError::WouldBlock) => {
                return Err(HcdError::RevisionConflict(
                    "another local HCD mutation is already in progress".to_string(),
                ));
            }
            Err(fs::TryLockError::Error(error)) => return Err(HcdError::Io(error)),
        }
        lock.set_len(0)?;
        writeln!(
            lock,
            "pid={} epochMs={}",
            std::process::id(),
            now_epoch_ms()
        )?;
        lock.sync_all()?;
        Ok(BundleWriteGuard { _lock: lock })
    }
}

pub(crate) struct BundleWriteGuard {
    _lock: fs::File,
}

pub struct BundleWriter {
    root: PathBuf,
    storage_codec: StorageCodec,
    pending: Vec<ChunkDescriptor>,
    page_count: usize,
    index_pages: Vec<String>,
    chunk_count: usize,
    root_hasher: Sha256,
    finished: bool,
}

struct ChunkWriteOptions {
    region: String,
    block_count: usize,
    continuation: bool,
    grid: Option<crate::GridChunkAddress>,
}

impl BundleWriter {
    pub fn create(root: impl AsRef<Path>) -> Result<Self, HcdError> {
        Self::create_with_codec(root, StorageCodec::None)
    }

    pub fn create_with_codec(
        root: impl AsRef<Path>,
        storage_codec: StorageCodec,
    ) -> Result<Self, HcdError> {
        let root = root.as_ref().to_path_buf();
        if root.exists() {
            return Err(HcdError::InvalidBundle(format!(
                "output already exists: {}",
                root.display()
            )));
        }
        fs::create_dir_all(&root)?;
        for directory in [
            "indexes/rev-00000000000000000000",
            "chunks/sha256",
            "maps/sha256",
            "annotations/sha256",
            "assets/sha256",
            "assets/staged",
            "assets/indexes/sha256",
            "revisions",
        ] {
            fs::create_dir_all(root.join(directory))?;
        }
        fs::write(root.join("assets/index.json"), b"[]")?;
        fs::write(root.join(".importing"), b"hcd/2\n")?;
        Ok(Self {
            root,
            storage_codec,
            pending: Vec::with_capacity(INDEX_PAGE_SIZE),
            page_count: 0,
            index_pages: Vec::new(),
            chunk_count: 0,
            root_hasher: Sha256::new(),
            finished: false,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn write_styles(&self, styles: &str) -> Result<(), HcdError> {
        crate::html::validate_css_text(styles)?;
        atomic_write(&self.root.join("styles.css"), styles.as_bytes())
    }

    pub fn write_chunk(
        &mut self,
        chunk_id: String,
        region: String,
        html: String,
        source_map: ChunkSourceMap,
        block_count: usize,
        continuation: bool,
    ) -> Result<ChunkDescriptor, HcdError> {
        self.write_chunk_with_options(
            chunk_id,
            html,
            source_map,
            ChunkWriteOptions {
                region,
                block_count,
                continuation,
                grid: None,
            },
        )
    }

    pub fn write_grid_chunk(
        &mut self,
        chunk_id: String,
        html: String,
        source_map: ChunkSourceMap,
        block_count: usize,
        continuation: bool,
        grid: crate::GridChunkAddress,
    ) -> Result<ChunkDescriptor, HcdError> {
        self.write_chunk_with_options(
            chunk_id,
            html,
            source_map,
            ChunkWriteOptions {
                region: "sheet".to_string(),
                block_count,
                continuation,
                grid: Some(grid),
            },
        )
    }

    fn write_chunk_with_options(
        &mut self,
        chunk_id: String,
        html: String,
        source_map: ChunkSourceMap,
        options: ChunkWriteOptions,
    ) -> Result<ChunkDescriptor, HcdError> {
        if html.len() > MAX_CHUNK_BYTES {
            return Err(HcdError::ResourceLimit(format!(
                "NODE_TOO_LARGE: chunk {} is {} bytes; maximum is {}",
                chunk_id,
                html.len(),
                MAX_CHUNK_BYTES
            )));
        }
        if source_map.chunk_id != chunk_id {
            return Err(HcdError::InvalidBundle(format!(
                "source map chunk id {} does not match {}",
                source_map.chunk_id, chunk_id
            )));
        }

        let html_hash = hash_bytes(html.as_bytes());
        let html_href = format!(
            "chunks/sha256/{html_hash}.html{}",
            self.storage_codec.suffix()
        );
        write_content_addressed(&self.root, &html_href, html.as_bytes())?;

        let map_bytes = serde_json::to_vec(&source_map)?;
        let map_hash = hash_bytes(&map_bytes);
        let map_href = format!("maps/sha256/{map_hash}.json{}", self.storage_codec.suffix());
        write_content_addressed(&self.root, &map_href, &map_bytes)?;

        let html_nodes = crate::extract_html_text_nodes(&html)?;
        if html_nodes.len() != source_map.entries.len() {
            return Err(HcdError::InvalidBundle(format!(
                "chunk {} contains {} canonical text nodes but its map contains {}",
                chunk_id,
                html_nodes.len(),
                source_map.entries.len()
            )));
        }
        for entry in &source_map.entries {
            let text = html_nodes.get(&entry.node_id).ok_or_else(|| {
                HcdError::InvalidBundle(format!(
                    "mapped node {} is missing from canonical HTML",
                    entry.node_id
                ))
            })?;
            let actual_hash = hash_bytes(text.as_bytes());
            if actual_hash != entry.node_hash {
                return Err(HcdError::InvalidBundle(format!(
                    "mapped node {} expected hash {}, actual {}",
                    entry.node_id, entry.node_hash, actual_hash
                )));
            }
        }

        let descriptor = ChunkDescriptor {
            sequence: self.chunk_count,
            chunk_id,
            region: options.region,
            html_href,
            html_hash,
            map_href,
            map_hash,
            byte_length: html.len() as u64,
            block_count: options.block_count,
            node_count: source_map.entries.len(),
            text_chars: html_nodes.values().map(|text| text.chars().count()).sum(),
            node_bloom: node_bloom(
                source_map
                    .entries
                    .iter()
                    .map(|entry| entry.node_id.as_str()),
            ),
            first_node_id: source_map
                .entries
                .first()
                .map(|entry| entry.node_id.clone()),
            last_node_id: source_map.entries.last().map(|entry| entry.node_id.clone()),
            continuation: options.continuation,
            grid: options.grid,
        };
        self.add_descriptor(descriptor.clone())?;
        Ok(descriptor)
    }

    pub fn add_descriptor(&mut self, descriptor: ChunkDescriptor) -> Result<(), HcdError> {
        if descriptor.sequence != self.chunk_count {
            return Err(HcdError::InvalidBundle(format!(
                "chunk sequence {} is not expected {}",
                descriptor.sequence, self.chunk_count
            )));
        }
        hash_descriptor(&mut self.root_hasher, &descriptor);
        self.pending.push(descriptor);
        self.chunk_count += 1;
        if self.pending.len() == INDEX_PAGE_SIZE {
            self.flush_index_page()?;
        }
        Ok(())
    }

    pub fn write_asset_from_reader(
        &self,
        extension: &str,
        reader: &mut (impl std::io::Read + ?Sized),
    ) -> Result<(String, String, u64), HcdError> {
        write_asset_payload(&self.root, extension, reader, u64::MAX)
    }

    pub fn finish(mut self, mut manifest: HcdManifest) -> Result<HcdManifest, HcdError> {
        self.flush_index_page()?;
        manifest.schema_version = HCD_SCHEMA_VERSION.to_string();
        manifest.storage_codec = self.storage_codec;
        manifest.revision = 0;
        let bundle = Bundle {
            root: self.root.clone(),
        };
        manifest.root_hash =
            finalize_root_hash(&bundle, self.root_hasher.clone(), "assets/index.json")?;
        manifest.annotation_root_hash = hash_bytes(b"[]");
        manifest.annotation_href = None;
        manifest.index_prefix = "indexes/rev-00000000000000000000".to_string();
        manifest.index_root_href =
            build_index_tree(&self.root, self.storage_codec, &self.index_pages)?;
        manifest.index_page_count = self.page_count;
        manifest.chunk_count = self.chunk_count;
        manifest.styles_href = "styles.css".to_string();
        manifest.state = "COMPLETE".to_string();

        let record = RevisionRecord {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            document_id: manifest.document_id.clone(),
            revision: 0,
            parent_revision: None,
            patch_id: None,
            patch_hash: None,
            patch_base_revision: None,
            author_id: None,
            author_name: None,
            root_hash: manifest.root_hash.clone(),
            annotation_root_hash: manifest.annotation_root_hash.clone(),
            index_prefix: manifest.index_prefix.clone(),
            index_root_href: manifest.index_root_href.clone(),
            index_page_count: Some(manifest.index_page_count),
            chunk_count: Some(manifest.chunk_count),
            asset_index_href: "assets/index.json".to_string(),
            created_at_epoch_ms: now_epoch_ms(),
            dirty_node_ids: Vec::new(),
            removed_node_ids: Vec::new(),
            dirty_chunk_ids: Vec::new(),
            dirty_source_parts: Vec::new(),
            dirty_grid_parts: Vec::new(),
            converted_formula_node_ids: Vec::new(),
            grid_row_insertions: Vec::new(),
            grid_row_deletions: Vec::new(),
            grid_column_insertions: Vec::new(),
            grid_column_deletions: Vec::new(),
            sheet_renames: Vec::new(),
            sheet_additions: Vec::new(),
            sheet_removals: Vec::new(),
            slide_additions: Vec::new(),
            slide_removals: Vec::new(),
            structural_change: false,
        };
        atomic_write_json(
            &self.root.join("revisions/00000000000000000000.json"),
            &record,
        )?;
        atomic_write_json(&self.root.join("manifest.json"), &manifest)?;
        let importing = self.root.join(".importing");
        if importing.exists() {
            fs::remove_file(importing)?;
        }
        self.finished = true;
        Ok(manifest)
    }

    fn flush_index_page(&mut self) -> Result<(), HcdError> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let page = ChunkIndexPage {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            revision: 0,
            page: self.page_count,
            chunks: std::mem::take(&mut self.pending),
        };
        let href = write_index_object(&self.root, self.storage_codec, "pages", &page)?;
        self.index_pages.push(href);
        self.page_count += 1;
        Ok(())
    }
}

fn write_index_object<T: Serialize>(
    root: &Path,
    codec: StorageCodec,
    kind: &str,
    value: &T,
) -> Result<String, HcdError> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() as u64 > MAX_CONTROL_PART_BYTES {
        return Err(HcdError::ResourceLimit(
            "index object exceeds 16 MiB".to_string(),
        ));
    }
    let hash = hash_bytes(&bytes);
    let href = format!("indexes/{kind}/sha256/{hash}.json{}", codec.suffix());
    write_content_addressed(root, &href, &bytes)?;
    Ok(href)
}

fn build_index_tree(
    root: &Path,
    codec: StorageCodec,
    pages: &[String],
) -> Result<Option<String>, HcdError> {
    if pages.is_empty() {
        return Ok(None);
    }
    let mut children = pages.to_vec();
    let mut child_span = 1usize;
    loop {
        let mut parents = Vec::with_capacity(children.len().div_ceil(INDEX_TREE_FANOUT));
        for (group, entries) in children.chunks(INDEX_TREE_FANOUT).enumerate() {
            let first_page = group
                .checked_mul(INDEX_TREE_FANOUT)
                .and_then(|offset| offset.checked_mul(child_span))
                .ok_or_else(|| {
                    HcdError::ResourceLimit("index tree page range overflow".to_string())
                })?;
            parents.push(write_index_object(
                root,
                codec,
                "nodes",
                &IndexTreeNode {
                    first_page,
                    child_span,
                    children: entries.to_vec(),
                },
            )?);
        }
        if parents.len() == 1 {
            return Ok(parents.pop());
        }
        children = parents;
        child_span = child_span
            .checked_mul(INDEX_TREE_FANOUT)
            .ok_or_else(|| HcdError::ResourceLimit("index tree span overflow".to_string()))?;
    }
}

impl Drop for BundleWriter {
    fn drop(&mut self) {
        if !self.finished {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

pub(crate) fn read_json_bounded<T: serde::de::DeserializeOwned>(
    path: &Path,
    maximum_bytes: u64,
    kind: &str,
) -> Result<T, HcdError> {
    let bytes = read_bytes_bounded(path, maximum_bytes, kind)?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub(crate) fn read_text_bounded(
    path: &Path,
    maximum_bytes: u64,
    kind: &str,
) -> Result<String, HcdError> {
    let bytes = read_bytes_bounded(path, maximum_bytes, kind)?;
    String::from_utf8(bytes)
        .map_err(|error| HcdError::InvalidBundle(format!("{kind} is not UTF-8: {error}")))
}

pub(crate) fn read_bytes_bounded(
    path: &Path,
    maximum_bytes: u64,
    kind: &str,
) -> Result<Vec<u8>, HcdError> {
    let metadata = fs::metadata(path)?;
    let compressed = path.extension().is_some_and(|extension| extension == "gz");
    let maximum_stored_bytes = if compressed {
        maximum_bytes
            .saturating_add(maximum_bytes / 16)
            .saturating_add(64 * 1024)
    } else {
        maximum_bytes
    };
    if metadata.len() > maximum_stored_bytes {
        return Err(HcdError::ResourceLimit(format!(
            "{kind} {} is {} stored bytes; maximum is {maximum_stored_bytes}",
            path.display(),
            metadata.len()
        )));
    }
    let mut bytes = Vec::with_capacity(metadata.len().min(maximum_bytes) as usize);
    let file = fs::File::open(path)?;
    if compressed {
        MultiGzDecoder::new(file)
            .take(maximum_bytes.saturating_add(1))
            .read_to_end(&mut bytes)?;
    } else {
        file.take(maximum_bytes.saturating_add(1))
            .read_to_end(&mut bytes)?;
    }
    if bytes.len() as u64 > maximum_bytes {
        return Err(HcdError::ResourceLimit(format!(
            "{kind} {} grew beyond the {maximum_bytes} byte limit while reading",
            path.display()
        )));
    }
    Ok(bytes)
}

pub(crate) fn atomic_write_json<T: serde::Serialize>(
    path: &Path,
    value: &T,
) -> Result<(), HcdError> {
    atomic_write(path, &serde_json::to_vec(value)?)
}

pub(crate) fn atomic_write_json_encoded<T: serde::Serialize>(
    path: &Path,
    value: &T,
) -> Result<(), HcdError> {
    atomic_write_encoded(path, &serde_json::to_vec(value)?)
}

pub(crate) fn atomic_write_encoded(path: &Path, bytes: &[u8]) -> Result<(), HcdError> {
    if path.extension().is_some_and(|extension| extension == "gz") {
        let mut encoder = GzBuilder::new()
            .mtime(0)
            .write(Vec::new(), Compression::new(6));
        encoder.write_all(bytes)?;
        atomic_write(path, &encoder.finish()?)
    } else {
        atomic_write(path, bytes)
    }
}

pub(crate) fn hash_decoded_file(path: &Path, maximum_bytes: u64) -> Result<String, HcdError> {
    Ok(hash_bytes(&read_bytes_bounded(
        path,
        maximum_bytes,
        "content object",
    )?))
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), HcdError> {
    let parent = path.parent().ok_or_else(|| {
        HcdError::InvalidBundle(format!("path has no parent: {}", path.display()))
    })?;
    fs::create_dir_all(parent)?;
    let mut temp = tempfile::Builder::new()
        .prefix(".hcd-")
        .tempfile_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path)
        .map_err(|error| HcdError::Io(error.error))?;
    Ok(())
}

pub(crate) fn write_content_addressed(
    root: &Path,
    href: &str,
    bytes: &[u8],
) -> Result<(), HcdError> {
    let relative = safe_relative_path(href)?;
    let path = root.join(relative);
    if path.exists() {
        let expected_hash = hash_bytes(bytes);
        let existing_hash = hash_decoded_file(&path, bytes.len() as u64)?;
        if existing_hash != expected_hash {
            return Err(HcdError::InvalidBundle(format!(
                "content-addressed object {} contains hash {} instead of {}",
                path.display(),
                existing_hash,
                expected_hash
            )));
        }
        return Ok(());
    }
    atomic_write_encoded(&path, bytes)
}

pub(crate) fn safe_relative_path(value: &str) -> Result<PathBuf, HcdError> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(HcdError::InvalidBundle(format!(
            "unsafe relative path: {value}"
        )));
    }
    Ok(path.to_path_buf())
}

pub(crate) fn hash_descriptor(hasher: &mut Sha256, descriptor: &ChunkDescriptor) {
    let value =
        serde_json::to_vec(descriptor).expect("ChunkDescriptor serialization is infallible");
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

/// Finish the revision body root from canonical HTML/map descriptors plus the
/// immutable rendering inputs shared by every revision. Annotations are
/// intentionally excluded and use `annotationRootHash` instead.
pub(crate) fn finalize_root_hash(
    bundle: &Bundle,
    descriptor_hasher: Sha256,
    asset_index_href: &str,
) -> Result<String, HcdError> {
    let descriptor_digest = descriptor_hasher.finalize();
    let styles = crate::hash::hash_file(&bundle.resolve_href("styles.css")?)?;
    let assets = crate::hash::hash_file(&bundle.resolve_href(asset_index_href)?)?;
    let mut root = Sha256::new();
    root.update(b"officecli-hcd-body-root/1\0");
    hash_root_component(&mut root, "chunks-and-maps", descriptor_digest.as_slice());
    hash_root_component(&mut root, "styles.css", styles.as_bytes());
    hash_root_component(&mut root, "assets/index.json", assets.as_bytes());
    Ok(encode_digest(root.finalize().as_slice()))
}

fn write_asset_payload(
    root: &Path,
    extension: &str,
    reader: &mut (impl std::io::Read + ?Sized),
    maximum_bytes: u64,
) -> Result<(String, String, u64), HcdError> {
    fs::create_dir_all(root.join("assets/sha256"))?;
    let temp = tempfile::Builder::new()
        .prefix(".hcd-asset-")
        .tempfile_in(root.join("assets/sha256"))?;
    let mut file = temp.reopen()?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total.checked_add(count as u64).ok_or_else(|| {
            HcdError::ResourceLimit("staged asset byte count overflowed".to_string())
        })?;
        if total > maximum_bytes {
            return Err(HcdError::ResourceLimit(format!(
                "asset exceeds the {maximum_bytes} byte limit"
            )));
        }
        file.write_all(&buffer[..count])?;
        hasher.update(&buffer[..count]);
    }
    file.sync_all()?;
    let hash = encode_digest(hasher.finalize().as_slice());
    let clean_extension = extension
        .trim_start_matches('.')
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(16)
        .collect::<String>()
        .to_ascii_lowercase();
    let file_name = if clean_extension.is_empty() {
        hash.clone()
    } else {
        format!("{hash}.{clean_extension}")
    };
    let relative = format!("assets/sha256/{file_name}");
    let target = root.join(&relative);
    if target.exists() {
        let existing_hash = crate::hash_file(&target)?;
        if existing_hash != hash {
            return Err(HcdError::InvalidBundle(format!(
                "content-addressed asset {} contains hash {}",
                target.display(),
                existing_hash
            )));
        }
        drop(temp);
    } else {
        temp.persist(&target)
            .map_err(|error| HcdError::Io(error.error))?;
    }
    Ok((relative, hash, total))
}

fn hash_root_component(hasher: &mut Sha256, name: &str, value: &[u8]) {
    hasher.update((name.len() as u64).to_be_bytes());
    hasher.update(name.as_bytes());
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

pub(crate) fn encode_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

pub(crate) fn now_epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HcdCapabilities, SourceDescriptor};

    #[test]
    fn safe_paths_reject_parent_components() {
        assert!(safe_relative_path("chunks/a.html").is_ok());
        assert!(safe_relative_path("../manifest.json").is_err());
        assert!(safe_relative_path("/tmp/file").is_err());
    }

    #[test]
    fn empty_bundle_finishes_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("doc.hcd");
        let writer = BundleWriter::create(&root).unwrap();
        writer.write_styles("article { color: #000; }").unwrap();
        let manifest = HcdManifest {
            schema_version: String::new(),
            storage_codec: crate::StorageCodec::None,
            document_id: "doc-1".to_string(),
            profile: "semantic-flow".to_string(),
            revision: 99,
            source: SourceDescriptor {
                format: "docx".to_string(),
                sha256: "00".repeat(32),
                size_bytes: 1,
            },
            root_hash: String::new(),
            annotation_root_hash: String::new(),
            annotation_href: None,
            index_prefix: String::new(),
            index_root_href: None,
            index_page_count: 0,
            chunk_count: 0,
            styles_href: String::new(),
            capabilities: HcdCapabilities::default(),
            fidelity: None,
            state: String::new(),
            warnings: Vec::new(),
        };
        writer.finish(manifest).unwrap();
        assert!(root.join("manifest.json").exists());
        assert!(!root.join(".importing").exists());
    }

    #[test]
    fn body_root_covers_styles_and_the_asset_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("doc.hcd");
        let writer = BundleWriter::create(&root).unwrap();
        writer.write_styles("article { color: #000; }").unwrap();
        writer.finish(test_manifest()).unwrap();
        let bundle = Bundle::open(&root).unwrap();
        assert!(crate::validate_bundle(&bundle).unwrap().valid);

        fs::write(root.join("styles.css"), b"article { color: #111; }").unwrap();
        let report = crate::validate_bundle(&bundle).unwrap();
        assert!(!report.valid);
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.code == "ROOT_HASH_MISMATCH"));

        writer_for_root_test(temp.path().join("assets.hcd"), b"[ ]");
    }

    fn writer_for_root_test(root: PathBuf, asset_index: &[u8]) {
        let writer = BundleWriter::create(&root).unwrap();
        writer.write_styles("article { color: #000; }").unwrap();
        fs::write(root.join("assets/index.json"), asset_index).unwrap();
        writer.finish(test_manifest()).unwrap();
        let bundle = Bundle::open(&root).unwrap();
        assert!(crate::validate_bundle(&bundle).unwrap().valid);
        fs::write(root.join("assets/index.json"), b"[]").unwrap();
        let report = crate::validate_bundle(&bundle).unwrap();
        assert!(!report.valid);
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.code == "ROOT_HASH_MISMATCH"));
    }

    fn test_manifest() -> HcdManifest {
        HcdManifest {
            schema_version: String::new(),
            storage_codec: crate::StorageCodec::None,
            document_id: "doc-1".to_string(),
            profile: "semantic-flow".to_string(),
            revision: 99,
            source: SourceDescriptor {
                format: "docx".to_string(),
                sha256: "00".repeat(32),
                size_bytes: 1,
            },
            root_hash: String::new(),
            annotation_root_hash: String::new(),
            annotation_href: None,
            index_prefix: String::new(),
            index_root_href: None,
            index_page_count: 0,
            chunk_count: 0,
            styles_href: String::new(),
            capabilities: HcdCapabilities::default(),
            fidelity: None,
            state: String::new(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn bounded_reader_rejects_a_control_object_before_full_buffering() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("oversized.json");
        fs::write(&path, vec![b'x'; 33]).unwrap();
        let error =
            read_json_bounded::<serde_json::Value>(&path, 32, "test control object").unwrap_err();
        assert!(matches!(error, HcdError::ResourceLimit(_)));
        assert!(error.to_string().contains("maximum is 32"));
    }

    #[test]
    fn gzip_reader_rejects_truncation_trailing_data_and_expansion() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("object.json.gz");
        atomic_write_encoded(&path, b"{\"value\":1}").unwrap();
        assert_eq!(
            read_bytes_bounded(&path, 128, "test").unwrap(),
            b"{\"value\":1}"
        );

        let valid = fs::read(&path).unwrap();
        fs::write(&path, &valid[..valid.len() - 4]).unwrap();
        assert!(read_bytes_bounded(&path, 128, "test").is_err());

        let mut trailing = valid.clone();
        trailing.extend_from_slice(b"not gzip");
        fs::write(&path, trailing).unwrap();
        assert!(read_bytes_bounded(&path, 128, "test").is_err());

        atomic_write_encoded(&path, &vec![b'x'; 4096]).unwrap();
        assert!(matches!(
            read_bytes_bounded(&path, 1024, "test"),
            Err(HcdError::ResourceLimit(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn bundle_hrefs_cannot_escape_through_symbolic_links() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("bundle");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("assets")).unwrap();

        let bundle = Bundle::open(&root).unwrap();
        let error = bundle.resolve_href("assets/index.json").unwrap_err();
        assert!(error.to_string().contains("symbolic link"));
    }

    #[test]
    fn local_bundle_mutations_are_serialized() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("bundle");
        fs::create_dir_all(&root).unwrap();
        let bundle = Bundle::open(&root).unwrap();

        let first = bundle.acquire_write_lock().unwrap();
        assert!(matches!(
            bundle.acquire_write_lock(),
            Err(HcdError::RevisionConflict(_))
        ));
        drop(first);
        assert!(bundle.acquire_write_lock().is_ok());
    }

    #[test]
    fn revision_reads_enforce_the_chain_limit_before_touching_disk() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = Bundle::open(temp.path()).unwrap();
        let error = bundle.revision(crate::MAX_REVISION + 1).unwrap_err();
        assert!(matches!(error, HcdError::ResourceLimit(_)));
    }

    fn written_page(number: usize, chunks: Vec<ChunkDescriptor>) -> ChunkIndexPage {
        ChunkIndexPage {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            revision: 1,
            page: number,
            chunks,
        }
    }

    #[test]
    fn append_index_page_opens_the_page_after_a_full_one() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("wide.hcd");
        let mut writer = BundleWriter::create(&root).unwrap();
        writer.write_styles("").unwrap();
        for index in 0..crate::INDEX_PAGE_SIZE {
            let node_id = format!("n_{index:032x}");
            let chunk_id = format!("c_{index:032x}");
            let text = format!("value-{index}");
            let node_hash = hash_bytes(text.as_bytes());
            writer
                .write_chunk(
                    chunk_id.clone(),
                    "body".to_string(),
                    format!(
                        "<p><span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\">{text}</span></p>"
                    ),
                    ChunkSourceMap {
                        schema_version: HCD_SCHEMA_VERSION.to_string(),
                        chunk_id,
                        entries: vec![crate::NodeMapEntry {
                            node_id,
                            node_hash,
                            source: crate::SourceAnchor {
                                source_cell_ref: None,
                                created_in_hcd: false,
                                part: "text/document".to_string(),
                                text_ordinal: index as u64 + 1,
                                paragraph_id: None,
                                text_id: None,
                                node_kind: "line".to_string(),
                                editable: true,
                            },
                        }],
                    },
                    1,
                    false,
                )
                .unwrap();
        }
        let manifest = writer.finish(test_manifest()).unwrap();
        assert_eq!(manifest.chunk_count, crate::INDEX_PAGE_SIZE);
        assert_eq!(manifest.index_page_count, 1);
        let bundle = Bundle::open(&root).unwrap();
        let tree = manifest.index_root_href.clone().unwrap();

        let html = "<p>appended</p>";
        let chunk_id = format!("c_{:032x}", crate::INDEX_PAGE_SIZE);
        let (html_href, html_hash) = bundle.write_chunk_object(html).unwrap();
        let (map_href, map_hash) = bundle
            .write_json_object(
                "maps",
                &ChunkSourceMap {
                    schema_version: HCD_SCHEMA_VERSION.to_string(),
                    chunk_id: chunk_id.clone(),
                    entries: Vec::new(),
                },
            )
            .unwrap();
        let descriptor = ChunkDescriptor {
            sequence: crate::INDEX_PAGE_SIZE,
            chunk_id,
            region: "body".to_string(),
            html_href,
            html_hash,
            map_href,
            map_hash,
            byte_length: html.len() as u64,
            block_count: 1,
            node_count: 0,
            text_chars: html.chars().count(),
            node_bloom: node_bloom(std::iter::empty::<&str>()),
            first_node_id: None,
            last_node_id: None,
            continuation: false,
            grid: None,
        };
        let page = written_page(1, vec![descriptor.clone()]);
        let grown = bundle.append_index_page(&tree, 1, &page).unwrap();

        let mut view = manifest.clone();
        view.revision = 1;
        view.chunk_count = crate::INDEX_PAGE_SIZE + 1;
        view.index_page_count = 2;
        view.index_root_href = Some(grown.clone());
        assert_eq!(
            bundle.read_index_page(&view, 0).unwrap().chunks.len(),
            crate::INDEX_PAGE_SIZE
        );
        let appended = bundle.read_index_page(&view, 1).unwrap();
        assert_eq!(appended.page, 1);
        assert_eq!(appended.chunks[0].chunk_id, descriptor.chunk_id);
        assert_eq!(appended.chunks[0].sequence, descriptor.sequence);
        assert_eq!(appended.chunks[0].html_href, descriptor.html_href);

        // Both pages sit under one new root, and the root the previous revision
        // used still resolves only its own page.
        let objects = bundle.index_tree_objects(&grown).unwrap();
        assert_eq!(objects.len(), 3);
        assert!(objects.contains(&grown));
        assert_eq!(
            bundle.index_page_href(&grown, 0).unwrap(),
            bundle.index_page_href(&tree, 0).unwrap()
        );
        assert!(bundle.index_page_href(&tree, 1).is_err());

        // An append cannot rewrite a page the tree already reaches, and it
        // cannot leave a hole behind.
        assert!(bundle
            .append_index_page(&grown, 0, &written_page(0, Vec::new()))
            .unwrap_err()
            .to_string()
            .contains("already has page 0"));
        assert!(bundle
            .append_index_page(&grown, 40, &written_page(40, Vec::new()))
            .unwrap_err()
            .to_string()
            .contains("ends before page 40"));
    }

    #[test]
    fn replace_index_pages_renumbers_the_pages_after_a_hole() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("wide.hcd");
        let mut writer = BundleWriter::create(&root).unwrap();
        writer.write_styles("").unwrap();
        for index in 0..crate::INDEX_PAGE_SIZE + 2 {
            let chunk_id = format!("c_{index:032x}");
            writer
                .write_chunk(
                    chunk_id.clone(),
                    "body".to_string(),
                    format!("<p>value-{index}</p>"),
                    ChunkSourceMap {
                        schema_version: HCD_SCHEMA_VERSION.to_string(),
                        chunk_id,
                        entries: Vec::new(),
                    },
                    1,
                    false,
                )
                .unwrap();
        }
        let manifest = writer.finish(test_manifest()).unwrap();
        assert_eq!(manifest.index_page_count, 2);
        let bundle = Bundle::open(&root).unwrap();
        let tree = manifest.index_root_href.clone().unwrap();
        let first = bundle.read_index_page(&manifest, 0).unwrap();
        let tail = bundle.read_index_page(&manifest, 1).unwrap();

        // Dropping the head of the tail page renumbers nothing in front of it,
        // so page 0 keeps the object the previous revision wrote.
        let mut kept = first.chunks.clone();
        kept.extend(tail.chunks[1..].iter().cloned());
        for (sequence, descriptor) in kept.iter_mut().enumerate() {
            descriptor.sequence = sequence;
        }
        let mut pages = vec![
            written_page(0, kept[..crate::INDEX_PAGE_SIZE].to_vec()),
            written_page(1, kept[crate::INDEX_PAGE_SIZE..].to_vec()),
        ];
        for page in &mut pages {
            page.revision = 2;
        }
        let rewritten = bundle.replace_index_pages(&tree, &pages).unwrap();
        assert_eq!(
            bundle.index_page_href(&rewritten, 0).unwrap(),
            bundle.index_page_href(&tree, 0).unwrap(),
            "a page in front of the hole was rewritten"
        );
        let mut view = manifest.clone();
        view.revision = 2;
        view.chunk_count = crate::INDEX_PAGE_SIZE + 1;
        view.index_root_href = Some(rewritten.clone());
        let moved = bundle.read_index_page(&view, 1).unwrap();
        assert_eq!(moved.chunks.len(), 1);
        assert_eq!(moved.chunks[0].sequence, crate::INDEX_PAGE_SIZE);
        assert_eq!(moved.chunks[0].chunk_id, tail.chunks[1].chunk_id);

        // Removing the head of the first page instead shifts a chunk across the
        // boundary, so both pages change and the tail page empties without
        // leaving the tree.
        let mut shifted = first.chunks[1..].to_vec();
        shifted.extend(tail.chunks.iter().cloned());
        for (sequence, descriptor) in shifted.iter_mut().enumerate() {
            descriptor.sequence = sequence;
        }
        let mut pages = vec![
            written_page(0, shifted[..crate::INDEX_PAGE_SIZE].to_vec()),
            written_page(1, shifted[crate::INDEX_PAGE_SIZE..].to_vec()),
        ];
        for page in &mut pages {
            page.revision = 3;
        }
        let shifted_root = bundle.replace_index_pages(&rewritten, &pages).unwrap();
        assert_ne!(
            bundle.index_page_href(&shifted_root, 0).unwrap(),
            bundle.index_page_href(&rewritten, 0).unwrap()
        );
        view.revision = 3;
        view.chunk_count = crate::INDEX_PAGE_SIZE + 1;
        view.index_root_href = Some(shifted_root.clone());
        let after = bundle.read_index_page(&view, 0).unwrap();
        assert_eq!(after.chunks.len(), crate::INDEX_PAGE_SIZE);
        assert_eq!(after.chunks[0].chunk_id, first.chunks[1].chunk_id);
        assert_eq!(
            after.chunks[crate::INDEX_PAGE_SIZE - 1].chunk_id,
            tail.chunks[0].chunk_id,
            "the chunk that crossed the page boundary is not the tail's first one"
        );
        assert_eq!(after.chunks[crate::INDEX_PAGE_SIZE - 1].sequence, 127);
        let after_tail = bundle.read_index_page(&view, 1).unwrap();
        assert_eq!(after_tail.chunks.len(), 1);
        assert_eq!(after_tail.chunks[0].chunk_id, tail.chunks[1].chunk_id);

        // Removing the last two chunks leaves nothing for the tail page. The
        // page stays in the tree, because the index cannot shrink yet.
        let mut last = after.chunks[..crate::INDEX_PAGE_SIZE - 1].to_vec();
        for (sequence, descriptor) in last.iter_mut().enumerate() {
            descriptor.sequence = sequence;
        }
        let mut pages = vec![written_page(0, last), written_page(1, Vec::new())];
        for page in &mut pages {
            page.revision = 4;
        }
        let empty_root = bundle.replace_index_pages(&shifted_root, &pages).unwrap();
        view.revision = 4;
        view.chunk_count = crate::INDEX_PAGE_SIZE - 1;
        view.index_root_href = Some(empty_root);
        let last = bundle.read_index_page(&view, 0).unwrap();
        assert_eq!(last.chunks.len(), crate::INDEX_PAGE_SIZE - 1);
        assert_eq!(last.chunks[0].sequence, 0);
        assert_eq!(last.chunks[last.chunks.len() - 1].sequence, 126);
        assert!(bundle.read_index_page(&view, 1).unwrap().chunks.is_empty());

        // The pages the earlier revisions described stay reachable under their
        // own roots, and a rewrite cannot invent a page the tree does not reach.
        assert_eq!(tail.chunks.len(), 2);
        assert_eq!(
            bundle.read_index_page(&manifest, 1).unwrap().chunks.len(),
            2
        );
        assert!(bundle
            .replace_index_pages(&shifted_root, &[written_page(9, Vec::new())])
            .unwrap_err()
            .to_string()
            .contains("no page 9"));
    }

    #[test]
    fn append_index_page_starts_a_new_leaf_under_a_taller_tree() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("deep.hcd");
        let writer = BundleWriter::create(&root).unwrap();
        writer.write_styles("").unwrap();
        let manifest = writer.finish(test_manifest()).unwrap();
        let bundle = Bundle::open(&root).unwrap();
        let page_href = |number: usize| {
            write_index_object(
                &root,
                manifest.storage_codec,
                "pages",
                &written_page(number, Vec::new()),
            )
            .unwrap()
        };
        let leaf = write_index_object(
            &root,
            manifest.storage_codec,
            "nodes",
            &IndexTreeNode {
                first_page: 0,
                child_span: 1,
                children: vec![page_href(0), page_href(1)],
            },
        )
        .unwrap();
        let tree = write_index_object(
            &root,
            manifest.storage_codec,
            "nodes",
            &IndexTreeNode {
                first_page: 0,
                child_span: 2,
                children: vec![leaf],
            },
        )
        .unwrap();

        // Page 2 is past the pages this root reaches, so the append opens a
        // second leaf instead of pretending the page belongs to the first.
        let expected = page_href(2);
        let grown = bundle
            .append_index_page(&tree, 2, &written_page(2, Vec::new()))
            .unwrap();
        assert_eq!(bundle.index_page_href(&grown, 0).unwrap(), page_href(0));
        assert_eq!(bundle.index_page_href(&grown, 2).unwrap(), expected);
        let second = bundle
            .append_index_page(&grown, 3, &written_page(3, Vec::new()))
            .unwrap();
        assert_eq!(bundle.index_page_href(&second, 3).unwrap(), page_href(3));
        assert_eq!(bundle.index_page_href(&second, 2).unwrap(), expected);
        assert!(matches!(
            bundle.append_index_page(&second, 5, &written_page(5, Vec::new())),
            Err(HcdError::InvalidBundle(_))
        ));
    }
}
