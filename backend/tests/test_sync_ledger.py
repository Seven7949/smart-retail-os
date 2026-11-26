import json

import pytest

from conftest import SHOP, call, event, make_chain
from handlers import ledger as ledger_h
from handlers import sync as sync_h


def sync(body, sub=SHOP):
    return call(sync_h.handler, event("POST /sync", body, sub))


def test_first_sync_signs_and_stores_chain(aws, rust_signer):
    chain = make_chain(3)
    status, body = sync({"chain": chain, "profile": {"shopName": "Sharma Kirana", "digestOptIn": True}})
    assert status == 200, body
    assert [a["seq"] for a in body["accepted"]] == [0, 1, 2]
    assert body["head"] == {"seq": 2, "entryHash": chain[-1]["entryHash"]}
    stored = aws.get_item(Key={"pk": f"SHOP#{SHOP}", "sk": "LEDGER#000000000002"})["Item"]
    assert json.loads(stored["data"])["signature"] == body["accepted"][2]["signature"]
    assert json.loads(aws.get_item(Key={"pk": f"SHOP#{SHOP}", "sk": "PROFILE"})["Item"]["data"])["digestOptIn"]


def test_resend_is_idempotent_and_continuation_works(aws, rust_signer):
    first = make_chain(2)
    _, b1 = sync({"chain": first})
    status, b2 = sync({"chain": first})  # lost response -> device retries
    assert status == 200 and b2["accepted"] == b1["accepted"]
    nxt = make_chain(2, head=b1["head"], start=2)
    status, b3 = sync({"chain": first[1:] + nxt})
    assert status == 200 and [a["seq"] for a in b3["accepted"]] == [1, 2, 3]


def test_fork_gap_and_foreign_shop_are_rejected(aws, rust_signer):
    sync({"chain": make_chain(2)})
    forked = make_chain(2, start=50)  # different bills at seq 0,1
    assert sync({"chain": forked})[0] == 409
    gap = make_chain(1, head={"seq": 5, "entryHash": "a" * 64})
    status, body = sync({"chain": gap})
    assert status == 409 and body["error"]["code"] == "CHAIN_GAP"
    other = make_chain(1, shop="someone-else")
    assert sync({"chain": other}, sub="someone-else-2")[0] == 422


def test_rust_rejects_inconsistent_bill(aws, rust_signer):
    chain = make_chain(1)
    chain[0]["bill"]["totalPaise"] += 1  # wrong arithmetic; also breaks payloadHash
    status, body = sync({"chain": chain})
    assert status == 422 and body["error"]["code"] in {"INVALID_BILL", "PAYLOAD_MISMATCH"}
    assert not aws.get_item(Key={"pk": f"SHOP#{SHOP}", "sk": "LEDGER#000000000000"}).get("Item")


def test_concurrent_append_conflict(aws, rust_signer, monkeypatch):
    from common import repo

    def boom(*a, **k):
        raise repo.ChainConflict()

    monkeypatch.setattr(repo, "append_ledger", boom)
    status, body = sync({"chain": make_chain(1)})
    assert status == 409 and body["error"]["code"] == "CHAIN_CONFLICT"


def test_upserts_and_privacy(aws, rust_signer):
    body = {
        "items": [{"sku": "milk-amul-500", "name": "Milk", "pricePaise": 2900, "stockMilli": 12000, "packSize": 12}],
        "customers": [{"customerId": "c_1", "name": "Ramesh", "phone": "+919999999999", "creditLimitPaise": 50000}],
        "udhaar": [{"id": "u1", "customerId": "c_1", "kind": "credit", "amountPaise": 7200, "ts": 1767229200000}],
    }
    status, out = sync(body)
    assert status == 200 and out["counts"] == {"items": 1, "customers": 1, "udhaar": 1, "ledger": 0}
    cust = json.loads(aws.get_item(Key={"pk": f"SHOP#{SHOP}", "sk": "CUST#c_1"})["Item"]["data"])
    assert "phone" not in cust  # phone numbers never leave the device


