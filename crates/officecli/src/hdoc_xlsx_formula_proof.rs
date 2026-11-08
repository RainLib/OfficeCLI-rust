//! Server-local, domain-separated attestation of an audited XLSX mapping.
//! Proofs are not part of portable archives and are never client-supplied.
use hcd_core::{Bundle, HcdError, SourceDescriptor};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Proof {
    schema: String,
    document_id: String,
    source: SourceDescriptor,
    mapping_fingerprint: String,
    audited_revision: u64,
    editable_cells_checked: usize,
}

fn key(secret: &[u8]) -> Vec<u8> {
    let mut digest = Sha256::new();
    digest.update(b"hcd-xlsx-formula-attestation-key/1\0");
    digest.update(secret);
    digest.finalize().to_vec()
}

fn location(root: &Path, document_id: &str) -> std::path::PathBuf {
    root.join("xlsx-formula-proofs")
        .join(format!("{document_id}.jwt"))
}

#[cfg(test)]
pub(super) fn downgrade_for_test(root: &Path, document_id: &str, secret: &[u8]) {
    let path = location(root, document_id);
    let token = std::fs::read_to_string(&path).unwrap();
    let mut validation = Validation::new(Algorithm::HS256);
    validation.required_spec_claims.clear();
    validation.validate_exp = false;
    validation.validate_aud = false;
    let mut proof = decode::<Proof>(&token, &DecodingKey::from_secret(&key(secret)), &validation)
        .unwrap()
        .claims;
    proof.schema = "hcd-xlsx-formula-proof/2".into();
    let legacy = encode(
        &Header::new(Algorithm::HS256),
        &proof,
        &EncodingKey::from_secret(&key(secret)),
    )
    .unwrap();
    std::fs::write(path, legacy).unwrap();
}

/// Audit fixed HCD and source snapshots before signing. A stale revision may
/// produce a harmless old proof; callers recheck the head before publishing it.
pub(super) fn create(
    bundle: &Bundle,
    source: &Path,
    root: &Path,
    secret: &[u8],
    expected_revision: u64,
) -> Result<usize, HcdError> {
    let audited =
        hcd_formats::audit_xlsx_formula_mapping_snapshot(bundle, source, Some(expected_revision))?;
    let proof = Proof {
        // Version 3 additionally audits worksheet protection; earlier proofs
        // cannot authorize writes without rechecking the original workbook.
        schema: "hcd-xlsx-formula-proof/3".into(),
        document_id: audited.document_id,
        source: audited.source,
        mapping_fingerprint: audited.mapping_fingerprint,
        audited_revision: audited.revision,
        editable_cells_checked: audited.editable_cells_checked,
    };
    let token = encode(
        &Header::new(Algorithm::HS256),
        &proof,
        &EncodingKey::from_secret(&key(secret)),
    )
    .map_err(|_| HcdError::InvalidBundle("XLSX proof signing failed".into()))?;
    let target = location(root, &proof.document_id);
    let parent = target
        .parent()
        .ok_or_else(|| HcdError::InvalidBundle("invalid XLSX proof path".into()))?;
    std::fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(token.as_bytes())?;
    temp.as_file().sync_all()?;
    temp.persist(target)
        .map_err(|error| HcdError::Io(error.error))?;
    Ok(proof.editable_cells_checked)
}

/// Compare the actual current mapping, not a marker contained in the bundle.
pub(super) fn matches(bundle: &Bundle, root: &Path, secret: &[u8]) -> Result<bool, HcdError> {
    let manifest = bundle.manifest()?;
    let path = location(root, &manifest.document_id);
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if file.metadata()?.len() > 32 * 1024 {
        return Ok(false);
    }
    let mut token = String::new();
    use std::io::Read;
    file.take(32 * 1024 + 1).read_to_string(&mut token)?;
    if token.len() > 32 * 1024 {
        return Ok(false);
    }
    let mut validation = Validation::new(Algorithm::HS256);
    validation.required_spec_claims.clear();
    validation.validate_exp = false;
    validation.validate_aud = false;
    let proof = match decode::<Proof>(&token, &DecodingKey::from_secret(&key(secret)), &validation)
    {
        Ok(result) => result.claims,
        Err(_) => return Ok(false),
    };
    if proof.schema != "hcd-xlsx-formula-proof/3"
        || proof.document_id != manifest.document_id
        || proof.source != manifest.source
        || proof.audited_revision > manifest.revision
    {
        return Ok(false);
    }
    Ok(proof.mapping_fingerprint == hcd_formats::xlsx_formula_mapping_fingerprint(bundle)?)
}
