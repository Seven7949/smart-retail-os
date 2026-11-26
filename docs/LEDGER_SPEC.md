# Tamper-evident ledger specification (v1)

The app (TypeScript) and the ledger service (Rust) must produce **byte-identical** hashes.
Both test suites read the shared vectors in `spec/ledger-vectors.json`.

## Canonical JSON

`canonical(value)`:

- Objects: keys sorted by Unicode code point (keys must be ASCII), no whitespace, `{"a":1,"b":2}`.
- Arrays: keep order, no whitespace.
- Strings: standard JSON escaping (`\"`, `\\`, `\n`, `\r`, `\t`, `\b`, `\f`, other control characters as `\u00xx` with lowercase hex). Non-ASCII text (for example Hindi) is emitted as raw UTF-8, never escaped.
- Numbers: **integers only**, in the range `[-(2^53-1), 2^53-1]`. Money is stored in **paise** and quantities in **milli-units** (1 kg = 1000), so floats never appear. Floats are rejected.
- `true`, `false` and `null` are allowed.

## Bill payload

```json
{
  "billId": "b_…",                   // unique, [A-Za-z0-9_-]{1,64}
  "createdAt": 1767225600000,         // epoch ms
  "customerId": "c_…" | null,
  "items": [{"sku": "…", "qtyMilli": 2000, "unitPricePaise": 4500}],
  "paymentMode": "cash" | "upi" | "udhaar",
  "totalPaise": 9000
}
```

`payloadHash = hex(sha256(utf8(canonical(bill))))`

**Line total rule** (checked by the signer, so inconsistent bills are never signed):
`lineTotal = floor((qtyMilli * unitPricePaise + 500) / 1000)`; `totalPaise = Σ lineTotal`.
`udhaar` bills must carry a `customerId`. IDs match `[A-Za-z0-9_-]{1,64}`.

## Ledger entry

```json
{"billId": "…", "payloadHash": "…", "prevHash": "…", "seq": 0, "shopId": "…", "timestamp": 1767225600000}
```

- `seq` starts at 0 and increases by exactly 1.
- `prevHash` of `seq = 0` is 64 zeros. Otherwise it is the previous entry's `entryHash`.
- `entryHash = hex(sha256(utf8(canonical(entry))))`

## Signature

`signature = base64(ed25519_sign(signing_key, bytes(entryHash)))`. The message is the
**32 raw bytes** of the hash, not its hex text.

The signing key seed is `sha256(utf8(secret))`, where `secret` is held in AWS Secrets
Manager and readable **only** by the Rust Lambda's IAM role. The public key is published so
anyone can verify the chain.

## Verification result

The first failure wins:

| Code | Meaning |
|---|---|
| `SEQ_GAP` | seq not contiguous (entry deleted or inserted) |
| `PREV_MISMATCH` | prevHash does not match the previous entryHash (reordered or forked) |
| `PAYLOAD_MISMATCH` | bill content does not match payloadHash (bill edited) |
| `HASH_MISMATCH` | entryHash does not match recomputed hash (entry edited) |
| `BAD_SIGNATURE` | signature invalid (forged by someone without the key) |
| `SHOP_MISMATCH` | entry belongs to another shop |
