//! A short-lived, service-only write barrier for the local Workspace snapshot.
use super::*;
use axum::http::Method;
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

const LEASE_TIME: Duration = Duration::from_secs(180);
pub(in crate::hdoc_server) const PATH: &str = "/integration/v1/backup-leases/";

#[derive(Clone, Default)]
pub(in crate::hdoc_server) struct Gate {
    writes: Arc<RwLock<()>>,
    lease: Arc<Mutex<Option<Lease>>>,
}

struct Lease {
    id: uuid::Uuid,
    expires: tokio::time::Instant,
    _guard: OwnedRwLockWriteGuard<()>,
}

tokio::task_local! {
    static ADMITTED: Arc<OwnedRwLockReadGuard<()>>;
}

pub(in crate::hdoc_server) fn spawn<F>(work: F) -> tokio::task::JoinHandle<F::Output>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    match ADMITTED.try_with(Arc::clone) {
        Ok(permit) => tokio::spawn(ADMITTED.scope(permit, work)),
        Err(_) => tokio::spawn(work),
    }
}

impl Gate {
    pub(super) fn try_work(&self) -> Option<OwnedRwLockReadGuard<()>> {
        self.writes.clone().try_read_owned().ok()
    }
}

pub(in crate::hdoc_server) async fn admit(
    State(state): State<ServerState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let Some(gate) = &state.backup else {
        return next.run(request).await;
    };
    let path = request.uri().path();
    let read = matches!(*request.method(), Method::GET | Method::HEAD);
    // Export and download GETs may write audit/jobs. Admin jobs may repair a
    // previous interrupted record. Everything else read-only can keep serving.
    if path.starts_with(PATH)
        || read
            && path != "/v1/admin/jobs"
            && !path.starts_with("/v1/downloads/")
            && !path.contains("/export/")
    {
        return next.run(request).await;
    }
    let Some(guard) = gate.try_work() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::RETRY_AFTER, "2")],
            Json(
                json!({"code":"workspace_snapshot","error":"工作空间正在取备份快照，请稍后重试。"}),
            ),
        )
            .into_response();
    };
    // A disconnected browser cannot cancel an admitted mutation while its
    // blocking filesystem operation is still running.
    tokio::spawn(ADMITTED.scope(Arc::new(guard), next.run(request)))
        .await
        .unwrap_or_else(|error| internal(error).into_response())
}

pub(in crate::hdoc_server) async fn acquire(
    State(state): State<ServerState>,
    Path(id): Path<uuid::Uuid>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let gate = authorized(&state, &headers)?;
    let mut active = gate.lease.lock().await;
    if active
        .as_ref()
        .is_some_and(|lease| lease.id == id && lease.expires > tokio::time::Instant::now())
    {
        return Ok(StatusCode::NO_CONTENT);
    }
    let guard = gate
        .writes
        .clone()
        .try_write_owned()
        .map_err(|_| conflict("workspace writes are still in flight"))?;
    let expires = tokio::time::Instant::now() + LEASE_TIME;
    *active = Some(Lease {
        id,
        expires,
        _guard: guard,
    });
    let leases = gate.lease.clone();
    tokio::spawn(async move {
        tokio::time::sleep_until(expires).await;
        let mut active = leases.lock().await;
        if active
            .as_ref()
            .is_some_and(|lease| lease.id == id && lease.expires == expires)
        {
            *active = None;
        }
    });
    Ok(StatusCode::NO_CONTENT)
}

pub(in crate::hdoc_server) async fn release(
    State(state): State<ServerState>,
    Path(id): Path<uuid::Uuid>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let gate = authorized(&state, &headers)?;
    let mut active = gate.lease.lock().await;
    if active
        .as_ref()
        .is_none_or(|lease| lease.id != id || lease.expires <= tokio::time::Instant::now())
    {
        return Err(conflict(
            "backup write barrier expired or belongs to another snapshot",
        ));
    }
    *active = None;
    Ok(StatusCode::NO_CONTENT)
}

fn authorized<'a>(state: &'a ServerState, headers: &HeaderMap) -> Result<&'a Gate, ApiError> {
    configured(state)?.service(headers)?;
    state.backup.as_ref().ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            "local snapshot service is disabled".into(),
        )
    })
}
