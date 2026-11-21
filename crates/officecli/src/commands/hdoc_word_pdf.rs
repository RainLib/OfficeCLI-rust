//! Word PDF export prints the same measured pages as the editor. A bounded,
//! isolated Chromium process has no application cookies or network access.
use handler_common::HandlerError;
use hcd_core::{Bundle, HtmlPresentationOptions};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

mod text;

fn error(message: impl std::fmt::Display) -> HandlerError {
    HandlerError::OperationFailed(message.to_string())
}
pub(crate) fn browser() -> Option<PathBuf> {
    for name in ["OFFICECLI_PDF_BROWSER", "HCD_BROWSER_PATH"] {
        if let Some(path) = std::env::var_os(name) {
            let path = PathBuf::from(path);
            return path.is_file().then_some(path);
        }
    }
    crate::screenshot::find_chromium_browser()
}
pub(crate) fn export(
    bundle: &Bundle,
    revision: u64,
    theme_stylesheet: Option<String>,
    output: &Path,
) -> Result<usize, HandlerError> {
    let browser=browser().ok_or_else(||error("high-fidelity Word PDF export requires Chromium; configure OFFICECLI_PDF_BROWSER. The semantic PDF fallback was not used."))?;
    let validation = hcd_core::validate_bundle(bundle).map_err(error)?;
    if !validation.valid {
        return Err(error("cannot export an invalid HCD bundle"));
    }
    let temp = tempfile::tempdir().map_err(error)?;
    let html = temp.path().join("preview.html");
    let dom = temp.path().join("prepared.html");
    let pdf = temp.path().join("output.pdf");
    let log = temp.path().join("browser.log");
    let mut source = Vec::new();
    office_engine::render_hcd_html(
        bundle,
        &HtmlPresentationOptions {
            revision: Some(revision),
            max_output_bytes: 256 * 1024 * 1024,
            theme_stylesheet,
            ..Default::default()
        },
        &mut source,
    )
    .map_err(error)?;
    let mut source = String::from_utf8(source).map_err(error)?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    source = source.replace(
        "<script id=\"hcd-docx-virtual-pages\"",
        &format!("<script nonce=\"{nonce}\" id=\"hcd-docx-virtual-pages\""),
    );
    // Capture the final page text after fields and running regions are resolved.
    // This is an export audit only; it never changes what the browser paints.
    let audit = r#"window.addEventListener('hcd-pagination-ready',()=>{const audit=document.createElement('meta');audit.id='hcd-word-pdf-text';audit.content=JSON.stringify([...document.querySelectorAll('.hcd-virtual-page')].map(page=>page.innerText));document.head.append(audit);},{once:true});"#;
    let paginator = regex::Regex::new(
        r#"(?s)(<script nonce="[^"]+" id="hcd-docx-virtual-pages"[^>]*>)(.*?)(</script>)"#,
    )
    .expect("constant paginator pattern");
    source = paginator
        .replace(&source, |capture: &regex::Captures<'_>| {
            format!("{}{}\n{audit}{}", &capture[1], &capture[2], &capture[3])
        })
        .into_owned();
    let policy=format!("<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'\"/>");
    source = source.replacen("<head>", &format!("<head>{policy}"), 1);
    std::fs::write(&html, source).map_err(error)?;
    let mut command = Command::new(browser);
    command
        .args([
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-extensions",
            "--no-pdf-header-footer",
            "--window-size=1600,1200",
            "--virtual-time-budget=10000",
            "--timeout=45000",
            "--dump-dom",
        ])
        .arg(format!(
            "--user-data-dir={}",
            temp.path().join("profile").display()
        ))
        .arg(format!("--print-to-pdf={}", pdf.display()))
        .arg(format!("file://{}", html.display()))
        .stdin(Stdio::null())
        .stdout(std::fs::File::create(&dom).map_err(error)?)
        .stderr(std::fs::File::create(&log).map_err(error)?);
    let mut child = command.spawn().map_err(error)?;
    let deadline = Instant::now() + Duration::from_secs(50);
    let status = loop {
        if let Some(status) = child.try_wait().map_err(error)? {
            break status;
        }
        if std::fs::metadata(&dom).is_ok_and(|m| m.len() > 512 * 1024 * 1024)
            || std::fs::metadata(&pdf).is_ok_and(|m| m.len() > 256 * 1024 * 1024)
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error(
                "Word PDF rendering exceeded its output budget; no download was issued",
            ));
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error(
                "Word PDF rendering timed out; no download was issued",
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    if !status.success() {
        return Err(error(format!(
            "Word PDF renderer failed: {}",
            std::fs::read_to_string(log)
                .unwrap_or_default()
                .chars()
                .take(2000)
                .collect::<String>()
        )));
    }
    if std::fs::metadata(&dom).map_err(error)?.len() > 512 * 1024 * 1024
        || std::fs::metadata(&pdf).map_err(error)?.len() > 256 * 1024 * 1024
    {
        return Err(error(
            "Word PDF rendering exceeded its output budget; no download was issued",
        ));
    }
    let prepared = std::fs::read_to_string(&dom).map_err(error)?;
    if regex::Regex::new(r#"<body\b[^>]*\bdata-hcd-pagination-error="|<section\b[^>]*\bdata-hcd-page-overflow="true""#).expect("constant error pattern").is_match(&prepared)
    {
        return Err(error("Word preview contains a pagination error or an oversized unsplittable object; PDF export stopped to avoid clipping"));
    }
    let pages = regex::Regex::new(r#"<body\b[^>]*\bdata-hcd-page-count="(\d+)""#)
        .expect("constant pagination pattern")
        .captures(&prepared)
        .and_then(|c| c[1].parse::<usize>().ok())
        .filter(|n| *n > 0)
        .ok_or_else(|| {
            error("Word PDF rendering did not finish the preview paginator; no download was issued")
        })?;
    let mut document = lopdf::Document::load(&pdf).map_err(error)?;
    if document.get_pages().len() != pages {
        return Err(error(format!(
            "Word PDF page count differs from preview: {} versus {pages}; export stopped",
            document.get_pages().len()
        )));
    }
    let paper =
        regex::Regex::new(r#"<section\b[^>]*\bdata-hcd-virtual-page="\d+"[^>]*\bstyle="([^"]*)""#)
            .expect("constant paper pattern");
    let sizes = paper
        .captures_iter(&prepared)
        .map(|c| {
            let dimension = |name: &str| -> Result<f64, HandlerError> {
                c[1].split(';')
                    .filter_map(|p| p.split_once(':'))
                    .find(|(k, _)| k.trim() == name)
                    .and_then(|(_, v)| v.trim().strip_suffix("px"))
                    .and_then(|v| v.parse::<f64>().ok())
                    .filter(|v| v.is_finite() && *v > 0.0)
                    .map(|v| v * 0.75)
                    .ok_or_else(|| error("Word preview page geometry is missing"))
            };
            Ok((dimension("width")?, dimension("height")?))
        })
        .collect::<Result<Vec<_>, HandlerError>>()?;
    if sizes.len() != pages {
        return Err(error("Word preview page geometry count is inconsistent"));
    }
    for ((_, id), (width, height)) in document.get_pages().iter().zip(sizes) {
        let mut dictionary = document.get_dictionary(*id).map_err(error)?;
        let bounds = loop {
            if let Ok(bounds) = dictionary.get(b"MediaBox") {
                break bounds.as_array().map_err(error)?;
            }
            let parent = dictionary
                .get(b"Parent")
                .and_then(|p| p.as_reference())
                .map_err(error)?;
            dictionary = document.get_dictionary(parent).map_err(error)?;
        };
        let number = |n: usize| -> Result<f64, HandlerError> {
            match bounds.get(n) {
                Some(lopdf::Object::Integer(v)) => Ok(*v as f64),
                Some(lopdf::Object::Real(v)) => Ok(f64::from(*v)),
                _ => Err(error("PDF page geometry is invalid")),
            }
        };
        if (number(2)? - number(0)? - width).abs() > 1.0
            || (number(3)? - number(1)? - height).abs() > 1.0
        {
            return Err(error(
                "Word PDF paper size differs from preview; export stopped to avoid scaling",
            ));
        }
    }
    let audit =
        regex::Regex::new(r#"<meta\b[^>]*\bid="hcd-word-pdf-text"[^>]*\bcontent="([^"]*)""#)
            .expect("constant text audit pattern");
    let audit = audit
        .captures(&prepared)
        .ok_or_else(|| error("Word PDF text audit is missing; no download was issued"))?;
    let audit = quick_xml::escape::unescape(&audit[1]).map_err(error)?;
    let expected: Vec<String> = serde_json::from_str(&audit).map_err(error)?;
    if text::reconcile(&mut document, &expected)? {
        document.save(&pdf).map_err(error)?;
    }
    if std::fs::metadata(&pdf).map_err(error)?.len() > 256 * 1024 * 1024 {
        return Err(error("Word PDF exceeds 256 MiB"));
    }
    if let Some(parent) = output.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(error)?;
    }
    std::fs::copy(pdf, output).map_err(error)?;
    Ok(pages)
}
