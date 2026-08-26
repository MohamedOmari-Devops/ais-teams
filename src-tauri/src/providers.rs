//! CLI backends and the API keys they need.
//!
//! Claude Code is one agent CLI among several. Codex, OpenCode and Kimi all
//! run the same shape of turn — a prompt in, a stream of text out — so an
//! agent is no more tied to Anthropic than it is to a single model name.
//!
//! A profile is the whole description of one backend: which binary to spawn,
//! how to lay out argv, how to read the output, and which key from the vault
//! to hand it. Five ship built in; the settings panel may override any field
//! on them, or add a fully custom profile with a literal argv template.
//!
//! Keys never reach PocketBase. They live in one JSON file in the app config
//! dir, on the machine that actually spawns the processes, and are injected as
//! environment variables on the child — never as argv, which is readable by
//! every other process on the box.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// How argv is laid out for a backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArgvKind {
    /// `claude -p --output-format stream-json ...`
    Claude,
    /// `codex exec --json ...`
    Codex,
    /// `opencode run --model provider/model <prompt>`
    OpenCode,
    /// Literal argv with `{placeholder}` substitution.
    Template,
}

/// How the backend's stdout is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutputFormat {
    /// Claude Code NDJSON: `stream_event` deltas plus a final `result`.
    ClaudeStreamJson,
    /// Codex `--json` event lines.
    CodexJsonl,
    /// Anything else: stdout is the answer, line by line.
    Plain,
}

/// Where the prompt goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptVia {
    /// Piped on stdin. Preferred: prompts routinely exceed the Windows
    /// command-line limit once a context pack is attached.
    Stdin,
    /// Appended as the last positional argument.
    Arg,
}

/// What a backend understands, so the runner can drop flags it would reject.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Supports {
    /// Can continue a previous session by id.
    #[serde(default)]
    pub resume: bool,
    /// Takes a system prompt as a flag. When false the persona is folded into
    /// the user prompt instead of being dropped.
    #[serde(default)]
    pub system_prompt: bool,
    #[serde(default)]
    pub permission_mode: bool,
    #[serde(default)]
    pub effort: bool,
    #[serde(default)]
    pub tools: bool,
    #[serde(default)]
    pub add_dirs: bool,
}

/// One agent CLI backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliProfile {
    pub id: String,
    pub label: String,
    /// One line explaining what this backend is, shown in settings.
    #[serde(default)]
    pub description: String,
    /// Executable name or absolute path.
    pub bin: String,
    pub argv: ArgvKind,
    /// Literal argv for `ArgvKind::Template`. Placeholders: `{prompt}`,
    /// `{model}`, `{cwd}`, `{system}`, `{session}`. An argument whose
    /// placeholder resolves to empty is dropped whole.
    #[serde(default)]
    pub template: Vec<String>,
    /// Appended to every invocation, after the generated flags.
    #[serde(default)]
    pub extra_args: Vec<String>,
    pub prompt_via: PromptVia,
    pub output: OutputFormat,
    /// Model used when neither the agent nor the project names one.
    #[serde(default)]
    pub default_model: String,
    /// Environment handed to the child. Values may reference vault entries as
    /// `{anthropic}`, `{openai}`, `{moonshot}`, … A variable whose key is
    /// missing or blank is omitted, so a CLI signed in interactively keeps
    /// using its own credentials.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Vault entries this profile needs, for the "key missing" hint in the UI.
    #[serde(default)]
    pub key_refs: Vec<String>,
    #[serde(default)]
    pub supports: Supports,
    /// False for user-defined profiles.
    #[serde(default)]
    pub builtin: bool,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

/// Machine-local settings: the key vault plus profile overrides.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Profile used when neither the agent nor the project picks one.
    #[serde(default = "default_profile_id")]
    pub default_profile: String,
    /// API keys by vault name. Never leaves this machine.
    #[serde(default)]
    pub keys: BTreeMap<String, String>,
    /// Full profiles that shadow a builtin of the same id, plus custom ones.
    #[serde(default)]
    pub profiles: Vec<CliProfile>,
}

