"""#27 Customer segmentation — RFM+ features, four clustering algorithms.

Internal metrics (silhouette, Davies–Bouldin, Calinski–Harabasz) pick the
best configuration; because personas are planted we also report the
Adjusted Rand Index against ground truth (external validation).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.cluster import DBSCAN, AgglomerativeClustering, KMeans
from sklearn.metrics import adjusted_rand_score, calinski_harabasz_score, davies_bouldin_score, silhouette_score
from sklearn.mixture import GaussianMixture
from sklearn.neighbors import NearestNeighbors
from sklearn.preprocessing import StandardScaler

FEATURES = ["recency_days", "frequency", "monetary_rs", "avg_basket_rs", "distinct_skus", "festive_share"]


def rfm(tx: pd.DataFrame, fest_dates: set | None = None) -> pd.DataFrame:
    known = tx[tx["customer_id"].notna()].copy()
    known["value"] = known["qty"] * known["price_paise"] / 100
    end = known["date"].max()
    per_tx = known.groupby(["customer_id", "tx_id"]).agg(date=("date", "first"), value=("value", "sum"))
    per_tx = per_tx.reset_index()
    if fest_dates:
        per_tx["festive"] = per_tx["date"].isin(fest_dates).astype(int)
    else:
        per_tx["festive"] = 0
    g = per_tx.groupby("customer_id")
    out = pd.DataFrame({
        "recency_days": (end - g["date"].max()).dt.days,
        "frequency": g["tx_id"].nunique(),
        "monetary_rs": g["value"].sum(),
        "avg_basket_rs": g["value"].mean(),
        "festive_share": g["festive"].mean(),
    })
    out["distinct_skus"] = known.groupby("customer_id")["sku"].nunique()
    persona = known.groupby("customer_id")["persona"].first()
    return out.join(persona)


def _matrix(df: pd.DataFrame) -> np.ndarray:
    X = df[FEATURES].astype(float).copy()
    for c in ("frequency", "monetary_rs", "avg_basket_rs", "recency_days", "distinct_skus"):
        X[c] = np.log1p(X[c])
    return StandardScaler().fit_transform(X)


def _scores(X, labels) -> dict:
    mask = labels != -1
    k = len(set(labels[mask]))
    if k < 2:
        return {"silhouette": float("nan"), "davies_bouldin": float("nan"), "calinski_harabasz": float("nan"), "k": k}
    return {
        "silhouette": float(silhouette_score(X[mask], labels[mask])),
        "davies_bouldin": float(davies_bouldin_score(X[mask], labels[mask])),
        "calinski_harabasz": float(calinski_harabasz_score(X[mask], labels[mask])),
        "k": k, "noise_share": float((~mask).mean()),
    }


def compare(df: pd.DataFrame, seed: int = 42) -> dict:
    X = _matrix(df)
    truth = df["persona"].to_numpy() if "persona" in df else None
    sweep = {}
    for k in range(2, 9):
        km = KMeans(n_clusters=k, n_init=10, random_state=seed).fit(X)
        sweep[k] = {"silhouette": float(silhouette_score(X, km.labels_)), "inertia": float(km.inertia_)}
    best_k = max(sweep, key=lambda k: sweep[k]["silhouette"])
    # GMM: choose components by BIC
    bics = {k: GaussianMixture(k, random_state=seed, n_init=3).fit(X).bic(X) for k in range(2, 9)}
    gmm_k = min(bics, key=bics.get)
    # DBSCAN: eps from the knee of the 5-NN distance curve (90th percentile)
    dists = NearestNeighbors(n_neighbors=5).fit(X).kneighbors(X)[0][:, -1]
    eps = float(np.percentile(dists, 90))
    models = {
        "KMeans": KMeans(n_clusters=best_k, n_init=10, random_state=seed).fit_predict(X),
        "GaussianMixture": GaussianMixture(gmm_k, random_state=seed, n_init=3).fit(X).predict(X),
        "DBSCAN": DBSCAN(eps=eps, min_samples=5).fit_predict(X),
        "Agglomerative (Ward)": AgglomerativeClustering(n_clusters=best_k, linkage="ward").fit_predict(X),
    }
    results = {}
    for name, labels in models.items():
        s = _scores(X, labels)
        if truth is not None:
            s["adjusted_rand_vs_personas"] = float(adjusted_rand_score(truth, labels))
        results[name] = s
    return {"kmeans_sweep": sweep, "best_k": best_k, "gmm_bic_k": gmm_k, "dbscan_eps": eps,
            "results": results, "labels": models["KMeans"]}


def name_segments(df: pd.DataFrame, labels: np.ndarray) -> dict[int, str]:
    """Human-readable persona names from cluster centroids (relative ranks)."""
    prof = df[FEATURES].assign(label=labels).groupby("label").median()
    names: dict[int, str] = {}
    for lab, row in prof.iterrows():
        if row["recency_days"] > prof["recency_days"].quantile(0.75) and row["recency_days"] > 30:
            names[lab] = "At risk / lapsed"
        elif row["festive_share"] >= prof["festive_share"].max() * 0.9 and row["festive_share"] > 0.3:
            names[lab] = "Festive shoppers"
        elif row["avg_basket_rs"] >= prof["avg_basket_rs"].max() * 0.9:
            names[lab] = "Bulk monthly buyers"
        elif row["frequency"] >= prof["frequency"].max() * 0.9:
            names[lab] = "Daily regulars"
        else:
            names[lab] = "Occasional visitors"
    return names
