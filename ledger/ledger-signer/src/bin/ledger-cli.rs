//! Local/dev CLI: reads one signer request (JSON) on stdin, prints the
//! response. Used by the Python backend's integration tests so they exercise
//! the *real* Rust validation and signing. Never deployed.
//!
//!     echo '{"action":"publicKey"}' | LEDGER_TEST_SECRET=... ledger-cli
#![forbid(unsafe_code)]

use ledger_core::Signer;
use ledger_signer::handler::{handle, now_ms, Request};
use std::io::Read;
use std::process::ExitCode;

fn main() -> ExitCode {
    let Ok(secret) = std::env::var("LEDGER_TEST_SECRET") else {
        eprintln!("LEDGER_TEST_SECRET must be set");
        return ExitCode::from(2);
    };
    let signer = match Signer::from_secret(&secret) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return ExitCode::from(2);
    }
    let out = match serde_json::from_str::<Request>(&input) {
        Ok(req) => serde_json::to_string(&handle(&signer, req, now_ms())),
        Err(_) => Ok(r#"{"ok":false,"error":{"seq":-1,"code":"MALFORMED_REQUEST"}}"#.to_string()),
    };
    match out {
        Ok(s) => {
            println!("{s}");
            ExitCode::SUCCESS
        }
        Err(_) => ExitCode::from(1),
    }
}
