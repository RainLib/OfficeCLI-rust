//! Server-owned business-node conversion declarations. This is not a promise
//! of whole-document layout fidelity; the exporter still validates the file.
use super::*;

pub(super) async fn options(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    let revision = query
        .revision
        .unwrap_or(bundle.manifest().map_err(internal)?.revision);
    let slot = export_process::reserve_slot()?;
    let features = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        hcd_core::export_feature_inventory(&bundle, revision)
    })
    .await
    .map_err(internal)?
    .map_err(hcd_error)?;
    let features: Vec<_> = features.into_iter().map(|feature| {
        let formats: BTreeMap<_, _> = ["docx", "xlsx", "pptx", "pdf", "html", "md", "txt"].into_iter().map(|format| (format, json!({"support":feature.formats.get(format).map(String::as_str).unwrap_or("static"),"dataRetention":if format == "html" { "embedded" } else { "omitted" }}))).collect();
        json!({"kind":feature.kind,"count":feature.count,"examples":feature.examples,"resourceCount":feature.resource_count,"resourceExamples":feature.resource_examples,"formats":formats,"source":{"support":"unsupported","dataRetention":"omitted"},"nativeBundle":{"support":"native","dataRetention":"native"}})
    }).collect();
    Ok(([(header::CACHE_CONTROL, "private, no-store")], Json(json!({"schemaVersion":"hcd-export-capabilities/1","scope":"business-nodes","documentId":id,"revision":revision,"features":features}))).into_response())
}
