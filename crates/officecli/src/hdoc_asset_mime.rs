/// Only identify supported raster signatures for generic binary assets.
/// Active formats such as SVG must never be inferred from untrusted bytes.
pub(crate) fn asset_mime(extension: &str, bytes: &[u8]) -> &'static str {
    let extension = if extension == "bin" {
        ["png", "jpg", "gif", "webp"]
            .into_iter()
            .find(|kind| image_magic(kind, bytes))
            .unwrap_or(extension)
    } else {
        extension
    };
    match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

pub(crate) fn image_magic(extension: &str, bytes: &[u8]) -> bool {
    match extension {
        "png" => bytes.len() >= 8 && bytes[..8] == [137, 80, 78, 71, 13, 10, 26, 10],
        "jpg" | "jpeg" => bytes.len() >= 3 && bytes[..3] == [0xff, 0xd8, 0xff],
        "gif" => bytes.len() >= 6 && matches!(&bytes[..6], b"GIF87a" | b"GIF89a"),
        "webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::asset_mime;

    #[test]
    fn generic_assets_only_infer_supported_raster_types() {
        for (bytes, expected) in [
            (b"\x89PNG\r\n\x1a\n".as_slice(), "image/png"),
            (b"\xff\xd8\xff".as_slice(), "image/jpeg"),
            (b"GIF89a".as_slice(), "image/gif"),
            (b"RIFF\x00\x00\x00\x00WEBP".as_slice(), "image/webp"),
            (b"<svg/>".as_slice(), "application/octet-stream"),
            (b"\x89PNG".as_slice(), "application/octet-stream"),
        ] {
            assert_eq!(asset_mime("bin", bytes), expected);
        }
        assert_eq!(asset_mime("txt", b"GIF89a"), "application/octet-stream");
    }
}
