# Task list and ECC workflow

The project follows the **Everything Claude Code (ECC)** feature workflow
(`rules/common/development-workflow.md`):

0. **Research & reuse**: use proven libraries (ed25519-dalek, sha2, mlxtend, scikit-learn,
   LightGBM, expo-speech-recognition, AWS CDK) instead of hand-rolled code where one exists.
1. **Plan first**: this folder (PRD, architecture, ledger spec, this task list).
2. **TDD**: tests are written first for each module (RED → GREEN → REFACTOR), with 80%+ coverage on domain logic.
3. **Code review**: an independent reviewer agent runs with the ECC `code-reviewer` checklist. CRITICAL and HIGH findings are fixed.
4. **Security review**: an independent agent runs with the ECC `security-reviewer` checklist.
5. **Conventional commits**, with CI green before release.

## Phases

| # | Phase | Deliverable | Tests |
|---|---|---|---|
| 1 | Spec | `spec/catalog.json`, `spec/ledger-vectors.json` | used by every suite |
| 2 | Rust ledger | `ledger/` core + signer Lambda | `cargo test`, clippy |
| 3 | ML research | `ml/` pipeline + `ml/reports/` | `pytest` |
| 4 | Backend | `backend/` handlers | `pytest` + moto |
| 5 | Infra | `infra/` CDK stack | Jest assertions |
| 6 | App | `app/` screens + domain logic | Jest |
| 7 | CI/CD | `.github/workflows/` | runs all of the above, builds APK |
| 8 | Review | `docs/REVIEW.md` | ECC reviewer findings fixed |

## Risks

| Risk | Mitigation |
|---|---|
| Hash mismatch between TS and Rust | Shared vectors file, tested in both languages |
| AWS cost | No always-on resources, budget alarm, 30-day S3 lifecycle |
| No real shop data | Realistic synthetic generator (festivals, paydays, seasonality, baskets) plus an option to import a real CSV |
| Speech recogniser missing Hindi pack | Falls back to en-IN, the typed Hinglish parser and the Bedrock fallback |
