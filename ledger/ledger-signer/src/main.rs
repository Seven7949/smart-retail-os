//! AWS Lambda entry point for the Rust ledger signer.
//!
//! The Ed25519 seed is derived from a Secrets Manager secret
//! (`LEDGER_SECRET_ARN`) that only this function's IAM role may read. The
//! secret is fetched once per cold start and kept in memory.
#![forbid(unsafe_code)]

use ledger_signer::handler;

use lambda_runtime::{service_fn, Error, LambdaEvent};
use ledger_core::Signer;
use serde_json::Value;
use tokio::sync::OnceCell;

static SIGNER: OnceCell<Signer> = OnceCell::const_new();

async fn load_signer() -> Result<Signer, Error> {
    let arn = std::env::var("LEDGER_SECRET_ARN").map_err(|_| "LEDGER_SECRET_ARN must be set")?;
    let config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let client = aws_sdk_secretsmanager::Client::new(&config);
    let secret = client
        .get_secret_value()
        .secret_id(arn)
        .send()
        .await
        .map_err(|e| format!("cannot read signing secret: {}", e.into_service_error()))?
        .secret_string
        .ok_or("signing secret has no string value")?;
    Ok(Signer::from_secret(&secret).map_err(|e| e.to_string())?)
}

async fn function(event: LambdaEvent<Value>) -> Result<Value, Error> {
    let signer = SIGNER.get_or_try_init(load_signer).await?;
    let request: handler::Request = match serde_json::from_value(event.payload) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "rejected malformed request");
            return Ok(
                serde_json::json!({"ok": false, "error": {"seq": -1, "code": "MALFORMED_REQUEST"}}),
            );
        }
    };
    let response = handler::handle(signer, request, handler::now_ms());
    Ok(serde_json::to_value(response)?)
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .json()
        .with_target(false)
        .without_time()
        .init();
    lambda_runtime::run(service_fn(function)).await
}
