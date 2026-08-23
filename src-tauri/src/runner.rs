//! Headless Claude Code runs — the path used by chat messages.
//!
//! One agent turn == one `claude -p --output-format stream-json` process.
//! stdout is NDJSON; each line is forwarded to the webview as an event so the
//! UI can render tokens as they arrive. The prompt is piped over stdin (not
//! argv) so long prompts never hit the Windows command-line length limit.
//!
//! Nothing here talks to PocketBase. The frontend owns persistence: it already
//! holds the authenticated PocketBase session, and keeping Rust write-free
//! means a mobile client (no local Claude) uses the exact same data path.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

/// Appended to every agent's persona. This is the "caveman" contract: the
/// agents answer in compressed form, which cuts output tokens on every turn.
const BREVITY_CONTRACT: &str = "\
OUTPUT CONTRACT (strict):
- Answer in compressed form. Drop articles, filler, pleasantries, hedging.
- Fragments allowed. Keep every technical term, path, identifier, number exact.
- Code blocks, commands and error strings: verbatim, never compressed.
- No preamble, no summary of what you are about to do, no restating the question.
- Max 12 lines unless asked for more, or unless emitting code.
- End with a line 'FACTS:' followed by 1-3 durable facts worth storing as \
project context. Omit the section if the turn produced none.";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRequest {
    /// Client-generated id used to correlate events and to cancel the run.
    pub run_id: String,
    pub agent_id: String,
    pub agent_name: String,
    /// Channel the reply belongs to; echoed back on every event.
    pub channel_id: String,
    /// Working directory for the run — normally the project checkout.
    pub cwd: String,
    pub prompt: String,
    /// Agent persona / standing instructions.
    #[serde(default)]
    pub instructions: Option<String>,
    /// Pre-built compressed context (see `context::build_pack`).
    #[serde(default)]
    pub context_pack: Option<String>,
    /// Replace the default Claude Code system prompt entirely. Rarely useful.
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// Claude session to resume. `None` starts a fresh session whose id is
    /// reported on `agent://start` so the caller can persist it.
    #[serde(default)]
    pub resume_session_id: Option<String>,
    /// acceptEdits | auto | bypassPermissions | manual | plan
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// low | medium | high | xhigh | max
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub disallowed_tools: Vec<String>,
    #[serde(default)]
    pub add_dirs: Vec<String>,
    /// Skip hooks, plugins, CLAUDE.md autoload. Cheapest possible turn.
    #[serde(default)]
    pub bare: bool,
    /// Suppress the brevity contract for this agent (e.g. a writing agent).
    #[serde(default)]
    pub verbose_output: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunStarted {
    run_id: String,
    agent_id: String,
    channel_id: String,
    session_id: String,
    resumed: bool,
    context_tokens: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunChunk {
    run_id: String,
    agent_id: String,
    channel_id: String,
    /// Parsed NDJSON line from Claude Code.
    event: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunDelta {
    run_id: String,
    agent_id: String,
    channel_id: String,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunEnded {
    run_id: String,
    agent_id: String,
    channel_id: String,
    session_id: String,
    exit_code: i32,
    cancelled: bool,
    text: String,
    stderr: String,
}

struct RunHandle {
    agent_id: String,
    cancel: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct RunRegistry {
    runs: Mutex<HashMap<String, RunHandle>>,
}

impl RunRegistry {
    /// Register a run. Returns false when `run_id` is already executing —
    /// overwriting would drop the live run's cancel channel and kill it.
    fn insert(&self, run_id: String, handle: RunHandle) -> bool {
        let mut runs = self.runs.lock().unwrap();
        if runs.contains_key(&run_id) {
            return false;
        }
        runs.insert(run_id, handle);
        true
    }

    fn remove(&self, run_id: &str) -> Option<RunHandle> {
        self.runs.lock().unwrap().remove(run_id)
    }

    fn contains(&self, run_id: &str) -> bool {
        self.runs.lock().unwrap().contains_key(run_id)
    }

    fn active(&self) -> Vec<(String, String)> {
        self.runs
            .lock()
            .unwrap()
            .iter()
            .map(|(id, h)| (id.clone(), h.agent_id.clone()))
            .collect()
    }
}

/// Resolve the Claude Code executable. Overridable so users on odd setups
/// (nvm shims, WSL wrappers) can point at their own binary.
fn claude_bin() -> String {
    std::env::var("AIS_CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string())
}

/// The stable half of the prompt: who this agent is.
///
/// Only things that do not change turn to turn belong here. Claude Code bakes
/// the system prompt into a session when it is created and **ignores a changed
/// `--append-system-prompt` on `--resume`**, so anything volatile placed here
/// would silently stop updating after the first turn.
fn compose_system_prompt(req: &AgentRunRequest) -> String {
    let mut parts: Vec<String> = Vec::new();

    parts.push(format!(
        "You are '{}', one agent in a multi-agent workspace.",
        req.agent_name
    ));
    if let Some(instructions) = req.instructions.as_ref().filter(|s| !s.trim().is_empty()) {
        parts.push(instructions.trim().to_string());
    }
    if !req.verbose_output {
        parts.push(BREVITY_CONTRACT.to_string());
    }
    parts.join("\n\n")
}

/// The volatile half: project brief, channel brief and compressed memory.
///
/// This rides on the user message precisely because it changes every turn and
/// must survive `--resume`.
fn compose_user_prompt(req: &AgentRunRequest) -> String {
    match req.context_pack.as_ref().filter(|s| !s.trim().is_empty()) {
        Some(pack) => format!("{}\n\n---\n\n{}", pack.trim(), req.prompt),
        None => req.prompt.clone(),
    }
}

fn build_command(req: &AgentRunRequest, session_id: &str) -> Command {
    let mut cmd = Command::new(claude_bin());
    cmd.current_dir(&req.cwd);
    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages");

    match req.resume_session_id.as_deref() {
        Some(existing) if !existing.is_empty() => {
            cmd.arg("--resume").arg(existing);
        }
        _ => {
            cmd.arg("--session-id").arg(session_id);
        }
    }

    let system = compose_system_prompt(req);
    if let Some(full) = req.system_prompt.as_ref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--system-prompt").arg(full);
    }
    if !system.is_empty() {
        cmd.arg("--append-system-prompt").arg(system);
    }
    if let Some(model) = req.model.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--model").arg(model);
    }
    if let Some(mode) = req.permission_mode.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--permission-mode").arg(mode);
    }
    if let Some(effort) = req.effort.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--effort").arg(effort);
    }
    if !req.allowed_tools.is_empty() {
        cmd.arg("--allowed-tools").arg(req.allowed_tools.join(","));
    }
    if !req.disallowed_tools.is_empty() {
        cmd.arg("--disallowed-tools")
            .arg(req.disallowed_tools.join(","));
    }
    for dir in &req.add_dirs {
        cmd.arg("--add-dir").arg(dir);
    }
    if req.bare {
        cmd.arg("--bare");
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Windows: keep the console window from flashing on every turn.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd
}

/// Pull the human-visible text out of one stream-json line.
///
/// Handles both the incremental `stream_event` deltas and the terminal
/// `result` message, so callers get a live feed and a final transcript.
fn extract_text(event: &serde_json::Value) -> Option<String> {
    match event.get("type").and_then(|t| t.as_str()) {
        Some("stream_event") => {
            let delta = event.pointer("/event/delta")?;
            delta
                .get("text")
                .and_then(|t| t.as_str())
                .map(str::to_string)
        }
        Some("assistant") => {
            let content = event.pointer("/message/content")?.as_array()?;
            let joined: String = content
                .iter()
                .filter(|block| block.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("");
            (!joined.is_empty()).then_some(joined)
        }
        _ => None,
    }
}

/// Start an agent turn. Returns immediately; progress arrives as events.
#[tauri::command]
pub async fn run_agent(
    app: AppHandle,
    registry: State<'_, RunRegistry>,
    request: AgentRunRequest,
) -> Result<String, String> {
    let session_id = request
        .resume_session_id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    if registry.contains(&request.run_id) {
        return Err(format!("run '{}' is already executing", request.run_id));
    }

    let mut cmd = build_command(&request, &session_id);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn {} failed: {e}", claude_bin()))?;

    let mut stdin = child.stdin.take().ok_or("no stdin on claude process")?;
    let stdout = child.stdout.take().ok_or("no stdout on claude process")?;
    let stderr = child.stderr.take().ok_or("no stderr on claude process")?;

    // Context travels on stdin with the message, not in argv: it changes every
    // turn, and it can be far larger than the Windows command-line limit.
    let prompt = compose_user_prompt(&request);
    tokio::spawn(async move {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.shutdown().await;
    });

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let registered = registry.insert(
        request.run_id.clone(),
        RunHandle {
            agent_id: request.agent_id.clone(),
            cancel: Some(cancel_tx),
        },
    );
    if !registered {
        // Lost a race with another caller using the same id.
        let _ = child.kill().await;
        return Err(format!("run '{}' is already executing", request.run_id));
    }
    // `None` once the channel has resolved, so the select arm below is never
    // polled after completion.
    let mut cancel_rx = Some(cancel_rx);

    let _ = app.emit(
        "agent://start",
        RunStarted {
            run_id: request.run_id.clone(),
            agent_id: request.agent_id.clone(),
            channel_id: request.channel_id.clone(),
            session_id: session_id.clone(),
            resumed: request.resume_session_id.is_some(),
            context_tokens: request
                .context_pack
                .as_deref()
                .map(crate::context::estimate_tokens)
                .unwrap_or(0),
        },
    );

    // stderr is drained on its own task so a chatty CLI cannot deadlock stdout.
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    });

    let app_events = app.clone();
    let run_id = request.run_id.clone();
    let agent_id = request.agent_id.clone();
    let channel_id = request.channel_id.clone();
    let registry_key = request.run_id.clone();

    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut transcript = String::new();
        let mut cancelled = false;

        loop {
            tokio::select! {
                signal = async {
                    match cancel_rx.as_mut() {
                        Some(rx) => rx.await,
                        None => std::future::pending().await,
                    }
                } => {
                    // A dropped sender is not a cancellation — only an explicit
                    // send is. Stop watching either way.
                    cancel_rx = None;
                    if signal.is_ok() {
                        cancelled = true;
                        let _ = child.kill().await;
                        break;
                    }
                }
                line = reader.next_line() => {
                    match line {
                        Ok(Some(raw)) => {
                            if raw.trim().is_empty() {
                                continue;
                            }
                            let Ok(event) = serde_json::from_str::<serde_json::Value>(&raw) else {
                                // Non-JSON output means the CLI printed a plain
                                // diagnostic; forward it rather than drop it.
                                let _ = app_events.emit("agent://delta", RunDelta {
                                    run_id: run_id.clone(),
                                    agent_id: agent_id.clone(),
                                    channel_id: channel_id.clone(),
                                    text: raw,
                                });
                                continue;
                            };

                            if let Some(text) = extract_text(&event) {
                                // `assistant` repeats the full block that the
                                // deltas already streamed; only deltas append.
                                if event.get("type").and_then(|t| t.as_str()) == Some("stream_event") {
                                    transcript.push_str(&text);
                                }
                                let _ = app_events.emit("agent://delta", RunDelta {
                                    run_id: run_id.clone(),
                                    agent_id: agent_id.clone(),
                                    channel_id: channel_id.clone(),
                                    text,
                                });
                            }

                            if event.get("type").and_then(|t| t.as_str()) == Some("result") {
                                if let Some(result) = event.get("result").and_then(|r| r.as_str()) {
                                    transcript = result.to_string();
                                }
                            }

                            let _ = app_events.emit("agent://chunk", RunChunk {
                                run_id: run_id.clone(),
                                agent_id: agent_id.clone(),
                                channel_id: channel_id.clone(),
                                event,
                            });
                        }
                        Ok(None) => break,
                        Err(e) => {
                            let _ = app_events.emit("agent://delta", RunDelta {
                                run_id: run_id.clone(),
                                agent_id: agent_id.clone(),
                                channel_id: channel_id.clone(),
                                text: format!("[stdout read error] {e}"),
                            });
                            break;
                        }
                    }
                }
            }
        }

        let exit_code = match child.wait().await {
            Ok(status) => status.code().unwrap_or(-1),
            Err(_) => -1,
        };
        let stderr_text = stderr_task.await.unwrap_or_default();

        let _ = app_events.emit(
            "agent://end",
            RunEnded {
                run_id: run_id.clone(),
                agent_id,
                channel_id,
                session_id,
                exit_code,
                cancelled,
                text: transcript,
                stderr: stderr_text,
            },
        );

        if let Some(state) = app_events.try_state::<RunRegistry>() {
            state.remove(&registry_key);
        }
    });

    Ok(request.run_id)
}

