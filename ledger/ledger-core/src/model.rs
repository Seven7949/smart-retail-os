//! Typed bill and ledger entry. "Parse, don't validate": a `Bill` that passed
//! [`Bill::validate`] is structurally sound and internally consistent.

use crate::canonical::{canonical, sha256_hex, CanonError, MAX_SAFE_INTEGER};
use serde::{Deserialize, Serialize};

pub const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const MAX_ID_LEN: usize = 64;
const MAX_ITEMS_PER_BILL: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaymentMode {
    Cash,
    Upi,
    Udhaar,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LineItem {
    pub sku: String,
    pub qty_milli: i64,
    pub unit_price_paise: i64,
}

impl LineItem {
    /// Line total in paise, rounded half-up (LEDGER_SPEC "line total" rule).
    pub fn total_paise(&self) -> Option<i64> {
        self.qty_milli
            .checked_mul(self.unit_price_paise)?
            .checked_add(500)
            .map(|v| v.div_euclid(1000))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bill {
    pub bill_id: String,
    pub created_at: i64,
    pub customer_id: Option<String>,
    pub items: Vec<LineItem>,
    pub payment_mode: PaymentMode,
    pub total_paise: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BillError {
    #[error("invalid id: {0}")]
    InvalidId(&'static str),
    #[error("bill must have between 1 and {MAX_ITEMS_PER_BILL} items")]
    ItemCount,
    #[error("quantity and price must be positive")]
    NonPositive,
    #[error("totalPaise does not equal the sum of line totals")]
    TotalMismatch,
    #[error("udhaar bills need a customerId")]
    UdhaarWithoutCustomer,
    #[error("timestamp out of range")]
    Timestamp,
}

pub(crate) fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

impl Bill {
    #[allow(clippy::expect_used)] // serialising a plain struct of strings/ints cannot fail
    pub fn canonical(&self) -> Result<String, CanonError> {
        canonical(&serde_json::to_value(self).expect("bill serialises"))
    }

    pub fn validate(&self) -> Result<(), BillError> {
        if !is_valid_id(&self.bill_id) {
            return Err(BillError::InvalidId("billId"));
        }
        if let Some(c) = &self.customer_id {
            if !is_valid_id(c) {
                return Err(BillError::InvalidId("customerId"));
            }
        }
        if self.payment_mode == PaymentMode::Udhaar && self.customer_id.is_none() {
            return Err(BillError::UdhaarWithoutCustomer);
        }
        if !(0..=MAX_SAFE_INTEGER).contains(&self.created_at) {
            return Err(BillError::Timestamp);
        }
        if self.items.is_empty() || self.items.len() > MAX_ITEMS_PER_BILL {
            return Err(BillError::ItemCount);
        }
        let mut sum: i64 = 0;
        for item in &self.items {
            if !is_valid_id(&item.sku) {
                return Err(BillError::InvalidId("sku"));
            }
            if item.qty_milli <= 0 || item.unit_price_paise <= 0 {
                return Err(BillError::NonPositive);
            }
            let line = item.total_paise().ok_or(BillError::TotalMismatch)?;
            sum = sum.checked_add(line).ok_or(BillError::TotalMismatch)?;
        }
        if sum != self.total_paise {
            return Err(BillError::TotalMismatch);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LedgerEntry {
    pub bill_id: String,
    pub payload_hash: String,
    pub prev_hash: String,
    pub seq: i64,
    pub shop_id: String,
    pub timestamp: i64,
}

impl LedgerEntry {
    #[allow(clippy::expect_used)] // serialising a plain struct of strings/ints cannot fail
    pub fn canonical(&self) -> Result<String, CanonError> {
        canonical(&serde_json::to_value(self).expect("entry serialises"))
    }
}

pub fn payload_hash(bill: &Bill) -> Result<String, CanonError> {
    Ok(sha256_hex(&bill.canonical()?))
}

pub fn entry_hash(entry: &LedgerEntry) -> Result<String, CanonError> {
    Ok(sha256_hex(&entry.canonical()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bill() -> Bill {
        Bill {
            bill_id: "b_1".into(),
            created_at: 1,
            customer_id: None,
            items: vec![LineItem {
                sku: "sugar-1".into(),
                qty_milli: 250,
                unit_price_paise: 4800,
            }],
            payment_mode: PaymentMode::Cash,
            total_paise: 1200,
        }
    }

    #[test]
    fn valid_bill_passes() {
        assert_eq!(bill().validate(), Ok(()));
    }

    #[test]
    fn half_up_rounding() {
        let li = LineItem {
            sku: "x".into(),
            qty_milli: 333,
            unit_price_paise: 1500,
        };
        assert_eq!(li.total_paise(), Some(500)); // 499.5 -> 500
    }

    #[test]
    fn wrong_total_rejected() {
        let mut b = bill();
        b.total_paise = 1;
        assert_eq!(b.validate(), Err(BillError::TotalMismatch));
    }

    #[test]
    fn udhaar_needs_customer() {
        let mut b = bill();
        b.payment_mode = PaymentMode::Udhaar;
        assert_eq!(b.validate(), Err(BillError::UdhaarWithoutCustomer));
    }

    #[test]
    fn bad_ids_rejected() {
        let mut b = bill();
        b.bill_id = "../etc/passwd".into();
        assert_eq!(b.validate(), Err(BillError::InvalidId("billId")));
        let mut b = bill();
        b.items[0].sku = String::new();
        assert_eq!(b.validate(), Err(BillError::InvalidId("sku")));
    }

    #[test]
    fn non_positive_and_empty_rejected() {
        let mut b = bill();
        b.items[0].qty_milli = 0;
        assert_eq!(b.validate(), Err(BillError::NonPositive));
        let mut b = bill();
        b.items.clear();
        assert_eq!(b.validate(), Err(BillError::ItemCount));
    }

    #[test]
    fn overflow_is_rejected_not_panicking() {
        let mut b = bill();
        b.items[0].qty_milli = i64::MAX;
        assert_eq!(b.validate(), Err(BillError::TotalMismatch));
    }

    #[test]
    fn unknown_fields_rejected() {
        let raw = r#"{"billId":"b","createdAt":1,"customerId":null,"items":[],"paymentMode":"cash","totalPaise":0,"evil":1}"#;
        assert!(serde_json::from_str::<Bill>(raw).is_err());
    }
}
