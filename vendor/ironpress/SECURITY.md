# Security policy

## Supported versions

Security fixes are released for the latest published Ironpress version. Older
versions are not supported. Please reproduce a suspected vulnerability with the
latest release before reporting it when that is safe to do.

## Report a vulnerability

Do not open a public issue for a suspected security vulnerability.

Use [GitHub private vulnerability reporting][private-report] to send the report
to the maintainers. Include as much of the following information as possible:

- The affected Ironpress version and language binding
- The operating system and architecture
- A minimal HTML, CSS, Markdown, image, font, or configuration input
- The security impact and the conditions required to reproduce it
- Reproduction steps or a proof of concept
- Any suggested mitigation

The maintainers will acknowledge the report, investigate it privately, and
coordinate a fix and disclosure when the report is confirmed. Please keep the
report and related discussion private until a release or coordinated disclosure
is ready.

## Scope

Reports are especially useful for vulnerabilities involving:

- HTML, CSS, SVG, image, font, or Markdown parsing
- Resource path boundaries, symlink handling, or remote resource policies
- Sanitization bypasses or unsafe URL handling
- Memory safety across the Rust, C, .NET, Java, Python, Ruby, or WebAssembly APIs
- Denial of service from untrusted document input
- Release artifacts, package integrity, or CI credentials

General bugs, unsupported CSS features, and rendering differences without a
security impact should use the public issue tracker instead.

[private-report]: https://github.com/gastongouron/ironpress/security/advisories/new
