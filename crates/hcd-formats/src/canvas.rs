//! Native Excalidraw import/export. Scene data stays lossless; HTML is a
//! searchable text preview, not an alternative editable canvas representation.
use crate::common::{
    base_manifest, emit_started, finish_import, source_identity, ExportOptions, ImportOptions,
};
use hcd_core::{
    canvas, Bundle, BundleWriter, ChunkSourceMap, FidelityLevel, FidelityReport, HcdError,
    HcdManifest, ImportEvent, HCD_SCHEMA_VERSION,
};
use std::path::Path;

pub(crate) fn import(
    source: &Path,
    output: &Path,
    options: &ImportOptions,
    emit: &mut dyn FnMut(&ImportEvent) -> Result<(), HcdError>,
) -> Result<HcdManifest, HcdError> {
    let (hash, size) = source_identity(source, "excalidraw")?;
    if size > canvas_core_limit() {
        return Err(HcdError::ResourceLimit("canvas exceeds 32 MiB".into()));
    }
    let scene: canvas::Scene = serde_json::from_slice(&std::fs::read(source)?)?;
    emit_started(&mut |e| emit(e), options, &hash)?;
    let mut manifest = base_manifest(options, "excalidraw", "canvas", hash, size);
    manifest.capabilities.text_patch = false;
    manifest.capabilities.annotations = false;
    let mut writer = BundleWriter::create_with_codec(output, options.storage_codec)?;
    writer.write_styles(".hcd-canvas-preview{font-family:system-ui;padding:24px}")?;
    let assets = canvas::store_initial_scene(&writer, &scene)?;
    std::fs::write(
        writer.root().join("assets/index.json"),
        serde_json::to_vec(&assets)?,
    )?;
    writer.write_chunk(
        canvas::chunk_id(&options.document_id),
        "canvas".into(),
        canvas::preview_html(&scene),
        ChunkSourceMap {
            schema_version: HCD_SCHEMA_VERSION.into(),
            chunk_id: canvas::chunk_id(&options.document_id),
            entries: vec![],
        },
        1,
        false,
    )?;
    manifest.fidelity = Some(report());
    finish_import(writer, manifest, &mut |e| emit(e))
}
fn canvas_core_limit() -> u64 {
    32 * 1024 * 1024
}
pub(crate) fn export(
    bundle: &Bundle,
    _source: &Path,
    target: &Path,
    options: &ExportOptions,
) -> Result<FidelityReport, HcdError> {
    let scene = canvas::read_scene(bundle, options.revision)?;
    std::fs::write(target, serde_json::to_vec_pretty(&scene)?)?;
    Ok(report())
}
pub(crate) fn preflight(
    bundle: &Bundle,
    _source: &Path,
    revision: Option<u64>,
) -> Result<(), HcdError> {
    canvas::read_scene(bundle, revision).map(|_| ())
}
fn report() -> FidelityReport {
    FidelityReport {
        schema_version: "hcd-fidelity/1".into(),
        level: FidelityLevel::Exact,
        preserved: vec![
            "Native canvas elements, freehand points, bindings, groups and image assets".into(),
        ],
        flattened: vec![],
        dropped: vec![],
        warnings: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;
    #[test]
    fn native_canvas_history_idempotency_restore_and_archive_share_verified_assets() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("board.excalidraw");
        let drawing = json!({"type":"excalidraw","version":2,"elements":[{"id":"freehand","type":"freedraw","x":0,"y":0,"width":30,"height":40,"points":[[0,0],[30,40]],"pressures":[0.2,0.8]},{"id":"note","type":"text","x":100,"y":0,"width":150,"height":40,"text":"原始想法","fontSize":20}],"appState":{"viewBackgroundColor":"#ffffff"},"files":{}});
        let mut drawing = drawing;
        let image="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO2kAAAAASUVORK5CYII=";
        drawing["files"] =
            json!({"photo":{"id":"photo","mimeType":"image/png","dataURL":image,"created":1}});
        drawing["elements"].as_array_mut().unwrap().push(json!({"id":"image","type":"image","fileId":"photo","x":300,"y":0,"width":80,"height":80}));
        std::fs::write(&source, serde_json::to_vec(&drawing).unwrap()).unwrap();
        let root = tmp.path().join("board.hcd");
        import(
            &source,
            &root,
            &ImportOptions::new("board"),
            &mut |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&root).unwrap();
        let author = BTreeMap::from([
            ("id".into(), "human".into()),
            ("name".into(), "测试用户".into()),
        ]);
        let batch:canvas::Batch=serde_json::from_value(json!({"schemaVersion":canvas::PROTOCOL,"documentId":"board","patchId":"first","baseRevision":0,"operations":[{"op":"element.update","id":"note","before":{"text":"原始想法"},"changes":{"text":"协作修改"}}]})).unwrap();
        let first = canvas::apply_batch(&bundle, &batch, None, &author).unwrap();
        assert_eq!(first.revision, 1);
        let mut next = batch.clone();
        next.patch_id = "second".into();
        next.base_revision = 0;
        next.operations = serde_json::from_value(
            json!([{"op":"element.update","id":"freehand","before":{"x":0},"changes":{"x":80}}]),
        )
        .unwrap();
        assert_eq!(
            canvas::apply_batch(&bundle, &next, None, &author)
                .unwrap()
                .revision,
            2
        );
        assert!(
            canvas::apply_batch(&bundle, &batch, None, &author)
                .unwrap()
                .idempotent_replay
        );
        assert!(canvas::apply_batch(
            &bundle,
            &batch,
            None,
            &BTreeMap::from([("id".into(), "other".into())])
        )
        .is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 2);
        let current = canvas::read_scene(&bundle, None).unwrap();
        assert_eq!(current.elements[0]["pressures"], json!([0.2, 0.8]));
        assert_eq!(current.elements[1]["text"], "协作修改");
        assert_eq!(current.files["photo"]["dataURL"], image);
        let assets = bundle.read_asset_index_for_revision(2).unwrap();
        assert!(
            assets
                .iter()
                .any(|asset| asset.source_part == "canvas/files/photo"
                    && asset.href.ends_with(".png"))
        );
        assert_eq!(
            canvas::read_scene(&bundle, Some(0)).unwrap().elements[1]["text"],
            "原始想法"
        );
        hcd_core::restore_revision(&bundle, 0, 2).unwrap();
        assert_eq!(
            canvas::read_scene(&bundle, None).unwrap().elements[0]["x"],
            0
        );
        let report = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{:?}", report.issues);
        let output = tmp.path().join("export.excalidraw");
        export(
            &bundle,
            &source,
            &output,
            &ExportOptions {
                revision: Some(1),
                fidelity_report: None,
            },
        )
        .unwrap();
        let exported: serde_json::Value =
            serde_json::from_slice(&std::fs::read(output).unwrap()).unwrap();
        assert_eq!(exported["elements"][1]["text"], "协作修改");
        assert_eq!(exported["files"]["photo"]["dataURL"], image);
        let archive = tmp.path().join("portable.hcd");
        hcd_core::pack_archive(&bundle, &archive).unwrap();
        let unpacked = tmp.path().join("unpacked");
        hcd_core::unpack_archive(&archive, &unpacked).unwrap();
        let reopened = Bundle::open(&unpacked).unwrap();
        let historical = canvas::read_scene(&reopened, Some(1)).unwrap();
        assert_eq!(historical.elements[1]["text"], "协作修改");
        assert_eq!(historical.files["photo"]["dataURL"], image);
    }
}
