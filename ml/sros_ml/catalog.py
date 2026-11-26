"""Shared catalog + Indian festival calendar (spec/catalog.json)."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

def _spec_dir() -> Path:
    """spec/ lives at the repo root; containers copy it next to the package."""
    if os.environ.get("SROS_SPEC_DIR"):
        return Path(os.environ["SROS_SPEC_DIR"])
    here = Path(__file__).resolve()
    for candidate in (here.parents[2] / "spec", here.parents[1] / "spec"):
        if (candidate / "catalog.json").exists():
            return candidate
    return here.parents[2] / "spec"


SPEC_DIR = _spec_dir()


@lru_cache(maxsize=1)
def load_catalog(path: str | None = None) -> dict:
    p = Path(path) if path else SPEC_DIR / "catalog.json"
    return json.loads(p.read_text(encoding="utf-8"))


def items_frame() -> pd.DataFrame:
    return pd.DataFrame(load_catalog()["items"]).set_index("sku", drop=False)


@dataclass(frozen=True)
class FestivalDay:
    name: str
    intensity: float
    days_to_peak: int  # 0 on the festival day, positive before it, negative after


def festival_calendar(start: date, end: date) -> pd.DataFrame:
    """One row per day with festival features that are *known in advance*
    (calendar facts), so they are safe to use for future forecasting.

    Columns: fest_intensity (0..1, peaks on the day, ramps up through the
    window), fest_in_window (0/1), days_to_next_fest (capped at 60).
    """
    days = pd.date_range(start, end, freq="D")
    intensity = np.zeros(len(days))
    in_window = np.zeros(len(days), dtype=int)
    peaks: list[date] = []
    for fest in load_catalog()["festivals"]:
        for ds in fest["dates"]:
            peak = date.fromisoformat(ds)
            peaks.append(peak)
            before, after = fest["windowBefore"], fest["windowAfter"]
            for offset in range(-before, after + 1):
                d = peak + timedelta(days=offset)
                idx = (pd.Timestamp(d) - days[0]).days
                if 0 <= idx < len(days):
                    # ramp: 0.4 at window start -> 1.0 on the day, 0.6 after
                    ramp = 1.0 if offset == 0 else (0.4 + 0.6 * (before + offset) / max(before, 1) if offset < 0 else 0.6)
                    value = fest["intensity"] * ramp
                    intensity[idx] = max(intensity[idx], value)
                    in_window[idx] = 1
    peaks_ts = np.array(sorted(pd.Timestamp(p) for p in peaks), dtype="datetime64[ns]")
    next_idx = np.searchsorted(peaks_ts, days.values, side="left")
    days_to_next = np.full(len(days), 60)
    valid = next_idx < len(peaks_ts)
    days_to_next[valid] = np.minimum(
        60, (peaks_ts[next_idx[valid]] - days.values[valid]).astype("timedelta64[D]").astype(int)
    )
    return pd.DataFrame(
        {"date": days, "fest_intensity": intensity, "fest_in_window": in_window, "days_to_next_fest": days_to_next}
    )


SEASON_MONTHS = {
    "summer": {3: 1.15, 4: 1.35, 5: 1.5, 6: 1.35, 7: 1.0},
    "winter": {11: 1.2, 12: 1.35, 1: 1.35, 2: 1.15},
    "monsoon": {7: 1.3, 8: 1.35, 9: 1.2},
}


def season_factor(season: str, month: int) -> float:
    if season == "none":
        return 1.0
    table = SEASON_MONTHS[season]
    if month in table:
        return table[month]
    # off-season dip for strongly seasonal items
    return 0.85 if season == "summer" else 0.95
