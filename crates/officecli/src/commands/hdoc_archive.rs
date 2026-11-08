//! A versioned, bounded ZIP transport for canonical HCD directories.
//! No collaboration state, receipts, ACL configuration or staging pins travel.
use handler_common::HandlerError;
use hcd_core::{
    Bundle, HcdError, MAX_CONTROL_PART_BYTES, MAX_PORTABLE_BYTES, MAX_PORTABLE_FILES,
    MAX_PORTABLE_FILE_BYTES,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};
const HEADER: &str = "hcd-archive.json";
const PREFIX: &str = "bundle/";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    href: String,
    byte_length: u64,
    sha256: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchiveManifest {
    schema_version: String,
    document_id: String,
    revision: u64,
    entries: Vec<Entry>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveReport {
    pub document_id: String,
    pub revision: u64,
    pub files: usize,
    pub decoded_bytes: u64,
}
fn invalid(message: impl Into<String>) -> HandlerError {
    HandlerError::InvalidArgument(message.into())
}
fn zipped(error: zip::result::ZipError) -> HandlerError {
    invalid(format!("invalid offline archive: {error}"))
}
fn core(error: HcdError) -> HandlerError {
    invalid(error.to_string())
}
fn parent(path: &Path) -> &Path {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}
fn safe_href(href: &str) -> bool {
    !href.is_empty()
        && href.len() <= 512
        && href.split('/').all(|part| {
            !part.is_empty()
                && !part.starts_with('.')
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
}
fn checked_manifest(raw: &[u8]) -> Result<ArchiveManifest, HandlerError> {
    let manifest: ArchiveManifest = serde_json::from_slice(raw)?;
    if manifest.schema_version != "hcd-archive/1"
        || manifest.entries.is_empty()
        || manifest.entries.len() > MAX_PORTABLE_FILES
        || manifest.revision > hcd_core::MAX_REVISION
    {
        return Err(invalid("unsupported or oversized offline archive manifest"));
    }
    let mut seen = BTreeSet::new();
    let mut bytes = 0u64;
    for entry in &manifest.entries {
        if !safe_href(&entry.href)
            || !seen.insert(&entry.href)
            || entry.byte_length > MAX_PORTABLE_FILE_BYTES
            || entry.sha256.len() != 64
            || !entry
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid("invalid or duplicate offline archive object"));
        }
        bytes = bytes
            .checked_add(entry.byte_length)
            .ok_or_else(|| invalid("offline archive size overflow"))?;
        if bytes > MAX_PORTABLE_BYTES {
            return Err(invalid("offline archive exceeds decoded byte limit"));
        }
    }
    Ok(manifest)
}

pub(crate) fn pack(
    bundle: &Bundle,
    output: &Path,
    revision: Option<u64>,
) -> Result<ArchiveReport, HandlerError> {
    if output.try_exists()? {
        return Err(invalid("offline archive output already exists"));
    }
    let snapshot = hcd_core::create_portable_snapshot(bundle, revision).map_err(core)?;
    let entries: Vec<_> = snapshot
        .hrefs
        .iter()
        .map(|href| {
            let path = snapshot.directory.path().join(href);
            Ok(Entry {
                href: href.clone(),
                byte_length: fs::metadata(&path)?.len(),
                sha256: hcd_core::hash_file(&path).map_err(core)?,
            })
        })
        .collect::<Result<_, HandlerError>>()?;
    let manifest = ArchiveManifest {
        schema_version: "hcd-archive/1".into(),
        document_id: snapshot.manifest.document_id,
        revision: snapshot.manifest.revision,
        entries,
    };
    let raw = serde_json::to_vec(&manifest)?;
    if raw.len() as u64 > MAX_CONTROL_PART_BYTES {
        return Err(invalid("offline manifest byte limit"));
    }
    checked_manifest(&raw)?;
    let mut staged = tempfile::NamedTempFile::new_in(parent(output))?;
    {
        let mut writer = ZipWriter::new(staged.as_file_mut());
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o600);
        writer.start_file(HEADER, options).map_err(zipped)?;
        writer.write_all(&raw)?;
        for entry in &manifest.entries {
            writer
                .start_file(format!("{PREFIX}{}", entry.href), options)
                .map_err(zipped)?;
            let input = fs::File::open(snapshot.directory.path().join(&entry.href))?;
            let written = std::io::copy(&mut input.take(entry.byte_length + 1), &mut writer)?;
            if written != entry.byte_length {
                return Err(invalid("offline snapshot changed during packing"));
            }
        }
        writer.finish().map_err(zipped)?;
    }
    staged.as_file_mut().sync_all()?;
    staged
        .persist_noclobber(output)
        .map_err(|e| HandlerError::IoError(e.error))?;
    Ok(report(&manifest))
}
fn report(manifest: &ArchiveManifest) -> ArchiveReport {
    ArchiveReport {
        document_id: manifest.document_id.clone(),
        revision: manifest.revision,
        files: manifest.entries.len(),
        decoded_bytes: manifest.entries.iter().map(|e| e.byte_length).sum(),
    }
}

