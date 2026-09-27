//! Portable `.hcd` snapshots. The editable representation remains a directory;
//! this ZIP container stores each referenced HCD/2 object without changing its bytes.

use crate::bundle::safe_relative_path;
use crate::stats::referenced_hrefs;
use crate::{validate_bundle, Bundle, HcdError, HcdManifest, MAX_CONTROL_PART_BYTES};
use serde::Serialize;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::{CompressionMethod, ZipArchive};

const MAX_ARCHIVE_ENTRIES: usize = 200_000;
const MAX_ARCHIVE_ENTRY_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ARCHIVE_DECODED_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveReport {
    pub document_id: String,
    pub revision: u64,
    pub entry_count: usize,
    pub payload_bytes: u64,
    pub archive_bytes: u64,
}

pub fn pack_archive(bundle: &Bundle, output: impl AsRef<Path>) -> Result<ArchiveReport, HcdError> {
    let output = output.as_ref();
    if occupied(output)? {
        return Err(HcdError::InvalidBundle(format!(
            "archive output already exists: {}",
            output.display()
        )));
    }
    // A patch cannot advance the manifest while the snapshot is enumerated.
    let _lock = bundle.acquire_write_lock()?;
    let validation = validate_bundle(bundle)?;
    if !validation.valid {
        return Err(HcdError::InvalidBundle(format!(
            "cannot pack an invalid bundle: {}",
            validation
                .issues
                .first()
                .map(|issue| issue.message.as_str())
                .unwrap_or("validation failed")
        )));
    }
    let manifest = bundle.manifest()?;
    let mut hrefs = referenced_hrefs(bundle)?.into_iter().collect::<Vec<_>>();
    hrefs.sort_unstable();
    if hrefs.len() > MAX_ARCHIVE_ENTRIES {
        return Err(HcdError::ResourceLimit(format!(
            "HCD archive has more than {MAX_ARCHIVE_ENTRIES} objects"
        )));
    }
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let temporary = tempfile::Builder::new()
        .prefix(".officecli-hcd-pack-")
        .tempfile_in(parent)?;
    let mut writer = ZipWriter::new(temporary.reopen()?);
    let mut payload_bytes = 0u64;
    for href in &hrefs {
        let path = bundle.resolve_href(href)?;
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(HcdError::InvalidBundle(format!(
                "HCD object is not a regular file: {href}"
            )));
        }
        check_size(metadata.len(), &mut payload_bytes)?;
        let compression = if href.ends_with(".gz") || href.starts_with("assets/sha256/") {
            CompressionMethod::Stored
        } else {
            CompressionMethod::Deflated
        };
        writer
            .start_file(
                href,
                SimpleFileOptions::default().compression_method(compression),
            )
            .map_err(zip_error)?;
        let copied = io::copy(&mut File::open(path)?, &mut writer)?;
        if copied != metadata.len() {
            return Err(HcdError::InvalidBundle(format!(
                "HCD object changed while packing: {href}"
            )));
        }
    }
    writer.finish().map_err(zip_error)?.sync_all()?;
    temporary
        .persist_noclobber(output)
        .map_err(|error| HcdError::Io(error.error))?;
    Ok(ArchiveReport {
        document_id: manifest.document_id,
        revision: manifest.revision,
        entry_count: hrefs.len(),
        payload_bytes,
        archive_bytes: fs::metadata(output)?.len(),
    })
}

