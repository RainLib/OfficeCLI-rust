//! MCP Streamable HTTP (JSON responses; optional GET SSE is not offered).
//! Sessions are document/principal bound and never carry authorization across
//! requests. Every request must still present a current document bearer token.
use super::*;

pub(super) type SessionStore = Arc<Mutex<HashMap<String, McpSession>>>;
pub(super) struct McpSession {
    document_id: String,
    owner: String,
    protocol: String,
    expires: Instant,
    initialized: bool,
}

const VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];

fn origin(headers: &HeaderMap) -> Result<(), ApiError> {
    if let Some(origin) = headers.get(header::ORIGIN) {
        let host = headers
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let url = origin
            .to_str()
            .ok()
            .and_then(|v| reqwest::Url::parse(v).ok());
        let allowed = url.as_ref().is_some_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
                && url.origin().ascii_serialization() == format!("{}://{host}", url.scheme())
        });
        if !allowed {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "MCP Origin must match request host".into(),
            ));
        }
    }
    Ok(())
}

fn principal(actor: &Claims, headers: &HeaderMap) -> String {
    actor
        .sub
        .as_deref()
        .filter(|id| !id.is_empty())
        .map(|id| format!("user:{id}"))
        // Legacy tokens without a user ID may still read documents, but tokens
        // with the same scope/expiry must not share an MCP session identity.
        .unwrap_or_else(|| {
            format!(
                "token:{}",
                hcd_core::hash_bytes(
                    headers
                        .get(header::AUTHORIZATION)
                        .map(|value| value.as_bytes())
                        .unwrap_or_default()
                )
            )
        })
}

fn rpc(id: Value, result: Result<Value, (i64, &str)>) -> Response {
    let body = match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err((code, message)) => {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
        }
    };
    Json(body).into_response()
}

async fn session(
    state: &ServerState,
    id: &str,
    actor: &Claims,
    headers: &HeaderMap,
) -> Result<String, ApiError> {
    let key = headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| bad("Mcp-Session-Id required after initialize"))?;
    let sessions = state.mcp_sessions.lock().await;
    let value = sessions
        .get(key)
        .filter(|s| {
            s.document_id == id
                && s.owner == principal(actor, headers)
                && s.expires > Instant::now()
        })
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                "MCP session expired or not found".into(),
            )
        })?;
    if headers
        .get("mcp-protocol-version")
        .and_then(|v| v.to_str().ok())
        != Some(value.protocol.as_str())
    {
        return Err(bad(
            "MCP-Protocol-Version must match negotiated session version",
        ));
    }
    Ok(key.to_string())
}

pub(super) async fn get(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    origin(&headers)?;
    let actor = claims(&state, &headers, &id)?;
    session(&state, &id, &actor, &headers).await?;
    Ok((
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, "POST, DELETE")],
    )
        .into_response())
}

