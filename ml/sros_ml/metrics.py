"""Forecast error metrics (no external deps, easy to unit test)."""
from __future__ import annotations

import numpy as np


def mae(y, p) -> float:
    return float(np.mean(np.abs(np.asarray(y, float) - np.asarray(p, float))))


def rmse(y, p) -> float:
    return float(np.sqrt(np.mean((np.asarray(y, float) - np.asarray(p, float)) ** 2)))


def wape(y, p) -> float:
    """Weighted absolute percentage error = Σ|y-p| / Σ|y|. Robust to zeros,
    which are common for slow movers (MAPE would explode)."""
    y = np.asarray(y, float)
    denom = np.abs(y).sum()
    return float(np.abs(y - np.asarray(p, float)).sum() / denom) if denom else float("nan")


def mase(y, p, naive_mae: float) -> float:
    """Mean absolute scaled error vs the in-sample seasonal-naive MAE.
    < 1 means better than "same day last week"."""
    return mae(y, p) / naive_mae if naive_mae else float("nan")


def bias(y, p) -> float:
    """Σ(p-y)/Σy — positive = over-forecasting (excess stock)."""
    y = np.asarray(y, float)
    return float((np.asarray(p, float) - y).sum() / y.sum()) if y.sum() else float("nan")
