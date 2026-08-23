#!/usr/bin/env node
// Seed a demo workspace so a fresh install has something to talk to.
//
//   node scripts/seed.mjs [--root "C:\\path\\to\\your\\repo"]
//
// Env: PB_URL, PB_EMAIL, PB_PASSWORD. The account is created if missing.

import PocketBase from "pocketbase";

const PB_URL = process.env.PB_URL ?? "http://127.0.0.1:8090";
const EMAIL = process.env.PB_EMAIL ?? "dev@ais.local";
const PASSWORD = process.env.PB_PASSWORD ?? "devdevdev123";

const rootFlag = process.argv.indexOf("--root");
const ROOT_PATH = rootFlag > -1 ? process.argv[rootFlag + 1] : process.cwd();

const pb = new PocketBase(PB_URL);
pb.autoCancellation(false);

async function auth() {
  try {
    await pb.collection("users").authWithPassword(EMAIL, PASSWORD);
    console.log(`auth ok: ${EMAIL}`);
  } catch {
    await pb.collection("users").create({
      email: EMAIL,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      name: EMAIL.split("@")[0],
    });
    await pb.collection("users").authWithPassword(EMAIL, PASSWORD);
    console.log(`created + auth ok: ${EMAIL}`);
  }
}

const AGENTS = [
  {
    name: "architect",
    role: "shapes the design, owns decisions",
    avatar_color: "#7c5cff",
    instructions:
      "You own architecture. Answer with decisions and trade-offs, not tutorials. " +
      "Cite concrete files. When a decision is final, put it in the FACTS block.",
    model: "opus",
    effort: "high",
    permission_mode: "plan",
    lanes: ["decisions"],
    context_budget: 4000,
  },
  {
    name: "backend",
    role: "Rust + PocketBase",
    avatar_color: "#3fbf7f",
    instructions:
      "You own the Rust core in src-tauri and the PocketBase schema. Small diffs. " +
      "Never edit files under src/components. Run cargo check before claiming done.",
    model: "sonnet",
    effort: "medium",
    permission_mode: "acceptEdits",
    lanes: ["infra"],
    context_budget: 3000,
  },
  {
    name: "frontend",
    role: "React + Tailwind",
    avatar_color: "#e0a44a",
    instructions:
      "You own src/ (React, Tailwind). Match existing component patterns. " +
      "Never touch src-tauri. Keep bundle size in mind.",
    model: "sonnet",
    effort: "medium",
    permission_mode: "acceptEdits",
    lanes: [],
    context_budget: 3000,
  },
  {
    name: "reviewer",
    role: "reads diffs, finds bugs",
    avatar_color: "#e2585f",
    instructions:
      "Review only. Never edit files. One line per finding: path:line, problem, fix. " +
      "No praise, no summary.",
    model: "sonnet",
    effort: "high",
    permission_mode: "manual",
    allowed_tools: ["Read", "Grep", "Glob", "Bash(git *)"],
    lanes: ["decisions", "infra"],
    context_budget: 2500,
  },
];

const CHANNELS = [
  { name: "general", lane: "general", topic: "Everything that has no home yet." },
  { name: "backend", lane: "infra", topic: "Rust core, PocketBase schema, deploys." },
  { name: "frontend", lane: "ui", topic: "React app, styling, UX." },
  { name: "decisions", lane: "decisions", topic: "Durable calls. High-weight memory." },
];

async function main() {
  await auth();
  const userId = pb.authStore.record.id;

  const project = await pb.collection("projects").create({
    name: "AIS Teams",
    slug: `ais-teams-${Math.random().toString(36).slice(2, 6)}`,
    description: "Demo workspace seeded by scripts/seed.mjs",
    root_path: ROOT_PATH,
    owner: userId,
    members: [userId],
    default_model: "sonnet",
    context_budget: 3000,
  });
  console.log(`project: ${project.name} (${project.id})`);
  console.log(`  root_path: ${ROOT_PATH}`);

  const agents = [];
  for (const spec of AGENTS) {
    const agent = await pb.collection("agents").create({
      project: project.id,
      enabled: true,
      bare: false,
      verbose_output: false,
      allowed_tools: [],
      disallowed_tools: [],
      add_dirs: [],
      ...spec,
    });
    agents.push(agent);
    console.log(`  agent: ${agent.name}`);
  }

  const byName = Object.fromEntries(agents.map((a) => [a.name, a.id]));
  const membership = {
    general: ["architect", "backend", "frontend"],
    backend: ["backend", "reviewer"],
    frontend: ["frontend", "reviewer"],
    decisions: ["architect"],
  };

  for (const spec of CHANNELS) {
    const channel = await pb.collection("channels").create({
      project: project.id,
      kind: "chat",
      agents: membership[spec.name].map((n) => byName[n]),
      ...spec,
    });
    console.log(`  channel: #${channel.name} (lane ${channel.lane})`);
  }

  await pb.collection("goals").create({
    project: project.id,
    lane: "decisions",
    title: "Ship v0.1 desktop build",
    detail: "Chat + agents + context lanes working end to end.",
    status: "in_progress",
  });

  console.log("\nseed done. sign in with:");
  console.log(`  url:      ${PB_URL}`);
  console.log(`  email:    ${EMAIL}`);
  console.log(`  password: ${PASSWORD}`);
}

main().catch((err) => {
  console.error("seed failed:", err?.response ?? err);
  process.exit(1);
});