pub(crate) fn unpack(archive: &Path, output: &Path) -> Result<ArchiveReport, HandlerError> {
    if output.symlink_metadata().is_ok() {
        return Err(invalid("offline directory output already exists"));
    }
    let mut input = fs::File::open(archive)?;
    if input.metadata()?.len() > MAX_PORTABLE_BYTES + MAX_CONTROL_PART_BYTES {
        return Err(invalid("offline archive byte limit"));
    }
    let central_count = preflight_directory(&mut input)?;
    input.rewind()?;
    let mut zip = ZipArchive::new(input).map_err(zipped)?;
    if zip.len() != central_count {
        return Err(invalid("offline archive has duplicate central records"));
    }
    if zip.len() > MAX_PORTABLE_FILES + 1 {
        return Err(invalid("offline archive file count limit"));
    }
    // Inspect every central directory record, including duplicate names and special files.
    let mut names = BTreeSet::new();
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(zipped)?;
        let name = std::str::from_utf8(entry.name_raw())
            .map_err(|_| invalid("offline archive path is not UTF-8"))?;
        if !names.insert(name.to_owned())
            || entry.is_dir()
            || entry
                .unix_mode()
                .is_some_and(|mode| ![0, 0o100000].contains(&(mode & 0o170000)))
            || (name != HEADER && !name.strip_prefix(PREFIX).is_some_and(safe_href))
        {
            return Err(invalid(
                "offline archive contains duplicate, unsafe or special entries",
            ));
        }
        if entry.size() > MAX_PORTABLE_FILE_BYTES {
            return Err(invalid("offline archive object byte limit"));
        }
    }
    let mut raw = Vec::new();
    zip.by_name(HEADER)
        .map_err(zipped)?
        .take(MAX_CONTROL_PART_BYTES + 1)
        .read_to_end(&mut raw)?;
    if raw.len() as u64 > MAX_CONTROL_PART_BYTES {
        return Err(invalid("offline manifest byte limit"));
    }
    let manifest = checked_manifest(&raw)?;
    let expected: BTreeSet<_> = std::iter::once(HEADER.to_owned())
        .chain(
            manifest
                .entries
                .iter()
                .map(|entry| format!("{PREFIX}{}", entry.href)),
        )
        .collect();
    if names != expected {
        return Err(invalid(
            "offline archive inventory does not match its files",
        ));
    }
    let staging = tempfile::tempdir_in(parent(output))?;
    let root = staging.path().join("document");
    fs::create_dir(&root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    }
    for entry in &manifest.entries {
        let mut input = zip
            .by_name(&format!("{PREFIX}{}", entry.href))
            .map_err(zipped)?;
        if input.size() != entry.byte_length {
            return Err(invalid("offline archive object length mismatch"));
        }
        let target = root.join(&entry.href);
        fs::create_dir_all(target.parent().expect("object parent"))?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&target)?;
        let copied = std::io::copy(&mut (&mut input).take(entry.byte_length + 1), &mut file)?;
        file.sync_all()?;
        if copied != entry.byte_length
            || hcd_core::hash_file(&target).map_err(core)? != entry.sha256
        {
            return Err(invalid("offline archive object integrity mismatch"));
        }
    }
    let bundle = Bundle::open(&root).map_err(core)?;
    let head = bundle.manifest().map_err(core)?;
    if head.document_id != manifest.document_id || head.revision != manifest.revision {
        return Err(invalid("offline archive document/revision mismatch"));
    }
    let hrefs: BTreeSet<_> = hcd_core::portable_bundle_hrefs(&bundle, head.revision)
        .map_err(core)?
        .into_iter()
        .collect();
    if hrefs != manifest.entries.iter().map(|e| e.href.clone()).collect() {
        return Err(invalid(
            "offline archive contains noncanonical or missing dependencies",
        ));
    }
    hcd_core::validate_portable_bundle(&bundle).map_err(core)?;
    publish_directory(&root, output)?;
    Ok(report(&manifest))
}

