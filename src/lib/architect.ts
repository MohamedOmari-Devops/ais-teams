// The master agent.
//
// One agent per project whose job is not to write code but to stand up the
// team that will: it interviews the user about the goal (stack, style, scope),
// then emits a plan — agents with missions, channels with lanes, goals — which
// the app applies to PocketBase in one go.
//
// It is a real `agents` row talking in a real `channels` row, hidden from the
// sidebar. That is deliberate: it gets the whole existing engine for free —
// streamed turns, a resumable Claude session per channel, and a context lane —
// which is what makes "open it again next week and it still knows everything"
// true without a second memory system.
//
// Applying a plan is always additive. Agents and channels are matched by name
// and updated in place; nothing is ever deleted, so re-running the architect to
// change one mission cannot wipe a team.

import { pb } from "./pb";
import { remember } from "./context";
import { dispatchTurn, postUserMessage } from "./orchestrator";
import type {
  Agent,
  Channel,
  ContextChunk,
  Goal,
  Message,
  Project,
} from "./types";

export const ARCHITECT_NAME = "Architect";
/** Marks the row as the master agent, whatever it ends up being named. */
export const ARCHITECT_ROLE = "master";
export const ARCHITECT_LANE = "architect";
export const ARCHITECT_CHANNEL = "architect";

/** Bumped when the persona below changes, so existing rows get upgraded. */
const PERSONA_VERSION = "v1";

export const isArchitectAgent = (agent: Agent) =>
  agent.role === ARCHITECT_ROLE || agent.name === ARCHITECT_NAME;

export const isArchitectChannel = (channel: Channel) =>
  channel.lane === ARCHITECT_LANE || channel.name === ARCHITECT_CHANNEL;

// --------------------------------------------------------------- the persona

/**
 * The master agent's standing instructions.
 *
 * Two rules carry the whole design: ask before assuming, and put the machine
 * readable part in one fenced block so the app can act on it while the human
 * still reads prose.
 */
const PERSONA = `You are the Architect: the master agent of this workspace. (persona ${PERSONA_VERSION})

You do not build the product yourself. You turn a rough goal — "a website for X",
"a mobile app that does Y" — into a working team: named agents with real missions,
channels wired to context lanes, and a set-up environment.

HOW YOU WORK

1. INTERVIEW FIRST. On a new goal, ask the user what you genuinely cannot infer:
   stack and language, visual style / design direction, scope and must-have
   features, deployment target, and where the code should live on disk. Ask at
   most 5 questions in one turn, numbered, each one line. Never ask something the
   TEAM STATE block or the user's own words already answer.
2. PROPOSE WHEN READY. Once the answers are enough to act on, write a short plan
   in prose (a few lines), then one fenced block tagged ais-plan holding the JSON
   below. Exactly one such block per message, and only when you mean it — the app
   shows the user an Apply button for it.
3. AMEND ON REQUEST. Later turns may edit the team: emit a new ais-plan block
   containing only what changes. Applying is additive and matched by name, so
   re-sending an agent with a new mission rewrites that agent and leaves the rest
   alone. Say so plainly rather than pretending a rebuild happened.
4. SET UP THE ENVIRONMENT. When the user asks you to scaffold, you have tools and
   your working directory is the project root: create the repo skeleton, config
   files and folders yourself, then report what you made. Never invent a path
   outside the project root.

PLAN FORMAT

\`\`\`ais-plan
{
  "summary": "one line on what this team is for",
  "project": {
    "description": "what the project is",
    "instructions": "standing brief every agent in the project receives",
    "default_model": "sonnet"
  },
  "agents": [
    {
      "name": "Frontend",
      "role": "UI and design system",
      "mission": "Full standing instructions for this agent: what it owns, what it must not touch, the stack it works in, the conventions it follows.",
      "model": "sonnet",
      "effort": "medium",
      "permission_mode": "acceptEdits",
      "avatar_color": "#7c5cff",
      "lanes": ["design"]
    }
  ],
  "channels": [
    {
      "name": "frontend",
      "topic": "what gets discussed here",
      "lane": "frontend",
      "kind": "chat",
      "agents": ["Frontend"]
    }
  ],
  "goals": [
    { "title": "Ship the landing page", "detail": "acceptance criteria", "lane": "frontend", "owner_agent": "Frontend" }
  ],
  "setup": { "commands": ["npm create vite@latest . -- --template react-ts"], "notes": "run order and anything manual" }
}
\`\`\`

CONSTRAINTS
- model: fable | opus | sonnet | haiku. effort: low | medium | high | xhigh | max.
- permission_mode: manual | acceptEdits | auto | plan | bypassPermissions.
- channel kind: chat | standup | review | terminal. lane: lowercase, dashes.
- Agent names are unique per project and are how channels reference them.
- 3-6 agents for a normal product. Every agent gets a mission specific enough
  that it could start work from that text alone; no filler personas.
- Each agent's own channel should exist, plus one shared channel for cross-team
  decisions. Keep lanes narrow — a lane is what an agent reads every turn.`;

