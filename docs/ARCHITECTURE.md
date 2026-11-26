# Architecture

```mermaid
flowchart LR
  subgraph Phone["Android app (Expo / React Native)"]
    UI[Screens: Home · Bill · Stock · Insights · Khata · Settings]
    SQL[(SQLite: offline source of truth)]
    ODML[On-device ML fallbacks: Holt-Winters, (s,S), Apriori, K-Means, logistic risk]
    VOICE[Speech recognizer hi-IN / en-IN + Hinglish parser]
    CHAIN[SHA-256 hash chain]
    UI --> SQL --> ODML
    VOICE --> UI
    SQL --> CHAIN
  end

  subgraph AWS["AWS (ap-south-1)"]
    COG[Cognito User Pool]
    API[API Gateway HTTP API + JWT authorizer + throttling]
    SYNC[λ sync]
    INS[λ insights]
    SCAN[λ scan]
    VOI[λ voice]
    VER[λ ledger-verify]
    RUST[λ ledger-signer · Rust · Ed25519]
    SEC[(Secrets Manager: signing seed)]
    DDB[(DynamoDB single table)]
    S3[(S3: invoice images, 30-day lifecycle)]
    TX[Textract AnalyzeExpense]
    BR[Bedrock · Claude Haiku]
    EB[EventBridge nightly 02:00 IST]
    ML[λ ml-batch · container · scikit-learn]
    SNS[SNS daily digest]
    SM[SageMaker training job]
    BUD[AWS Budget alarm]
  end

  Phone -- sign in --> COG
  Phone -- HTTPS + JWT --> API
  API --> SYNC & INS & SCAN & VOI & VER
  SYNC -- invoke --> RUST
  VER -- invoke --> RUST
  RUST --> SEC
  SYNC --> DDB
  INS --> DDB
  SCAN --> S3 --> TX
  VOI --> BR
  EB --> ML --> DDB
  ML --> SNS
  SM -. trains global model .-> S3
```

## Key decisions

| Decision | Why |
|---|---|
| **Offline-first; SQLite is the source of truth** | Kirana connectivity is patchy. The cloud adds sync, heavy ML, OCR and the LLM, but the app never blocks on it. |
| **On-device ML fallbacks in TypeScript** | Insights work in demo mode and offline. Cloud insights replace them once synced. |
| **Rust only for the security core** | The signer is the one component holding a secret. Rust gives memory safety and a small, auditable surface. Only its IAM role can read the secret (least privilege). Python never sees the key. |
| **Shop ID comes from the JWT `sub` claim** | Prevents one shop from reading or writing another's data (IDOR). |
| **Money in paise, quantity in milli-units** | Integer-only canonical JSON, so TS and Rust hashes match byte for byte. |
| **Serverless only** | Free-tier friendly. There are no SageMaker endpoints; the batch Lambda serves the models and SageMaker is used for training jobs only. |
| **Bedrock is a fallback, not the default** | The Hinglish parser handles most utterances for free and offline; the LLM only runs when parser confidence is low. Its output is validated against the shop's inventory. |

## Data model (DynamoDB single table `pk`/`sk`)

| Entity | pk | sk |
|---|---|---|
| Shop profile | `SHOP#<sub>` | `PROFILE` |
| Item | `SHOP#<sub>` | `ITEM#<sku>` |
| Bill | `SHOP#<sub>` | `BILL#<createdAt>#<billId>` |
| Ledger entry | `SHOP#<sub>` | `LEDGER#<seq zero-padded 12>` |
| Customer | `SHOP#<sub>` | `CUST#<customerId>` |
| Udhaar txn | `SHOP#<sub>` | `UDHAAR#<customerId>#<ts>#<id>` |
| Insight | `SHOP#<sub>` | `INSIGHT#<kind>` |

Ledger writes use `attribute_not_exists(sk)`, so two devices can never fork the chain.

## Repository layout

```
app/       Expo React Native app (TypeScript, Jest)
backend/   Python Lambda handlers (pytest + moto)
ledger/    Rust workspace: ledger-core (lib) + ledger-signer (Lambda)
ml/        Research pipeline, reports, SageMaker entry point, ml-batch container
infra/     AWS CDK (TypeScript) + assertion tests
spec/      Shared catalog + ledger test vectors used by TS, Rust and Python
docs/      PRD, architecture, ledger spec, task list, ECC workflow log
.github/   CI, APK build, AWS deploy, SageMaker training workflows
```
