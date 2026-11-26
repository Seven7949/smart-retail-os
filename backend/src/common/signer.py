"""Client for the Rust ledger-signer Lambda (direct, IAM-authorised invoke)."""
from __future__ import annotations

import json
import os

import boto3

_client = None


def _lambda():
    global _client
    if _client is None:
        _client = boto3.client("lambda")
    return _client


class SignerError(Exception):
    pass


def invoke(payload: dict) -> dict:
    res = _lambda().invoke(FunctionName=os.environ["SIGNER_FUNCTION"], InvocationType="RequestResponse",
                           Payload=json.dumps(payload).encode("utf-8"))
    body = json.loads(res["Payload"].read() or b"{}")
    if res.get("FunctionError"):
        raise SignerError(f"signer failed: {res['FunctionError']}")
    return body
