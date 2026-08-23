//! Reading agent definitions from `.md` files on disk.
//!
//! A project points at a folder of agent markdown files — the same shape Claude
//! Code uses for its own subagents:
//!
//! ```markdown
//! ---
//! name: backend
//! description: owns the Rust core
//! model: sonnet
//! color: "#3fbf7f"
//! tools: Read, Grep, Bash(git *)
//! ---
//! You own src-tauri. Small diffs. Never touch the UI.
//! ```
//!
//! Scanning happens in Rust rather than through the fs plugin so the folder can
//! live anywhere on the machine without widening the webview's filesystem scope.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// One agent parsed out of a markdown file.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentFile {
    /// `name:` from the frontmatter, else the file stem.
    pub name: String,
    pub description: String,
    pub model: String,
    pub color: String,
    /// `tools:` split on commas.
    pub tools: Vec<String>,
    /// Everything after the frontmatter block.
    pub instructions: String,
    pub path: String,
}

/// Split a document into (frontmatter, body).
///
/// Returns an empty frontmatter when the file does not open with `---`, so a
/// plain markdown file still yields usable instructions.
fn split_frontmatter(text: &str) -> (&str, &str) {
    let trimmed = text.trim_start_matches('\u{feff}');
    let Some(rest) = trimmed.strip_prefix("---") else {
        return ("", trimmed);
    };
    let rest = rest.trim_start_matches(['\r', '\n']);

    // The closing fence is a line that is exactly `---`.
    for (idx, line) in rest.match_indices("---") {
        let starts_line = idx == 0 || rest[..idx].ends_with('\n');
        let ends_line = rest[idx + 3..]
            .trim_start_matches('\r')
            .starts_with('\n')
            .then_some(true)
            .unwrap_or(rest.len() == idx + 3);
        if starts_line && ends_line && line == "---" {
            return (&rest[..idx], &rest[idx + 3..]);
        }
    }
    ("", trimmed)
}

/// Read one `key: value` pair per line. Quotes and list brackets are stripped.
fn frontmatter_value(frontmatter: &str, key: &str) -> String {
    for line in frontmatter.lines() {
        let Some((raw_key, raw_value)) = line.split_once(':') else {
            continue;
        };
        if raw_key.trim().eq_ignore_ascii_case(key) {
            return raw_value
                .trim()
                .trim_matches(|c| c == '"' || c == '\'' || c == '[' || c == ']')
                .trim()
                .to_string();
        }
    }
    String::new()
}

fn parse(text: &str, path: &Path) -> AgentFile {
    let (frontmatter, body) = split_frontmatter(text);

    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("agent")
        .to_string();
    let name = {
        let from_matter = frontmatter_value(frontmatter, "name");
        if from_matter.is_empty() {
            stem
        } else {
            from_matter
        }
    };

    let tools = frontmatter_value(frontmatter, "tools")
        .split(',')
        .map(|tool| tool.trim().trim_matches('"').to_string())
        .filter(|tool| !tool.is_empty())
        .collect();

    AgentFile {
        name,
        description: frontmatter_value(frontmatter, "description"),
        model: frontmatter_value(frontmatter, "model"),
        color: frontmatter_value(frontmatter, "color"),
        tools,
        instructions: body.trim().to_string(),
        path: path.to_string_lossy().to_string(),
    }
}

/// Scan a folder for `.md` agent definitions, sorted by name.
///
/// Non-recursive on purpose: an agents folder is a flat list, and recursing
/// would sweep up unrelated documentation.
#[tauri::command]
pub fn scan_agent_files(dir: String) -> Result<Vec<AgentFile>, String> {
    let path = Path::new(&dir);
    if !path.is_dir() {
        return Err(format!("not a folder: {dir}"));
    }

    let mut found = Vec::new();
    for entry in std::fs::read_dir(path).map_err(|e| format!("read {dir}: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file = entry.path();
        if !file.is_file() {
            continue;
        }
        if file.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        // A README in the agents folder is documentation, not an agent.
        if file
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|stem| stem.eq_ignore_ascii_case("readme"))
        {
            continue;
        }
        let text = std::fs::read_to_string(&file)
            .map_err(|e| format!("read {}: {e}", file.display()))?;
        found.push(parse(&text, &file));
    }

    found.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_and_body() {
        let doc = "---\nname: backend\ndescription: owns the Rust core\nmodel: sonnet\ncolor: \"#3fbf7f\"\ntools: Read, Grep\n---\nYou own src-tauri.\nSmall diffs.\n";
        let parsed = parse(doc, Path::new("C:/x/backend.md"));
        assert_eq!(parsed.name, "backend");
        assert_eq!(parsed.description, "owns the Rust core");
        assert_eq!(parsed.model, "sonnet");
        assert_eq!(parsed.color, "#3fbf7f");
        assert_eq!(parsed.tools, vec!["Read", "Grep"]);
        assert_eq!(parsed.instructions, "You own src-tauri.\nSmall diffs.");
    }

    #[test]
    fn falls_back_to_file_stem_without_frontmatter() {
        let parsed = parse("Just instructions.\n", Path::new("/tmp/reviewer.md"));
        assert_eq!(parsed.name, "reviewer");
        assert_eq!(parsed.instructions, "Just instructions.");
        assert!(parsed.tools.is_empty());
    }

    #[test]
    fn body_may_contain_horizontal_rules() {
        let doc = "---\nname: a\n---\nintro\n\n---\n\nmore\n";
        let parsed = parse(doc, Path::new("/tmp/a.md"));
        assert_eq!(parsed.name, "a");
        assert!(parsed.instructions.contains("intro"));
        assert!(parsed.instructions.contains("more"));
    }
}