fn default_profile_id() -> String {
    "claude".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            default_profile: default_profile_id(),
            keys: BTreeMap::new(),
            profiles: Vec::new(),
        }
    }
}

/// Vault names the built-in profiles read.
pub const KEY_ANTHROPIC: &str = "anthropic";
pub const KEY_OPENAI: &str = "openai";
pub const KEY_MOONSHOT: &str = "moonshot";

fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn claude_default_bin() -> String {
    std::env::var("AIS_CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string())
}

/// The backends that ship with the app.
///
/// Anything here can be overridden field by field in settings, which is the
/// escape hatch for a CLI that moves a flag between releases: point `bin` at
/// your own build, or edit `extraArgs`, without waiting for a new version.
pub fn builtins() -> Vec<CliProfile> {
    vec![
        CliProfile {
            id: "claude".into(),
            label: "Claude Code".into(),
            description:
                "Anthropic's CLI. Streams partial messages, resumes sessions, honours permission modes."
                    .into(),
            bin: claude_default_bin(),
            argv: ArgvKind::Claude,
            template: vec![],
            extra_args: vec![],
            prompt_via: PromptVia::Stdin,
            output: OutputFormat::ClaudeStreamJson,
            default_model: String::new(),
            // A blank key means "use whatever the CLI is already signed in
            // with", which is the common case for a Claude subscription.
            env: env(&[("ANTHROPIC_API_KEY", "{anthropic}")]),
            key_refs: vec![KEY_ANTHROPIC.into()],
            supports: Supports {
                resume: true,
                system_prompt: true,
                permission_mode: true,
                effort: true,
                tools: true,
                add_dirs: true,
            },
            builtin: true,
            enabled: true,
        },
        CliProfile {
            id: "codex".into(),
            label: "Codex CLI (ChatGPT)".into(),
            description:
                "OpenAI's CLI, run as `codex exec --json`. Uses an OpenAI API key, or the ChatGPT sign-in the CLI already holds."
                    .into(),
            bin: "codex".into(),
            argv: ArgvKind::Codex,
            template: vec![],
            extra_args: vec![],
            prompt_via: PromptVia::Stdin,
            output: OutputFormat::CodexJsonl,
            default_model: "gpt-5-codex".into(),
            env: env(&[("OPENAI_API_KEY", "{openai}")]),
            key_refs: vec![KEY_OPENAI.into()],
            supports: Supports {
                resume: false,
                system_prompt: false,
                permission_mode: true,
                effort: true,
                tools: false,
                add_dirs: false,
            },
            builtin: true,
            enabled: true,
        },
        CliProfile {
            id: "opencode".into(),
            label: "OpenCode".into(),
            description:
                "Multi-provider CLI. Model is `provider/model`, e.g. `anthropic/claude-sonnet-4-5` or `moonshotai/kimi-k2`."
                    .into(),
            bin: "opencode".into(),
            argv: ArgvKind::OpenCode,
            template: vec![],
            extra_args: vec![],
            prompt_via: PromptVia::Arg,
            output: OutputFormat::Plain,
            default_model: String::new(),
            // OpenCode picks its provider from the model id, so every key it
            // might need is offered; blank ones are dropped before spawn.
            env: env(&[
                ("ANTHROPIC_API_KEY", "{anthropic}"),
                ("OPENAI_API_KEY", "{openai}"),
                ("MOONSHOT_API_KEY", "{moonshot}"),
            ]),
            key_refs: vec![
                KEY_ANTHROPIC.into(),
                KEY_OPENAI.into(),
                KEY_MOONSHOT.into(),
            ],
            supports: Supports::default(),
            builtin: true,
            enabled: true,
        },
        CliProfile {
            id: "kimi".into(),
            label: "Kimi CLI (Moonshot)".into(),
            description:
                "Moonshot's standalone CLI. Argv is a template — edit it in settings if your build names the non-interactive flag differently."
                    .into(),
            bin: "kimi".into(),
            argv: ArgvKind::Template,
            template: vec![
                "--print".into(),
                "--model".into(),
                "{model}".into(),
                "{prompt}".into(),
            ],
            extra_args: vec![],
            prompt_via: PromptVia::Arg,
            output: OutputFormat::Plain,
            default_model: "kimi-k2-turbo-preview".into(),
            env: env(&[
                ("MOONSHOT_API_KEY", "{moonshot}"),
                ("KIMI_API_KEY", "{moonshot}"),
            ]),
            key_refs: vec![KEY_MOONSHOT.into()],
            supports: Supports::default(),
            builtin: true,
            enabled: true,
        },
        CliProfile {
            id: "kimi-claude".into(),
            label: "Kimi via Claude Code".into(),
            description:
                "Claude Code pointed at Moonshot's Anthropic-compatible endpoint. Full streaming and session resume, billed to a Moonshot key."
                    .into(),
            bin: claude_default_bin(),
            argv: ArgvKind::Claude,
            template: vec![],
            extra_args: vec![],
            prompt_via: PromptVia::Stdin,
            output: OutputFormat::ClaudeStreamJson,
            default_model: "kimi-k2-turbo-preview".into(),
            env: env(&[
                ("ANTHROPIC_BASE_URL", "https://api.moonshot.ai/anthropic"),
                ("ANTHROPIC_AUTH_TOKEN", "{moonshot}"),
                // The base URL alone is not enough: an Anthropic key already in
                // the ambient environment would take precedence and be sent to
                // Moonshot.
                ("ANTHROPIC_API_KEY", "{moonshot}"),
            ]),
            key_refs: vec![KEY_MOONSHOT.into()],
            supports: Supports {
                resume: true,
                system_prompt: true,
                permission_mode: true,
                effort: false,
                tools: true,
                add_dirs: true,
            },
            builtin: true,
            enabled: true,
        },
    ]
}

/// Builtins with user overrides applied, followed by custom profiles.
///
/// Order is stable so the settings list does not reshuffle on every save.
pub fn merged(settings: &Settings) -> Vec<CliProfile> {
    let mut out: Vec<CliProfile> = builtins()
        .into_iter()
        .map(|builtin| {
            settings
                .profiles
                .iter()
                .find(|p| p.id == builtin.id)
                .cloned()
                // An override is stored whole, but the id stays marked builtin
                // so the UI still offers "reset to default".
                .map(|mut p| {
                    p.builtin = true;
                    p
                })
                .unwrap_or(builtin)
        })
        .collect();

    let known: Vec<String> = out.iter().map(|p| p.id.clone()).collect();
    out.extend(
        settings
            .profiles
            .iter()
            .filter(|p| !known.contains(&p.id))
            .cloned()
            .map(|mut p| {
                p.builtin = false;
                p
            }),
    );
    out
}

/// The profile for `id`, falling back to the configured default and then to
/// Claude Code, so a run never fails just because a profile was deleted.
pub fn resolve(settings: &Settings, id: Option<&str>) -> CliProfile {
    let profiles = merged(settings);
    let wanted = id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(settings.default_profile.as_str());

    profiles
        .iter()
        .find(|p| p.id == wanted)
        .or_else(|| profiles.iter().find(|p| p.id == settings.default_profile))
        .or_else(|| profiles.iter().find(|p| p.id == "claude"))
        .cloned()
        .unwrap_or_else(|| builtins().remove(0))
}

/// Expand `{vault_name}` references in a profile's env against the vault.
///
/// A variable is omitted when any key it references is missing or blank: an
/// empty `ANTHROPIC_API_KEY` in the child's environment is worse than none at
/// all, because it shadows the CLI's own stored credentials.
pub fn resolved_env(profile: &CliProfile, settings: &Settings) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (name, template) in &profile.env {
        if let Some(value) = expand(template, &settings.keys) {
            if !value.is_empty() {
                out.push((name.clone(), value));
            }
        }
    }
    out
}

