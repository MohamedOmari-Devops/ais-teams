/// <reference path="../pb_data/types.d.ts" />

// Which CLI backend runs a turn. Claude Code is one of several — Codex,
// OpenCode and Kimi run the same shape of turn — so the choice belongs next to
// the model, not baked into the runner.
//
// Only the profile *id* is stored here. Binaries, argv and API keys live in a
// machine-local settings file next to the CLIs themselves: a key synced through
// PocketBase would be readable by every member of the project, and a binary
// path is meaningless on anyone else's machine.
//
// Empty means "inherit": agent -> project -> the machine's default profile.

migrate(
  (app) => {
    for (const name of ["projects", "agents"]) {
      const collection = app.findCollectionByNameOrId(name);
      collection.fields.add(
        new Field({
          name: "cli_profile",
          type: "text",
          max: 60,
          required: false,
        }),
      );
      app.save(collection);
    }
  },

  (app) => {
    for (const name of ["projects", "agents"]) {
      const collection = app.findCollectionByNameOrId(name);
      collection.fields.removeByName("cli_profile");
      app.save(collection);
    }
  },
);
