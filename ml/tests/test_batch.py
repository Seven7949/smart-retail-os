"""Tests for the production ml-batch job (pure logic + DynamoDB via moto)."""
from __future__ import annotations

import json
from datetime import date

import boto3
import pandas as pd
import pytest
from moto import mock_aws

from batch import handler as H
from batch.insights import bills_to_panel, compute_insights, digest, forecast
from sros_ml import synth
from sros_ml.catalog import items_frame
from sros_ml.udhaar_features import DAY_MS, features_for

NOW = int(pd.Timestamp("2026-11-16T06:00:00+05:30").timestamp() * 1000)


def make_bills(days: int) -> list[dict]:
    cfg = synth.SynthConfig(start=date(2026, 1, 1), end=date(2026, 11, 15), n_customers=60, tx_days=days)
    tx = synth.transactions(cfg)
    bills = []
    for tx_id, g in tx.groupby("tx_id"):
        ts = int(pd.Timestamp(g["date"].iloc[0]).tz_localize("Asia/Kolkata").timestamp() * 1000) + 10 * 3600_000
        items = [{"sku": r.sku, "qtyMilli": int(r.qty) * 1000, "unitPricePaise": int(r.price_paise)} for r in g.itertuples()]
        cid = g["customer_id"].iloc[0]
        bills.append({"billId": f"b_{tx_id}", "createdAt": ts, "customerId": cid if isinstance(cid, str) else None,
                      "items": items, "paymentMode": "cash",
                      "totalPaise": sum(i["qtyMilli"] * i["unitPricePaise"] // 1000 for i in items)})
    return bills


def catalog_items(stock_units: int = 3) -> dict:
    return {sku: {**it.to_dict(), "stockMilli": stock_units * 1000} for sku, it in items_frame().iterrows()}


UDHAAR = [
    {"customerId": "c_good", "kind": "credit", "amountPaise": 50_000, "ts": NOW - 40 * DAY_MS},
    {"customerId": "c_good", "kind": "payment", "amountPaise": 50_000, "ts": NOW - 35 * DAY_MS},
    {"customerId": "c_good", "kind": "credit", "amountPaise": 20_000, "ts": NOW - 3 * DAY_MS},
    {"customerId": "c_bad", "kind": "credit", "amountPaise": 90_000, "ts": NOW - 120 * DAY_MS},
    {"customerId": "c_bad", "kind": "credit", "amountPaise": 60_000, "ts": NOW - 70 * DAY_MS},
    {"customerId": "c_bad", "kind": "payment", "amountPaise": 5_000, "ts": NOW - 100 * DAY_MS},
]


@pytest.fixture(scope="module")
def long_bills():
    return make_bills(120)


def test_udhaar_features_fifo():
    f = features_for({}, [t for t in UDHAAR if t["customerId"] == "c_good"], NOW)
    assert f["outstanding_paise"] == 20_000
    assert f["avg_days_to_repay"] == pytest.approx(5)
    assert f["late_payments"] == 0
    bad = features_for({"remindersSent": 4}, [t for t in UDHAAR if t["customerId"] == "c_bad"], NOW)
    assert bad["late_payments"] >= 1 and bad["reminders_ignored"] == 4
    assert bad["days_since_payment"] == pytest.approx(100)


def test_panel_fills_missing_days(long_bills):
    panel = bills_to_panel(long_bills[:50], catalog_items(), pd.Timestamp("2026-11-15").to_pydatetime())
    per_sku = panel.groupby("sku")["date"].nunique()
    assert per_sku.nunique() == 1  # every sku has every day
    assert (panel["units"] >= 0).all()


def test_compute_insights_full(long_bills):
    out = compute_insights(long_bills, catalog_items(), {}, UDHAAR, NOW)
    assert out["forecastMethod"] == "gradient-boosting"
    assert all(len(v) == 14 for v in out["forecast"].values())
    assert out["reorder"] and all(r["orderUnits"] > 0 for r in out["reorder"])
    assert out["basket"] and out["basket"][0]["lift"] > 1
    assert {s["segment"] for s in out["segments"]} - {"New"}
    risks = {u["customerId"]: u for u in out["udhaar"]}
    assert risks["c_bad"]["risk"] > risks["c_good"]["risk"]
    json.dumps(out)  # serialisable
    assert "Reorder today" in digest(out, "Sharma Kirana")


def test_short_history_uses_fallback():
    bills = make_bills(20)
    panel = bills_to_panel(bills, catalog_items(), pd.Timestamp("2026-11-15").to_pydatetime())
    fc, method, _ = forecast(panel)
    assert method == "seasonal-average"
    assert (fc["forecast"] >= 0).all()


def test_empty_shop():
    out = compute_insights([], {}, {}, [], NOW)
    assert out["billCount"] == 0 and out["segments"] == [] and out["udhaar"] == []


@pytest.fixture
def aws(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "ap-south-1")
    monkeypatch.setenv("TABLE_NAME", "sros")
    with mock_aws():
        ddb = boto3.resource("dynamodb")
        table = ddb.create_table(
            TableName="sros", BillingMode="PAY_PER_REQUEST",
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}, {"AttributeName": "sk", "AttributeType": "S"}],
        )
        topic = boto3.client("sns").create_topic(Name="digest")["TopicArn"]
        monkeypatch.setenv("DIGEST_TOPIC_ARN", topic)
        yield table


def seed_shop(table, shop: str, bills: list[dict]) -> None:
    pk = f"SHOP#{shop}"
    with table.batch_writer() as bw:
        bw.put_item(Item={"pk": pk, "sk": "PROFILE", "data": json.dumps({"shopName": "Test", "digestOptIn": True})})
        for b in bills:
            bw.put_item(Item={"pk": pk, "sk": f"BILL#{b['createdAt']:013d}#{b['billId']}", "data": json.dumps(b)})
        for sku, it in list(catalog_items().items())[:10]:
            bw.put_item(Item={"pk": pk, "sk": f"ITEM#{sku}", "data": json.dumps(it)})
        for i, t in enumerate(UDHAAR):
            bw.put_item(Item={"pk": pk, "sk": f"UDHAAR#{t['customerId']}#{t['ts']}#{i}", "data": json.dumps(t)})


def test_handler_on_demand(aws, long_bills, monkeypatch):
    monkeypatch.setattr(H.time, "time", lambda: NOW / 1000)
    seed_shop(aws, "shop_a", long_bills[:2000])
    res = H.handler({"shopId": "shop_a"}, None)
    assert res["processed"] == 1 and not res["results"][0].get("error")
    meta = json.loads(aws.get_item(Key={"pk": "SHOP#shop_a", "sk": "INSIGHT#meta"})["Item"]["data"])
    assert meta["billCount"] > 0
    assert aws.get_item(Key={"pk": "SHOP#shop_a", "sk": "INSIGHT#reorder"}).get("Item")


def test_handler_scheduled_runs_all_shops_and_isolates_failures(aws, long_bills, monkeypatch):
    monkeypatch.setattr(H.time, "time", lambda: NOW / 1000)
    seed_shop(aws, "shop_a", long_bills[:300])
    seed_shop(aws, "shop_b", long_bills[300:600])
    aws.put_item(Item={"pk": "SHOP#shop_c", "sk": "PROFILE", "data": "{}"})
    aws.put_item(Item={"pk": "SHOP#shop_c", "sk": f"BILL#{NOW - DAY_MS:013d}#x", "data": "not json"})
    res = H.handler({"source": "aws.events"}, None)
    by = {r["shopId"]: r for r in res["results"]}
    assert set(by) == {"shop_a", "shop_b", "shop_c"}
    assert by["shop_c"].get("error") and not by["shop_a"].get("error")


def test_handler_rejects_bad_shop_id(aws):
    with pytest.raises(ValueError):
        H.handler({"shopId": "../../etc"}, None)
