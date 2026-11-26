# PRD — Smart Retail OS (Dukaan AI)

## 1. Problem

India has roughly 13 million kirana (neighbourhood) stores. Most still run on a paper
*khata* (credit notebook) and memory:

- **Stock is a guess.** Owners reorder when a shelf looks empty, so fast movers run out
  before festivals while slow movers expire on the shelf. Recorded and actual stock can
  differ by 20–30%.
- **Supplier bills are typed in by hand**, if they are recorded at all.
- **Udhaar (customer credit) leaks money.** Credit is tracked in a notebook, reminders are
  awkward, and nobody knows which customers are likely to default.
- **Records can be edited after the fact**, so a shop's books can't be trusted by a lender,
  a partner or the owner themselves.
- **Connectivity is patchy** and many owners are more comfortable speaking Hindi than typing.

## 2. Users

| User | Need |
|---|---|
| Shop owner (primary) | Fast billing, knows what to reorder and when, recovers udhaar |
| Shop helper | Bill by voice in Hindi/English without training |
| Lender / auditor (secondary) | Proof that sales records were not altered |

## 3. Goals and success metrics

| Goal | Metric (measured in `ml/reports`) |
|---|---|
| Better demand forecasts than "same day last week" | WAPE / MASE lower than the seasonal-naive baseline |
| Fewer stockouts without extra stock | Stockout days and total cost vs the shopkeeper heuristic |
| Useful cross-sell rules | Rules with lift > 1.5 and confidence > 0.3 |
| Actionable customer groups | Silhouette score and named personas |
| Catch risky udhaar early | PR-AUC / recall vs a logistic baseline |
| Tamper evidence | 100% detection of edited, deleted or reordered bills in tests |

## 4. Scope

### Core ML features (from the course project bank)
1. **#6 Sales forecasting**: per-product daily demand with Indian festival, payday and weekly features.
2. **#40 Inventory replenishment**: when and how much to reorder (forecast-driven (s,S) policy vs heuristic vs Q-learning).
3. **#35 Purchase-pattern mining**: frequently bought together (Apriori vs FP-Growth).
4. **#27 Customer segmentation**: RFM clustering (K-Means vs GMM vs DBSCAN vs Hierarchical).

### Innovative features
5. **Invoice photo → stock**: Amazon Textract AnalyzeExpense reads supplier bills; fuzzy matching maps lines to inventory items.
6. **Hindi/English voice billing**: on-device speech recognition plus a Hinglish quantity parser ("do kilo cheeni, teen Maggi"), with an Amazon Bedrock fallback for complex sentences.
7. **Udhaar ledger**: credit and payment tracking, ML risk score, and WhatsApp reminders that carry a UPI payment link.
8. **Tamper-proof ledger (Rust)**: every bill is SHA-256 hash-chained on the device and signed with Ed25519 by a Rust Lambda. Editing, deleting or reordering any bill breaks verification.
9. **Offline-first**: the app is fully usable with no network; data syncs when online. A demo shop with 120 days of data makes every insight visible on first launch.

### Out of scope (v1)
GST filing, multi-store chains, payments processing (UPI is a deep link only), iOS build.

## 5. Non-functional requirements
- Works offline; sync is idempotent and retry-safe.
- No secrets in the app bundle. Auth tokens are kept in the Android Keystore (expo-secure-store).
- Every API route needs a Cognito JWT. The shop ID always comes from the token, never from the request body.
- API throttling, input validation at every boundary, least-privilege IAM per Lambda.
- AWS cost guardrail: serverless only, no always-on endpoints, plus a budget alarm.
- Test coverage of 80% or more on the domain logic (ECC testing rule).

## 6. Ethics (rubric requirement)
- Udhaar risk is **decision support**: it never blocks a sale. It uses no protected attributes
  (religion, caste, gender), only payment behaviour.
- Customer data stays in the shop's own partition; Bedrock calls send item names and the
  spoken sentence only, never customer identities.
- Synthetic data is used for research; it is clearly labelled and its limitations are documented.
