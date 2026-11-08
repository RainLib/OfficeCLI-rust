use clap::{Args, Subcommand, ValueEnum};
use handler_common::{HandlerError, OutputFormat};
use hcd_core::{
    hash_file, manifest_at_revision, render_standalone_html_with_transform, Bundle, FidelityLevel,
    FidelityReport, FidelityWarning, HcdError, HcdManifest, HtmlPresentationOptions, PatchBatch,
    StorageCodec, HCD_SCHEMA_VERSION,
};
use hcd_formats::{ExportOptions, ImportOptions, PdfRasterMode};
use std::collections::HashMap;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

const MAX_SEMANTIC_ASSET_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SEMANTIC_ASSETS_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PREVIEW_STYLESHEET_BYTES: u64 = 1024 * 1024;

#[derive(Args)]
pub struct HdocCommand {
    #[command(subcommand)]
    pub command: HdocSubcommand,
}

#[derive(Subcommand)]
pub enum HdocSubcommand {
    /// Stream a DOCX/XLSX/PPTX/PDF/HTML/Markdown/TXT into an immutable, chunked HCD directory
    Import(HdocImportCommand),
    /// Validate an HCD bundle and all content hashes
    Validate(HdocValidateCommand),
    /// Check XLSX editable cells against the matching original workbook
    #[command(
        after_help = "Example: officecli hdoc audit-xlsx-formulas workbook.hcd --source workbook.xlsx --json\nThe audit does not migrate the document or authorize source-free editing."
    )]
    AuditXlsxFormulas(HdocAuditXlsxFormulasCommand),
    /// Pack a saved revision and its history/resources into one offline .hcdz archive
    Pack(HdocPackCommand),
    /// Verify and unpack an offline .hcdz archive into a new HCD directory
    Unpack(HdocUnpackCommand),
    /// Measure HCD storage, compression, revision growth and unreferenced objects
    Stats(HdocStatsCommand),
    /// List or delete unreferenced immutable objects after checking all revisions
    Gc(HdocGcCommand),
    /// Read one decoded and verified index page from a selected revision
    GetIndexPage(HdocGetIndexPageCommand),
    /// Read one decoded and verified HTML chunk and source map
    GetChunk(HdocGetChunkCommand),
    /// Extract one cursor page of node-local text and source anchors
    ExtractText(HdocExtractTextCommand),
    /// Resolve one current text node by stable HCD nodeId
    GetNode(HdocGetNodeCommand),
    /// Resolve one mapped image node and its asset/geometry state
    GetImage(HdocGetImageCommand),
    /// List mapped image nodes with cursor pagination
    ListImages(HdocListImagesCommand),
    /// List immutable revision records from an append-only HCD history
    ListRevisions(HdocListRevisionsCommand),
    /// Read one immutable HCD revision record
    GetRevision(HdocGetRevisionCommand),
    /// Inspect and optionally copy one verified content-addressed asset
    GetAsset(HdocGetAssetCommand),
    /// Stage a bounded raster image for a later image.replace patch
    PutAsset(HdocPutAssetCommand),
    /// Materialize the current chunk sequence as a standalone inspection HTML file
    RenderHtml(HdocRenderHtmlCommand),
    /// Apply a hash-guarded text, style, annotation, image or structure patch
    Apply(HdocApplyCommand),
    /// Create a revision that enables semantic block editing while preserving the original view
    ProjectEditor(HdocProjectEditorCommand),
    /// Upgrade old PDF coordinates in a new revision without replacing document content or history
    UpgradePdfLayout(HdocUpgradePdfLayoutCommand),
    /// Read bounded semantic blocks and precondition hashes for an editor
    EditorState(HdocEditorStateCommand),
    /// Serve authorized HCD document, revision and edit APIs
    Serve(HdocServeCommand),
    /// Issue a short-lived document-scoped token for a caller or local test
    IssueToken(HdocIssueTokenCommand),
    /// Restore historical content as a new immutable revision
    Restore(HdocRestoreCommand),
    /// Export one HCD revision by source-backed rewrite or pure-Rust semantic conversion
    Export(HdocExportCommand),
}

#[derive(Args)]
pub struct HdocUpgradePdfLayoutCommand {
    pub bundle: String,
    /// Immutable source PDF; its SHA-256 must match the bundle
    #[arg(long)]
    pub source: PathBuf,
    #[arg(long)]
    pub expected_revision: u64,
}

