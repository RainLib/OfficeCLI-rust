use clap::Args;
use handler_common::HandlerError;

/// Create a blank document (docx, xlsx, pptx, pdf)
#[derive(Args)]
pub struct CreateCommand {
    /// File path to create
    pub file: String,

    /// Format: docx, xlsx, pptx
    #[arg(long, visible_alias = "type")]
    pub format: Option<String>,

    /// Overwrite an existing file. Without this flag create refuses to replace data.
    #[arg(long)]
    pub force: bool,

    /// For .docx, emit a raw OOXML scaffold without the Word-style baseline.
    #[arg(long)]
    pub minimal: bool,

    /// Locale tag used to seed DOCX script fonts and RTL defaults (for example zh-CN or ar-SA).
    #[arg(long)]
    pub locale: Option<String>,
}

pub fn handle_create(
    cmd: CreateCommand,
    _format: handler_common::OutputFormat,
) -> Result<String, HandlerError> {
    let options = office_engine::CreateOptions {
        overwrite: cmd.force,
        minimal: cmd.minimal,
        locale: effective_locale(cmd.locale.as_deref()),
    };
    let created = office_engine::create_document(&cmd.file, cmd.format.as_deref(), &options)?;
    Ok(created.message)
}

fn effective_locale(explicit: Option<&str>) -> Option<String> {
    let value = explicit.map(ToOwned::to_owned).or_else(|| {
        std::env::var("LC_ALL")
            .ok()
            .filter(|value| !value.is_empty())
            .or_else(|| std::env::var("LANG").ok())
    })?;
    let locale = value
        .split('.')
        .next()
        .unwrap_or_default()
        .replace('_', "-");
    let language = locale
        .split('-')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if locale.is_empty()
        || matches!(locale.to_ascii_lowercase().as_str(), "c" | "posix")
        || (explicit.is_none()
            && matches!(
                language.as_str(),
                "en" | "fr" | "de" | "es" | "it" | "pt" | "nl" | "ru" | "pl"
            ))
    {
        None
    } else {
        Some(locale)
    }
}
