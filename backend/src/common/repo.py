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
    return {"seq": rec["entry"]["seq"], "entryHash": rec["entryHash"]}


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
    """Write ledger entries + bills atomically, refusing to overwrite any seq."""
    client = tbl.meta.client
    ops = []
    for rec in signed:
        ops.append({"Put": {"TableName": tbl.name, "Item": {"pk": pk(shop), "sk": ledger_sk(rec["entry"]["seq"]),
                                                             "data": _dump(rec), "updatedAt": now_ms},
                            "ConditionExpression": "attribute_not_exists(sk)"}})
        ops.append({"Put": {"TableName": tbl.name, "Item": {"pk": pk(shop), "sk": bill_sk(rec["bill"]),
                                                             "data": _dump(rec["bill"]), "updatedAt": now_ms}}})
    # tbl.meta.client is the resource's client: it serialises Python values itself.
    for i in range(0, len(ops), TRANSACT_LIMIT):
        try:
            client.transact_write_items(TransactItems=ops[i : i + TRANSACT_LIMIT])
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
