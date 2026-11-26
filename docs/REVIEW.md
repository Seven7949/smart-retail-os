# ECC review log

Two independent review agents ran with the ECC `code-reviewer` and `security-reviewer` definitions, against
commit `5bbd666`. Neither had seen the code being written. All findings below were verified, and each fix has a
regression test where one is possible.

## Code review

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | CRITICAL | Overlapping SQLite writes (a bill saved during sync, or a double tap) nested `BEGIN`, and could leave a stale ledger head or delete the ledger in `replaceChain` | `SqliteRepo` serialises every operation. `Store` serialises every action. `commitBill` writes the ledger entry, stock and udhaar in one transaction. `replaceChain` is one transaction. Tests: *double taps cannot corrupt the ledger*, *created during a sync* |
| 2 | HIGH | Signing in to an account that already has a cloud ledger re-chained from seq 0, so every sync failed forever with `CHAIN_FORK` | Sign-in fetches the server head and refuses with a clear message. Settings are saved before re-chaining, and `Store.create` repairs an interrupted re-chain. Reset also signs out. Test: *refuses to fork…self-heals* |
| 3 | HIGH | Sync marked udhaar entries created during the request as synced | Only the entries actually sent are marked |
| 4 | HIGH | `NODE_ENV=production` at job level skipped devDependencies, so the APK job's tests could not run | `NODE_ENV` is set only on the Gradle step |
| 5 | MEDIUM | Toasts were hidden behind bottom sheets (an Android Modal is a separate window) | `ToastView` is also mounted inside every `Sheet` |
| 6 | MEDIUM | Double-tapping udhaar Save recorded the entry twice | Busy guard, plus the store mutex |
| 7 | MEDIUM | "Voice bill" from Home only worked once | Param is cleared after use, and a unique value is sent each time |
| 8 | LOW | Partial ledger batch on server failure | Client batches = 33 entries = one DynamoDB transaction |
| 9 | LOW | A Bedrock quantity of 0.0001 rounded to 0 and crashed the cart | Filtered on the server and the client |
| 10 | LOW | Toast fade callback ignored `finished` | Fixed |
| 11 | LOW | Unhandled rejection in invoice apply | try/catch + toast |

## Security review

| # | Severity | Finding | Fix |
|---|---|---|---|
| H1 | HIGH | Backdated or future-dated bills could be signed | The signer rejects future (>10 min) and backwards timestamps. Bill IDs are unique per batch and per chain. `signedAt` is stored. The v1 limitation is documented in `LEDGER_SPEC.md` |
| H2 | HIGH | Cost abuse: huge Bedrock prompts, repeated Textract runs, stage-wide throttle shared by all shops | Catalog fields are validated (unit whitelist, 16 KB cap). Per-shop daily quotas (voice 300, scan 40, sync 500) use atomic DynamoDB counters with TTL. Each upload is parsed once. Request list caps lowered to 2000. A budget alarm already exists |
| H3 | HIGH | Release APK signed with the public debug key | `plugins/withReleaseSigning.js` signs with a keystore from GitHub secrets (tested). APKs without one are labelled `-test` and the build shows a warning |
| M1 | MEDIUM | One shop could stall the nightly ML run | Only SKUs in the shop's inventory are used, capped at 1500 per shop |
| M2 | MEDIUM | All digests went to the operator's email | No catch-all subscriber. Each owner's verified Cognito email is subscribed with a `shopId` filter policy. Digest text is sanitised |
| M3 | MEDIUM | Workflow inputs were pasted into a shell command | Inputs go through env vars and are validated. A protected `aws` environment is used, with `persist-credentials: false` |
| L1 | LOW | Duplicate bill IDs could overwrite stored bills | Conditional writes plus a `BILLID#` marker |
| L3 | LOW | Broad DynamoDB grants | `insights` is now read-only plus `PutItem` |
| L5 | LOW | `contents: write` for the whole APK workflow | Split into a build job (read-only) and a minimal release job |
| L6 | LOW | API URL could be silently pointed at another host | Confirmation dialog when the host differs from the built-in one |

**Accepted for v1 (documented):** Cognito `USER_PASSWORD_AUTH` (needed without an SRP library), 8-character
passwords with no MFA, actions pinned by version tag rather than SHA, and a single sequential nightly batch (fine
at project scale; SQS fan-out is the next step).
