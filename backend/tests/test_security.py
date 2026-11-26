"""Regression tests for the ECC security-review findings (docs/REVIEW.md)."""
import json

import boto3
import pytest

from conftest import SHOP, call, event, make_chain, sha, canonical
from handlers import scan as scan_h
from handlers import sync as sync_h
from handlers import voice as voice_h
from test_ai_routes import CATALOG, TEXTRACT_RESPONSE, FakeClient, bedrock_returning


def sync(body, sub=SHOP, email=None):
    ev = event("POST /sync", body, sub)
    if email:
        ev["requestContext"]["authorizer"]["jwt"]["claims"]["email"] = email
    return call(sync_h.handler, ev)


def rehash(chain):
    """Recompute hashes after editing bills (attacker with the app's code)."""
    prev = "0" * 64
    for c in chain:
        c["entry"].update(payloadHash=sha(canonical(c["bill"])), prevHash=prev, timestamp=c["bill"]["createdAt"])
        c["entryHash"] = prev = sha(canonical(c["entry"]))
    return chain


def test_future_dated_bills_are_never_signed(aws, rust_signer):
    chain = make_chain(1)
    chain[0]["bill"]["createdAt"] = 4_102_444_800_000  # year 2100
    status, body = sync({"chain": rehash(chain)})
    assert status == 422 and body["error"]["code"] == "FUTURE_TIMESTAMP"


def test_chain_cannot_go_back_in_time(aws, rust_signer):
    first = make_chain(1)
    sync({"chain": first})
    head = {"seq": 0, "entryHash": first[0]["entryHash"]}
    nxt = make_chain(1, head=head, start=1)
    nxt[0]["bill"]["createdAt"] = first[0]["bill"]["createdAt"] - 86_400_000
    nxt[0]["entry"].update(payloadHash=sha(canonical(nxt[0]["bill"])), timestamp=nxt[0]["bill"]["createdAt"])
    nxt[0]["entryHash"] = sha(canonical(nxt[0]["entry"]))
    status, body = sync({"chain": nxt})
    assert status == 422 and body["error"]["code"] == "TIMESTAMP_REGRESSION"


def test_bill_ids_are_unique_across_the_whole_chain(aws, rust_signer):
    first = make_chain(1)
    sync({"chain": first})
    head = {"seq": 0, "entryHash": first[0]["entryHash"]}
    again = make_chain(1, head=head, start=1)
    again[0]["bill"]["billId"] = first[0]["bill"]["billId"]
    again[0]["entry"].update(billId=first[0]["bill"]["billId"], payloadHash=sha(canonical(again[0]["bill"])))
    again[0]["entryHash"] = sha(canonical(again[0]["entry"]))
    status, body = sync({"chain": again})
    assert status == 409
    stored = json.loads(aws.get_item(Key={"pk": f"SHOP#{SHOP}", "sk": "LEDGER#000000000000"})["Item"]["data"])
    assert "signedAt" in stored


def test_voice_daily_quota_and_catalog_hardening(aws, monkeypatch):
    monkeypatch.setattr(voice_h, "DAILY_LIMIT", 2)
    monkeypatch.setattr(voice_h.boto3, "client", lambda name: bedrock_returning([{"sku": "sugar-1", "qty": 1}]))
    body = {"text": "ek cheeni", "catalog": CATALOG}
    assert call(voice_h.handler, event("POST /voice/parse", body))[0] == 200
    assert call(voice_h.handler, event("POST /voice/parse", body))[0] == 200
    status, out = call(voice_h.handler, event("POST /voice/parse", body))
    assert status == 429 and out["error"]["code"] == "DAILY_LIMIT"
    # another shop is unaffected
    assert call(voice_h.handler, event("POST /voice/parse", body, sub="other-shop"))[0] == 200
    bad_unit = [{"sku": "a", "name": "x", "unit": "y" * 5000}]
    fake = bedrock_returning([])
    monkeypatch.setattr(voice_h.boto3, "client", lambda name: fake)
    assert call(voice_h.handler, event("POST /voice/parse", {"text": "x", "catalog": bad_unit}, sub="s3"))[0] == 200
    assert "yyyy" not in fake.calls[0][1]["messages"][0]["content"][0]["text"]
    huge = [{"sku": f"s{i}", "name": "n" * 60} for i in range(300)]
    assert call(voice_h.handler, event("POST /voice/parse", {"text": "x", "catalog": huge}, sub="s4"))[0] == 400


def test_each_scan_is_read_once_and_textract_failures_can_retry(aws, monkeypatch):
    key = f"scans/{SHOP}/0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b.jpg"

    def boom(**kw):
        raise RuntimeError("textract down")

    monkeypatch.setattr(scan_h.boto3, "client", lambda name: FakeClient(analyze_expense=boom))
    assert call(scan_h.handler, event("POST /scan/parse", {"key": key}))[0] == 500
    monkeypatch.setattr(scan_h.boto3, "client", lambda name: FakeClient(analyze_expense=lambda **kw: TEXTRACT_RESPONSE))
    assert call(scan_h.handler, event("POST /scan/parse", {"key": key}))[0] == 200
    status, out = call(scan_h.handler, event("POST /scan/parse", {"key": key}))
    assert status == 409 and out["error"]["code"] == "ALREADY_PARSED"


def test_digest_goes_only_to_the_shops_own_email(aws, rust_signer, monkeypatch):
    sns = boto3.client("sns")
    topic = sns.create_topic(Name="digest")["TopicArn"]
    monkeypatch.setenv("DIGEST_TOPIC_ARN", topic)
    profile = {"shopName": "Sharma", "digestOptIn": True}
    assert sync({"profile": profile}, email="owner@shop.in")[0] == 200
    assert sync({"profile": profile}, email="owner@shop.in")[0] == 200  # no duplicate subscription
    subs = sns.list_subscriptions_by_topic(TopicArn=topic)["Subscriptions"]
    assert [s["Endpoint"] for s in subs] == ["owner@shop.in"]
    attrs = sns.get_subscription_attributes(SubscriptionArn=subs[0]["SubscriptionArn"])["Attributes"]
    assert json.loads(attrs["FilterPolicy"]) == {"shopId": [SHOP]}


def test_sync_quota(aws, rust_signer, monkeypatch):
    monkeypatch.setattr(sync_h, "DAILY_SYNC_LIMIT", 1)
    assert sync({})[0] == 200
    assert sync({})[0] == 429
