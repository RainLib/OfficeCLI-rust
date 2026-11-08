//! SSRF controls for the optional remote-resource transport.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use ureq::config::Config;
use ureq::http::Uri;
use ureq::unversioned::resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{DefaultConnector, NextTimeout};

use super::resources::{HttpUrl, NetworkPolicy};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UrlDecision {
    Reject,
    Allow,
    Classify,
}

fn url_decision(url: &HttpUrl, policy: &NetworkPolicy) -> UrlDecision {
    let Some(host) = url.host_str() else {
        return UrlDecision::Reject;
    };
    if policy.deny.iter().any(|entry| entry.matches(host)) {
        UrlDecision::Reject
    } else if policy.allow.iter().any(|entry| entry.matches(host)) {
        UrlDecision::Allow
    } else {
        UrlDecision::Classify
    }
}

fn address_allowed(ip: IpAddr, policy: &NetworkPolicy) -> bool {
    let globally_reachable = match ip {
        IpAddr::V4(ip) => core_net::Ipv4Addr::from(ip.octets()).is_global(),
        IpAddr::V6(ip) => core_net::Ipv6Addr::from(ip.octets()).is_global(),
    };
    let non_public = bogon::is_bogon(ip) || !globally_reachable;
    !((policy.deny_private_ips && non_public) || (policy.deny_public_ips && !non_public))
}

/// Fetch one parsed URL while checking every redirect and connected address.
pub(crate) fn fetch_authorized(url: &HttpUrl, policy: &NetworkPolicy) -> Option<Vec<u8>> {
    let mut current = url.clone();
    let mut redirects_left = policy.max_redirects;
    loop {
        let bypass_ip_checks = match url_decision(&current, policy) {
            UrlDecision::Reject => return None,
            UrlDecision::Allow => true,
            UrlDecision::Classify => false,
        };
        if !bypass_ip_checks
            && let Some(ip) = current.host_ip()
            && !address_allowed(ip, policy)
        {
            return None;
        }

        let response = pinned_agent(policy, bypass_ip_checks)
            .get(current.as_str())
            .call()
            .ok()?;
        if response.status().is_redirection() {
            if redirects_left == 0 {
                return None;
            }
            redirects_left -= 1;
            let location = response.headers().get("location")?.to_str().ok()?;
            current = current.join(location)?;
            continue;
        }

        let declared_size = response
            .headers()
            .get("content-length")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok());
        if declared_size.is_some_and(|size| size > policy.max_body_size) {
            return None;
        }
        return response
            .into_body()
            .with_config()
            .limit(policy.max_body_size)
            .read_to_vec()
            .ok();
    }
}

fn pinned_agent(policy: &NetworkPolicy, bypass_ip_checks: bool) -> ureq::Agent {
    let config = Config::builder().max_redirects(0).build();
    let resolver = PinnedResolver {
        policy: policy.clone(),
        bypass_ip_checks,
    };
    ureq::Agent::with_parts(config, DefaultConnector::default(), resolver)
}

/// The resolver filters the exact addresses handed to the connector.
///
/// Environment proxies remain enabled and their connection hop is trusted as
/// operator configuration. If a proxy resolves the final host, literal target
/// IPs and host lists are still checked here; final-hop IP policy belongs at
/// that proxy.
#[derive(Debug)]
struct PinnedResolver {
    policy: NetworkPolicy,
    bypass_ip_checks: bool,
}

impl Resolver for PinnedResolver {
    fn resolve(
        &self,
        uri: &Uri,
        config: &Config,
        timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let resolved = DefaultResolver::default().resolve(uri, config, timeout)?;
        if is_configured_proxy(uri, config)
            || self.bypass_ip_checks
            || (!self.policy.deny_private_ips && !self.policy.deny_public_ips)
        {
            return Ok(resolved);
        }

        let mut allowed =
            ResolvedSocketAddrs::from_fn(|_| SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0));
        for address in resolved.iter().copied() {
            if address_allowed(address.ip(), &self.policy) {
                allowed.push(address);
            }
        }
        if allowed.is_empty() {
            Err(ureq::Error::HostNotFound)
        } else {
            Ok(allowed)
        }
    }
}

