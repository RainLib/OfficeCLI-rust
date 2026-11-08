//! PDF -> PNG rasterization through one discovered Poppler executable.
//!
//! Oracle and candidate PDFs must pass through this exact object at runtime.
//! Committed browser artifacts are PDFs, not machine-specific PNG rasters.

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::config::DPI;
use super::util::sha256_hex;

#[derive(Debug)]
pub(crate) struct Rasterizer {
    source_executable: PathBuf,
    snapshot: ExecutableSnapshot,
    version: String,
    sha256: String,
}

/// Private, immutable copy of the exact executable bytes authenticated at
/// discovery. Every child uses this path, so replacing the PATH/configured file
/// halfway through a run cannot change the rasterizer behind the recorded hash.
#[derive(Debug)]
struct ExecutableSnapshot {
    directory: PathBuf,
    executable: PathBuf,
    directory_permissions: std::fs::Permissions,
    executable_permissions: std::fs::Permissions,
}

impl ExecutableSnapshot {
    fn create_directory() -> Result<PathBuf, String> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        for attempt in 0..1024 {
            let directory = std::env::temp_dir().join(format!(
                "ironpress-pdftoppm-{}-{nonce}-{attempt}",
                std::process::id()
            ));
            match std::fs::create_dir(&directory) {
                Ok(()) => return Ok(directory),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!(
                        "cannot create pdftoppm snapshot directory {}: {error}",
                        directory.display()
                    ));
                }
            }
        }
        Err("cannot allocate a unique pdftoppm snapshot directory".to_string())
    }

    fn create(source: &Path, bytes: &[u8]) -> Result<Self, String> {
        let file_name = source
            .file_name()
            .ok_or_else(|| format!("rasterizer path has no file name: {}", source.display()))?;
        let executable_permissions = std::fs::metadata(source)
            .map_err(|error| format!("cannot inspect {}: {error}", source.display()))?
            .permissions();
        let directory = Self::create_directory()?;
        let executable = directory.join(file_name);
        let directory_permissions = std::fs::metadata(&directory)
            .map_err(|error| error.to_string())?
            .permissions();
        let snapshot = Self {
            directory,
            executable,
            directory_permissions,
            executable_permissions,
        };
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&snapshot.executable)
            .map_err(|error| {
                format!(
                    "cannot create pdftoppm snapshot {}: {error}",
                    snapshot.executable.display()
                )
            })?;
        file.write_all(bytes).map_err(|error| {
            format!(
                "cannot write pdftoppm snapshot {}: {error}",
                snapshot.executable.display()
            )
        })?;
        file.sync_all().map_err(|error| {
            format!(
                "cannot sync pdftoppm snapshot {}: {error}",
                snapshot.executable.display()
            )
        })?;
        drop(file);

        std::fs::set_permissions(
            &snapshot.executable,
            snapshot.executable_permissions.clone(),
        )
        .map_err(|error| {
            format!(
                "cannot make pdftoppm snapshot executable {}: {error}",
                snapshot.executable.display()
            )
        })?;
        for (path, original) in [
            (&snapshot.executable, &snapshot.executable_permissions),
            (&snapshot.directory, &snapshot.directory_permissions),
        ] {
            let mut read_only = original.clone();
            read_only.set_readonly(true);
            std::fs::set_permissions(path, read_only).map_err(|error| {
                format!(
                    "cannot make pdftoppm snapshot read-only {}: {error}",
                    path.display()
                )
            })?;
        }
        Ok(snapshot)
    }
}

