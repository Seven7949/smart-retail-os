"""Unit + integration tests for the ML pipeline (pytest)."""
from __future__ import annotations

from datetime import date
import json

import numpy as np
import pandas as pd
import pytest

from sros_ml import basket, forecasting, metrics, replenishment, segmentation, synth, udhaar_risk
from sros_ml.catalog import festival_calendar, items_frame, season_factor

SMALL = synth.SynthConfig(start=date(2025, 6, 1), end=date(2025, 12, 31), n_customers=120, tx_days=60,
                          n_credit_customers=1200)


@pytest.fixture(scope="module")
def panel():
    return synth.daily_demand(SMALL)


@pytest.fixture(scope="module")
def tx():
    return synth.transactions(SMALL)


# ---------- metrics ----------
def test_metrics_known_values():
    y, p = [10, 0, 5], [8, 1, 5]
    assert metrics.mae(y, p) == pytest.approx(1.0)
    assert metrics.rmse(y, p) == pytest.approx(np.sqrt(5 / 3))
    assert metrics.wape(y, p) == pytest.approx(3 / 15)
    assert metrics.mase(y, p, 2.0) == pytest.approx(0.5)
    assert metrics.bias(y, p) == pytest.approx(-1 / 15)
    assert np.isnan(metrics.wape([0, 0], [1, 1]))


# ---------- calendar / synth ----------
def test_diwali_window_peaks_on_the_day():
    cal = festival_calendar(date(2026, 10, 25), date(2026, 11, 12)).set_index("date")
    assert cal.loc["2026-11-08", "fest_intensity"] == pytest.approx(1.0)
    assert cal.loc["2026-11-01", "fest_in_window"] == 1
    assert cal.loc["2026-10-26", "days_to_next_fest"] == 13
    assert cal.loc["2026-11-12", "fest_in_window"] == 0


def test_season_factor():
    assert season_factor("summer", 5) > 1.3
    assert season_factor("winter", 12) > 1.3
    assert season_factor("none", 5) == 1.0
    assert season_factor("summer", 12) < 1.0


def test_synth_is_deterministic_and_complete(panel):
    again = synth.daily_demand(SMALL)
    pd.testing.assert_frame_equal(panel, again)
    assert panel["sku"].nunique() == len(items_frame())
    assert (panel["units"] >= 0).all()


def test_festival_lift_visible_in_data(panel):
    diya = panel[panel["sku"] == "diya-12"]
    fest = diya[diya["fest_intensity"] > 0.8]["units"].mean()
    normal = diya[diya["fest_in_window"] == 0]["units"].mean()
    assert fest > 5 * normal


def test_transactions_have_planted_baskets(tx):
    assert tx["tx_id"].nunique() > 1000
    assert set(tx["persona"]) >= {"daily_regular", "walk_in"}
    # lapsed customers have no recent visits
    last = tx[tx["persona"] == "lapsed"]["date"].max()
    assert (tx["date"].max() - last).days >= 30


# ---------- forecasting ----------
def test_no_leakage_features_only_use_past(panel):
    df = forecasting.make_features(panel)
    one = df[df["sku"] == "milk-amul-500"].reset_index(drop=True)
    i = 60
    # lag_7 at row i equals units at i-7; rolling mean uses rows <= i-7
    assert one.loc[i, "lag_7"] == one.loc[i - 7, "units"]
    assert one.loc[i, "rmean_7"] == pytest.approx(one.loc[i - 13 : i - 7, "units"].mean())
    # mutate the future: features at i must not change
    future = panel.copy()
    mask = (future["sku"] == "milk-amul-500") & (future["date"] > one.loc[i - 7, "date"])
    future.loc[mask, "units"] = 9999
    df2 = forecasting.make_features(future)
    two = df2[df2["sku"] == "milk-amul-500"].reset_index(drop=True)
    cols = ["lag_7", "lag_14", "rmean_7", "rmean_28", "rstd_28", "ewm_14"]
    pd.testing.assert_series_equal(one.loc[i, cols], two.loc[i, cols], check_names=False)


def test_split_is_time_ordered(panel):
    train, test = forecasting.split(forecasting.make_features(panel))
    assert train["date"].max() < test["date"].min()
    assert test["date"].nunique() == forecasting.TEST_DAYS


def test_ml_models_beat_seasonal_naive(panel):
    results, _ = forecasting.evaluate(panel, cv=False)
    by = {r.name: r for r in results}
    naive = by["Seasonal naive (same day last week)"].test["WAPE"]
    assert by["LightGBM"].test["WAPE"] < naive
    assert by["HistGradientBoosting"].test["WAPE"] < naive
    assert all(r.predictions.min() >= 0 for r in results)


def test_feature_importance_sums_to_one(panel):
    imp = forecasting.feature_importance(panel, top=len(forecasting.ALL_FEATURES))
    assert imp.sum() == pytest.approx(1.0)


