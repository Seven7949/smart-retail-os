"""GET /ledger/verify — re-verify the shop's whole chain with the Rust signer.
GET /ledger/public-key — public key so anyone (a lender, an auditor) can verify."""
from __future__ import annotations

from common import repo, signer
from common.http import ApiError, api, shop_id

PAGE = 1000
_public_key: str | None = None


def verify(tbl, shop: str) -> dict:
    head = None
    checked = 0
    for page in repo.ledger_pages(tbl, shop, PAGE):
        if not page:
            break
        items = [{"bill": r["bill"], "entry": r["entry"], "entryHash": r["entryHash"], "signature": r["signature"]}
                 for r in page]
        res = signer.invoke({"action": "verify", "shopId": shop, "from": head, "items": items})
        report = res.get("report") or {}
        checked += int(report.get("checked", 0))
        if not res.get("ok"):
            return {"valid": False, "checked": checked, "failure": report.get("failure") or res.get("error")}
        head = report.get("head")
    return {"valid": True, "checked": checked, "head": head}


@api
def handler(event, _ctx):
    global _public_key
    shop = shop_id(event)
    route = event.get("routeKey", "")
    if route == "GET /ledger/verify":
        return 200, verify(repo.table(), shop)
    if route == "GET /ledger/public-key":
        if _public_key is None:
            _public_key = signer.invoke({"action": "publicKey"})["publicKey"]
        return 200, {"publicKey": _public_key, "algorithm": "Ed25519", "spec": "docs/LEDGER_SPEC.md v1"}
    raise ApiError(404, "NOT_FOUND", "unknown route")
