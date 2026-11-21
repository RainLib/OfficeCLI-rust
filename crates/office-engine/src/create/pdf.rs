use super::*;

pub(crate) fn create_blank_pdf(path: &str) -> Result<String, HandlerError> {
    use lopdf::{dictionary, Document, Object, Stream};

    let mut doc = Document::with_version("1.4");

    // Pages root ID
    let pages_id = doc.new_object_id();

    // Page 1 ID
    let page_id = doc.new_object_id();

    // Content stream ID (empty content)
    let content_dict = dictionary! {};
    let content_id = doc.add_object(Object::Stream(Stream::new(content_dict, vec![])));

    // Page dictionary
    let page_dict = dictionary! {
        "Type" => Object::Name(b"Page".to_vec()),
        "Parent" => Object::Reference(pages_id),
        "MediaBox" => Object::Array(vec![
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(595),
            Object::Integer(842),
        ]),
        "Resources" => Object::Dictionary(dictionary! {}),
        "Contents" => Object::Reference(content_id),
    };
    doc.set_object(page_id, Object::Dictionary(page_dict));

    // Pages dictionary
    let pages_dict = dictionary! {
        "Type" => Object::Name(b"Pages".to_vec()),
        "Kids" => Object::Array(vec![Object::Reference(page_id)]),
        "Count" => Object::Integer(1),
    };
    doc.set_object(pages_id, Object::Dictionary(pages_dict));

    // Catalog dictionary
    let catalog_id = doc.new_object_id();
    let catalog_dict = dictionary! {
        "Type" => Object::Name(b"Catalog".to_vec()),
        "Pages" => Object::Reference(pages_id),
    };
    doc.set_object(catalog_id, Object::Dictionary(catalog_dict));

    doc.trailer.set("Root", Object::Reference(catalog_id));

    doc.save(path)
        .map_err(|e| HandlerError::SaveError(e.to_string()))?;

    Ok(format!("Created blank PDF document: {}", path))
}
