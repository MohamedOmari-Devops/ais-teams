// The turn engine.
//
// One user message can fan out to several agents. Each agent turn is:
//
//   pack context (lanes + budget)  ->  spawn `claude -p`  ->  stream deltas
//   ->  persist reply  ->  harvest FACTS into durable context
//
// Two entry points exist because two kinds of client exist. A desktop host has
// the Claude Code CLI and runs turns locally. A phone has no CLI, so it writes
// a `runs` row with status "queued"; `startQueueWorker` on the desktop claims
// it and executes it. Both paths write identical `messages` rows, so the
// conversation looks the same everywhere.

import { pb, currentUserId } from "./pb";
import {
  cancelAgentRun,
  compressText,
  isTauri,
  onRunDelta,
  onRunEnd,
  onRunStart,
  runAgent,
} from "./bridge";
import { harvestFacts, packFor, remember } from "./context";
import { useApp } from "../store";
import type {
  Agent,
  AgentSession,
  Channel,
  Message,
  Project,
  Run,
} from "./types";

/** How often a streaming reply is flushed to PocketBase, in ms. */
const FLUSH_INTERVAL = 900;

const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `run_${Date.now()}_${Math.random().toString(16).slice(2)}`;

/**
 * Stable-ish name for this device, used as the `runs.claimed_by` lock.
 *
 * A run executed locally is stamped with this at creation time, so this host's
 * own queue worker does not turn around and claim its own row.
 */
export const localHostName = () =>
  `${navigator.platform || "host"}-${currentUserId()}`;

/** True when this device can spawn Claude Code itself. */
const canRunLocally = () => isTauri() && useApp.getState().hostCanRun;

/**
 * Prefix the context pack with what this channel is for.
 *
 * The channel description is the cheapest steering available: a couple of lines
 * that scope the turn without touching any agent's persona.
 */
function channelBrief(channel: Channel, pack: string): string {
  const header = [`## CHANNEL #${channel.name} (lane: ${channel.lane})`];
  if (channel.topic?.trim()) header.push(channel.topic.trim());
  return [header.join("\n"), pack].filter(Boolean).join("\n\n");
}

// ------------------------------------------------------------- run bookkeeping

interface LiveRun {
  messageId: string;
  projectId: string;
  channelId: string;
  agentId: string;
  lane: string;
  runRecordId: string;
  buffer: string;
  flushTimer: ReturnType<typeof setInterval> | null;
  lastFlushed: string;
}

const live = new Map<string, LiveRun>();
let listenersReady = false;

/**
 * Attach the Rust event listeners exactly once.
 *
 * Deltas are buffered and flushed on a timer: writing every token to
 * PocketBase would be one HTTP request per token.
 */
export async function initRunListeners() {
  if (listenersReady || !isTauri()) return;
  listenersReady = true;

  await onRunStart((event) => {
    const run = live.get(event.runId);
    if (!run) return;

    useApp.getState().startDraft({
      runId: event.runId,
      agentId: event.agentId,
      channelId: event.channelId,
      messageId: run.messageId,
      text: "",
      startedAt: Date.now(),
      contextTokens: event.contextTokens,
    });

    void pb.collection("runs").update(run.runRecordId, {
      status: "running",
      started: new Date().toISOString(),
      context_tokens: event.contextTokens,
    });

    run.flushTimer = setInterval(() => void flush(event.runId), FLUSH_INTERVAL);
  });

  await onRunDelta((event) => {
    const run = live.get(event.runId);
    if (!run) return;
    run.buffer += event.text;
    useApp.getState().appendDraft(event.runId, event.text);
  });

  await onRunEnd((event) => {
    void finish(event.runId, {
      text: event.text,
      exitCode: event.exitCode,
      cancelled: event.cancelled,
      stderr: event.stderr,
      sessionId: event.sessionId,
    });
  });
}

async function flush(runId: string) {
  const run = live.get(runId);
  if (!run || run.buffer === run.lastFlushed) return;
  run.lastFlushed = run.buffer;
  try {
    await pb.collection("messages").update(run.messageId, {
      body: run.buffer,
      status: "streaming",
    });
  } catch {
    // A dropped flush is harmless — the final write carries the whole reply.
  }
}