# ---------- replenishment ----------
ECON = replenishment.ItemEcon(cost_paise=2700, price_paise=2900, lead_time=1, pack_size=12, shelf_life=2)


def test_shelf_fifo_and_expiry():
    shelf = replenishment._Shelf(5, 2)
    shelf.add(5, 2)
    assert shelf.sell(7) == 7 and shelf.units == 3
    assert shelf.age() == 0
    assert shelf.age() == 3  # expired
    assert shelf.units == 0


def test_round_to_pack():
    assert replenishment.round_to_pack(1, 12) == 12
    assert replenishment.round_to_pack(13, 12) == 24
    assert replenishment.round_to_pack(-3, 12) == 0


def test_ss_policy_beats_heuristic_on_durable_item():
    rng = np.random.default_rng(0)
    econ = replenishment.ItemEcon(cost_paise=4300, price_paise=4800, lead_time=3, pack_size=25, shelf_life=365)
    # demand ramps up (festival season): the forecast sees it, the 28-day average does not
    demand = rng.poisson(np.linspace(8, 20, 56))
    fc = np.linspace(8, 20, 56)
    hist = rng.poisson(8, 60)
    ss = replenishment.simulate(demand, econ, replenishment.ss_policy(fc, 3.0, econ), 40, "ss")
    heur = replenishment.simulate(demand, econ, replenishment.heuristic_policy(hist, econ), 40, "heur")
    assert ss.total_cost_paise < heur.total_cost_paise
    assert ss.fill_rate > heur.fill_rate


def test_perishables_run_lean():
    rng = np.random.default_rng(0)
    demand = rng.poisson(30, 60)
    ss = replenishment.simulate(demand, ECON, replenishment.ss_policy(np.full(60, 30.0), 5.5, ECON), 30, "ss")
    assert replenishment.service_z(ECON) < 0  # ₹2 margin milk: newsvendor says under-stock slightly
    assert ss.fill_rate > 0.85
    assert ss.waste_units < 0.1 * demand.sum()


def test_qlearning_learns_to_order():
    rng = np.random.default_rng(1)
    econ = replenishment.ItemEcon(cost_paise=1000, price_paise=1400, lead_time=2, pack_size=10, shelf_life=200)
    train = rng.poisson(10, 200)
    agent = replenishment.QLearningPolicy(econ, 10, seed=1)
    agent.train(train, episodes=30)
    res = replenishment.simulate(rng.poisson(10, 60), econ, agent.decide, 30, "q")
    never = replenishment.simulate(rng.poisson(10, 60), econ, lambda *a: 0, 30, "never")
    assert res.fill_rate > never.fill_rate
    assert res.total_cost_paise < never.total_cost_paise


def test_reorder_suggestion():
    s = replenishment.reorder_suggestion(2, np.full(14, 10.0), 3.0, ECON)
    assert s["reorder"] and s["orderUnits"] % 12 == 0
    s2 = replenishment.reorder_suggestion(500, np.full(14, 10.0), 3.0, ECON)
    assert not s2["reorder"] and s2["daysOfCover"] == 50.0


# ---------- basket ----------
def test_apriori_equals_fpgrowth_and_finds_planted_rules(tx):
    out = basket.compare(tx, min_support=0.02)
    assert out["identical_itemsets"]
    assert out["planted_precision_top20"] >= 0.7
    recs = basket.rules_to_records(out["rules"], top=5)
    assert recs and recs[0]["lift"] > 1.2
    json.dumps(recs)


def test_rules_from_empty():
    assert basket.rules_from(pd.DataFrame(columns=["support", "itemsets"]), 0).empty


# ---------- segmentation ----------
def test_segmentation_finds_structure(tx):
    df = segmentation.rfm(tx)
    out = segmentation.compare(df)
    assert out["results"]["KMeans"]["silhouette"] > 0.2
    assert out["results"]["KMeans"]["adjusted_rand_vs_personas"] > 0.2
    names = segmentation.name_segments(df, out["labels"])
    assert len(names) == out["best_k"]


# ---------- udhaar risk ----------
def test_udhaar_models_and_export(tmp_path):
    df = synth.udhaar_accounts(SMALL)
    out = udhaar_risk.compare(df)
    for name, r in out["results"].items():
        assert r["roc_auc"] > 0.7, name
        assert r["pr_auc"] > out["positive_rate"], name  # better than random
    lr = out["fitted"]["LogisticRegression"]
    payload = udhaar_risk.export_logistic(lr, tmp_path / "m.json")
    row = df.iloc[0][udhaar_risk.FEATURES].to_dict()
    expected = lr.predict_proba(pd.DataFrame([row]))[0, 1]
    assert udhaar_risk.score(payload, row) == pytest.approx(expected, abs=1e-4)
