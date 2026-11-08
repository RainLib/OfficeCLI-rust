use super::*;
use std::fs;

#[test]
fn remote_host_parses_exact_hosts_and_subdomain_suffixes() {
    assert_eq!(
        "CDN.Example.COM."
            .parse::<RemoteHost>()
            .unwrap()
            .to_string(),
        "cdn.example.com"
    );
    assert_eq!(
        ".Example.COM".parse::<RemoteHost>().unwrap().to_string(),
        ".example.com"
    );
    assert_eq!("::1".parse::<RemoteHost>().unwrap().to_string(), "::1");
}

#[test]
fn remote_host_rejects_urls_ports_and_invalid_suffixes() {
    for host in [
        "https://example.com",
        "example.com:443",
        "example.com/path",
        ".127.0.0.1",
        ".::1",
        "-bad.example",
    ] {
        assert!(
            host.parse::<RemoteHost>().is_err(),
            "{host} must be rejected"
        );
    }
}

#[test]
fn data_uri_percent_encoding_is_decoded_at_the_load_boundary() {
    let loaded = ResourceLoader::default()
        .load_document_resource("data:image/svg+xml,%3Csvg%3Ehello%20world%3C/svg%3E")
        .expect("valid data URI");
    assert_eq!(loaded.bytes, b"<svg>hello world</svg>");
    assert_eq!(loaded.media_type.as_deref(), Some("image/svg+xml"));
}

fn test_root() -> (tempfile::TempDir, DocumentResources) {
    let directory = tempfile::tempdir().expect("temporary resource root");
    fs::create_dir(directory.path().join("images")).expect("image directory");
    fs::write(directory.path().join("images/ok.png"), b"png").expect("image fixture");
    let resources = DocumentResources::new(Some(directory.path()), None, NetworkPolicy::default());
    (directory, resources)
}

#[test]
fn sanitized_local_reference_requires_an_authorized_root() {
    let resources = DocumentResources::default();
    assert_eq!(resources.resolve("../../private.png", None), None);
    assert_eq!(
        resources.rewrite_css_urls("a{background:url(../../private.png)}", None),
        "a{background:url(\"\")}"
    );
}

#[test]
fn protocol_relative_and_unsupported_schemes_never_become_local_paths() {
    let (directory, resources) = test_root();

    for reference in ["//127.0.0.1/secret", "file:///etc/passwd", "gopher://host/"] {
        assert_eq!(
            resources.resolve(reference, Some(directory.path())),
            None,
            "{reference} must not cross into the local path branch"
        );
    }
}

#[test]
fn authorized_root_rewrites_descendants_and_rejects_traversal() {
    let (directory, resources) = test_root();
    let resolved = resources
        .resolve("images/ok.png", Some(directory.path()))
        .expect("authorized descendant");
    let ResolvedResource::Local(path) = resolved else {
        panic!("authorized local reference must remain a local resource");
    };
    assert!(path.as_path().is_absolute());
    assert!(path.as_path().ends_with("images/ok.png"));
    assert_eq!(
        resources.resolve("../outside.png", Some(directory.path())),
        None
    );
}

#[test]
fn distinct_base_and_root_allow_shared_ancestor_assets_only() {
    let root = tempfile::tempdir().expect("authorized root");
    let base = root.path().join("cases/fonts");
    fs::create_dir_all(&base).expect("document base");
    fs::create_dir(root.path().join("fonts")).expect("shared font directory");
    fs::write(root.path().join("fonts/Parity.ttf"), b"font").expect("shared font");
    let outside = tempfile::tempdir().expect("outside directory");
    fs::write(outside.path().join("secret.ttf"), b"secret").expect("outside font");

    let resources =
        DocumentResources::new(Some(&base), Some(root.path()), NetworkPolicy::default());
    let resolved = resources
        .resolve("../../fonts/Parity.ttf", resources.base_path())
        .expect("shared asset inside the explicit root");
    let ResolvedResource::Local(path) = resolved else {
        panic!("authorized font reference must remain a local resource");
    };
    assert!(path.as_path().ends_with("fonts/Parity.ttf"));
    assert_eq!(
        resources.resolve(
            outside
                .path()
                .join("secret.ttf")
                .to_str()
                .expect("UTF-8 fixture path"),
            None
        ),
        None
    );
}

