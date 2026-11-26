//! Ed25519 signing over the 32 raw bytes of an entry hash.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

const MIN_SECRET_LEN: usize = 32;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum SignError {
    #[error("signing secret must be at least {MIN_SECRET_LEN} characters")]
    WeakSecret,
    #[error("entry hash must be 64 lowercase hex characters")]
    BadHash,
    #[error("malformed public key")]
    BadPublicKey,
}

pub struct Signer {
    key: SigningKey,
}

// Never print key material, even in debug logs.
impl std::fmt::Debug for Signer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Signer")
            .field("public_key", &self.public_key_base64())
            .finish()
    }
}

impl Signer {
    /// Seed = SHA-256(secret). The secret lives in AWS Secrets Manager.
    pub fn from_secret(secret: &str) -> Result<Self, SignError> {
        if secret.len() < MIN_SECRET_LEN {
            return Err(SignError::WeakSecret);
        }
        let seed: [u8; 32] = Sha256::digest(secret.as_bytes()).into();
        Ok(Self {
            key: SigningKey::from_bytes(&seed),
        })
    }

    pub fn public_key_base64(&self) -> String {
        B64.encode(self.key.verifying_key().to_bytes())
    }

    pub fn sign_entry_hash(&self, entry_hash_hex: &str) -> Result<String, SignError> {
        let msg = hash_bytes(entry_hash_hex)?;
        Ok(B64.encode(self.key.sign(&msg).to_bytes()))
    }
}

pub fn parse_public_key(public_key_b64: &str) -> Result<VerifyingKey, SignError> {
    let raw = B64
        .decode(public_key_b64)
        .map_err(|_| SignError::BadPublicKey)?;
    let arr: [u8; 32] = raw.try_into().map_err(|_| SignError::BadPublicKey)?;
    VerifyingKey::from_bytes(&arr).map_err(|_| SignError::BadPublicKey)
}

/// Constant-time-safe verification via ed25519-dalek (strict mode).
pub fn verify_signature(key: &VerifyingKey, entry_hash_hex: &str, signature_b64: &str) -> bool {
    let Ok(msg) = hash_bytes(entry_hash_hex) else {
        return false;
    };
    let Ok(raw) = B64.decode(signature_b64) else {
        return false;
    };
    let Ok(arr) = <[u8; 64]>::try_from(raw.as_slice()) else {
        return false;
    };
    let sig = Signature::from_bytes(&arr);
    key.verify_strict(&msg, &sig).is_ok() && key.verify(&msg, &sig).is_ok()
}

pub(crate) fn is_hash_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hash_bytes(hex_hash: &str) -> Result<[u8; 32], SignError> {
    if !is_hash_hex(hex_hash) {
        return Err(SignError::BadHash);
    }
    let raw = hex::decode(hex_hash).map_err(|_| SignError::BadHash)?;
    raw.try_into().map_err(|_| SignError::BadHash)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "unit-test-secret-unit-test-secret";
    const HASH: &str = "1e249c09afd78992af5138aaba168eace09179252528794ae2211f5e27b42ea0";

    #[test]
    fn weak_secret_rejected() {
        assert_eq!(
            Signer::from_secret("short").unwrap_err(),
            SignError::WeakSecret
        );
    }

    #[test]
    fn sign_then_verify_round_trip() {
        let s = Signer::from_secret(SECRET).unwrap();
        let pk = parse_public_key(&s.public_key_base64()).unwrap();
        let sig = s.sign_entry_hash(HASH).unwrap();
        assert!(verify_signature(&pk, HASH, &sig));
        let other = HASH.replace('1', "2");
        assert!(!verify_signature(&pk, &other, &sig));
    }

    #[test]
    fn rejects_bad_inputs() {
        let s = Signer::from_secret(SECRET).unwrap();
        assert_eq!(s.sign_entry_hash("XYZ").unwrap_err(), SignError::BadHash);
        assert_eq!(
            s.sign_entry_hash(&HASH.to_uppercase()).unwrap_err(),
            SignError::BadHash
        );
        assert!(parse_public_key("not base64!").is_err());
        assert!(parse_public_key("AAAA").is_err());
        let pk = parse_public_key(&s.public_key_base64()).unwrap();
        assert!(!verify_signature(&pk, HASH, "AAAA"));
        assert!(!verify_signature(&pk, HASH, "%%%"));
    }

    #[test]
    fn debug_does_not_leak_secret() {
        let s = Signer::from_secret(SECRET).unwrap();
        let dbg = format!("{s:?}");
        assert!(!dbg.contains(SECRET));
        assert!(dbg.contains("public_key"));
    }
}
