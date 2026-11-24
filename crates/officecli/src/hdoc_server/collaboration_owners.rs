//! Fence sidecar writes during a room handoff using the same lock as checkpoints.
use super::*;
use uuid::Uuid;

#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Owner {
    sequence: u64,
    token: Uuid,
}

pub(super) type Owners = HashMap<String, Owner>;

pub(super) async fn assign(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(owner): Json<Owner>,
) -> Result<StatusCode, ApiError> {
    integration::configured(&state)?.service(&headers)?;
    let mut guard = state.collaboration_lock.lock().await;
    let owners = guard.as_mut().ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            "external collaboration is disabled".into(),
        )
    })?;
    open(&state, &id)?;
    if let Some(current) = owners.get(&id) {
        if current == &owner {
            return Ok(StatusCode::NO_CONTENT);
        }
        if current.sequence >= owner.sequence {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "collaboration owner assignment is out of date".into(),
            ));
        }
    }
    owners.insert(id, owner);
    Ok(StatusCode::NO_CONTENT)
}

pub(super) fn require(
    owners: &Option<Owners>,
    actor: &Claims,
    id: &str,
    headers: &HeaderMap,
) -> Result<Option<Uuid>, ApiError> {
    let Some(owners) = owners
        .as_ref()
        .filter(|_| actor.sub.as_deref() == Some("hcd-collaboration"))
    else {
        return Ok(None);
    };
    let token = headers
        .get("x-hcd-collaboration-owner")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| Uuid::parse_str(value).ok());
    if let Some(token) =
        token.filter(|token| owners.get(id).is_some_and(|owner| owner.token == *token))
    {
        Ok(Some(token))
    } else {
        Err(ApiError(
            StatusCode::CONFLICT,
            "collaboration room is owned by another instance".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_old_owner_cannot_write_after_handoff() {
        let old = Uuid::new_v4();
        let current = Uuid::new_v4();
        let owners = Some(HashMap::from([(
            "managed-doc".to_string(),
            Owner {
                sequence: 2,
                token: current,
            },
        )]));
        let actor = Claims {
            doc: "managed-doc".into(),
            scope: "write".into(),
            sub: Some("hcd-collaboration".into()),
            name: None,
            aud: "hcd-core".into(),
            iat: 0,
            exp: 60,
            worker_generation: None,
            integration_session: None,
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-hcd-collaboration-owner",
            old.to_string().parse().unwrap(),
        );
        assert_eq!(
            require(&owners, &actor, "managed-doc", &headers)
                .unwrap_err()
                .0,
            StatusCode::CONFLICT
        );
        headers.insert(
            "x-hcd-collaboration-owner",
            current.to_string().parse().unwrap(),
        );
        assert_eq!(
            require(&owners, &actor, "managed-doc", &headers).unwrap(),
            Some(current)
        );
        assert!(require(&owners, &actor, "another-doc", &headers).is_err());
        assert_eq!(
            require(&None, &actor, "managed-doc", &HeaderMap::new()).unwrap(),
            None
        );
    }
}