pub(super) async fn delete(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    origin(&headers)?;
    let actor = claims(&state, &headers, &id)?;
    let key = session(&state, &id, &actor, &headers).await?;
    state.mcp_sessions.lock().await.remove(&key);
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn post(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Result<Response, ApiError> {
    origin(&headers)?;
    let actor = claims(&state, &headers, &id)?;
    open(&state, &id)?;
    let request_id = request.get("id").cloned().unwrap_or(Value::Null);
    if !request.is_object()
        || request["jsonrpc"] != "2.0"
        || !request["method"].is_string()
        || request
            .get("id")
            .is_some_and(|id| !id.is_null() && !id.is_string() && !id.is_number())
    {
        return Ok(rpc(request_id, Err((-32600, "Invalid JSON-RPC request"))));
    }
    let method = request["method"].as_str().unwrap_or("");
    if method == "initialize" {
        if request.get("id").is_none() {
            return Ok(rpc(
                Value::Null,
                Err((-32600, "initialize requires a request ID")),
            ));
        }
        let requested = request["params"]["protocolVersion"].as_str().unwrap_or("");
        let protocol = if VERSIONS.contains(&requested) {
            requested
        } else {
            VERSIONS[0]
        };
        let key = uuid::Uuid::new_v4().to_string();
        {
            let mut sessions = state.mcp_sessions.lock().await;
            sessions.retain(|_, s| s.expires > Instant::now());
            if sessions.len() >= 1024 {
                return Err(ApiError(
                    StatusCode::TOO_MANY_REQUESTS,
                    "MCP session capacity reached".into(),
                ));
            }
            sessions.insert(
                key.clone(),
                McpSession {
                    document_id: id,
                    owner: principal(&actor, &headers),
                    protocol: protocol.into(),
                    expires: Instant::now() + Duration::from_secs(3600),
                    initialized: false,
                },
            );
        }
        let mut response = rpc(
            request_id,
            Ok(
                json!({"protocolVersion":protocol,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"officecli-hcd","version":env!("CARGO_PKG_VERSION")},"instructions":"Authenticated collaborative document tools. Each agent should use a distinct signed user-id. Read hcd_help before edits; conflicts require fresh reads, never guessed revisions."}),
            ),
        );
        response
            .headers_mut()
            .insert("mcp-session-id", key.parse().map_err(internal)?);
        return Ok(response);
    }
    let key = session(&state, &id, &actor, &headers).await?;
    if request.get("id").is_none() {
        if method == "notifications/initialized" {
            if let Some(value) = state.mcp_sessions.lock().await.get_mut(&key) {
                value.initialized = true;
            }
        }
        return Ok(StatusCode::ACCEPTED.into_response());
    }
    if method == "ping" {
        return Ok(rpc(request_id, Ok(json!({}))));
    }
    if !state
        .mcp_sessions
        .lock()
        .await
        .get(&key)
        .is_some_and(|s| s.initialized)
    {
        return Ok(rpc(
            request_id,
            Err((-32000, "Send notifications/initialized before using tools")),
        ));
    }
    match method {
        "tools/list" => Ok(rpc(
            request_id,
            Ok(json!({"tools":agent_tools::definitions()})),
        )),
        "tools/call" => {
            let Some(name) = request["params"]["name"].as_str() else {
                return Ok(rpc(request_id, Err((-32602, "Tool name required"))));
            };
            if !agent_tools::definitions()
                .iter()
                .any(|tool| tool["name"] == name)
            {
                return Ok(rpc(request_id, Err((-32602, "Unknown tool"))));
            }
            let args = request["params"]
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let result = if name == "hcd_workflow" {
                agent_workflows::call(state, id, headers, args).await
            } else if name == "hcd_agent_run" {
                agent_tools::call_run(state, id, headers, args).await
            } else {
                agent_tools::call(state, id, headers, name, args).await
            };
            let (error, text) = match result {
                Ok(value) => (false, serde_json::to_string(&value).map_err(internal)?),
                Err(error) => (true, format!("HCD HTTP {}: {}", error.0.as_u16(), error.1)),
            };
            Ok(rpc(
                request_id,
                Ok(json!({"content":[{"type":"text","text":text}],"isError":error})),
            ))
        }
        _ => Ok(rpc(request_id, Err((-32601, "Method not found")))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_tokens_do_not_share_a_session_owner_by_scope_and_expiry() {
        let mut actor = Claims {
            doc: "document".into(),
            scope: "read".into(),
            sub: None,
            name: None,
            aud: "hcd-core".into(),
            iat: 1,
            exp: 100,
            worker_generation: None,
            integration_session: None,
        };
        let mut first = HeaderMap::new();
        first.insert(header::AUTHORIZATION, "Bearer first-token".parse().unwrap());
        let mut second = HeaderMap::new();
        second.insert(
            header::AUTHORIZATION,
            "Bearer second-token".parse().unwrap(),
        );
        assert_ne!(principal(&actor, &first), principal(&actor, &second));
        actor.sub = Some("agent-a".into());
        assert_eq!(principal(&actor, &first), principal(&actor, &second));
    }
}
