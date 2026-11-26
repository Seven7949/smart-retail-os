"""Per-shop insight generation used by the nightly ml-batch Lambda.

Pure function of the shop's records -> JSON-serialisable insights. It reuses
the research modules so production = what the report evaluated.
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from sros_ml import basket, replenishment
from sros_ml.catalog import SPEC_DIR, festival_calendar
from sros_ml.forecasting import ALL_FEATURES, HORIZON, make_features
from sros_ml.udhaar_features import features_for
from sros_ml.udhaar_risk import score

MIN_HISTORY_DAYS_FOR_ML = 56
MAX_SKUS = 1500  # bounds memory/time per shop so one shop cannot stall the nightly run
FORECAST_DAYS = 14
IST = timezone(timedelta(hours=5, minutes=30))
DEFAULT_ECON = {"leadTimeDays": 2, "packSize": 1, "shelfLifeDays": 180}


def _udhaar_model() -> dict:
    return json.loads((SPEC_DIR / "udhaar_model.json").read_text(encoding="utf-8"))


def bills_to_panel(bills: list[dict], items: dict[str, dict], end: datetime) -> pd.DataFrame:
    rows = []
    known = set(list(items)[:MAX_SKUS]) if items else None
    for b in bills:
        day = datetime.fromtimestamp(b["createdAt"] / 1000, IST).date()
        for li in b["items"]:
            if known is not None and li["sku"] not in known:
                continue  # only forecast SKUs the shop actually stocks
            rows.append((pd.Timestamp(day), li["sku"], li["qtyMilli"] / 1000, li["unitPricePaise"]))
    if not rows:
        return pd.DataFrame(columns=["date", "sku", "units", "price_paise", "promo"])
    df = pd.DataFrame(rows, columns=["date", "sku", "units", "price_paise"])
    daily = df.groupby(["date", "sku"]).agg(units=("units", "sum"), price_paise=("price_paise", "mean")).reset_index()
    start = daily["date"].min()
    idx = pd.MultiIndex.from_product([pd.date_range(start, pd.Timestamp(end.date()), freq="D"), sorted(daily["sku"].unique())],
                                     names=["date", "sku"])
    daily = daily.set_index(["date", "sku"]).reindex(idx).reset_index()
    daily["units"] = daily["units"].fillna(0.0)
    base_price = daily["sku"].map(lambda s: items.get(s, {}).get("pricePaise", np.nan))
    daily["price_paise"] = daily["price_paise"].fillna(base_price).fillna(daily.groupby("sku")["price_paise"].transform("mean"))
    daily["promo"] = 0
    return daily


def _with_calendar(panel: pd.DataFrame) -> pd.DataFrame:
    cal = festival_calendar(panel["date"].min().date(), panel["date"].max().date())
    return panel.drop(columns=[c for c in cal.columns if c != "date" and c in panel], errors="ignore").merge(cal, on="date")


def _fallback_forecast(panel: pd.DataFrame, future: pd.DataFrame) -> pd.DataFrame:
    """Weekday-adjusted 28-day mean × festival uplift (same as on-device)."""
    out = []
    recent = panel[panel["date"] > panel["date"].max() - pd.Timedelta(days=28)]
    for sku, g in recent.groupby("sku"):
        level = g["units"].mean()
        dow = g.groupby(g["date"].dt.dayofweek)["units"].mean() / level if level > 0 else None
        f = future[future["sku"] == sku].copy()
        mult = f["date"].dt.dayofweek.map(dow).fillna(1.0) if dow is not None else 1.0
        f["forecast"] = level * mult * (1 + f["fest_intensity"] * 0.5)
        out.append(f)
    return pd.concat(out) if out else future.assign(forecast=0.0)


def forecast(panel: pd.DataFrame, days: int = FORECAST_DAYS, seed: int = 42) -> tuple[pd.DataFrame, str, dict]:
    """Return (future rows with `forecast`, method, residual sigma per sku)."""
    panel = _with_calendar(panel)
    last = panel["date"].max()
    skus = sorted(panel["sku"].unique())
    fut_dates = pd.date_range(last + pd.Timedelta(days=1), periods=days, freq="D")
    future = pd.DataFrame([(d, s) for d in fut_dates for s in skus], columns=["date", "sku"])
    future = _with_calendar(future.assign(units=np.nan, price_paise=np.nan, promo=0))
    future["price_paise"] = future["sku"].map(panel.groupby("sku")["price_paise"].last())
    sigma = {s: float(g["units"].tail(56).std() or 0.0) for s, g in panel.groupby("sku")}
    selling_days = panel.loc[panel["units"] > 0, "date"].nunique()
    feats = make_features(panel).dropna(subset=["lag_28", "rmean_28", "rstd_28"])
    if selling_days < MIN_HISTORY_DAYS_FOR_ML or feats["units"].sum() <= 0:
        return _fallback_forecast(panel, future), "seasonal-average", sigma

    from sklearn.ensemble import HistGradientBoostingRegressor

    model = HistGradientBoostingRegressor(loss="poisson", max_iter=300, learning_rate=0.05, random_state=seed)
    model.fit(feats[ALL_FEATURES], feats["units"])
    work = panel.copy()
    preds = []
    # direct 7-day model applied block by block (block 2 uses block-1 forecasts as history)
    for block in range(math.ceil(days / HORIZON)):
        block_dates = fut_dates[block * HORIZON : (block + 1) * HORIZON]
        blk = future[future["date"].isin(block_dates)]
        combo = make_features(pd.concat([work, blk], ignore_index=True))
        rows = combo[combo["date"].isin(block_dates)].copy()
        rows["forecast"] = np.clip(model.predict(rows[ALL_FEATURES]), 0, None)
        preds.append(rows[["date", "sku", "forecast", "fest_intensity"]])
        work = pd.concat([work, rows.assign(units=rows["forecast"])[work.columns]], ignore_index=True)
    return pd.concat(preds, ignore_index=True), "gradient-boosting", sigma


def _econ(item: dict) -> replenishment.ItemEcon:
    price = int(item.get("pricePaise", 100))
    return replenishment.ItemEcon(
        cost_paise=int(item.get("costPaise") or price * 0.85), price_paise=price,
        lead_time=int(item.get("leadTimeDays", DEFAULT_ECON["leadTimeDays"])),
        pack_size=max(1, int(item.get("packSize", DEFAULT_ECON["packSize"]))),
        shelf_life=int(item.get("shelfLifeDays", DEFAULT_ECON["shelfLifeDays"])),
    )


def reorders(fc: pd.DataFrame, sigma: dict, items: dict[str, dict]) -> list[dict]:
    out = []
    for sku, g in fc.groupby("sku"):
        item = items.get(sku)
        if not item:
            continue
        on_hand = item.get("stockMilli", 0) / 1000
        sug = replenishment.reorder_suggestion(on_hand, g.sort_values("date")["forecast"].to_numpy(),
                                               sigma.get(sku, 1.0), _econ(item))
        if sug["reorder"]:
            fest = g["fest_intensity"].max() > 0.3
            out.append({"sku": sku, "name": item.get("name", sku), **sug, "onHand": on_hand,
                        "reason": "festival demand ahead" if fest else "below reorder point"})
    return sorted(out, key=lambda r: r["daysOfCover"])


def segments(bills: list[dict], now_ms: int) -> list[dict]:
    from sklearn.cluster import KMeans
    from sklearn.metrics import silhouette_score
    from sklearn.preprocessing import StandardScaler

    per: dict[str, dict] = {}
    for b in bills:
        c = b.get("customerId")
        if not isinstance(c, str) or not c:
            continue
        p = per.setdefault(c, {"last": 0, "n": 0, "value": 0})
        p["last"] = max(p["last"], b["createdAt"])
        p["n"] += 1
        p["value"] += b["totalPaise"]
    ids = sorted(per)
    if len(ids) < 8:
        return [{"customerId": c, "segment": "New"} for c in ids]
    X = np.array([[(now_ms - per[c]["last"]) / 86_400_000, per[c]["n"], per[c]["value"] / 100] for c in ids])
    Xs = StandardScaler().fit_transform(np.log1p(X))
    best = None
    for k in range(2, min(6, len(ids) - 1) + 1):
        km = KMeans(n_clusters=k, n_init=10, random_state=0).fit(Xs)
        s = silhouette_score(Xs, km.labels_)
        if best is None or s > best[0]:
            best = (s, km.labels_)
    labels = best[1]
    prof = pd.DataFrame(X, columns=["recency", "frequency", "monetary"]).assign(label=labels).groupby("label").median()
    names = {}
    for lab, r in prof.iterrows():
        if r["recency"] == prof["recency"].max() and r["recency"] > 21:
            names[lab] = "At risk"
        elif r["monetary"] == prof["monetary"].max():
            names[lab] = "Champions"
        elif r["frequency"] == prof["frequency"].max():
            names[lab] = "Regulars"
        else:
            names[lab] = "Occasional"
    return [{"customerId": c, "segment": names[l]} for c, l in zip(ids, labels)]


def udhaar(customers: dict[str, dict], txns: list[dict], now_ms: int) -> list[dict]:
    model = _udhaar_model()
    by: dict[str, list] = {}
    for t in txns:
        by.setdefault(t["customerId"], []).append(t)
    out = []
    for cid, ts in by.items():
        f = features_for(customers.get(cid, {}), ts, now_ms)
        if f["outstanding_paise"] <= 0:
            continue
        p = score(model, f)
        band = "high" if p >= model["bands"]["high"] else "medium" if p >= model["bands"]["low"] else "low"
        out.append({"customerId": cid, "risk": round(p, 3), "band": band, "outstandingPaise": f["outstanding_paise"]})
    return sorted(out, key=lambda r: -r["risk"])


def compute_insights(bills: list[dict], items: dict[str, dict], customers: dict[str, dict],
                     udhaar_txns: list[dict], now_ms: int) -> dict:
    now = datetime.fromtimestamp(now_ms / 1000, IST)
    result: dict = {"generatedAt": now_ms, "billCount": len(bills)}
    panel = bills_to_panel(bills, items, now - timedelta(days=1))
    if len(panel):
        fc, method, sigma = forecast(panel)
        result["forecastMethod"] = method
        result["forecast"] = {
            sku: [round(float(v), 2) for v in g.sort_values("date")["forecast"]] for sku, g in fc.groupby("sku")
        }
        result["forecastStart"] = fc["date"].min().strftime("%Y-%m-%d")
        result["reorder"] = reorders(fc, sigma, items)
    if len(bills) >= 30:
        tx = pd.DataFrame([(b["billId"], li["sku"]) for b in bills for li in b["items"]], columns=["tx_id", "sku"])
        oh = basket.one_hot(tx)
        itemsets, _ = basket.mine(oh, "fpgrowth", max(0.01, 5 / len(oh)))
        result["basket"] = basket.rules_to_records(basket.rules_from(itemsets, len(oh)), top=20)
    result["segments"] = segments(bills, now_ms)
    result["udhaar"] = udhaar(customers, udhaar_txns, now_ms)
    return result


def _clean(text: str, limit: int = 60) -> str:
    """Shop-controlled text goes into an email: strip control chars and links."""
    text = "".join(ch for ch in str(text) if ch.isprintable())
    return text.replace("://", " ")[:limit]


def digest(insights: dict, shop_name: str) -> str:
    lines = [f"Dukaan AI daily digest: {_clean(shop_name)}", ""]
    if insights.get("reorder"):
        lines.append("Reorder today:")
        lines += [f"  • {_clean(r['name'])}: {r['orderUnits']} units ({r['reason']})" for r in insights["reorder"][:5]]
    high = [u for u in insights.get("udhaar", []) if u["band"] == "high"]
    if high:
        total = sum(u["outstandingPaise"] for u in high) / 100
        lines.append(f"High-risk udhaar: {len(high)} customers, ₹{total:,.0f} outstanding")
    return "\n".join(lines)


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
