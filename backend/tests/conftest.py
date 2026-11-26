"""Shared fixtures. The ledger signer is the REAL Rust code (ledger-cli binary),
so these are true cross-language integration tests."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend" / "src"))

TEST_SECRET = "test-secret-do-not-use-in-production"
GENESIS = "0" * 64
SHOP = "3f1c2a9e-1111-4b6a-9c1d-000000000001"
CLI = ROOT / "ledger" / "target" / "debug" / "ledger-cli"


def canonical(v) -> str:
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def make_bill(n: int, mode: str = "cash", customer: str | None = None) -> dict:
    items = [{"sku": "milk-amul-500", "qtyMilli": 2000, "unitPricePaise": 2900},
             {"sku": "parleg-80", "qtyMilli": 1000 + n * 1000, "unitPricePaise": 1000}]
    total = sum((i["qtyMilli"] * i["unitPricePaise"] + 500) // 1000 for i in items)
    return {"billId": f"b_{n:04d}", "createdAt": 1767225600000 + n * 60000, "customerId": customer,
            "items": items, "paymentMode": mode, "totalPaise": total}


def make_chain(n: int, shop: str = SHOP, head: dict | None = None, start: int = 0) -> list[dict]:
    out = []
    seq, prev = (head["seq"] + 1, head["entryHash"]) if head else (0, GENESIS)
    for i in range(n):
        bill = make_bill(start + i)
        entry = {"billId": bill["billId"], "payloadHash": sha(canonical(bill)), "prevHash": prev, "seq": seq,
                 "shopId": shop, "timestamp": bill["createdAt"]}
        h = sha(canonical(entry))
        out.append({"bill": bill, "entry": entry, "entryHash": h})
        prev, seq = h, seq + 1
    return out


def event(route: str, body=None, sub: str | None = SHOP) -> dict:
    ev = {"routeKey": route, "body": json.dumps(body) if body is not None else None, "isBase64Encoded": False,
          "requestContext": {}}
    if sub is not None:
        ev["requestContext"]["authorizer"] = {"jwt": {"claims": {"sub": sub}}}
    return ev


def call(handler, ev) -> tuple[int, dict]:
    res = handler(ev, None)
    return res["statusCode"], json.loads(res["body"])


@pytest.fixture(scope="session")
def ledger_cli() -> Path:
    if not CLI.exists():
        if not shutil.which("cargo"):
            pytest.skip("cargo not available to build the Rust ledger CLI")
        subprocess.run(["cargo", "build", "-q", "-p", "ledger-signer", "--bin", "ledger-cli"],
                       cwd=ROOT / "ledger", check=True)
    return CLI


@pytest.fixture
def rust_signer(ledger_cli, monkeypatch):
    from common import signer

    calls = []

    def invoke(payload):
        calls.append(payload)
        out = subprocess.run([str(ledger_cli)], input=json.dumps(payload), capture_output=True, text=True,
                             env={**os.environ, "LEDGER_TEST_SECRET": TEST_SECRET}, check=True)
        return json.loads(out.stdout)

    monkeypatch.setattr(signer, "invoke", invoke)
    return calls


@pytest.fixture
def aws(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "ap-south-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("TABLE_NAME", "sros-test")
    monkeypatch.setenv("SCAN_BUCKET", "sros-scans-test")
    monkeypatch.setenv("ML_FUNCTION", "ml-batch")
    monkeypatch.setenv("SIGNER_FUNCTION", "ledger-signer")
    with mock_aws():
        table = boto3.resource("dynamodb").create_table(
            TableName="sros-test", BillingMode="PAY_PER_REQUEST",
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"},
                                  {"AttributeName": "sk", "AttributeType": "S"}])
        boto3.client("s3").create_bucket(Bucket="sros-scans-test",
                                         CreateBucketConfiguration={"LocationConstraint": "ap-south-1"})
        yield table
