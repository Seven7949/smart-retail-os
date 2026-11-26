//! Hash-chain construction, sign-time validation and full verification.

use crate::model::{entry_hash, is_valid_id, payload_hash, Bill, LedgerEntry, GENESIS_HASH};
use crate::signer::{is_hash_hex, parse_public_key, verify_signature, Signer};
use serde::{Deserialize, Serialize};

pub const MAX_BATCH: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FailureCode {
    SeqGap,
    PrevMismatch,
    PayloadMismatch,
    HashMismatch,
    BadSignature,
    ShopMismatch,
    InvalidBill,
    BatchTooLarge,
    BadPublicKey,
    FutureTimestamp,
    TimestampRegression,
    DuplicateBill,
}

/// Bills may not claim to be from the future (device clock tolerance).
pub const MAX_CLOCK_SKEW_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Failure {
    pub seq: i64,
    pub code: FailureCode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainItem {
    pub bill: Bill,
    pub entry: LedgerEntry,
    pub entry_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

/// The last accepted entry of a shop's chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainHead {
    pub seq: i64,
    pub entry_hash: String,
    /// Timestamp of the head entry; new entries may not go back in time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub valid: bool,
    pub checked: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<Failure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<ChainHead>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedHash {
    pub seq: i64,
    pub entry_hash: String,
    pub signature: String,
}

/// Build the next entry for `bill` on top of `head` (None = new chain).
pub fn build_entry(
    shop_id: &str,
    head: Option<&ChainHead>,
    bill: &Bill,
) -> Result<(LedgerEntry, String), FailureCode> {
    let (seq, prev_hash) = match head {
        None => (0, GENESIS_HASH.to_string()),
        Some(h) => (h.seq + 1, h.entry_hash.clone()),
    };
    let entry = LedgerEntry {
        bill_id: bill.bill_id.clone(),
        payload_hash: payload_hash(bill).map_err(|_| FailureCode::InvalidBill)?,
        prev_hash,
        seq,
        shop_id: shop_id.to_string(),
        timestamp: bill.created_at,
    };
    let hash = entry_hash(&entry).map_err(|_| FailureCode::InvalidBill)?;
    Ok((entry, hash))
}

/// Structural checks shared by signing and verification.
fn check_link(
    shop_id: &str,
    expected_seq: i64,
    expected_prev: &str,
    item: &ChainItem,
) -> Result<(), FailureCode> {
    let e = &item.entry;
    if e.shop_id != shop_id {
        return Err(FailureCode::ShopMismatch);
    }
    if e.seq != expected_seq {
        return Err(FailureCode::SeqGap);
    }
    if e.prev_hash != expected_prev {
        return Err(FailureCode::PrevMismatch);
    }
    if e.bill_id != item.bill.bill_id || e.timestamp != item.bill.created_at {
        return Err(FailureCode::PayloadMismatch);
    }
    match payload_hash(&item.bill) {
        Ok(h) if h == e.payload_hash => {}
        _ => return Err(FailureCode::PayloadMismatch),
    }
    match entry_hash(e) {
        Ok(h) if h == item.entry_hash && is_hash_hex(&h) => Ok(()),
        _ => Err(FailureCode::HashMismatch),
    }
}

/// Validate a batch of new entries continuing `head`, then sign each one.
/// All-or-nothing: on any failure nothing is signed.
pub fn validate_and_sign(
    signer: &Signer,
    shop_id: &str,
    head: Option<&ChainHead>,
    items: &[ChainItem],
    now_ms: i64,
) -> Result<Vec<SignedHash>, Failure> {
    let fail = |seq, code| Failure { seq, code };
    if !is_valid_id(shop_id) {
        return Err(fail(-1, FailureCode::ShopMismatch));
    }
    if items.len() > MAX_BATCH {
        return Err(fail(-1, FailureCode::BatchTooLarge));
    }
    let (mut seq, mut prev) = match head {
        None => (0, GENESIS_HASH.to_string()),
        Some(h) => (h.seq + 1, h.entry_hash.clone()),
    };
    let mut out = Vec::with_capacity(items.len());
    let mut last_ts = head.and_then(|h| h.timestamp).unwrap_or(i64::MIN);
    let mut seen = std::collections::HashSet::with_capacity(items.len());
    for item in items {
        item.bill
            .validate()
            .map_err(|_| fail(item.entry.seq, FailureCode::InvalidBill))?;
        if item.bill.created_at > now_ms.saturating_add(MAX_CLOCK_SKEW_MS) {
            return Err(fail(item.entry.seq, FailureCode::FutureTimestamp));
        }
        if item.bill.created_at < last_ts {
            return Err(fail(item.entry.seq, FailureCode::TimestampRegression));
        }
        if !seen.insert(item.bill.bill_id.as_str()) {
            return Err(fail(item.entry.seq, FailureCode::DuplicateBill));
        }
        last_ts = item.bill.created_at;
        check_link(shop_id, seq, &prev, item).map_err(|code| fail(item.entry.seq, code))?;
        let signature = signer
            .sign_entry_hash(&item.entry_hash)
            .map_err(|_| fail(seq, FailureCode::HashMismatch))?;
        out.push(SignedHash {
            seq,
            entry_hash: item.entry_hash.clone(),
            signature,
        });
        prev = item.entry_hash.clone();
        seq += 1;
    }
    Ok(out)
}

/// Verify an entire chain from genesis. If `public_key_b64` is given every
/// entry must also carry a valid signature.
pub fn verify_chain(
    shop_id: &str,
    items: &[ChainItem],
    public_key_b64: Option<&str>,
) -> VerifyReport {
    verify_chain_from(shop_id, None, items, public_key_b64)
}

/// Verify a contiguous page of a chain that continues `start` (None = genesis).
/// Long chains are verified page by page, passing each page's `head` on.
pub fn verify_chain_from(
    shop_id: &str,
    start: Option<&ChainHead>,
    items: &[ChainItem],
    public_key_b64: Option<&str>,
) -> VerifyReport {
    let key = match public_key_b64.map(parse_public_key) {
        None => None,
        Some(Ok(k)) => Some(k),
        Some(Err(_)) => {
            return report(
                0,
                Some(Failure {
                    seq: -1,
                    code: FailureCode::BadPublicKey,
                }),
                None,
            )
        }
    };
    let (first_seq, mut prev) = match start {
        None => (0, GENESIS_HASH.to_string()),
        Some(h) => (h.seq + 1, h.entry_hash.clone()),
    };
    for (i, item) in items.iter().enumerate() {
        let seq = first_seq + i as i64;
        if let Err(code) = check_link(shop_id, seq, &prev, item) {
            return report(
                i,
                Some(Failure {
                    seq: item.entry.seq,
                    code,
                }),
                None,
            );
        }
        if let Some(k) = &key {
            let ok = item
                .signature
                .as_deref()
                .is_some_and(|sig| verify_signature(k, &item.entry_hash, sig));
            if !ok {
                return report(
                    i,
                    Some(Failure {
                        seq: item.entry.seq,
                        code: FailureCode::BadSignature,
                    }),
                    None,
                );
            }
        }
        prev = item.entry_hash.clone();
    }
    let head = items
        .last()
        .map(|it| ChainHead {
            seq: it.entry.seq,
            entry_hash: it.entry_hash.clone(),
            timestamp: Some(it.entry.timestamp),
        })
        .or_else(|| start.cloned());
    report(items.len(), None, head)
}

fn report(checked: usize, failure: Option<Failure>, head: Option<ChainHead>) -> VerifyReport {
    VerifyReport {
        valid: failure.is_none(),
        checked,
        failure,
        head,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{LineItem, PaymentMode};

    const SHOP: &str = "shop_1";
    const NOW: i64 = 1_767_225_600_000;
    const SECRET: &str = "unit-test-secret-unit-test-secret";

    fn bill(n: i64) -> Bill {
        Bill {
            bill_id: format!("b_{n}"),
            created_at: 1_000 + n,
            customer_id: None,
            items: vec![LineItem {
                sku: "milk".into(),
                qty_milli: 1000,
                unit_price_paise: 2900,
            }],
            payment_mode: PaymentMode::Cash,
            total_paise: 2900,
        }
    }

    fn chain(n: i64, head: Option<ChainHead>) -> Vec<ChainItem> {
        let mut head = head;
        (0..n)
            .map(|i| {
                let b = bill(i + head.as_ref().map_or(0, |h| h.seq + 1));
                let (entry, entry_hash) = build_entry(SHOP, head.as_ref(), &b).unwrap();
                head = Some(ChainHead {
                    seq: entry.seq,
                    entry_hash: entry_hash.clone(),
                    timestamp: Some(entry.timestamp),
                });
                ChainItem {
                    bill: b,
                    entry,
                    entry_hash,
                    signature: None,
                }
            })
            .collect()
    }

    #[test]
    fn sign_new_chain_then_verify_with_key() {
        let signer = Signer::from_secret(SECRET).unwrap();
        let mut items = chain(5, None);
        let sigs = validate_and_sign(&signer, SHOP, None, &items, NOW).unwrap();
        assert_eq!(sigs.len(), 5);
        for (it, s) in items.iter_mut().zip(&sigs) {
            it.signature = Some(s.signature.clone());
        }
        let r = verify_chain(SHOP, &items, Some(&signer.public_key_base64()));
        assert!(r.valid);
        assert_eq!(r.head.unwrap().seq, 4);
    }

    #[test]
    fn continuation_batch_must_link_to_head() {
        let signer = Signer::from_secret(SECRET).unwrap();
        let first = chain(2, None);
        let head = ChainHead {
            seq: 1,
            entry_hash: first[1].entry_hash.clone(),
            timestamp: None,
        };
        let next = chain(2, Some(head.clone()));
        assert!(validate_and_sign(&signer, SHOP, Some(&head), &next, NOW).is_ok());

        // Fork attempt: same batch against a different head.
        let wrong = ChainHead {
            seq: 1,
            entry_hash: first[0].entry_hash.clone(),
            timestamp: None,
        };
        let err = validate_and_sign(&signer, SHOP, Some(&wrong), &next, NOW).unwrap_err();
        assert_eq!(err.code, FailureCode::PrevMismatch);

        // Replay: re-sending an already-accepted batch.
        let err = validate_and_sign(&signer, SHOP, Some(&head), &first, NOW).unwrap_err();
        assert_eq!(err.code, FailureCode::SeqGap);
    }

    #[test]
    fn future_backdated_and_duplicate_bills_are_rejected() {
        let signer = Signer::from_secret(SECRET).unwrap();
        // a bill claiming to be from tomorrow
        let items = chain(1, None);
        let err =
            validate_and_sign(&signer, SHOP, None, &items, -MAX_CLOCK_SKEW_MS - 1).unwrap_err();
        assert_eq!(err.code, FailureCode::FutureTimestamp);
        // a continuation that goes back in time relative to the stored head
        let head = ChainHead {
            seq: items[0].entry.seq,
            entry_hash: items[0].entry_hash.clone(),
            timestamp: Some(NOW),
        };
        let next = chain(1, Some(head.clone()));
        let err = validate_and_sign(&signer, SHOP, Some(&head), &next, NOW).unwrap_err();
        assert_eq!(err.code, FailureCode::TimestampRegression);
        // the same bill id twice in one batch
        let mut dup = chain(2, None);
        dup[1].bill.bill_id = dup[0].bill.bill_id.clone();
        dup[1].entry.bill_id = dup[0].bill.bill_id.clone();
        dup[1].entry.payload_hash = payload_hash(&dup[1].bill).unwrap();
        dup[1].entry.prev_hash = dup[0].entry_hash.clone();
        dup[1].entry_hash = entry_hash(&dup[1].entry).unwrap();
        let err = validate_and_sign(&signer, SHOP, None, &dup, NOW).unwrap_err();
        assert_eq!(err.code, FailureCode::DuplicateBill);
    }

    #[test]
    fn invalid_bill_is_never_signed() {
        let signer = Signer::from_secret(SECRET).unwrap();
        let mut items = chain(1, None);
        items[0].bill.total_paise = 1;
        let err = validate_and_sign(&signer, SHOP, None, &items, NOW).unwrap_err();
        assert_eq!(err.code, FailureCode::InvalidBill);
    }

    #[test]
    fn batch_limit_and_bad_shop() {
        let signer = Signer::from_secret(SECRET).unwrap();
        let items = chain(1, None);
        let many: Vec<_> = std::iter::repeat_n(items[0].clone(), MAX_BATCH + 1).collect();
        assert_eq!(
            validate_and_sign(&signer, SHOP, None, &many, NOW)
                .unwrap_err()
                .code,
            FailureCode::BatchTooLarge
        );
        assert_eq!(
            validate_and_sign(&signer, "bad shop!", None, &items, NOW)
                .unwrap_err()
                .code,
            FailureCode::ShopMismatch
        );
    }

    #[test]
    fn tampered_entry_hash_detected() {
        let mut items = chain(2, None);
        items[1].entry.timestamp += 1;
        items[1].bill.created_at += 1;
        // payload hash now differs too; edit payload hash to match bill to isolate HASH_MISMATCH
        items[1].entry.payload_hash = payload_hash(&items[1].bill).unwrap();
        let r = verify_chain(SHOP, &items, None);
        assert_eq!(r.failure.unwrap().code, FailureCode::HashMismatch);
    }

    #[test]
    fn missing_signature_and_bad_key() {
        let items = chain(1, None);
        let signer = Signer::from_secret(SECRET).unwrap();
        let r = verify_chain(SHOP, &items, Some(&signer.public_key_base64()));
        assert_eq!(r.failure.unwrap().code, FailureCode::BadSignature);
        let r = verify_chain(SHOP, &items, Some("garbage"));
        assert_eq!(r.failure.unwrap().code, FailureCode::BadPublicKey);
    }

    #[test]
    fn paged_verification_matches_full() {
        let items = chain(6, None);
        let full = verify_chain(SHOP, &items, None);
        let p1 = verify_chain_from(SHOP, None, &items[..3], None);
        let p2 = verify_chain_from(SHOP, p1.head.as_ref(), &items[3..], None);
        assert!(p1.valid && p2.valid);
        assert_eq!(p2.head, full.head);
        // wrong start head is rejected
        let bad = verify_chain_from(SHOP, None, &items[3..], None);
        assert_eq!(bad.failure.unwrap().code, FailureCode::SeqGap);
    }

    #[test]
    fn empty_chain_is_valid() {
        let r = verify_chain(SHOP, &[], None);
        assert!(r.valid && r.head.is_none());
    }
}