#[derive(Args)]
pub struct HdocImportCommand {
    /// Preserve Word sections/stories for preview region editing (DOCX only)
    #[arg(long)]
    pub word_regions: bool,
    /// Immutable source DOCX, XLSX, PPTX, PDF, HTML, UTF-8 Markdown, or UTF-8 TXT
    pub source: String,
    /// New HCD directory; must not already exist
    #[arg(short, long)]
    pub output: String,
    /// Stable business document id; derived from the immutable source SHA-256 when omitted
    #[arg(long)]
    pub document_id: Option<String>,
    /// Emit import_started/chunk_ready/asset_ready/completed as NDJSON
    #[arg(long, value_name = "ndjson")]
    pub events: Option<String>,
    /// Soft HTML chunk byte limit
    #[arg(long, default_value_t = hcd_core::DEFAULT_CHUNK_SOFT_BYTES)]
    pub chunk_bytes: usize,
    /// Maximum top-level blocks per ordinary chunk
    #[arg(long, default_value_t = hcd_core::DEFAULT_CHUNK_BLOCKS)]
    pub chunk_blocks: usize,
    /// Encoding for HCD text objects; gzip saves space while keeping random-access chunks
    #[arg(long, value_enum, default_value_t = HdocStorageCodec::Gzip)]
    pub storage_codec: HdocStorageCodec,
    /// PDF page preview encoding; auto uses JPEG only when it passes a visual quality gate
    #[arg(long, value_enum, default_value_t = HdocPdfRasterMode::Auto)]
    pub pdf_raster_mode: HdocPdfRasterMode,
    /// JPEG quality for PDF auto/lossy raster modes (70-100)
    #[arg(long, default_value_t = 92, value_parser = clap::value_parser!(u8).range(70..=100))]
    pub pdf_raster_quality: u8,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum HdocStorageCodec {
    Gzip,
    None,
}

#[derive(Debug, Clone, Copy, ValueEnum, PartialEq, Eq)]
pub enum HdocPdfRasterMode {
    Auto,
    Lossless,
    Lossy,
}

#[derive(Args)]
pub struct HdocValidateCommand {
    pub bundle: String,
}

/// Check the current saved XLSX mapping without changing the document.
///
/// This does not migrate the document or authorize source-free edits.
/// Example: officecli hdoc audit-xlsx-formulas workbook.hcd --source workbook.xlsx --json
#[derive(Args)]
pub struct HdocAuditXlsxFormulasCommand {
    /// Saved HCD directory to check
    pub bundle: PathBuf,
    /// Original XLSX; its SHA-256 and size must match the HCD source
    #[arg(long)]
    pub source: PathBuf,
}

#[derive(Args)]
pub struct HdocPackCommand {
    pub bundle: PathBuf,
    #[arg(short, long)]
    pub output: PathBuf,
    /// Include this saved head and all its ancestors; defaults to the current head
    #[arg(long)]
    pub revision: Option<u64>,
}
#[derive(Args)]
pub struct HdocUnpackCommand {
    pub archive: PathBuf,
    #[arg(short, long)]
    pub output: PathBuf,
}

#[derive(Args)]
pub struct HdocStatsCommand {
    pub bundle: String,
}

#[derive(Args)]
pub struct HdocGcCommand {
    pub bundle: String,
    /// Delete verified unreferenced objects; omitted means dry run
    #[arg(long)]
    pub delete: bool,
}

#[derive(Args)]
pub struct HdocGetIndexPageCommand {
    pub bundle: String,
    /// Zero-based index page number
    pub page: usize,
    /// Revision to read; defaults to the current head
    #[arg(long)]
    pub revision: Option<u64>,
}

#[derive(Args)]
pub struct HdocGetChunkCommand {
    pub bundle: String,
    /// Zero-based chunk sequence number
    pub sequence: usize,
    /// Revision to read; defaults to the current head
    #[arg(long)]
    pub revision: Option<u64>,
}

#[derive(Args)]
pub struct HdocExtractTextCommand {
    pub bundle: String,
    #[arg(long)]
    pub cursor: Option<String>,
    #[arg(long, default_value_t = 1000)]
    pub limit: usize,
}

#[derive(Args)]
pub struct HdocGetNodeCommand {
    pub bundle: String,
    /// Stable canonical text node ID (`n_` followed by 32 lowercase hex digits)
    pub node_id: String,
}

#[derive(Args)]
pub struct HdocGetImageCommand {
    pub bundle: String,
    /// Stable mapped image node ID (`n_` followed by 32 lowercase hex digits)
    pub node_id: String,
}

#[derive(Args)]
pub struct HdocListImagesCommand {
    pub bundle: String,
    /// Opaque cursor returned by a previous page
    #[arg(long)]
    pub cursor: Option<String>,
    /// Maximum image nodes to return
    #[arg(long, default_value_t = 100)]
    pub limit: usize,
}

#[derive(Args)]
pub struct HdocListRevisionsCommand {
    pub bundle: String,
    /// First revision number to return
    #[arg(long, default_value_t = 0)]
    pub cursor: u64,
    /// Maximum revision records to return (1-1000)
    #[arg(long, default_value_t = 100)]
    pub limit: usize,
}

#[derive(Args)]
pub struct HdocGetRevisionCommand {
    pub bundle: String,
    /// Immutable revision number
    pub revision: u64,
}

#[derive(Args)]
pub struct HdocGetAssetCommand {
    pub bundle: String,
    /// Lowercase SHA-256 from assets/index.json
    pub hash: String,
    /// Asset index revision; defaults to the current head
    #[arg(long)]
    pub revision: Option<u64>,
    /// Optional destination for a verified copy; must not already exist
    #[arg(short, long)]
    pub output: Option<PathBuf>,
}

#[derive(Args)]
pub struct HdocPutAssetCommand {
    pub bundle: String,
    /// PNG, JPEG, GIF, or WebP image to stage (maximum 64 MiB)
    pub image: PathBuf,
}

#[derive(Args)]
pub struct HdocRenderHtmlCommand {
    pub bundle: String,
    /// Standalone HTML output path; written incrementally without a full-document buffer
    #[arg(short, long)]
    pub output: String,
    /// Revision to render; defaults to the current head
    #[arg(long)]
    pub revision: Option<u64>,
    /// Zero-based first HCD chunk to include
    #[arg(long, default_value_t = 0)]
    pub chunk_start: usize,
    /// Maximum number of consecutive chunks to include; omitted means all remaining chunks
    #[arg(long)]
    pub chunk_limit: Option<usize>,
    /// Text-node hover-outline state in the generated preview
    #[arg(long, value_enum, default_value_t = HdocHitboxState::On)]
    pub text_hitboxes: HdocHitboxState,
    /// Image/form-node hover-outline state in the generated preview
    #[arg(long, value_enum, default_value_t = HdocHitboxState::On)]
    pub image_hitboxes: HdocHitboxState,
    /// CSS file appended after HCD styles; preview-only and excluded from HCD hashes
    #[arg(long, value_name = "CSS_FILE")]
    pub style: Option<PathBuf>,
    /// Optional PNG screenshot of the rendered HCD page for visual regression review
    #[arg(long, value_name = "PNG_FILE")]
    pub screenshot: Option<PathBuf>,
    /// Screenshot viewport width (capped by the screenshot backend)
    #[arg(long, default_value_t = 1600)]
    pub screenshot_width: u32,
    /// Screenshot viewport height (capped by the screenshot backend)
    #[arg(long, default_value_t = 1200)]
    pub screenshot_height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum HdocHitboxState {
    On,
    Off,
}

#[derive(Args)]
pub struct HdocApplyCommand {
    pub bundle: String,
    /// Patch JSON path, or '-' for stdin
    #[arg(long)]
    pub patch: String,
    #[arg(long)]
    pub expected_revision: u64,
    /// Original XLSX used to protect formula cells during text edits
    #[arg(long)]
    pub source: Option<PathBuf>,
}

#[derive(Args)]
pub struct HdocProjectEditorCommand {
    /// Upgrade an opted-in Word layout to canonical regions (preview; browser editing unavailable)
    #[arg(long)]
    pub word_regions: bool,
    pub bundle: String,
    #[arg(long)]
    pub expected_revision: u64,
}

#[derive(Args)]
pub struct HdocEditorStateCommand {
    pub bundle: String,
    #[arg(long)]
    pub revision: Option<u64>,
}

#[derive(Args)]
pub struct HdocServeCommand {
    /// Directory containing one <documentId>.hcd bundle per document
    #[arg(long)]
    pub root: PathBuf,
    #[arg(long, default_value = "127.0.0.1:8766")]
    pub bind: String,
    /// Environment variable holding the JWT HMAC secret (at least 32 bytes)
    #[arg(long, default_value = "HCD_TOKEN_SECRET")]
    pub secret_env: String,
    /// PostgreSQL connection URL environment variable; enables durable metadata when set with S3 bucket
    #[arg(long, default_value = "HCD_DATABASE_URL")]
    pub database_url_env: String,
    /// Private S3-compatible bucket environment variable
    #[arg(long, default_value = "HCD_S3_BUCKET")]
    pub s3_bucket_env: String,
    /// Optional S3-compatible endpoint environment variable
    #[arg(long, default_value = "HCD_S3_ENDPOINT")]
    pub s3_endpoint_env: String,
}

#[derive(Args)]
pub struct HdocIssueTokenCommand {
    #[arg(long)]
    pub document_id: String,
    #[arg(long, value_enum)]
    pub scope: HdocTokenScope,
    /// Stable caller user ID for collaboration presence
    #[arg(long)]
    pub user_id: Option<String>,
    /// Name shown above the user's collaborative caret
    #[arg(long)]
    pub display_name: Option<String>,
    #[arg(long, default_value_t = 900, value_parser = clap::value_parser!(u64).range(1..=3600))]
    pub ttl_seconds: u64,
    #[arg(long, default_value = "HCD_TOKEN_SECRET")]
    pub secret_env: String,
}

#[derive(Args)]
pub struct HdocRestoreCommand {
    pub bundle: String,
    #[arg(long)]
    pub revision: u64,
    #[arg(long)]
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum HdocTokenScope {
    /// Policy management only; does not grant document read/write access.
    Manage,
    Read,
    Write,
    Upload,
}

#[derive(Args)]
pub struct HdocExportCommand {
    pub bundle: String,
    /// Immutable source for same-format source-backed EXACT/HIGH export. Omit for semantic export.
    #[arg(long)]
    pub source: Option<String>,
    /// Verified original DOCX supplying language-font metadata for legacy semantic export
    #[arg(long)]
    pub typography_source: Option<String>,
    #[arg(short, long)]
    pub output: String,
    /// Semantic target format; inferred from --output when omitted
    #[arg(long, value_name = "docx|xlsx|pptx|pdf|html|md|txt")]
    pub to: Option<String>,
    #[arg(long)]
    pub revision: Option<u64>,
    #[arg(long)]
    pub fidelity_report: Option<PathBuf>,
}

pub fn handle_hdoc(
    command: HdocCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    match command.command {
        HdocSubcommand::Import(command) => import(command, format),
        HdocSubcommand::Validate(command) => validate(command, format),
        HdocSubcommand::AuditXlsxFormulas(command) => audit_xlsx_formulas(command, format),
        HdocSubcommand::Pack(command) => {
            let bundle = Bundle::open(command.bundle).map_err(handler_error)?;
            let result = super::hdoc_archive::pack(&bundle, &command.output, command.revision)?;
            render(
                &result,
                format,
                format!("Packed offline document at r{}", result.revision),
            )
        }
        HdocSubcommand::Unpack(command) => {
            let result = super::hdoc_archive::unpack(&command.archive, &command.output)?;
            render(
                &result,
                format,
                format!("Unpacked verified offline document at r{}", result.revision),
            )
        }
        HdocSubcommand::Stats(command) => stats(command, format),
        HdocSubcommand::Gc(command) => gc(command, format),
        HdocSubcommand::GetIndexPage(command) => get_index_page(command, format),
        HdocSubcommand::GetChunk(command) => get_chunk(command, format),
        HdocSubcommand::ExtractText(command) => extract_text(command, format),
        HdocSubcommand::GetNode(command) => get_node(command, format),
        HdocSubcommand::GetImage(command) => get_image(command, format),
        HdocSubcommand::ListImages(command) => list_images(command, format),
        HdocSubcommand::ListRevisions(command) => list_revisions(command, format),
        HdocSubcommand::GetRevision(command) => get_revision(command, format),
        HdocSubcommand::GetAsset(command) => get_asset(command, format),
        HdocSubcommand::PutAsset(command) => put_asset(command, format),
        HdocSubcommand::RenderHtml(command) => render_html(command, format),
        HdocSubcommand::Apply(command) => apply(command, format),
        HdocSubcommand::ProjectEditor(command) => project_editor(command, format),
        HdocSubcommand::EditorState(command) => editor_state(command, format),
        HdocSubcommand::Serve(command) => {
            let runtime = tokio::runtime::Runtime::new()
                .map_err(|error| HandlerError::OperationFailed(error.to_string()))?;
            runtime
                .block_on(crate::hdoc_server::serve(command))
                .map_err(|error| HandlerError::OperationFailed(error.to_string()))?;
            Ok(("HCD server stopped".to_string(), true))
        }
        HdocSubcommand::UpgradePdfLayout(command) => {
            let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
            let result = hcd_formats::upgrade_pdf_layout(
                &bundle,
                &command.source,
                command.expected_revision,
                Default::default(),
            )
            .map_err(handler_error)?;
            let revision = result
                .as_ref()
                .map_or(command.expected_revision, |result| result.revision);
            render(
                &serde_json::json!({"upgraded":result.is_some(),"revision":revision}),
                format,
                format!("PDF layout ready at revision {revision}"),
            )
        }
        HdocSubcommand::IssueToken(command) => {
            let token = crate::hdoc_server::issue_token(&command)
                .map_err(|error| HandlerError::OperationFailed(error.to_string()))?;
            render(&serde_json::json!({"token": token}), format, token)
        }
        HdocSubcommand::Restore(command) => {
            let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
            let result = hcd_core::restore_revision(
                &bundle,
                command.revision,
                command.expected_revision,
                None,
                None,
            )
            .map_err(handler_error)?;
            render(
                &result,
                format,
                format!(
                    "Restored revision {} as revision {}",
                    command.revision, result.revision
                ),
            )
        }
        HdocSubcommand::Export(command) => export(command, format),
    }
}

fn import(
    command: HdocImportCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    let events = command.events.as_deref();
    if events.is_some_and(|value| value != "ndjson") {
        return Err(HandlerError::InvalidArgument(
            "--events currently accepts only 'ndjson'".to_string(),
        ));
    }
    if events.is_some() && format == OutputFormat::Json {
        return Err(HandlerError::InvalidArgument(
            "--events ndjson cannot be combined with global --json".to_string(),
        ));
    }
    let document_id = match command.document_id {
        Some(document_id) => document_id,
        None => deterministic_document_id(&command.source)?,
    };
    let mut options = ImportOptions::new(document_id);
    options.word_regions = command.word_regions;
    options.chunk_soft_bytes = command.chunk_bytes;
    options.chunk_blocks = command.chunk_blocks;
    options.storage_codec = match command.storage_codec {
        HdocStorageCodec::Gzip => StorageCodec::Gzip,
        HdocStorageCodec::None => StorageCodec::None,
    };
    options.pdf_raster_mode = match command.pdf_raster_mode {
        HdocPdfRasterMode::Auto => PdfRasterMode::Auto,
        HdocPdfRasterMode::Lossless => PdfRasterMode::Lossless,
        HdocPdfRasterMode::Lossy => PdfRasterMode::Lossy,
    };
    options.pdf_raster_quality = command.pdf_raster_quality;
    let manifest =
        hcd_formats::import_document(&command.source, &command.output, &options, |event| {
            if events.is_some() {
                println!("{}", serde_json::to_string(event).map_err(HcdError::from)?);
            }
            Ok(())
        })
        .map_err(handler_error)?;
    if events.is_some() {
        Ok((String::new(), true))
    } else {
        render(
            &manifest,
            format,
            format!(
                "Imported {} as {} chunks at revision 0",
                command.source, manifest.chunk_count
            ),
        )
    }
}

fn audit_xlsx_formulas(
    command: HdocAuditXlsxFormulasCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    let bundle = Bundle::open(command.bundle).map_err(handler_error)?;
    // Snapshot under the bundle lock so the audit sees one saved head even
    // while another process continues editing the live document.
    let snapshot = hcd_core::create_portable_snapshot(&bundle, None).map_err(handler_error)?;
    let frozen = Bundle::open(snapshot.directory.path()).map_err(handler_error)?;
    let count = hcd_formats::audit_xlsx_editable_formula_map(&frozen, &command.source)
        .map_err(handler_error)?;
    let data = serde_json::json!({
        "documentId": snapshot.manifest.document_id,
        "revision": snapshot.manifest.revision,
        "editableCellsChecked": count,
        "sourceFreeEditsAuthorized": false,
    });
    render(
        &data,
        format,
        format!("Checked {count} editable cells at r{}; no migration or source-free authorization was performed", snapshot.manifest.revision),
    )
}

fn validate(
    command: HdocValidateCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    let report = hcd_core::validate_bundle(&bundle).map_err(handler_error)?;
    let valid = report.valid;
    if format == OutputFormat::Json {
        return Ok((
            crate::commands::json_data_envelope(serde_json::to_value(&report)?, valid),
            valid,
        ));
    }
    render(
        &report,
        format,
        if valid {
            "HCD validation passed".to_string()
        } else {
            format!(
                "HCD validation failed with {} issue(s)",
                report.issues.len()
            )
        },
    )
    .map(|(output, _)| (output, valid))
}

fn stats(command: HdocStatsCommand, format: OutputFormat) -> Result<(String, bool), HandlerError> {
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    let stats = hcd_core::bundle_stats(&bundle).map_err(handler_error)?;
    render(
        &stats,
        format,
        format!(
            "HCD uses {} bytes; {} orphan object(s) use {} bytes",
            stats.total_stored_bytes,
            stats.orphan_hrefs.len(),
            stats.orphan_stored_bytes
        ),
    )
}

fn gc(command: HdocGcCommand, format: OutputFormat) -> Result<(String, bool), HandlerError> {
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    let before = hcd_core::bundle_stats(&bundle).map_err(handler_error)?;
    if command.delete {
        hcd_core::remove_orphan_objects(&bundle).map_err(handler_error)?;
    }
    let result = serde_json::json!({
        "deleted": command.delete,
        "orphanCount": before.orphan_hrefs.len(),
        "orphanBytes": before.orphan_stored_bytes,
        "orphanHrefs": before.orphan_hrefs,
    });
    render(
        &result,
        format,
        if command.delete {
            format!(
                "Deleted {} unreferenced HCD object(s)",
                result["orphanCount"]
            )
        } else {
            format!(
                "Dry run: {} unreferenced HCD object(s)",
                result["orphanCount"]
            )
        },
    )
}

fn get_index_page(
    command: HdocGetIndexPageCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    let head = bundle.manifest().map_err(handler_error)?;
    let (manifest, revision) =
        manifest_at_revision(&bundle, &head, command.revision).map_err(handler_error)?;
    let page = bundle
        .read_index_page(&manifest, command.page)
        .map_err(handler_error)?;
    if page.page != command.page || page.revision > revision {
        return Err(HandlerError::ValidationError(format!(
            "index page {} does not belong to revision {revision}",
            command.page
        )));
    }
    let result = serde_json::json!({"requestedRevision": revision, "indexPage": page});
    render(
        &result,
        format,
        format!(
            "Index page {} contains {} chunk(s)",
            command.page,
            page.chunks.len()
        ),
    )
}

fn get_chunk(
    command: HdocGetChunkCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    let head = bundle.manifest().map_err(handler_error)?;
    let (manifest, revision) =
        manifest_at_revision(&bundle, &head, command.revision).map_err(handler_error)?;
    if command.sequence >= manifest.chunk_count {
        return Err(HandlerError::InvalidArgument(format!(
            "chunk sequence {} exceeds revision {revision} chunk count {}",
            command.sequence, manifest.chunk_count
        )));
    }
    let page = bundle
        .read_index_page(&manifest, command.sequence / hcd_core::INDEX_PAGE_SIZE)
        .map_err(handler_error)?;
    let descriptor = page
        .chunks
        .into_iter()
        .find(|chunk| chunk.sequence == command.sequence)
        .ok_or_else(|| {
            HandlerError::ValidationError(format!(
                "index page is missing chunk sequence {}",
                command.sequence
            ))
        })?;
    let html = bundle
        .read_chunk_verified(&descriptor)
        .map_err(handler_error)?;
    let map = bundle
        .read_map_verified(&descriptor)
        .map_err(handler_error)?;
    if map.chunk_id != descriptor.chunk_id {
        return Err(HandlerError::ValidationError(format!(
            "source map does not belong to chunk {}",
            descriptor.chunk_id
        )));
    }
    let result = serde_json::json!({
        "revision": revision,
        "descriptor": descriptor,
        "html": html,
        "map": map,
    });
    render(&result, format, html)
}

fn extract_text(
    command: HdocExtractTextCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    let page = hcd_core::extract_text_page(&bundle, command.cursor.as_deref(), command.limit)
        .map_err(handler_error)?;
    let text = page
        .entries
        .iter()
        .map(|entry| entry.text.as_str())
        .collect::<Vec<_>>()
        .join("");
    render(&page, format, text)
}

fn get_node(
    command: HdocGetNodeCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    let node = hcd_core::get_text_node(&bundle, &command.node_id).map_err(handler_error)?;
    let text = node.node.text.clone();
    render(&node, format, text)
}

fn get_image(
    command: HdocGetImageCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    let image = hcd_core::get_image_node(&bundle, &command.node_id).map_err(handler_error)?;
    let text = format!(
        "{} asset={} visualHash={}",
        image.node.node_id,
        image.node.asset_hash.as_deref().unwrap_or("none"),
        image.node.visual_hash
    );
    render(&image, format, text)
}

fn list_images(
    command: HdocListImagesCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    if !(1..=10_000).contains(&command.limit) {
        return Err(HandlerError::InvalidArgument(
            "--limit must be between 1 and 10000".to_string(),
        ));
    }
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    let page = hcd_core::extract_image_page(&bundle, command.cursor.as_deref(), command.limit)
        .map_err(handler_error)?;
    let text = if page.entries.is_empty() {
        "No mapped image nodes".to_string()
    } else {
        page.entries
            .iter()
            .map(|entry| {
                format!(
                    "{} asset={} visualHash={}",
                    entry.node.node_id,
                    entry.node.asset_hash.as_deref().unwrap_or("none"),
                    entry.node.visual_hash
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    render(&page, format, text)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RevisionPage {
    document_id: String,
    head_revision: u64,
    revisions: Vec<hcd_core::RevisionRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<u64>,
}

fn list_revisions(
    command: HdocListRevisionsCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    if !(1..=1000).contains(&command.limit) {
        return Err(HandlerError::InvalidArgument(
            "--limit must be between 1 and 1000".to_string(),
        ));
    }
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    let manifest = bundle.manifest().map_err(handler_error)?;
    let terminal = manifest.revision.checked_add(1).ok_or_else(|| {
        HandlerError::InvalidArgument("head revision cannot be incremented".to_string())
    })?;
    if command.cursor > terminal {
        return Err(HandlerError::InvalidArgument(format!(
            "--cursor {} is beyond head revision {}",
            command.cursor, manifest.revision
        )));
    }
    let end = command
        .cursor
        .saturating_add(command.limit as u64)
        .min(terminal);
    let mut revisions = Vec::with_capacity((end - command.cursor) as usize);
    for revision in command.cursor..end {
        revisions.push(bundle.revision(revision).map_err(handler_error)?);
    }
    let next_cursor = (end < terminal).then_some(end);
    let text = if revisions.is_empty() {
        format!("No revisions at or after {}", command.cursor)
    } else {
        revisions
            .iter()
            .map(|record| {
                format!(
                    "revision {} parent={} patch={} root={}",
                    record.revision,
                    record
                        .parent_revision
                        .map_or_else(|| "none".to_string(), |value| value.to_string()),
                    record.patch_id.as_deref().unwrap_or("none"),
                    record.root_hash
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    render(
        &RevisionPage {
            document_id: manifest.document_id,
            head_revision: manifest.revision,
            revisions,
            next_cursor,
        },
        format,
        text,
    )
}

fn get_revision(
    command: HdocGetRevisionCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    let manifest = bundle.manifest().map_err(handler_error)?;
    if command.revision > manifest.revision {
        return Err(HandlerError::InvalidArgument(format!(
            "revision {} is ahead of head {}",
            command.revision, manifest.revision
        )));
    }
    let record = bundle.revision(command.revision).map_err(handler_error)?;
    let text = serde_json::to_string_pretty(&record)?;
    render(&record, format, text)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetReadResult {
    asset: hcd_core::AssetDescriptor,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<PathBuf>,
}

fn get_asset(
    command: HdocGetAssetCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    if command.hash.len() != 64
        || !command
            .hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(HandlerError::InvalidArgument(
            "asset hash must be a 64-character lowercase SHA-256 digest".to_string(),
        ));
    }
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    let head = bundle.manifest().map_err(handler_error)?.revision;
    let revision = command.revision.unwrap_or(head);
    if revision > head {
        return Err(HandlerError::InvalidArgument(format!(
            "revision {revision} is ahead of head {head}"
        )));
    }
    let asset = bundle
        .read_asset_index_for_revision(revision)
        .map_err(handler_error)?
        .into_iter()
        .find(|asset| asset.hash == command.hash)
        .ok_or_else(|| HandlerError::PathNotFound(format!("asset {}", command.hash)))?;
    let source = bundle.resolve_href(&asset.href).map_err(handler_error)?;
    let metadata = std::fs::metadata(&source)?;
    if metadata.len() != asset.byte_length {
        return Err(HandlerError::ValidationError(format!(
            "asset {} expected {} bytes, found {}",
            asset.hash,
            asset.byte_length,
            metadata.len()
        )));
    }
    let actual_hash = hash_file(&source).map_err(handler_error)?;
    if actual_hash != asset.hash {
        return Err(HandlerError::ValidationError(format!(
            "asset {} content hash is {}",
            asset.hash, actual_hash
        )));
    }
    if let Some(output) = command.output.as_deref() {
        if output.exists() {
            return Err(HandlerError::InvalidArgument(format!(
                "asset output already exists: {}",
                output.display()
            )));
        }
        let parent = output
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent)?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".officecli-hcd-asset-")
            .tempfile_in(parent)?;
        let mut input = std::fs::File::open(&source)?;
        std::io::copy(&mut input, temporary.as_file_mut())?;
        temporary.as_file_mut().flush()?;
        temporary.persist(output).map_err(|error| error.error)?;
    }
    let text = match command.output.as_deref() {
        Some(output) => format!(
            "Copied asset {} ({} bytes) to {}",
            asset.hash,
            asset.byte_length,
            output.display()
        ),
        None => format!(
            "asset {} {} bytes {}",
            asset.hash, asset.byte_length, asset.href
        ),
    };
    render(
        &AssetReadResult {
            asset,
            output: command.output,
        },
        format,
        text,
    )
}

fn put_asset(
    command: HdocPutAssetCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    let extension = command
        .image
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| {
            HandlerError::InvalidArgument("staged image must have an extension".to_string())
        })?;
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
        return Err(HandlerError::InvalidArgument(
            "staged image must be PNG, JPEG, GIF, or WebP".to_string(),
        ));
    }
    let metadata = std::fs::metadata(&command.image)?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(HandlerError::InvalidArgument(format!(
            "staged image is not a non-empty regular file: {}",
            command.image.display()
        )));
    }
    if metadata.len() > hcd_core::MAX_STAGED_ASSET_BYTES {
        return Err(HandlerError::InvalidArgument(format!(
            "staged image is {} bytes; maximum is {}",
            metadata.len(),
            hcd_core::MAX_STAGED_ASSET_BYTES
        )));
    }
    let mut header = [0u8; 12];
    let mut input = std::fs::File::open(&command.image)?;
    let count = input.read(&mut header)?;
    let valid_magic = match extension.as_str() {
        "png" => count >= 8 && header[..8] == [137, 80, 78, 71, 13, 10, 26, 10],
        "jpg" | "jpeg" => count >= 3 && header[..3] == [0xff, 0xd8, 0xff],
        "gif" => count >= 6 && matches!(&header[..6], b"GIF87a" | b"GIF89a"),
        "webp" => count >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP",
        _ => false,
    };
    if !valid_magic {
        return Err(HandlerError::InvalidArgument(format!(
            "{} content does not match its .{extension} image extension",
            command.image.display()
        )));
    }
    input.rewind()?;
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    let descriptor = bundle
        .stage_asset_from_reader(&extension, &mut input)
        .map_err(handler_error)?;
    let text = format!(
        "Staged image {} ({} bytes); reference this hash from image.replace",
        descriptor.hash, descriptor.byte_length
    );
    render(&descriptor, format, text)
}

fn render_html(
    command: HdocRenderHtmlCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    if command.chunk_limit.is_none() {
        let validation = hcd_core::validate_bundle(&bundle).map_err(handler_error)?;
        if !validation.valid {
            return Err(HandlerError::ValidationError(format!(
                "cannot render an invalid HCD bundle with {} issue(s)",
                validation.issues.len()
            )));
        }
    }
    let output = Path::new(&command.output);
    let style_path = command.style.clone();
    let override_stylesheet = command
        .style
        .as_deref()
        .map(read_preview_stylesheet)
        .transpose()?;
    let parent = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let asset_base_href = relative_directory_href(parent, bundle.root())?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".officecli-hcd-preview-")
        .suffix(".html")
        .tempfile_in(parent)?;
    let report = render_standalone_html_with_transform(
        &bundle,
        &HtmlPresentationOptions {
            revision: command.revision,
            chunk_start: command.chunk_start,
            chunk_limit: command.chunk_limit,
            asset_base_href: Some(asset_base_href),
            text_hitboxes_enabled: command.text_hitboxes == HdocHitboxState::On,
            image_hitboxes_enabled: command.image_hitboxes == HdocHitboxState::On,
            override_stylesheet,
            ..HtmlPresentationOptions::default()
        },
        temporary.as_file_mut(),
        hcd_formats::enhance_presentation_fragment,
    )
    .map_err(handler_error)?;
    temporary.as_file_mut().flush()?;
    temporary.persist(output).map_err(|error| error.error)?;
    let screenshot = command
        .screenshot
        .as_deref()
        .map(|screenshot| {
            crate::screenshot::capture(
                &output.to_string_lossy(),
                &screenshot.to_string_lossy(),
                command.screenshot_width,
                command.screenshot_height,
            )
            .map(|result| {
                serde_json::json!({
                    "output": result.output_path,
                    "backend": result.backend,
                    "width": command.screenshot_width,
                    "height": command.screenshot_height,
                })
            })
            .map_err(HandlerError::OperationFailed)
        })
        .transpose()?;
    let result = serde_json::json!({
        "documentId": report.document_id,
        "revision": report.revision,
        "profile": report.profile,
        "firstChunk": report.first_chunk,
        "chunkCount": report.chunk_count,
        "totalChunkCount": report.total_chunk_count,
        "nextChunk": report.next_chunk,
        "bytes": report.bytes_written,
        "output": output,
        "style": style_path,
        "screenshot": screenshot,
    });
    render(
        &result,
        format,
        format!(
            "Rendered HCD revision {} as {} chunks to {}",
            report.revision,
            report.chunk_count,
            output.display()
        ),
    )
}

fn read_preview_stylesheet(path: &Path) -> Result<String, HandlerError> {
    let file = std::fs::File::open(path)?;
    let mut bytes = Vec::with_capacity(MAX_PREVIEW_STYLESHEET_BYTES.min(64 * 1024) as usize);
    file.take(MAX_PREVIEW_STYLESHEET_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_PREVIEW_STYLESHEET_BYTES {
        return Err(HandlerError::InvalidArgument(format!(
            "preview stylesheet {} exceeds the {MAX_PREVIEW_STYLESHEET_BYTES} byte limit",
            path.display()
        )));
    }
    let stylesheet = String::from_utf8(bytes).map_err(|error| {
        HandlerError::InvalidArgument(format!(
            "preview stylesheet {} is not UTF-8: {error}",
            path.display()
        ))
    })?;
    hcd_core::validate_css_text(&stylesheet).map_err(|error| {
        HandlerError::InvalidArgument(format!(
            "preview stylesheet {} is unsafe: {error}",
            path.display()
        ))
    })?;
    Ok(stylesheet)
}

fn relative_directory_href(from: &Path, to: &Path) -> Result<String, HandlerError> {
    let from = std::fs::canonicalize(from)?;
    let to = std::fs::canonicalize(to)?;
    let from_components = from.components().collect::<Vec<_>>();
    let to_components = to.components().collect::<Vec<_>>();
    let common = from_components
        .iter()
        .zip(&to_components)
        .take_while(|(left, right)| left == right)
        .count();
    if common == 0 {
        return Err(HandlerError::InvalidArgument(format!(
            "preview output and HCD bundle do not share a filesystem root: {} and {}",
            from.display(),
            to.display()
        )));
    }
    let mut parts = vec!["..".to_string(); from_components.len() - common];
    parts.extend(
        to_components[common..].iter().map(|component| {
            percent_encode_href_component(&component.as_os_str().to_string_lossy())
        }),
    );
    let mut href = if parts.is_empty() {
        "./".to_string()
    } else {
        format!("{}/", parts.join("/"))
    };
    if href == "/" {
        href = "./".to_string();
    }
    Ok(href)
}

fn percent_encode_href_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(*byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn deterministic_document_id(source: &str) -> Result<String, HandlerError> {
    let source_hash = hash_file(source).map_err(handler_error)?;
    Ok(format!("doc-{}", &source_hash[..32]))
}

fn apply(command: HdocApplyCommand, format: OutputFormat) -> Result<(String, bool), HandlerError> {
    let patch_json = read_patch_json(&command.patch)?;
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    let header: serde_json::Value = serde_json::from_str(&patch_json)?;
    let result = if header["schemaVersion"] == hcd_core::HCD_PATCH_SCHEMA_VERSION_6 {
        let patch: hcd_core::FlowStructurePatchBatch = serde_json::from_str(&patch_json)?;
        hcd_core::apply_flow_structure_patch(&bundle, &patch, command.expected_revision)
    } else if header["schemaVersion"] == hcd_core::HCD_PATCH_SCHEMA_VERSION_4 {
        let patch: hcd_core::StructurePatchBatch = serde_json::from_str(&patch_json)?;
        hcd_core::apply_structure_patch(&bundle, &patch, command.expected_revision)
    } else {
        let patch: PatchBatch = serde_json::from_str(&patch_json)?;
        let manifest = bundle.manifest().map_err(handler_error)?;
        if manifest.source.format == "xlsx" {
            let default_source = std::path::Path::new(&command.bundle)
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .join("sources")
                .join(format!("{}.xlsx", manifest.document_id));
            let source = command.source.as_deref().unwrap_or(&default_source);
            hcd_formats::apply_xlsx_patch_with_source(
                &bundle,
                &patch,
                command.expected_revision,
                Some(source),
            )
        } else {
            let source = std::path::Path::new(&command.bundle)
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .join("sources")
                .join(format!("{}.pdf", manifest.document_id));
            let plan = if manifest.source.format == "pdf" {
                hcd_formats::plan_pdf_page_rasters(&bundle, &source, &patch.operations)
                    .map_err(handler_error)?
            } else {
                hcd_core::PdfRasterPlan::default()
            };
            hcd_core::apply_patch_with_pdf_rasters(&bundle, &patch, command.expected_revision, plan)
        }
    }
    .map_err(handler_error)?;
    render(
        &result,
        format,
        format!(
            "Applied patch {}: revision {} ({} dirty chunk(s))",
            result.patch_id,
            result.revision,
            result.dirty_chunk_ids.len()
        ),
    )
}

fn project_editor(
    command: HdocProjectEditorCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    let result = if command.word_regions {
        hcd_core::project_flow_regions(&bundle, command.expected_revision)
    } else {
        hcd_core::project_editor(&bundle, command.expected_revision)
    }
    .map_err(handler_error)?;
    render(
        &result,
        format,
        format!("Editor projection created at revision {}", result.revision),
    )
}

fn editor_state(
    command: HdocEditorStateCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    let state = hcd_core::editor_projection(&bundle, command.revision).map_err(handler_error)?;
    let count = state.blocks.len();
    render(
        &state,
        format,
        format!("Editor projection has {count} blocks"),
    )
}

fn read_patch_json(source: &str) -> Result<String, HandlerError> {
    if source == "-" {
        let stdin = std::io::stdin();
        return read_patch_json_from(stdin.lock(), "stdin");
    }
    let file = std::fs::File::open(source)?;
    read_patch_json_from(file, source)
}

fn read_patch_json_from(mut reader: impl Read, source: &str) -> Result<String, HandlerError> {
    let maximum = hcd_core::MAX_PATCH_JSON_BYTES;
    let mut bytes = Vec::with_capacity((maximum.min(64 * 1024)) as usize);
    reader
        .by_ref()
        .take(maximum.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        return Err(HandlerError::InvalidArgument(format!(
            "HCD patch JSON from {source} exceeds the {maximum} byte limit"
        )));
    }
    String::from_utf8(bytes).map_err(|error| {
        HandlerError::InvalidArgument(format!(
            "HCD patch JSON from {source} is not UTF-8: {error}"
        ))
    })
}

fn export(
    command: HdocExportCommand,
    format: OutputFormat,
) -> Result<(String, bool), HandlerError> {
    let bundle = Bundle::open(&command.bundle).map_err(handler_error)?;
    let head = bundle.manifest().map_err(handler_error)?;
    let target = semantic_target(&command.output, command.to.as_deref())?;
    let source_format = normalize_format(&head.source.format);
    let options = ExportOptions {
        revision: command.revision,
        fidelity_report: command.fidelity_report.clone(),
    };
    let report = match command.source.as_deref() {
        Some(source) if target == source_format => {
            hcd_formats::export_document(&command.bundle, source, &command.output, &options)
                .map_err(handler_error)?
        }
        _ => semantic_export(
            &bundle,
            &head,
            &command.output,
            &target,
            command.revision,
            command.fidelity_report.as_deref(),
            command.typography_source.as_deref(),
        )?,
    };
    render(
        &report,
        format,
        format!(
            "Exported revision to {} ({:?} fidelity)",
            command.output, report.level
        ),
    )
}

fn semantic_target(output: &str, requested: Option<&str>) -> Result<String, HandlerError> {
    let extension = Path::new(output)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(normalize_format)
        .unwrap_or_default();
    let requested = requested.map(normalize_format);
    if let Some(requested) = requested.as_deref() {
        if requested != extension {
            return Err(HandlerError::InvalidArgument(format!(
                "--to {requested} does not match --output extension .{extension}"
            )));
        }
    }
    let target = requested.unwrap_or(extension);
    if !matches!(
        target.as_str(),
        "docx" | "xlsx" | "pptx" | "pdf" | "html" | "md" | "txt"
    ) {
        return Err(HandlerError::UnsupportedMode(format!(
            "HCD export supports .docx, .xlsx, .pptx, .pdf, .html, .md/.markdown, or .txt; found .{target}"
        )));
    }
    Ok(target)
}

fn normalize_format(value: &str) -> String {
    match value
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .as_str()
    {
        "htm" => "html".to_string(),
        "markdown" => "md".to_string(),
        format => format.to_string(),
    }
}

fn semantic_export(
    bundle: &Bundle,
    head: &HcdManifest,
    output: &str,
    target: &str,
    requested_revision: Option<u64>,
    fidelity_report: Option<&Path>,
    typography_source: Option<&str>,
) -> Result<FidelityReport, HandlerError> {
    if !matches!(
        target,
        "docx" | "xlsx" | "pptx" | "pdf" | "html" | "md" | "txt"
    ) {
        return Err(HandlerError::UnsupportedMode(format!(
            "source-free semantic export supports .docx, .xlsx, .pptx, .pdf, .html, .md, or .txt; .{target} requires its immutable source"
        )));
    }
    let validation = hcd_core::validate_bundle(bundle).map_err(handler_error)?;
    if !validation.valid {
        return Err(HandlerError::ValidationError(format!(
            "HCD validation failed with {} issue(s) before semantic export",
            validation.issues.len()
        )));
    }
    let (manifest, revision) =
        manifest_at_revision(bundle, head, requested_revision).map_err(handler_error)?;
    if manifest.source.format == "pdf"
        && hcd_formats::pdf_has_unpainted_text(bundle, revision).map_err(handler_error)?
    {
        return Err(HandlerError::UnsupportedMode("PDF_UNPAINTED_TEXT: source-free export cannot safely hide original text behind an approximate overlay. Restore the original PDF for source-backed export or retain the HCD archive.".into()));
    }
    if let Some(layout) =
        hcd_core::read_flow_document_layout(bundle, &manifest).map_err(handler_error)?
    {
        if target == "docx" {
            return word_region_export(
                bundle,
                &manifest,
                &layout,
                output,
                fidelity_report,
                typography_source,
            );
        }
        if target == "txt" && layout.schema_version == hcd_core::FLOW_REGION_LAYOUT_SCHEMA {
            if typography_source.is_some() {
                return Err(HandlerError::InvalidArgument(
                    "--typography-source requires DOCX semantic export from a DOCX bundle".into(),
                ));
            }
            let summary = super::html_convert::word_regions::export_text(
                bundle,
                &manifest,
                &layout,
                Path::new(output),
            )?;
            let mut warnings = vec![FidelityWarning {
                code: "HCD_WORD_TEXT_STATIC".into(),
                message: "Section bodies and distinct header/footer stories are listed as static text. Page variants, paper layout, field calculations, images and attachments require the original Word file or HCDZ".into(),
                node_id: None,
                source_part: None,
            }];
            warnings.extend(summary.warnings.into_iter().map(|message| FidelityWarning {
                code: "RUST_HTML_SEMANTIC_WARNING".into(),
                message,
                node_id: None,
                source_part: None,
            }));
            let report = FidelityReport {
                schema_version: HCD_SCHEMA_VERSION.into(),
                level: FidelityLevel::Semantic,
                preserved: vec![format!("saved revision {revision} body sections and distinct header/footer stories as labeled text")],
                flattened: vec!["formatting, page layout, fields and relationships become static readable text".into()],
                dropped: vec!["image bytes, attachments and native history require HCDZ".into()],
                warnings,
            };
            if let Some(path) = fidelity_report {
                write_semantic_fidelity_report(path, &report)?;
            }
            return Ok(report);
        }
        if target != "html" || layout.schema_version != hcd_core::FLOW_REGION_LAYOUT_SCHEMA {
            let recovery = if hcd_docx::requires_semantic_rebuild(bundle, revision)
                .map_err(handler_error)?
            {
                "Use hdoc pack for an offline HCD archive; edited Word regions require section-aware rebuilding"
            } else {
                "Export DOCX with --source pointing to the original DOCX, or use hdoc pack for an offline HCD archive"
            };
            return Err(HandlerError::UnsupportedMode(format!("Semantic export cannot preserve this Word document's headers, footers and section settings yet. {recovery}")));
        }
    }
    let output_path = Path::new(output);
    let parent = output_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    if target == "html" {
        if typography_source.is_some() {
            return Err(HandlerError::InvalidArgument(
                "--typography-source requires DOCX semantic export from a DOCX bundle".into(),
            ));
        }
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        let exported = crate::hdoc_export_html::render(bundle, revision, temporary.as_file_mut())
            .map_err(handler_error)?;
        temporary.as_file_mut().flush()?;
        temporary
            .persist(output_path)
            .map_err(|error| HandlerError::IoError(error.error))?;
        let mut report = FidelityReport {
            schema_version: HCD_SCHEMA_VERSION.into(), level: FidelityLevel::Semantic,
            preserved: vec![format!("canonical HCD revision {revision} across {} chunks, with stylesheet and portable HTML node presentations", exported.presentation.chunk_count),format!("{} verified content-addressed resources embedded as data URIs", exported.embedded_assets),"inert node/reference metadata where present in the canonical HTML".into()],
            flattened: vec!["source-format opaque objects and exact physical pagination are not reconstructed; online collaboration and relationship services require HCD".into()],
            dropped: Vec::new(), warnings: vec![FidelityWarning { code:"HCD_HTML_STANDALONE_EXPORT".into(),message:"Self-contained derived HTML uses the selected saved revision; original Office package parts, unaccepted suggestions and live service state are not added".into(),node_id:None,source_part:None }],
        };
        if exported.word_regions {
            report.preserved.push("section and story identities, explicit paper dimensions/margins, header/footer variant bindings and cached field results".into());
            report.flattened.push("browser block pagination is approximate; continuous sections start separate pages, oversized blocks expand rather than crop, and Word field caches are not recalculated".into());
            report.warnings.push(FidelityWarning{code:"HCD_WORD_HTML_BROWSER_PAGINATION".into(),message:"The standalone Word view uses source section geometry and story bindings. Exact Word line/table pagination, continuous-section positioning and computed page fields still require a Word layout engine; use HCDZ for complete native history and attachments".into(),node_id:None,source_part:None});
        }
        if let Some(path) = fidelity_report {
            write_semantic_fidelity_report(path, &report)?;
        }
        return Ok(report);
    }
    if target == "pdf"
        && manifest.profile == "fixed-layout"
        && manifest.source.format == "pdf"
        && super::hdoc_raster_pdf::can_export(bundle, &manifest)?
    {
        let exported = super::hdoc_raster_pdf::export(bundle, &manifest, revision, output_path)?;
        let report = FidelityReport {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            level: FidelityLevel::Visual,
            preserved: vec![format!("{} HCD page rasters and physical page dimensions", exported.pages), format!("{} positioned canonical text nodes in an invisible Unicode search/copy layer", exported.text_nodes)],
            flattened: vec!["PDF page text and vector structure are represented by page images".to_string()],
            dropped: vec!["original PDF object metadata and original font structure".to_string()],
            warnings: vec![FidelityWarning {
                code: "HCD_PDF_RASTER_TEXT_EXPORT".to_string(),
                message: "source-free PDF export embeds final HCD page images plus existing canonical text for search/copy; it does not run OCR or preserve the original PDF vector/font/tag structure".to_string(),
                node_id: None, source_part: None,
            }],
        };
        if let Some(path) = fidelity_report {
            write_semantic_fidelity_report(path, &report)?;
        }
        return Ok(report);
    }
    let mut materialized = tempfile::Builder::new()
        .prefix(".officecli-hcd-semantic-")
        .suffix(".html")
        .tempfile_in(parent)?;
    let mut stylesheet = String::new();
    if target == "docx" && manifest.profile == "semantic-flow" {
        std::fs::File::open(
            bundle
                .resolve_href(&manifest.styles_href)
                .map_err(handler_error)?,
        )?
        .take(hcd_core::MAX_CONTROL_PART_BYTES + 1)
        .read_to_string(&mut stylesheet)?;
    }
    if let Some(source) = typography_source {
        if target != "docx" || manifest.source.format != "docx" {
            return Err(HandlerError::InvalidArgument(
                "--typography-source requires DOCX semantic export from a DOCX bundle".into(),
            ));
        }
        stylesheet.push('\n');
        stylesheet.push_str(
            &hcd_docx::source_typography_styles(source, &manifest.source.sha256)
                .map_err(handler_error)?,
        );
    }
    let typography = if target != "docx" || manifest.profile != "semantic-flow" {
        None
    } else {
        Some(hcd_core::TypographyResolver::new(&stylesheet).map_err(handler_error)?)
    };
    let presentation = render_standalone_html_with_transform(
        bundle,
        &HtmlPresentationOptions {
            revision: Some(revision),
            ..HtmlPresentationOptions::default()
        },
        materialized.as_file_mut(),
        |html| {
            let adapted = hcd_core::adapt_extension_exports(html, target)?;
            let html = adapted.as_str();
            if target == "pdf" {
                hcd_formats::enhance_presentation_fragment(html)
            } else if let Some(resolver) = &typography {
                resolver.annotate_export(html)
            } else {
                Ok(html.to_string())
            }
        },
    )
    .map_err(handler_error)?;
    let chunk_count = presentation.chunk_count;
    materialized.as_file_mut().flush()?;
    let assets = semantic_assets(bundle, revision).map_err(handler_error)?;
    let summary = super::html_convert::convert_html_with_assets(
        materialized.path(),
        output_path,
        target,
        assets,
    )?;
    let image_count = summary.image_count;
    let embedded_image_count = summary.embedded_image_count;
    let conversion_engine = summary.engine;

    let mut warnings = vec![FidelityWarning {
        code: "HCD_CROSS_FORMAT_SEMANTIC_EXPORT".to_string(),
        message: format!(
            "revision {revision} was rebuilt as .{target} by OfficeCLI's in-process Rust {conversion_engine} handler; source-backed opaque parts and exact {profile} source layout were not applied",
            profile = manifest.profile
        ),
        node_id: None,
        source_part: None,
    }];
    warnings.extend(summary.warnings.into_iter().map(|message| FidelityWarning {
        code: "RUST_HTML_SEMANTIC_WARNING".to_string(),
        message,
        node_id: None,
        source_part: None,
    }));
    if manifest.profile == "semantic-flow" {
        for extension in hcd_core::projection_extensions(
            &hcd_core::editor_projection(bundle, Some(revision)).map_err(handler_error)?,
        )
        .map_err(handler_error)?
        {
            let adapted = extension.exports.contains_key(target);
            warnings.push(FidelityWarning{code:if adapted {"HCD_EXTENSION_ADAPTED"} else {"HCD_EXTENSION_FLATTENED"}.into(),message:format!("{} ({} v{}): {} retained in .{target}; business data and opaque resources require the native HCD bundle",extension.instance_id,extension.node_type,extension.version,if adapted {"portable presentation"} else {"readable content"}),node_id:None,source_part:None});
        }
        for occurrence in
            hcd_core::document_references(bundle, Some(revision)).map_err(handler_error)?
        {
            warnings.push(FidelityWarning{code:"HCD_REFERENCE_FLATTENED".into(),message:format!("{}: readable display text is retained in .{target}; dynamic person/business relationships require the native HCD bundle",occurrence.reference.mention_id),node_id:Some(occurrence.block_id),source_part:None});
        }
    }
    let mut preserved = vec![
        format!("canonical HCD revision {revision} text in chunk sequence order"),
        format!(
            "semantic headings, paragraphs, lists and tables recognized across {chunk_count} HCD chunks"
        ),
        "in-process Rust output generation and target structure validation".to_string(),
    ];
    if conversion_engine == "rust-html-css-pdf" {
        preserved.push(
            "canonical HCD HTML structure, stylesheet cascade, inline formatting, links, tables and paginated print layout rendered directly to PDF"
                .to_string(),
        );
    }
    if embedded_image_count > 0 {
        preserved.push(format!(
            "{embedded_image_count} of {image_count} content-addressed HCD image assets embedded in the target artifact; bounded source dimensions and direct slide coordinates are applied when present and target-compatible"
        ));
    }
    let report = FidelityReport {
        schema_version: HCD_SCHEMA_VERSION.to_string(),
        level: if conversion_engine == "rust-html-css-pdf" && manifest.profile != "fixed-layout" {
            FidelityLevel::High
        } else {
            FidelityLevel::Semantic
        },
        preserved,
        flattened: if conversion_engine == "rust-html-css-pdf" {
            vec![
                format!(
                    "{} source-format physical geometry outside canonical HCD HTML remains distinct from CSS print pagination",
                    manifest.profile
                ),
                "source-format opaque parts, annotations, JavaScript and unsupported browser-only CSS are not embedded in the PDF".to_string(),
            ]
        } else {
            vec![
                format!(
                    "{} profile-specific geometry, styles and pagination are reduced to semantic document defaults",
                    manifest.profile
                ),
                "source-format opaque parts, annotations and unsupported active content are not embedded in the cross-format artifact".to_string(),
            ]
        },
        dropped: Vec::new(),
        warnings,
    };
    if let Some(path) = fidelity_report {
        write_semantic_fidelity_report(path, &report)?;
    }
    Ok(report)
}

fn word_region_export(
    bundle: &Bundle,
    manifest: &HcdManifest,
    layout: &hcd_core::FlowDocumentLayout,
    output: &str,
    fidelity_report: Option<&Path>,
    typography_source: Option<&str>,
) -> Result<FidelityReport, HandlerError> {
    if layout.schema_version == hcd_core::FLOW_LAYOUT_SCHEMA {
        // Project an owned immutable snapshot. Export must never upgrade the
        // caller's head or overwrite its concurrent edits, including history.
        let snapshot = hcd_core::create_portable_snapshot(bundle, Some(manifest.revision))
            .map_err(handler_error)?;
        let projected = Bundle::open(snapshot.directory.path()).map_err(handler_error)?;
        hcd_core::project_flow_regions(&projected, manifest.revision).map_err(handler_error)?;
        let selected = projected.manifest().map_err(handler_error)?;
        let layout = hcd_core::read_flow_document_layout(&projected, &selected)
            .map_err(handler_error)?
            .ok_or_else(|| HandlerError::ValidationError("missing projected Word layout".into()))?;
        let mut report = word_region_export(
            &projected,
            &selected,
            &layout,
            output,
            None,
            typography_source,
        )?;
        if let Some(first) = report.preserved.first_mut() {
            *first = format!(
                "canonical revision {} rebuilt through an owned temporary region projection",
                manifest.revision
            );
        }
        report.warnings.push(FidelityWarning { code:"HCD_TEMPORARY_REGION_PROJECTION".into(), message: "Word region projection was applied only to the export snapshot; the saved document and its history were unchanged".into(),node_id:None,source_part:None });
        if let Some(path) = fidelity_report {
            write_semantic_fidelity_report(path, &report)?;
        }
        return Ok(report);
    }
    let mut stylesheet = String::new();
    std::fs::File::open(
        bundle
            .resolve_href(&manifest.styles_href)
            .map_err(handler_error)?,
    )?
    .take(hcd_core::MAX_CONTROL_PART_BYTES + 1)
    .read_to_string(&mut stylesheet)?;
    if stylesheet.len() as u64 > hcd_core::MAX_CONTROL_PART_BYTES {
        return Err(HandlerError::ValidationError(
            "Word export stylesheet exceeds limit".into(),
        ));
    }
    if let Some(source) = typography_source {
        stylesheet.push_str(
            &hcd_docx::source_typography_styles(source, &manifest.source.sha256)
                .map_err(handler_error)?,
        );
    }
    let typography = hcd_core::TypographyResolver::new(&stylesheet).map_err(handler_error)?;
    let assets = semantic_assets(bundle, manifest.revision).map_err(handler_error)?;
    let references =
        hcd_core::document_references(bundle, Some(manifest.revision)).map_err(handler_error)?;
    let extensions = hcd_core::projection_extensions(
        &hcd_core::editor_projection(bundle, Some(manifest.revision)).map_err(handler_error)?,
    )
    .map_err(handler_error)?;
    let summary = super::html_convert::word_regions::export(
        bundle,
        manifest,
        layout,
        Path::new(output),
        assets,
        &typography,
    )?;
    let mut warnings: Vec<_> = summary
        .warnings
        .into_iter()
        .map(|message| FidelityWarning {
            code: "HCD_WORD_REGION_SEMANTIC_EXPORT".into(),
            message,
            node_id: None,
            source_part: None,
        })
        .collect();
    for occurrence in references {
        warnings.push(FidelityWarning { code:"HCD_REFERENCE_FLATTENED".into(),message:"Readable mention text is retained; dynamic relationships remain in the native HCD archive".into(),node_id:Some(occurrence.block_id),source_part:None });
    }
    for extension in extensions {
        warnings.push(FidelityWarning { code:if extension.exports.contains_key("docx") { "HCD_EXTENSION_ADAPTED" } else { "HCD_EXTENSION_FLATTENED" }.into(),message:format!("{}: readable portable presentation is retained; opaque business data and resources remain in the native HCD archive",extension.instance_id),node_id:None,source_part:None });
    }
    let report = FidelityReport {
        schema_version: HCD_SCHEMA_VERSION.into(), level: FidelityLevel::Semantic,
        preserved: vec![format!("canonical revision {} across {} body sections and {} independent header/footer stories", manifest.revision,layout.sections.len(),layout.stories.len()), "section page settings, first/even/default bindings, inheritance and shared story identity".into(),format!("{} semantic blocks and {} of {} trusted image assets",summary.block_count, summary.embedded_image_count,summary.image_count),"native rich text, links and numbering with part-local relationships".into()],
        flattened: vec!["source pagination, unsupported CSS, computed field results and floating image placement use static semantic representations".into()],
        dropped: vec!["source-only opaque parts and section property revision history".into()], warnings,
    };
    if let Some(path) = fidelity_report {
        write_semantic_fidelity_report(path, &report)?;
    }
    Ok(report)
}

fn semantic_assets(
    bundle: &Bundle,
    revision: u64,
) -> Result<HashMap<String, super::html_convert::SemanticAsset>, HcdError> {
    let records = bundle.read_asset_index_for_revision(revision)?;
    let mut total = 0u64;
    let mut assets = HashMap::with_capacity(records.len());
    for record in records {
        if record.byte_length > MAX_SEMANTIC_ASSET_BYTES {
            return Err(HcdError::ResourceLimit(format!(
                "asset {} is {} bytes; source-free semantic export allows at most {MAX_SEMANTIC_ASSET_BYTES} bytes per asset",
                record.hash, record.byte_length
            )));
        }
        total = total.checked_add(record.byte_length).ok_or_else(|| {
            HcdError::ResourceLimit("semantic asset bytes overflowed".to_string())
        })?;
        if total > MAX_SEMANTIC_ASSETS_TOTAL_BYTES {
            return Err(HcdError::ResourceLimit(format!(
                "source-free semantic export assets exceed the {MAX_SEMANTIC_ASSETS_TOTAL_BYTES} byte total limit"
            )));
        }
        let path = bundle.resolve_href(&record.href)?;
        let metadata = std::fs::metadata(&path)?;
        if metadata.len() != record.byte_length {
            return Err(HcdError::InvalidBundle(format!(
                "asset {} changed size after validation",
                record.hash
            )));
        }
        let actual_hash = hash_file(&path)?;
        if actual_hash != record.hash {
            return Err(HcdError::InvalidBundle(format!(
                "asset {} changed content after validation: {actual_hash}",
                record.hash
            )));
        }
        let format = semantic_asset_format(&path)?;
        if format.is_empty() {
            continue;
        } // Opaque extension attachments remain in the native bundle.
        assets.insert(
            format!("asset://sha256/{}", record.hash),
            super::html_convert::SemanticAsset { path, format },
        );
    }
    Ok(assets)
}

fn semantic_asset_format(path: &Path) -> Result<String, HcdError> {
    let mut file = std::fs::File::open(path)?;
    let mut signature = [0u8; 16];
    let length = file.read(&mut signature)?;
    let bytes = &signature[..length];
    let format = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "gif"
    } else if bytes.starts_with(b"BM") {
        "bmp"
    } else if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        "tiff"
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "webp"
    } else if bytes.starts_with(&[0, 0, 1, 0]) {
        "ico"
    } else {
        ""
    };
    Ok(format.to_string())
}

fn write_semantic_fidelity_report(
    path: &Path,
    report: &FidelityReport,
) -> Result<(), HandlerError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".officecli-hcd-fidelity-")
        .suffix(".json")
        .tempfile_in(parent)?;
    serde_json::to_writer_pretty(temporary.as_file_mut(), report)?;
    temporary.as_file_mut().flush()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

fn render<T: serde::Serialize>(
    value: &T,
    format: OutputFormat,
    text: String,
) -> Result<(String, bool), HandlerError> {
    Ok((
        match format {
            OutputFormat::Text => text,
            OutputFormat::Json => serde_json::to_string_pretty(value)?,
        },
        true,
    ))
}

fn handler_error(error: HcdError) -> HandlerError {
    match error {
        HcdError::ResourceLimit(message) | HcdError::InvalidPatch(message) => {
            HandlerError::InvalidArgument(message)
        }
        HcdError::RevisionConflict(message) => {
            HandlerError::InvalidArgument(format!("revision conflict: {message}"))
        }
        HcdError::PreconditionFailed(message) => {
            HandlerError::InvalidArgument(format!("node precondition failed: {message}"))
        }
        HcdError::InvalidBundle(message) | HcdError::SourceMismatch(message) => {
            HandlerError::ValidationError(message)
        }
        HcdError::NodeNotFound(node) => HandlerError::PathNotFound(node),
        HcdError::Unsupported(message) => HandlerError::UnsupportedMode(message),
        HcdError::Io(error) => HandlerError::IoError(error),
        other => HandlerError::OperationFailed(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regional_word_text_export_labels_all_regions_without_modifying_bundle() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-regions-2026-10-26/image-source.docx");
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("regional.hcd");
        let mut options = hcd_docx::ImportOptions::new("text-export-test");
        options.flow_layout = true;
        hcd_docx::import_docx(&source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(&path).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        let before = bundle.manifest().unwrap();
        let output = temp.path().join("document.txt");
        let report = semantic_export(
            &bundle,
            &before,
            output.to_str().unwrap(),
            "txt",
            Some(1),
            None,
            None,
        )
        .unwrap();
        let text = std::fs::read_to_string(output).unwrap();
        assert!(text.contains("Section 1") && text.contains("Section 2"));
        assert!(text.contains("Body one") && text.contains("Body two"));
        assert!(text.contains("Header") && text.contains("Footer"), "{text}");
        assert!(!text.contains("asset://"));
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.code == "HCD_WORD_TEXT_STATIC"));
        assert_eq!(bundle.manifest().unwrap().root_hash, before.root_hash);
        assert_eq!(bundle.manifest().unwrap().revision, before.revision);
    }

    #[test]
    fn independent_word_header_semantic_export_preserves_sections_and_reimports() {
        use std::io::Read;
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-regions-2026-10-26/image-source.docx");
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("independent.hcd");
        let mut options = hcd_docx::ImportOptions::new("unlink-export-test");
        options.flow_layout = true;
        hcd_docx::import_docx(&source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(&path).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        let projection = hcd_core::editor_projection(&bundle, Some(1)).unwrap();
        let layout = projection.flow_layout.as_ref().unwrap();
        let request = hcd_core::FlowStoryUnlinkRequest {
            base_layout_hash: projection.flow_layout_hash.clone().unwrap(),
            section_id: layout.sections[1].id.clone(),
            kind: hcd_core::FlowStoryKind::Header,
            variant: hcd_core::FlowStoryVariant::First,
            expected_inherited_story_id: layout.sections[0].headers.first.clone(),
        };
        let story = hcd_core::FlowStory {
            id: format!("n_{:032x}", 999996),
            kind: hcd_core::FlowStoryKind::Header,
            source_part: "word/independent-export.xml".into(),
        };
        let candidate = hcd_docx::prepare_source_story_unlink(
            &bundle,
            &source,
            1,
            &request,
            &story,
            |_| unreachable!(),
            |_| unreachable!(),
        )
        .unwrap();
        candidate.verify_current(&bundle).unwrap();
        hcd_core::apply_prepared_story_unlink(
            &bundle,
            &candidate.prepared,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            &Default::default(),
        )
        .unwrap();
        let independent = hcd_core::editor_projection(&bundle, Some(2)).unwrap();
        let block = independent
            .blocks
            .iter()
            .find(|block| block.flow_region_id.as_deref() == Some(story.id.as_str()))
            .unwrap();
        let mut content = block.content.clone();
        content.inlines[0].text = "Changed independently".into();
        let patch = hcd_core::FlowStructurePatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_6.into(),
            document_id: independent.document_id.clone(),
            patch_id: "independent-header-edit".into(),
            base_revision: 2,
            layout_hash: independent.flow_layout_hash.unwrap(),
            actor: Default::default(),
            regions: vec![hcd_core::FlowRegionEdits {
                region_id: story.id.clone(),
                operations: vec![hcd_core::StructureOperation::Replace {
                    block_id: block.block_id.clone(),
                    block: content,
                    precondition: hcd_core::BlockPrecondition {
                        block_hash: block.block_hash.clone(),
                    },
                }],
            }],
        };
        hcd_core::apply_flow_structure_patch(&bundle, &patch, 2).unwrap();
        let output = temp.path().join("independent.docx");
        semantic_export(
            &bundle,
            &bundle.manifest().unwrap(),
            output.to_str().unwrap(),
            "docx",
            Some(3),
            None,
            None,
        )
        .unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&output).unwrap()).unwrap();
        let mut xml = String::new();
        archive
            .by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("Body one") && xml.contains("Body two"));
        let document = roxmltree::Document::parse(&xml).unwrap();
        let references: Vec<_> = document
            .descendants()
            .filter(|node| node.is_element() && node.tag_name().name() == "sectPr")
            .map(|section| {
                section
                    .children()
                    .find(|node| {
                        node.is_element()
                            && node.tag_name().name() == "headerReference"
                            && node
                                .attributes()
                                .iter()
                                .any(|attr| attr.name() == "type" && attr.value() == "first")
                    })
                    .and_then(|node| {
                        node.attributes()
                            .iter()
                            .find(|attr| attr.name() == "id")
                            .map(|attr| attr.value().to_owned())
                    })
            })
            .collect();
        assert_eq!(references.len(), 2);
        assert!(references.iter().all(Option::is_some));
        assert_ne!(references[0], references[1]);
        let imported = temp.path().join("roundtrip.hcd");
        let mut roundtrip_options = hcd_docx::ImportOptions::new("unlink-roundtrip");
        roundtrip_options.flow_layout = true;
        hcd_docx::import_docx(&output, &imported, &roundtrip_options, |_| Ok(())).unwrap();
        let imported = Bundle::open(imported).unwrap();
        let imported_layout =
            hcd_core::read_flow_document_layout(&imported, &imported.manifest().unwrap())
                .unwrap()
                .unwrap();
        assert_eq!(imported_layout.sections.len(), 2);
        assert_ne!(
            imported_layout.sections[0].headers.first,
            imported_layout.sections[1].headers.first
        );
        let mut original_headers = 0;
        let mut independent_headers = 0;
        for index in 0..archive.len() {
            let mut part = archive.by_index(index).unwrap();
            if part.name().starts_with("word/header") && part.name().ends_with(".xml") {
                let mut text = String::new();
                part.read_to_string(&mut text).unwrap();
                if text.contains("First header") {
                    original_headers += 1;
                }
                if text.contains("Changed independently") {
                    independent_headers += 1;
                }
            }
        }
        assert_eq!(original_headers, 1);
        assert_eq!(independent_headers, 1);
    }

