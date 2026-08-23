/// <reference path="../pb_data/types.d.ts" />

// Per-agent Claude in Chrome integration. Maps to the CLI's `--chrome` flag, so
// an agent with this on can drive the user's browser during its turn.
//
// Off by default and per-agent on purpose: browser control is a much larger
// blast radius than file edits, and most agents have no use for it.

migrate(
  (app) => {
    const agents = app.findCollectionByNameOrId("agents");
    agents.fields.add(new Field({ name: "chrome", type: "bool", required: false }));
    app.save(agents);
  },

  (app) => {
    const agents = app.findCollectionByNameOrId("agents");
    agents.fields.removeByName("chrome");
    app.save(agents);
  },
);