// ---------------------------------------------------------------- bootstrap

/**
 * The architect agent and its channel for this project, created on first use.
 *
 * Both are looked up by name, so a project that already has them keeps its
 * transcript and its resumable session across app restarts.
 */
export async function ensureArchitect(
  project: Project,
): Promise<{ agent: Agent; channel: Channel }> {
  const agent = await ensureAgent(project);
  const channel = await ensureChannel(project, agent);
  return { agent, channel };
}

async function ensureAgent(project: Project): Promise<Agent> {
  const defaults = {
    project: project.id,
    name: ARCHITECT_NAME,
    role: ARCHITECT_ROLE,
    instructions: PERSONA,
    model: "opus",
    effort: "high",
    permission_mode: "acceptEdits",
    avatar_color: "#c86ee0",
    lanes: [ARCHITECT_LANE],
    allowed_tools: [],
    disallowed_tools: [],
    add_dirs: [],
    context_budget: 6000,
    bare: false,
    // The house brevity contract caps replies at 12 lines and demands a FACTS
    // block; an interview plus a JSON plan needs neither.
    verbose_output: true,
    chrome: false,
    enabled: true,
  };

  try {
    const found = await pb
      .collection("agents")
      .getFirstListItem<Agent>(
        `project = "${project.id}" && name = "${ARCHITECT_NAME}"`,
      );

    // Upgrade an older persona in place. This changes the persona hash, which
    // makes the next turn start a fresh Claude session — the only way an edited
    // system prompt actually reaches the model.
    if (!found.instructions?.includes(`persona ${PERSONA_VERSION}`)) {
      return pb.collection("agents").update<Agent>(found.id, {
        instructions: PERSONA,
        role: ARCHITECT_ROLE,
        verbose_output: true,
      });
    }
    return found;
  } catch {
    return pb.collection("agents").create<Agent>(defaults);
  }
}

async function ensureChannel(project: Project, agent: Agent): Promise<Channel> {
  try {
    const found = await pb
      .collection("channels")
      .getFirstListItem<Channel>(
        `project = "${project.id}" && name = "${ARCHITECT_CHANNEL}"`,
      );
    if (!found.agents?.includes(agent.id)) {
      return pb.collection("channels").update<Channel>(found.id, {
        agents: [...(found.agents ?? []), agent.id],
      });
    }
    return found;
  } catch {
    return pb.collection("channels").create<Channel>({
      project: project.id,
      name: ARCHITECT_CHANNEL,
      topic: "Master agent: goals in, teams out.",
      lane: ARCHITECT_LANE,
      kind: "chat",
      agents: [agent.id],
    });
  }
}

// ------------------------------------------------------------------- talking

/**
 * What the team looks like right now, as the architect sees it.
 *
 * The Claude session already remembers the conversation, but it cannot see
 * edits made elsewhere in the app — someone renaming an agent in the sidebar,
 * or a plan applied on another device. Sending the live roster every turn is
 * what stops the architect from planning against a stale picture.
 */
export function teamState(
  project: Project,
  agents: Agent[],
  channels: Channel[],
): string {
  const lines = [`## TEAM STATE (live, ${new Date().toISOString().slice(0, 10)})`];
  lines.push(`project: ${project.name}`);
  lines.push(`root_path: ${project.root_path || "(not set)"}`);
  lines.push(`default_model: ${project.default_model || "(project default)"}`);

  const team = agents.filter((a) => !isArchitectAgent(a));
  lines.push(team.length ? "agents:" : "agents: (none yet)");
  for (const agent of team) {
    const mission = (agent.instructions || "").replace(/\s+/g, " ").trim();
    lines.push(
      `- ${agent.name}${agent.role ? ` (${agent.role})` : ""} [${agent.model || "default"}]` +
        (mission ? ` — ${mission.slice(0, 200)}` : ""),
    );
  }

  const rooms = channels.filter((c) => !isArchitectChannel(c));
  lines.push(rooms.length ? "channels:" : "channels: (none yet)");
  const nameOf = new Map(agents.map((a) => [a.id, a.name]));
  for (const channel of rooms) {
    const members = (channel.agents ?? [])
      .map((id) => nameOf.get(id) ?? "?")
      .join(", ");
    lines.push(
      `- #${channel.name} (lane: ${channel.lane}) — ${channel.topic || "no topic"}` +
        (members ? ` — members: ${members}` : " — members: none"),
    );
  }

  return lines.join("\n");
}

