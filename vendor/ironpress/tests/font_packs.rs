use ironpress::{FontPack, FontPackKind, HtmlConverter};

#[test]
fn font_pack_kind_parses_published_package_names() {
    assert_eq!(
        "cjk-jp".parse::<FontPackKind>().unwrap(),
        FontPackKind::CjkJapanese
    );
    assert_eq!(
        "cjk-kr".parse::<FontPackKind>().unwrap(),
        FontPackKind::CjkKorean
    );
    assert_eq!(
        "cjk-sc".parse::<FontPackKind>().unwrap(),
        FontPackKind::CjkSimplifiedChinese
    );
    assert_eq!(
        "cjk-tc".parse::<FontPackKind>().unwrap(),
        FontPackKind::CjkTraditionalChinese
    );
    assert_eq!(
        "emoji".parse::<FontPackKind>().unwrap(),
        FontPackKind::Emoji
    );
}

#[test]
fn font_pack_rejects_invalid_font_data_at_the_boundary() {
    let error = FontPack::parse(FontPackKind::Emoji, b"not a font".to_vec()).unwrap_err();

    assert!(error.to_string().contains("emoji"));
    assert!(error.to_string().contains("valid TrueType font"));
}

#[test]
fn japanese_pack_is_used_for_japanese_content() {
    let pack = FontPack::parse(
        FontPackKind::CjkJapanese,
        include_bytes!("fonts/IronpressCjkVertical.ttf").to_vec(),
    )
    .unwrap();

    let pdf = HtmlConverter::new()
        .add_font_pack(pack)
        .convert("<p lang='ja'>第</p>")
        .unwrap();
    let pdf_text = String::from_utf8_lossy(&pdf);

    assert!(pdf_text.contains("DroidSansFallback"));
}

#[test]
fn emoji_pack_is_used_for_emoji_content() {
    let pack = FontPack::parse(
        FontPackKind::Emoji,
        include_bytes!("fonts/NotoEmoji-TestSubset.ttf").to_vec(),
    )
    .unwrap();

    let pdf = HtmlConverter::new()
        .add_font_pack(pack)
        .convert("<p>😀</p>")
        .unwrap();
    let pdf_text = String::from_utf8_lossy(&pdf);

    assert!(pdf_text.contains("NotoEmoji"));
}

#[test]
fn mixed_text_uses_each_pack_without_losing_the_primary_font() {
    let japanese = FontPack::parse(
        FontPackKind::CjkJapanese,
        include_bytes!("fonts/IronpressCjkVertical.ttf").to_vec(),
    )
    .unwrap();
    let emoji = FontPack::parse(
        FontPackKind::Emoji,
        include_bytes!("fonts/NotoEmoji-TestSubset.ttf").to_vec(),
    )
    .unwrap();

    let pdf = HtmlConverter::new()
        .add_font_pack(japanese)
        .add_font_pack(emoji)
        .convert("<p lang='ja'>Hello 第 😀</p>")
        .unwrap();
    let pdf_text = String::from_utf8_lossy(&pdf);

    assert!(pdf_text.contains("DroidSansFallback"));
    assert!(pdf_text.contains("NotoEmoji"));
}
