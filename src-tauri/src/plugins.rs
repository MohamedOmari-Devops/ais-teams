//! Claude Code plugin and marketplace management.
//!
//! The CLI already owns this: `claude plugin list --json --available` returns
//! both what is installed and everything installable from the configured
//! marketplaces, and install/uninstall/enable/disable are single commands. So
//! this module is a typed shell around them rather than a reimplementation —
//! plugins installed here are the same ones a plain `claude` session sees.
//!
//! Every call is bounded by a timeout: marketplace operations hit the network
//! and a hung child would otherwise wedge the panel forever.

use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

/// Plugin operations clone git repositories; the default is generous.
const CALL_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub id: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub install_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailablePlugin {
    pub plugin_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub marketplace_name: String,
    #[serde(default)]
    pub install_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marketplace {
    pub name: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub repo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalog {
    pub installed: Vec<InstalledPlugin>,
    pub available: Vec<AvailablePlugin>,
    pub marketplaces: Vec<Marketplace>,
}

fn claude_bin() -> String {
    std::env::var("AIS_CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string())
}

/// Run `claude <args>` and return stdout, or stderr on failure.
async fn claude(args: &[&str], cwd: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new(claude_bin());
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = tokio::time::timeout(CALL_TIMEOUT, cmd.output())
        .await
        .map_err(|_| format!("`claude {}` timed out", args.join(" ")))?
        .map_err(|e| format!("`claude {}` failed to start: {e}", args.join(" ")))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        return Ok(stdout);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("`claude {}` exited with {}", args.join(" "), output.status)
    } else {
        stderr
    })
}

/// JSON output can be preceded by human-readable lines; take from the first
/// structural character so a stray banner does not break parsing.
fn json_slice(text: &str) -> &str {
    match text.find(['{', '[']) {
        Some(idx) => &text[idx..],
        None => text,
    }
}

/// Everything the plugin panel needs, in one round trip.
#[tauri::command]
pub async fn plugin_catalog() -> Result<PluginCatalog, String> {
    let listing = claude(&["plugin", "list", "--json", "--available"], None).await?;
    let parsed: serde_json::Value = serde_json::from_str(json_slice(&listing))
        .map_err(|e| format!("could not parse plugin list: {e}"))?;

    // Without `--available` the CLI returns a bare array of installed plugins.
    // Tolerate that shape so a flag change degrades instead of breaking.
    let parsed = if parsed.is_array() {
        serde_json::json!({ "installed": parsed, "available": [] })
    } else {
        parsed
    };

    let installed = parsed
        .get("installed")
        .cloned()
        .map(serde_json::from_value::<Vec<InstalledPlugin>>)
        .transpose()
        .map_err(|e| format!("could not read installed plugins: {e}"))?
        .unwrap_or_default();

    let available = parsed
        .get("available")
        .cloned()
        .map(serde_json::from_value::<Vec<AvailablePlugin>>)
        .transpose()
        .map_err(|e| format!("could not read available plugins: {e}"))?
        .unwrap_or_default();

    // A missing marketplace list is not fatal: the catalog is still usable.
    let marketplaces = match claude(&["plugin", "marketplace", "list", "--json"], None).await {
        Ok(text) => serde_json::from_str(json_slice(&text)).unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    Ok(PluginCatalog {
        installed,
        available,
        marketplaces,
    })
}

/// Install `plugin@marketplace`.
///
/// `scope` is user, project or local. Project scope writes into `cwd`, which is
/// why the project's working folder is passed through.
#[tauri::command]
pub async fn plugin_install(
    plugin_id: String,
    scope: String,
    cwd: Option<String>,
) -> Result<String, String> {
    let scope = if scope.is_empty() { "user".into() } else { scope };
    claude(
        &["plugin", "install", &plugin_id, "--scope", &scope, "--yes"],
        cwd.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn plugin_uninstall(plugin_id: String, cwd: Option<String>) -> Result<String, String> {
    claude(&["plugin", "uninstall", &plugin_id], cwd.as_deref()).await
}

#[tauri::command]
pub async fn plugin_set_enabled(
    plugin_id: String,
    enabled: bool,
    cwd: Option<String>,
) -> Result<String, String> {
    let verb = if enabled { "enable" } else { "disable" };
    claude(&["plugin", verb, &plugin_id], cwd.as_deref()).await
}

#[tauri::command]
pub async fn plugin_update(plugin_id: String, cwd: Option<String>) -> Result<String, String> {
    claude(&["plugin", "update", &plugin_id], cwd.as_deref()).await
}

/// Add a marketplace by GitHub repo (`owner/name`), URL, or local path.
#[tauri::command]
pub async fn marketplace_add(source: String) -> Result<String, String> {
    claude(&["plugin", "marketplace", "add", &source], None).await
}

#[tauri::command]
pub async fn marketplace_remove(name: String) -> Result<String, String> {
    claude(&["plugin", "marketplace", "remove", &name], None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_slice_skips_leading_noise() {
        assert_eq!(json_slice("Checking...\n{\"a\":1}"), "{\"a\":1}");
        assert_eq!(json_slice("[1,2]"), "[1,2]");
        assert_eq!(json_slice("no json here"), "no json here");
    }

    #[test]
    fn available_plugins_parse_from_cli_shape() {
        let raw = r#"[{
            "pluginId": "agentforce-adlc@claude-plugins-official",
            "name": "agentforce-adlc",
            "description": "author, discover, scaffold",
            "marketplaceName": "claude-plugins-official",
            "source": {"source": "url", "url": "https://example.invalid/x.git"},
            "installCount": 1307
        }]"#;
        let parsed: Vec<AvailablePlugin> = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed[0].name, "agentforce-adlc");
        assert_eq!(parsed[0].install_count, 1307);
        assert_eq!(parsed[0].marketplace_name, "claude-plugins-official");
    }

    #[test]
    fn installed_plugins_tolerate_extra_fields() {
        let raw = r#"[{
            "id": "caveman@caveman",
            "version": "25d22f8",
            "scope": "user",
            "enabled": true,
            "installPath": "C:\\x",
            "installedAt": "2026-06-16T17:56:39.178Z",
            "mcpServers": {"firebase": {"command": "npx"}}
        }]"#;
        let parsed: Vec<InstalledPlugin> = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed[0].id, "caveman@caveman");
        assert!(parsed[0].enabled);
    }
}