/// Substitute `{name}` from `values`. Returns `None` if any reference is
/// missing or blank.
fn expand(template: &str, values: &BTreeMap<String, String>) -> Option<String> {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;

    while let Some(start) = rest.find('{') {
        let Some(len) = rest[start + 1..].find('}') else {
            break;
        };
        let name = &rest[start + 1..start + 1 + len];
        let value = values.get(name).map(String::as_str).unwrap_or("");
        if value.trim().is_empty() {
            return None;
        }
        out.push_str(&rest[..start]);
        out.push_str(value.trim());
        rest = &rest[start + len + 2..];
    }

    out.push_str(rest);
    Some(out)
}

// ------------------------------------------------------------------ storage

fn settings_path(app: &AppHandle) -> PathBuf {
    if let Ok(explicit) = std::env::var("AIS_SETTINGS_PATH") {
        if !explicit.trim().is_empty() {
            return PathBuf::from(explicit);
        }
    }
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("settings.json")
}

pub fn load(app: &AppHandle) -> Settings {
    std::fs::read_to_string(settings_path(app))
        .ok()
        .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
        .unwrap_or_default()
}

fn store(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("{}: {e}", path.display()))?;

    // The file holds API keys; keep it off other accounts on this machine.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

// ----------------------------------------------------------------- commands

