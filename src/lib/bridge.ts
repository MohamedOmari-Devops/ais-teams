// Thin wrapper over the Rust commands in src-tauri/src.
//
// Everything degrades gracefully when the UI is opened in a plain browser or
// on a phone: `canRunAgents` goes false and the caller falls back to queueing
// the run in PocketBase for a desktop host to pick up.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentFile,
  AgentRunRequest,
  ContextPack,
  HostInfo,
  PluginCatalog,
} from "./types";

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface RunStarted {
  runId: string;
  agentId: string;
  channelId: string;
  sessionId: string;
  resumed: boolean;
  contextTokens: number;
}

export interface RunDelta {
  runId: string;
  agentId: string;
  channelId: string;
  text: string;
}

export interface RunChunk {
  runId: string;
  agentId: string;
  channelId: string;
  event: Record<string, unknown>;
}

export interface RunEnded {
  runId: string;
  agentId: string;
  channelId: string;
  sessionId: string;
  exitCode: number;
  cancelled: boolean;
  text: string;
  stderr: string;
}

export async function hostInfo(): Promise<HostInfo> {
  if (!isTauri()) {
    return { hostname: "browser", platform: "web", canRunAgents: false };
  }
  return invoke<HostInfo>("host_info");
}

export async function claudeDoctor(): Promise<string> {
  if (!isTauri()) return "";
  try {
    return await invoke<string>("claude_doctor");
  } catch (err) {
    return `unavailable: ${String(err)}`;
  }
}

/** Caveman-compress text. Falls back to the identity outside Tauri. */
export async function compressText(text: string): Promise<string> {
  if (!isTauri()) return text;
  return invoke<string>("compress_text", { text });
}

export async function estimateTokens(text: string): Promise<number> {
  if (!isTauri()) return Math.ceil(text.length / 4);
  return invoke<number>("estimate_tokens", { text });
}

export async function buildContextPack(
  chunks: Array<{
    id: string;
    kind: string;
    lane: string;
    text: string;
    weight: number;
    created: string;
  }>,
  budgetTokens: number,
): Promise<ContextPack> {
  if (!isTauri()) {
    // Browser fallback: newest-first concatenation under the same budget.
    const lines: string[] = [];
    let used = 0;
    let dropped = 0;
    for (const chunk of chunks) {
      const line = `[${chunk.lane}|${chunk.kind}] ${chunk.text}`;
      const cost = Math.ceil(line.length / 4);
      if (used + cost > budgetTokens) {
        dropped += 1;
        continue;
      }
      used += cost;
      lines.push(line);
    }
    const text = lines.length
      ? `## PROJECT CONTEXT (compressed)\n${lines.join("\n")}`
      : "";
    return {
      text,
      estimated_tokens: Math.ceil(text.length / 4),
      included: lines.length,
      dropped,
    };
  }
  return invoke<ContextPack>("build_context_pack", { chunks, budgetTokens });
}

export async function defaultContextBudget(): Promise<number> {
  if (!isTauri()) return 3000;
  return invoke<number>("default_context_budget");
}

export async function runAgent(request: AgentRunRequest): Promise<string> {
  return invoke<string>("run_agent", { request });
}

export async function cancelAgentRun(runId: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("cancel_agent_run", { runId });
}

export async function onRunStart(cb: (e: RunStarted) => void): Promise<UnlistenFn> {
  return listen<RunStarted>("agent://start", (e) => cb(e.payload));
}

export async function onRunDelta(cb: (e: RunDelta) => void): Promise<UnlistenFn> {
  return listen<RunDelta>("agent://delta", (e) => cb(e.payload));
}

export async function onRunChunk(cb: (e: RunChunk) => void): Promise<UnlistenFn> {
  return listen<RunChunk>("agent://chunk", (e) => cb(e.payload));
}

export async function onRunEnd(cb: (e: RunEnded) => void): Promise<UnlistenFn> {
  return listen<RunEnded>("agent://end", (e) => cb(e.payload));
}

/**
 * Read `.md` agent definitions from a folder.
 *
 * Scanning runs in Rust so the folder can live anywhere without widening the
 * webview's filesystem scope.
 */
export async function scanAgentFiles(dir: string): Promise<AgentFile[]> {
  if (!isTauri()) return [];
  return invoke<AgentFile[]>("scan_agent_files", { dir });
}

/** Native folder picker. Returns "" when the dialog is dismissed. */
export async function pickFolder(title: string): Promise<string> {
  if (!isTauri()) return "";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : "";
}

// ------------------------------------------------------------------- plugins

/**
 * Installed plugins, everything installable from configured marketplaces, and
 * the marketplaces themselves.
 *
 * These are the CLI's own plugins, so anything installed here is also visible
 * to a plain `claude` session.
 */
export async function pluginCatalog(): Promise<PluginCatalog> {
  if (!isTauri()) {
    return { installed: [], available: [], marketplaces: [] };
  }
  return invoke<PluginCatalog>("plugin_catalog");
}

export const pluginInstall = (pluginId: string, scope: string, cwd?: string) =>
  invoke<string>("plugin_install", { pluginId, scope, cwd });

export const pluginUninstall = (pluginId: string, cwd?: string) =>
  invoke<string>("plugin_uninstall", { pluginId, cwd });

export const pluginSetEnabled = (pluginId: string, enabled: boolean, cwd?: string) =>
  invoke<string>("plugin_set_enabled", { pluginId, enabled, cwd });

export const pluginUpdate = (pluginId: string, cwd?: string) =>
  invoke<string>("plugin_update", { pluginId, cwd });

export const marketplaceAdd = (source: string) =>
  invoke<string>("marketplace_add", { source });

export const marketplaceRemove = (name: string) =>
  invoke<string>("marketplace_remove", { name });

// ------------------------------------------------------------------ terminal

export interface PtyOpenRequest {
  sessionId: string;
  cwd: string;
  args?: string[];
  program?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export const ptyOpen = (request: PtyOpenRequest) =>
  invoke<string>("pty_open", { request });

export const ptyWrite = (sessionId: string, data: string) =>
  invoke<void>("pty_write", { sessionId, data });

export const ptyResize = (sessionId: string, cols: number, rows: number) =>
  invoke<void>("pty_resize", { sessionId, cols, rows });

export const ptyClose = (sessionId: string) =>
  invoke<boolean>("pty_close", { sessionId });

export async function onPtyData(
  cb: (e: { sessionId: string; data: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ sessionId: string; data: string }>("pty://data", (e) =>
    cb(e.payload),
  );
}

export async function onPtyExit(
  cb: (e: { sessionId: string; code: number }) => void,
): Promise<UnlistenFn> {
  return listen<{ sessionId: string; code: number }>("pty://exit", (e) =>
    cb(e.payload),
  );
}
