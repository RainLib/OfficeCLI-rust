use std::fmt;
use std::str::FromStr;

/// A parsed host entry used by the remote allow and deny lists.
///
/// `example.com` matches only that host. `.example.com` matches subdomains,
/// but not the apex. Parse entries with [`str::parse`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteHost {
    name: String,
    subdomains: bool,
}

impl RemoteHost {
    #[cfg(feature = "remote")]
    pub(crate) fn matches(&self, host: &str) -> bool {
        let host = host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .trim_end_matches('.')
            .to_ascii_lowercase();
        if self.subdomains {
            host.strip_suffix(&self.name)
                .is_some_and(|prefix| prefix.ends_with('.') && prefix.len() > 1)
        } else {
            host == self.name
        }
    }
}

impl FromStr for RemoteHost {
    type Err = InvalidRemoteHost;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let value = value.trim();
        let (subdomains, host) = value
            .strip_prefix('.')
            .map_or((false, value), |host| (true, host));
        if host.is_empty() {
            return Err(InvalidRemoteHost);
        }
        let name = if let Ok(ip) = host.parse::<std::net::IpAddr>() {
            if subdomains {
                return Err(InvalidRemoteHost);
            }
            ip.to_string()
        } else {
            parse_dns_host(host).ok_or(InvalidRemoteHost)?
        };

        Ok(Self { name, subdomains })
    }
}

impl fmt::Display for RemoteHost {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.subdomains {
            formatter.write_str(".")?;
        }
        formatter.write_str(&self.name)
    }
}

/// Error returned when a remote host pattern contains a URL, port, or path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidRemoteHost;

impl fmt::Display for InvalidRemoteHost {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("expected a host name, IP address, or .example.com suffix")
    }
}

impl std::error::Error for InvalidRemoteHost {}

fn parse_dns_host(host: &str) -> Option<String> {
    let name = host.trim_end_matches('.').to_ascii_lowercase();
    let valid = !name.is_empty()
        && name.len() <= 253
        && name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        });
    valid.then_some(name)
}

/// Controls every HTTP and HTTPS resource requested by one conversion.
///
/// Public addresses are allowed by default. Non-public addresses, including
/// loopback, private, link-local, metadata, multicast, documentation, and
/// reserved ranges, are denied. A deny entry wins over an allow entry. An
/// allow entry bypasses the address-class checks while retaining DNS pinning.
#[derive(Debug, Clone)]
pub struct NetworkPolicy {
    pub(crate) allow: Vec<RemoteHost>,
    pub(crate) deny: Vec<RemoteHost>,
    pub(crate) deny_private_ips: bool,
    pub(crate) deny_public_ips: bool,
    pub(crate) max_redirects: u32,
    pub(crate) max_body_size: u64,
}

impl NetworkPolicy {
    /// Replace the host allow list.
    pub fn with_allow_list(mut self, hosts: impl IntoIterator<Item = RemoteHost>) -> Self {
        self.allow = hosts.into_iter().collect();
        self
    }

    /// Replace the host deny list.
    pub fn with_deny_list(mut self, hosts: impl IntoIterator<Item = RemoteHost>) -> Self {
        self.deny = hosts.into_iter().collect();
        self
    }

    /// Enable or disable rejection of non-public target addresses.
    ///
    /// This is enabled by default. When an environment proxy resolves the
    /// final host, Ironpress can classify only target IP literals. The operator
    /// must enforce the same rule at that trusted proxy.
    pub fn deny_private_ips(mut self, deny: bool) -> Self {
        self.deny_private_ips = deny;
        self
    }

    /// Enable or disable rejection of public target addresses.
    ///
    /// With an environment proxy that resolves the final host, Ironpress can
    /// classify only IP literals. Host lists still apply to the target URL.
    pub fn deny_public_ips(mut self, deny: bool) -> Self {
        self.deny_public_ips = deny;
        self
    }

    /// Set the maximum redirect count. Every target is checked again.
    pub fn max_redirects(mut self, max: u32) -> Self {
        self.max_redirects = max;
        self
    }

    /// Set the maximum accepted response body size in bytes.
    pub fn max_body_size(mut self, max: u64) -> Self {
        self.max_body_size = max;
        self
    }
}

impl Default for NetworkPolicy {
    fn default() -> Self {
        Self {
            allow: Vec::new(),
            deny: Vec::new(),
            deny_private_ips: true,
            deny_public_ips: false,
            max_redirects: 8,
            max_body_size: 10 * 1024 * 1024,
        }
    }
}