    #[test]
    fn semantic_docx_export_embeds_png_stored_as_bin() {
        use base64::Engine;
        use std::io::Read;
        let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
        let (temp, bundle, _) =
            crate::hdoc_export_html::tests::fixture_with_extension(&png, "bin", |hash| {
                format!("<p>Shared image</p><img src=\"asset://sha256/{hash}\"/>")
            });
        let output = temp.path().join("shared.docx");
        let head = bundle.manifest().unwrap();
        let validation = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
        semantic_export(
            &bundle,
            &head,
            output.to_str().unwrap(),
            "docx",
            Some(0),
            None,
            None,
        )
        .unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(output).unwrap()).unwrap();
        let mut found = false;
        for index in 0..archive.len() {
            let mut file = archive.by_index(index).unwrap();
            if file.name().starts_with("word/media/") && !file.is_dir() {
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes).unwrap();
                if bytes == png {
                    assert!(file.name().ends_with(".png"));
                    found = true;
                }
            }
        }
        assert!(found, "the original PNG must be embedded as an image");
    }

    #[test]
    fn semantic_docx_export_embeds_shared_node_image_stored_as_bin() {
        use base64::Engine;
        use std::io::Read;
        let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
        let (temp, bundle, _) = crate::hdoc_export_html::tests::fixture_with_extension(
            &png,
            "bin",
            |hash| {
                let node = serde_json::json!({"schemaVersion":"hcd.extension/2","instanceId":format!("x_{:032x}",1),"type":"example.shared","version":1,"display":"block","data":{},"fallback":{"text":"Files"},"resources":[{"key":"photo","name":"picture.png","mediaType":"image/png","byteLength":png.len(),"hash":hash},{"key":"file","name":"attachment.bin","mediaType":"application/octet-stream","byteLength":png.len(),"hash":hash}],"exports":{"docx":{"support":"semantic","blocks":[{"kind":"paragraph","runs":[{"text":"Shared image"},{"resource":"photo","alt":"Photo","widthPt":32,"heightPt":24}]}]}}});
                format!(
                    "<div data-hcd-extension=\"{}\">Files</div>",
                    quick_xml::escape::escape(node.to_string())
                )
            },
        );
        let validation = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
        let output = temp.path().join("shared-node.docx");
        semantic_export(
            &bundle,
            &bundle.manifest().unwrap(),
            output.to_str().unwrap(),
            "docx",
            Some(0),
            None,
            None,
        )
        .unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(output).unwrap()).unwrap();
        let mut found = false;
        for index in 0..archive.len() {
            let mut file = archive.by_index(index).unwrap();
            if file.name().starts_with("word/media/") && !file.is_dir() {
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes).unwrap();
                if bytes == png {
                    assert!(file.name().ends_with(".png"));
                    found = true;
                }
            }
        }
        assert!(found, "the shared node PNG must be embedded as an image");
    }

    #[test]
    fn patch_reader_stops_at_the_json_byte_limit() {
        let input = std::io::repeat(b'x').take(hcd_core::MAX_PATCH_JSON_BYTES + 1);
        let error = read_patch_json_from(input, "test input").unwrap_err();
        assert!(error.to_string().contains("exceeds the"));
        assert!(error.to_string().contains("byte limit"));
    }

    #[test]
    fn preview_stylesheet_reader_rejects_active_content() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(temp.path(), ".hcd-grid{background:url(javascript:x)}").unwrap();
        let error = read_preview_stylesheet(temp.path()).unwrap_err();
        assert!(error.to_string().contains("unsafe"));
    }
}
