"""Run the full research pipeline and write ml/reports/.

    python3 run_all.py            # full run (~2-4 min)
    python3 run_all.py --quick    # smaller data, no CV (CI smoke test)
"""
from __future__ import annotations

import argparse
import json
import platform
import time
from datetime import date
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from sros_ml import basket, forecasting, replenishment, segmentation, synth, udhaar_risk  # noqa: E402
from sros_ml.catalog import SPEC_DIR, festival_calendar, items_frame  # noqa: E402

REPORTS = Path(__file__).parent / "reports"
plt.rcParams.update({"figure.dpi": 120, "axes.spines.top": False, "axes.spines.right": False,
                     "axes.grid": True, "grid.alpha": 0.25, "font.size": 9})
INK, ACCENT, MUTED, WARN = "#1f2937", "#0f766e", "#94a3b8", "#d97706"


def fmt(x, nd=3):
    return "—" if x is None or (isinstance(x, float) and np.isnan(x)) else f"{x:.{nd}f}"


def run_forecasting(panel: pd.DataFrame, cv: bool, md: list, out: dict) -> tuple:
    results, test = forecasting.evaluate(panel, cv=cv)
    md += ["## 1. Sales forecasting (#6)", "",
           f"Global model over {panel['sku'].nunique()} SKUs × {panel['date'].nunique()} days. "
           f"Held-out test = last {forecasting.TEST_DAYS} days (includes Dussehra and Diwali). "
           "All lag features are shifted ≥ 7 days → true 7-day-ahead forecasts.", "",
           "| Model | CV MAE | Test MAE | RMSE | WAPE | MASE | Bias | Festival-window WAPE | Fit (s) |",
           "|---|---|---|---|---|---|---|---|---|"]
    rows = []
    for r in results:
        t = r.test
        md.append(f"| {r.name} | {fmt(r.cv_mae)} | {fmt(t['MAE'])} | {fmt(t['RMSE'])} | {fmt(t['WAPE'])} | "
                  f"{fmt(t['MASE'])} | {fmt(t['Bias'])} | {fmt(r.festival_wape)} | {r.fit_seconds:.1f} |")
        rows.append({"model": r.name, **t, "festival_wape": r.festival_wape, "cv_mae": r.cv_mae})
    best = min(results[2:], key=lambda r: r.test["WAPE"])
    naive = results[0]
    ablation = next(r for r in results if "no festival" in r.name)
    lgbm = next(r for r in results if r.name == "LightGBM")
    gain = (ablation.festival_wape - lgbm.festival_wape) / ablation.festival_wape * 100
    md += ["", f"**Best model: {best.name}**: WAPE {fmt(best.test['WAPE'])} vs "
           f"{fmt(naive.test['WAPE'])} for the seasonal-naive baseline "
           f"({(1 - best.test['WAPE'] / naive.test['WAPE']) * 100:.0f}% lower error).",
           f"**Festival features ablation:** during festival windows LightGBM WAPE is {fmt(lgbm.festival_wape)} "
           f"with festival features vs {fmt(ablation.festival_wape)} without them "
           f"({gain:.0f}% lower error). This is the project's main novelty claim.", ""]
    imp = forecasting.feature_importance(panel)
    md += ["Top features (LightGBM gain share): " + ", ".join(f"`{k}` {v:.2f}" for k, v in imp.items()), ""]
    out["forecasting"] = {"results": rows, "best": best.name, "festival_gain_pct": gain,
                          "importance": imp.round(4).to_dict()}

    # plot: model comparison
    fig, ax = plt.subplots(figsize=(7, 3))
    names = [r.name.replace(" (same day last week)", "").replace(" (no festival features)", "\n(no festival)") for r in results]
    vals = [r.test["WAPE"] for r in results]
    fv = [r.festival_wape for r in results]
    x = np.arange(len(results))
    ax.bar(x - 0.2, vals, 0.4, color=ACCENT, label="All test days")
    ax.bar(x + 0.2, fv, 0.4, color=WARN, label="Festival days")
    ax.set_xticks(x, names, rotation=25, ha="right")
    ax.set_ylabel("WAPE (lower is better)")
    ax.legend(frameon=False)
    ax.set_title("Forecast error by model", loc="left", color=INK)
    fig.tight_layout()
    fig.savefig(REPORTS / "forecast_models.png")
    plt.close(fig)

    # plot: actual vs forecast for festive SKUs
    test = test.assign(pred_lgbm=lgbm.predictions, pred_naive=naive.predictions, pred_abl=ablation.predictions)
    fig, axes = plt.subplots(1, 3, figsize=(10, 2.8), sharex=True)
    for ax, sku in zip(axes, ["sweets-box-500", "oil-fortune-1", "milk-amul-500"]):
        s = test[test["sku"] == sku]
        ax.plot(s["date"], s["units"], color=INK, lw=1.2, label="Actual")
        ax.plot(s["date"], s["pred_lgbm"], color=ACCENT, lw=1.4, label="LightGBM + festivals")
        ax.plot(s["date"], s["pred_abl"], color=MUTED, lw=1, ls="--", label="No festival features")
        ax.set_title(items_frame().loc[sku, "name"], loc="left", fontsize=9)
        ax.tick_params(axis="x", rotation=40)
    axes[0].legend(frameon=False, fontsize=7)
    fig.tight_layout()
    fig.savefig(REPORTS / "forecast_examples.png")
    plt.close(fig)
    return results, test, lgbm