// Check the footer before ZipArchive allocates its central-record vector. The
// crate indexes records by name, so compare its count with the raw footer too.
fn preflight_directory(input: &mut fs::File) -> Result<usize, HandlerError> {
    fn u16at(raw: &[u8], at: usize) -> u16 {
        u16::from_le_bytes(raw[at..at + 2].try_into().unwrap())
    }
    fn u32at(raw: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(raw[at..at + 4].try_into().unwrap())
    }
    fn u64at(raw: &[u8], at: usize) -> u64 {
        u64::from_le_bytes(raw[at..at + 8].try_into().unwrap())
    }
    let length = input.metadata()?.len();
    let tail_length = length.min(65_557) as usize;
    input.seek(SeekFrom::End(-(tail_length as i64)))?;
    let mut tail = vec![0; tail_length];
    input.read_exact(&mut tail)?;
    let end = (0..tail.len().saturating_sub(21))
        .rev()
        .find(|&i| {
            tail[i..].starts_with(b"PK\x05\x06")
                && i + 22 + u16at(&tail, i + 20) as usize == tail.len()
        })
        .ok_or_else(|| invalid("offline ZIP footer missing"))?;
    if u16at(&tail, end + 4) != 0
        || u16at(&tail, end + 6) != 0
        || u16at(&tail, end + 8) != u16at(&tail, end + 10)
    {
        return Err(invalid("multi-disk offline archives are unsupported"));
    }
    let end_offset = length - tail_length as u64 + end as u64;
    let mut count = u16at(&tail, end + 10) as u64;
    let mut size = u32at(&tail, end + 12) as u64;
    let mut start = u32at(&tail, end + 16) as u64;
    let mut boundary = end_offset;
    let mut has_zip64 = false;
    if end_offset >= 20 {
        input.seek(SeekFrom::Start(end_offset - 20))?;
        let mut magic = [0; 4];
        input.read_exact(&mut magic)?;
        has_zip64 = &magic == b"PK\x06\x07";
    }
    if has_zip64 || count == u16::MAX as u64 || size == u32::MAX as u64 || start == u32::MAX as u64
    {
        if end_offset < 20 {
            return Err(invalid("offline ZIP64 locator missing"));
        }
        input.seek(SeekFrom::Start(end_offset - 20))?;
        let mut locator = [0; 20];
        input.read_exact(&mut locator)?;
        if &locator[..4] != b"PK\x06\x07" || u32at(&locator, 4) != 0 || u32at(&locator, 16) != 1 {
            return Err(invalid("invalid offline ZIP64 locator"));
        }
        boundary = u64at(&locator, 8);
        if boundary
            .checked_add(56)
            .is_none_or(|at| at > end_offset - 20)
        {
            return Err(invalid("invalid offline ZIP64 footer bounds"));
        }
        input.seek(SeekFrom::Start(boundary))?;
        let mut footer = [0; 56];
        input.read_exact(&mut footer)?;
        let body = u64at(&footer, 4);
        if &footer[..4] != b"PK\x06\x06"
            || !(44..=MAX_CONTROL_PART_BYTES).contains(&body)
            || boundary.checked_add(12).and_then(|v| v.checked_add(body)) != Some(end_offset - 20)
            || u32at(&footer, 16) != 0
            || u32at(&footer, 20) != 0
            || u64at(&footer, 24) != u64at(&footer, 32)
        {
            return Err(invalid("invalid offline ZIP64 footer"));
        }
        count = u64at(&footer, 32);
        size = u64at(&footer, 40);
        start = u64at(&footer, 48);
    }
    if count == 0
        || count > MAX_PORTABLE_FILES as u64 + 1
        || size > 64 * 1024 * 1024
        || start.checked_add(size) != Some(boundary)
    {
        return Err(invalid(
            "offline ZIP directory exceeds limits or has invalid bounds",
        ));
    }
    input.seek(SeekFrom::Start(start))?;
    let mut walked = 0u64;
    let mut names = BTreeSet::new();
    while walked < size {
        if size - walked < 46 {
            return Err(invalid("truncated offline ZIP directory"));
        }
        let mut header = [0; 46];
        input.read_exact(&mut header)?;
        if &header[..4] != b"PK\x01\x02" {
            return Err(invalid("invalid offline ZIP directory record"));
        }
        let length = u16at(&header, 28) as u64;
        let extra = u16at(&header, 30) as u64 + u16at(&header, 32) as u64;
        let record_bytes = 46 + length + extra;
        if length == 0
            || length > 520
            || record_bytes > size - walked
            || names.len() > MAX_PORTABLE_FILES
        {
            return Err(invalid("offline ZIP directory record limit"));
        }
        let mut raw_name = vec![0; length as usize];
        input.read_exact(&mut raw_name)?;
        let name =
            std::str::from_utf8(&raw_name).map_err(|_| invalid("offline ZIP path is not UTF-8"))?;
        if !names.insert(name.to_owned())
            || (name != HEADER && !name.strip_prefix(PREFIX).is_some_and(safe_href))
        {
            return Err(invalid("duplicate or unsafe offline ZIP directory record"));
        }
        input.seek(SeekFrom::Current(extra as i64))?;
        walked += record_bytes;
    }
    if names.len() as u64 != count {
        return Err(invalid("offline ZIP directory count mismatch"));
    }
    Ok(count as usize)
}

