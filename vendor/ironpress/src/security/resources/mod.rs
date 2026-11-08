use std::path::{Path, PathBuf};

mod css;
mod loader;
mod policy;

pub(crate) use loader::{LoadedResource, ResourceLoader};
pub use policy::{InvalidRemoteHost, NetworkPolicy, RemoteHost};

/// A canonical directory that explicitly authorizes local document resources.
///
/// Canonicalizing the directory once makes later descendant checks resistant
/// to both `..` traversal and symlink escapes.
#[derive(Debug, Clone)]
pub(crate) struct AuthorizedResourceRoot {
    canonical: PathBuf,
}

/// A local path proven to be inside the configured resource root.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct AuthorizedPath(PathBuf);

impl AuthorizedPath {
    fn as_path(&self) -> &Path {
        &self.0
    }
}

/// A parsed HTTP or HTTPS URL.
#[cfg(feature = "remote")]
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct HttpUrl(url::Url);

#[cfg(feature = "remote")]
impl HttpUrl {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        let url = url::Url::parse(value).ok()?;
        matches!(url.scheme(), "http" | "https")
            .then_some(Self(url))
            .filter(|url| url.0.host().is_some())
    }

    pub(crate) fn as_str(&self) -> &str {
        self.0.as_str()
    }

    pub(crate) fn host_str(&self) -> Option<&str> {
        self.0.host_str()
    }

    pub(crate) fn host_ip(&self) -> Option<std::net::IpAddr> {
        match self.0.host()? {
            url::Host::Ipv4(ip) => Some(ip.into()),
            url::Host::Ipv6(ip) => Some(ip.into()),
            url::Host::Domain(_) => None,
        }
    }

    pub(crate) fn join(&self, location: &str) -> Option<Self> {
        let url = self.0.join(location).ok()?;
        matches!(url.scheme(), "http" | "https").then_some(Self(url))
    }
}

/// The only resource states accepted by the byte-loading boundary.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum ResolvedResource {
    Inline(String),
    Fragment(String),
    Local(AuthorizedPath),
    #[cfg(feature = "remote")]
    Remote(HttpUrl),
    #[cfg(not(feature = "remote"))]
    Remote(String),
}

impl ResolvedResource {
    pub(crate) fn reference(&self) -> String {
        match self {
            Self::Inline(reference) | Self::Fragment(reference) => reference.clone(),
            Self::Local(path) => path.as_path().to_string_lossy().into_owned(),
            #[cfg(feature = "remote")]
            Self::Remote(url) => url.as_str().to_string(),
            #[cfg(not(feature = "remote"))]
            Self::Remote(url) => url.clone(),
        }
    }
}

impl AuthorizedResourceRoot {
    pub(crate) fn parse(path: &Path) -> Option<Self> {
        let canonical = path.canonicalize().ok()?;
        canonical.is_dir().then_some(Self { canonical })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.canonical
    }

    fn contains(&self, path: &Path) -> bool {
        path.starts_with(&self.canonical)
    }

    fn resolve(&self, base: &Path, reference: &str) -> Option<PathBuf> {
        let reference = Path::new(reference);
        let candidate = if reference.is_absolute() {
            reference.to_path_buf()
        } else {
            base.join(reference)
        };
        let canonical = candidate.canonicalize().ok()?;
        canonical.starts_with(&self.canonical).then_some(canonical)
    }
}

/// Resource resolution policy carried through one document conversion.
///
/// The optional root is the sole authority for local files. HTML sanitization
/// is independent from both local and remote resource access.
#[derive(Debug, Clone)]
pub(crate) struct DocumentResources {
    base: Option<PathBuf>,
    root: Option<AuthorizedResourceRoot>,
    #[cfg_attr(not(feature = "remote"), allow(dead_code))]
    network: NetworkPolicy,
}

