"""Schema validation at the API boundary (stdlib only, no extra Lambda deps).

Every function returns a *new* clean dict containing only known fields
(unknown fields are dropped), or raises ValueError with a precise message.
"""
from __future__ import annotations

import re
from typing import Any

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_SAFE = 2**53 - 1
MAX_ITEMS = 5000
MAX_CUSTOMERS = 5000
MAX_UDHAAR = 5000
MAX_CHAIN = 500
UNITS = {"pcs", "kg", "l"}
PAYMENT_MODES = {"cash", "upi", "udhaar"}


def _int(v: Any, name: str, lo: int = 0, hi: int = MAX_SAFE) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise ValueError(f"{name} must be an integer in [{lo}, {hi}]")
    return v


def _str(v: Any, name: str, max_len: int = 120, min_len: int = 1) -> str:
    if not isinstance(v, str) or not min_len <= len(v) <= max_len:
        raise ValueError(f"{name} must be a string of length {min_len}..{max_len}")
    if any(ord(c) < 0x20 for c in v):
        raise ValueError(f"{name} contains control characters")
    return v


def _id(v: Any, name: str) -> str:
    if not isinstance(v, str) or not ID_RE.match(v):
        raise ValueError(f"{name} must match [A-Za-z0-9_-]{{1,64}}")
    return v


def _list(v: Any, name: str, max_len: int) -> list:
    if v is None:
        return []
    if not isinstance(v, list) or len(v) > max_len:
        raise ValueError(f"{name} must be a list of at most {max_len} entries")
    return v


def _obj(v: Any, name: str) -> dict:
    if not isinstance(v, dict):
        raise ValueError(f"{name} must be an object")
    return v


def item(v: Any) -> dict:
    v = _obj(v, "item")
    out = {
        "sku": _id(v.get("sku"), "item.sku"),
        "name": _str(v.get("name"), "item.name"),
        "unit": v.get("unit") if v.get("unit") in UNITS else "pcs",
        "pricePaise": _int(v.get("pricePaise"), "item.pricePaise", 1, 10_000_000),
        "stockMilli": _int(v.get("stockMilli", 0), "item.stockMilli", -10**12, 10**12),
    }
    for k, lo, hi in (("costPaise", 0, 10_000_000), ("leadTimeDays", 0, 60), ("packSize", 1, 10_000),
                      ("shelfLifeDays", 1, 3650)):
        if v.get(k) is not None:
            out[k] = _int(v[k], f"item.{k}", lo, hi)
    if v.get("category") is not None:
        out["category"] = _str(v["category"], "item.category", 40)
    return out


def customer(v: Any) -> dict:
    """Phone numbers are deliberately NOT accepted: they stay on the device."""
    v = _obj(v, "customer")
    out = {"customerId": _id(v.get("customerId"), "customer.customerId"),
           "name": _str(v.get("name"), "customer.name", 80)}
    if v.get("creditLimitPaise") is not None:
        out["creditLimitPaise"] = _int(v["creditLimitPaise"], "customer.creditLimitPaise", 0, 100_000_000)
    if v.get("remindersSent") is not None:
        out["remindersSent"] = _int(v["remindersSent"], "customer.remindersSent", 0, 10_000)
    return out


def udhaar_txn(v: Any) -> dict:
    v = _obj(v, "udhaar")
    kind = v.get("kind")
    if kind not in ("credit", "payment"):
        raise ValueError("udhaar.kind must be credit or payment")
    out = {"id": _id(v.get("id"), "udhaar.id"), "customerId": _id(v.get("customerId"), "udhaar.customerId"),
           "kind": kind, "amountPaise": _int(v.get("amountPaise"), "udhaar.amountPaise", 1, 100_000_000),
           "ts": _int(v.get("ts"), "udhaar.ts")}
    if v.get("billId") is not None:
        out["billId"] = _id(v["billId"], "udhaar.billId")
    return out


def bill(v: Any) -> dict:
    """Shape check only; arithmetic + hash integrity is enforced by the Rust signer."""
    v = _obj(v, "bill")
    mode = v.get("paymentMode")
    if mode not in PAYMENT_MODES:
        raise ValueError("bill.paymentMode invalid")
    lines = _list(v.get("items"), "bill.items", 200)
    if not lines:
        raise ValueError("bill.items must not be empty")
    return {
        "billId": _id(v.get("billId"), "bill.billId"),
        "createdAt": _int(v.get("createdAt"), "bill.createdAt"),
        "customerId": None if v.get("customerId") is None else _id(v["customerId"], "bill.customerId"),
        "items": [{"sku": _id(_obj(li, "line").get("sku"), "line.sku"),
                   "qtyMilli": _int(li.get("qtyMilli"), "line.qtyMilli", 1, 10**9),
                   "unitPricePaise": _int(li.get("unitPricePaise"), "line.unitPricePaise", 1, 10**9)} for li in lines],
        "paymentMode": mode,
        "totalPaise": _int(v.get("totalPaise"), "bill.totalPaise"),
    }


def entry(v: Any) -> dict:
    v = _obj(v, "entry")
    for h in ("payloadHash", "prevHash"):
        if not isinstance(v.get(h), str) or not HEX64_RE.match(v[h]):
            raise ValueError(f"entry.{h} must be 64 lowercase hex chars")
    return {"billId": _id(v.get("billId"), "entry.billId"), "payloadHash": v["payloadHash"],
            "prevHash": v["prevHash"], "seq": _int(v.get("seq"), "entry.seq"),
            "shopId": _id(v.get("shopId"), "entry.shopId"), "timestamp": _int(v.get("timestamp"), "entry.timestamp")}


def chain_item(v: Any) -> dict:
    v = _obj(v, "chain item")
    h = v.get("entryHash")
    if not isinstance(h, str) or not HEX64_RE.match(h):
        raise ValueError("entryHash must be 64 lowercase hex chars")
    return {"bill": bill(v.get("bill")), "entry": entry(v.get("entry")), "entryHash": h}


def sync_request(body: dict) -> dict:
    profile = body.get("profile")
    clean_profile = None
    if profile is not None:
        profile = _obj(profile, "profile")
        clean_profile = {"shopName": _str(profile.get("shopName", "My shop"), "profile.shopName", 80),
                         "digestOptIn": bool(profile.get("digestOptIn", False))}
    chain = [chain_item(c) for c in _list(body.get("chain"), "chain", MAX_CHAIN)]
    seqs = [c["entry"]["seq"] for c in chain]
    if seqs != sorted(seqs) or len(set(seqs)) != len(seqs):
        raise ValueError("chain must be sorted by seq without duplicates")
    return {
        "profile": clean_profile,
        "items": [item(i) for i in _list(body.get("items"), "items", MAX_ITEMS)],
        "customers": [customer(c) for c in _list(body.get("customers"), "customers", MAX_CUSTOMERS)],
        "udhaar": [udhaar_txn(u) for u in _list(body.get("udhaar"), "udhaar", MAX_UDHAAR)],
        "chain": chain,
    }
