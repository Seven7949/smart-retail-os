"""DynamoDB single-table access. Every key is scoped to SHOP#<jwt sub>."""
from __future__ import annotations

import json
import os
from typing import Iterable

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

TRANSACT_LIMIT = 100


def table():
    return boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])


def pk(shop: str) -> str:
    return f"SHOP#{shop}"


def ledger_sk(seq: int) -> str:
    return f"LEDGER#{seq:012d}"


def bill_sk(bill: dict) -> str:
    return f"BILL#{bill['createdAt']:013d}#{bill['billId']}"


def _dump(d) -> str:
    return json.dumps(d, separators=(",", ":"), ensure_ascii=False)


def query_all(tbl, **kw) -> list[dict]:
    out, start = [], None
    while True:
        if start:
            kw["ExclusiveStartKey"] = start
        page = tbl.query(**kw)
        out += page.get("Items", [])
        start = page.get("LastEvaluatedKey")
        if not start:
            return out


def ledger_head(tbl, shop: str) -> dict | None:
    res = tbl.query(KeyConditionExpression=Key("pk").eq(pk(shop)) & Key("sk").begins_with("LEDGER#"),
                    ScanIndexForward=False, Limit=1)
    items = res.get("Items", [])
    if not items:
        return None
    rec = json.loads(items[0]["data"])
    return {"seq": rec["entry"]["seq"], "entryHash": rec["entryHash"], "timestamp": rec["entry"]["timestamp"]}


def ledger_range(tbl, shop: str, first: int, last: int) -> list[dict]:
    rows = query_all(tbl, KeyConditionExpression=Key("pk").eq(pk(shop)) & Key("sk").between(ledger_sk(first), ledger_sk(last)))
    return [json.loads(r["data"]) for r in rows]


def ledger_pages(tbl, shop: str, page_size: int = 1000) -> Iterable[list[dict]]:
    start = None
    while True:
        kw = {"KeyConditionExpression": Key("pk").eq(pk(shop)) & Key("sk").begins_with("LEDGER#"), "Limit": page_size}
        if start:
            kw["ExclusiveStartKey"] = start
        page = tbl.query(**kw)
        yield [json.loads(r["data"]) for r in page.get("Items", [])]
        start = page.get("LastEvaluatedKey")
        if not start:
            return


class ChainConflict(Exception):
    """Another device appended to the chain concurrently."""


def append_ledger(tbl, shop: str, signed: list[dict], now_ms: int) -> None:
    """Write ledger entries + bills, refusing to overwrite any seq or bill id.

    Each entry is 3 conditional puts (ledger seq, bill copy, bill-id marker);
    entries are written in transactions of up to 33 entries, in seq order, so a
    failure can only ever leave a valid *prefix* of the batch stored.
    """
    client = tbl.meta.client
    per_entry = []
    for rec in signed:
        stored = {**rec, "signedAt": now_ms}
        per_entry.append([
            {"Put": {"TableName": tbl.name, "Item": {"pk": pk(shop), "sk": ledger_sk(rec["entry"]["seq"]),
                                                      "data": _dump(stored), "updatedAt": now_ms},
                     "ConditionExpression": "attribute_not_exists(sk)"}},
            {"Put": {"TableName": tbl.name, "Item": {"pk": pk(shop), "sk": bill_sk(rec["bill"]),
                                                      "data": _dump(rec["bill"]), "updatedAt": now_ms},
                     "ConditionExpression": "attribute_not_exists(sk)"}},
            {"Put": {"TableName": tbl.name, "Item": {"pk": pk(shop), "sk": f"BILLID#{rec['bill']['billId']}",
                                                      "seq": rec["entry"]["seq"], "updatedAt": now_ms},
                     "ConditionExpression": "attribute_not_exists(sk)"}},
        ])
    step = TRANSACT_LIMIT // 3
    # tbl.meta.client is the resource's client: it serialises Python values itself.
    for i in range(0, len(per_entry), step):
        ops = [op for group in per_entry[i : i + step] for op in group]
        try:
            client.transact_write_items(TransactItems=ops)
        except ClientError as e:
            reasons = [r.get("Code") for r in e.response.get("CancellationReasons", [])]
            if e.response["Error"]["Code"] == "TransactionCanceledException" and "ConditionalCheckFailed" in reasons:
                raise ChainConflict() from e
            raise


