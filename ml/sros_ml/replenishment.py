"""#40 Dynamic inventory replenishment under uncertain demand.

Three policies are simulated on the same held-out demand:

1. **Shopkeeper heuristic** — what most kiranas do today: check the shelf once
   a week and refill to "about a week's worth" of last month's average sales.
2. **Forecast-driven (s, S)** — daily review; reorder point
   ``s = forecast over lead time + z·σ·√L``; order up to
   ``S = s + forecast over a 7-day cycle``; rounded up to the supplier's
   pack size.
3. **Tabular Q-learning** — state = (stock bucket, day of week); action =
   number of packs to order; reward = −(holding + spoilage + stockout +
   ordering cost). Trained on the training period.

The simulator is FIFO with shelf life, so perishables (milk, bread) waste
stock if over-ordered — over-ordering is not free.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import numpy as np
from scipy.stats import norm

ORDER_COST_PAISE = 2000  # ₹20 trip / call to distributor
HOLDING_RATE_PER_DAY = 0.0015  # capital + space, fraction of cost
STOCKOUT_GOODWILL = 1.0  # lost margin x (1 + goodwill)
Z_SERVICE = 1.65  # ~95% cycle service level


@dataclass(frozen=True)
class ItemEcon:
    cost_paise: int
    price_paise: int
    lead_time: int
    pack_size: int
    shelf_life: int

    @property
    def margin(self) -> int:
        return self.price_paise - self.cost_paise


@dataclass
class SimResult:
    policy: str
    total_cost_paise: float
    fill_rate: float
    stockout_days: int
    waste_units: int
    orders: int
    avg_stock_units: float


class _Shelf:
    """FIFO batches with expiry."""

    def __init__(self, units: int, shelf_life: int):
        self.batches: deque[list[int]] = deque([[units, shelf_life]]) if units else deque()

    @property
    def units(self) -> int:
        return sum(b[0] for b in self.batches)

    def add(self, units: int, shelf_life: int) -> None:
        if units > 0:
            self.batches.append([units, shelf_life])

    def sell(self, demand: int) -> int:
        sold = 0
        while demand > 0 and self.batches:
            take = min(demand, self.batches[0][0])
            self.batches[0][0] -= take
            sold += take
            demand -= take
            if self.batches[0][0] == 0:
                self.batches.popleft()
        return sold

    def age(self) -> int:
        wasted = 0
        for b in self.batches:
            b[1] -= 1
        while self.batches and self.batches[0][1] <= 0:
            wasted += self.batches.popleft()[0]
        return wasted


def round_to_pack(units: float, pack: int) -> int:
    return int(np.ceil(max(units, 0) / pack) * pack) if units > 0 else 0


def simulate(demand: np.ndarray, econ: ItemEcon, decide, start_stock: int, name: str) -> SimResult:
    """Run a policy. ``decide(t, stock_on_hand, pipeline_units) -> order units``."""
    shelf = _Shelf(start_stock, econ.shelf_life)
    pipeline: list[tuple[int, int]] = []  # (arrival_day, units)
    cost = 0.0
    sold_total = stockout_days = waste = orders = 0
    stock_trace = []
    for t, d in enumerate(demand):
        for arr in [p for p in pipeline if p[0] == t]:
            shelf.add(arr[1], econ.shelf_life)
        pipeline = [p for p in pipeline if p[0] > t]
        sold = shelf.sell(int(d))
        sold_total += sold
        lost = int(d) - sold
        if lost:
            stockout_days += 1
            cost += lost * econ.margin * (1 + STOCKOUT_GOODWILL)
        wasted = shelf.age()
        waste += wasted
        cost += wasted * econ.cost_paise
        cost += shelf.units * econ.cost_paise * HOLDING_RATE_PER_DAY
        stock_trace.append(shelf.units)
        q = decide(t, shelf.units, sum(p[1] for p in pipeline))
        if q > 0:
            orders += 1
            cost += ORDER_COST_PAISE
            pipeline.append((t + econ.lead_time, q))
    total_demand = int(demand.sum())
    return SimResult(
        policy=name, total_cost_paise=cost,
        fill_rate=sold_total / total_demand if total_demand else 1.0,
        stockout_days=stockout_days, waste_units=waste, orders=orders,
        avg_stock_units=float(np.mean(stock_trace)),
    )


def heuristic_policy(history: np.ndarray, econ: ItemEcon, review_every: int = 7):
    """A fair "experienced shopkeeper" baseline: perishables are refilled
    daily to ~1 day's worth (like the daily milk/bread delivery), everything
    else is checked weekly and refilled to ~a week's worth."""
    avg = float(np.mean(history[-28:])) if len(history) else 0.0
    perishable = econ.shelf_life <= PERISHABLE_DAYS
    if perishable:
        review_every = 1
    days = min(econ.shelf_life - 1, 1 + econ.lead_time) if perishable else 7
    target = avg * max(days, 1) * 1.2

    def decide(t, on_hand, pipeline):
        if t % review_every != 0:
            return 0
        return round_to_pack(target - on_hand - pipeline, econ.pack_size)

    return decide