def run_replenishment(panel: pd.DataFrame, test: pd.DataFrame, lgbm, md: list, out: dict) -> None:
    items = items_frame()
    test = test.assign(pred=lgbm.predictions)
    train_end = test["date"].min()
    totals: dict[str, dict] = {}
    for sku, it in items.iterrows():
        econ = replenishment.ItemEcon(int(it["costPaise"]), int(it["pricePaise"]), int(it["leadTimeDays"]),
                                      int(it["packSize"]), int(it["shelfLifeDays"]))
        hist = panel[(panel["sku"] == sku) & (panel["date"] < train_end)]["units"].to_numpy()
        s = test[test["sku"] == sku].sort_values("date")
        demand, fc = s["units"].to_numpy(), s["pred"].to_numpy()
        sigma = float(np.std(hist[-56:] - np.convolve(hist, np.ones(7) / 7, "same")[-56:]))
        start = int(np.mean(hist[-28:]) * 4)
        q = replenishment.QLearningPolicy(econ, float(np.mean(hist[-56:])), seed=0)
        q.train(hist[-240:], episodes=40)
        for res in (
            replenishment.simulate(demand, econ, replenishment.heuristic_policy(hist, econ), start, "Shopkeeper heuristic"),
            replenishment.simulate(demand, econ, replenishment.ss_policy(fc, sigma, econ), start, "Forecast-driven (s,S)"),
            replenishment.simulate(demand, econ, q.decide, start, "Q-learning"),
        ):
            agg = totals.setdefault(res.policy, {"cost": 0.0, "sold_w": 0.0, "dem": 0, "stockout_days": 0,
                                                 "waste": 0, "orders": 0, "stock_value": 0.0})
            d = int(demand.sum())
            agg["cost"] += res.total_cost_paise
            agg["sold_w"] += res.fill_rate * d
            agg["dem"] += d
            agg["stockout_days"] += res.stockout_days
            agg["waste"] += res.waste_units
            agg["orders"] += res.orders
            agg["stock_value"] += res.avg_stock_units * econ.cost_paise
    md += ["## 2. Inventory replenishment (#40)", "",
           f"All {len(items)} SKUs simulated over the {forecasting.TEST_DAYS}-day test period with supplier lead "
           "times, pack sizes, shelf life (FIFO expiry), ₹20 order cost, holding cost and lost-margin stockout penalty.", "",
           "| Policy | Total cost (₹) | Fill rate | Stockout SKU-days | Wasted units | Orders | Avg stock value (₹) |",
           "|---|---|---|---|---|---|---|"]
    rows = []
    for name, a in totals.items():
        fill = a["sold_w"] / a["dem"]
        md.append(f"| {name} | {a['cost'] / 100:,.0f} | {fill:.1%} | {a['stockout_days']} | {a['waste']} | "
                  f"{a['orders']} | {a['stock_value'] / 100:,.0f} |")
        rows.append({"policy": name, "total_cost_rs": a["cost"] / 100, "fill_rate": fill,
                     "stockout_days": a["stockout_days"], "waste_units": a["waste"], "orders": a["orders"]})
    h, s = totals["Shopkeeper heuristic"]["cost"], totals["Forecast-driven (s,S)"]["cost"]
    q = totals["Q-learning"]
    best_policy = min(totals, key=lambda k: totals[k]["cost"])
    q_capital = q["stock_value"] / max(totals["Forecast-driven (s,S)"]["stock_value"], 1)
    md += ["", f"The forecast-driven (s,S) policy cuts total inventory cost by **{(1 - s / h) * 100:.0f}%** vs the "
           "experienced-shopkeeper heuristic (daily refills for perishables, weekly for the rest) and raises the fill rate. Perishables use a newsvendor service level "
           "(critical ratio Cu/(Cu+Co)) instead of a flat 95%, because over-ordering milk is expensive.",
           f"Lowest-cost policy: **{best_policy}**. Tabular Q-learning (#40's suggested algorithm) "
           f"{'beats' if q['cost'] < s else 'does not beat'} (s,S) on cost, but it ties up "
           f"{q_capital:.1f}× the working capital and places {q['orders']} orders (vs "
           f"{totals['Forecast-driven (s,S)']['orders']}). With only ~240 days of history per SKU, model-based "
           "control is the safer production choice; RL is kept as a research comparison.", ""]
    out["replenishment"] = rows
    fig, ax = plt.subplots(figsize=(6, 2.6))
    ax.barh(list(totals), [a["cost"] / 100 for a in totals.values()], color=[MUTED, ACCENT, WARN])
    ax.set_xlabel("Total cost over test period (₹, lower is better)")
    ax.set_title("Replenishment policy cost", loc="left")
    fig.tight_layout()
    fig.savefig(REPORTS / "replenishment_cost.png")
    plt.close(fig)