async function finish(
  runId: string,
  result: {
    text: string;
    exitCode: number;
    cancelled: boolean;
    stderr: string;
    sessionId: string;
  },
) {
  const run = live.get(runId);
  if (!run) return;
  if (run.flushTimer) clearInterval(run.flushTimer);
  live.delete(runId);
  useApp.getState().endDraft(runId);

  const raw = result.text || run.buffer;
  const { body, facts } = harvestFacts(raw);
  const failed = result.exitCode !== 0 && !result.cancelled;

  const status: Message["status"] = result.cancelled
    ? "cancelled"
    : failed
      ? "error"
      : "done";

  await pb.collection("messages").update(run.messageId, {
    body: body || (failed ? "" : raw),
    compressed: body ? await compressText(body) : "",
    status,
    claude_session_id: result.sessionId,
    error: failed ? result.stderr.slice(0, 5000) : "",
  });

  await pb.collection("runs").update(run.runRecordId, {
    status: result.cancelled ? "cancelled" : failed ? "error" : "done",
    exit_code: result.exitCode,
    error: failed ? result.stderr.slice(0, 5000) : "",
    ended: new Date().toISOString(),
  });

  if (status !== "done") return;

  // The reply itself becomes low-weight context; the FACTS block becomes
  // high-weight context. This split is what keeps future packs small.
  await remember({
    projectId: run.projectId,
    lane: run.lane,
    kind: "message",
    text: body,
    sourceMessageId: run.messageId,
    agentId: run.agentId,
  });

  for (const fact of facts) {
    await remember({
      projectId: run.projectId,
      lane: run.lane,
      kind: "decision",
      text: fact,
      sourceMessageId: run.messageId,
      agentId: run.agentId,
      weight: 0.9,
    });
  }

  await rememberSession(run, result.sessionId);
}

async function rememberSession(run: LiveRun, sessionId: string) {
  if (!sessionId) return;
  const filter = `agent = "${run.agentId}" && channel = "${run.channelId}"`;
  try {
    const existing = await pb
      .collection("agent_sessions")
      .getFirstListItem<AgentSession>(filter);
    await pb.collection("agent_sessions").update(existing.id, {
      claude_session_id: sessionId,
      turns: (existing.turns ?? 0) + 1,
      last_used: new Date().toISOString(),
    });
  } catch {
    await pb.collection("agent_sessions").create({
      project: run.projectId,
      agent: run.agentId,
      channel: run.channelId,
      claude_session_id: sessionId,
      turns: 1,
      last_used: new Date().toISOString(),
    });
  }
}

async function resumeIdFor(agentId: string, channelId: string): Promise<string> {
  try {
    const row = await pb
      .collection("agent_sessions")
      .getFirstListItem<AgentSession>(
        `agent = "${agentId}" && channel = "${channelId}"`,
      );
    return row.claude_session_id ?? "";
  } catch {
    return "";
  }
}

// --------------------------------------------------------------- public API

/** Post a human message and remember it as low-weight context. */
export async function postUserMessage(
  project: Project,
  channel: Channel,
  text: string,
): Promise<Message> {
  const compressed = await compressText(text);
  const message = await pb.collection("messages").create<Message>({
    project: project.id,
    channel: channel.id,
    author_type: "user",
    author_user: currentUserId(),
    body: text,
    compressed,
    status: "done",
  });

  await remember({
    projectId: project.id,
    lane: channel.lane,
    kind: "message",
    text,
    sourceMessageId: message.id,
  });

  return message;
}

/**
 * Run one agent turn.
 *
 * On a machine with the CLI this spawns Claude Code immediately. Elsewhere the
 * run is left queued in PocketBase and a desktop host picks it up.
 */
export async function dispatchTurn(
  project: Project,
  channel: Channel,
  agent: Agent,
  prompt: string,
): Promise<string> {
  const runId = newId();
  const pack = await packFor(project, channel, agent);
  const local = canRunLocally();
  const brief = channelBrief(channel, pack.text);

  const placeholder = await pb.collection("messages").create<Message>({
    project: project.id,
    channel: channel.id,
    author_type: "agent",
    author_agent: agent.id,
    body: "",
    status: "pending",
    run_id: runId,
    context_tokens: pack.tokens,
  });

  // A run this device is about to execute is created already claimed. Creating
  // it as "queued" would make this host's own queue worker claim it and spawn a
  // second process for the same runId.
  const runRecord = await pb.collection("runs").create<Run>({
    project: project.id,
    channel: channel.id,
    agent: agent.id,
    message: placeholder.id,
    run_id: runId,
    prompt,
    status: local ? "running" : "queued",
    claimed_by: local ? localHostName() : "",
    started: local ? new Date().toISOString() : "",
    context_tokens: pack.tokens,
  });

  if (!local) {
    // No local CLI: leave it queued for a desktop host.
    return runId;
  }

  live.set(runId, {
    messageId: placeholder.id,
    projectId: project.id,
    channelId: channel.id,
    agentId: agent.id,
    lane: channel.lane,
    runRecordId: runRecord.id,
    buffer: "",
    flushTimer: null,
    lastFlushed: "",
  });

  try {
    await runAgent({
      runId,
      agentId: agent.id,
      agentName: agent.name,
      channelId: channel.id,
      cwd: project.root_path || ".",
      prompt,
      instructions: agent.instructions,
      contextPack: brief,
      model: agent.model || project.default_model || undefined,
      resumeSessionId: (await resumeIdFor(agent.id, channel.id)) || undefined,
      permissionMode: agent.permission_mode || undefined,
      effort: agent.effort || undefined,
      allowedTools: agent.allowed_tools ?? [],
      disallowedTools: agent.disallowed_tools ?? [],
      addDirs: agent.add_dirs ?? [],
      bare: agent.bare ?? false,
      verboseOutput: agent.verbose_output ?? false,
    });
  } catch (err) {
    live.delete(runId);
    await pb.collection("messages").update(placeholder.id, {
      status: "error",
      error: String(err).slice(0, 5000),
    });
    await pb.collection("runs").update(runRecord.id, {
      status: "error",
      error: String(err).slice(0, 5000),
      ended: new Date().toISOString(),
    });
    throw err;
  }

  return runId;
}

