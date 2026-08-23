//! Token-frugal context handling.
//!
//! Every byte handed to Claude Code costs money, so the app never ships raw
//! transcripts. Messages are compressed ("caveman" style: drop filler, keep
//! every technical token) and then packed into a fixed budget, highest value
//! first.
//!
//! The compressor is deliberately lossless for anything that carries meaning:
//! fenced code blocks, inline code, paths, identifiers and numbers are copied
//! verbatim. Only English glue words are dropped.

use serde::{Deserialize, Serialize};

/// Default cap on the injected context block, in tokens. Keeps argv small on
/// Windows and keeps per-turn cost predictable.
pub const DEFAULT_CONTEXT_BUDGET: usize = 3000;

/// Rough tokens-per-character ratio for English + code. Good enough for
/// budgeting; exact counts are never needed, only a safe upper bound.
const CHARS_PER_TOKEN: usize = 4;

/// Words that carry no technical signal and are dropped by the compressor.
const FILLER: &[&str] = &[
    "a", "an", "the", "just", "really", "very", "quite", "basically", "actually", "simply",
    "please", "kindly", "maybe", "perhaps", "somewhat", "essentially", "literally", "obviously",
    "definitely", "certainly", "sure", "well", "so", "then", "that", "which", "there", "here",
    "some", "any", "of", "to", "for", "with", "and", "or", "but", "is", "are", "was", "were",
    "be", "been", "being", "do", "does", "did", "have", "has", "had", "will", "would", "should",
    "could", "can", "may", "might", "i", "we", "you", "it", "this", "these", "those",
];

/// Multi-word phrases collapsed before word-level filtering.
const PHRASES: &[(&str, &str)] = &[
    ("in order to", "to"),
    ("due to the fact that", "because"),
    ("at this point in time", "now"),
    ("it is important to note that", ""),
    ("please note that", ""),
    ("as you can see", ""),
    ("i would like to", ""),
    ("make sure that", "ensure"),
    ("a lot of", "many"),
    ("in the event that", "if"),
    ("is able to", "can"),
    ("has the ability to", "can"),
];

/// Characters that mark a word as code-ish, therefore never filler.
const CODE_MARKERS: [char; 10] = ['`', '/', '\\', '.', '_', ':', '(', '#', '@', '$'];

/// One unit of stored context: a compressed message, decision or summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextChunk {
    pub id: String,
    /// `message` | `decision` | `goal` | `summary` | `file` | `note`
    pub kind: String,
    /// Free-form lane, e.g. `auth`, `billing`, `infra`. Lanes are how a project
    /// is split so an agent only loads the slice it needs.
    pub lane: String,
    pub text: String,
    /// 0.0..1.0 — pinned decisions rank above chatter.
    pub weight: f32,
    /// RFC3339. Newer chunks win ties.
    pub created: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextPack {
    pub text: String,
    pub estimated_tokens: usize,
    pub included: usize,
    pub dropped: usize,
}

/// Estimated token count for `text`.
pub fn estimate_tokens(text: &str) -> usize {
    text.len().div_ceil(CHARS_PER_TOKEN)
}

/// Compress prose while leaving fenced code untouched.
pub fn compress(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_code = false;

    for (idx, segment) in text.split("```").enumerate() {
        if idx > 0 {
            out.push_str("```");
        }
        if in_code {
            out.push_str(segment);
        } else {
            out.push_str(&compress_prose(segment));
        }
        in_code = !in_code;
    }
    out
}

fn compress_prose(text: &str) -> String {
    let mut work = text.to_string();

    // Phrase collapse is case-insensitive but keeps the replacement casing.
    let lower = work.to_lowercase();
    for (from, to) in PHRASES {
        if lower.contains(from) {
            work = replace_ignore_case(&work, from, to);
        }
    }

    work.lines()
        .map(compress_line)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn compress_line(line: &str) -> String {
    // Preserve leading whitespace: lists and indented blocks depend on it.
    let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
    let body = line.trim();
    if body.is_empty() {
        return String::new();
    }

    let kept: Vec<&str> = body
        .split_whitespace()
        .filter(|word| !is_filler(word))
        .collect();

    // Never empty a line completely — that would lose a bullet or heading.
    if kept.is_empty() {
        return format!("{indent}{body}");
    }
    format!("{indent}{}", kept.join(" "))
}

fn is_filler(word: &str) -> bool {
    // Anything with code-ish characters is signal, keep it.
    if word.chars().any(|c| CODE_MARKERS.contains(&c)) {
        return false;
    }
    let stripped: String = word
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    if stripped.is_empty() {
        return false;
    }
    FILLER.contains(&stripped.as_str())
}

fn replace_ignore_case(haystack: &str, needle: &str, replacement: &str) -> String {
    let lower_hay = haystack.to_lowercase();
    let mut out = String::with_capacity(haystack.len());
    let mut cursor = 0;

    while let Some(found) = lower_hay[cursor..].find(needle) {
        let start = cursor + found;
        out.push_str(&haystack[cursor..start]);
        out.push_str(replacement);
        cursor = start + needle.len();
    }
    out.push_str(&haystack[cursor..]);
    out
}

/// Build the context block injected into an agent run.
///
/// Chunks are ranked by `weight` then recency, compressed, and appended until
/// `budget_tokens` is exhausted. Anything that does not fit is reported as
/// `dropped` so the UI can show how hard context was trimmed.
pub fn build_pack(mut chunks: Vec<ContextChunk>, budget_tokens: usize) -> ContextPack {
    chunks.sort_by(|a, b| {
        b.weight
            .partial_cmp(&a.weight)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.created.cmp(&a.created))
    });

    let mut lines: Vec<String> = Vec::new();
    let mut used = 0usize;
    let mut included = 0usize;
    let mut dropped = 0usize;

    for chunk in &chunks {
        let compressed = compress(&chunk.text);
        if compressed.is_empty() {
            continue;
        }
        let line = format!("[{}|{}] {}", chunk.lane, chunk.kind, compressed);
        let cost = estimate_tokens(&line);
        if used + cost > budget_tokens {
            dropped += 1;
            continue;
        }
        used += cost;
        included += 1;
        lines.push(line);
    }

    let text = if lines.is_empty() {
        String::new()
    } else {
        format!("## PROJECT CONTEXT (compressed)\n{}", lines.join("\n"))
    };

    ContextPack {
        estimated_tokens: estimate_tokens(&text),
        text,
        included,
        dropped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_code_blocks_verbatim() {
        let input = "This is the thing.\n```rs\nlet a = the_value;\n```\n";
        let out = compress(input);
        assert!(out.contains("let a = the_value;"));
        assert!(!out.contains("This is the thing"));
    }

    #[test]
    fn keeps_paths_and_identifiers() {
        let out = compress("Update the file at src/lib.rs for the handler");
        assert!(out.contains("src/lib.rs"));
        assert!(out.contains("handler"));
    }

    #[test]
    fn budget_drops_overflow() {
        let chunks: Vec<ContextChunk> = (0..50)
            .map(|i| ContextChunk {
                id: i.to_string(),
                kind: "message".into(),
                lane: "auth".into(),
                text: "a fairly long message about the authentication flow".repeat(4),
                weight: 0.5,
                created: format!("2026-01-{:02}T00:00:00Z", i % 28 + 1),
            })
            .collect();
        let pack = build_pack(chunks, 200);
        assert!(pack.estimated_tokens <= 260);
        assert!(pack.dropped > 0);
    }
}
