"""Insights, invoice scanning (Textract) and voice (Bedrock) routes."""
import json

import pytest

from conftest import SHOP, call, event
from handlers import insights as ins_h
from handlers import scan as scan_h
from handlers import voice as voice_h


class FakeClient:
    def __init__(self, **methods):
        self.calls = []
        for name, fn in methods.items():
            setattr(self, name, self._wrap(name, fn))

    def _wrap(self, name, fn):
        def inner(**kw):
            self.calls.append((name, kw))
            return fn(**kw)

        return inner


# ---------- insights ----------
def test_get_insights_and_rate_limited_refresh(aws, monkeypatch):
    aws.put_item(Item={"pk": f"SHOP#{SHOP}", "sk": "INSIGHT#reorder", "data": json.dumps([{"sku": "milk"}])})
    status, body = call(ins_h.handler, event("GET /insights"))
    assert status == 200 and body["insights"]["reorder"] == [{"sku": "milk"}]

    fake = FakeClient(invoke=lambda **kw: {"StatusCode": 202})
    monkeypatch.setattr(ins_h.boto3, "client", lambda name: fake)
    assert call(ins_h.handler, event("POST /insights/refresh"))[0] == 202
    assert json.loads(fake.calls[0][1]["Payload"]) == {"shopId": SHOP}
    assert fake.calls[0][1]["InvocationType"] == "Event"
    status, body = call(ins_h.handler, event("POST /insights/refresh"))
    assert status == 429 and body["error"]["code"] == "TOO_SOON"
    assert call(ins_h.handler, event("DELETE /insights"))[0] == 404


# ---------- scan ----------
def test_upload_url_is_scoped_and_size_limited(aws):
    status, body = call(scan_h.handler, event("POST /scan/upload-url", {"contentType": "image/jpeg"}))
    assert status == 200
    assert body["key"].startswith(f"scans/{SHOP}/") and body["key"].endswith(".jpg")
    policy = body["fields"]["policy"]
    import base64

    conds = json.loads(base64.b64decode(policy))["conditions"]
    assert ["content-length-range", 1, 5 * 1024 * 1024] in conds
    assert call(scan_h.handler, event("POST /scan/upload-url", {"contentType": "text/html"}))[0] == 400


TEXTRACT_RESPONSE = {"ExpenseDocuments": [{
    "SummaryFields": [
        {"Type": {"Text": "VENDOR_NAME"}, "ValueDetection": {"Text": "Gupta Distributors"}},
        {"Type": {"Text": "TOTAL"}, "ValueDetection": {"Text": "₹1,824.00"}},
    ],
    "LineItemGroups": [{"LineItems": [
        {"LineItemExpenseFields": [
            {"Type": {"Text": "ITEM"}, "ValueDetection": {"Text": "PARLE-G 80G"}},
            {"Type": {"Text": "QUANTITY"}, "ValueDetection": {"Text": "48"}},
            {"Type": {"Text": "UNIT_PRICE"}, "ValueDetection": {"Text": "8.20"}},
            {"Type": {"Text": "PRICE"}, "ValueDetection": {"Text": "393.60"}}]},
        {"LineItemExpenseFields": [
            {"Type": {"Text": "ITEM"}, "ValueDetection": {"Text": "Toor Dal"}},
            {"Type": {"Text": "QUANTITY"}, "ValueDetection": {"Text": "500 g"}},
            {"Type": {"Text": "PRICE"}, "ValueDetection": {"Text": "Rs. 71"}}]},
        {"LineItemExpenseFields": [{"Type": {"Text": "PRICE"}, "ValueDetection": {"Text": "5"}}]},
    ]}],
}]}


def test_parse_scoped_to_own_uploads(aws, monkeypatch):
    fake = FakeClient(analyze_expense=lambda **kw: TEXTRACT_RESPONSE)
    monkeypatch.setattr(scan_h.boto3, "client", lambda name: fake)
    key = f"scans/{SHOP}/0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b.jpg"
    status, body = call(scan_h.handler, event("POST /scan/parse", {"key": key}))
    assert status == 200
    assert body["vendor"] == "Gupta Distributors" and body["totalPaise"] == 182400
    assert body["lines"][0] == {"description": "PARLE-G 80G", "qtyMilli": 48000, "unitPricePaise": 820, "amountPaise": 39360}
    assert body["lines"][1]["qtyMilli"] == 500 and body["lines"][1]["unitPricePaise"] == 14200
    assert len(body["lines"]) == 2  # line without description skipped
    other = "scans/another-shop/0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b.jpg"
    for bad in (other, f"scans/{SHOP}/../../x.jpg", 42):
        assert call(scan_h.handler, event("POST /scan/parse", {"key": bad}))[0] == 403
    assert call(scan_h.handler, event("POST /scan/other", {}))[0] == 404


@pytest.mark.parametrize("text,paise", [("₹1,234.50", 123450), ("Rs. 45", 4500), ("abc", None), (None, None),
                                         ("99999999999999", None)])
def test_parse_money(text, paise):
    assert scan_h.parse_money_paise(text) == paise


@pytest.mark.parametrize("text,milli", [("2", 2000), ("2.5 kg", 2500), ("250 gm", 250), (None, 1000), ("pc", 1000)])
def test_parse_qty(text, milli):
    assert scan_h.parse_qty_milli(text) == milli


# ---------- voice ----------
CATALOG = [{"sku": "sugar-1", "name": "Sugar 1kg", "unit": "kg"}, {"sku": "maggi-70", "name": "Maggi", "unit": "pcs"}]


def bedrock_returning(lines):
    return FakeClient(converse=lambda **kw: {"output": {"message": {"content": [
        {"text": "ok"}, {"toolUse": {"name": "bill_lines", "input": {"lines": lines}}}]}}})


def test_voice_parse_validates_model_output(aws, monkeypatch):
    fake = bedrock_returning([{"sku": "sugar-1", "qty": 2}, {"sku": "maggi-70", "qty": 3},
                              {"sku": "rm -rf", "qty": 1}, {"sku": "sugar-1", "qty": -4},
                              {"sku": "maggi-70", "qty": True}, {"sku": "maggi-70", "qty": 0.0001}, "junk"])
    monkeypatch.setattr(voice_h.boto3, "client", lambda name: fake)
    status, body = call(voice_h.handler, event("POST /voice/parse", {"text": "do kilo cheeni teen maggi", "catalog": CATALOG}))
    assert status == 200
    assert body["lines"] == [{"sku": "sugar-1", "qtyMilli": 2000, "name": "Sugar 1kg"},
                             {"sku": "maggi-70", "qtyMilli": 3000, "name": "Maggi"}]
    kw = fake.calls[0][1]
    assert kw["toolConfig"]["toolChoice"] == {"tool": {"name": "bill_lines"}}
    assert "<request>do kilo cheeni teen maggi</request>" in kw["messages"][0]["content"][0]["text"]


@pytest.mark.parametrize("body", [{"text": "", "catalog": CATALOG}, {"text": "x" * 301, "catalog": CATALOG},
                                  {"text": "hi", "catalog": []}, {"text": "hi", "catalog": [{"sku": 1}]}])
def test_voice_rejects_bad_input(aws, body):
    assert call(voice_h.handler, event("POST /voice/parse", body))[0] == 400


def test_voice_requires_auth(aws):
    assert call(voice_h.handler, event("POST /voice/parse", {"text": "a", "catalog": CATALOG}, sub=None))[0] == 401