@pytest.mark.parametrize("body,code", [
    ({"items": [{"sku": "bad sku", "name": "x", "pricePaise": 1}]}, 400),
    ({"items": [{"sku": "a", "name": "x", "pricePaise": 1.5}]}, 400),
    ({"udhaar": [{"id": "u", "customerId": "c", "kind": "gift", "amountPaise": 1, "ts": 1}]}, 400),
    ({"chain": "nope"}, 400),
])
def test_validation_errors(aws, rust_signer, body, code):
    assert sync(body)[0] == code


def test_unsorted_chain_rejected(aws, rust_signer):
    chain = make_chain(2)
    assert sync({"chain": chain[::-1]})[0] == 400


def test_auth_and_body_limits(aws, rust_signer):
    assert sync({}, sub=None)[0] == 401
    assert sync({}, sub="bad sub!")[0] == 401
    ev = event("POST /sync", None)
    ev["body"] = "x" * (2 * 1024 * 1024 + 1)
    assert call(sync_h.handler, ev)[0] == 413
    ev["body"] = "[1,2]"
    assert call(sync_h.handler, ev)[0] == 400
    ev["body"] = "{not json"
    assert call(sync_h.handler, ev)[0] == 400


def test_base64_body(aws, rust_signer):
    import base64

    ev = event("POST /sync", None)
    ev["body"] = base64.b64encode(json.dumps({"items": []}).encode()).decode()
    ev["isBase64Encoded"] = True
    assert call(sync_h.handler, ev)[0] == 200


def test_verify_detects_tampering_in_database(aws, rust_signer, monkeypatch):
    sync({"chain": make_chain(5)})
    status, rep = call(ledger_h.handler, event("GET /ledger/verify"))
    assert status == 200 and rep == {"valid": True, "checked": 5, "head": rep["head"]}
    # paging: 2 entries per page must give the same result
    monkeypatch.setattr(ledger_h, "PAGE", 2)
    assert call(ledger_h.handler, event("GET /ledger/verify"))[1]["valid"]
    # an insider edits a stored bill directly in DynamoDB
    key = {"pk": f"SHOP#{SHOP}", "sk": "LEDGER#000000000003"}
    rec = json.loads(aws.get_item(Key=key)["Item"]["data"])
    rec["bill"]["items"][0]["qtyMilli"] = 1000
    aws.put_item(Item={**key, "data": json.dumps(rec)})
    status, rep = call(ledger_h.handler, event("GET /ledger/verify"))
    assert status == 200 and not rep["valid"]
    assert rep["failure"] == {"seq": 3, "code": "PAYLOAD_MISMATCH"}


def test_public_key_route(aws, rust_signer, monkeypatch):
    monkeypatch.setattr(ledger_h, "_public_key", None)
    status, body = call(ledger_h.handler, event("GET /ledger/public-key"))
    assert status == 200 and body["algorithm"] == "Ed25519" and len(body["publicKey"]) == 44
    assert call(ledger_h.handler, event("GET /nope"))[0] == 404


def test_internal_errors_do_not_leak(aws, monkeypatch):
    from common import repo

    def explode(*a, **k):
        raise RuntimeError("secret internal detail")

    monkeypatch.setattr(repo, "ensure_profile", explode)
    status, body = sync({})
    assert status == 500 and "secret" not in json.dumps(body)


def test_dynamodb_condition_prevents_overwriting_a_seq(aws):
    from common import repo

    recs = [{**c, "signature": "sig"} for c in make_chain(1)]
    repo.append_ledger(aws, SHOP, recs, 1)
    with pytest.raises(repo.ChainConflict):
        repo.append_ledger(aws, SHOP, recs, 2)


def test_signer_client_invokes_lambda_and_surfaces_errors(monkeypatch):
    import io

    from common import signer

    class FakeLambda:
        def __init__(self, error=None):
            self.error = error

        def invoke(self, **kw):
            res = {"Payload": io.BytesIO(b'{"ok": true}')}
            if self.error:
                res["FunctionError"] = self.error
            return res

    monkeypatch.setenv("SIGNER_FUNCTION", "fn")
    monkeypatch.setattr(signer, "_client", FakeLambda())
    assert signer.invoke({"action": "publicKey"}) == {"ok": True}
    monkeypatch.setattr(signer, "_client", FakeLambda("Unhandled"))
    with pytest.raises(signer.SignerError):
        signer.invoke({"action": "publicKey"})
