//! Server-owned people scopes. Presence never populates this directory and a
//! mention never grants document access. Host adapters can replace the snapshot
//! source without changing the public search/resolve contract.
use super::*;
use std::io::Read;

const MAX_DIRECTORY_BYTES: u64 = 1024 * 1024;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Person {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_to: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mentionable_by: Option<Vec<String>>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PeopleSnapshot {
    pub schema_version: String,
    pub generation: u64,
    pub people: Vec<Person>,
}
pub(super) trait PeopleDirectory {
    fn snapshot(&self, document_id: &str) -> Result<Option<(PeopleSnapshot, String)>, String>;
}
pub(super) struct FilePeopleDirectory {
    root: PathBuf,
}
impl FilePeopleDirectory {
    pub fn new(root: &std::path::Path) -> Self {
        Self {
            root: root.join("people"),
        }
    }
}
fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn audience(ids: &Option<Vec<String>>, actor: &str) -> bool {
    ids.as_ref()
        .is_none_or(|ids| ids.iter().any(|id| id == actor))
}
impl PeopleDirectory for FilePeopleDirectory {
    fn snapshot(&self, id: &str) -> Result<Option<(PeopleSnapshot, String)>, String> {
        if !valid_id(id) {
            return Err("invalid document ID".into());
        }
        let path = self.root.join(format!("{id}.json"));
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let mut bytes = Vec::new();
        file.take(MAX_DIRECTORY_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_DIRECTORY_BYTES {
            return Err("people directory exceeds 1 MiB".into());
        }
        let snapshot: PeopleSnapshot = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if snapshot.schema_version != "hcd-people/1" || snapshot.people.len() > 10_000 {
            return Err("unsupported people directory".into());
        }
        let mut ids = HashSet::new();
        for person in &snapshot.people {
            if !text(&person.id, 256)
                || !text(&person.label, 256)
                || person.detail.as_deref().is_some_and(|v| !text(v, 256))
                || !ids.insert(&person.id)
                || [&person.visible_to, &person.mentionable_by]
                    .iter()
                    .any(|scope| {
                        scope.as_ref().is_some_and(|ids| {
                            ids.len() > 256
                                || ids.iter().any(|v| !text(v, 256))
                                || ids.iter().collect::<HashSet<_>>().len() != ids.len()
                        })
                    })
            {
                return Err("invalid people directory entry".into());
            }
        }
        Ok(Some((snapshot, hash_bytes(&bytes))))
    }
}
fn load(state: &ServerState, id: &str) -> Result<(PeopleSnapshot, String), ApiError> {
    FilePeopleDirectory::new(&state.root)
        .snapshot(id)
        .map_err(|_| internal("people directory is unavailable"))?
        .ok_or_else(|| {
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "people directory is not configured".into(),
            )
        })
}
fn visible(person: &Person, actor: &str, access: &DocumentAccess) -> bool {
    access.can_read(Some(&person.id)) && audience(&person.visible_to, actor)
}
fn mentionable(person: &Person, actor: &str, access: &DocumentAccess) -> bool {
    person.active && visible(person, actor, access) && audience(&person.mentionable_by, actor)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OptionsQuery {
    pub kind: Option<String>,
    pub q: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}
#[derive(Deserialize, Serialize)]
struct Cursor {
    doc: String,
    sub: String,
    query: String,
    digest: String,
    access_generation: u64,
    offset: usize,
    exp: usize,
    iss: String,
    aud: String,
}
pub(super) async fn options(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<OptionsQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let identity = claims(&state, &headers, &id)?;
    open(&state, &id)?;
    let actor = identity
        .sub
        .as_deref()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            ApiError(
                StatusCode::FORBIDDEN,
                "people search requires a stable identity".into(),
            )
        })?;
    if query.kind.as_deref().unwrap_or("person") != "person" {
        return Err(bad("reference kind is not available"));
    }
    let term = query.q.unwrap_or_default().trim().to_lowercase();
    let limit = query.limit.unwrap_or(20);
    if term.len() > 256 || term.chars().any(char::is_control) || !(1..=50).contains(&limit) {
        return Err(bad("invalid people search bounds"));
    }
    let access = load_access(&state, &id)?;
    let (snapshot, digest) = load(&state, &id)?;
    let query_hash = hash_bytes(term.as_bytes());
    // Do not expose an unsalted digest of private directory contents in the cursor.
    let digest = jsonwebtoken::crypto::sign(
        format!("{id}:{actor}:{digest}").as_bytes(),
        &EncodingKey::from_secret(&state.secret),
        Algorithm::HS256,
    )
    .map_err(internal)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(internal)?
        .as_secs() as usize;
    let offset = if let Some(token) = query.cursor {
        if token.len() > 2048 {
            return Err(bad("invalid people cursor"));
        }
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_issuer(&["hcd-people-cursor/1"]);
        validation.set_audience(&["hcd-people"]);
        validation.leeway = 0;
        let cursor = decode::<Cursor>(
            &token,
            &DecodingKey::from_secret(&state.secret),
            &validation,
        )
        .map_err(|_| bad("invalid or expired people cursor"))?
        .claims;
        if cursor.doc != id || cursor.sub != actor || cursor.query != query_hash {
            return Err(bad("people cursor belongs to another search"));
        }
        if cursor.digest != digest || cursor.access_generation != access.generation {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "people search scope changed; restart the search".into(),
            ));
        }
        cursor.offset
    } else {
        0
    };
    let mut people: Vec<_> = snapshot
        .people
        .iter()
        .filter(|person| {
            mentionable(person, actor, &access)
                && (term.is_empty()
                    || person.label.to_lowercase().contains(&term)
                    || person
                        .detail
                        .as_deref()
                        .is_some_and(|v| v.to_lowercase().contains(&term)))
        })
        .collect();
    people.sort_by(|a, b| {
        a.label
            .to_lowercase()
            .cmp(&b.label.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    if offset > people.len() {
        return Err(bad("invalid people cursor offset"));
    }
    let items:Vec<_>=people.iter().skip(offset).take(limit).map(|person|json!({"kind":"person","id":person.id,"label":person.label,"detail":person.detail})).collect();
    let next = offset + items.len();
    let next_cursor = if next < people.len() {
        Some(
            encode(
                &Header::new(Algorithm::HS256),
                &Cursor {
                    doc: id,
                    sub: actor.into(),
                    query: query_hash,
                    digest,
                    access_generation: access.generation,
                    offset: next,
                    exp: now + 120,
                    iss: "hcd-people-cursor/1".into(),
                    aud: "hcd-people".into(),
                },
                &EncodingKey::from_secret(&state.secret),
            )
            .map_err(internal)?,
        )
    } else {
        None
    };
    Ok(Json(
        json!({"schemaVersion":"hcd-mention-options/1","kind":"person","items":items,"nextCursor":next_cursor}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ResolveRequest {
    pub targets: Vec<hcd_core::ReferenceTarget>,
}
pub(super) async fn resolve(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ResolveRequest>,
) -> Result<Json<Value>, ApiError> {
    let identity = claims(&state, &headers, &id)?;
    open(&state, &id)?;
    let actor = identity.sub.as_deref().ok_or_else(|| {
        ApiError(
            StatusCode::FORBIDDEN,
            "reference resolution requires a stable identity".into(),
        )
    })?;
    if request.targets.len() > 100
        || request
            .targets
            .iter()
            .any(|target| !text(&target.id, 256) || !text(&target.kind, 64))
    {
        return Err(bad("invalid reference resolution bounds"));
    }
    let access = load_access(&state, &id)?;
    let (snapshot, _) = load(&state, &id)?;
    let writable = write_allowed(&identity, &access);
    let items:Vec<_>=request.targets.into_iter().map(|target|{
        if target.kind!="person"{return json!({"target":target,"status":"unsupported"})}
        match snapshot.people.iter().find(|person|person.id==target.id).filter(|person|visible(person,actor,&access)){
            Some(person) if person.active=>json!({"target":target,"status":"active","label":person.label,"detail":person.detail,"canMention":writable&&mentionable(person,actor,&access)}),
            Some(_)=>json!({"target":target,"status":"inactive","canMention":false}),
            None=>json!({"target":target,"status":"restricted","canMention":false}),
        }
    }).collect();
    Ok(Json(
        json!({"schemaVersion":"hcd-reference-resolution/1","items":items}),
    ))
}
#[derive(Deserialize)]
pub(super) struct ReferenceQuery {
    pub revision: Option<u64>,
    #[serde(default)]
    pub locations: bool,
}
pub(super) async fn references(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<ReferenceQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let projection = hcd_core::editor_projection(&bundle, query.revision).map_err(hcd_error)?;
    let items = hcd_core::projection_references(&projection).map_err(hcd_error)?;
    let record = bundle.revision(projection.revision).map_err(internal)?;
    let source = reference_source(&record);
    let mut events = if projection.revision == 0 {
        Vec::new()
    } else {
        let before = hcd_core::document_references(&bundle, Some(projection.revision - 1))
            .map_err(hcd_error)?;
        hcd_core::reference_events(
            &id,
            projection.revision,
            &before,
            &items,
            &hcd_core::ReferenceEventContext {
                source: source.into(),
                actor_id: record.author_id.clone(),
                occurred_at_epoch_ms: record.created_at_epoch_ms,
            },
        )
    };
    for event in &mut events {
        if let Some(author) = record.reference_authors.get(&event.mention_id) {
            event.context.actor_id = Some(author.clone());
        } else if record
            .patch_id
            .as_deref()
            .is_some_and(|id| id.starts_with("hcdsave"))
        {
            event.context.actor_id = None;
        }
    }
    let mut item_values = serde_json::to_value(&items).map_err(internal)?;
    if query.locations && !items.is_empty() {
        let locations = hcd_core::document_reference_locations(&bundle, projection.revision)
            .map_err(hcd_error)?;
        for (item, value) in items.iter().zip(
            item_values
                .as_array_mut()
                .ok_or_else(|| internal("invalid reference response"))?,
        ) {
            let location = locations
                .get(&item.reference.mention_id)
                .ok_or_else(|| internal("canonical reference has no immutable location"))?;
            value["chunkSequence"] = json!(location.chunk_sequence);
            value["indexPage"] = json!(location.index_page);
        }
    }
    Ok(Json(
        json!({"schemaVersion":"hcd-references/1","documentId":id,"revision":projection.revision,"items":item_values,"transition":{"fromRevision":projection.revision.checked_sub(1),"source":source,"events":events},"reminders":{"enabled":false,"delivery":"disabled"}}),
    ))
}
pub(super) fn reference_source(record: &hcd_core::RevisionRecord) -> &'static str {
    if record.revision == 0 {
        return "import";
    }
    // A caller may choose a patch ID. Only the core restore operation produces
    // this deterministic hash; a misleading ID alone is never a restore receipt.
    let restored = record.patch_id.as_deref().and_then(|id| {
        let suffix = format!("-{}", record.revision);
        let target = id
            .strip_prefix("restore-")?
            .strip_suffix(&suffix)?
            .parse::<u64>()
            .ok()?;
        let parent = record.parent_revision?;
        let expected = hash_bytes(format!("restore:{target}:{parent}").as_bytes());
        (target < parent && record.patch_hash.as_deref() == Some(expected.as_str())).then_some(())
    });
    if restored.is_some() {
        "restore"
    } else {
        "content"
    }
}

/// Only new/retargeted occurrences need directory authority. Existing offline
/// snapshots remain readable and savable when the directory is unavailable.
pub(super) fn validate_targets(
    state: &ServerState,
    id: &str,
    actor: &str,
    before: &[hcd_core::ReferenceOccurrence],
    after: &[hcd_core::ReferenceOccurrence],
) -> Result<(), ApiError> {
    let old: HashMap<_, _> = before
        .iter()
        .map(|item| (&item.reference.mention_id, &item.reference.target))
        .collect();
    let pending: Vec<_> = after
        .iter()
        .filter(|item| old.get(&item.reference.mention_id).copied() != Some(&item.reference.target))
        .collect();
    if pending.is_empty() {
        return Ok(());
    }
    let (snapshot, _) = load(state, id)?;
    let access = load_access(state, id)?;
    for item in pending {
        if item.reference.target.kind != "person"
            || !snapshot.people.iter().any(|person| {
                person.id == item.reference.target.id && mentionable(person, actor, &access)
            })
        {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "reference target is unavailable for this actor".into(),
            ));
        }
    }
    Ok(())
}
pub(super) fn validate_snapshot(
    state: &ServerState,
    id: &str,
    current: &EditorProjection,
    request: &SnapshotRequest,
) -> Result<(), ApiError> {
    let before = hcd_core::projection_references(current).map_err(hcd_error)?;
    let mut after = Vec::new();
    let mut seen = HashSet::new();
    for block in &request.blocks {
        for occurrence in
            hcd_core::content_references(block.block_id.as_deref().unwrap_or(""), &block.content)
                .map_err(hcd_error)?
        {
            if after.len() >= 10_000 || !seen.insert(occurrence.reference.mention_id.clone()) {
                return Err(bad("duplicate or excessive reference occurrence IDs"));
            }
            after.push(occurrence);
        }
    }
    if request.reference_authors.len() > 10_000 {
        return Err(bad("too many reference authors"));
    }
    let before_extensions = hcd_core::projection_extensions(current).map_err(hcd_error)?;
    let mut extension_ids = HashSet::new();
    for block in &request.blocks {
        for node in hcd_core::content_extensions(&block.content).map_err(hcd_error)? {
            if extension_ids.len() >= 10000 || !extension_ids.insert(node.instance_id) {
                return Err(bad("duplicate or excessive extension identities"));
            }
        }
    }
    if request
        .extension_version
        .is_some_and(|version| version != 1)
        || ((!before_extensions.is_empty() || !extension_ids.is_empty())
            && request.extension_version != Some(1))
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "extension-aware coordinator required; no content was saved".into(),
        ));
    }
    if (request.reference_version.is_some() && request.reference_version != Some(1))
        || ((!before.is_empty() || !after.is_empty()) && request.reference_version != Some(1))
    {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "reference-aware coordinator required; no content was saved".into(),
        ));
    }
    let authors: HashMap<_, _> = request
        .reference_authors
        .iter()
        .map(|v| (&v.mention_id, &v.user_id))
        .collect();
    if authors.len() != request.reference_authors.len() {
        return Err(bad("duplicate reference authors"));
    }
    let old: HashMap<_, _> = before
        .iter()
        .map(|item| (&item.reference.mention_id, &item.reference.target))
        .collect();
    let pending: Vec<_> = after
        .iter()
        .filter(|occurrence| {
            old.get(&occurrence.reference.mention_id).copied() != Some(&occurrence.reference.target)
        })
        .collect();
    let present: HashSet<_> = after
        .iter()
        .map(|item| &item.reference.mention_id)
        .collect();
    let changes: HashSet<_> = pending
        .iter()
        .map(|item| &item.reference.mention_id)
        .chain(
            before
                .iter()
                .filter(|item| !present.contains(&item.reference.mention_id))
                .map(|item| &item.reference.mention_id),
        )
        .collect();
    let contributors: HashSet<_> = request
        .contributors
        .iter()
        .map(|person| &person.user_id)
        .collect();
    if changes.iter().any(|id| !authors.contains_key(*id)) {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "reference transitions require a coordinator-bound author".into(),
        ));
    }
    if authors.iter().any(|(id, author)| {
        !changes.contains(id)
            || !contributors.contains(*author)
            || !super::access_policy::valid_subject(author)
    }) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "reference author is not bound to this transition and contributor".into(),
        ));
    }
    if pending.is_empty() {
        return Ok(());
    }
    let (snapshot, _) = load(state, id)?;
    let access = load_access(state, id)?;
    let index: HashMap<_, _> = snapshot
        .people
        .iter()
        .map(|person| (&person.id, person))
        .collect();
    let contributors: HashSet<_> = request
        .contributors
        .iter()
        .map(|person| &person.user_id)
        .collect();
    for occurrence in pending {
        if old.get(&occurrence.reference.mention_id).copied() != Some(&occurrence.reference.target)
        {
            let author = authors
                .get(&occurrence.reference.mention_id)
                .ok_or_else(|| {
                    ApiError(
                        StatusCode::UPGRADE_REQUIRED,
                        "new references require a coordinator-bound author".into(),
                    )
                })?;
            if !contributors.contains(*author) {
                return Err(ApiError(
                    StatusCode::FORBIDDEN,
                    "reference author is not a checkpoint contributor".into(),
                ));
            }
            if occurrence.reference.target.kind != "person"
                || !index
                    .get(&occurrence.reference.target.id)
                    .is_some_and(|person| mentionable(person, author, &access))
            {
                return Err(ApiError(
                    StatusCode::FORBIDDEN,
                    "reference target is unavailable for this actor".into(),
                ));
            }
        }
    }
    Ok(())
}