impl Drop for ExecutableSnapshot {
    fn drop(&mut self) {
        let _ = std::fs::set_permissions(&self.directory, self.directory_permissions.clone());
        let _ = std::fs::set_permissions(&self.executable, self.executable_permissions.clone());
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

impl Rasterizer {
    pub(crate) fn discover() -> Result<Self, String> {
        let executable = if let Some(configured) = std::env::var_os("PARITY_PDFTOPPM") {
            let configured = PathBuf::from(configured);
            if !configured.is_absolute() {
                return Err("PARITY_PDFTOPPM must be an absolute path".to_string());
            }
            configured.canonicalize().map_err(|error| {
                format!(
                    "cannot resolve PARITY_PDFTOPPM {}: {error}",
                    configured.display()
                )
            })?
        } else {
            find_on_path("pdftoppm").ok_or_else(|| "pdftoppm not found on PATH".to_string())?
        };
        Self::from_executable(executable)
    }

    fn from_executable(source_executable: PathBuf) -> Result<Self, String> {
        let executable_bytes = std::fs::read(&source_executable)
            .map_err(|error| format!("cannot hash {}: {error}", source_executable.display()))?;
        let sha256 = sha256_hex(&executable_bytes);
        let snapshot = ExecutableSnapshot::create(&source_executable, &executable_bytes)?;
        let output = Command::new(&snapshot.executable)
            .arg("-v")
            .output()
            .map_err(|error| {
                format!(
                    "cannot run authenticated pdftoppm snapshot {} copied from {}: {error}; the temporary directory may be mounted noexec",
                    snapshot.executable.display(),
                    source_executable.display()
                )
            })?;
        if !output.status.success() {
            return Err(format!(
                "{} -v exited {}",
                source_executable.display(),
                output.status
            ));
        }
        let version_output = if output.stderr.is_empty() {
            &output.stdout
        } else {
            &output.stderr
        };
        let version = String::from_utf8_lossy(version_output)
            .lines()
            .next()
            .unwrap_or("unknown pdftoppm version")
            .trim()
            .to_string();
        if !version.starts_with("pdftoppm version ") {
            return Err(format!(
                "{} returned an unexpected version banner: {version:?}",
                source_executable.display()
            ));
        }
        Ok(Self {
            source_executable,
            snapshot,
            version,
            sha256,
        })
    }

    pub(crate) fn source_executable(&self) -> &Path {
        &self.source_executable
    }

    pub(crate) fn executed_snapshot(&self) -> &Path {
        &self.snapshot.executable
    }

    pub(crate) fn version(&self) -> &str {
        &self.version
    }

    pub(crate) fn sha256(&self) -> &str {
        &self.sha256
    }

    pub(crate) fn argument_contract() -> String {
        let arguments = Self::arguments(Path::new("<PDF>"), Path::new("<PREFIX>"));
        format!(
            "[{}]",
            arguments
                .iter()
                .map(|argument| argument.to_string_lossy())
                .collect::<Vec<_>>()
                .join(", ")
        )
    }

    fn arguments(pdf: &Path, prefix: &Path) -> Vec<OsString> {
        vec![
            OsString::from("-r"),
            OsString::from(DPI.to_string()),
            OsString::from("-png"),
            pdf.as_os_str().to_owned(),
            prefix.as_os_str().to_owned(),
        ]
    }

    /// Rasterize every page to `<tmp>/<key>-<n>.png`, returning paths in page
    /// order. Both oracle and candidate call this method with distinct keys.
    pub(crate) fn rasterize_all_pages(
        &self,
        pdf: &Path,
        tmp_dir: &Path,
        key: &str,
    ) -> Result<Vec<PathBuf>, String> {
        clear_raster_pages(tmp_dir, key)?;

        let prefix = tmp_dir.join(key);
        let mut child = Command::new(&self.snapshot.executable)
            .args(Self::arguments(pdf, &prefix))
            .spawn()
            .map_err(|error| {
                format!(
                    "cannot run authenticated pdftoppm snapshot {}: {error}",
                    self.snapshot.executable.display()
                )
            })?;
        let deadline = Instant::now() + Duration::from_secs(120);
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{} timed out after 120 seconds",
                    self.snapshot.executable.display()
                ));
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        if !status.success() {
            return Err(format!(
                "{} exit {status}",
                self.snapshot.executable.display()
            ));
        }

        collect_raster_pages(tmp_dir, key)
    }
}

fn raster_page_number(name: &str, key: &str) -> Option<u32> {
    let rest = name.strip_prefix(&format!("{key}-"))?;
    let number = rest.strip_suffix(".png")?;
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    number.parse().ok()
}

fn clear_raster_pages(tmp_dir: &Path, key: &str) -> Result<(), String> {
    for entry in std::fs::read_dir(tmp_dir)
        .map_err(|error| format!("cannot scan {}: {error}", tmp_dir.display()))?
    {
        let entry =
            entry.map_err(|error| format!("cannot inspect {}: {error}", tmp_dir.display()))?;
        if entry
            .file_name()
            .to_str()
            .and_then(|name| raster_page_number(name, key))
            .is_some()
        {
            std::fs::remove_file(entry.path()).map_err(|error| {
                format!(
                    "cannot remove stale raster {}: {error}",
                    entry.path().display()
                )
            })?;
        }
    }
    Ok(())
}

fn collect_raster_pages(tmp_dir: &Path, key: &str) -> Result<Vec<PathBuf>, String> {
    let mut pages = Vec::new();
    for entry in std::fs::read_dir(tmp_dir)
        .map_err(|error| format!("cannot scan {}: {error}", tmp_dir.display()))?
    {
        let entry =
            entry.map_err(|error| format!("cannot inspect {}: {error}", tmp_dir.display()))?;
        let path = entry.path();
        if let Some(number) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| raster_page_number(name, key))
        {
            pages.push((number, path));
        }
    }
    pages.sort_by_key(|(number, _)| *number);
    if pages.is_empty() {
        return Err("pdftoppm produced no pages".to_string());
    }
    if pages
        .iter()
        .map(|(number, _)| *number)
        .ne(1..=pages.len() as u32)
    {
        return Err("pdftoppm produced a non-contiguous page sequence".to_string());
    }
    Ok(pages.into_iter().map(|(_, path)| path).collect())
}

