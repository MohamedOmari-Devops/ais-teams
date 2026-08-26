//! Headless agent runs — the path used by chat messages.
//!
//! One agent turn == one CLI process. Which CLI is a per-agent choice: Claude
//! Code, Codex, OpenCode, Kimi, or anything the user described in settings
//! (see `providers.rs`). The differences between them — argv, output format,
//! where the prompt goes, which key the child needs — are all carried by the
//! profile, so everything below is shape-agnostic: spawn, read stdout, forward
//! text to the webview as it arrives.
//!
//! Nothing here talks to PocketBase. The frontend owns persistence: it already
//! holds the authenticated PocketBase session, and keeping Rust write-free
//! means a mobile client (no local CLI) uses the exact same data path.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

use crate::providers::{self, ArgvKind, CliProfile, OutputFormat, PromptVia, Settings};

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
    /// CLI profile id. `None` uses the machine's default profile.
    #[serde(default)]
    pub provider: Option<String>,
    /// Agent persona / standing instructions.
    #[serde(default)]
    pub instructions: Option<String>,
    /// Pre-built compressed context (see `context::build_pack`).
    #[serde(default)]
    pub context_pack: Option<String>,
    /// Replace the CLI's default system prompt entirely. Rarely useful, and
    /// only honoured by backends that take a system prompt as a flag.
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// Session to resume. `None` starts a fresh session whose id is reported
    /// on `agent://start` so the caller can persist it.
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
    /// Enable the Claude in Chrome integration for this agent's turns.
    #[serde(default)]
    pub chrome: bool,
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
    /// Which backend actually ran, so the UI can label the reply.
    provider: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunChunk {
    run_id: String,
    agent_id: String,
    channel_id: String,
    /// Parsed NDJSON line from the CLI.
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
    provider: String,
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
/// must survive `--resume`. On a backend with no system-prompt flag the
/// persona is folded in here too — dropping it would leave the agent nameless
/// and unbriefed, which is worse than paying for it on every turn.
fn compose_user_prompt(req: &AgentRunRequest, profile: &CliProfile) -> String {
    let mut sections: Vec<String> = Vec::new();

    if !profile.supports.system_prompt {
        let persona = compose_system_prompt(req);
        if !persona.is_empty() {
            sections.push(persona);
        }
    }
    if let Some(pack) = req.context_pack.as_ref().filter(|s| !s.trim().is_empty()) {
        sections.push(pack.trim().to_string());
    }
    sections.push(req.prompt.clone());

    sections.join("\n\n---\n\n")
}

/// Everything needed to spawn one turn.
struct Plan {
    argv: Vec<String>,
    /// Prompt to pipe, when the profile takes it on stdin.
    stdin: Option<String>,
}

fn build_plan(req: &AgentRunRequest, profile: &CliProfile, session_id: &str) -> Plan {
    let prompt = compose_user_prompt(req, profile);
    let system = compose_system_prompt(req);
    let model = req
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(profile.default_model.as_str())
        .to_string();

    let mut argv = match profile.argv {
        ArgvKind::Claude => claude_argv(req, profile, session_id, &system, &model),
        ArgvKind::Codex => codex_argv(req, profile, &model),
        ArgvKind::OpenCode => opencode_argv(&model),
        ArgvKind::Template => template_argv(req, profile, session_id, &system, &model, &prompt),
    };

    argv.extend(profile.extra_args.iter().cloned());

    // The prompt goes last so a positional argument is never mistaken for a
    // flag value. A template that already placed `{prompt}` keeps its position.
    let placed = profile.argv == ArgvKind::Template
        && profile.template.iter().any(|a| a.contains("{prompt}"));

    match profile.prompt_via {
        PromptVia::Stdin => Plan {
            argv,
            stdin: Some(prompt),
        },
        PromptVia::Arg => {
            if !placed {
                argv.push(prompt);
            }
            Plan { argv, stdin: None }
        }
    }
}

fn claude_argv(
    req: &AgentRunRequest,
    profile: &CliProfile,
    session_id: &str,
    system: &str,
    model: &str,
) -> Vec<String> {
    let mut argv: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--include-partial-messages".into(),
    ];

    match req.resume_session_id.as_deref().filter(|s| !s.is_empty()) {
        Some(existing) if profile.supports.resume => {
            argv.push("--resume".into());
            argv.push(existing.to_string());
        }
        _ => {
            argv.push("--session-id".into());
            argv.push(session_id.to_string());
        }
    }

    if let Some(full) = req.system_prompt.as_ref().filter(|s| !s.trim().is_empty()) {
        argv.push("--system-prompt".into());
        argv.push(full.clone());
    }
    if !system.is_empty() {
        argv.push("--append-system-prompt".into());
        argv.push(system.to_string());
    }
    if !model.is_empty() {
        argv.push("--model".into());
        argv.push(model.to_string());
    }
    if profile.supports.permission_mode {
        if let Some(mode) = req.permission_mode.as_ref().filter(|s| !s.is_empty()) {
            argv.push("--permission-mode".into());
            argv.push(mode.clone());
        }
    }
    if profile.supports.effort {
        if let Some(effort) = req.effort.as_ref().filter(|s| !s.is_empty()) {
            argv.push("--effort".into());
            argv.push(effort.clone());
        }
    }
    if profile.supports.tools {
        if !req.allowed_tools.is_empty() {
            argv.push("--allowed-tools".into());
            argv.push(req.allowed_tools.join(","));
        }
        if !req.disallowed_tools.is_empty() {
            argv.push("--disallowed-tools".into());
            argv.push(req.disallowed_tools.join(","));
        }
    }
    if profile.supports.add_dirs {
        for dir in &req.add_dirs {
            argv.push("--add-dir".into());
            argv.push(dir.clone());
        }
    }
    if req.bare {
        argv.push("--bare".into());
    }
    if req.chrome {
        argv.push("--chrome".into());
    }

    argv
}

