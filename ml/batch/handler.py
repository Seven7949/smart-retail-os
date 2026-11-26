"""ml-batch Lambda (container image). Triggered nightly by EventBridge for every
shop, or on demand with {"shopId": "..."} by the insights API.

Reads the shop's partition from DynamoDB, computes insights, writes them back
as INSIGHT#* items and publishes an SNS digest.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time

import boto3
from boto3.dynamodb.conditions import Key

from batch.insights import compute_insights, digest

log = logging.getLogger()
log.setLevel(logging.INFO)
SHOP_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
HISTORY_DAYS = 180
DAY_MS = 86_400_000


def _table():
    return boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])


def _query_all(table, **kwargs) -> list[dict]:
    items, start = [], None
    while True:
        if start:
            kwargs["ExclusiveStartKey"] = start
        page = table.query(**kwargs)
        items += page.get("Items", [])
        start = page.get("LastEvaluatedKey")
        if not start:
            return items


def _data(rows: list[dict]) -> list[dict]:
    return [json.loads(r["data"]) for r in rows if "data" in r]


def load_shop(table, shop_id: str, now_ms: int) -> dict:
    pk = f"SHOP#{shop_id}"
    since = f"BILL#{now_ms - HISTORY_DAYS * DAY_MS:013d}"
    bills = _data(_query_all(table, KeyConditionExpression=Key("pk").eq(pk) & Key("sk").between(since, "BILL#~")))
    items = {i["sku"]: i for i in _data(_query_all(table, KeyConditionExpression=Key("pk").eq(pk) & Key("sk").begins_with("ITEM#")))}
    custs = {c["customerId"]: c for c in _data(_query_all(table, KeyConditionExpression=Key("pk").eq(pk) & Key("sk").begins_with("CUST#")))}
    udh = _data(_query_all(table, KeyConditionExpression=Key("pk").eq(pk) & Key("sk").begins_with("UDHAAR#")))
    profile = table.get_item(Key={"pk": pk, "sk": "PROFILE"}).get("Item", {})
    return {"bills": bills, "items": items, "customers": custs, "udhaar": udh,
            "profile": json.loads(profile.get("data", "{}"))}


def save_insights(table, shop_id: str, insights: dict) -> None:
    pk = f"SHOP#{shop_id}"
    with table.batch_writer() as bw:
        for kind in ("forecast", "reorder", "basket", "segments", "udhaar"):
            if kind in insights:
                bw.put_item(Item={"pk": pk, "sk": f"INSIGHT#{kind}", "data": json.dumps(insights[kind]),
                                  "updatedAt": insights["generatedAt"]})
        meta = {k: insights.get(k) for k in ("generatedAt", "billCount", "forecastMethod", "forecastStart")}
        bw.put_item(Item={"pk": pk, "sk": "INSIGHT#meta", "data": json.dumps(meta), "updatedAt": insights["generatedAt"]})


def list_shops(table) -> list[str]:
    shops, start = [], None
    while True:
        kw = {"FilterExpression": Key("sk").eq("PROFILE"), "ProjectionExpression": "pk"}
        if start:
            kw["ExclusiveStartKey"] = start
        page = table.scan(**kw)
        shops += [i["pk"].removeprefix("SHOP#") for i in page.get("Items", [])]
        start = page.get("LastEvaluatedKey")
        if not start:
            return shops


def run_shop(table, shop_id: str, now_ms: int) -> dict:
    shop = load_shop(table, shop_id, now_ms)
    insights = compute_insights(shop["bills"], shop["items"], shop["customers"], shop["udhaar"], now_ms)
    save_insights(table, shop_id, insights)
    topic = os.environ.get("DIGEST_TOPIC_ARN")
    if topic and shop["profile"].get("digestOptIn"):
        boto3.client("sns").publish(TopicArn=topic, Subject="Dukaan AI daily digest",
                                    Message=digest(insights, shop["profile"].get("shopName", "Your shop")),
                                    MessageAttributes={"shopId": {"DataType": "String", "StringValue": shop_id}})
    return {"shopId": shop_id, "bills": len(shop["bills"]), "reorders": len(insights.get("reorder", []))}


def handler(event, _context):
    table = _table()
    now_ms = int(time.time() * 1000)
    shop_id = (event or {}).get("shopId")
    if shop_id is not None:
        if not isinstance(shop_id, str) or not SHOP_ID_RE.match(shop_id):
            raise ValueError("invalid shopId")
        shops = [shop_id]
    else:
        shops = list_shops(table)
    results = []
    for sid in shops:
        try:
            results.append(run_shop(table, sid, now_ms))
        except Exception:  # one bad shop must not stop the nightly run
            log.exception("insights failed for shop %s", sid)
            results.append({"shopId": sid, "error": True})
    log.info(json.dumps({"processed": len(results)}))
    return {"processed": len(results), "results": results}
