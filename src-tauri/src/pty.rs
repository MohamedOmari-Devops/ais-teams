//! Interactive Claude Code sessions backed by a real PTY (desktop only).
//!
//! `runner.rs` covers chat turns. This module covers the case where a human
//! wants the actual TUI: a terminal tab inside the app running `claude` with a
//! pseudo-terminal, so prompts, permission dialogs and the status line behave
//! exactly as they do in a shell.
//!
//! Mobile clients never reach this code — they drive agents through PocketBase
//! and the desktop machine executes the run.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOpenRequest {
    /// Caller-chosen id, normally the channel or project id.
    pub session_id: String,
    pub cwd: String,
    /// Extra argv for `claude`. Empty starts a plain interactive session.
    #[serde(default)]
    pub args: Vec<String>,
    /// Program to run. Defaults to the Claude Code CLI.
    #[serde(default)]
    pub program: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

fn default_cols() -> u16 {
    120
}
fn default_rows() -> u16 {
    30
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyData {
    session_id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExit {
    session_id: String,
    code: i32,
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyRegistry {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

fn claude_bin() -> String {
    std::env::var("AIS_CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string())
}

/// Open a PTY and start Claude Code inside it.
///
/// Output is streamed to the webview as `pty://data`; process exit arrives as
/// `pty://exit`. Reopening an id closes the previous session first.
#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    registry: State<'_, PtyRegistry>,
    request: PtyOpenRequest,
) -> Result<String, String> {
    close_session(&registry, &request.session_id);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: request.rows,
            cols: request.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(request.program.unwrap_or_else(claude_bin));
    for arg in &request.args {
        cmd.arg(arg);
    }
    cmd.cwd(&request.cwd);
    for (key, value) in &request.env {
        cmd.env(key, value);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn in pty failed: {e}"))?;
    // Dropping the slave lets the reader see EOF once the child exits.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer failed: {e}"))?;

    let session_id = request.session_id.clone();
    let sessions = registry.sessions.clone();
    let app_reader = app.clone();
    let reader_id = session_id.clone();

    // Blocking reads live on their own OS thread; a PTY has no async API here.
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = app_reader.emit(
                        "pty://data",
                        PtyData {
                            session_id: reader_id.clone(),
                            data: String::from_utf8_lossy(&buf[..n]).to_string(),
                        },
                    );
                }
                Err(_) => break,
            }
        }

        let code = sessions
            .lock()
            .unwrap()
            .remove(&reader_id)
            .and_then(|mut session| session.child.wait().ok())
            .map(|status| status.exit_code() as i32)
            .unwrap_or(-1);

        let _ = app_reader.emit(
            "pty://exit",
            PtyExit {
                session_id: reader_id,
                code,
            },
        );
    });

    registry.sessions.lock().unwrap().insert(
        session_id.clone(),
        PtySession {
            master: pair.master,
            writer,
            child,
        },
    );

    Ok(session_id)
}

/// Send keystrokes (or a whole command plus `\r`) to a session.
#[tauri::command]
pub fn pty_write(
    registry: State<'_, PtyRegistry>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = registry.sessions.lock().unwrap();
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("no pty session '{session_id}'"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("pty write failed: {e}"))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("pty flush failed: {e}"))
}

#[tauri::command]
pub fn pty_resize(
    registry: State<'_, PtyRegistry>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = registry.sessions.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("no pty session '{session_id}'"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty resize failed: {e}"))
}

#[tauri::command]
pub fn pty_close(registry: State<'_, PtyRegistry>, session_id: String) -> bool {
    close_session(&registry, &session_id)
}

#[tauri::command]
pub fn pty_list(registry: State<'_, PtyRegistry>) -> Vec<String> {
    registry.sessions.lock().unwrap().keys().cloned().collect()
}

fn close_session(registry: &State<'_, PtyRegistry>, session_id: &str) -> bool {
    let session = registry.sessions.lock().unwrap().remove(session_id);
    match session {
        Some(mut session) => {
            let _ = session.child.kill();
            true
        }
        None => false,
    }
}
