import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sagemaker"))
import train  # noqa: E402


def test_train_entry_point_writes_model_and_metrics(tmp_path, monkeypatch):
    monkeypatch.delenv("SM_CHANNEL_TRAIN", raising=False)
    res = train.main(["--model-dir", str(tmp_path / "m"), "--output-dir", str(tmp_path / "o")])
    assert (tmp_path / "m" / "model.joblib").exists()
    saved = json.loads((tmp_path / "o" / "metrics.json").read_text())
    assert saved["test_wape"] < saved["baseline_wape"]
    assert res["source"] == "synthetic"


def test_train_reads_csv_channel(tmp_path):
    from datetime import date
    from sros_ml import synth

    panel = synth.daily_demand(synth.SynthConfig(start=date(2025, 3, 1), end=date(2025, 9, 30)))
    ch = tmp_path / "train"
    ch.mkdir()
    panel[["date", "sku", "units", "price_paise", "promo"]].to_csv(ch / "a.csv", index=False)
    res = train.main(["--train", str(ch), "--model-dir", str(tmp_path / "m"), "--output-dir", str(tmp_path / "o")])
    assert res["source"] == "channel:1 files"