/// Everything the settings panel edits, plus the merged profile list so the UI
/// never has to know the builtins.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub default_profile: String,
    pub keys: BTreeMap<String, String>,
    pub profiles: Vec<CliProfile>,
    /// Where the file lives, so the panel can say it out loud.
    pub path: String,
}

fn view(app: &AppHandle, settings: &Settings) -> SettingsView {
    SettingsView {
        default_profile: settings.default_profile.clone(),
        keys: settings.keys.clone(),
        profiles: merged(settings),
        path: settings_path(app).display().to_string(),
    }
}

#[tauri::command]
pub fn read_settings(app: AppHandle) -> SettingsView {
    let settings = load(&app);
    view(&app, &settings)
}

/// Persist the vault and the profile list.
///
/// A profile identical to its builtin is dropped rather than stored, so the
/// file stays small and a builtin that improves in a later version is not
/// frozen by an override nobody meant to make.
#[tauri::command]
pub fn write_settings(
    app: AppHandle,
    default_profile: String,
    keys: BTreeMap<String, String>,
    profiles: Vec<CliProfile>,
) -> Result<SettingsView, String> {
    let stock = builtins();
    let overrides: Vec<CliProfile> = profiles
        .into_iter()
        .filter(|p| match stock.iter().find(|b| b.id == p.id) {
            Some(builtin) => !same(builtin, p),
            None => true,
        })
        .collect();

    let settings = Settings {
        default_profile: if default_profile.trim().is_empty() {
            default_profile_id()
        } else {
            default_profile
        },
        keys: keys
            .into_iter()
            .map(|(k, v)| (k, v.trim().to_string()))
            .filter(|(_, v)| !v.is_empty())
            .collect(),
        profiles: overrides,
    };

    store(&app, &settings)?;
    Ok(view(&app, &settings))
}

/// Structural equality, ignoring the flag the UI never edits.
fn same(a: &CliProfile, b: &CliProfile) -> bool {
    let normalise = |p: &CliProfile| {
        serde_json::to_value(CliProfile {
            builtin: true,
            ..p.clone()
        })
        .ok()
    };
    normalise(a) == normalise(b)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub id: String,
    pub bin: String,
    pub ok: bool,
    pub version: String,
    pub error: String,
    /// Vault entries this profile wants that are still blank.
    pub missing_keys: Vec<String>,
}

