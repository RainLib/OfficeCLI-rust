//! Bound the lifetime and diagnostics of a read-only export subprocess.
use super::{internal, ApiError};
use axum::http::StatusCode;
use std::process::{Output, Stdio};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MAX_DIAGNOSTIC_BYTES: usize = 64 * 1024;

pub(super) fn reserve_slot() -> Result<OwnedSemaphorePermit, ApiError> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SLOTS
        .get_or_init(|| Arc::new(Semaphore::new(2)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "other exports are running".into(),
            )
        })
}

pub(super) fn timeout_from_env() -> Result<Duration, ApiError> {
    let seconds = match std::env::var("HCD_HTTP_EXPORT_TIMEOUT_SECONDS") {
        Ok(value) => value.parse::<u64>().map_err(internal)?,
        Err(std::env::VarError::NotPresent) => 300,
        Err(error) => return Err(internal(error)),
    };
    if !(1..=3600).contains(&seconds) {
        return Err(internal("HCD_HTTP_EXPORT_TIMEOUT_SECONDS must be 1..3600"));
    }
    Ok(Duration::from_secs(seconds))
}

pub(super) async fn run(
    command: &mut tokio::process::Command,
    timeout: Duration,
) -> Result<Output, ApiError> {
    let mut child = command
        .kill_on_drop(true)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(internal)?;
    let mut stderr = child.stderr.take().expect("piped stderr");
    // Continue draining after the cap so a noisy child cannot deadlock on its
    // pipe. Only bounded diagnostics can enter an HTTP error response.
    let diagnostics = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let mut buffer = [0; 8192];
        loop {
            let count = stderr.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            let remaining = MAX_DIAGNOSTIC_BYTES.saturating_sub(bytes.len());
            bytes.extend_from_slice(&buffer[..count.min(remaining)]);
        }
        std::io::Result::Ok(bytes)
    });
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(status) => status.map_err(internal)?,
        Err(_) => {
            // kill() also waits/reaps. A request task dropped by the runtime
            // uses kill_on_drop; an ordinary deadline explicitly reaps here.
            let _ = child.kill().await;
            diagnostics.abort();
            return Err(ApiError(
                StatusCode::GATEWAY_TIMEOUT,
                "export timed out; saved document revision is unchanged".into(),
            ));
        }
    };
    let stderr = diagnostics.await.map_err(internal)?.map_err(internal)?;
    Ok(Output {
        status,
        stdout: Vec::new(),
        stderr,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn shell(script: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.arg("-c").arg(script);
        command
    }
    async fn running(pid: &str) -> bool {
        tokio::process::Command::new("/bin/kill")
            .args(["-0", pid])
            .stderr(Stdio::null())
            .status()
            .await
            .unwrap()
            .success()
    }
    async fn wait_for_pid(path: &std::path::Path) -> String {
        for _ in 0..100 {
            if let Ok(value) = tokio::fs::read_to_string(path).await {
                if !value.trim().is_empty() {
                    return value.trim().into();
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("export test child did not start");
    }
    fn sleeping_child(path: &std::path::Path) -> tokio::process::Command {
        let mut command = shell("echo $$ > \"$1\"; exec sleep 60");
        command.arg("export-test").arg(path);
        command
    }
    #[tokio::test]
    async fn successful_export_discards_stdout_and_preserves_exit_status() {
        let result = run(
            &mut shell("printf diagnostic >&2; printf unused; exit 3"),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
        assert_eq!(result.status.code(), Some(3));
        assert!(result.stdout.is_empty());
        assert_eq!(result.stderr, b"diagnostic");
    }
    #[tokio::test]
    async fn noisy_export_drains_pipe_without_unbounded_diagnostics() {
        let result = run(
            &mut shell("head -c 100000 /dev/zero >&2"),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
        assert!(result.status.success());
        assert_eq!(result.stderr.len(), MAX_DIAGNOSTIC_BYTES);
    }
    #[tokio::test]
    async fn deadline_kills_and_reaps_export_child() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("pid");
        let result = run(&mut sleeping_child(&path), Duration::from_millis(100)).await;
        assert!(matches!(
            result,
            Err(ApiError(StatusCode::GATEWAY_TIMEOUT, _))
        ));
        assert!(!running(&wait_for_pid(&path).await).await);
    }
    #[tokio::test]
    async fn dropped_request_task_does_not_leave_its_export_child_running() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("pid");
        let mut command = sleeping_child(&path);
        let task = tokio::spawn(async move { run(&mut command, Duration::from_secs(60)).await });
        let pid = wait_for_pid(&path).await;
        assert!(running(&pid).await);
        task.abort();
        let _ = task.await;
        for _ in 0..100 {
            if !running(&pid).await {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("cancelled export child remains alive");
    }
}