fn find_on_path(binary: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(binary))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| candidate.canonicalize().ok().or(Some(candidate)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn write_fake_pdftoppm(path: &Path, identity: &str) -> Vec<u8> {
        use std::os::unix::fs::PermissionsExt;

        let script = format!(
            "#!/bin/sh\n\
             if [ \"$1\" = \"-v\" ]; then\n\
               echo 'pdftoppm version {identity}' >&2\n\
               exit 0\n\
             fi\n\
             for argument in \"$@\"; do output=\"$argument\"; done\n\
             printf '%s' '{identity}' > \"${{output}}-1.png\"\n"
        );
        std::fs::write(path, script.as_bytes()).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        script.into_bytes()
    }

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ironpress-rasterizer-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn oracle_and_candidate_use_one_argument_builder() {
        let oracle =
            Rasterizer::arguments(Path::new("oracle.pdf"), Path::new("tmp/oracle-example"));
        let candidate = Rasterizer::arguments(
            Path::new("candidate.pdf"),
            Path::new("tmp/candidate-example"),
        );
        assert_eq!(&oracle[..3], &candidate[..3]);
        assert_eq!(oracle[0], "-r");
        assert_eq!(oracle[1], OsString::from(DPI.to_string()));
        assert_eq!(oracle[2], "-png");
        assert_eq!(
            Rasterizer::argument_contract(),
            format!("[-r, {DPI}, -png, <PDF>, <PREFIX>]")
        );
    }

    #[cfg(unix)]
    #[test]
    fn source_replacement_or_removal_cannot_change_the_authenticated_executable() {
        let directory = temp_dir("pinned-executable");
        let source = directory.join("pdftoppm");
        let replacement = directory.join("replacement");
        let pinned_bytes = write_fake_pdftoppm(&source, "pinned");
        let rasterizer = Rasterizer::from_executable(source.clone()).unwrap();
        let snapshot_path = rasterizer.executed_snapshot().to_path_buf();

        assert_ne!(snapshot_path, source);
        assert_eq!(rasterizer.source_executable(), source);
        assert_eq!(rasterizer.version(), "pdftoppm version pinned");
        assert_eq!(rasterizer.sha256(), sha256_hex(&pinned_bytes));
        assert!(
            std::fs::metadata(snapshot_path.parent().unwrap())
                .unwrap()
                .permissions()
                .readonly()
        );

        write_fake_pdftoppm(&replacement, "replacement");
        std::fs::rename(&replacement, &source).unwrap();
        let candidate = rasterizer
            .rasterize_all_pages(&directory.join("candidate.pdf"), &directory, "candidate")
            .unwrap();
        assert_eq!(std::fs::read(&candidate[0]).unwrap(), b"pinned");

        std::fs::remove_file(&source).unwrap();
        let oracle = rasterizer
            .rasterize_all_pages(&directory.join("oracle.pdf"), &directory, "oracle")
            .unwrap();
        assert_eq!(std::fs::read(&oracle[0]).unwrap(), b"pinned");
        assert!(snapshot_path.is_file());

        drop(rasterizer);
        assert!(!snapshot_path.exists());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn page_collection_is_numeric_contiguous_and_prefix_exact() {
        let directory = temp_dir("page-order");
        for name in [
            "candidate-a-2.png",
            "candidate-a-1.png",
            "candidate-a-longer-1.png",
            "candidate-a-note.png",
        ] {
            std::fs::write(directory.join(name), []).unwrap();
        }
        let pages = collect_raster_pages(&directory, "candidate-a").unwrap();
        assert_eq!(
            pages
                .iter()
                .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            ["candidate-a-1.png", "candidate-a-2.png"]
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn missing_middle_or_first_page_fails_closed() {
        let directory = temp_dir("page-gap");
        std::fs::write(directory.join("oracle-a-1.png"), []).unwrap();
        std::fs::write(directory.join("oracle-a-3.png"), []).unwrap();
        assert!(
            collect_raster_pages(&directory, "oracle-a")
                .unwrap_err()
                .contains("non-contiguous")
        );
        std::fs::remove_file(directory.join("oracle-a-1.png")).unwrap();
        assert!(
            collect_raster_pages(&directory, "oracle-a")
                .unwrap_err()
                .contains("non-contiguous")
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn stale_cleanup_cannot_delete_a_longer_fixture_id() {
        let directory = temp_dir("stale-prefix");
        let own = directory.join("candidate-a-1.png");
        let other = directory.join("candidate-a-longer-1.png");
        std::fs::write(&own, []).unwrap();
        std::fs::write(&other, []).unwrap();
        clear_raster_pages(&directory, "candidate-a").unwrap();
        assert!(!own.exists());
        assert!(other.exists());
        let _ = std::fs::remove_dir_all(directory);
    }
}