fn is_configured_proxy(uri: &Uri, config: &Config) -> bool {
    config.proxy().is_some_and(|proxy| {
        uri.scheme() == proxy.uri().scheme() && uri.authority() == proxy.uri().authority()
    })
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;
    use crate::security::resources::RemoteHost;

    fn parsed(url: &str) -> HttpUrl {
        HttpUrl::parse(url).expect("valid HTTP test URL")
    }

    #[test]
    fn mixed_case_url_is_matched_against_the_deny_list() {
        let policy = NetworkPolicy::default()
            .with_deny_list(["blocked.example".parse().expect("valid host pattern")]);
        assert_eq!(
            url_decision(&parsed("HTTP://BLOCKED.EXAMPLE/image.png"), &policy),
            UrlDecision::Reject
        );
    }

    #[test]
    fn policy_matches_only_the_parsed_host() {
        let suffix: RemoteHost = ".example.com".parse().expect("valid suffix");
        let policy = NetworkPolicy::default().with_allow_list([suffix]);
        assert_eq!(
            url_decision(&parsed("https://cdn.example.com/image"), &policy),
            UrlDecision::Allow
        );
        assert_eq!(
            url_decision(&parsed("https://example.com/image"), &policy),
            UrlDecision::Classify
        );
        assert_eq!(
            url_decision(&parsed("https://cdn.example.com@127.0.0.1/image"), &policy),
            UrlDecision::Classify
        );
    }

    #[test]
    fn deny_entry_wins_over_an_allow_entry() {
        let host: RemoteHost = "blocked.example".parse().expect("valid host");
        let policy = NetworkPolicy::default()
            .with_allow_list([host.clone()])
            .with_deny_list([host]);

        assert_eq!(
            url_decision(&parsed("https://blocked.example/image"), &policy),
            UrlDecision::Reject
        );
    }

    #[test]
    fn alternate_ipv4_syntax_is_normalized_before_classification() {
        let url = parsed("http://2130706433/image");
        let loopback = "127.0.0.1".parse().expect("valid loopback fixture");

        assert_eq!(url.host_ip(), Some(loopback));
        assert!(!address_allowed(loopback, &NetworkPolicy::default()));
    }

    #[test]
    fn iana_non_global_addresses_are_denied_by_default() {
        let policy = NetworkPolicy::default();
        for address in [
            "0.1.2.3",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "192.0.0.1",
            "192.0.2.1",
            "192.168.0.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "::1",
            "100::1",
            "2001:2::1",
            "2001:db8::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::127.0.0.1",
            "2002:7f00:1::",
            "64:ff9b::7f00:1",
            "64:ff9b:1::7f00:1",
        ] {
            let ip = address.parse().expect("valid IANA fixture");
            assert!(!address_allowed(ip, &policy), "{address} must be denied");
        }
    }

    #[test]
    fn allocated_public_addresses_are_allowed_by_default() {
        let policy = NetworkPolicy::default();
        for address in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            let ip = address.parse().expect("valid public fixture");
            assert!(address_allowed(ip, &policy), "{address} must be allowed");
        }
    }

    #[test]
    fn address_class_controls_can_be_inverted() {
        let policy = NetworkPolicy::default()
            .deny_private_ips(false)
            .deny_public_ips(true);
        let private = "127.0.0.1".parse().expect("valid private fixture");
        let public = "1.1.1.1".parse().expect("valid public fixture");

        assert!(address_allowed(private, &policy));
        assert!(!address_allowed(public, &policy));
    }

    #[test]
    fn configured_proxy_hop_is_recognized_as_operator_owned() {
        let proxy = ureq::Proxy::new("http://127.0.0.1:8123").unwrap();
        let config = Config::builder().proxy(Some(proxy)).build();
        let proxy_uri: Uri = "http://127.0.0.1:8123".parse().unwrap();
        let target_uri: Uri = "http://127.0.0.1:9000".parse().unwrap();

        assert!(is_configured_proxy(&proxy_uri, &config));
        assert!(!is_configured_proxy(&target_uri, &config));
    }

    fn server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback fixture");
        let port = listener.local_addr().expect("fixture address").port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                respond(stream, port);
            }
        });
        port
    }

    fn respond(mut stream: std::net::TcpStream, port: u16) {
        let mut request = [0; 1024];
        let read = stream.read(&mut request).unwrap_or(0);
        let request = String::from_utf8_lossy(&request[..read]);
        let path = request.split_whitespace().nth(1).unwrap_or("/");
        let response = match path {
            "/ok" => "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nHELLO".to_string(),
            "/redirect" => format!(
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/ok\r\nContent-Length: 0\r\n\r\n"
            ),
            "/large" => format!(
                "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{}",
                "x".repeat(100)
            ),
            _ => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_string(),
        };
        let _ = stream.write_all(response.as_bytes());
    }

    fn allow_loopback() -> NetworkPolicy {
        NetworkPolicy::default()
            .with_allow_list(["127.0.0.1".parse().expect("valid loopback host")])
    }

    #[test]
    fn default_policy_blocks_private_literal() {
        let url = parsed(&format!("http://127.0.0.1:{}/ok", server()));
        assert!(fetch_authorized(&url, &NetworkPolicy::default()).is_none());
    }

    #[test]
    fn default_policy_blocks_a_hostname_resolving_to_loopback() {
        let url = parsed(&format!("http://localhost:{}/ok", server()));
        assert!(fetch_authorized(&url, &NetworkPolicy::default()).is_none());
    }

    #[test]
    fn allow_entry_can_authorize_a_private_host() {
        let url = parsed(&format!("http://127.0.0.1:{}/ok", server()));
        assert_eq!(
            fetch_authorized(&url, &allow_loopback()).as_deref(),
            Some(b"HELLO".as_slice())
        );
    }

    #[test]
    fn redirects_are_rechecked_and_bounded() {
        let url = parsed(&format!("http://127.0.0.1:{}/redirect", server()));
        assert_eq!(
            fetch_authorized(&url, &allow_loopback()).as_deref(),
            Some(b"HELLO".as_slice())
        );
        assert!(fetch_authorized(&url, &allow_loopback().max_redirects(0)).is_none());
    }

    #[test]
    fn redirect_to_a_non_allowed_private_host_is_rejected() {
        let url = parsed(&format!("http://localhost:{}/redirect", server()));
        let policy = NetworkPolicy::default()
            .with_allow_list(["localhost".parse().expect("valid fixture host")]);

        assert!(fetch_authorized(&url, &policy).is_none());
    }

    #[test]
    fn response_body_limit_is_enforced() {
        let url = parsed(&format!("http://127.0.0.1:{}/large", server()));
        assert!(fetch_authorized(&url, &allow_loopback().max_body_size(10)).is_none());
    }
}
