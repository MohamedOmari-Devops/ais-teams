// Shapes mirroring the PocketBase collections in
// pocketbase/pb_migrations/1756000000_init_schema.js

export interface Base {
  id: string;
  created: string;
  updated: string;
  collectionId?: string;
  collectionName?: string;
}

export interface Project extends Base {
  name: string;
  slug: string;
  description: string;
  /** Absolute path on the desktop machine; used as cwd for every agent run. */
  root_path: string;
  owner: string;
  members: string[];
  default_model: string;
  context_budget: number;
  archived: boolean;
  /** Standing brief prepended to every agent turn in this project. */
  instructions: string;
  /** Folder of agent `.md` definitions the settings panel can import. */
  agents_dir: string;
  /** Accent colour for the project chip. */
  color: string;
  /** CLI backend for this project's agents. Empty inherits the machine default. */
  cli_profile: string;
}

export type PermissionMode =
  | "manual"
  | "acceptEdits"
  | "auto"
  | "plan"
  | "bypassPermissions";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Agent extends Base {
  project: string;
  name: string;
  role: string;
  avatar_color: string;
  instructions: string;
  model: string;
  effort: Effort | "";
  permission_mode: PermissionMode | "";
  allowed_tools: string[];
  disallowed_tools: string[];
  add_dirs: string[];
  /** Extra context lanes this agent may read beyond the channel's own lane. */
  lanes: string[];
  context_budget: number;
  bare: boolean;
  verbose_output: boolean;
  /** Enable the Claude in Chrome integration for this agent's turns. */
  chrome: boolean;
  /** CLI backend override. Empty inherits the project's, then the machine's. */
  cli_profile: string;
  enabled: boolean;
}

export interface Channel extends Base {
  project: string;
  name: string;
  topic: string;
  /** The context lane this channel reads from and writes to. */
  lane: string;
  kind: "chat" | "standup" | "review" | "terminal";
  agents: string[];
  archived: boolean;
}

export interface Message extends Base {
  project: string;
  channel: string;
  author_type: "user" | "agent" | "system";
  author_user: string;
  author_agent: string;
  body: string;
  compressed: string;
  status: "pending" | "streaming" | "done" | "error" | "cancelled";
  run_id: string;
  claude_session_id: string;
  context_tokens: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  error: string;
}

export type ChunkKind =
  | "message"
  | "decision"
  | "goal"
  | "summary"
  | "file"
  | "note";

export interface ContextChunk extends Base {
  project: string;
  lane: string;
  kind: ChunkKind;
  text: string;
  weight: number;
  tokens: number;
  source_message: string;
  agent: string;
  pinned: boolean;
}

export interface Goal extends Base {
  project: string;
  lane: string;
  title: string;
  detail: string;
  status: "open" | "in_progress" | "done" | "dropped";
  owner_agent: string;
  achieved_at: string;
}

export interface AgentSession extends Base {
  project: string;
  agent: string;
  channel: string;
  claude_session_id: string;
  /** Persona fingerprint the session was created with. */
  persona_hash: string;
  turns: number;
  last_used: string;
}

export interface Device extends Base {
  user: string;
  name: string;
  platform: string;
  is_runner: boolean;
  last_seen: string;
}

export interface Run extends Base {
  project: string;
  channel: string;
  agent: string;
  message: string;
  run_id: string;
  prompt: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  claimed_by: string;
  context_tokens: number;
  exit_code: number;
  error: string;
  started: string;
  ended: string;
}

/** Payload handed to the Rust `run_agent` command. */
export interface AgentRunRequest {
  runId: string;
  agentId: string;
  agentName: string;
  channelId: string;
  cwd: string;
  prompt: string;
  /** CLI profile id. Omitted uses the machine's default profile. */
  provider?: string;
  instructions?: string;
  contextPack?: string;
  systemPrompt?: string;
  model?: string;
  resumeSessionId?: string;
  permissionMode?: string;
  effort?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  addDirs?: string[];
  bare?: boolean;
  verboseOutput?: boolean;
  chrome?: boolean;
}

export interface ContextPack {
  text: string;
  estimated_tokens: number;
  included: number;
  dropped: number;
}

/** One agent definition parsed out of a markdown file on disk. */
export interface AgentFile {
  name: string;
  description: string;
  model: string;
  color: string;
  tools: string[];
  instructions: string;
  path: string;
}

export interface InstalledPlugin {
  id: string;
  version: string;
  scope: string;
  enabled: boolean;
  installPath?: string | null;
}

export interface AvailablePlugin {
  pluginId: string;
  name: string;
  description: string;
  marketplaceName: string;
  installCount: number;
}

export interface Marketplace {
  name: string;
  source: string;
  repo?: string | null;
}

export interface PluginCatalog {
  installed: InstalledPlugin[];
  available: AvailablePlugin[];
  marketplaces: Marketplace[];
}

export interface HostInfo {
  hostname: string;
  platform: string;
  canRunAgents: boolean;
}

// ------------------------------------------------------------ CLI backends

export type ArgvKind = "claude" | "codex" | "openCode" | "template";
export type OutputFormat = "claudeStreamJson" | "codexJsonl" | "plain";
export type PromptVia = "stdin" | "arg";

/** What a backend understands, so the runner can drop flags it would reject. */
export interface CliSupports {
  resume: boolean;
  systemPrompt: boolean;
  permissionMode: boolean;
  effort: boolean;
  tools: boolean;
  addDirs: boolean;
}

/** One agent CLI backend, as described in global settings. */
export interface CliProfile {
  id: string;
  label: string;
  description: string;
  /** Executable name or absolute path. */
  bin: string;
  argv: ArgvKind;
  /**
   * Literal argv for `argv: "template"`. Placeholders: `{prompt}`, `{model}`,
   * `{cwd}`, `{system}`, `{session}`.
   */
  template: string[];
  extraArgs: string[];
  promptVia: PromptVia;
  output: OutputFormat;
  defaultModel: string;
  /** Child environment; values may reference vault keys as `{anthropic}`. */
  env: Record<string, string>;
  /** Vault entries this profile needs, for the "key missing" hint. */
  keyRefs: string[];
  supports: CliSupports;
  builtin: boolean;
  enabled: boolean;
}

/** Machine-local settings. API keys never reach PocketBase. */
export interface GlobalSettings {
  defaultProfile: string;
  keys: Record<string, string>;
  profiles: CliProfile[];
  /** Where the settings file lives on this machine. */
  path: string;
}

export interface CliProbe {
  id: string;
  bin: string;
  ok: boolean;
  version: string;
  error: string;
  missingKeys: string[];
}
