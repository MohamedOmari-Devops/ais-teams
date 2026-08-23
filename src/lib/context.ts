// The memory layer.
//
// Cost control rests on three rules:
//   1. Nothing is stored raw — every chunk is compressed before it is written.
//   2. Context is split into lanes; an agent reads its own lanes, never the
//      whole project history.
//   3. A run gets a token budget, and chunks compete for it by weight then
//      recency. What does not fit is dropped, not silently truncated.

import { pb } from "./pb";
import { buildContextPack, compressText, estimateTokens } from "./bridge";
import type { Agent, Channel, ChunkKind, ContextChunk, Project } from "./types";

/** Weights decide who survives a tight budget. */
export const WEIGHTS: Record<ChunkKind, number> = {
  decision: 0.9,
  goal: 0.85,
  summary: 0.7,
  file: 0.5,
  note: 0.45,
  message: 0.3,
};

/** Hard cap on rows pulled per lane before budgeting. */
const MAX_ROWS = 200;

export function lanesFor(agent: Agent, channel: Channel): string[] {
  const lanes = new Set<string>([channel.lane]);
  for (const lane of agent.lanes ?? []) lanes.add(lane);
  return [...lanes].filter(Boolean);
}

/**
 * Assemble the compressed context block for one agent turn.
 *
 * Only the lanes the agent is entitled to are queried, so a 40-channel project
 * still sends a few KB per turn.
 */
export async function packFor(
  project: Project,
  channel: Channel,
  agent: Agent,
): Promise<{ text: string; tokens: number; included: number; dropped: number }> {
  const lanes = lanesFor(agent, channel);
  const laneFilter = lanes
    .map((lane) => `lane = ${JSON.stringify(lane)}`)
    .join(" || ");

  const rows = await pb.collection("context_chunks").getList<ContextChunk>(1, MAX_ROWS, {
    filter: `project = "${project.id}" && (${laneFilter})`,
    sort: "-pinned,-weight,-created",
  });

  const budget =
    agent.context_budget || project.context_budget || 3000;

  const pack = await buildContextPack(
    rows.items.map((row) => ({
      id: row.id,
      kind: row.kind,
      lane: row.lane,
      text: row.text,
      weight: row.pinned ? 1 : row.weight || WEIGHTS[row.kind] || 0.3,
      created: row.created,
    })),
    budget,
  );

  return {
    text: pack.text,
    tokens: pack.estimated_tokens,
    included: pack.included,
    dropped: pack.dropped,
  };
}

/** Compress and store one piece of durable project memory. */
export async function remember(params: {
  projectId: string;
  lane: string;
  kind: ChunkKind;
  text: string;
  sourceMessageId?: string;
  agentId?: string;
  pinned?: boolean;
  weight?: number;
}): Promise<ContextChunk | null> {
  const text = (await compressText(params.text)).trim();
  if (!text) return null;

  return pb.collection("context_chunks").create<ContextChunk>({
    project: params.projectId,
    lane: params.lane,
    kind: params.kind,
    text: text.slice(0, 20000),
    weight: params.weight ?? WEIGHTS[params.kind] ?? 0.3,
    tokens: await estimateTokens(text),
    source_message: params.sourceMessageId ?? "",
    agent: params.agentId ?? "",
    pinned: params.pinned ?? false,
  });
}

/**
 * Pull the `FACTS:` block an agent emits at the end of a turn.
 *
 * Returns the reply with the block stripped plus the harvested facts, so the
 * transcript stays clean while the facts become durable context.
 */
export function harvestFacts(reply: string): { body: string; facts: string[] } {
  // The marker may stand alone or carry the first fact on the same line.
  const match = reply.match(/^[ \t]*FACTS:[ \t]*(.*)$/im);
  if (!match || match.index === undefined) return { body: reply, facts: [] };

  const body = reply.slice(0, match.index).trimEnd();
  const tail = [match[1], reply.slice(match.index + match[0].length)].join("\n");

  const facts = tail
    .split("\n")
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    // "none" is the agent saying the turn produced nothing worth storing.
    .filter((line) => line.length > 3 && !/^(none|n\/a|nothing)\.?$/i.test(line))
    .slice(0, 5);

  return { body, facts };
}

/**
 * Fold a channel's oldest raw messages into one summary chunk.
 *
 * Run this when a lane grows past a few hundred chunks: it collapses chatter
 * into a single high-weight summary and deletes the originals, which is what
 * keeps long-running projects from getting slowly more expensive.
 */
export async function compactLane(
  projectId: string,
  lane: string,
  keepNewest = 60,
): Promise<{ folded: number } | null> {
  const rows = await pb.collection("context_chunks").getFullList<ContextChunk>({
    filter: `project = "${projectId}" && lane = ${JSON.stringify(lane)} && kind = "message" && pinned = false`,
    sort: "-created",
  });
  const stale = rows.slice(keepNewest);
  if (stale.length < 20) return null;

  const merged = stale
    .map((row) => row.text)
    .reverse()
    .join("\n");

  await remember({
    projectId,
    lane,
    kind: "summary",
    text: merged.slice(0, 20000),
    weight: 0.7,
  });

  for (const row of stale) {
    await pb.collection("context_chunks").delete(row.id);
  }
  return { folded: stale.length };
}
