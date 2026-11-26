"""GET /insights and POST /insights/refresh."""
from __future__ import annotations

import json
import os
import time

import boto3

from common import repo
from common.http import ApiError, api, shop_id

REFRESH_INTERVAL_MS = 10 * 60 * 1000


@api
def handler(event, _ctx):
    shop = shop_id(event)
    route = event.get("routeKey", "")
    tbl = repo.table()
    if route == "GET /insights":
        return 200, {"insights": repo.insights(tbl, shop)}
    if route == "POST /insights/refresh":
        now = int(time.time() * 1000)
        if not repo.claim_refresh_slot(tbl, shop, now, REFRESH_INTERVAL_MS):
            raise ApiError(429, "TOO_SOON", "insights were refreshed recently; try again in a few minutes")
        boto3.client("lambda").invoke(FunctionName=os.environ["ML_FUNCTION"], InvocationType="Event",
                                      Payload=json.dumps({"shopId": shop}).encode())
        return 202, {"status": "queued"}
    raise ApiError(404, "NOT_FOUND", "unknown route")