def upsert(tbl, shop: str, prefix: str, key_field: str, records: list[dict], now_ms: int) -> int:
    with tbl.batch_writer(overwrite_by_pkeys=["pk", "sk"]) as bw:
        for r in records:
            bw.put_item(Item={"pk": pk(shop), "sk": f"{prefix}#{r[key_field]}", "data": _dump(r), "updatedAt": now_ms})
    return len(records)


def upsert_udhaar(tbl, shop: str, txns: list[dict], now_ms: int) -> int:
    with tbl.batch_writer(overwrite_by_pkeys=["pk", "sk"]) as bw:
        for t in txns:
            bw.put_item(Item={"pk": pk(shop), "sk": f"UDHAAR#{t['customerId']}#{t['ts']:013d}#{t['id']}",
                              "data": _dump(t), "updatedAt": now_ms})
    return len(txns)


def put_profile(tbl, shop: str, profile: dict, now_ms: int) -> None:
    tbl.put_item(Item={"pk": pk(shop), "sk": "PROFILE", "data": _dump(profile), "updatedAt": now_ms})


def ensure_profile(tbl, shop: str, now_ms: int) -> None:
    try:
        tbl.put_item(Item={"pk": pk(shop), "sk": "PROFILE", "data": _dump({"shopName": "My shop", "digestOptIn": False}),
                           "updatedAt": now_ms}, ConditionExpression="attribute_not_exists(sk)")
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise


def insights(tbl, shop: str) -> dict:
    rows = query_all(tbl, KeyConditionExpression=Key("pk").eq(pk(shop)) & Key("sk").begins_with("INSIGHT#"))
    return {r["sk"].removeprefix("INSIGHT#"): json.loads(r["data"]) for r in rows}


def claim_refresh_slot(tbl, shop: str, now_ms: int, min_interval_ms: int) -> bool:
    """Per-shop rate limit for expensive on-demand ML refreshes."""
    try:
        tbl.put_item(Item={"pk": pk(shop), "sk": "RATE#refresh", "at": now_ms},
                     ConditionExpression="attribute_not_exists(sk) OR #at < :cut",
                     ExpressionAttributeNames={"#at": "at"}, ExpressionAttributeValues={":cut": now_ms - min_interval_ms})
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


QUOTA_TTL_SECONDS = 2 * 86_400


def consume_quota(tbl, shop: str, kind: str, limit: int, now_ms: int) -> bool:
    """Per-shop daily quota for paid AI calls (Bedrock, Textract) and syncs.
    Atomic conditional counter; rows expire via the table's TTL attribute."""
    day = now_ms // 86_400_000
    try:
        tbl.update_item(
            Key={"pk": pk(shop), "sk": f"QUOTA#{kind}#{day}"},
            UpdateExpression="ADD #n :one SET #ttl = :ttl",
            ConditionExpression="attribute_not_exists(#n) OR #n < :limit",
            ExpressionAttributeNames={"#n": "n", "#ttl": "ttl"},
            ExpressionAttributeValues={":one": 1, ":limit": limit, ":ttl": now_ms // 1000 + QUOTA_TTL_SECONDS},
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def claim_once(tbl, shop: str, marker: str, now_ms: int) -> bool:
    """True the first time `marker` is claimed for this shop (e.g. one Textract run per upload)."""
    try:
        tbl.put_item(Item={"pk": pk(shop), "sk": marker, "at": now_ms, "ttl": now_ms // 1000 + 40 * 86_400},
                     ConditionExpression="attribute_not_exists(sk)")
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def release(tbl, shop: str, marker: str) -> None:
    tbl.delete_item(Key={"pk": pk(shop), "sk": marker})


def get_profile(tbl, shop: str) -> dict:
    item = tbl.get_item(Key={"pk": pk(shop), "sk": "PROFILE"}).get("Item")
    return json.loads(item["data"]) if item else {}
