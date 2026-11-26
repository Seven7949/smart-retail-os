"""#35 Product association mining — Apriori vs FP-Growth (mlxtend).

Both algorithms must find exactly the same frequent itemsets (correctness
check); FP-Growth should be faster because it avoids candidate generation.
Because the synthetic data has *planted* basket templates, we also measure
**planted-pair precision**: what share of the top rules connect items that
truly belong together.
"""
from __future__ import annotations

import time
from itertools import combinations

import pandas as pd
from mlxtend.frequent_patterns import apriori, association_rules, fpgrowth
from mlxtend.preprocessing import TransactionEncoder

from .catalog import load_catalog


def one_hot(tx: pd.DataFrame) -> pd.DataFrame:
    baskets = tx.groupby("tx_id")["sku"].apply(lambda s: sorted(set(s))).tolist()
    te = TransactionEncoder()
    arr = te.fit(baskets).transform(baskets)
    return pd.DataFrame(arr, columns=te.columns_)


def mine(onehot: pd.DataFrame, algorithm: str, min_support: float) -> tuple[pd.DataFrame, float]:
    fn = {"apriori": apriori, "fpgrowth": fpgrowth}[algorithm]
    t0 = time.perf_counter()
    itemsets = fn(onehot, min_support=min_support, use_colnames=True)
    return itemsets, time.perf_counter() - t0


def rules_from(itemsets: pd.DataFrame, n_tx: int, min_lift: float = 1.2, min_conf: float = 0.2) -> pd.DataFrame:
    if itemsets.empty:
        return pd.DataFrame(columns=["antecedents", "consequents", "support", "confidence", "lift"])
    rules = association_rules(itemsets, metric="lift", min_threshold=min_lift, num_itemsets=n_tx)
    rules = rules[rules["confidence"] >= min_conf]
    return rules.sort_values(["lift", "confidence"], ascending=False).reset_index(drop=True)


def planted_pairs() -> set[frozenset]:
    pairs: set[frozenset] = set()
    for t in load_catalog()["baskets"]:
        for a, b in combinations(t["skus"], 2):
            pairs.add(frozenset((a, b)))
    return pairs


def planted_precision(rules: pd.DataFrame, top: int = 20) -> float:
    truth = planted_pairs()
    top_rules = rules.head(top)
    if top_rules.empty:
        return float("nan")
    hits = 0
    for _, r in top_rules.iterrows():
        items = set(r["antecedents"]) | set(r["consequents"])
        hits += all(frozenset(p) in truth for p in combinations(sorted(items), 2))
    return hits / len(top_rules)


def compare(tx: pd.DataFrame, min_support: float = 0.01) -> dict:
    oh = one_hot(tx)
    ap, t_ap = mine(oh, "apriori", min_support)
    fp, t_fp = mine(oh, "fpgrowth", min_support)
    same = set(map(frozenset, ap["itemsets"])) == set(map(frozenset, fp["itemsets"]))
    rules = rules_from(fp, len(oh))
    return {
        "transactions": len(oh), "items": oh.shape[1], "min_support": min_support,
        "itemsets": len(fp), "identical_itemsets": same,
        "apriori_seconds": t_ap, "fpgrowth_seconds": t_fp,
        "speedup": t_ap / t_fp if t_fp else float("nan"),
        "rules": rules, "planted_precision_top20": planted_precision(rules),
    }


def rules_to_records(rules: pd.DataFrame, top: int = 30) -> list[dict]:
    """JSON-friendly rules for the app / DynamoDB."""
    out = []
    for _, r in rules.head(top).iterrows():
        out.append({
            "if": sorted(r["antecedents"]), "then": sorted(r["consequents"]),
            "support": round(float(r["support"]), 4), "confidence": round(float(r["confidence"]), 3),
            "lift": round(float(r["lift"]), 2),
        })
    return out