def run_basket(tx: pd.DataFrame, md: list, out: dict) -> None:
    res = basket.compare(tx, min_support=0.01)
    names = items_frame()["name"]
    md += ["## 3. Frequently bought together (#35)", "",
           f"{res['transactions']:,} baskets, {res['items']} products, min support {res['min_support']}.", "",
           "| Algorithm | Frequent itemsets | Runtime (s) |", "|---|---|---|",
           f"| Apriori | {res['itemsets']} | {res['apriori_seconds']:.2f} |",
           f"| FP-Growth | {res['itemsets']} | {res['fpgrowth_seconds']:.2f} |", "",
           f"Identical itemsets: **{res['identical_itemsets']}** · FP-Growth speed-up: **{res['speedup']:.1f}×** · "
           f"Planted-pair precision of top-20 rules: **{res['planted_precision_top20']:.0%}**", "",
           "| If customer buys | → also buys | Support | Confidence | Lift |", "|---|---|---|---|---|"]
    for r in basket.rules_to_records(res["rules"], top=10):
        md.append(f"| {' + '.join(names[s] for s in r['if'])} | {' + '.join(names[s] for s in r['then'])} | "
                  f"{r['support']:.3f} | {r['confidence']:.2f} | {r['lift']:.2f} |")
    md += ["", "Runtime vs minimum support (where the algorithms differ):", "",
           "| min support | itemsets | Apriori (s) | FP-Growth (s) |", "|---|---|---|---|"]
    oh = basket.one_hot(tx)
    sweep = []
    for ms in (0.02, 0.01, 0.005, 0.002):
        a, ta = basket.mine(oh, "apriori", ms)
        _, tf = basket.mine(oh, "fpgrowth", ms)
        sweep.append({"min_support": ms, "itemsets": len(a), "apriori_s": ta, "fpgrowth_s": tf})
        md.append(f"| {ms} | {len(a)} | {ta:.2f} | {tf:.2f} |")
    faster = sum(r["fpgrowth_s"] < r["apriori_s"] for r in sweep)
    md += ["", f"FP-Growth was faster in {faster}/{len(sweep)} settings. With only 40 products Apriori's candidate "
           "sets stay small; FP-Growth's advantage grows as support falls and the catalogue grows (a real shop "
           "stocks 500 to 2,000 SKUs), which is why the production batch job uses FP-Growth.", ""]
    out["basket"] = {k: v for k, v in res.items() if k != "rules"}
    out["basket"]["support_sweep"] = sweep
    out["basket"]["top_rules"] = basket.rules_to_records(res["rules"], top=30)


def run_segmentation(tx: pd.DataFrame, md: list, out: dict) -> None:
    cal = festival_calendar(tx["date"].min().date(), tx["date"].max().date())
    fest_days = set(cal.loc[cal["fest_intensity"] > 0.3, "date"])
    df = segmentation.rfm(tx, fest_days)
    res = segmentation.compare(df)
    names = segmentation.name_segments(df, res["labels"])
    md += ["## 4. Customer segmentation (#27)", "",
           f"{len(df)} known customers; features: {', '.join(segmentation.FEATURES)} (log + standardised). "
           f"K-Means k chosen by silhouette sweep (best k = {res['best_k']}); GMM by BIC (k = {res['gmm_bic_k']}); "
           f"DBSCAN eps from 5-NN distance (eps = {res['dbscan_eps']:.2f}).", "",
           "| Algorithm | k | Silhouette ↑ | Davies–Bouldin ↓ | Calinski–Harabasz ↑ | ARI vs planted personas ↑ |",
           "|---|---|---|---|---|---|"]
    for n, r in res["results"].items():
        md.append(f"| {n} | {r['k']} | {fmt(r['silhouette'])} | {fmt(r['davies_bouldin'])} | "
                  f"{fmt(r['calinski_harabasz'], 0)} | {fmt(r.get('adjusted_rand_vs_personas'))} |")
    prof = df.assign(segment=[names[label] for label in res["labels"]]).groupby("segment")[segmentation.FEATURES].median()
    prof["customers"] = pd.Series([names[label] for label in res["labels"]]).value_counts()
    md += ["", "Segment profiles (medians), used for targeted offers in the app:", "",
           prof.round(1).to_markdown() if hasattr(prof, "to_markdown") else prof.round(1).to_string(), ""]
    out["segmentation"] = {"best_k": res["best_k"], "results": res["results"], "sweep": res["kmeans_sweep"]}
    fig, ax = plt.subplots(figsize=(4.5, 2.6))
    ks = list(res["kmeans_sweep"])
    ax.plot(ks, [res["kmeans_sweep"][k]["silhouette"] for k in ks], marker="o", color=ACCENT)
    ax.set_xlabel("k")
    ax.set_ylabel("Silhouette")
    ax.set_title("Choosing k for K-Means", loc="left")
    fig.tight_layout()
    fig.savefig(REPORTS / "segmentation_silhouette.png")
    plt.close(fig)