/// `codex exec --json` — Codex's non-interactive mode.
///
/// It has no append-system-prompt and no tool allowlist, so those arrive in
/// the prompt instead. Approval and sandbox are one setting there, not two,
/// which is why the permission modes collapse onto three flags.
fn codex_argv(req: &AgentRunRequest, profile: &CliProfile, model: &str) -> Vec<String> {
    let mut argv: Vec<String> = vec![
        "exec".into(),
        "--json".into(),
        "--skip-git-repo-check".into(),
    ];

    if !req.cwd.trim().is_empty() {
        argv.push("--cd".into());
        argv.push(req.cwd.clone());
    }
    if !model.is_empty() {
        argv.push("--model".into());
        argv.push(model.to_string());
    }
    if profile.supports.effort {
        if let Some(effort) = req.effort.as_deref().filter(|s| !s.is_empty()) {
            // Codex tops out at "high"; the two levels above it map down.
            let level = match effort {
                "xhigh" | "max" => "high",
                other => other,
            };
            argv.push("-c".into());
            argv.push(format!("model_reasoning_effort=\"{level}\""));
        }
    }
    if profile.supports.permission_mode {
        match req.permission_mode.as_deref().unwrap_or("") {
            "bypassPermissions" => {
                argv.push("--dangerously-bypass-approvals-and-sandbox".into())
            }
            "acceptEdits" | "auto" => argv.push("--full-auto".into()),
            "plan" | "manual" => {
                argv.push("--sandbox".into());
                argv.push("read-only".into());
            }
            _ => {}
        }
    }
    if req.prompt_via_stdin(profile) {
        // `-` is Codex's read-the-prompt-from-stdin marker.
        argv.push("-".into());
    }

    argv
}

/// `opencode run` — one message, one answer, plain text on stdout.
fn opencode_argv(model: &str) -> Vec<String> {
    let mut argv: Vec<String> = vec!["run".into()];
    if !model.is_empty() {
        argv.push("--model".into());
        argv.push(model.to_string());
    }
    argv
}

