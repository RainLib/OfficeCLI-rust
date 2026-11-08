//! Local, source-authenticated Word field policy. A proof is bound to every
//! current source anchor, not to editable text or an untrusted bundle marker.
use hcd_core::{Bundle, HcdError, HcdManifest, SourceDescriptor};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    io::{Read, Write},
    path::Path,
};

const MAX_NODES: usize = 1_000_000;
const MAX_PROOF_BYTES: u64 = 8 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Proof {
    schema: String,
    document_id: String,
    source: SourceDescriptor,
    fingerprint: String,
    protected: BTreeSet<String>,
    audited_revision: u64,
}
fn key(secret: &[u8]) -> Vec<u8> {
    let mut hash = Sha256::new();
    hash.update(b"hcd-word-source-proof-key/1\0");
    hash.update(secret);
    hash.finalize().to_vec()
}
fn location(root: &Path, id: &str) -> std::path::PathBuf {
    root.join("word-source-proofs").join(format!("{id}.jwt"))
}
fn fingerprint(bundle: &Bundle, manifest: &HcdManifest) -> Result<String, HcdError> {
    let mut nodes = BTreeMap::new();
    for page in 0..manifest.index_page_count {
        for chunk in bundle.read_index_page(manifest, page)?.chunks {
            for entry in bundle.read_map_verified(&chunk)?.entries {
                if nodes.len() >= MAX_NODES {
                    return Err(HcdError::ResourceLimit("Word source mapping limit".into()));
                }
                if nodes.insert(entry.node_id, entry.source).is_some() {
                    return Err(HcdError::InvalidBundle("duplicate Word source node".into()));
                }
            }
        }
    }
    let bytes = serde_json::to_vec(&(
        "hcd-word-source-mapping/1",
        &manifest.document_id,
        &manifest.source,
        &nodes,
    ))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
/// Only publish a proof after policy and mapping are read at the same head.
pub(super) fn create(
    bundle: &Bundle,
    source: &Path,
    root: &Path,
    secret: &[u8],
) -> Result<(), HcdError> {
    let before = bundle.manifest()?;
    if before.source.format != "docx" || before.capabilities.flow_layout.is_some() {
        return Err(HcdError::InvalidBundle(
            "expected ordinary Word document".into(),
        ));
    }
    let protected = hcd_docx::legacy_read_only_nodes(bundle, source)?
        .into_iter()
        .collect();
    let fingerprint = fingerprint(bundle, &before)?;
    let after = bundle.manifest()?;
    if before.revision != after.revision
        || before.root_hash != after.root_hash
        || before.source != after.source
    {
        return Err(HcdError::InvalidBundle(
            "Word head changed during source audit".into(),
        ));
    }
    let proof = Proof {
        schema: "hcd-word-source-proof/1".into(),
        document_id: before.document_id,
        source: before.source,
        fingerprint,
        protected,
        audited_revision: before.revision,
    };
    let token = encode(
        &Header::new(Algorithm::HS256),
        &proof,
        &EncodingKey::from_secret(&key(secret)),
    )
    .map_err(|_| HcdError::InvalidBundle("Word proof signing failed".into()))?;
    if token.len() as u64 > MAX_PROOF_BYTES {
        return Err(HcdError::ResourceLimit("Word proof limit".into()));
    }
    let target = location(root, &proof.document_id);
    let parent = target
        .parent()
        .ok_or_else(|| HcdError::InvalidBundle("invalid Word proof path".into()))?;
    std::fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(token.as_bytes())?;
    temp.as_file().sync_all()?;
    temp.persist(target)
        .map_err(|error| HcdError::Io(error.error))?;
    Ok(())
}
/// Invalid, stale or foreign proofs never grant source-free writes.
pub(super) fn read(
    bundle: &Bundle,
    root: &Path,
    secret: &[u8],
) -> Result<Option<HashSet<String>>, HcdError> {
    let head = bundle.manifest()?;
    if head.source.format != "docx" || head.capabilities.flow_layout.is_some() {
        return Ok(None);
    }
    let file = match std::fs::File::open(location(root, &head.document_id)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if file.metadata()?.len() > MAX_PROOF_BYTES {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    file.take(MAX_PROOF_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_PROOF_BYTES {
        return Ok(None);
    }
    let token = match String::from_utf8(bytes) {
        Ok(token) => token,
        Err(_) => return Ok(None),
    };
    let mut validation = Validation::new(Algorithm::HS256);
    validation.required_spec_claims.clear();
    validation.validate_exp = false;
    validation.validate_aud = false;
    let proof = match decode::<Proof>(&token, &DecodingKey::from_secret(&key(secret)), &validation)
    {
        Ok(value) => value.claims,
        Err(_) => return Ok(None),
    };
    if proof.schema != "hcd-word-source-proof/1"
        || proof.document_id != head.document_id
        || proof.source != head.source
        || proof.audited_revision > head.revision
        || proof.fingerprint != fingerprint(bundle, &head)?
    {
        return Ok(None);
    }
    let after = bundle.manifest()?;
    if after.revision != head.revision
        || after.root_hash != head.root_hash
        || after.source != head.source
    {
        return Ok(None);
    }
    Ok(Some(proof.protected.into_iter().collect()))
}