def run_udhaar(cfg: synth.SynthConfig, md: list, out: dict) -> None:
    df = synth.udhaar_accounts(cfg)
    res = udhaar_risk.compare(df)
    payload = udhaar_risk.export_logistic(res["fitted"]["LogisticRegression"], SPEC_DIR / "udhaar_model.json")
    md += ["## 5. Udhaar (credit) risk", "",
           f"{res['n']} credit accounts, default rate {res['positive_rate']:.1%} (imbalanced, so accuracy is not used).", "",
           "| Model | CV PR-AUC | Test PR-AUC | ROC-AUC | Precision | Recall | F1 | Recall @ top-20% |",
           "|---|---|---|---|---|---|---|---|"]
    for n, r in res["results"].items():
        md.append(f"| {n} | {fmt(r['cv_pr_auc'])} | {fmt(r['pr_auc'])} | {fmt(r['roc_auc'])} | {fmt(r['precision'])} | "
                  f"{fmt(r['recall'])} | {fmt(r['f1'])} | {fmt(r['recall_at_top20pct'])} |")
    lr = res["results"]["LogisticRegression"]
    md += ["", f"Logistic regression confusion matrix (test, threshold 0.5): `{lr['confusion_matrix']}`.",
           "It is deployed **on the phone** as plain coefficients (`spec/udhaar_model.json`), so scoring works "
           "offline with zero inference cost, and its weights are explainable to the shopkeeper:", "",
           "| Feature | Weight (standardised) |", "|---|---|"]
    for f, c in sorted(zip(payload["features"], payload["coef"]), key=lambda t: -abs(t[1])):
        md.append(f"| {f} | {c:+.2f} |")
    md += ["", "**Ethics:** the model uses payment behaviour only, with no demographic or protected attributes. It is "
           "decision support (it suggests a reminder or a lower credit limit) and never blocks a sale.", ""]
    out["udhaar"] = {k: v for k, v in res.items() if k != "fitted"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    args = ap.parse_args()
    REPORTS.mkdir(exist_ok=True)
    cfg = (synth.SynthConfig(start=date(2025, 6, 1), n_customers=150, tx_days=90) if args.quick
           else synth.SynthConfig())
    t0 = time.perf_counter()
    panel, tx = synth.daily_demand(cfg), synth.transactions(cfg)
    md = ["# Smart Retail OS: ML evaluation report", "",
          f"Generated by `ml/run_all.py` on synthetic kirana data (seed {cfg.seed}, {cfg.start} → {cfg.end}). "
          f"Python {platform.python_version()}. Re-run to reproduce every number.", "",
          "> **Data note:** real shop data is private, so data is generated with *planted* Indian retail structure "
          "(festivals, paydays, weekday rhythm, seasonal items, basket templates, customer personas). Planting the "
          "structure lets us also measure how well each algorithm *recovers* it. Limitation: real demand has "
          "shocks (price hikes, local events) that the generator does not model.", ""]
    out: dict = {"config": {"start": str(cfg.start), "end": str(cfg.end), "seed": cfg.seed}}
    results, test, lgbm = run_forecasting(panel, cv=not args.quick, md=md, out=out)
    run_replenishment(panel, test, lgbm, md, out)
    run_basket(tx, md, out)
    run_segmentation(tx, md, out)
    run_udhaar(cfg, md, out)
    md += ["## Figures", "", "![](forecast_models.png)", "", "![](forecast_examples.png)", "",
           "![](replenishment_cost.png)", "", "![](segmentation_silhouette.png)", "",
           f"_Total runtime {time.perf_counter() - t0:.0f}s._", ""]
    (REPORTS / "REPORT.md").write_text("\n".join(md), encoding="utf-8")
    (REPORTS / "metrics.json").write_text(json.dumps(out, indent=2, default=str), encoding="utf-8")
    print("\n".join(md))


if __name__ == "__main__":
    main()
