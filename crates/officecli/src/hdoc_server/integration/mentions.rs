//! A service projection of committed mention targets in managed whiteboards.
use super::*;
use std::collections::BTreeSet;

#[derive(Deserialize)]
pub(crate) struct KnownRevision {
    known: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MentionTarget {
    element_id: String,
    kind: &'static str,
    preview: String,
    recipients: BTreeSet<String>,
}

pub(crate) async fn read(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<KnownRevision>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let integration = configured(&state)?;
    integration.service(&headers)?;
    if integration.store.mapping(&id).is_none() {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "managed whiteboard not found".into(),
        ));
    }
    let bundle = open(&state, &id)?;
    tokio::task::spawn_blocking(move || {
        let manifest = bundle.manifest().map_err(hcd_error)?;
        if manifest.source.format != "excalidraw" {
            return Err(bad("document is not a canvas"));
        }
        let revision = manifest.revision;
        if query.known == Some(revision) {
            return Ok(Json(json!({"revision": revision})));
        }
        let elements = hcd_core::canvas::read_elements(&bundle, revision).map_err(hcd_error)?;
        Ok(Json(
            json!({"revision": revision, "targets": targets(&elements)}),
        ))
    })
    .await
    .map_err(internal)?
}

fn body_text(element: &Value) -> Option<&str> {
    element["originalText"]
        .as_str()
        .or_else(|| element["text"].as_str())
}

fn targets(elements: &[Value]) -> Vec<MentionTarget> {
    let live: HashMap<_, _> = elements
        .iter()
        .filter(|element| element["isDeleted"] != true)
        .filter_map(|element| Some((element["id"].as_str()?, element)))
        .collect();
    let labels: HashMap<_, _> = elements
        .iter()
        .filter(|element| element["isDeleted"] != true && element["type"] == "text")
        .filter_map(|element| Some((element["containerId"].as_str()?, body_text(element)?)))
        .collect();
    elements
        .iter()
        .filter(|element| element["isDeleted"] != true)
        .filter_map(|element| {
            let id = element["id"].as_str()?;
            let data = &element["customData"];
            let tag = &data["officeBoard"];
            let entries = data["mentions"].as_array()?;
            let root = tag["root"].as_str()?;
            let (kind, text) = match tag["kind"].as_str()? {
                "sticky" if root == id => ("sticky", *labels.get(id)?),
                "comment" if root == id => ("comment", data["officeComment"].as_str()?),
                "comment" if tag["part"] == "reply" => {
                    let parent = &live.get(root)?["customData"]["officeBoard"];
                    if parent["kind"] != "comment" || parent["root"] != root {
                        return None;
                    }
                    ("reply", body_text(element)?)
                }
                _ => return None,
            };
            let utf16: Vec<_> = text.encode_utf16().collect();
            let recipients: BTreeSet<_> = entries
                .iter()
                .filter_map(|entry| recipient(entry, &utf16))
                .map(str::to_owned)
                .collect();
            (!recipients.is_empty()).then(|| MentionTarget {
                element_id: id.to_owned(),
                kind,
                preview: text.trim().chars().take(180).collect(),
                recipients,
            })
        })
        .collect()
}

fn recipient<'a>(entry: &'a Value, text: &[u16]) -> Option<&'a str> {
    let subject = entry["id"].as_str()?;
    let suffix = subject.strip_prefix("host-")?;
    if suffix.len() != 32
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let name = entry["name"].as_str()?;
    if name.is_empty() {
        return None;
    }
    // Mention ranges are offsets in the textarea's UTF-16 string.
    let start = usize::try_from(entry["start"].as_u64()?).ok()?;
    let end = usize::try_from(entry["end"].as_u64()?).ok()?;
    let mentioned = text.get(start..end)?;
    mentioned
        .iter()
        .copied()
        .eq(std::iter::once(b'@' as u16).chain(name.encode_utf16()))
        .then_some(subject)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn committed_mentions_use_utf16_spans_and_a_live_thread() {
        let recipient = "host-0123456789abcdef0123456789abcdef";
        let mention = json!({"id":recipient,"name":"林夏","start":3,"end":6});
        let stale = json!({"id":recipient,"name":"林夏","start":2,"end":5});
        let text = "🟢 @林夏 请查阅";
        let mut scene = vec![
            json!({"id":"note","customData":{"officeBoard":{"kind":"sticky","root":"note"},"mentions":[mention,mention]}}),
            json!({"id":"text","type":"text","containerId":"note","originalText":text}),
            json!({"id":"comment","customData":{"officeBoard":{"kind":"comment","root":"comment"},"officeComment":text,"mentions":[stale]}}),
            json!({"id":"reply","type":"text","originalText":text,"customData":{"officeBoard":{"kind":"comment","root":"comment","part":"reply"},"mentions":[mention]}}),
        ];
        let result = targets(&scene);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].element_id, "note");
        assert_eq!(result[0].recipients.len(), 1);
        assert_eq!(result[1].element_id, "reply");
        scene[2]["isDeleted"] = json!(true);
        assert_eq!(targets(&scene).len(), 1);
    }
}
