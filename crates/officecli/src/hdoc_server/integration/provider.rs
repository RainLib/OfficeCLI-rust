//! The registered host is the authority for identity, policy and immutable files.
use super::*;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

pub(super) const OPERATIONS: &[&str] = &[
    "document.view",
    "document.edit",
    "document.ai",
    "document.publish",
    "document.download",
    "document.export",
    "document.print",
    "document.copy",
    "history.view",
    "history.restore",
    "theme.assign",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Config {
    pub schema_version: String,
    pub tenant_id: String,
    pub app_id: String,
    pub provider_url: String,
    pub key_id: String,
    pub provider_secret_env: String,
    pub service_secret_env: String,
    pub transfer_origins: Vec<String>,
    pub events: Option<EventConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EventConfig {
    pub url: String,
    pub key_id: String,
    pub secret_env: String,
}

pub(super) struct Provider {
    pub config: Config,
    client: reqwest::Client,
    secret: Vec<u8>,
    pub service_secret: Vec<u8>,
    event_secret: Option<Vec<u8>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct User {
    pub id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Resolved {
    pub tenant_id: String,
    pub app_id: String,
    pub external_file_id: String,
    pub session_id: String,
    pub actor: User,
    pub expires_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Descriptor {
    pub id: String,
    pub version: String,
    pub name: String,
    pub media_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub created_at: String,
    pub modified_at: String,
    pub creator_id: String,
    pub modifier_id: String,
}

impl Descriptor {
    pub fn format(&self) -> Result<String, ApiError> {
        let extension = std::path::Path::new(&self.name)
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let format = match extension.as_str() {
            "markdown" => "md",
            "htm" => "html",
            "jpg" => "jpeg",
            other => other,
        };
        if !matches!(
            format,
            "docx"
                | "xlsx"
                | "pptx"
                | "pdf"
                | "html"
                | "md"
                | "txt"
                | "png"
                | "jpeg"
                | "webp"
                | "excalidraw"
        ) {
            return Err(bad("Provider file format is not supported"));
        }
        if self.size_bytes > MAX_FILE_BYTES
            || !sha256_valid(&self.sha256)
            || self.version.is_empty()
            || self.version.len() > 256
            || self.name.chars().any(char::is_control)
            || self.name.len() > 4096
        {
            return Err(bad("invalid Provider file descriptor"));
        }
        Ok(format.into())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::hdoc_server) struct Decision {
    pub granted: Vec<String>,
    pub permission_version: String,
    pub expires_at: String,
    pub constraints: Constraints,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::hdoc_server) struct Constraints {
    #[serde(default)]
    pub selection_agent: bool,
    pub export_formats: Vec<String>,
    pub model_ids: Vec<String>,
}

impl Decision {
    pub fn require_model(&self, model: &str) -> Result<(), ApiError> {
        self.require(&["document.view", "document.edit", "document.ai"])?;
        if !self
            .constraints
            .model_ids
            .iter()
            .any(|allowed| allowed == model)
        {
            return Err(denied("model is not authorized by the business Provider"));
        }
        Ok(())
    }

    pub fn require(&self, operations: &[&str]) -> Result<(), ApiError> {
        if operations
            .iter()
            .any(|op| !self.granted.iter().any(|v| v == op))
        {
            return Err(denied("business permission denied"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod model_constraint_tests {
    use super::*;

    #[test]
    fn empty_or_unlisted_models_are_denied_even_with_ai_permission() {
        let mut decision: Decision = serde_json::from_value(json!({
            "granted":["document.view","document.edit","document.ai"],
            "permissionVersion":"acl-1","expiresAt":"2026-11-18T00:00:00Z",
            "constraints":{"exportFormats":[],"modelIds":[]}
        }))
        .unwrap();
        assert!(decision.require_model("allowed-model").is_err());
        decision.constraints.model_ids.push("allowed-model".into());
        assert!(decision.require_model("allowed-model").is_ok());
        assert!(decision.require_model("other-model").is_err());
        decision
            .granted
            .retain(|operation| operation != "document.ai");
        assert!(decision.require_model("allowed-model").is_err());
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Transfer {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub expires_at: String,
}

pub(super) fn timestamp(value: &str) -> Result<u64, ApiError> {
    OffsetDateTime::parse(value, &Rfc3339)
        .ok()
        .and_then(|v| u64::try_from(v.unix_timestamp()).ok())
        .ok_or_else(|| bad("invalid Provider timestamp"))
}

pub(super) fn date_now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("UTC date")
}

fn safe_url(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value).context("invalid integration URL")?;
    if !(url.scheme() == "https"
        || url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(anyhow!(
            "integration URLs require HTTPS or loopback HTTP without credentials or fragments"
        ));
    }
    Ok(url)
}

impl Provider {
    pub fn load(path: &std::path::Path) -> Result<Self> {
        if std::fs::metadata(path)?.len() > 64 * 1024 {
            return Err(anyhow!("integration config exceeds 64 KiB"));
        }
        let config: Config = serde_json::from_slice(&std::fs::read(path)?)?;
        if config.schema_version != "officecli-integration/1"
            || !valid_id(&config.key_id)
            || !external_id(&config.tenant_id)
            || !external_id(&config.app_id)
        {
            return Err(anyhow!("invalid integration config identity"));
        }
        let base = safe_url(&config.provider_url)?;
        if base.query().is_some() {
            return Err(anyhow!("Provider base URL cannot contain a query"));
        }
        for origin in &config.transfer_origins {
            let url = safe_url(origin)?;
            if url.origin().ascii_serialization() != *origin {
                return Err(anyhow!("transferOrigins entries must be exact URL origins"));
            }
        }
        let event_secret = config
            .events
            .as_ref()
            .map(|event| {
                safe_url(&event.url)?;
                if !valid_id(&event.key_id) {
                    return Err(anyhow!("invalid event key ID"));
                }
                load_secret(&event.secret_env)
            })
            .transpose()?;
        let secret = load_secret(&config.provider_secret_env)?;
        let service_secret = load_secret(&config.service_secret_env)?;
        if secret == service_secret
            || event_secret
                .as_ref()
                .is_some_and(|key| key == &secret || key == &service_secret)
        {
            return Err(anyhow!(
                "Provider, session-service and event secrets must be distinct"
            ));
        }
        Ok(Self {
            config,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .timeout(Duration::from_secs(15))
                .build()?,
            secret,
            service_secret,
            event_secret,
        })
    }

    pub fn context(&self, session: &Session) -> Value {
        json!({"tenantId":self.config.tenant_id,"appId":self.config.app_id,
            "sessionId":session.session_id,"actorId":session.actor.id})
    }

    pub fn file_path(&self, file: &str, suffix: &str) -> String {
        let mut url = reqwest::Url::parse("http://placeholder/").expect("static URL");
        url.path_segments_mut().expect("hierarchical URL").extend([
            "officecli-provider",
            "v1",
            "files",
            file,
        ]);
        format!("{}{suffix}", url.path())
    }

    fn signed(
        &self,
        url: reqwest::Url,
        body: Vec<u8>,
        key: &[u8],
        key_id: &str,
    ) -> reqwest::RequestBuilder {
        let seconds = now().to_string();
        let nonce = uuid::Uuid::new_v4().to_string();
        let target = format!(
            "{}{}",
            url.path(),
            url.query().map(|q| format!("?{q}")).unwrap_or_default()
        );
        let canonical = format!(
            "POST\n{target}\n{seconds}\n{nonce}\n{}",
            hcd_core::hash_bytes(&body)
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts keys");
        mac.update(canonical.as_bytes());
        let signature: String = mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect();
        self.client
            .post(url)
            .header("Content-Type", "application/json")
            .header("X-HCD-Timestamp", seconds)
            .header("X-HCD-Nonce", nonce)
            .header("X-HCD-Request-Id", uuid::Uuid::new_v4().to_string())
            .header(
                "X-HCD-Signature",
                format!("v1;kid={key_id};mac={signature}"),
            )
            .body(body)
    }

    pub async fn post<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: Value,
    ) -> Result<T, ApiError> {
        let url = reqwest::Url::parse(&format!(
            "{}{path}",
            self.config.provider_url.trim_end_matches('/')
        ))
        .map_err(internal)?;
        let response = self
            .signed(
                url,
                serde_json::to_vec(&body).map_err(internal)?,
                &self.secret,
                &self.config.key_id,
            )
            .send()
            .await
            .map_err(|_| {
                unavailable("Provider request failed; safe to retry with the same operation ID")
            })?;
        let status = response.status();
        if status.is_success() && status != StatusCode::OK {
            return Err(unavailable(
                "synchronous Provider calls require a final HTTP 200 response",
            ));
        }
        if !status.is_success() {
            return Err(ApiError(
                match status.as_u16() {
                    401 | 403 => StatusCode::FORBIDDEN,
                    404 => StatusCode::NOT_FOUND,
                    409 => StatusCode::CONFLICT,
                    400 | 410 | 422 => StatusCode::UNPROCESSABLE_ENTITY,
                    _ => StatusCode::SERVICE_UNAVAILABLE,
                },
                format!("Provider rejected request (HTTP {})", status.as_u16()),
            ));
        }
        let bytes = bounded(response, 2 * 1024 * 1024).await?;
        serde_json::from_slice(&bytes)
            .map_err(|_| unavailable("Provider returned an invalid response"))
    }

    pub async fn permissions(&self, session: &Session) -> Result<Decision, ApiError> {
        let decision: Decision = self.post("/officecli-provider/v1/permissions/resolve",
            json!({"context":self.context(session),"externalFileId":session.external_file_id,"operations":OPERATIONS})).await?;
        let expiry = timestamp(&decision.expires_at)?;
        let unique: HashSet<_> = decision.granted.iter().collect();
        if expiry <= now()
            || expiry > now() + 60
            || expiry > session.host_expires_at
            || decision.permission_version.is_empty()
            || unique.len() != decision.granted.len()
            || decision
                .granted
                .iter()
                .any(|v| !OPERATIONS.contains(&v.as_str()))
            || decision.constraints.model_ids.len() > 100
            || decision.constraints.export_formats.len() > 32
        {
            return Err(unavailable(
                "Provider returned an invalid permission decision",
            ));
        }
        decision.require(&["document.view"])?;
        Ok(decision)
    }

    fn transfer(
        &self,
        transfer: &Transfer,
        method: &str,
    ) -> Result<reqwest::RequestBuilder, ApiError> {
        let url = safe_url(&transfer.url).map_err(|_| bad("invalid transfer URL"))?;
        if transfer.method != method
            || timestamp(&transfer.expires_at)? <= now()
            || !self
                .config
                .transfer_origins
                .contains(&url.origin().ascii_serialization())
        {
            return Err(denied("transfer URL, method or expiry is not allowed"));
        }
        let mut request = self.client.request(method.parse().map_err(internal)?, url);
        for (key, value) in &transfer.headers {
            if matches!(
                key.to_ascii_lowercase().as_str(),
                "host"
                    | "content-length"
                    | "connection"
                    | "transfer-encoding"
                    | "cookie"
                    | "proxy-authorization"
            ) {
                return Err(bad("Provider returned a forbidden transfer header"));
            }
            let key = reqwest::header::HeaderName::from_bytes(key.as_bytes())
                .map_err(|_| bad("invalid transfer header"))?;
            let value = reqwest::header::HeaderValue::from_str(value)
                .map_err(|_| bad("invalid transfer header"))?;
            request = request.header(key, value);
        }
        Ok(request)
    }

    pub async fn download(
        &self,
        transfer: &Transfer,
        descriptor: &Descriptor,
        target: &std::path::Path,
    ) -> Result<(), ApiError> {
        let response = self
            .transfer(transfer, "GET")?
            .send()
            .await
            .map_err(|_| unavailable("source transfer failed"))?;
        if response.status() != StatusCode::OK {
            return Err(unavailable("source transfer rejected"));
        }
        let bytes = bounded(response, descriptor.size_bytes.min(MAX_FILE_BYTES) as usize).await?;
        if bytes.len() as u64 != descriptor.size_bytes
            || hcd_core::hash_bytes(&bytes) != descriptor.sha256
        {
            return Err(bad("Provider source length or SHA-256 mismatch"));
        }
        store::write_bytes(target, &bytes).map_err(internal)
    }

    pub async fn upload(&self, transfer: &Transfer, bytes: Vec<u8>) -> Result<(), ApiError> {
        let response = self
            .transfer(transfer, "PUT")?
            .body(bytes)
            .send()
            .await
            .map_err(|_| unavailable("publication upload failed"))?;
        if !matches!(response.status().as_u16(), 200 | 201 | 204) {
            return Err(unavailable("publication upload rejected"));
        }
        Ok(())
    }

    pub async fn event(&self, value: &Value) -> Result<u16, ApiError> {
        let config = self
            .config
            .events
            .as_ref()
            .ok_or_else(|| bad("events are disabled"))?;
        let response = self
            .signed(
                reqwest::Url::parse(&config.url).map_err(internal)?,
                serde_json::to_vec(value).map_err(internal)?,
                self.event_secret.as_ref().expect("configured event key"),
                &config.key_id,
            )
            .send()
            .await
            .map_err(|_| unavailable("event delivery failed"))?;
        Ok(response.status().as_u16())
    }
}

#[cfg(test)]
impl Provider {
    pub(super) fn testing(config: Config) -> Self {
        Self {
            config,
            client: reqwest::Client::new(),
            secret: vec![1; 32],
            service_secret: vec![2; 32],
            event_secret: None,
        }
    }
}

async fn bounded(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, ApiError> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err(bad("Provider response exceeds limit"));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| unavailable("Provider response was interrupted"))?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(bad("Provider response exceeds limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
