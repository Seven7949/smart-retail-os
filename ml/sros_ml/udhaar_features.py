"""Turn a shop's raw udhaar transactions into the risk-model features.

Mirrors ``app/src/ml/udhaarRisk.ts`` so the phone and the cloud agree.
"""
from __future__ import annotations

DAY_MS = 86_400_000
LATE_AFTER_DAYS = 30


def features_for(customer: dict, txns: list[dict], now_ms: int) -> dict:
    """``txns``: [{kind: credit|payment, amountPaise, ts}] for one customer."""
    txns = sorted(txns, key=lambda t: t["ts"])
    credits = [t for t in txns if t["kind"] == "credit"]
    payments = [t for t in txns if t["kind"] == "payment"]
    outstanding = sum(t["amountPaise"] for t in credits) - sum(t["amountPaise"] for t in payments)
    outstanding = max(outstanding, 0)
    avg_credit = (sum(t["amountPaise"] for t in credits) / len(credits)) if credits else 0
    limit = customer.get("creditLimitPaise") or max(avg_credit * 6, 50_000)
    first = txns[0]["ts"] if txns else now_ms
    last_pay = payments[-1]["ts"] if payments else first

    # FIFO-match payments to credits to estimate repayment delays
    queue = [[c["ts"], c["amountPaise"]] for c in credits]
    delays: list[float] = []
    late = 0
    qi = 0
    for p in payments:
        remaining = p["amountPaise"]
        while remaining > 0 and qi < len(queue):
            take = min(remaining, queue[qi][1])
            queue[qi][1] -= take
            remaining -= take
            if queue[qi][1] == 0:
                d = (p["ts"] - queue[qi][0]) / DAY_MS
                delays.append(d)
                late += d > LATE_AFTER_DAYS
                qi += 1
    # still-open credits older than the limit also count as late
    late += sum(1 for ts, amt in queue[qi:] if amt > 0 and (now_ms - ts) / DAY_MS > LATE_AFTER_DAYS)

    since = now_ms - 90 * DAY_MS
    c90 = sum(t["amountPaise"] for t in credits if t["ts"] >= since)
    p90 = sum(t["amountPaise"] for t in payments if t["ts"] >= since)
    return {
        "tenure_days": (now_ms - first) / DAY_MS,
        "utilisation": outstanding / limit if limit else 0.0,
        "days_since_payment": (now_ms - last_pay) / DAY_MS,
        "avg_days_to_repay": (sum(delays) / len(delays)) if delays else (now_ms - first) / DAY_MS,
        "late_payments": late,
        "pay_ratio_90d": (p90 / c90) if c90 else 1.0,
        "reminders_ignored": int(customer.get("remindersSent", 0)),
        "outstanding_paise": outstanding,
    }
