"""Udhaar (store credit) default-risk scoring.

Imbalanced binary classification, so accuracy is NOT reported as the main
metric (course guidance §10): PR-AUC, ROC-AUC, recall, precision, F1 and the
confusion matrix are. The logistic model is exported as plain coefficients so
the phone can score customers offline with no ML runtime.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (average_precision_score, confusion_matrix, f1_score, precision_score,
                             recall_score, roc_auc_score)
from sklearn.model_selection import StratifiedKFold, cross_val_score, train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

FEATURES = ["tenure_days", "utilisation", "days_since_payment", "avg_days_to_repay", "late_payments",
            "pay_ratio_90d", "reminders_ignored"]


def models(seed: int) -> dict:
    return {
        "LogisticRegression": make_pipeline(StandardScaler(), LogisticRegression(class_weight="balanced", max_iter=1000)),
        "RandomForest": RandomForestClassifier(n_estimators=300, min_samples_leaf=5, class_weight="balanced",
                                               random_state=seed, n_jobs=-1),
        "GradientBoosting": GradientBoostingClassifier(random_state=seed),
    }


def compare(df: pd.DataFrame, seed: int = 42, threshold: float = 0.5) -> dict:
    X, y = df[FEATURES], df["defaulted"]
    X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.25, stratify=y, random_state=seed)
    cv = StratifiedKFold(5, shuffle=True, random_state=seed)
    out = {"positive_rate": float(y.mean()), "n": len(df), "results": {}}
    fitted = {}
    for name, m in models(seed).items():
        cv_pr = cross_val_score(m, X_tr, y_tr, cv=cv, scoring="average_precision").mean()
        m.fit(X_tr, y_tr)
        p = m.predict_proba(X_te)[:, 1]
        # GradientBoosting is unweighted -> pick the threshold that matches the base rate
        thr = threshold if name != "GradientBoosting" else float(np.quantile(p, 1 - y_tr.mean()))
        pred = (p >= thr).astype(int)
        top20 = p >= np.quantile(p, 0.8)
        out["results"][name] = {
            "cv_pr_auc": float(cv_pr), "pr_auc": float(average_precision_score(y_te, p)),
            "roc_auc": float(roc_auc_score(y_te, p)), "precision": float(precision_score(y_te, pred, zero_division=0)),
            "recall": float(recall_score(y_te, pred)), "f1": float(f1_score(y_te, pred)),
            "recall_at_top20pct": float(y_te[top20].sum() / max(y_te.sum(), 1)),
            "confusion_matrix": confusion_matrix(y_te, pred).tolist(), "threshold": thr,
        }
        fitted[name] = m
    out["fitted"] = fitted
    return out


def export_logistic(model, path: Path) -> dict:
    """Write {features, mean, scale, coef, intercept} for on-device scoring:
    p = sigmoid(intercept + Σ coef_i * (x_i - mean_i) / scale_i)."""
    scaler, lr = model.steps[0][1], model.steps[1][1]
    payload = {
        "version": 1, "features": FEATURES,
        "mean": [round(float(v), 6) for v in scaler.mean_],
        "scale": [round(float(v), 6) for v in scaler.scale_],
        "coef": [round(float(v), 6) for v in lr.coef_[0]],
        "intercept": round(float(lr.intercept_[0]), 6),
        "bands": {"low": 0.35, "high": 0.65},
        "note": "Decision support only. Trained on synthetic payment behaviour; no demographic features.",
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return payload


def score(payload: dict, row: dict) -> float:
    z = payload["intercept"]
    for f, m, s, c in zip(payload["features"], payload["mean"], payload["scale"], payload["coef"]):
        z += c * (float(row[f]) - m) / s
    return float(1 / (1 + np.exp(-z)))
