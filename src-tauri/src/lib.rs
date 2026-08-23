//! ais-teams desktop core.
//!
//! Responsibilities, in order of importance:
//!   1. Run Claude Code (headless per chat turn, or in a real PTY).
//!   2. Compress and budget context before it is sent anywhere.
//!   3. Expose machine facts the UI needs (hostname, LAN address for pairing).
//!
//! Persistence is deliberately absent: PocketBase is the single source of
//! truth and the frontend writes to it directly, so the desktop app and a
//! phone see identical data.

mod context;
mod runner;

#[cfg(desktop)]
mod pty;

use serde::Serialize;

use context::{ContextChunk, ContextPack};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub hostname: String,
    pub platform: &'static str,
    /// True when this build can spawn Claude Code locally.
    pub can_run_agents: bool,
}

/// Compress arbitrary text with the caveman rules (code stays verbatim).
#[tauri::command]
fn compress_text(text: String) -> String {
    context::compress(&text)
}

/// Cheap token estimate, used by the UI to show per-turn cost before sending.
#[tauri::command]
fn estimate_tokens(text: String) -> usize {
    context::estimate_tokens(&text)
}

/// Rank, compress and truncate context chunks into one injectable block.
#[tauri::command]
fn build_context_pack(chunks: Vec<ContextChunk>, budget_tokens: usize) -> ContextPack {
    context::build_pack(chunks, budget_tokens)
}

/// Default per-turn context budget in tokens; the UI seeds new projects with it.
#[tauri::command]
fn default_context_budget() -> usize {
    context::DEFAULT_CONTEXT_BUDGET
}

#[tauri::command]
fn host_info() -> HostInfo {
    HostInfo {
        hostname: hostname(),
        platform: std::env::consts::OS,
        can_run_agents: cfg!(desktop),
    }
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(runner::RunRegistry::default());

    #[cfg(desktop)]
    let builder = builder
        .manage(pty::PtyRegistry::default())
        .invoke_handler(tauri::generate_handler![
            compress_text,
            estimate_tokens,
            build_context_pack,
            default_context_budget,
            host_info,
            runner::run_agent,
            runner::cancel_agent_run,
            runner::active_runs,
            runner::claude_doctor,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            pty::pty_list,
        ]);

    // Phones have no local Claude Code binary; only the pure helpers ship.
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        compress_text,
        estimate_tokens,
        build_context_pack,
        default_context_budget,
        host_info,
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
