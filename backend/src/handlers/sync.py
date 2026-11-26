"""POST /sync — idempotent, offline-first sync of a shop's data.

Ledger entries are validated + signed by the Rust signer before being stored;
re-sending an already-accepted entry is a no-op (returns its signature), a
different entry at an existing seq is a fork and is rejected with 409.
"""
from __future__ import annotations

import json
import os
import time

import boto3

from common import repo, signer, validate
from common.http import ApiError, api, claim, json_body, shop_id

DAILY_SYNC_LIMIT = 500


def _now() -> int:
    return int(time.time() * 1000)


def process_chain(tbl, shop: str, chain: list[dict], now: int) -> tuple[list[dict], dict | None]:
    head = repo.ledger_head(tbl, shop)
    if not chain:
        return [], head
    for c in chain:
        if c["entry"]["shopId"] != shop:
            raise ApiError(422, "SHOP_MISMATCH", "ledger entries must be chained with your shop id")
    head_seq = head["seq"] if head else -1
    old = [c for c in chain if c["entry"]["seq"] <= head_seq]
    new = [c for c in chain if c["entry"]["seq"] > head_seq]
    accepted: list[dict] = []
    if old:
        stored = {r["entry"]["seq"]: r for r in repo.ledger_range(tbl, shop, old[0]["entry"]["seq"], old[-1]["entry"]["seq"])}
        for c in old:
            s = stored.get(c["entry"]["seq"])
            if not s or s["entryHash"] != c["entryHash"]:
                raise ApiError(409, "CHAIN_FORK", f"seq {c['entry']['seq']} already holds a different entry")
            accepted.append({"seq": s["entry"]["seq"], "entryHash": s["entryHash"], "signature": s["signature"]})
    if new:
        if new[0]["entry"]["seq"] != head_seq + 1:
            raise ApiError(409, "CHAIN_GAP", f"expected seq {head_seq + 1}")
        res = signer.invoke({"action": "sign", "shopId": shop, "head": head, "items": new})
        if not res.get("ok"):
            err = res.get("error") or {}
            raise ApiError(422, str(err.get("code", "LEDGER_REJECTED")), f"ledger rejected entry seq {err.get('seq')}")
        sigs = {s["seq"]: s["signature"] for s in res["signatures"]}
        if set(sigs) != {c["entry"]["seq"] for c in new}:
            raise ApiError(502, "SIGNER_MISMATCH", "signer returned an unexpected set of signatures")
        records = [{**c, "signature": sigs[c["entry"]["seq"]]} for c in new]
        try:
            repo.append_ledger(tbl, shop, records, now)
        except repo.ChainConflict:
            raise ApiError(409, "CHAIN_CONFLICT", "another device synced at the same time; retry") from None
        accepted += [{"seq": r["entry"]["seq"], "entryHash": r["entryHash"], "signature": r["signature"]} for r in records]
        head = {"seq": records[-1]["entry"]["seq"], "entryHash": records[-1]["entryHash"]}
    return accepted, head


def subscribe_digest(shop: str, email: str | None, profile: dict) -> dict:
    """Subscribe the shop owner's *own verified email* (from the JWT) to the
    digest topic, filtered so they only ever receive their own shop's digest."""
    topic = os.environ.get("DIGEST_TOPIC_ARN")
    if not topic or not email or not profile.get("digestOptIn") or profile.get("digestSubscribed"):
        return profile
    boto3.client("sns").subscribe(TopicArn=topic, Protocol="email", Endpoint=email,
                                  Attributes={"FilterPolicy": json.dumps({"shopId": [shop]})})
    return {**profile, "digestSubscribed": True}


@api
def handler(event, _ctx):
    shop = shop_id(event)
    req = validate.sync_request(json_body(event))
    now = _now()
    tbl = repo.table()
    if not repo.consume_quota(tbl, shop, "sync", DAILY_SYNC_LIMIT, now):
        raise ApiError(429, "DAILY_LIMIT", "Too many syncs today; your data is safe on the phone.")
    if req["profile"]:
        stored = repo.get_profile(tbl, shop)
        profile = {**req["profile"], "digestSubscribed": bool(stored.get("digestSubscribed"))}
        profile = subscribe_digest(shop, claim(event, "email"), profile)
        repo.put_profile(tbl, shop, profile, now)
    else:
        repo.ensure_profile(tbl, shop, now)
    accepted, head = process_chain(tbl, shop, req["chain"], now)
    counts = {
        "items": repo.upsert(tbl, shop, "ITEM", "sku", req["items"], now),
        "customers": repo.upsert(tbl, shop, "CUST", "customerId", req["customers"], now),
        "udhaar": repo.upsert_udhaar(tbl, shop, req["udhaar"], now),
        "ledger": len(accepted),
    }
    return 200, {"accepted": accepted, "head": head, "counts": counts, "serverTime": now}