/// Check whether a backend is actually runnable on this machine.
#[tauri::command]
pub async fn cli_doctor(app: AppHandle, profile_id: String) -> ProbeResult {
    let settings = load(&app);
    let profile = resolve(&settings, Some(&profile_id));

    let missing_keys: Vec<String> = profile
        .key_refs
        .iter()
        .filter(|name| {
            settings
                .keys
                .get(*name)
                .map(|v| v.trim().is_empty())
                .unwrap_or(true)
        })
        .cloned()
        .collect();

    let mut cmd = tokio::process::Command::new(&profile.bin);
    cmd.arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let probe = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output()).await;

    match probe {
        Ok(Ok(output)) => {
            let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            ProbeResult {
                id: profile.id,
                bin: profile.bin,
                ok: output.status.success(),
                // Some CLIs print their version on stderr and still exit 0.
                version: if out.is_empty() { err.clone() } else { out },
                error: if output.status.success() {
                    String::new()
                } else {
                    err
                },
                missing_keys,
            }
        }
        Ok(Err(e)) => ProbeResult {
            id: profile.id,
            error: format!("{} is not on PATH: {e}", profile.bin),
            bin: profile.bin,
            ok: false,
            version: String::new(),
            missing_keys,
        },
        Err(_) => ProbeResult {
            id: profile.id,
            bin: profile.bin,
            ok: false,
            version: String::new(),
            error: "`--version` timed out".into(),
            missing_keys,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn blank_keys_drop_the_variable_instead_of_emptying_it() {
        let settings = Settings {
            keys: vault(&[("anthropic", "  ")]),
            ..Settings::default()
        };
        let claude = resolve(&settings, Some("claude"));
        // An empty ANTHROPIC_API_KEY would shadow the CLI's own login.
        assert!(resolved_env(&claude, &settings).is_empty());
    }

    #[test]
    fn keys_expand_into_env() {
        let settings = Settings {
            keys: vault(&[("moonshot", "sk-moon")]),
            ..Settings::default()
        };
        let kimi = resolve(&settings, Some("kimi-claude"));
        let env = resolved_env(&kimi, &settings);
        assert!(env.contains(&("ANTHROPIC_AUTH_TOKEN".into(), "sk-moon".into())));
        // Literals with no placeholder survive untouched.
        assert!(env.contains(&(
            "ANTHROPIC_BASE_URL".into(),
            "https://api.moonshot.ai/anthropic".into()
        )));
    }

    #[test]
    fn unknown_profile_falls_back_to_the_default() {
        let settings = Settings {
            default_profile: "codex".into(),
            ..Settings::default()
        };
        assert_eq!(resolve(&settings, Some("deleted")).id, "codex");
        assert_eq!(resolve(&settings, None).id, "codex");
    }

    #[test]
    fn an_override_shadows_its_builtin_without_duplicating_it() {
        let mut custom = builtins().into_iter().find(|p| p.id == "codex").unwrap();
        custom.bin = "/opt/codex/bin/codex".into();
        let settings = Settings {
            profiles: vec![custom],
            ..Settings::default()
        };

        let all = merged(&settings);
        assert_eq!(all.iter().filter(|p| p.id == "codex").count(), 1);
        assert_eq!(resolve(&settings, Some("codex")).bin, "/opt/codex/bin/codex");
        assert!(resolve(&settings, Some("codex")).builtin);
    }

    #[test]
    fn custom_profiles_are_appended_after_the_builtins() {
        let settings = Settings {
            profiles: vec![CliProfile {
                id: "my-cli".into(),
                label: "My CLI".into(),
                description: String::new(),
                bin: "mycli".into(),
                argv: ArgvKind::Template,
                template: vec!["{prompt}".into()],
                extra_args: vec![],
                prompt_via: PromptVia::Arg,
                output: OutputFormat::Plain,
                default_model: String::new(),
                env: BTreeMap::new(),
                key_refs: vec![],
                supports: Supports::default(),
                builtin: false,
                enabled: true,
            }],
            ..Settings::default()
        };

        let all = merged(&settings);
        assert_eq!(all.len(), builtins().len() + 1);
        assert_eq!(all.last().unwrap().id, "my-cli");
    }
}