impl DocumentResources {
    pub(crate) fn new(
        base_path: Option<&Path>,
        authorized_root: Option<&Path>,
        network: NetworkPolicy,
    ) -> Self {
        let root = authorized_root
            .or(base_path)
            .and_then(AuthorizedResourceRoot::parse);
        let base = match base_path {
            Some(path) => path
                .canonicalize()
                .ok()
                .filter(|path| path.is_dir())
                .filter(|path| root.as_ref().is_none_or(|root| root.contains(path))),
            None => root
                .as_ref()
                .map(AuthorizedResourceRoot::path)
                .map(Path::to_path_buf),
        };
        Self {
            base,
            root,
            network,
        }
    }

    pub(crate) fn base_path(&self) -> Option<&Path> {
        self.base.as_deref()
    }

    pub(crate) fn has_authorized_root(&self) -> bool {
        self.root.is_some()
    }

    /// Resolve a resource reference at an HTML/CSS boundary.
    ///
    /// The returned local reference is canonical and therefore carries proof
    /// that it is inside the authorized root. A denied reference is represented
    /// by `None`, not by a path-shaped string that later code must revalidate.
    pub(crate) fn resolve(&self, reference: &str, base: Option<&Path>) -> Option<ResolvedResource> {
        let reference = reference.trim();
        match RawResource::parse(reference)? {
            RawResource::Inline => Some(ResolvedResource::Inline(reference.to_string())),
            RawResource::Fragment => Some(ResolvedResource::Fragment(reference.to_string())),
            RawResource::Remote => resolve_http_url(reference).map(ResolvedResource::Remote),
            RawResource::UnsupportedScheme => None,
            RawResource::Local => self.root.as_ref().and_then(|root| {
                root.resolve(
                    base.or_else(|| self.base_path())
                        .unwrap_or_else(|| root.path()),
                    reference,
                )
                .map(AuthorizedPath)
                .map(ResolvedResource::Local)
            }),
        }
    }

    /// Rewrite every actual CSS `url()` token through the document resource
    /// policy. Text inside comments and strings is deliberately untouched.
    pub(crate) fn rewrite_css_urls(&self, css: &str, base: Option<&Path>) -> String {
        css::rewrite(css, self, base)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RawResource {
    Inline,
    Fragment,
    Remote,
    Local,
    UnsupportedScheme,
}

impl RawResource {
    fn parse(reference: &str) -> Option<Self> {
        if reference.is_empty() {
            return None;
        }
        if reference.starts_with('#') {
            return Some(Self::Fragment);
        }
        if starts_ascii_case_insensitive(reference, "data:") {
            return Some(Self::Inline);
        }
        if reference.starts_with("//")
            || starts_ascii_case_insensitive(reference, "http://")
            || starts_ascii_case_insensitive(reference, "https://")
        {
            return Some(Self::Remote);
        }
        if has_explicit_scheme(reference) {
            return Some(Self::UnsupportedScheme);
        }
        Some(Self::Local)
    }
}

#[cfg(feature = "remote")]
fn resolve_http_url(reference: &str) -> Option<HttpUrl> {
    HttpUrl::parse(reference)
}

#[cfg(not(feature = "remote"))]
fn resolve_http_url(reference: &str) -> Option<String> {
    starts_ascii_case_insensitive(reference, "http://")
        .then_some(reference)
        .or_else(|| starts_ascii_case_insensitive(reference, "https://").then_some(reference))
        .map(str::to_string)
}

fn has_explicit_scheme(reference: &str) -> bool {
    let Some(colon) = reference.find(':') else {
        return false;
    };
    let scheme = &reference[..colon];
    !scheme.is_empty()
        && scheme.bytes().enumerate().all(|(index, byte)| {
            matches!(
                (index, byte),
                (0, b'a'..=b'z' | b'A'..=b'Z')
                    | (_, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'+' | b'-' | b'.')
            )
        })
}

fn starts_ascii_case_insensitive(value: &str, prefix: &str) -> bool {
    value
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

impl Default for DocumentResources {
    fn default() -> Self {
        Self::new(None, None, NetworkPolicy::default())
    }
}

#[cfg(test)]
mod tests;
