//! Headless HTML → PNG screenshot via shell-out to a browser.
//! Tries playwright CLI → Chromium → Chrome → Edge → Firefox.
//! No embedded browser engine; binary stays small.

use std::path::{Path, PathBuf};
use std::process::Command;

pub struct ScreenshotResult {
    pub backend: String,
    pub output_path: String,
}

/// PDF printing requires Chromium; an unrelated Playwright CLI or Firefox on
/// PATH must not hide an installed Chrome/Edge renderer.
pub fn find_chromium_browser() -> Option<PathBuf> {
    for name in [
        "chromium",
        "chromium-browser",
        "chrome",
        "google-chrome",
        "msedge",
    ] {
        if let Ok(path) = which_binary(name) {
            return Some(path);
        }
    }
    for path in [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    ] {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    find_playwright_chromium()
}

/// Find an available headless browser binary.
pub fn find_browser() -> Option<(String, PathBuf)> {
    // 1. Playwright CLI
    if let Ok(path) = which_binary("playwright") {
        return Some(("playwright".to_string(), path));
    }

    // 2. Chromium
    if let Ok(path) = which_binary("chromium") {
        return Some(("chromium".to_string(), path));
    }
    if let Ok(path) = which_binary("chromium-browser") {
        return Some(("chromium".to_string(), path));
    }

    // 3. Chrome / Google Chrome (platform-specific paths)
    if let Ok(path) = which_binary("chrome") {
        return Some(("chrome".to_string(), path));
    }
    if let Ok(path) = which_binary("google-chrome") {
        return Some(("chrome".to_string(), path));
    }
    // macOS
    let mac_chrome = PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    if mac_chrome.exists() {
        return Some(("chrome".to_string(), mac_chrome));
    }
    // Windows
    let win_chrome = PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe");
    if win_chrome.exists() {
        return Some(("chrome".to_string(), win_chrome));
    }

    // 4. Edge
    if let Ok(path) = which_binary("msedge") {
        return Some(("edge".to_string(), path));
    }
    let mac_edge = PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    if mac_edge.exists() {
        return Some(("edge".to_string(), mac_edge));
    }

    // 5. Firefox
    if let Ok(path) = which_binary("firefox") {
        return Some(("firefox".to_string(), path));
    }

    None
}

/// Capture an HTML file to a PNG screenshot.
pub fn capture(
    html_path: &str,
    out_path: &str,
    width: u32,
    height: u32,
) -> Result<ScreenshotResult, String> {
    let (backend, browser_path) = find_browser().ok_or_else(|| {
        "no_screenshot_backend: no headless browser found (tried playwright, chromium, chrome, edge, firefox)".to_string()
    })?;

    // Ensure output directory exists
    if let Some(parent) = Path::new(out_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create output dir: {}", e))?;
    }

    // Cap to <= 1920px width for LLM limits (mirrors upstream)
    let w = width.min(1920);
    let h = height.min((1920 * height / width).max(800));

    let url = format!(
        "file://{}#screenshot",
        Path::new(html_path)
            .canonicalize()
            .map_err(|e| format!("cannot resolve HTML path: {}", e))?
            .display()
    );

    match backend.as_str() {
        "playwright" => capture_playwright(&browser_path, &url, out_path, w, h, &backend),
        _ => capture_chromium(&browser_path, &url, out_path, w, h, &backend),
    }
}

fn capture_chromium(
    browser: &Path,
    url: &str,
    out_path: &str,
    width: u32,
    height: u32,
    backend: &str,
) -> Result<ScreenshotResult, String> {
    let output = Command::new(browser)
        .args([
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            &format!("--window-size={},{}", width, height),
            &format!("--screenshot={}", out_path),
            url,
        ])
        .output()
        .map_err(|e| format!("failed to launch browser: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("browser exited with error: {}", stderr));
    }

    if !Path::new(out_path).exists() {
        return Err("screenshot file was not created".to_string());
    }

    Ok(ScreenshotResult {
        backend: backend.to_string(),
        output_path: out_path.to_string(),
    })
}

fn capture_playwright(
    playwright: &Path,
    url: &str,
    out_path: &str,
    width: u32,
    height: u32,
    backend: &str,
) -> Result<ScreenshotResult, String> {
    // Use playwright screenshot command
    let output = Command::new(playwright)
        .args([
            "screenshot",
            "--viewport-size",
            &format!("{},{}", width, height),
            url,
            out_path,
        ])
        .output()
        .map_err(|e| format!("failed to launch playwright: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("playwright exited with error: {}", stderr));
    }

    if !Path::new(out_path).exists() {
        return Err("screenshot file was not created".to_string());
    }

    Ok(ScreenshotResult {
        backend: backend.to_string(),
        output_path: out_path.to_string(),
    })
}

/// Capture an HTML file to a PDF file using headless browser.
/// This mirrors the C# ExporterInvoker approach.
pub fn capture_pdf(
    html_path: &str,
    out_path: &str,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let (backend, browser_path) = find_browser().ok_or_else(|| {
        "no_screenshot_backend: no headless browser found (tried playwright, chromium, chrome, edge, firefox)".to_string()
    })?;

    // Ensure output directory exists
    if let Some(parent) = Path::new(out_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create output dir: {}", e))?;
    }

    let url = format!(
        "file://{}",
        Path::new(html_path)
            .canonicalize()
            .map_err(|e| format!("cannot resolve HTML path: {}", e))?
            .display()
    );

    // Use Chromium/Chrome/Edge headless print-to-pdf
    match backend.as_str() {
        "playwright" => {
            // Playwright doesn't have a direct PDF CLI, use its Chromium backend
            // Fall through to chromium approach with --print-to-pdf
            let pw_chromium = find_playwright_chromium();
            if let Some(chrome_path) = pw_chromium {
                return capture_pdf_chromium(
                    &chrome_path,
                    &url,
                    out_path,
                    width,
                    height,
                    "playwright/chromium",
                );
            }
            // Fallback: try any chromium
            capture_pdf_via_any_browser(&url, out_path, width, height)
        }
        _ => capture_pdf_chromium(&browser_path, &url, out_path, width, height, &backend),
    }
}

fn capture_pdf_chromium(
    browser: &Path,
    url: &str,
    out_path: &str,
    width: u32,
    height: u32,
    _backend: &str,
) -> Result<String, String> {
    let output = Command::new(browser)
        .args([
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            &format!("--window-size={},{}", width, height),
            &format!("--print-to-pdf={}", out_path),
            url,
        ])
        .output()
        .map_err(|e| format!("failed to launch browser: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("browser PDF export error: {}", stderr));
    }

    if !Path::new(out_path).exists() {
        return Err("PDF file was not created".to_string());
    }

    Ok(out_path.to_string())
}

fn capture_pdf_via_any_browser(
    url: &str,
    out_path: &str,
    width: u32,
    height: u32,
) -> Result<String, String> {
    // Try common browser paths
    let candidates = [
        which_binary("chromium"),
        which_binary("chromium-browser"),
        which_binary("chrome"),
        which_binary("google-chrome"),
    ];
    for candidate in candidates.iter().flatten() {
        if let Ok(result) = capture_pdf_chromium(candidate, url, out_path, width, height, "auto") {
            return Ok(result);
        }
    }
    Err("no headless browser available for PDF export".to_string())
}

/// Try to find the Chromium binary bundled with Playwright.
fn find_playwright_chromium() -> Option<PathBuf> {
    // Common Playwright browser install paths
    let home = std::env::var("HOME").ok()?;
    let pw_dir = PathBuf::from(home).join(".cache/ms-playwright");
    if let Ok(entries) = std::fs::read_dir(&pw_dir) {
        for entry in entries.flatten() {
            let chrome_dir = entry
                .path()
                .join("chrome-mac/Chromium.app/Contents/MacOS/Chromium");
            if chrome_dir.exists() {
                return Some(chrome_dir);
            }
            let chrome_dir = entry.path().join("chrome-linux/chrome");
            if chrome_dir.exists() {
                return Some(chrome_dir);
            }
        }
    }
    None
}

/// Simple `which` implementation — checks PATH for an executable.
fn which_binary(name: &str) -> Result<PathBuf, ()> {
    // Check PATH
    if let Ok(path_var) = std::env::var("PATH") {
        let separator = if cfg!(windows) { ';' } else { ':' };
        for dir in path_var.split(separator) {
            let candidate = PathBuf::from(dir).join(name);
            if candidate.exists() {
                return Ok(candidate);
            }
            // On Windows, also try with .exe
            #[cfg(windows)]
            {
                let candidate_exe = PathBuf::from(dir).join(format!("{}.exe", name));
                if candidate_exe.exists() {
                    return Ok(candidate_exe);
                }
            }
        }
    }
    Err(())
}