/// A user-described CLI: literal argv with `{...}` substitution.
///
/// An argument whose placeholder resolves to empty is dropped whole, together
/// with a preceding flag — `--model {model}` with no model would otherwise
/// leave a dangling `--model` for the next argument to be eaten by.
fn template_argv(
    req: &AgentRunRequest,
    profile: &CliProfile,
    session_id: &str,
    system: &str,
    model: &str,
    prompt: &str,
) -> Vec<String> {
    let resume = req.resume_session_id.as_deref().unwrap_or("");
    let session = if profile.supports.resume && !resume.is_empty() {
        resume
    } else {
        session_id
    };

    let mut argv: Vec<String> = Vec::with_capacity(profile.template.len());
    for raw in &profile.template {
        let filled = raw
            .replace("{prompt}", prompt)
            .replace("{model}", model)
            .replace("{cwd}", &req.cwd)
            .replace("{system}", system)
            .replace("{session}", session);

        if filled.trim().is_empty() {
            // Drop the flag this empty value belonged to.
            if argv.last().map(|a| a.starts_with('-')).unwrap_or(false) {
                argv.pop();
            }
            continue;
        }
        argv.push(filled);
    }
    argv
}

impl AgentRunRequest {
    fn prompt_via_stdin(&self, profile: &CliProfile) -> bool {
        profile.prompt_via == PromptVia::Stdin
    }
}

