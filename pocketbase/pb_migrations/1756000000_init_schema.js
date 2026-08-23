/// <reference path="../pb_data/types.d.ts" />

// Initial ais-teams schema.
//
// Shape of the world:
//   projects   -> one codebase / product line
//   channels   -> a conversation inside a project, bound to a context lane
//   agents     -> a Claude Code persona owned by a project
//   messages   -> what humans and agents said, plus run bookkeeping
//   context_chunks -> the compressed memory agents actually read
//   goals      -> what the project is trying to achieve, and what landed
//   agent_sessions -> maps (agent, channel) to a resumable Claude session id
//   devices    -> paired phones
//
// Access model: everything hangs off `projects.owner`. A record is visible to
// the project owner and to users listed in `projects.members`.

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");

    const memberRule = [
      "@request.auth.id != ''",
      "(project.owner = @request.auth.id || project.members.id ?= @request.auth.id)",
    ].join(" && ");

    // ---------------------------------------------------------------- projects
    const projects = new Collection({
      type: "base",
      name: "projects",
      listRule: "@request.auth.id != '' && (owner = @request.auth.id || members.id ?= @request.auth.id)",
      viewRule: "@request.auth.id != '' && (owner = @request.auth.id || members.id ?= @request.auth.id)",
      createRule: "@request.auth.id != ''",
      updateRule: "@request.auth.id != '' && owner = @request.auth.id",
      deleteRule: "@request.auth.id != '' && owner = @request.auth.id",
      fields: [
        { name: "name", type: "text", required: true, max: 120 },
        { name: "slug", type: "text", required: true, max: 120 },
        { name: "description", type: "text", max: 2000 },
        // Absolute path on the desktop machine. Agents run with this as cwd.
        { name: "root_path", type: "text", max: 500 },
        { name: "owner", type: "relation", required: true, maxSelect: 1, cascadeDelete: false, collectionId: users.id },
        { name: "members", type: "relation", required: false, maxSelect: 0, cascadeDelete: false, collectionId: users.id },
        { name: "default_model", type: "text", max: 60 },
        { name: "context_budget", type: "number", min: 200, max: 60000 },
        { name: "archived", type: "bool" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_projects_slug ON projects (slug)"],
    });
    app.save(projects);

    // ------------------------------------------------------------------ agents
    const agents = new Collection({
      type: "base",
      name: "agents",
      listRule: memberRule,
      viewRule: memberRule,
      createRule: memberRule,
      updateRule: memberRule,
      deleteRule: memberRule,
      fields: [
        { name: "project", type: "relation", required: true, maxSelect: 1, cascadeDelete: true, collectionId: projects.id },
        { name: "name", type: "text", required: true, max: 60 },
        { name: "role", type: "text", max: 120 },
        { name: "avatar_color", type: "text", max: 20 },
        // The persona. Sent to Claude Code via --append-system-prompt.
        { name: "instructions", type: "text", max: 20000 },
        { name: "model", type: "select", maxSelect: 1, values: ["fable", "opus", "sonnet", "haiku"] },
        { name: "effort", type: "select", maxSelect: 1, values: ["low", "medium", "high", "xhigh", "max"] },
        {
          name: "permission_mode",
          type: "select",
          maxSelect: 1,
          values: ["manual", "acceptEdits", "auto", "plan", "bypassPermissions"],
        },
        { name: "allowed_tools", type: "json", maxSize: 20000 },
        { name: "disallowed_tools", type: "json", maxSize: 20000 },
        { name: "add_dirs", type: "json", maxSize: 20000 },
        // Which context lanes this agent may read. Empty = the channel lane only.
        { name: "lanes", type: "json", maxSize: 20000 },
        { name: "context_budget", type: "number", min: 200, max: 60000 },
        { name: "bare", type: "bool" },
        // Opt out of the compressed output contract (writers, docs agents).
        { name: "verbose_output", type: "bool" },
        { name: "enabled", type: "bool" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_agents_project_name ON agents (project, name)"],
    });
    app.save(agents);

    // ---------------------------------------------------------------- channels
    const channels = new Collection({
      type: "base",
      name: "channels",
      listRule: memberRule,
      viewRule: memberRule,
      createRule: memberRule,
      updateRule: memberRule,
      deleteRule: memberRule,
      fields: [
        { name: "project", type: "relation", required: true, maxSelect: 1, cascadeDelete: true, collectionId: projects.id },
        { name: "name", type: "text", required: true, max: 80 },
        { name: "topic", type: "text", max: 500 },
        // The context lane this channel reads and writes. This is the split
        // that keeps each conversation cheap.
        { name: "lane", type: "text", required: true, max: 60 },
        { name: "kind", type: "select", maxSelect: 1, values: ["chat", "standup", "review", "terminal"] },
        { name: "agents", type: "relation", required: false, maxSelect: 0, cascadeDelete: false, collectionId: agents.id },
        { name: "archived", type: "bool" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_channels_project_name ON channels (project, name)"],
    });
    app.save(channels);

    // ---------------------------------------------------------------- messages
    const messages = new Collection({
      type: "base",
      name: "messages",
      listRule: memberRule,
      viewRule: memberRule,
      createRule: memberRule,
      updateRule: memberRule,
      deleteRule: memberRule,
      fields: [
        { name: "project", type: "relation", required: true, maxSelect: 1, cascadeDelete: true, collectionId: projects.id },
        { name: "channel", type: "relation", required: true, maxSelect: 1, cascadeDelete: true, collectionId: channels.id },
        { name: "author_type", type: "select", required: true, maxSelect: 1, values: ["user", "agent", "system"] },
        { name: "author_user", type: "relation", maxSelect: 1, cascadeDelete: false, collectionId: users.id },
        { name: "author_agent", type: "relation", maxSelect: 1, cascadeDelete: false, collectionId: agents.id },
        { name: "body", type: "text", max: 200000 },
        // Caveman-compressed body, written once and reused as context forever.
        { name: "compressed", type: "text", max: 200000 },
        { name: "status", type: "select", maxSelect: 1, values: ["pending", "streaming", "done", "error", "cancelled"] },
        { name: "run_id", type: "text", max: 60 },
        { name: "claude_session_id", type: "text", max: 60 },
        { name: "context_tokens", type: "number" },
        { name: "tokens_in", type: "number" },
        { name: "tokens_out", type: "number" },
        { name: "cost_usd", type: "number" },
        { name: "error", type: "text", max: 5000 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE INDEX idx_messages_channel_created ON messages (channel, created)",
        "CREATE INDEX idx_messages_run ON messages (run_id)",
      ],
    });
    app.save(messages);

    // ---------------------------------------------------------- context_chunks
    const chunks = new Collection({
      type: "base",
      name: "context_chunks",
      listRule: memberRule,
      viewRule: memberRule,
      createRule: memberRule,
      updateRule: memberRule,
      deleteRule: memberRule,
      fields: [
        { name: "project", type: "relation", required: true, maxSelect: 1, cascadeDelete: true, collectionId: projects.id },
        { name: "lane", type: "text", required: true, max: 60 },
        {
          name: "kind",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["message", "decision", "goal", "summary", "file", "note"],
        },
        { name: "text", type: "text", required: true, max: 20000 },
        // 0..1. Pinned decisions outrank chatter when the budget is tight.
        { name: "weight", type: "number", min: 0, max: 1 },
        { name: "tokens", type: "number" },
        { name: "source_message", type: "relation", maxSelect: 1, cascadeDelete: false, collectionId: messages.id },
        { name: "agent", type: "relation", maxSelect: 1, cascadeDelete: false, collectionId: agents.id },
        { name: "pinned", type: "bool" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE INDEX idx_chunks_project_lane ON context_chunks (project, lane, weight)",
        "CREATE INDEX idx_chunks_created ON context_chunks (created)",
      ],
    });
    app.save(chunks);

    // ------------------------------------------------------------------- goals
    const goals = new Collection({
      type: "base",
      name: "goals",
      listRule: memberRule,
      viewRule: memberRule,
      createRule: memberRule,
      updateRule: memberRule,
      deleteRule: memberRule,
      fields: [
        { name: "project", type: "relation", required: true, maxSelect: 1, cascadeDelete: true, collectionId: projects.id },
        { name: "lane", type: "text", max: 60 },
        { name: "title", type: "text", required: true, max: 200 },
        { name: "detail", type: "text", max: 10000 },
        { name: "status", type: "select", maxSelect: 1, values: ["open", "in_progress", "done", "dropped"] },
        { name: "owner_agent", type: "relation", maxSelect: 1, cascadeDelete: false, collectionId: agents.id },
        { name: "achieved_at", type: "date" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE INDEX idx_goals_project_status ON goals (project, status)"],
    });
    app.save(goals);

    // ---------------------------------------------------------- agent_sessions
    const sessions = new Collection({
      type: "base",
      name: "agent_sessions",
      listRule: memberRule,
      viewRule: memberRule,
      createRule: memberRule,
      updateRule: memberRule,
      deleteRule: memberRule,
      fields: [
        { name: "project", type: "relation", required: true, maxSelect: 1, cascadeDelete: true, collectionId: projects.id },
        { name: "agent", type: "relation", required: true, maxSelect: 1, cascadeDelete: true, collectionId: agents.id },
        { name: "channel", type: "relation", required: true, maxSelect: 1, cascadeDelete: true, collectionId: channels.id },
        // Resumable Claude Code session — this is what makes turn 2 cheap.
        { name: "claude_session_id", type: "text", required: true, max: 60 },
        { name: "turns", type: "number" },
        { name: "last_used", type: "date" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_sessions_agent_channel ON agent_sessions (agent, channel)"],
    });
    app.save(sessions);

    // ----------------------------------------------------------------- devices
    const devices = new Collection({
      type: "base",
      name: "devices",
      listRule: "@request.auth.id != '' && user = @request.auth.id",
      viewRule: "@request.auth.id != '' && user = @request.auth.id",
      createRule: "@request.auth.id != ''",
      updateRule: "@request.auth.id != '' && user = @request.auth.id",
      deleteRule: "@request.auth.id != '' && user = @request.auth.id",
      fields: [
        { name: "user", type: "relation", required: true, maxSelect: 1, cascadeDelete: true, collectionId: users.id },
        { name: "name", type: "text", required: true, max: 80 },
        { name: "platform", type: "select", maxSelect: 1, values: ["windows", "macos", "linux", "android", "ios"] },
        // Set by the desktop host so phones know who can actually run agents.
        { name: "is_runner", type: "bool" },
        { name: "last_seen", type: "date" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE INDEX idx_devices_user ON devices (user)"],
    });
    app.save(devices);

    // -------------------------------------------------------------------- runs
    // Queue + audit log. A phone creates a run with status "queued"; the
    // desktop host subscribes, executes it, and writes the result back.
    const runs = new Collection({
      type: "base",
      name: "runs",
      listRule: memberRule,
      viewRule: memberRule,
      createRule: memberRule,
      updateRule: memberRule,
      deleteRule: memberRule,
      fields: [
        { name: "project", type: "relation", required: true, maxSelect: 1, cascadeDelete: true, collectionId: projects.id },
        { name: "channel", type: "relation", required: true, maxSelect: 1, cascadeDelete: true, collectionId: channels.id },
        { name: "agent", type: "relation", required: true, maxSelect: 1, cascadeDelete: true, collectionId: agents.id },
        { name: "message", type: "relation", maxSelect: 1, cascadeDelete: true, collectionId: messages.id },
        { name: "run_id", type: "text", required: true, max: 60 },
        { name: "prompt", type: "text", max: 50000 },
        {
          name: "status",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["queued", "running", "done", "error", "cancelled"],
        },
        { name: "claimed_by", type: "text", max: 120 },
        { name: "context_tokens", type: "number" },
        { name: "exit_code", type: "number" },
        { name: "error", type: "text", max: 5000 },
        { name: "started", type: "date" },
        { name: "ended", type: "date" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_runs_run_id ON runs (run_id)",
        "CREATE INDEX idx_runs_status ON runs (status)",
      ],
    });
    app.save(runs);
  },

  (app) => {
    // Down migration: reverse dependency order.
    for (const name of [
      "runs",
      "devices",
      "agent_sessions",
      "goals",
      "context_chunks",
      "messages",
      "channels",
      "agents",
      "projects",
    ]) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch (err) {
        // Already gone; nothing to undo.
      }
    }
  }
);
