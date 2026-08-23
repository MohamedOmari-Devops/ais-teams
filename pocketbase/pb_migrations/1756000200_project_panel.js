/// <reference path="../pb_data/types.d.ts" />

// Projects were created with a name and nothing else, which left every run
// working in "." with no standing brief. These fields are what the project
// settings panel edits.

migrate(
  (app) => {
    const projects = app.findCollectionByNameOrId("projects");

    // Standing instructions prepended to every agent turn in the project.
    projects.fields.add(
      new Field({
        name: "instructions",
        type: "text",
        max: 20000,
        required: false,
      }),
    );

    // Folder of agent `.md` definitions, imported by the settings panel.
    projects.fields.add(
      new Field({
        name: "agents_dir",
        type: "text",
        max: 500,
        required: false,
      }),
    );

    // Accent colour, used for the project chip and its channels.
    projects.fields.add(
      new Field({
        name: "color",
        type: "text",
        max: 20,
        required: false,
      }),
    );

    app.save(projects);
  },

  (app) => {
    const projects = app.findCollectionByNameOrId("projects");
    for (const name of ["instructions", "agents_dir", "color"]) {
      projects.fields.removeByName(name);
    }
    app.save(projects);
  },
);
