//! Request handling for the signer Lambda, independent of the AWS runtime so
//! it can be unit-tested with an injected [`Signer`].
//!
//! The Lambda is invoked **only** by the backend's sync / verify Lambdas
//! (IAM-restricted), never directly from the internet. `shopId` is taken by
//! the caller from the Cognito JWT `sub` claim.

use ledger_core::{
    validate_and_sign, verify_chain_from, ChainHead, ChainItem, Failure, Signer, MAX_BATCH,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    #[serde(rename_all = "camelCase")]
    Sign {
        shop_id: String,
        head: Option<ChainHead>,
        items: Vec<ChainItem>,
    },
    #[serde(rename_all = "camelCase")]
    Verify {
        shop_id: String,
        #[serde(default)]
        from: Option<ChainHead>,
        items: Vec<ChainItem>,
    },
    PublicKey {},
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(untagged)]
pub enum Response {
    Signed {
        ok: bool,
        signatures: Vec<ledger_core::SignedHash>,
    },
    Rejected {
        ok: bool,
        error: Failure,
    },
    Verified {
        ok: bool,
        report: ledger_core::VerifyReport,
    },
    Key {
        ok: bool,
        #[serde(rename = "publicKey")]
        public_key: String,
    },
}

pub fn handle(signer: &Signer, req: Request) -> Response {
    match req {
        Request::Sign {
            shop_id,
            head,
            items,
        } => match validate_and_sign(signer, &shop_id, head.as_ref(), &items) {
            Ok(signatures) => Response::Signed {
                ok: true,
                signatures,
            },
            Err(error) => Response::Rejected { ok: false, error },
        },
        Request::Verify {
            shop_id,
            from,
            items,
        } => {
            if items.len() > MAX_BATCH * 4 {
                let error = Failure {
                    seq: -1,
                    code: ledger_core::FailureCode::BatchTooLarge,
                };
                return Response::Rejected { ok: false, error };
            }
            let pk = signer.public_key_base64();
            let report = verify_chain_from(&shop_id, from.as_ref(), &items, Some(&pk));
            Response::Verified {
                ok: report.valid,
                report,
            }
        }
        Request::PublicKey {} => Response::Key {
            ok: true,
            public_key: signer.public_key_base64(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../../../spec/ledger-vectors.json")).unwrap()
    }

    fn signer(v: &Value) -> Signer {
        Signer::from_secret(v["testSecret"].as_str().unwrap()).unwrap()
    }

    fn items(v: &Value, with_sig: bool) -> Value {
        Value::Array(
            v["chain"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| {
                    let mut o = json!({"bill": c["bill"], "entry": c["entry"], "entryHash": c["entryHash"]});
                    if with_sig {
                        o["signature"] = c["signature"].clone();
                    }
                    o
                })
                .collect(),
        )
    }

    fn run(v: &Value, req: Value) -> Value {
        let req: Request = serde_json::from_value(req).unwrap();
        serde_json::to_value(handle(&signer(v), req)).unwrap()
    }

    #[test]
    fn sign_returns_reference_signatures() {
        let v = vectors();
        let out = run(
            &v,
            json!({"action": "sign", "shopId": v["shopId"], "head": null, "items": items(&v, false)}),
        );
        assert_eq!(out["ok"], true);
        for (i, s) in out["signatures"].as_array().unwrap().iter().enumerate() {
            assert_eq!(s["signature"], v["chain"][i]["signature"]);
        }
    }

    #[test]
    fn sign_rejects_other_shop() {
        let v = vectors();
        let out = run(
            &v,
            json!({"action": "sign", "shopId": "attacker", "head": null, "items": items(&v, false)}),
        );
        assert_eq!(out["ok"], false);
        assert_eq!(out["error"]["code"], "SHOP_MISMATCH");
    }

    #[test]
    fn verify_full_chain() {
        let v = vectors();
        let out = run(
            &v,
            json!({"action": "verify", "shopId": v["shopId"], "items": items(&v, true)}),
        );
        assert_eq!(out["ok"], true);
        assert_eq!(out["report"]["checked"], 3);
        assert_eq!(out["report"]["head"]["seq"], 2);
    }

    #[test]
    fn verify_second_page_from_head() {
        let v = vectors();
        let all = items(&v, true);
        let page2 = Value::Array(all.as_array().unwrap()[2..].to_vec());
        let head = json!({"seq": 1, "entryHash": v["chain"][1]["entryHash"]});
        let out = run(
            &v,
            json!({"action": "verify", "shopId": v["shopId"], "from": head, "items": page2}),
        );
        assert_eq!(out["ok"], true);
        assert_eq!(out["report"]["head"]["seq"], 2);
    }

    #[test]
    fn public_key_matches_reference() {
        let v = vectors();
        let out = run(&v, json!({"action": "publicKey"}));
        assert_eq!(out["publicKey"], v["publicKeyBase64"]);
    }

    #[test]
    fn unknown_action_or_fields_are_rejected() {
        assert!(serde_json::from_value::<Request>(json!({"action": "dump"})).is_err());
        assert!(serde_json::from_value::<Request>(json!({"action": "publicKey", "x": 1})).is_err());
    }
}