#[test]
fn base_outside_explicit_root_denies_relative_resources() {
    let root = tempfile::tempdir().expect("authorized root");
    let outside = tempfile::tempdir().expect("outside base");
    fs::write(outside.path().join("secret.png"), b"secret").expect("outside resource");
    let resources = DocumentResources::new(
        Some(outside.path()),
        Some(root.path()),
        NetworkPolicy::default(),
    );

    assert_eq!(resources.base_path(), None);
    assert_eq!(resources.resolve("secret.png", None), None);
}

#[cfg(unix)]
#[test]
fn authorized_root_rejects_symlink_escape() {
    use std::os::unix::fs::symlink;

    let (directory, resources) = test_root();
    let outside = tempfile::tempdir().expect("outside directory");
    fs::write(outside.path().join("secret.png"), b"secret").expect("outside fixture");
    symlink(outside.path(), directory.path().join("linked")).expect("symlink fixture");

    assert_eq!(
        resources.resolve("linked/secret.png", Some(directory.path())),
        None
    );
}

#[test]
fn css_rewriter_ignores_comments_and_strings() {
    let resources = DocumentResources::default();
    let css =
        r#"/* url(secret.png) */ a::before{content:"url(secret.png)";background:url(secret.png)}"#;
    assert_eq!(
        resources.rewrite_css_urls(css, None),
        r#"/* url(secret.png) */ a::before{content:"url(secret.png)";background:url("")}"#
    );
}

#[test]
fn sanitized_css_preserves_inline_and_fragment_urls() {
    let resources = DocumentResources::default();
    let css = "a{filter:url(#fx);background:url(DATA:image/png;base64,AA==)}";
    assert_eq!(
        resources.rewrite_css_urls(css, None),
        "a{filter:url(\"#fx\");background:url(\"DATA:image/png;base64,AA==\")}"
    );
}

#[cfg(feature = "remote")]
#[test]
fn distinct_remote_resources_are_preloaded_concurrently() {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::time::{Duration, Instant};

    fn accept_before(listener: &TcpListener, deadline: Instant) -> Option<TcpStream> {
        loop {
            match listener.accept() {
                Ok((stream, _)) => return Some(stream),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return None;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return None,
            }
        }
    }

    fn respond(mut stream: TcpStream) {
        let mut request = [0; 1024];
        let _ = stream.read(&mut request);
        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nHELLO");
    }

    let listener = TcpListener::bind("127.0.0.1:0").expect("loopback fixture");
    listener
        .set_nonblocking(true)
        .expect("non-blocking fixture");
    let port = listener.local_addr().expect("fixture address").port();
    let first_url = format!("http://127.0.0.1:{port}/first");
    let second_url = format!("http://127.0.0.1:{port}/second");
    let policy = NetworkPolicy::default()
        .with_allow_list(["127.0.0.1".parse().expect("valid loopback host")]);
    let resources = DocumentResources::new(None, None, policy);
    let mut loader = ResourceLoader::new(resources);

    let connected_concurrently = std::thread::scope(|scope| {
        let preload = scope.spawn(|| {
            loader.preload_document_resources([first_url.as_str(), second_url.as_str()]);
        });
        let first = accept_before(&listener, Instant::now() + Duration::from_secs(1))
            .expect("first remote connection");
        let second = accept_before(&listener, Instant::now() + Duration::from_secs(1));
        if let Some(second) = second {
            respond(first);
            respond(second);
            preload.join().expect("preload worker");
            true
        } else {
            respond(first);
            let second = accept_before(&listener, Instant::now() + Duration::from_secs(1))
                .expect("sequential fallback connection");
            respond(second);
            preload.join().expect("preload worker");
            false
        }
    });

    assert!(
        connected_concurrently,
        "both requests must start before either response completes"
    );
    assert_eq!(
        loader
            .load_document_resource(&first_url)
            .expect("cached first resource")
            .bytes,
        b"HELLO"
    );
}