/**
 * Post the user's message and start the architect's turn.
 *
 * The transcript keeps the human's words verbatim; the model gets those words
 * plus the live roster, so what is read back later is what was actually said.
 */
export async function askArchitect(params: {
  project: Project;
  channel: Channel;
  agent: Agent;
  agents: Agent[];
  channels: Channel[];
  text: string;
}): Promise<string> {
  const { project, channel, agent, agents, channels, text } = params;
  await postUserMessage(project, channel, text);
  const prompt = `${teamState(project, agents, channels)}\n\n---\n\n${text}`;
  return dispatchTurn(project, channel, agent, prompt);
}

// ---------------------------------------------------------------- the plan

export interface PlanAgent {
  name: string;
  role?: string;
  mission?: string;
  /** Accepted as an alias for `mission`, since that is what the row is called. */
  instructions?: string;
  model?: string;
  effort?: string;
  permission_mode?: string;
  avatar_color?: string;
  lanes?: string[];
  allowed_tools?: string[];
  disallowed_tools?: string[];
  add_dirs?: string[];
  context_budget?: number;
}

export interface PlanChannel {
  name: string;
  topic?: string;
  lane?: string;
  kind?: string;
  agents?: string[];
}

export interface PlanGoal {
  title: string;
  detail?: string;
  lane?: string;
  owner_agent?: string;
}

export interface ArchitectPlan {
  summary?: string;
  project?: {
    description?: string;
    instructions?: string;
    default_model?: string;
    root_path?: string;
  };
  agents?: PlanAgent[];
  channels?: PlanChannel[];
  goals?: PlanGoal[];
  setup?: { commands?: string[]; notes?: string };
}

const PLAN_FENCE = /```(?:ais-plan|json)?\s*\n([\s\S]*?)```/gi;

/**
 * Pull the plan out of a reply.
 *
 * Later blocks win: when a turn shows a draft and then a corrected version, the
 * corrected one is the plan.
 */
export function parsePlan(reply: string): ArchitectPlan | null {
  let found: ArchitectPlan | null = null;
  for (const match of reply.matchAll(PLAN_FENCE)) {
    const body = match[1].trim();
    if (!body.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(body) as ArchitectPlan;
      // A bare JSON block that is not a plan (a config sample, say) must not
      // arm the Apply button.
      if (parsed.agents || parsed.channels || parsed.goals || parsed.project) {
        found = parsed;
      }
    } catch {
      // Half-streamed or hand-mangled JSON: ignore, the next turn can resend.
    }
  }
  return found;
}

/** The reply with the plan block removed, for display. */
export function stripPlan(reply: string): string {
  return reply.replace(PLAN_FENCE, "").replace(/\n{3,}/g, "\n\n").trim();
}

// -------------------------------------------------------------- applying it

