/// <reference path="../pb_data/types.d.ts" />

// Fix: `maxSelect: 0` on a relation field means *single* select in PocketBase,
// not "unlimited". The initial schema used it for `channels.agents` and
// `projects.members`, so both stored one id instead of a list — a channel could
// only ever have one agent.
//
// The field id is preserved so existing data survives the change.

function retype(app, collectionName, fieldName, targetCollectionName, maxSelect) {
  const collection = app.findCollectionByNameOrId(collectionName);
  const target = app.findCollectionByNameOrId(targetCollectionName);
  const existing = collection.fields.getByName(fieldName);
  if (!existing) throw new Error(`${collectionName}.${fieldName} not found`);

  const fieldId = existing.id;
  collection.fields.removeByName(fieldName);
  collection.fields.add(
    new Field({
      id: fieldId,
      name: fieldName,
      type: "relation",
      required: false,
      system: false,
      hidden: false,
      presentable: false,
      collectionId: target.id,
      cascadeDelete: false,
      minSelect: 0,
      maxSelect: maxSelect,
    }),
  );
  app.save(collection);
}

migrate(
  (app) => {
    retype(app, "channels", "agents", "agents", 999);
    retype(app, "projects", "members", "users", 999);
  },
  (app) => {
    retype(app, "channels", "agents", "agents", 1);
    retype(app, "projects", "members", "users", 1);
  },
);