PERISHABLE_DAYS = 7


def service_z(econ: ItemEcon) -> float:
    """Safety factor. Durable goods use a 95% service level. Perishables use
    the newsvendor critical ratio Cu / (Cu + Co): an unsold unit is thrown
    away (Co = cost) and a missed sale loses margin + goodwill (Cu). For a
    ₹2-margin milk packet the optimum is to run *lean*, not to over-stock."""
    if econ.shelf_life > PERISHABLE_DAYS:
        return Z_SERVICE
    cu = econ.margin * (1 + STOCKOUT_GOODWILL)
    ratio = cu / (cu + econ.cost_paise)
    return float(np.clip(norm.ppf(ratio), -1.0, Z_SERVICE))


def ss_policy(forecast: np.ndarray, sigma: float, econ: ItemEcon, cycle: int = 7):
    """Forecast-driven (s, S). ``forecast[t]`` is the expected demand on day t."""
    L = max(econ.lead_time, 1)
    z = service_z(econ)

    def window(t, n):
        seg = forecast[t + 1 : t + 1 + n]
        if len(seg) < n:  # beyond horizon: extend with last known level
            seg = np.concatenate([seg, np.full(n - len(seg), forecast[-1])])
        return float(seg.sum())

    # A new batch arrives at the start of day t+L and can only be sold for
    # `cover` days before it expires, so never order beyond that horizon.
    cover = max(1, min(cycle, econ.shelf_life))

    def decide(t, on_hand, pipeline):
        s = window(t, L) + z * sigma * np.sqrt(L)
        position = on_hand + pipeline
        if position >= s:
            return 0
        horizon = L - 1 + cover
        S = window(t, horizon) + z * sigma * np.sqrt(horizon)
        return round_to_pack(S - position, econ.pack_size)

    return decide


class QLearningPolicy:
    """Tabular Q-learning over (stock bucket, day-of-week)."""

    def __init__(self, econ: ItemEcon, mean_demand: float, max_packs: int = 4, seed: int = 0):
        self.econ = econ
        self.bucket = max(1.0, mean_demand)  # one bucket ~ one day of demand
        self.n_buckets = 16
        self.actions = np.arange(max_packs + 1)
        self.q = np.zeros((self.n_buckets, 7, len(self.actions)))
        self.rng = np.random.default_rng(seed)

    def _state(self, position: float, t: int) -> tuple[int, int]:
        return min(int(position / self.bucket), self.n_buckets - 1), t % 7

    def train(self, demand: np.ndarray, episodes: int = 60, alpha: float = 0.1, gamma: float = 0.95) -> None:
        e = self.econ
        for ep in range(episodes):
            eps = max(0.05, 1 - ep / (episodes * 0.7))
            shelf = _Shelf(int(self.bucket * 5), e.shelf_life)
            pipeline: list[tuple[int, int]] = []
            for t, d in enumerate(demand):
                for arr in [p for p in pipeline if p[0] == t]:
                    shelf.add(arr[1], e.shelf_life)
                pipeline = [p for p in pipeline if p[0] > t]
                s = self._state(shelf.units + sum(p[1] for p in pipeline), t)
                a = int(self.rng.integers(len(self.actions))) if self.rng.random() < eps else int(np.argmax(self.q[s]))
                q_units = int(self.actions[a]) * e.pack_size
                if q_units:
                    pipeline.append((t + e.lead_time, q_units))
                sold = shelf.sell(int(d))
                wasted = shelf.age()
                r = -(
                    (int(d) - sold) * e.margin * (1 + STOCKOUT_GOODWILL)
                    + wasted * e.cost_paise
                    + shelf.units * e.cost_paise * HOLDING_RATE_PER_DAY
                    + (ORDER_COST_PAISE if q_units else 0)
                ) / 1000.0
                s2 = self._state(shelf.units + sum(p[1] for p in pipeline), t + 1)
                self.q[s][a] += alpha * (r + gamma * self.q[s2].max() - self.q[s][a])

    def decide(self, t, on_hand, pipeline):
        s = self._state(on_hand + pipeline, t)
        return int(self.actions[int(np.argmax(self.q[s]))]) * self.econ.pack_size


def reorder_suggestion(on_hand: float, forecast_next: np.ndarray, sigma: float, econ: ItemEcon) -> dict:
    """Single-day decision for the app / ml-batch: should we order today?"""
    decide = ss_policy(np.concatenate([[0.0], forecast_next]), sigma, econ)
    qty = decide(0, on_hand, 0)
    days_cover = on_hand / max(float(np.mean(forecast_next[:7])), 1e-6)
    return {"orderUnits": int(qty), "daysOfCover": round(days_cover, 1), "reorder": qty > 0}
