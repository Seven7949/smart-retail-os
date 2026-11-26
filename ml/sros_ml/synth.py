"""Deterministic synthetic kirana data.

Real shop data is private and public retail datasets are Western
supermarkets. This generator encodes Indian kirana dynamics so the models
have realistic structure to learn — and, because the structure is *planted*,
we can measure how well each algorithm recovers it (external validation):

* daily demand: weekday pattern, month seasonality per item, payday bump
  (1st–5th), month-end dip, festival windows with per-item lift, slow trend,
  random promotion days, Poisson noise
* transactions: planted basket templates (breakfast, chai-time, sabzi ...)
* customers: planted personas (daily regular, monthly bulk, occasional,
  lapsed, festive-only)
* udhaar: credit customers with a latent reliability that drives payment
  behaviour and the default label
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import numpy as np
import pandas as pd

from .catalog import festival_calendar, items_frame, load_catalog, season_factor

DOW_FACTOR = np.array([0.95, 0.92, 0.95, 0.98, 1.05, 1.18, 1.12])  # Mon..Sun
DEFAULT_START = date(2025, 1, 1)
DEFAULT_END = date(2026, 11, 15)

PERSONAS = {
    # name: (share, visits_per_week, items_per_visit, basket_value_mult, active_last_days)
    "daily_regular": (0.30, 5.0, 2.5, 1.0, 0),
    "monthly_bulk": (0.15, 0.35, 9.0, 3.0, 0),
    "occasional": (0.30, 0.8, 2.0, 1.0, 0),
    "lapsed": (0.15, 2.5, 2.5, 1.0, 75),  # stopped visiting ~75 days before end
    "festive_only": (0.10, 0.15, 4.0, 2.0, 0),
}


@dataclass(frozen=True)
class SynthConfig:
    start: date = DEFAULT_START
    end: date = DEFAULT_END
    seed: int = 42
    n_customers: int = 400
    tx_days: int = 180
    n_credit_customers: int = 1200


def daily_demand(cfg: SynthConfig = SynthConfig()) -> pd.DataFrame:
    """Long panel: date, sku, units (int), price_paise, promo (0/1)."""
    rng = np.random.default_rng(cfg.seed)
    items = items_frame()
    cal = festival_calendar(cfg.start, cfg.end)
    n_days = len(cal)
    dow = cal["date"].dt.dayofweek.to_numpy()
    dom = cal["date"].dt.day.to_numpy()
    month = cal["date"].dt.month.to_numpy()
    payday = np.where(dom <= 5, 1.15, np.where(dom >= 26, 0.92, 1.0))
    trend = 1 + 0.00025 * np.arange(n_days)
    frames = []
    for _, it in items.iterrows():
        season = np.array([season_factor(it["season"], m) for m in month])
        fest = 1 + (it["festivalLift"] - 1) * cal["fest_intensity"].to_numpy()
        promo = (rng.random(n_days) < 0.04).astype(int)
        lam = it["baseDaily"] * DOW_FACTOR[dow] * season * payday * fest * trend * (1 + 0.3 * promo)
        # item-level random walk in popularity keeps the series non-trivial
        drift = np.exp(np.cumsum(rng.normal(0, 0.01, n_days)))
        lam = lam * np.clip(drift, 0.7, 1.4)
        units = rng.poisson(lam)
        price = np.where(promo == 1, int(it["pricePaise"] * 0.9), it["pricePaise"])
        frames.append(
            pd.DataFrame(
                {"date": cal["date"], "sku": it["sku"], "units": units, "price_paise": price, "promo": promo}
            )
        )
    out = pd.concat(frames, ignore_index=True)
    return out.merge(cal, on="date", how="left")


def _assign_personas(rng: np.random.Generator, n: int) -> list[str]:
    names = list(PERSONAS)
    shares = np.array([PERSONAS[p][0] for p in names])
    return list(rng.choice(names, size=n, p=shares / shares.sum()))


def transactions(cfg: SynthConfig = SynthConfig()) -> pd.DataFrame:
    """Basket-level log for the last ``tx_days`` days.

    Columns: tx_id, date, customer_id (None = walk-in), persona, sku, qty.
    """
    rng = np.random.default_rng(cfg.seed + 1)
    cat = load_catalog()
    items = items_frame()
    skus = items.index.to_list()
    pop = items["baseDaily"].to_numpy() / items["baseDaily"].sum()
    templates = cat["baskets"]
    t_weights = np.array([t["weight"] for t in templates])
    t_weights = t_weights / t_weights.sum()
    end = pd.Timestamp(cfg.end)
    days = pd.date_range(end - pd.Timedelta(days=cfg.tx_days - 1), end, freq="D")
    cal = festival_calendar(days[0].date(), days[-1].date()).set_index("date")
    personas = _assign_personas(rng, cfg.n_customers)
    rows: list[tuple] = []
    tx_id = 0

    def basket(n_items: float, festive: bool) -> list[str]:
        chosen: set[str] = set()
        if rng.random() < 0.75:
            t = templates[rng.choice(len(templates), p=t_weights)]
            if festive and rng.random() < 0.5:
                t = next(x for x in templates if x["name"] == "festive-sweets")
            for s in t["skus"]:
                if rng.random() < 0.7:
                    chosen.add(s)
        extra = max(0, int(rng.poisson(max(n_items - len(chosen), 0.3))))
        for s in rng.choice(skus, size=extra, p=pop):
            chosen.add(str(s))
        return sorted(chosen) or [str(rng.choice(skus, p=pop))]

    for day in days:
        fest = cal.loc[day, "fest_intensity"] > 0.3
        days_left = (end - day).days
        for cid, persona in enumerate(personas):
            _, per_week, n_items, _, inactive = PERSONAS[persona]
            if inactive and days_left < min(inactive, cfg.tx_days // 2):
                continue
            p_visit = per_week / 7
            if persona == "festive_only" and fest:
                p_visit = 0.6
            if rng.random() < p_visit:
                for s in basket(n_items, fest):
                    rows.append((tx_id, day, f"c_{cid:04d}", persona, s, int(rng.integers(1, 4))))
                tx_id += 1
        for _ in range(int(rng.poisson(28 * (1.6 if fest else 1.0)))):  # walk-ins
            for s in basket(1.8, fest):
                rows.append((tx_id, day, None, "walk_in", s, 1))
            tx_id += 1
    df = pd.DataFrame(rows, columns=["tx_id", "date", "customer_id", "persona", "sku", "qty"])
    df["price_paise"] = df["sku"].map(items["pricePaise"]).astype(int)
    return df


def udhaar_accounts(cfg: SynthConfig = SynthConfig()) -> pd.DataFrame:
    """One row per credit customer at a cutoff date with behavioural features
    and the label ``defaulted`` (did not clear dues within 60 days after).

    Only payment behaviour is used — no demographic attributes (see PRD §6).
    """
    rng = np.random.default_rng(cfg.seed + 2)
    n = cfg.n_credit_customers
    reliability = rng.beta(5, 2, n)  # latent: most customers are reliable
    tenure = rng.integers(30, 900, n)
    avg_purchase = rng.lognormal(np.log(350), 0.5, n)
    credit_limit = np.round(avg_purchase * rng.uniform(4, 10, n), -1)
    utilisation = np.clip(rng.normal(0.9 - 0.7 * reliability, 0.12), 0, 1.5)
    outstanding = np.round(credit_limit * utilisation, 0)
    days_since_payment = np.clip(rng.gamma(2, 6 + 40 * (1 - reliability)), 0, 240).round()
    avg_days_to_repay = np.clip(rng.normal(8 + 45 * (1 - reliability), 4), 1, 120).round()
    late_payments = rng.poisson(0.3 + 6 * (1 - reliability) * (tenure / 365) ** 0.5)
    pay_ratio_90d = np.clip(rng.normal(0.35 + 0.65 * reliability, 0.08), 0, 1.2)
    reminders_ignored = rng.poisson(3 * (1 - reliability))
    logit = (
        -2.0
        + 7.0 * (0.65 - reliability)
        + 0.8 * (utilisation - 0.5)
        + 0.012 * (days_since_payment - 20)
        + rng.normal(0, 0.5, n)  # irreducible noise: life happens
    )
    defaulted = (rng.random(n) < 1 / (1 + np.exp(-logit))).astype(int)
    return pd.DataFrame(
        {
            "customer_id": [f"u_{i:04d}" for i in range(n)],
            "tenure_days": tenure,
            "avg_purchase_rs": avg_purchase.round(0),
            "credit_limit_rs": credit_limit,
            "outstanding_rs": outstanding,
            "utilisation": utilisation.round(3),
            "days_since_payment": days_since_payment,
            "avg_days_to_repay": avg_days_to_repay,
            "late_payments": late_payments,
            "pay_ratio_90d": pay_ratio_90d.round(3),
            "reminders_ignored": reminders_ignored,
            "defaulted": defaulted,
        }
    )