/// Kill an in-flight run. Safe to call for an id that already finished.
#[tauri::command]
pub fn cancel_agent_run(registry: State<'_, RunRegistry>, run_id: String) -> bool {
    match registry.remove(&run_id) {
        Some(mut handle) => handle.cancel.take().map(|tx| tx.send(()).is_ok()).unwrap_or(false),
        None => false,
    }
}

/// Run ids currently executing, paired with their agent.
#[tauri::command]
pub fn active_runs(registry: State<'_, RunRegistry>) -> Vec<(String, String)> {
    registry.active()
}

/// Report whether the Claude Code CLI is reachable, and at what version.
#[tauri::command]
pub async fn claude_doctor() -> Result<String, String> {
    let output = Command::new(claude_bin())
        .arg("--version")
        .output()
        .await
        .map_err(|e| format!("{} not runnable: {e}", claude_bin()))?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> AgentRunRequest {
        AgentRunRequest {
            agent_name: "backend".into(),
            instructions: Some("You own src-tauri.".into()),
            context_pack: Some("## PROJECT Demo
Ship it.".into()),
            prompt: "What is 2+2?".into(),
            ..Default::default()
        }
    }

    #[test]
    fn context_rides_on_the_user_prompt_not_the_system_prompt() {
        let req = request();
        let system = compose_system_prompt(&req);
        let user = compose_user_prompt(&req);

        // Volatile context must survive --resume, which only replays the
        // session's original system prompt.
        assert!(!system.contains("Ship it."));
        assert!(user.contains("Ship it."));
        assert!(user.contains("What is 2+2?"));

        // The stable half still carries identity and persona.
        assert!(system.contains("backend"));
        assert!(system.contains("You own src-tauri."));
    }

    #[test]
    fn empty_context_leaves_the_prompt_untouched() {
        let req = AgentRunRequest {
            prompt: "hello".into(),
            context_pack: Some("   ".into()),
            ..Default::default()
        };
        assert_eq!(compose_user_prompt(&req), "hello");
    }

    #[test]
    fn verbose_agents_skip_the_brevity_contract() {
        let mut req = request();
        req.verbose_output = true;
        assert!(!compose_system_prompt(&req).contains("OUTPUT CONTRACT"));
        assert!(compose_system_prompt(&request()).contains("OUTPUT CONTRACT"));
    }
}
