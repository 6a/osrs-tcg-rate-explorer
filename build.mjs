// Merges the raw catalog + circulation data, computes pull rates, and writes:
//   - pull-rates.db  (SQLite database)
//   - data.js        (embedded data for the local frontend)
//
// Pull rate methodology:
//   totalPulled   = sum over all cards of (pulledNormal + pulledFoil)
//   card pull rate = (pulledNormal + pulledFoil) / totalPulled * 100
//
// Usage: node build.mjs

import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const catalog = JSON.parse(await readFile(path.join(HERE, "raw_catalog.json"), "utf8"));
const circulation = JSON.parse(await readFile(path.join(HERE, "raw_circulation.json"), "utf8"));
const circ = circulation.cards;

// Circulation keys are card names, but casing is inconsistent and the same card
// can be split across case-variants (e.g. "Hoop Snake" has all the normal pulls,
// "Hoop snake" all the foil pulls). Merge into one entry per lowercase name.
const circMerged = new Map();
for (const [key, stats] of Object.entries(circ)) {
  const k = key.toLowerCase();
  const prev = circMerged.get(k);
  if (!prev) {
    circMerged.set(k, { ...stats });
  } else {
    for (const f of ["pulledNormal", "pulledFoil", "existNormal", "existFoil"]) {
      prev[f] = (prev[f] ?? 0) + (stats[f] ?? 0);
    }
    prev.highestFoilCondition = Math.max(prev.highestFoilCondition ?? 0, stats.highestFoilCondition ?? 0) || null;
  }
}

const totalPulled = [...circMerged.values()].reduce(
  (sum, c) => sum + (c.pulledNormal ?? 0) + (c.pulledFoil ?? 0),
  0,
);

// Official osrs-tcg.net tag filter groups (mirrors their tag dropdown).
// Generated here at gather time: each card gets its normalized official
// labels, and the group structure is embedded in data.js for the frontend.
const TAG_GROUPS = [
  { label: "Type", tags: ["Item", "NPC"] },
  { label: "Combat", tags: ["Magic", "Melee", "Ranged"] },
  {
    label: "Skills",
    tags: ["Agility", "Construction", "Cooking", "Crafting", "Farming", "Firemaking", "Fishing", "Fletching", "Herblore", "Hunter", "Mining", "Prayer", "Runecraft", "Sailing", "Slayer", "Smithing", "Special attack", "Thieving", "Woodcutting"],
  },
  { label: "Gear", tags: ["Ammo", "Equipment", "Tool", "Weapon"] },
];
// The API spells it "Specialattack"; the site shows "Special attack".
const TAG_ALIASES = { Specialattack: "Special attack" };
const KNOWN_TAGS = new Set(TAG_GROUPS.flatMap((g) => g.tags));
function cardTags(e) {
  const out = new Set();
  for (const raw of (e.tcg?.tags?.labels ?? [])) {
    const t = TAG_ALIASES[raw] ?? raw;
    if (KNOWN_TAGS.has(t)) out.add(t);
  }
  if (e.kind.includes("item")) out.add("Item");
  if (e.kind.includes("npc")) out.add("NPC");
  return [...out];
}

const entities = [
  ...catalog.items.map((i) => ({ ...i, kind: "item" })),
  ...catalog.npcs.map((i) => ({ ...i, kind: "npc" })),
];
for (const e of entities) e._tags = cardTags(e);

// Some names exist as both an item and an NPC ("Manta ray"). Usually
// circulation tracks both under the single name, but when the NPC entry has a
// known id AND circulation has a separate "npc:{id}" key, the item and NPC
// cards are tracked separately (e.g. item "Manta ray" vs NPC npc:15220).
const itemNames = new Set(catalog.items.map((i) => i.name.toLowerCase()));
const npcIdToName = new Map(
  catalog.npcs.filter((n) => n.id > 0).map((n) => [n.name.toLowerCase(), n.id]),
);

const splitCards = new Set(); // lowercase names tracked separately by npc id
for (const [name, id] of npcIdToName) {
  if (itemNames.has(name) && circMerged.has(`npc:${id}`)) {
    splitCards.add(name);
  }
}
const consumedNpcKeys = new Set(
  [...npcIdToName]
    .filter(([name]) => splitCards.has(name))
    .map(([, id]) => `npc:${id}`),
);

// Collapse to one row per lowercase name, except for split-tracked cards.
const byKey = new Map();
for (const e of entities) {
  const k = e.name.toLowerCase();
  const prev = byKey.get(k);
  if (splitCards.has(k)) {
    byKey.set(`${k}|${e.kind}`, e);
  } else if (!prev) {
    byKey.set(k, e);
  } else if (prev.kind !== e.kind) {
    prev.kind = `${prev.kind}+${e.kind}`;
    prev._tags = [...new Set([...prev._tags, ...e._tags])];
  }
}

