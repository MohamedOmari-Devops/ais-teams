# AIS Teams

A Slack-shaped desktop app where the people you talk to are Claude Code agents.

Each project gets its own channels, its own roster of agents, and its own
compressed memory. You type in a channel, the agents that belong to that channel
answer, and everything durable they produce is stored in PocketBase so the next
turn starts from knowledge instead of from scratch. A phone can join the same
workspace and drive the same agents — the desktop machine does the actual work.

The whole design is bent around one constraint: **tokens cost money**, so
nothing raw is ever sent to a model twice.

---

## Table of contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [How context stays cheap](#how-context-stays-cheap)
- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [WSL networking (important)](#wsl-networking-important)
- [Connecting a phone](#connecting-a-phone)
- [Project layout](#project-layout)
- [Data model](#data-model)
- [Rust commands and events](#rust-commands-and-events)
- [Full development plan](#full-development-plan)
- [Commands](#commands)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)

---

## What it does

- **Channels, not chat windows.** A project is split into channels; each channel
  owns a *context lane*. `#backend` writes to lane `infra`, `#decisions` writes
  to lane `decisions`. Agents read only the lanes they are entitled to.
- **Agents with profiles.** Every agent has its own persona, model, effort
  level, permission mode, tool allowlist and token budget. The persona is
  injected as `--append-system-prompt`; the rest map onto Claude Code CLI flags.
- **Real Claude Code, not an API wrapper.** Chat turns spawn
  `claude -p --output-format stream-json` in the project directory and stream
  the result back. A terminal pane runs the full interactive TUI in a PTY when
  you want to drive it by hand.
- **Memory that compounds.** Each turn ends with a `FACTS:` block. Those facts
  are stored as high-weight context chunks, so "what did we decide about auth"
  costs a few hundred tokens instead of a full transcript replay.
- **Phone as a remote control.** A phone posts a `runs` row; the desktop host
  claims it, executes it locally, and writes the reply back. Both devices see
  the same conversation through PocketBase realtime.

---

## Architecture

```
┌──────────────────────────── desktop (Tauri 2) ────────────────────────────┐
│                                                                           │
│  React + Tailwind (src/)                                                  │
│    ├── orchestrator.ts   turn engine, queue worker, FACTS harvesting      │
│    ├── context.ts        lanes, weights, budget, compaction               │
│    └── pb.ts             PocketBase SDK (auth + realtime)                 │
│              │ invoke / events                                            │
│  Rust core (src-tauri/src/)                                               │
│    ├── runner.rs   spawns `claude -p`, streams NDJSON -> webview events    │
│    ├── pty.rs      interactive `claude` in a real PTY (desktop only)      │
│    └── context.rs  caveman compressor + token budgeting (unit-tested)     │
└───────────────────────────────────────────────────────────────────────────┘
             │ HTTP + realtime (SSE)
┌────────────┴──────────── PocketBase (Docker, inside WSL) ─────────────────┐
│  projects · agents · channels · messages · context_chunks · goals         │
│  agent_sessions · devices · runs                                          │
└───────────────────────────────────────────────────────────────────────────┘
             │ HTTP + realtime
┌────────────┴──────────── phone (Tauri 2 mobile / browser) ────────────────┐
│  same React app; no local CLI, so it queues runs for the desktop host     │
└───────────────────────────────────────────────────────────────────────────┘
```

Two deliberate choices are worth calling out:

**Rust never writes to PocketBase.** The frontend owns all persistence. It
already holds the authenticated session, and keeping the Rust side write-free
means the phone and the desktop use the identical data path — only the
*execution* differs.

**PocketBase is the queue.** No message broker. A `runs` row with
`status = "queued"` is a job; `claimed_by` is the lock. It is enough for a team
of one machine plus a few phones, and it keeps the stack to two processes.

---

## How context stays cheap

Four mechanisms, in the order they apply:

1. **Compression on write.** Nothing is stored raw. `context.rs::compress`
   strips articles, filler and hedging from prose while copying fenced code,
   paths, identifiers and numbers verbatim. Roughly 30–40% off English text,
   0% off code.

2. **Lane splitting.** A chunk belongs to a lane. An agent's pack query only
   touches `channel.lane` plus the agent's own `lanes[]`. A 40-channel project
   never loads 40 channels of history.

3. **Budgeted packing.** `build_context_pack` ranks chunks by weight
   (`decision 0.9 > goal 0.85 > summary 0.7 > message 0.3`, pinned = 1.0) then
   recency, and appends until the token budget runs out. Overflow is *dropped
   and counted*, not silently truncated — the UI shows `ctx 1240t` per turn.

4. **Session resume.** `agent_sessions` maps `(agent, channel)` to a Claude
   session id. Turn 2 passes `--resume`, so the model already has the
   conversation and only the delta is new.

On top of that, agents answer under a strict brevity contract
(`runner.rs::BREVITY_CONTRACT`), which caps output tokens and forces the
`FACTS:` block that feeds mechanism 1. Set `verbose_output` on an agent to opt
out when you actually want prose.

Periodic compaction is available via `compactLane()` in `src/lib/context.ts`:
it folds a lane's stale `message` chunks into one `summary` chunk and deletes
the originals.

---

## Prerequisites

| Tool | Version tested | Notes |
|---|---|---|
| Node | 24.14 | any 20+ works |
| pnpm | 10.30 | `npm i -g pnpm` |
| Rust | 1.96 | via [rustup](https://rustup.rs) |
| Claude Code CLI | 2.1.229 | `claude --version` must work in the shell that launches the app |
| Docker | 29.6 (in WSL) | Docker Desktop with WSL integration also works |
| WSL 2 | Ubuntu | only needed because PocketBase runs there |

Windows also needs **Microsoft Visual Studio C++ Build Tools** and
**WebView2** (preinstalled on Windows 11) for Tauri. See
<https://tauri.app/start/prerequisites/>.

---

## Quickstart

```bash
# 1. install frontend deps
pnpm install

# 2. start PocketBase in Docker (inside WSL) — applies migrations on boot
pnpm pb:up

# 3. find the URL the app should use (see the networking section below)
pnpm pb:ip          # -> e.g. 172.27.79.200

# 4. seed a demo project, 4 agents and 4 channels
PB_URL=http://172.27.79.200:8090 node scripts/seed.mjs --root "C:\path\to\your\repo"

# 5. run the desktop app
pnpm app:dev
```

On the login screen, put the same PocketBase URL in the **PocketBase URL**
field, then sign in with the seeded account (`dev@ais.local` /
`devdevdev123`) or create your own.

The status line at the bottom of the window reads `runner ready · <version>`
when the Claude Code CLI was found. If it reads `runner offline`, the app can
still show the workspace but every turn will sit queued.

**Set `root_path` on your project.** It is the working directory for every
agent run. The seed script sets it from `--root`; otherwise edit the project
record in the PocketBase dashboard at `http://<pb-host>:8090/_/`.

---

## WSL networking (important)

PocketBase listens inside the WSL VM. Windows can reach it in one of two ways,
and **on a default NAT setup `localhost:8090` may not work** — that is what
happens on this machine.

### Option A — mirrored networking (recommended)

Makes `localhost` work in both directions and lets phones reach the server
through the Windows LAN IP.

1. Edit `%USERPROFILE%\.wslconfig`:

   ```ini
   [wsl2]
   networkingMode=mirrored
   ```

2. Restart WSL (this closes every running WSL session):

   ```powershell
   wsl --shutdown
   ```

3. Start the container again: `pnpm pb:up`. `http://127.0.0.1:8090` now works
   from Windows, and phones can use `http://<windows-lan-ip>:8090`.

4. Allow the port through the firewall once:

   ```powershell
   New-NetFirewallRule -DisplayName "PocketBase 8090" -Direction Inbound `
     -Protocol TCP -LocalPort 8090 -Action Allow
   ```

### Option B — talk to the WSL VM directly

No config change, but the address changes on reboot:

```bash
pnpm pb:ip        # -> 172.27.79.200
```

Use `http://172.27.79.200:8090` as the PocketBase URL. Phones **cannot** reach
this address; Option A is required for mobile.

---

## Connecting a phone

The phone runs the same React app — either as a Tauri 2 mobile build or just in
a browser pointed at a dev server on the LAN.

1. Finish [Option A](#option-a--mirrored-networking-recommended) above.
2. Build for Android:

   ```bash
   pnpm android:init      # once; needs Android Studio, SDK, NDK, JDK 17
   pnpm android:dev
   ```

   For iOS you need macOS and Xcode; `pnpm tauri ios init` then `ios dev`.
3. On the phone's login screen, enter `http://<windows-lan-ip>:8090` and sign in
   with the same account.

What happens then: the phone has no Claude Code binary, so `hostInfo()` reports
`canRunAgents: false`. `dispatchTurn` still creates the placeholder message and
the `runs` row, but leaves it `queued`. The desktop app — which runs
`startQueueWorker` — claims the row, executes the turn locally against
`root_path`, and streams the reply into the same message record. The phone sees
it appear through PocketBase realtime.

Keep the desktop app open. It is the only thing that can actually run agents.

---

## Project layout

```
ais-teams/
├── src/                          React frontend
│   ├── App.tsx                   auth gate, subscriptions, layout
│   ├── store.ts                  zustand: project/channel/messages/drafts
│   ├── components/
│   │   ├── Login.tsx             auth + PocketBase URL
│   │   ├── Sidebar.tsx           projects, channels, agent roster
│   │   ├── Chat.tsx              transcript, live drafts, composer
│   │   ├── AgentEditor.tsx       per-agent profile (maps to CLI flags)
│   │   └── Terminal.tsx          PTY pane running the real TUI
│   └── lib/
│       ├── pb.ts                 PocketBase client, auth, URL override
│       ├── bridge.ts             typed wrappers over Rust commands/events
│       ├── context.ts            lanes, weights, packing, FACTS, compaction
│       ├── orchestrator.ts       turn engine + queue worker
│       └── types.ts              collection shapes
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs                plugins, state, command registration
│   │   ├── runner.rs             headless `claude -p` runs
│   │   ├── pty.rs                interactive PTY sessions (desktop only)
│   │   └── context.rs            compressor + budgeting (+ unit tests)
│   ├── capabilities/default.json permission set for the main window
│   └── tauri.conf.json
├── pocketbase/
│   ├── docker-compose.yml        PocketBase in WSL Docker
│   └── pb_migrations/
│       └── 1756000000_init_schema.js
└── scripts/seed.mjs              demo project + agents + channels
```

---

## Data model

Nine collections, all defined in `pocketbase/pb_migrations/1756000000_init_schema.js`.

| Collection | Purpose | Key fields |
|---|---|---|
| `projects` | one codebase / product | `root_path`, `owner`, `members`, `context_budget` |
| `agents` | a Claude Code persona | `instructions`, `model`, `effort`, `permission_mode`, `allowed_tools`, `lanes`, `context_budget`, `bare`, `verbose_output` |
| `channels` | a conversation | `lane`, `kind`, `agents[]` |
| `messages` | transcript | `author_type`, `body`, `compressed`, `status`, `run_id`, `context_tokens` |
| `context_chunks` | the memory agents read | `lane`, `kind`, `text`, `weight`, `pinned` |
| `goals` | what the project is chasing | `title`, `status`, `achieved_at` |
| `agent_sessions` | resumable Claude sessions | `(agent, channel)` unique → `claude_session_id` |
| `devices` | paired phones / hosts | `is_runner`, `last_seen` |
| `runs` | job queue + audit log | `status`, `claimed_by`, `exit_code` |

Access rules hang off `projects.owner` and `projects.members`; every child
collection checks `project.owner = @request.auth.id || project.members.id ?= @request.auth.id`.

Migrations run automatically when the container starts. To change the schema,
add a new file to `pb_migrations/` and restart: `pnpm pb:down && pnpm pb:up`.

---

## Rust commands and events

Commands (call through `src/lib/bridge.ts`, never `invoke` directly):

| Command | Purpose |
|---|---|
| `run_agent(request)` | spawn a turn; returns immediately |
| `cancel_agent_run(runId)` | kill an in-flight turn |
| `active_runs()` | `[runId, agentId]` currently executing |
| `claude_doctor()` | CLI version, or an error string |
| `compress_text(text)` | caveman compression |
| `estimate_tokens(text)` | cheap token estimate |
| `build_context_pack(chunks, budgetTokens)` | rank + compress + truncate |
| `default_context_budget()` | seed value for new projects |
| `host_info()` | hostname, platform, `canRunAgents` |
| `pty_open/write/resize/close/list` | interactive terminal (desktop only) |

Events:

| Event | Payload |
|---|---|
| `agent://start` | `runId, agentId, channelId, sessionId, resumed, contextTokens` |
| `agent://delta` | `runId, text` — incremental assistant text |
| `agent://chunk` | full parsed NDJSON line from the CLI |
| `agent://end` | `exitCode, cancelled, text, stderr, sessionId` |
| `pty://data`, `pty://exit` | terminal output / exit code |

The prompt is piped over **stdin**, not argv, so long prompts never hit the
Windows 32 KB command-line limit. The system prompt still goes through
`--append-system-prompt`, which is why the context budget defaults to 3000
tokens (~12 KB).

---

## Full development plan

The stages below are the order this app is meant to be built in. Stages 0–5 are
implemented in this repository; 6 onward are the roadmap.

### Stage 0 — scaffold

```bash
pnpm create tauri-app@latest ais-teams -m pnpm -t react-ts --tauri-version 2
pnpm add pocketbase zustand @tauri-apps/plugin-shell @tauri-apps/plugin-store \
         @tauri-apps/plugin-os @tauri-apps/plugin-dialog @tauri-apps/plugin-fs
pnpm add -D tailwindcss @tailwindcss/vite
cargo add tauri-plugin-shell tauri-plugin-store tauri-plugin-os \
          tauri-plugin-dialog tauri-plugin-fs tokio anyhow uuid chrono
```

Add `portable-pty` under a target-gated dependency block so mobile builds skip
it, register the Tailwind Vite plugin, and add the plugin permissions to
`src-tauri/capabilities/default.json`. **Checkpoint:** `pnpm app:dev` opens a
window.

### Stage 1 — backend up

Write `pocketbase/docker-compose.yml` using a **named volume** for `pb_data`
(SQLite over a `/mnt/c` bind mount is slow and its file locks are unreliable)
and a bind mount for `pb_migrations`. Write the schema migration. Start it with
`pnpm pb:up` and confirm the collections exist in the dashboard.
**Checkpoint:** `curl http://<pb>:8090/api/health` returns healthy and the nine
collections are listed.

### Stage 2 — the context engine

Build `src-tauri/src/context.rs` before any UI. It is the piece the whole cost
model rests on:

- `compress` — split on ``` fences, rewrite prose, copy code verbatim.
- `estimate_tokens` — `len / 4`, deliberately crude.
- `build_pack` — sort by weight then recency, append under budget, count drops.

Write the unit tests first: code blocks survive, paths survive, overflow is
dropped. **Checkpoint:** `pnpm rust:test` is green.

### Stage 3 — the runner

`runner.rs` builds the CLI invocation and streams it back:

```
claude -p --output-format stream-json --verbose --include-partial-messages \
       --session-id <uuid> | --resume <id> \
       --append-system-prompt <persona + context + brevity contract> \
       --model … --permission-mode … --effort … --allowed-tools … --add-dir …
```

Pipe the prompt over stdin. Drain stderr on its own task so a chatty CLI cannot
deadlock stdout. Keep a registry of in-flight runs keyed by `runId` with a
oneshot cancel channel. **Checkpoint:** `claude_doctor()` returns a version and
a hardcoded prompt streams `agent://delta` events into the console.

### Stage 4 — the turn engine

`src/lib/orchestrator.ts` ties it together:

1. `postUserMessage` — store the message, remember it as a low-weight chunk.
2. `pickTargets` — `@mentions` win, otherwise every enabled agent on the channel.
3. `dispatchTurn` — pack context, create the placeholder message and `runs` row,
   invoke `run_agent`.
4. Buffer deltas, flush to PocketBase every ~900 ms (never per token).
5. On `agent://end`, harvest the `FACTS:` block into high-weight chunks and
   upsert `agent_sessions`.

**Checkpoint:** a message in `#general` produces a streaming reply that persists
and survives a reload.

### Stage 5 — the UI

Sidebar (projects / channels / agents), chat pane with live drafts and a token
meter, agent editor mapping every profile field to a CLI flag, PTY terminal
pane. **Checkpoint:** you can create an agent, add it to a channel, and talk to
it without touching the database.

### Stage 6 — mobile

`pnpm android:init`, then `pnpm android:dev`. The mobile build registers only
the pure Rust helpers — no PTY, no process spawning. Verify that a turn sent
from the phone lands as a `queued` run and that the desktop host executes it.
Add push notifications (`tauri-plugin-notification`) for turn completion.

### Stage 7 — memory maintenance

Schedule `compactLane()` per lane (a nightly `setInterval`, or a PocketBase
cron hook in `pb_hooks/`). Add a memory browser: list chunks by lane, pin the
important ones, delete noise. Consider embeddings for retrieval instead of
weight+recency once a lane passes a few thousand chunks.

### Stage 8 — multi-agent workflows

Let one agent address another (`@reviewer look at this`), so a reply can trigger
a follow-up turn. Cap the fan-out depth — two agents talking to each other is
an infinite token bill. Add a standup channel kind that runs every agent on a
schedule and posts a digest.

### Stage 9 — hardening and release

Set a real CSP in `tauri.conf.json` (it ships `null`), narrow the `fs` scope in
`capabilities/default.json`, put PocketBase behind TLS if it leaves the LAN,
and configure the Tauri updater. Then `pnpm app:build`.

---

## Commands

| Command | What it does |
|---|---|
| `pnpm app:dev` | run the desktop app (Vite + Tauri) |
| `pnpm app:build` | production bundle |
| `pnpm dev` / `pnpm build` | frontend only |
| `pnpm pb:up` / `pb:down` | start / stop PocketBase in WSL Docker |
| `pnpm pb:logs` | follow PocketBase logs |
| `pnpm pb:reset` | **destroys** `pb_data` and starts fresh |
| `pnpm pb:ip` | print the WSL VM IP |
| `pnpm pb:admin` | create/update a PocketBase superuser |
| `pnpm seed` | seed a demo workspace |
| `pnpm rust:check` / `rust:test` | Rust type-check / unit tests |
| `pnpm android:init` / `android:dev` | Android target |

---

## Troubleshooting

**`runner offline` in the status bar.** The app could not run `claude`. Check
`claude --version` in a shell, then set `AIS_CLAUDE_BIN` to the absolute path
if the binary is behind a shim (nvm, volta).

**Turns stay `queued` forever.** No device is running the queue worker. The
desktop app must be open, authenticated, and reporting `runner ready`.

**`fetch failed ECONNREFUSED` from Node or the app.** WSL is not forwarding
localhost. See [WSL networking](#wsl-networking-important).

**Migration did not apply.** Migrations run on container start. Confirm the file
is mounted (`wsl -e docker exec ais-teams-pb ls /pb_migrations`) and restart the
container. A syntax error in a migration stops the server from booting — check
`pnpm pb:logs`.

**Replies arrive but nothing is remembered.** The agent skipped its `FACTS:`
block. Check that `verbose_output` is off, and that the persona in the agent
editor does not contradict the brevity contract.

**PocketBase is slow.** You bind-mounted `pb_data` from `/mnt/c`. Use the named
volume in the shipped compose file.

---

## Security notes

Read these before pointing this at anything sensitive:

- **`bypassPermissions` is a real footgun.** An agent set to that mode can run
  any command in `root_path` with no prompt. Default to `acceptEdits`, and use
  `plan` or `manual` for anything you have not audited.
- **`tauri.conf.json` ships `csp: null`.** Fine for local development; set a
  real policy before distributing a build.
- **PocketBase is unauthenticated at the network level.** Binding `0.0.0.0:8090`
  exposes it to your whole LAN. Keep it on a trusted network, or put it behind
  TLS and a reverse proxy.
- **The `fs` capability allows reading `$HOME/**`.** Narrow it to the
  directories you actually need.
- **Seeded credentials are throwaway.** Change `dev@ais.local` /
  `devdevdev123` before the workspace holds anything real.
