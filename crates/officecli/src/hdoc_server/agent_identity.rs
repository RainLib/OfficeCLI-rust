//! Visible names belong to agents. Authorization continues to use the signed principal.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

pub(super) const EDITOR: &str = "墨点";
pub(super) const REVIEWER: &str = "校墨";
const WORKERS: [&str; 4] = ["折线", "尺规", "拾光", "点墨"];

pub(super) fn worker(index: usize) -> &'static str {
    WORKERS[index % WORKERS.len()]
}
pub(super) fn clean(name: Option<&str>) -> Option<String> {
    let name = name?
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(48)
        .collect::<String>();
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_owned())
}
pub(super) fn visible(actor: &Claims, headers: &HeaderMap) -> String {
    if actor.worker_generation.is_some() {
        return clean(actor.name.as_deref()).unwrap_or_else(|| EDITOR.into());
    }
    let alias = headers
        .get("x-hcd-agent-name")
        .filter(|v| v.len() <= 256)
        .and_then(|v| URL_SAFE_NO_PAD.decode(v.as_bytes()).ok())
        .and_then(|v| String::from_utf8(v).ok());
    clean(alias.as_deref()).unwrap_or_else(|| EDITOR.into())
}
pub(super) fn encode_name(name: &str) -> axum::http::HeaderValue {
    URL_SAFE_NO_PAD
        .encode(name.as_bytes())
        .parse()
        .expect("base64url is a header value")
}

// Use this identity only for transient overlays. ACLs and undo ownership stay
// with the authenticated principal who actually delegated the edit.
pub(super) fn for_presence(actor: &Claims, headers: &HeaderMap) -> Claims {
    let mut display = actor.clone();
    if actor.worker_generation.is_none() {
        if let Some(key) = headers
            .get("x-hcd-agent-presence-id")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
        {
            display.sub = Some(format!("agent-{key}"));
            display.name = Some(visible(actor, headers));
        }
    }
    display
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_names_are_visible_bounded_and_distinct_across_the_team() {
        assert_eq!(clean(Some("  芽\u{202e}芽\n ")).as_deref(), Some("芽芽"));
        assert_eq!(clean(Some(" \n  ")), None);
        assert_eq!(clean(Some(&"苗".repeat(60))).unwrap().chars().count(), 48);
        let named = (0..4).map(worker).collect::<std::collections::HashSet<_>>();
        assert_eq!(named.len(), 4);
        assert!(!named.contains(EDITOR));
    }
}
