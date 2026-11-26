//! # ledger-core
//!
//! Tamper-evident bill ledger for Smart Retail OS. Pure, dependency-light and
//! `#![forbid(unsafe_code)]`. See `docs/LEDGER_SPEC.md`.
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

mod canonical;
mod chain;
mod model;
mod signer;

pub use canonical::{canonical, sha256_hex, CanonError, MAX_SAFE_INTEGER};
pub use chain::{
    build_entry, validate_and_sign, verify_chain, verify_chain_from, ChainHead, ChainItem, Failure,
    FailureCode, SignedHash, VerifyReport, MAX_BATCH,
};
pub use model::{
    entry_hash, payload_hash, Bill, BillError, LedgerEntry, LineItem, PaymentMode, GENESIS_HASH,
};
pub use signer::{parse_public_key, verify_signature, SignError, Signer};
