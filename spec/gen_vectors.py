"""Generate shared ledger test vectors (independent reference implementation).

The Rust signer and the TypeScript app must both reproduce every value in
ledger-vectors.json byte for byte. Run: python3 spec/gen_vectors.py
"""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

TEST_SECRET = "test-secret-do-not-use-in-production"
SHOP_ID = "shop_demo_01"
GENESIS = "0" * 64


def canonical(value) -> str:
    # sort_keys + compact separators + raw UTF-8 == LEDGER_SPEC canonical form
    def check(v):
        if isinstance(v, bool) or v is None or isinstance(v, str):
            return
        if isinstance(v, int):
            assert abs(v) <= 2**53 - 1
            return
        if isinstance(v, float):
            raise ValueError("floats are not allowed")
        if isinstance(v, list):
            for x in v:
                check(x)
            return
        if isinstance(v, dict):
            for k, x in v.items():
                assert k.isascii()
                check(x)
            return
        raise TypeError(type(v))

    check(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main() -> None:
    seed = hashlib.sha256(TEST_SECRET.encode("utf-8")).digest()
    key = Ed25519PrivateKey.from_private_bytes(seed)
    public_key = base64.b64encode(
        key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ).decode()

    canonical_cases = [
        {"name": "sorted keys", "input": {"b": 1, "a": [3, 2, 1], "c": {"z": True, "y": None}}},
        {"name": "hindi text stays raw utf-8", "input": {"name": "दूध", "qty": 2}},
        {"name": "escapes", "input": {"s": "quote\" back\\ nl\n tab\t ctl\u0001 bell\u0007 del\u007f"}},
        {"name": "negative and big ints", "input": {"n": -42, "max": 2**53 - 1, "zero": 0}},
        {"name": "empty containers", "input": {"o": {}, "a": [], "s": ""}},
    ]
    for case in canonical_cases:
        case["canonical"] = canonical(case["input"])
        case["sha256"] = sha256_hex(case["canonical"])

    bills = [
        {
            "billId": "b_0001",
            "createdAt": 1767225600000,
            "customerId": None,
            "items": [
                {"sku": "milk-amul-500", "qtyMilli": 2000, "unitPricePaise": 2900},
                {"sku": "parleg-80", "qtyMilli": 3000, "unitPricePaise": 1000},
            ],
            "paymentMode": "cash",
            "totalPaise": 8800,
        },
        {
            "billId": "b_0002",
            "createdAt": 1767229200000,
            "customerId": "c_ramesh",
            "items": [{"sku": "sugar-1", "qtyMilli": 1500, "unitPricePaise": 4800}],
            "paymentMode": "udhaar",
            "totalPaise": 7200,
        },
        {
            "billId": "b_0003",
            "createdAt": 1767232800000,
            "customerId": None,
            "items": [{"sku": "tea-tata-250", "qtyMilli": 1000, "unitPricePaise": 15000}],
            "paymentMode": "upi",
            "totalPaise": 15000,
        },
    ]

    chain = []
    prev = GENESIS
    for seq, bill in enumerate(bills):
        payload_canonical = canonical(bill)
        entry = {
            "billId": bill["billId"],
            "payloadHash": sha256_hex(payload_canonical),
            "prevHash": prev,
            "seq": seq,
            "shopId": SHOP_ID,
            "timestamp": bill["createdAt"],
        }
        entry_hash = sha256_hex(canonical(entry))
        signature = base64.b64encode(key.sign(bytes.fromhex(entry_hash))).decode()
        chain.append(
            {
                "bill": bill,
                "billCanonical": payload_canonical,
                "entry": entry,
                "entryCanonical": canonical(entry),
                "entryHash": entry_hash,
                "signature": signature,
            }
        )
        prev = entry_hash

    out = {
        "spec": "docs/LEDGER_SPEC.md v1",
        "testSecret": TEST_SECRET,
        "publicKeyBase64": public_key,
        "shopId": SHOP_ID,
        "genesisPrevHash": GENESIS,
        "canonicalCases": canonical_cases,
        "rejectFloats": [{"price": 1.5}, {"nested": [0.1]}],
        "chain": chain,
    }
    path = Path(__file__).with_name("ledger-vectors.json")
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
