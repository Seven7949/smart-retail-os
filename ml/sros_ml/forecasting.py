"""#6 Retail sales forecasting — festival-aware global model vs baselines.

Design choices (documented for the viva):

* **Global model** across all SKUs (M5-competition style): one model learns
  shared weekday / payday / festival effects; per-item scale comes from lags.
* **Direct 7-day horizon**: every lag/rolling feature is shifted by >= 7 days,
  so a single model forecasts a full week ahead with no recursion and **no
  leakage** (enforced by ``test_no_leakage``).
* **Calendar features are known in advance** (festival dates, paydays,
  planned promotions) so they are legitimate future inputs.
* **Ablation**: the same LightGBM without festival features quantifies the
  value of the Indian-festival engineering — the project's novelty claim.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from . import metrics as M
from .catalog import items_frame

HORIZON = 7
TEST_DAYS = 56

FESTIVAL_FEATURES = ["fest_intensity", "fest_in_window", "days_to_next_fest", "fest_x_lift"]
BASE_FEATURES = [
    "lag_7", "lag_14", "lag_21", "lag_28", "rmean_7", "rmean_28", "rstd_28", "ewm_14",
    "dow", "dom", "month", "payday", "month_end", "promo", "price_ratio",
    "cat_code", "season_code", "festival_lift", "same_dow_mean_4",
]
ALL_FEATURES = BASE_FEATURES + FESTIVAL_FEATURES


def make_features(panel: pd.DataFrame) -> pd.DataFrame:
    """Add leak-free features. ``panel`` needs date, sku, units, price_paise,
    promo, fest_intensity, fest_in_window, days_to_next_fest."""
    items = items_frame()
    df = panel.sort_values(["sku", "date"]).reset_index(drop=True).copy()
    g = df.groupby("sku", sort=False)["units"]
    shifted = g.shift(HORIZON)
    for lag in (7, 14, 21, 28):
        df[f"lag_{lag}"] = g.shift(lag)
    sg = shifted.groupby(df["sku"], sort=False)
    df["rmean_7"] = sg.transform(lambda s: s.rolling(7, min_periods=3).mean())
    df["rmean_28"] = sg.transform(lambda s: s.rolling(28, min_periods=7).mean())
    df["rstd_28"] = sg.transform(lambda s: s.rolling(28, min_periods=7).std())
    df["ewm_14"] = sg.transform(lambda s: s.ewm(span=14, min_periods=7).mean())
    df["same_dow_mean_4"] = df[["lag_7", "lag_14", "lag_21", "lag_28"]].mean(axis=1)
    df["dow"] = df["date"].dt.dayofweek
    df["dom"] = df["date"].dt.day
    df["month"] = df["date"].dt.month
    df["payday"] = (df["dom"] <= 5).astype(int)
    df["month_end"] = (df["dom"] >= 26).astype(int)
    base_price = df["sku"].map(items["pricePaise"])
    df["price_ratio"] = df["price_paise"] / base_price
    df["cat_code"] = df["sku"].map(items["category"]).astype("category").cat.codes
    df["season_code"] = df["sku"].map(items["season"]).map({"none": 0, "summer": 1, "winter": 2, "monsoon": 3})
    df["festival_lift"] = df["sku"].map(items["festivalLift"])
    df["fest_x_lift"] = df["fest_intensity"] * (df["festival_lift"] - 1)
    return df


@dataclass
class ModelResult:
    name: str
    test: dict
    festival_wape: float
    cv_mae: float | None
    fit_seconds: float
    predictions: np.ndarray = field(repr=False)


def _models(seed: int) -> dict:
    import lightgbm as lgb

    lgb_params = dict(
        objective="poisson", n_estimators=500, learning_rate=0.04, num_leaves=31,
        min_child_samples=20, subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
        random_state=seed, verbose=-1,
    )
    return {
        "Ridge": (make_pipeline(StandardScaler(), Ridge(alpha=1.0)), ALL_FEATURES),
        "RandomForest": (
            RandomForestRegressor(n_estimators=200, max_depth=16, min_samples_leaf=3, n_jobs=-1, random_state=seed),
            ALL_FEATURES,
        ),
        "HistGradientBoosting": (
            HistGradientBoostingRegressor(loss="poisson", max_iter=400, learning_rate=0.05, random_state=seed),
            ALL_FEATURES,
        ),
        "LightGBM": (lgb.LGBMRegressor(**lgb_params), ALL_FEATURES),
        "LightGBM (no festival features)": (lgb.LGBMRegressor(**lgb_params), BASE_FEATURES),
    }


def split(df: pd.DataFrame, test_days: int = TEST_DAYS) -> tuple[pd.DataFrame, pd.DataFrame]:
    df = df.dropna(subset=["lag_28", "rmean_28", "rstd_28"])
    cutoff = df["date"].max() - pd.Timedelta(days=test_days - 1)
    return df[df["date"] < cutoff].copy(), df[df["date"] >= cutoff].copy()


def _cv_mae(model, X: pd.DataFrame, y: pd.Series, dates: pd.Series, n_splits: int = 3) -> float:
    uniq = np.sort(dates.unique())
    tss = TimeSeriesSplit(n_splits=n_splits, gap=HORIZON, test_size=28)
    scores = []
    for tr_idx, va_idx in tss.split(uniq):
        tr = dates.isin(uniq[tr_idx]).to_numpy()
        va = dates.isin(uniq[va_idx]).to_numpy()
        model.fit(X[tr], y[tr])
        scores.append(M.mae(y[va], np.clip(model.predict(X[va]), 0, None)))
    return float(np.mean(scores))


def evaluate(panel: pd.DataFrame, seed: int = 42, cv: bool = True) -> tuple[list[ModelResult], pd.DataFrame]:
    df = make_features(panel)
    train, test = split(df)
    y_test = test["units"].to_numpy()
    fest_mask = test["fest_in_window"].to_numpy() == 1
    naive_mae_in = M.mae(train["units"], train["lag_7"])

    def pack(name, pred, cv_mae, secs):
        pred = np.clip(np.asarray(pred, float), 0, None)
        return ModelResult(
            name=name,
            test={
                "MAE": M.mae(y_test, pred), "RMSE": M.rmse(y_test, pred), "WAPE": M.wape(y_test, pred),
                "MASE": M.mase(y_test, pred, naive_mae_in), "Bias": M.bias(y_test, pred),
            },
            festival_wape=M.wape(y_test[fest_mask], pred[fest_mask]) if fest_mask.any() else float("nan"),
            cv_mae=cv_mae, fit_seconds=secs, predictions=pred,
        )

    results = [
        pack("Seasonal naive (same day last week)", test["lag_7"], None, 0.0),
        pack("Moving average (28 days)", test["rmean_28"], None, 0.0),
    ]
    for name, (model, feats) in _models(seed).items():
        t0 = time.perf_counter()
        cv_mae = _cv_mae(model, train[feats], train["units"], train["date"]) if cv else None
        model.fit(train[feats], train["units"])
        secs = time.perf_counter() - t0
        results.append(pack(name, model.predict(test[feats]), cv_mae, secs))
    return results, test


def feature_importance(panel: pd.DataFrame, seed: int = 42, top: int = 12) -> pd.Series:
    import lightgbm as lgb

    df = make_features(panel)
    train, _ = split(df)
    model = lgb.LGBMRegressor(objective="poisson", n_estimators=300, random_state=seed, verbose=-1,
                              importance_type="gain")
    model.fit(train[ALL_FEATURES], train["units"])
    imp = pd.Series(model.feature_importances_, index=ALL_FEATURES)
    return (imp / imp.sum()).sort_values(ascending=False).head(top)


def fit_production_model(panel: pd.DataFrame, seed: int = 42):
    """Train the selected model on all available history (used by SageMaker
    training and the nightly ml-batch Lambda)."""
    import lightgbm as lgb

    df = make_features(panel).dropna(subset=["lag_28", "rmean_28", "rstd_28"])
    model = lgb.LGBMRegressor(objective="poisson", n_estimators=500, learning_rate=0.04,
                              random_state=seed, verbose=-1)
    model.fit(df[ALL_FEATURES], df["units"])
    return model
