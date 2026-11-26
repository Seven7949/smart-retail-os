"""HTTP helpers for API Gateway HTTP API (payload v2) Lambdas."""
from __future__ import annotations

import base64
import json
import logging
import re
from functools import wraps
from typing import Any, Callable

log = logging.getLogger()
log.setLevel(logging.INFO)

MAX_BODY_BYTES = 2 * 1024 * 1024
SHOP_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def respond(status: int, body: Any) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "strict-transport-security": "max-age=63072000",
        },
        "body": json.dumps(body, separators=(",", ":"), ensure_ascii=False),
    }


def shop_id(event: dict) -> str:
    """Shop identity ALWAYS comes from the verified Cognito JWT, never the body."""
    try:
        sub = event["requestContext"]["authorizer"]["jwt"]["claims"]["sub"]
    except (KeyError, TypeError):
        raise ApiError(401, "UNAUTHENTICATED", "missing identity") from None
    if not isinstance(sub, str) or not SHOP_ID_RE.match(sub):
        raise ApiError(401, "UNAUTHENTICATED", "invalid identity")
    return sub


def json_body(event: dict) -> dict:
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        try:
            raw = base64.b64decode(raw).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "BAD_REQUEST", "body is not valid base64 UTF-8") from None
    if len(raw.encode("utf-8")) > MAX_BODY_BYTES:
        raise ApiError(413, "PAYLOAD_TOO_LARGE", "request body too large")
    if not raw:
        return {}
    try:
        body = json.loads(raw)
    except json.JSONDecodeError:
        raise ApiError(400, "BAD_REQUEST", "body must be JSON") from None
    if not isinstance(body, dict):
        raise ApiError(400, "BAD_REQUEST", "body must be a JSON object")
    return body


def api(fn: Callable[[dict, Any], Any]) -> Callable[[dict, Any], dict]:
    """Wrap a handler: map ApiError/ValueError to clean 4xx, never leak internals."""

    @wraps(fn)
    def wrapper(event, context):
        rid = getattr(context, "aws_request_id", "-")
        try:
            status, body = fn(event, context)
            return respond(status, body)
        except ApiError as e:
            log.info(json.dumps({"rid": rid, "status": e.status, "code": e.code}))
            return respond(e.status, {"error": {"code": e.code, "message": e.message}})
        except ValueError as e:
            log.info(json.dumps({"rid": rid, "status": 400, "code": "VALIDATION", "detail": str(e)[:200]}))
            return respond(400, {"error": {"code": "VALIDATION", "message": str(e)[:200]}})
        except Exception:
            log.exception("unhandled error rid=%s", rid)
            return respond(500, {"error": {"code": "INTERNAL", "message": "internal error", "requestId": rid}})

    return wrapper
