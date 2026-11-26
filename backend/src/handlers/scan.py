"""Supplier-invoice scanning with Amazon Textract AnalyzeExpense.

1. POST /scan/upload-url  -> short-lived presigned POST (max 5 MB, image only),
   key forced under scans/<shop>/ so shops can never read each other's files.
2. POST /scan/parse {key} -> Textract reads the invoice; we return clean lines.
   Matching lines to inventory happens on the phone (same matcher as voice).
"""
from __future__ import annotations

import os
import re
import uuid

import boto3

from common.http import ApiError, api, json_body, shop_id

MAX_UPLOAD_BYTES = 5 * 1024 * 1024
URL_TTL_SECONDS = 300
CONTENT_TYPES = {"image/jpeg": "jpg", "image/png": "png"}
KEY_RE = re.compile(r"^scans/[A-Za-z0-9_-]{1,64}/[0-9a-f-]{36}\.(jpg|png)$")
MONEY_RE = re.compile(r"-?\d[\d,]*(?:\.\d+)?")
MAX_LINES = 200


def parse_money_paise(text: str | None) -> int | None:
    if not text:
        return None
    m = MONEY_RE.search(text.replace(" ", ""))
    if not m:
        return None
    try:
        value = round(float(m.group(0).replace(",", "")) * 100)
    except ValueError:
        return None
    return value if 0 <= value < 10**10 else None


def parse_qty_milli(text: str | None) -> int:
    if not text:
        return 1000
    m = re.search(r"\d+(?:\.\d+)?", text.replace(",", ""))
    if not m:
        return 1000
    qty = float(m.group(0))
    if re.search(r"\b(g|gm|gms|gram|grams|ml)\b", text.lower()):
        qty = qty / 1000
    return max(1, min(int(round(qty * 1000)), 10**9))


def _fields(fields: list[dict]) -> dict[str, str]:
    out: dict[str, str] = {}
    for f in fields or []:
        t = (f.get("Type") or {}).get("Text")
        v = (f.get("ValueDetection") or {}).get("Text")
        if t and v and t not in out:
            out[t] = v.strip()[:200]
    return out


def parse_expense(resp: dict) -> dict:
    docs = resp.get("ExpenseDocuments") or []
    summary: dict[str, str] = {}
    lines: list[dict] = []
    for doc in docs:
        for k, v in _fields(doc.get("SummaryFields")).items():
            summary.setdefault(k, v)
        for group in doc.get("LineItemGroups") or []:
            for li in group.get("LineItems") or []:
                f = _fields(li.get("LineItemExpenseFields"))
                desc = f.get("ITEM") or f.get("PRODUCT_CODE")
                if not desc:
                    continue
                qty = parse_qty_milli(f.get("QUANTITY"))
                unit = parse_money_paise(f.get("UNIT_PRICE"))
                amount = parse_money_paise(f.get("PRICE"))
                if unit is None and amount is not None:
                    unit = round(amount * 1000 / qty)
                lines.append({"description": desc[:120], "qtyMilli": qty, "unitPricePaise": unit, "amountPaise": amount})
                if len(lines) >= MAX_LINES:
                    break
    return {"vendor": summary.get("VENDOR_NAME"), "invoiceDate": summary.get("INVOICE_RECEIPT_DATE"),
            "totalPaise": parse_money_paise(summary.get("TOTAL")), "lines": lines}


@api
def handler(event, _ctx):
    shop = shop_id(event)
    route = event.get("routeKey", "")
    body = json_body(event)
    bucket = os.environ["SCAN_BUCKET"]
    if route == "POST /scan/upload-url":
        ctype = body.get("contentType")
        if ctype not in CONTENT_TYPES:
            raise ApiError(400, "BAD_CONTENT_TYPE", "contentType must be image/jpeg or image/png")
        key = f"scans/{shop}/{uuid.uuid4()}.{CONTENT_TYPES[ctype]}"
        post = boto3.client("s3").generate_presigned_post(
            Bucket=bucket, Key=key, Fields={"Content-Type": ctype},
            Conditions=[{"Content-Type": ctype}, ["content-length-range", 1, MAX_UPLOAD_BYTES]],
            ExpiresIn=URL_TTL_SECONDS)
        return 200, {"key": key, "url": post["url"], "fields": post["fields"], "maxBytes": MAX_UPLOAD_BYTES}
    if route == "POST /scan/parse":
        key = body.get("key")
        if not isinstance(key, str) or not KEY_RE.match(key) or not key.startswith(f"scans/{shop}/"):
            raise ApiError(403, "FORBIDDEN_KEY", "you can only parse your own uploads")
        resp = boto3.client("textract").analyze_expense(Document={"S3Object": {"Bucket": bucket, "Name": key}})
        return 200, parse_expense(resp)
    raise ApiError(404, "NOT_FOUND", "unknown route")