fn build_command(plan: &Plan, profile: &CliProfile, settings: &Settings, cwd: &str) -> Command {
    let mut cmd = Command::new(&profile.bin);
    if !cwd.trim().is_empty() {
        cmd.current_dir(cwd);
    }
    cmd.args(&plan.argv);

    // Keys ride in the environment, never in argv: argv is visible to every
    // other process on the machine.
    for (name, value) in providers::resolved_env(profile, settings) {
        cmd.env(name, value);
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

// ------------------------------------------------------------- output parsing

/// One unit of readable output pulled off the CLI's stdout.
#[derive(Debug, PartialEq)]
enum Piece {
    /// Streamed text: show it and keep it.
    Delta(String),
    /// Text the transcript already has: show it, do not append it twice.
    Echo(String),
    /// The whole answer, authoritative. Replaces whatever was accumulated.
    Final(String),
    None,
}

/// Pull the human-visible text out of one Claude Code stream-json line.
fn parse_claude(event: &serde_json::Value) -> Piece {
    match event.get("type").and_then(|t| t.as_str()) {
        Some("stream_event") => event
            .pointer("/event/delta/text")
            .and_then(|t| t.as_str())
            .map(|t| Piece::Delta(t.to_string()))
            .unwrap_or(Piece::None),
        Some("assistant") => {
            let Some(content) = event.pointer("/message/content").and_then(|c| c.as_array()) else {
                return Piece::None;
            };
            let joined: String = content
                .iter()
                .filter(|block| block.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("");
            // `assistant` repeats the block the deltas already streamed.
            if joined.is_empty() {
                Piece::None
            } else {
                Piece::Echo(joined)
            }
        }
        Some("result") => event
            .get("result")
            .and_then(|r| r.as_str())
            .map(|t| Piece::Final(t.to_string()))
            .unwrap_or(Piece::None),
        _ => Piece::None,
    }
}

/// Pull text out of one `codex exec --json` line.
///
/// Codex has moved this shape around between releases — the flat `msg` form
/// and the nested `item` form both appear in the wild — so both are accepted
/// rather than pinning the app to one CLI version.
fn parse_codex(event: &serde_json::Value) -> Piece {
    if let Some(delta) = event
        .pointer("/msg/delta")
        .and_then(|d| d.as_str())
        .filter(|_| {
            event.pointer("/msg/type").and_then(|t| t.as_str()) == Some("agent_message_delta")
        })
    {
        return Piece::Delta(delta.to_string());
    }

    if event.pointer("/msg/type").and_then(|t| t.as_str()) == Some("agent_message") {
        if let Some(text) = event.pointer("/msg/message").and_then(|m| m.as_str()) {
            return Piece::Final(text.to_string());
        }
    }

    if event.get("type").and_then(|t| t.as_str()) == Some("item.completed")
        && event.pointer("/item/type").and_then(|t| t.as_str()) == Some("agent_message")
    {
        if let Some(text) = event.pointer("/item/text").and_then(|t| t.as_str()) {
            return Piece::Final(text.to_string());
        }
    }

    // Surface failures rather than ending the turn on a silent empty reply.
    if event.get("type").and_then(|t| t.as_str()) == Some("error") {
        if let Some(message) = event.get("message").and_then(|m| m.as_str()) {
            return Piece::Echo(format!("[codex error] {message}\n"));
        }
    }

    Piece::None
}

fn parse_line(output: OutputFormat, raw: &str) -> (Piece, Option<serde_json::Value>) {
    match output {
        OutputFormat::Plain => (Piece::Delta(format!("{raw}\n")), None),
        OutputFormat::ClaudeStreamJson | OutputFormat::CodexJsonl => {
            match serde_json::from_str::<serde_json::Value>(raw) {
                Ok(event) => {
                    let piece = match output {
                        OutputFormat::CodexJsonl => parse_codex(&event),
                        _ => parse_claude(&event),
                    };
                    (piece, Some(event))
                }
                // Non-JSON output means the CLI printed a plain diagnostic;
                // forward it rather than drop it.
                Err(_) => (Piece::Echo(format!("{raw}\n")), None),
            }
        }
    }
}

// --------------------------------------------------------------------- run

/// Start an agent turn. Returns immediately; progress arrives as events.
#[tauri::command]
pub async fn run_agent(
    app: AppHandle,
    registry: State<'_, RunRegistry>,
    request: AgentRunRequest,
) -> Result<String, String> {
    let settings = providers::load(&app);
    let profile = providers::resolve(&settings, request.provider.as_deref());

    if !profile.enabled {
        return Err(format!("CLI profile '{}' is disabled", profile.label));
    }
    if registry.contains(&request.run_id) {
        return Err(format!("run '{}' is already executing", request.run_id));
    }

    let session_id = request
        .resume_session_id
        .clone()
        .filter(|s| !s.is_empty() && profile.supports.resume)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let plan = build_plan(&request, &profile, &session_id);

    // A backend that takes its prompt as an argument carries the whole context
    // pack in argv. Windows caps a command line near 32 KB, and the failure it
    // raises there names no cause at all — so say what actually happened.
    #[cfg(windows)]
    {
        let width: usize =
            profile.bin.len() + plan.argv.iter().map(|a| a.len() + 3).sum::<usize>();
        if width > 30_000 {
            return Err(format!(
                "{} takes its prompt as an argument, and this turn is {width} characters of \
                 command line — Windows caps it near 32000. Lower the project's context budget, \
                 or set this backend's prompt delivery to stdin in settings.",
                profile.label
            ));
        }
    }

    let mut cmd = build_command(&plan, &profile, &settings, &request.cwd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn {} failed: {e}", profile.bin))?;

    let mut stdin = child.stdin.take().ok_or("no stdin on child process")?;
    let stdout = child.stdout.take().ok_or("no stdout on child process")?;
    let stderr = child.stderr.take().ok_or("no stderr on child process")?;

    // Context travels on stdin with the message when the backend allows it: it
    // changes every turn, and it can be far larger than the Windows
    // command-line limit. Closing stdin either way stops a CLI that waits on it.
    let piped = plan.stdin.clone();
    tokio::spawn(async move {
        if let Some(text) = piped {
            let _ = stdin.write_all(text.as_bytes()).await;
        }
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
            resumed: request.resume_session_id.is_some() && profile.supports.resume,
            context_tokens: request
                .context_pack
                .as_deref()
                .map(crate::context::estimate_tokens)
                .unwrap_or(0),
            provider: profile.id.clone(),
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
    let output = profile.output;
    let provider_id = profile.id.clone();

    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut transcript = String::new();
        let mut streamed = false;
        let mut cancelled = false;

        let emit = |text: String| {
            let _ = app_events.emit(
                "agent://delta",
                RunDelta {
                    run_id: run_id.clone(),
                    agent_id: agent_id.clone(),
                    channel_id: channel_id.clone(),
                    text,
                },
            );
        };

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
                            let (piece, event) = parse_line(output, &raw);

                            match piece {
                                Piece::Delta(text) => {
                                    transcript.push_str(&text);
                                    streamed = true;
                                    emit(text);
                                }
                                Piece::Echo(text) => emit(text),
                                Piece::Final(text) => {
                                    // A backend that answers in one shot never
                                    // streamed anything, so the UI still needs
                                    // to be handed the text once.
                                    if !streamed {
                                        emit(text.clone());
                                        streamed = true;
                                    }
                                    transcript = text;
                                }
                                Piece::None => {}
                            }

                            if let Some(event) = event {
                                let _ = app_events.emit("agent://chunk", RunChunk {
                                    run_id: run_id.clone(),
                                    agent_id: agent_id.clone(),
                                    channel_id: channel_id.clone(),
                                    event,
                                });
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            emit(format!("[stdout read error] {e}"));
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
                provider: provider_id,
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
        Some(mut handle) => handle
            .cancel
            .take()
            .map(|tx| tx.send(()).is_ok())
            .unwrap_or(false),
        None => false,
    }
}

/// Run ids currently executing, paired with their agent.
#[tauri::command]
pub fn active_runs(registry: State<'_, RunRegistry>) -> Vec<(String, String)> {
    registry.active()
}

/// Report whether the default CLI is reachable, and at what version.
#[tauri::command]
pub async fn claude_doctor(app: AppHandle) -> Result<String, String> {
    let settings = providers::load(&app);
    let probe = providers::cli_doctor(app.clone(), settings.default_profile.clone()).await;
    if probe.ok {
        Ok(probe.version)
    } else {
        Err(format!("{} not runnable: {}", probe.bin, probe.error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> AgentRunRequest {
        AgentRunRequest {
            agent_name: "backend".into(),
            instructions: Some("You own src-tauri.".into()),
            context_pack: Some("## PROJECT Demo\nShip it.".into()),
            prompt: "What is 2+2?".into(),
            ..Default::default()
        }
    }

    fn profile(id: &str) -> CliProfile {
        providers::resolve(&Settings::default(), Some(id))
    }

    #[test]
    fn context_rides_on_the_user_prompt_not_the_system_prompt() {
        let req = request();
        let system = compose_system_prompt(&req);
        let user = compose_user_prompt(&req, &profile("claude"));

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
            verbose_output: true,
            ..Default::default()
        };
        // Claude carries the persona on its own flag, so nothing else is added.
        let user = compose_user_prompt(&req, &profile("claude"));
        assert_eq!(user, "hello");
    }

    #[test]
    fn verbose_agents_skip_the_brevity_contract() {
        let mut req = request();
        req.verbose_output = true;
        assert!(!compose_system_prompt(&req).contains("OUTPUT CONTRACT"));
        assert!(compose_system_prompt(&request()).contains("OUTPUT CONTRACT"));
    }

    #[test]
    fn a_backend_without_a_system_prompt_flag_folds_the_persona_into_the_prompt() {
        let req = request();
        // Codex takes no --append-system-prompt; dropping the persona there
        // would leave the agent nameless.
        let user = compose_user_prompt(&req, &profile("codex"));
        assert!(user.contains("You own src-tauri."));
        assert!(user.contains("Ship it."));
        assert!(user.ends_with("What is 2+2?"));
    }

    #[test]
    fn claude_argv_carries_the_flags_the_profile_declares() {
        let mut req = request();
        req.model = Some("opus".into());
        req.permission_mode = Some("acceptEdits".into());
        req.effort = Some("high".into());
        req.allowed_tools = vec!["Read".into(), "Edit".into()];

        let plan = build_plan(&req, &profile("claude"), "sess-1");
        let argv = plan.argv.join(" ");

        assert!(argv.contains("--output-format stream-json"));
        assert!(argv.contains("--session-id sess-1"));
        assert!(argv.contains("--model opus"));
        assert!(argv.contains("--permission-mode acceptEdits"));
        assert!(argv.contains("--effort high"));
        assert!(argv.contains("--allowed-tools Read,Edit"));
        // Long prompts must never reach argv on Windows.
        assert!(plan.stdin.is_some());
        assert!(!argv.contains("What is 2+2?"));
    }

    #[test]
    fn codex_drops_flags_it_does_not_have_and_reads_stdin() {
        let mut req = request();
        req.cwd = "/repo".into();
        req.effort = Some("max".into());
        req.permission_mode = Some("bypassPermissions".into());
        req.allowed_tools = vec!["Read".into()];

        let plan = build_plan(&req, &profile("codex"), "sess-1");
        let argv = plan.argv.join(" ");

        assert!(argv.starts_with("exec --json"));
        assert!(argv.contains("--cd /repo"));
        assert!(argv.contains("--dangerously-bypass-approvals-and-sandbox"));
        // Codex tops out at "high".
        assert!(argv.contains("model_reasoning_effort=\"high\""));
        // No tool allowlist and no session id exist there.
        assert!(!argv.contains("--allowed-tools"));
        assert!(!argv.contains("--session-id"));
        assert!(plan.argv.last().unwrap() == "-");
        assert!(plan.stdin.is_some());
    }

    #[test]
    fn a_positional_prompt_lands_last() {
        let req = request();
        let plan = build_plan(&req, &profile("opencode"), "sess-1");
        assert_eq!(plan.stdin, None);
        assert_eq!(plan.argv.first().unwrap(), "run");
        assert!(plan.argv.last().unwrap().contains("What is 2+2?"));
    }

    #[test]
    fn a_template_placeholder_with_no_value_takes_its_flag_with_it() {
        let mut kimi = profile("kimi");
        kimi.default_model = String::new();
        let plan = build_plan(&request(), &kimi, "sess-1");

        // `--model {model}` with no model must not swallow the prompt.
        assert!(!plan.argv.contains(&"--model".to_string()));
        assert_eq!(plan.argv.first().unwrap(), "--print");
        assert!(plan.argv.last().unwrap().contains("What is 2+2?"));
    }

    #[test]
    fn a_resume_id_is_ignored_by_a_backend_that_cannot_resume() {
        let mut req = request();
        req.resume_session_id = Some("old-session".into());

        let claude = build_plan(&req, &profile("claude"), "fresh").argv.join(" ");
        assert!(claude.contains("--resume old-session"));

        let codex = build_plan(&req, &profile("codex"), "fresh").argv.join(" ");
        assert!(!codex.contains("old-session"));
    }

    #[test]
    fn plain_output_streams_every_line() {
        let (piece, event) = parse_line(OutputFormat::Plain, "hello world");
        assert_eq!(piece, Piece::Delta("hello world\n".into()));
        assert!(event.is_none());
    }

    #[test]
    fn codex_events_yield_the_agent_message() {
        let nested = serde_json::json!({
            "type": "item.completed",
            "item": { "type": "agent_message", "text": "4" }
        });
        assert_eq!(parse_codex(&nested), Piece::Final("4".into()));

        let flat = serde_json::json!({
            "msg": { "type": "agent_message_delta", "delta": "4" }
        });
        assert_eq!(parse_codex(&flat), Piece::Delta("4".into()));

        let noise = serde_json::json!({ "type": "item.started" });
        assert_eq!(parse_codex(&noise), Piece::None);
    }

    #[test]
    fn claude_deltas_append_but_the_assistant_echo_does_not() {
        let delta = serde_json::json!({
            "type": "stream_event",
            "event": { "delta": { "text": "hi" } }
        });
        assert_eq!(parse_claude(&delta), Piece::Delta("hi".into()));

        let assistant = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{ "type": "text", "text": "hi" }] }
        });
        assert_eq!(parse_claude(&assistant), Piece::Echo("hi".into()));

        let result = serde_json::json!({ "type": "result", "result": "hi" });
        assert_eq!(parse_claude(&result), Piece::Final("hi".into()));
    }
}
