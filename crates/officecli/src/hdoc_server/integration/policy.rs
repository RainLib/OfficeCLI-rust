//! Deny unknown managed-document routes, including transports without fine policy.
use super::*;

fn operation_requirements(method: &str, route: &str) -> Result<Vec<&'static str>, ApiError> {
    let read = matches!(method, "GET" | "HEAD");
    let parts: Vec<_> = route.trim_start_matches('/').split('/').collect();
    if matches!(
        parts[0],
        "agent-runs" | "agent-workflows" | "image-jobs" | "mcp"
    ) || route.starts_with("/image/jobs")
        || route.starts_with("/image/copies")
    {
        return Err(denied(
            "this host integration does not yet support delegated AI/MCP or document copies",
        ));
    }
    let mut required = vec!["document.view"];
    if read {
        match parts[0] {
            "revisions" => required.push("history.view"),
            "export" | "downloads" => {}
            ""
            | "auth"
            | "capabilities"
            | "editor"
            | "index"
            | "chunks"
            | "search"
            | "nodes"
            | "sheets"
            | "assets"
            | "styles"
            | "presentation"
            | "theme"
            | "font-plan"
            | "export-capabilities"
            | "integration"
            | "publications"
            | "agents"
            | "collaboration"
            | "image" => {}
            _ => return Err(denied("unclassified host document route")),
        }
    } else {
        match (method, parts[0]) {
            ("POST", "project" | "patch" | "node-patch" | "checkpoints" | "collaboration") => {
                required.push("document.edit")
            }
            ("PUT", "collaboration") => required.push("document.edit"),
            ("POST", "restore") => {
                required.extend(["document.edit", "history.view", "history.restore"])
            }
            ("PUT", "theme") => required.push("theme.assign"),
            ("POST", "publications") => required.extend(["document.edit", "document.publish"]),
            ("POST", "downloads") => {}
            ("POST", "image") if route == "/image/commit" => required.push("document.edit"),
            _ => return Err(denied("unclassified host document operation")),
        }
    }
    Ok(required)
}

async fn authorize_request(
    state: &ServerState,
    method: &str,
    path: &str,
    query: Option<&str>,
    headers: &HeaderMap,
) -> Result<(), ApiError> {
    let Some(integration) = state.integration.as_deref() else {
        return Ok(());
    };
    if let Some(ticket_id) = path
        .strip_prefix("/v1/downloads/")
        .and_then(|p| p.split('/').next())
    {
        let ticket = state.downloads.lock().await.get(ticket_id).cloned();
        if let Some(ticket) = ticket {
            if let Some(session_id) = &ticket.integration_session {
                let session = integration.store.session(session_id)?;
                let decision = integration.provider.permissions(&session).await?;
                if ticket.revision
                    != open(state, &session.document_id)?
                        .manifest()
                        .map_err(hcd_error)?
                        .revision
                {
                    decision.require(&["history.view"])?;
                }
                return export_permission(state, &session.document_id, &ticket.format, &decision);
            }
        }
        return Ok(());
    }
    if let Some(document_path) = path.strip_prefix("/v1/documents/") {
        let (id, route) = document_path
            .split_once('/')
            .map(|(id, route)| (id, format!("/{route}")))
            .unwrap_or((document_path, String::new()));
        if integration.store.mapping(id).is_none() {
            // A host token cannot be presented against another (legacy) document.
            if let Some(actor) = decoded_actor(state, headers) {
                if actor.integration_session.is_some() {
                    return Err(denied("host session is bound to another document"));
                }
            }
            return Ok(());
        }
        let actor = claims(state, headers, id)?;
        if actor.integration_session.is_none() {
            let allowed = actor.sub.as_deref() == Some("hcd-collaboration")
                && match method {
                    "GET" | "HEAD" => {
                        matches!(route.as_str(), "" | "/editor" | "/collaboration/state")
                    }
                    "POST" => matches!(
                        route.as_str(),
                        "/project" | "/checkpoints" | "/collaboration/pending"
                    ),
                    "PUT" => route == "/collaboration/state",
                    _ => false,
                };
            return if allowed {
                Ok(())
            } else {
                Err(denied(
                    "collaboration service cannot use this document route",
                ))
            };
        }
        let session = integration.session(state, headers, id)?;
        let decision = integration.provider.permissions(&session).await?;
        decision.require(&operation_requirements(method, &route)?)?;
        if let Some(query) = query {
            let url = reqwest::Url::parse(&format!("http://local/?{query}")).map_err(bad)?;
            for (key, value) in url.query_pairs() {
                if key == "revision" {
                    let revision: u64 = value.parse().map_err(|_| bad("invalid revision"))?;
                    if revision != open(state, id)?.manifest().map_err(hcd_error)?.revision {
                        decision.require(&["history.view"])?;
                    }
                }
            }
        }
        if let Some(format) = route
            .strip_prefix("/export/")
            .or_else(|| route.strip_prefix("/downloads/"))
        {
            export_permission(state, id, format, &decision)?;
        }
        return Ok(());
    }
    if path.starts_with("/v1/")
        && path != "/v1/capabilities"
        && decoded_actor(state, headers).is_some_and(|actor| actor.integration_session.is_some())
    {
        return Err(denied(
            "host sessions cannot access global catalogs or management APIs",
        ));
    }
    Ok(())
}

fn decoded_actor(state: &ServerState, headers: &HeaderMap) -> Option<Claims> {
    let token = headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")?;
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&["hcd-core"]);
    decode::<Claims>(token, &DecodingKey::from_secret(&state.secret), &validation)
        .ok()
        .map(|v| v.claims)
}

pub(super) fn export_permission(
    state: &ServerState,
    id: &str,
    format: &str,
    decision: &provider::Decision,
) -> Result<(), ApiError> {
    let source = open(state, id)?
        .manifest()
        .map_err(hcd_error)?
        .source
        .format;
    let source = if source == "jpg" { "jpeg" } else { &source };
    if format == source {
        decision.require(&["document.view", "document.download"])?;
    } else {
        decision.require(&["document.view", "document.export"])?;
        if !decision
            .constraints
            .export_formats
            .iter()
            .any(|f| f == format)
        {
            return Err(denied("export format is not granted"));
        }
    }
    if format == "hcd" {
        decision.require(&["history.view"])?;
    }
    Ok(())
}

pub(in crate::hdoc_server) async fn guard(
    State(state): State<ServerState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let query = request.uri().query().map(str::to_string);
    let headers = request.headers().clone();
    match authorize_request(&state, &method, &path, query.as_deref(), &headers).await {
        Ok(()) => next.run(request).await,
        Err(error) => error.into_response(),
    }
}
