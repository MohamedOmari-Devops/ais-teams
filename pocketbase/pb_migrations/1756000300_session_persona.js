/// <reference path="../pb_data/types.d.ts" />

// Claude Code freezes a session's system prompt when the session is created and
// ignores a changed `--append-system-prompt` on `--resume`. Volatile context now
// rides on the user message, but the agent's persona still lives in the system
// prompt — so a persona edit only takes effect in a *new* session.
//
// This fingerprint records which persona a session was created with. When it no
// longer matches the agent, the turn starts a fresh session instead of resuming.

migrate(
  (app) => {
    const sessions = app.findCollectionByNameOrId("agent_sessions");
    sessions.fields.add(
      new Field({
        name: "persona_hash",
        type: "text",
        max: 40,
        required: false,
      }),
    );
    app.save(sessions);
  },

  (app) => {
    const sessions = app.findCollectionByNameOrId("agent_sessions");
    sessions.fields.removeByName("persona_hash");
    app.save(sessions);
  },
);
