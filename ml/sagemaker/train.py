"""SageMaker training entry point (scikit-learn framework container).

Trains the selected global demand model (LightGBM, festival-aware) on the
`train` channel (CSV: date, sku, units, price_paise, promo) or, if no channel
is attached, on freshly generated synthetic data. Writes:

* $SM_MODEL_DIR/model.joblib     — fitted model + feature list
* $SM_OUTPUT_DATA_DIR/metrics.json — held-out evaluation
and prints `test_wape=<value>` for SageMaker metric definitions.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))


def main(argv=None) -> dict:
    import joblib
    import pandas as pd

    from sros_ml import forecasting, metrics, synth
    from sros_ml.catalog import festival_calendar

    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--model-dir", default=os.environ.get("SM_MODEL_DIR", "model"))
    ap.add_argument("--output-dir", default=os.environ.get("SM_OUTPUT_DATA_DIR", "output"))
    ap.add_argument("--train", default=os.environ.get("SM_CHANNEL_TRAIN"))
    args = ap.parse_args(argv)

    if args.train and Path(args.train).exists():
        files = sorted(Path(args.train).glob("*.csv"))
        panel = pd.concat([pd.read_csv(f, parse_dates=["date"]) for f in files], ignore_index=True)
        cal = festival_calendar(panel["date"].min().date(), panel["date"].max().date())
        panel = panel.merge(cal, on="date", how="left")
        source = f"channel:{len(files)} files"
    else:
        panel = synth.daily_demand(synth.SynthConfig(seed=args.seed))
        source = "synthetic"

    df = forecasting.make_features(panel)
    train, test = forecasting.split(df)
    import lightgbm as lgb

    model = lgb.LGBMRegressor(objective="poisson", n_estimators=500, learning_rate=0.04,
                              random_state=args.seed, verbose=-1)
    model.fit(train[forecasting.ALL_FEATURES], train["units"])
    pred = model.predict(test[forecasting.ALL_FEATURES]).clip(0)
    result = {
        "source": source, "rows": int(len(df)),
        "test_wape": metrics.wape(test["units"], pred), "test_mae": metrics.mae(test["units"], pred),
        "baseline_wape": metrics.wape(test["units"], test["lag_7"]),
    }
    final = forecasting.fit_production_model(panel, seed=args.seed)
    Path(args.model_dir).mkdir(parents=True, exist_ok=True)
    Path(args.output_dir).mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": final, "features": forecasting.ALL_FEATURES}, Path(args.model_dir) / "model.joblib")
    (Path(args.output_dir) / "metrics.json").write_text(json.dumps(result, indent=2))
    print(f"test_wape={result['test_wape']:.4f}")
    print(f"baseline_wape={result['baseline_wape']:.4f}")
    return result


if __name__ == "__main__":
    main()