function rowFrom(e, stats) {
  const pulledNormal = stats.pulledNormal ?? 0;
  const pulledFoil = stats.pulledFoil ?? 0;
  const pulled = pulledNormal + pulledFoil;
  return {
    name: e.name,
    kind: e.kind,
    rarity: e.tcg?.tierLabel ?? null,
    score: e.tcg?.score ?? null,
    foilScore: e.tcg?.foilScore ?? null,
    labels: JSON.stringify(e.tcg?.tags?.labels ?? []),
    collections: [...new Set([...(e.tcg?.tags?.labels ?? []), ...(e.regions ?? [])])],
    tags: e._tags ?? [],
    variants: JSON.stringify(e.tcg?.variants ?? []),
    examine: e.examine ?? null,
    imagePath: e.imagePath ?? null,
    wiki: e.wiki?.page ?? null,
    pulledNormal,
    pulledFoil,
    pulled,
    existNormal: stats.existNormal ?? null,
    existFoil: stats.existFoil ?? null,
    highestFoilCondition: stats.highestFoilCondition ?? null,
    pullRatePct: totalPulled ? (pulled / totalPulled) * 100 : 0,
    oneInX: pulled ? totalPulled / pulled : null,
  };
}

const rows = [...byKey.entries()].map(([k, e]) => {
  let stats = circMerged.get(k.split("|")[0]) ?? {};
  if (splitCards.has(k.split("|")[0]) && e.kind === "npc") {
    stats = circMerged.get(`npc:${e.id}`) ?? {};
  }
  return rowFrom(e, stats);
});

// Circulation entries with no catalog entry (e.g. special variants); skip the
// npc:{id} keys that were resolved onto NPC rows above.
const knownNames = new Set(entities.map((e) => e.name.toLowerCase()));
const extraRows = [...circMerged.keys()]
  .filter((k) => !knownNames.has(k) && !consumedNpcKeys.has(k))
  .map((k) => {
    const stats = circMerged.get(k);
    const pulled = (stats.pulledNormal ?? 0) + (stats.pulledFoil ?? 0);
    return {
      name: k,
      kind: "unknown",
      rarity: null,
      score: null,
      foilScore: null,
      labels: "[]",
      collections: [],
      tags: [],
      variants: "[]",
      examine: null,
      imagePath: null,
      wiki: null,
      pulledNormal: stats.pulledNormal ?? 0,
      pulledFoil: stats.pulledFoil ?? 0,
      pulled,
      existNormal: stats.existNormal ?? null,
      existFoil: stats.existFoil ?? null,
      highestFoilCondition: stats.highestFoilCondition ?? null,
      pullRatePct: totalPulled ? (pulled / totalPulled) * 100 : 0,
      oneInX: pulled ? totalPulled / pulled : null,
    };
  });

const allRows = [...rows, ...extraRows].sort((a, b) => b.pullRatePct - a.pullRatePct);

// ---- SQLite ----
const dbPath = path.join(HERE, "pull-rates.db");
const db = new DatabaseSync(dbPath);
db.exec(`
  DROP TABLE IF EXISTS cards;
  DROP TABLE IF EXISTS meta;
  CREATE TABLE cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT,
    rarity TEXT,
    score INTEGER,
    foil_score INTEGER,
    labels TEXT,
    collections TEXT,
    tags TEXT,
    variants TEXT,
    examine TEXT,
    image_path TEXT,
    wiki TEXT,
    pulled_normal INTEGER NOT NULL,
    pulled_foil INTEGER NOT NULL,
    pulled INTEGER NOT NULL,
    exist_normal INTEGER,
    exist_foil INTEGER,
    highest_foil_condition REAL,
    pull_rate_pct REAL NOT NULL,
    one_in_x REAL
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE INDEX idx_cards_rarity ON cards(rarity);
  CREATE INDEX idx_cards_name ON cards(name);
  CREATE INDEX idx_cards_pull_rate ON cards(pull_rate_pct);
`);

const insert = db.prepare(`
  INSERT INTO cards (name, kind, rarity, score, foil_score, labels, collections, tags, variants, examine,
                     image_path, wiki, pulled_normal, pulled_foil, pulled,
                     exist_normal, exist_foil, highest_foil_condition,
                     pull_rate_pct, one_in_x)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
for (const r of allRows) {
  insert.run(
    r.name, r.kind, r.rarity, r.score, r.foilScore, r.labels, JSON.stringify(r.collections), JSON.stringify(r.tags), r.variants, r.examine,
    r.imagePath, r.wiki, r.pulledNormal, r.pulledFoil, r.pulled,
    r.existNormal, r.existFoil, r.highestFoilCondition,
    r.pullRatePct, r.oneInX,
  );
}

const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
meta.run("generatedAt", circulation.generatedAt);
meta.run("totalPulled", String(totalPulled));
meta.run("catalogVersion", circulation.partial === undefined ? "" : "");
db.exec("DELETE FROM meta WHERE value = ''");
db.close();

// ---- data.js for the frontend (embedded so file:// works without a server) ----
const frontendData = {
  generatedAt: circulation.generatedAt,
  totalPulled,
  tagGroups: TAG_GROUPS,
  cards: allRows.map((r) => ({
    name: r.name,
    kind: r.kind,
    rarity: r.rarity,
    pulledNormal: r.pulledNormal,
    pulledFoil: r.pulledFoil,
    pulled: r.pulled,
    existNormal: r.existNormal,
    existFoil: r.existFoil,
    highestFoilCondition: r.highestFoilCondition,
    pullRatePct: r.pullRatePct,
    oneInX: r.oneInX,
    collections: r.collections,
    tags: r.tags,
    imagePath: r.imagePath,
    wiki: r.wiki,
  })),
};
await writeFile(
  path.join(HERE, "data.js"),
  "window.PULL_DATA = " + JSON.stringify(frontendData) + ";\n",
);

console.log(`totalPulled = ${totalPulled}`);
console.log(`Wrote ${allRows.length} rows to pull-rates.db and data.js`);