/// Read only the bounded root manifest; `unpack_archive` performs full validation.
pub fn inspect_archive(input: impl AsRef<Path>) -> Result<HcdManifest, HcdError> {
    let mut archive = open_zip(input.as_ref())?;
    let mut manifest = archive.by_name("manifest.json").map_err(zip_error)?;
    if manifest.size() > MAX_CONTROL_PART_BYTES {
        return Err(HcdError::ResourceLimit(
            "archive manifest exceeds the HCD control-part limit".to_string(),
        ));
    }
    let mut bytes = Vec::new();
    manifest
        .by_ref()
        .take(MAX_CONTROL_PART_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CONTROL_PART_BYTES {
        return Err(HcdError::ResourceLimit(
            "archive manifest exceeds the HCD control-part limit".to_string(),
        ));
    }
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn unpack_archive(
    input: impl AsRef<Path>,
    destination: impl AsRef<Path>,
) -> Result<ArchiveReport, HcdError> {
    let input = input.as_ref();
    let destination = destination.as_ref();
    if occupied(destination)? {
        return Err(HcdError::InvalidBundle(format!(
            "bundle output already exists: {}",
            destination.display()
        )));
    }
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let temporary = tempfile::Builder::new()
        .prefix(".officecli-hcd-unpack-")
        .tempdir_in(parent)?;
    let mut archive = open_zip(input)?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(HcdError::ResourceLimit(format!(
            "archive has more than {MAX_ARCHIVE_ENTRIES} entries"
        )));
    }
    let mut names = HashSet::with_capacity(archive.len());
    let mut filesystem_names = HashSet::with_capacity(archive.len());
    let mut payload_bytes = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(zip_error)?;
        let name = entry.name().to_string();
        let relative = archive_path(&name)?;
        if entry.is_dir() || entry.is_symlink() {
            return Err(HcdError::InvalidBundle(format!(
                "archive entry is not a regular file: {name}"
            )));
        }
        if !matches!(
            entry.compression(),
            CompressionMethod::Stored | CompressionMethod::Deflated
        ) {
            return Err(HcdError::Unsupported(format!(
                "unsupported archive compression for {name}"
            )));
        }
        if !names.insert(name.clone()) {
            return Err(HcdError::InvalidBundle(format!(
                "duplicate archive entry: {name}"
            )));
        }
        if !filesystem_names.insert(name.to_ascii_lowercase()) {
            return Err(HcdError::InvalidBundle(format!(
                "archive entries collide on a case-insensitive filesystem: {name}"
            )));
        }
        check_size(entry.size(), &mut payload_bytes)?;
        if entry.size() > 1024 * 1024 && entry.size() / entry.compressed_size().max(1) > 200 {
            return Err(HcdError::ResourceLimit(format!(
                "archive entry compression ratio is excessive: {name}"
            )));
        }
        let target = temporary.path().join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = File::create(target)?;
        let copied = io::copy(
            &mut entry.by_ref().take(MAX_ARCHIVE_ENTRY_BYTES + 1),
            &mut output,
        )?;
        if copied != entry.size() {
            return Err(HcdError::InvalidBundle(format!(
                "archive entry length does not match its header: {name}"
            )));
        }
        output.sync_all()?;
    }
    let bundle = Bundle::open(temporary.path())?;
    let validation = validate_bundle(&bundle)?;
    if !validation.valid {
        return Err(HcdError::InvalidBundle(format!(
            "archive contains an invalid HCD bundle: {}",
            validation
                .issues
                .first()
                .map(|issue| issue.message.as_str())
                .unwrap_or("validation failed")
        )));
    }
    if names != referenced_hrefs(&bundle)? {
        return Err(HcdError::InvalidBundle(
            "archive entries do not match objects referenced by HCD revisions".to_string(),
        ));
    }
    let manifest = bundle.manifest()?;
    if occupied(destination)? {
        return Err(HcdError::InvalidBundle(format!(
            "bundle output appeared while unpacking: {}",
            destination.display()
        )));
    }
    fs::rename(temporary.path(), destination)?;
    Ok(ArchiveReport {
        document_id: manifest.document_id,
        revision: manifest.revision,
        entry_count: names.len(),
        payload_bytes,
        archive_bytes: fs::metadata(input)?.len(),
    })
}

fn open_zip(path: &Path) -> Result<ZipArchive<File>, HcdError> {
    if !path.is_file() {
        return Err(HcdError::InvalidBundle(format!(
            "HCD archive file does not exist: {}",
            path.display()
        )));
    }
    ZipArchive::new(File::open(path)?).map_err(zip_error)
}

fn archive_path(name: &str) -> Result<PathBuf, HcdError> {
    if name.contains('\\')
        || name.contains(':')
        || name.contains('\0')
        || name == ".hcd-write-lock"
        || name
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(HcdError::InvalidBundle(format!(
            "unsafe archive entry path: {name}"
        )));
    }
    safe_relative_path(name)
}

fn check_size(size: u64, total: &mut u64) -> Result<(), HcdError> {
    if size > MAX_ARCHIVE_ENTRY_BYTES {
        return Err(HcdError::ResourceLimit(format!(
            "HCD archive entry exceeds {MAX_ARCHIVE_ENTRY_BYTES} bytes"
        )));
    }
    *total = total
        .checked_add(size)
        .ok_or_else(|| HcdError::ResourceLimit("HCD archive decoded size overflow".to_string()))?;
    if *total > MAX_ARCHIVE_DECODED_BYTES {
        return Err(HcdError::ResourceLimit(format!(
            "HCD archive exceeds {MAX_ARCHIVE_DECODED_BYTES} decoded bytes"
        )));
    }
    Ok(())
}

fn occupied(path: &Path) -> Result<bool, HcdError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(HcdError::Io(error)),
    }
}

fn zip_error(error: zip::result::ZipError) -> HcdError {
    HcdError::InvalidBundle(format!("invalid HCD archive: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_zip(path: &Path, names: &[&str], data: &[u8]) {
        let mut writer = ZipWriter::new(File::create(path).unwrap());
        for name in names {
            writer
                .start_file(
                    *name,
                    SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
                )
                .unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn rejects_unsafe_archive_entries_without_creating_destination() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("bad.hcd");
        let destination = temp.path().join("opened.hcd");
        make_zip(&archive, &["../outside"], b"bad");
        assert!(unpack_archive(&archive, &destination).is_err());
        assert!(!destination.exists());

        make_zip(&archive, &["folder\\escape"], b"bad");
        assert!(unpack_archive(&archive, &destination).is_err());
        assert!(!destination.exists());

        make_zip(&archive, &["a//b"], b"bad");
        assert!(unpack_archive(&archive, &destination).is_err());
        assert!(!destination.exists());

        make_zip(&archive, &["MANIFEST.json", "manifest.json"], b"{}");
        assert!(unpack_archive(&archive, &destination).is_err());
        assert!(!destination.exists());
    }

    #[test]
    fn rejects_excessive_decompression_before_publishing_destination() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("bomb.hcd");
        let destination = temp.path().join("opened.hcd");
        make_zip(&archive, &["manifest.json"], &vec![b'X'; 2 * 1024 * 1024]);
        assert!(matches!(
            unpack_archive(&archive, &destination),
            Err(HcdError::ResourceLimit(_))
        ));
        assert!(!destination.exists());
    }
}