#[cfg(unix)]
fn publish_directory(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::ffi::OsStrExt;
    let source = std::ffi::CString::new(source.as_os_str().as_bytes())?;
    let target = std::ffi::CString::new(target.as_os_str().as_bytes())?;
    // SAFETY: both path buffers are live, NUL-terminated C strings. The syscall
    // performs a no-replace directory rename and never takes ownership of them.
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "atomic offline directory publication is unavailable on this platform",
    ));
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
#[cfg(not(unix))]
fn publish_directory(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    // Windows MoveFileEx used by rename fails when the destination exists.
    std::fs::rename(source, target)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(root: &Path) -> Bundle {
        let source = root.join("source.md");
        fs::write(&source, "# Original\n\nOffline 内容\n").unwrap();
        let path = root.join("source.hcd");
        hcd_formats::import_document(
            &source,
            &path,
            &hcd_formats::ImportOptions::new("portable-test"),
            |_| Ok(()),
        )
        .unwrap();
        Bundle::open(path).unwrap()
    }
    fn replace_archive(path: &Path, change: impl FnOnce(&mut Vec<(String, Vec<u8>)>)) {
        let mut zip = ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
        let mut files = Vec::new();
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).unwrap();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            files.push((entry.name().to_owned(), bytes));
        }
        drop(zip);
        change(&mut files);
        let mut zip = ZipWriter::new(fs::File::create(path).unwrap());
        for (name, bytes) in files {
            zip.start_file(name, SimpleFileOptions::default()).unwrap();
            zip.write_all(&bytes).unwrap()
        }
        zip.finish().unwrap();
    }
    #[test]
    fn offline_roundtrip_keeps_history_and_excludes_service_secrets_and_uncommitted_uploads() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = fixture(temp.path());
        hcd_core::project_editor(&bundle, 0).unwrap();
        let staged = bundle
            .stage_asset_from_reader("bin", &mut std::io::Cursor::new(b"pending only"))
            .unwrap();
        fs::write(bundle.root().join("private.json"), "secret-do-not-export").unwrap();
        fs::write(
            bundle.root().join("collaboration.bin"),
            "unsaved collaborator draft",
        )
        .unwrap();
        let before = fs::read(bundle.root().join("manifest.json")).unwrap();
        let archive = temp.path().join("saved.hcdz");
        let result = pack(&bundle, &archive, None).unwrap();
        assert_eq!(result.revision, 1);
        let output = temp.path().join("reopened.hcd");
        unpack(&archive, &output).unwrap();
        let restored = Bundle::open(&output).unwrap();
        assert!(hcd_core::validate_bundle(&restored).unwrap().valid);
        assert_eq!(
            serde_json::to_value(restored.revision(0).unwrap()).unwrap(),
            serde_json::to_value(bundle.revision(0).unwrap()).unwrap()
        );
        assert_eq!(fs::read(output.join("manifest.json")).unwrap(), before);
        assert!(!output.join("private.json").exists());
        assert!(!output.join("collaboration.bin").exists());
        assert!(!output.join("assets/staged").exists());
        assert!(!output.join(staged.href).exists());
        assert_eq!(
            fs::read(bundle.root().join("manifest.json")).unwrap(),
            before
        );
        let old = temp.path().join("r0.hcdz");
        pack(&bundle, &old, Some(0)).unwrap();
        let root = temp.path().join("r0.hcd");
        unpack(&old, &root).unwrap();
        assert_eq!(Bundle::open(&root).unwrap().manifest().unwrap().revision, 0);
        assert!(!root.join("revisions/00000000000000000001.json").exists());
        assert!(pack(&bundle, &archive, None).is_err());
        assert!(unpack(&archive, &output).is_err());
        assert_eq!(fs::read(output.join("manifest.json")).unwrap(), before);
    }
    #[test]
    fn corrupted_payload_and_extra_runtime_file_never_publish_a_directory() {
        for extra in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let bundle = fixture(temp.path());
            let archive = temp.path().join("broken.hcdz");
            pack(&bundle, &archive, None).unwrap();
            replace_archive(&archive, |files| {
                if extra {
                    files.push(("bundle/private.json".into(), b"secret".to_vec()))
                } else {
                    files
                        .iter_mut()
                        .find(|(name, _)| name == "bundle/styles.css")
                        .unwrap()
                        .1
                        .push(b'x')
                }
            });
            let output = temp.path().join("reopened.hcd");
            assert!(unpack(&archive, &output).is_err());
            assert!(!output.exists());
            assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 3);
        }
    }
    #[test]
    fn archive_paths_and_directory_publication_cannot_escape_or_replace_existing_data() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = fixture(temp.path());
        let archive = temp.path().join("unsafe.hcdz");
        pack(&bundle, &archive, None).unwrap();
        replace_archive(&archive, |files| {
            files.push(("../escaped".into(), b"no".to_vec()))
        });
        assert!(unpack(&archive, &temp.path().join("out")).is_err());
        assert!(!temp.path().join("escaped").exists());
        let source = temp.path().join("staging");
        let target = temp.path().join("existing");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(source.join("new"), b"new").unwrap();
        assert!(publish_directory(&source, &target).is_err());
        assert!(source.join("new").exists());
        assert_eq!(fs::read_dir(target).unwrap().count(), 0);
    }
    #[test]
    fn raw_footer_count_is_bounded_before_zip_allocation() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = fixture(temp.path());
        let archive = temp.path().join("count.hcdz");
        pack(&bundle, &archive, None).unwrap();
        let mut bytes = fs::read(&archive).unwrap();
        let end = bytes.len() - 22;
        let original = bytes.clone();
        let count = u16::from_le_bytes(bytes[end + 10..end + 12].try_into().unwrap());
        bytes[end + 8..end + 10].copy_from_slice(&(count - 1).to_le_bytes());
        bytes[end + 10..end + 12].copy_from_slice(&(count - 1).to_le_bytes());
        fs::write(&archive, &bytes).unwrap();
        assert!(unpack(&archive, &temp.path().join("underreported")).is_err());
        let mut bytes = original;
        bytes[end + 8..end + 12].copy_from_slice(&[0xff; 4]);
        fs::write(&archive, bytes).unwrap();
        assert!(unpack(&archive, &temp.path().join("out")).is_err());
        assert!(!temp.path().join("out").exists());
    }
    #[test]
    fn historical_only_chunk_corruption_is_not_hidden_by_a_valid_current_head() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = fixture(temp.path());
        let old = bundle.manifest().unwrap();
        let descriptor = bundle.read_index_page(&old, 0).unwrap().chunks.remove(0);
        let entry = hcd_core::extract_text_page(&bundle, None, 100)
            .unwrap()
            .entries
            .remove(0);
        hcd_core::apply_patch(
            &bundle,
            &hcd_core::PatchBatch {
                schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.into(),
                document_id: old.document_id.clone(),
                patch_id: "change-current".into(),
                base_revision: 0,
                actor: Default::default(),
                metadata: Default::default(),
                operations: vec![hcd_core::PatchOperation::TextSplice {
                    node_id: entry.node_id,
                    start: 0,
                    delete_count: 0,
                    insert_text: "New ".into(),
                    precondition: hcd_core::NodePrecondition {
                        node_hash: entry.node_hash,
                    },
                }],
            },
            0,
        )
        .unwrap();
        let current = bundle.manifest().unwrap();
        assert_ne!(
            descriptor.html_href,
            bundle.read_index_page(&current, 0).unwrap().chunks[0].html_href
        );
        fs::write(
            bundle.resolve_href(&descriptor.html_href).unwrap(),
            "corrupt old content",
        )
        .unwrap();
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
        let output = temp.path().join("broken-history.hcdz");
        assert!(pack(&bundle, &output, None).is_err());
        assert!(!output.exists());
    }
    #[test]
    fn duplicate_zip_records_and_symbolic_links_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = fixture(temp.path());
        let archive = temp.path().join("duplicate.hcdz");
        pack(&bundle, &archive, None).unwrap();
        replace_archive(&archive, |files| {
            files.push(("bundle/duplicateA".into(), b"a".to_vec()));
            files.push(("bundle/duplicateB".into(), b"b".to_vec()));
        });
        let mut raw = fs::read(&archive).unwrap();
        let needle = b"bundle/duplicateB";
        for i in 0..=raw.len() - needle.len() {
            if &raw[i..i + needle.len()] == needle {
                raw[i + needle.len() - 1] = b'A';
            }
        }
        fs::write(&archive, raw).unwrap();
        assert!(unpack(&archive, &temp.path().join("out"))
            .unwrap_err()
            .to_string()
            .contains("duplicate"));
        let link = temp.path().join("link.hcdz");
        let mut zip = ZipWriter::new(fs::File::create(&link).unwrap());
        zip.add_symlink("bundle/link", "../outside", SimpleFileOptions::default())
            .unwrap();
        zip.finish().unwrap();
        assert!(unpack(&link, &temp.path().join("out-link")).is_err());
        assert!(!temp.path().join("out-link").exists());
    }
    #[test]
    fn zip64_footer_is_bounded_even_when_the_zip32_count_is_not_saturated() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = fixture(temp.path());
        let archive = temp.path().join("zip64.hcdz");
        pack(&bundle, &archive, None).unwrap();
        let raw = fs::read(&archive).unwrap();
        let end = raw.len() - 22;
        let eocd = &raw[end..];
        let count = u16::from_le_bytes(eocd[10..12].try_into().unwrap()) as u64;
        let size = u32::from_le_bytes(eocd[12..16].try_into().unwrap()) as u64;
        let start = u32::from_le_bytes(eocd[16..20].try_into().unwrap()) as u64;
        for oversized in [false, true] {
            let mut raw = raw[..end].to_vec();
            raw.extend(b"PK\x06\x06");
            raw.extend(44u64.to_le_bytes());
            raw.extend(45u16.to_le_bytes());
            raw.extend(45u16.to_le_bytes());
            raw.extend([0; 8]);
            let count = if oversized {
                MAX_PORTABLE_FILES as u64 + 2
            } else {
                count
            };
            raw.extend(count.to_le_bytes());
            raw.extend(count.to_le_bytes());
            raw.extend(size.to_le_bytes());
            raw.extend(start.to_le_bytes());
            raw.extend(b"PK\x06\x07");
            raw.extend(0u32.to_le_bytes());
            raw.extend((end as u64).to_le_bytes());
            raw.extend(1u32.to_le_bytes());
            raw.extend(eocd);
            fs::write(&archive, raw).unwrap();
            let output = temp.path().join(if oversized { "reject" } else { "valid" });
            let result = unpack(&archive, &output);
            if oversized {
                assert!(result.is_err());
                assert!(!output.exists())
            } else {
                result.unwrap();
            }
        }
    }
    #[test]
    fn archive_includes_old_index_pages_after_the_current_document_becomes_smaller() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("large.md");
        fs::write(
            &source,
            (0..130)
                .map(|i| format!("Paragraph {i}\n\n"))
                .collect::<String>(),
        )
        .unwrap();
        let mut options = hcd_formats::ImportOptions::new("page-history");
        options.chunk_blocks = 1;
        let path = temp.path().join("large.hcd");
        hcd_formats::import_document(&source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(&path).unwrap();
        assert_eq!(bundle.manifest().unwrap().index_page_count, 2);
        hcd_core::project_editor(&bundle, 0).unwrap();
        let projection = hcd_core::editor_projection(&bundle, None).unwrap();
        assert!(projection.blocks.len() >= 130);
        let operations = projection
            .blocks
            .into_iter()
            .skip(1)
            .map(|b| hcd_core::StructureOperation::Delete {
                block_id: b.block_id,
                precondition: hcd_core::BlockPrecondition {
                    block_hash: b.block_hash,
                },
            })
            .collect();
        hcd_core::apply_structure_patch(
            &bundle,
            &hcd_core::StructurePatchBatch {
                schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_4.into(),
                document_id: "page-history".into(),
                patch_id: "shorten-document".into(),
                base_revision: 1,
                actor: Default::default(),
                operations,
            },
            1,
        )
        .unwrap();
        assert_eq!(bundle.manifest().unwrap().index_page_count, 1);
        let archive = temp.path().join("full-history.hcdz");
        pack(&bundle, &archive, None).unwrap();
        let out = temp.path().join("reopened.hcd");
        unpack(&archive, &out).unwrap();
        let reopened = Bundle::open(&out).unwrap();
        assert_eq!(
            serde_json::to_value(hcd_core::editor_projection(&reopened, Some(0)).unwrap()).unwrap(),
            serde_json::to_value(hcd_core::editor_projection(&bundle, Some(0)).unwrap()).unwrap()
        );
        assert_eq!(
            hcd_core::editor_projection(&reopened, None)
                .unwrap()
                .blocks
                .len(),
            1
        );
    }
}