/** Send one message and let every agent on the channel answer it. */
export async function broadcast(
  project: Project,
  channel: Channel,
  agents: Agent[],
  text: string,
): Promise<void> {
  await postUserMessage(project, channel, text);
  const targets = pickTargets(agents, channel, text);
  for (const agent of targets) {
    await dispatchTurn(project, channel, agent, text);
  }
}

/**
 * Decide who answers.
 *
 * `@name` mentions win. Otherwise every enabled agent on the channel replies —
 * which is exactly why per-agent lanes and budgets matter.
 */
export function pickTargets(
  agents: Agent[],
  channel: Channel,
  text: string,
): Agent[] {
  const onChannel = agents.filter(
    (agent) => agent.enabled !== false && channel.agents?.includes(agent.id),
  );
  const mentioned = onChannel.filter((agent) =>
    new RegExp(`(^|\\s)@${escapeRegex(agent.name)}\\b`, "i").test(text),
  );
  return mentioned.length ? mentioned : onChannel;
}

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function cancelRun(runId: string) {
  await cancelAgentRun(runId);
  const run = live.get(runId);
  if (run) {
    await pb.collection("messages").update(run.messageId, { status: "cancelled" });
  }
}

// ------------------------------------------------------------- queue worker

/**
 * Claim and execute runs queued by other devices (phones).
 *
 * Claiming is a compare-and-set on `claimed_by`: two hosts racing for the same
 * row means one update lands and the loser re-reads a row that is no longer
 * queued.
 */
export function startQueueWorker(): () => void {
  if (!isTauri()) return () => {};

  const hostName = localHostName();
  let stopped = false;

  const claim = async (run: Run) => {
    if (stopped || run.status !== "queued" || run.claimed_by) return;
    // Never touch a run this device is already executing.
    if (live.has(run.run_id)) return;
    try {
      await pb.collection("runs").update(run.id, {
        status: "running",
        claimed_by: hostName,
        started: new Date().toISOString(),
      });
    } catch {
      return; // Someone else won the race.
    }

    const project = await pb.collection("projects").getOne<Project>(run.project);
    const channel = await pb.collection("channels").getOne<Channel>(run.channel);
    const agent = await pb.collection("agents").getOne<Agent>(run.agent);

    live.set(run.run_id, {
      messageId: run.message,
      projectId: project.id,
      channelId: channel.id,
      agentId: agent.id,
      lane: channel.lane,
      runRecordId: run.id,
      buffer: "",
      flushTimer: null,
      lastFlushed: "",
    });

    const pack = await packFor(project, channel, agent);
    await runAgent({
      runId: run.run_id,
      agentId: agent.id,
      agentName: agent.name,
      channelId: channel.id,
      cwd: project.root_path || ".",
      prompt: run.prompt,
      instructions: agent.instructions,
      contextPack: channelBrief(channel, pack.text),
      model: agent.model || project.default_model || undefined,
      resumeSessionId: (await resumeIdFor(agent.id, channel.id)) || undefined,
      permissionMode: agent.permission_mode || undefined,
      effort: agent.effort || undefined,
      allowedTools: agent.allowed_tools ?? [],
      disallowedTools: agent.disallowed_tools ?? [],
      addDirs: agent.add_dirs ?? [],
      bare: agent.bare ?? false,
      verboseOutput: agent.verbose_output ?? false,
    });
  };

  // Drain whatever was queued while this host was offline, then follow live.
  void pb
    .collection("runs")
    .getFullList<Run>({ filter: 'status = "queued"' })
    .then((rows) => rows.forEach((row) => void claim(row)))
    .catch(() => {});

  void pb.collection("runs").subscribe<Run>("*", (event) => {
    if (event.action === "create") void claim(event.record);
  });

  return () => {
    stopped = true;
    void pb.collection("runs").unsubscribe("*");
  };
}