const MODELS = ["fable", "opus", "sonnet", "haiku"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODES = ["manual", "acceptEdits", "auto", "plan", "bypassPermissions"];
const KINDS = ["chat", "standup", "review", "terminal"];

const pick = (value: unknown, allowed: string[], fallback: string) =>
  typeof value === "string" && allowed.includes(value) ? value : fallback;

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export const laneSlug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "general";

export interface ApplyResult {
  agentsCreated: string[];
  agentsUpdated: string[];
  channelsCreated: string[];
  channelsUpdated: string[];
  goals: number;
  project: boolean;
}

/**
 * Write a plan into the project.
 *
 * Everything is an upsert keyed on name. The one thing deliberately guarded is
 * `root_path`: the architect may propose one for an empty project, but it never
 * moves a project that already points at a checkout.
 */
export async function applyPlan(
  project: Project,
  plan: ArchitectPlan,
): Promise<ApplyResult> {
  const result: ApplyResult = {
    agentsCreated: [],
    agentsUpdated: [],
    channelsCreated: [],
    channelsUpdated: [],
    goals: 0,
    project: false,
  };

  // ---- project brief
  const patch: Record<string, string> = {};
  const wanted = plan.project ?? {};
  if (wanted.description?.trim()) patch.description = wanted.description.trim();
  if (wanted.instructions?.trim()) patch.instructions = wanted.instructions.trim();
  if (wanted.default_model && MODELS.includes(wanted.default_model)) {
    patch.default_model = wanted.default_model;
  }
  if (wanted.root_path?.trim() && !project.root_path?.trim()) {
    patch.root_path = wanted.root_path.trim();
  }
  if (Object.keys(patch).length) {
    await pb.collection("projects").update(project.id, patch);
    result.project = true;
  }

  // ---- agents, by name
  const existingAgents = await pb.collection("agents").getFullList<Agent>({
    filter: `project = "${project.id}"`,
  });
  const byName = new Map(
    existingAgents.map((a) => [a.name.trim().toLowerCase(), a]),
  );

  for (const spec of plan.agents ?? []) {
    const name = (spec.name ?? "").trim().slice(0, 60);
    if (!name || name.toLowerCase() === ARCHITECT_NAME.toLowerCase()) continue;

    const mission = (spec.mission ?? spec.instructions ?? "").trim().slice(0, 20000);
    const payload = {
      project: project.id,
      name,
      role: (spec.role ?? "").trim().slice(0, 120),
      instructions: mission,
      model: pick(spec.model, MODELS, "sonnet"),
      effort: pick(spec.effort, EFFORTS, "medium"),
      permission_mode: pick(spec.permission_mode, MODES, "acceptEdits"),
      avatar_color: spec.avatar_color?.match(/^#[0-9a-f]{6}$/i)
        ? spec.avatar_color
        : "#7c5cff",
      lanes: list(spec.lanes).map(laneSlug),
      allowed_tools: list(spec.allowed_tools),
      disallowed_tools: list(spec.disallowed_tools),
      add_dirs: list(spec.add_dirs),
      context_budget:
        typeof spec.context_budget === "number" ? spec.context_budget : 3000,
      enabled: true,
    };

    const existing = byName.get(name.toLowerCase());
    if (existing) {
      // A mission the architect left blank is a mission it did not mean to
      // change — keep the one already on the row.
      const saved = await pb.collection("agents").update<Agent>(existing.id, {
        ...payload,
        instructions: mission || existing.instructions,
      });
      byName.set(name.toLowerCase(), saved);
      result.agentsUpdated.push(name);
    } else {
      const saved = await pb.collection("agents").create<Agent>(payload);
      byName.set(name.toLowerCase(), saved);
      result.agentsCreated.push(name);
    }
  }

  // ---- channels, by name
  const existingChannels = await pb.collection("channels").getFullList<Channel>({
    filter: `project = "${project.id}"`,
  });
  const channelByName = new Map(
    existingChannels.map((c) => [c.name.trim().toLowerCase(), c]),
  );

  for (const spec of plan.channels ?? []) {
    const name = laneSlug(spec.name ?? "").slice(0, 80);
    if (!name || name === ARCHITECT_CHANNEL) continue;

    const members = (spec.agents ?? [])
      .map((agentName) => byName.get(agentName.trim().toLowerCase())?.id)
      .filter((id): id is string => Boolean(id));

    const existing = channelByName.get(name);
    if (existing) {
      // Union, never replace: an agent added by hand in the sidebar stays.
      const merged = [...new Set([...(existing.agents ?? []), ...members])];
      await pb.collection("channels").update(existing.id, {
        topic: spec.topic?.trim() || existing.topic,
        agents: merged,
      });
      result.channelsUpdated.push(name);
    } else {
      await pb.collection("channels").create<Channel>({
        project: project.id,
        name,
        topic: (spec.topic ?? "").trim().slice(0, 500),
        lane: laneSlug(spec.lane || name),
        kind: pick(spec.kind, KINDS, "chat"),
        agents: members,
      });
      result.channelsCreated.push(name);
    }
  }

  // ---- goals
  const openGoals = await pb.collection("goals").getFullList<Goal>({
    filter: `project = "${project.id}" && status = "open"`,
  });
  const openTitles = new Set(openGoals.map((g) => g.title.trim().toLowerCase()));

  for (const spec of plan.goals ?? []) {
    const title = (spec.title ?? "").trim().slice(0, 200);
    // Re-applying an amended plan resends the goals it already created; a goal
    // that is still open does not need a twin.
    if (!title || openTitles.has(title.toLowerCase())) continue;
    openTitles.add(title.toLowerCase());
    await pb.collection("goals").create<Goal>({
      project: project.id,
      lane: spec.lane ? laneSlug(spec.lane) : "",
      title,
      detail: (spec.detail ?? "").trim().slice(0, 10000),
      status: "open",
      owner_agent: spec.owner_agent
        ? (byName.get(spec.owner_agent.trim().toLowerCase())?.id ?? "")
        : "",
    });
    result.goals += 1;
  }

  await seedMissions(project, plan, byName);
  return result;
}

/**
 * Drop each mission into the lane its agent actually reads.
 *
 * Without this an agent only learns its mission from its own system prompt;
 * with it, everyone sharing the lane knows who owns what — which is what makes
 * the team behave like a team on the first message rather than the tenth.
 */
async function seedMissions(
  project: Project,
  plan: ArchitectPlan,
  byName: Map<string, Agent>,
) {
  if (plan.summary?.trim()) {
    await pinOnce(
      project,
      ARCHITECT_LANE,
      "goal",
      "TEAM PLAN:",
      `TEAM PLAN: ${plan.summary.trim()}`,
    );
  }

  for (const spec of plan.channels ?? []) {
    const lane = laneSlug(spec.lane || spec.name || "");
    if (!lane || lane === ARCHITECT_LANE) continue;

    const missions = (spec.agents ?? [])
      .map((name) => byName.get(name.trim().toLowerCase()))
      .filter((agent): agent is Agent => Boolean(agent))
      .map((agent) => `${agent.name}: ${agent.role || "team member"}`);

    if (!missions.length && !spec.topic) continue;

    const key = `CHANNEL #${laneSlug(spec.name ?? lane)}`;
    await pinOnce(
      project,
      lane,
      "decision",
      key,
      [
        `${key} — ${spec.topic ?? ""}`.trim(),
        missions.length ? `Owners: ${missions.join(" | ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

/**
 * Pin one fact per lane, replacing the previous version of it.
 *
 * Pinned chunks always win the budget, so a plan applied five times must not
 * leave five copies of the same line crowding out everything else. The key is a
 * stable prefix; anything already pinned in this lane carrying it is the older
 * copy, and goes.
 */
async function pinOnce(
  project: Project,
  lane: string,
  kind: "goal" | "decision",
  key: string,
  text: string,
) {
  try {
    const stale = await pb.collection("context_chunks").getFullList<ContextChunk>({
      filter:
        `project = "${project.id}" && lane = ${JSON.stringify(lane)} && ` +
        `pinned = true && text ~ ${JSON.stringify(key)}`,
    });
    for (const row of stale) {
      await pb.collection("context_chunks").delete(row.id);
    }
  } catch {
    // A failed sweep is not worth losing the new pin over.
  }

  await remember({
    projectId: project.id,
    lane,
    kind,
    text,
    pinned: true,
    weight: 1,
  });
}

/** Record what was applied in the architect's own transcript. */
export async function noteApplied(
  project: Project,
  channel: Channel,
  result: ApplyResult,
): Promise<Message> {
  const parts = [
    result.agentsCreated.length ? `agents created: ${result.agentsCreated.join(", ")}` : "",
    result.agentsUpdated.length ? `agents updated: ${result.agentsUpdated.join(", ")}` : "",
    result.channelsCreated.length
      ? `channels created: ${result.channelsCreated.map((c) => `#${c}`).join(", ")}`
      : "",
    result.channelsUpdated.length
      ? `channels updated: ${result.channelsUpdated.map((c) => `#${c}`).join(", ")}`
      : "",
    result.goals ? `goals: ${result.goals}` : "",
    result.project ? "project brief updated" : "",
  ].filter(Boolean);

  const body = parts.length ? `Plan applied — ${parts.join("; ")}.` : "Plan applied — nothing to change.";

  const message = await pb.collection("messages").create<Message>({
    project: project.id,
    channel: channel.id,
    author_type: "system",
    body,
    status: "done",
  });

  // The architect must know on its next turn what it already built, even if the
  // Claude session is gone.
  await remember({
    projectId: project.id,
    lane: ARCHITECT_LANE,
    kind: "decision",
    text: body,
    sourceMessageId: message.id,
    weight: 0.95,
    pinned: true,
  });

  return message;
}
