// Downloads the OSRS TCG card catalog and circulation (pull) data from the
// public backing API used by https://osrs-tcg.net/cards
//
// Endpoints (discovered from the site's JS bundles):
//   GET /api/v1/catalog/cards/live   -> card catalog: name, rarity, tags, images
//   GET /api/v1/catalog/circulation  -> per-card pull/exist counts
//
// Usage: node fetch-data.mjs

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://osrs-tcg.net/api/v1";
const OUT_DIR = path.dirname(fileURLToPath(import.meta.url));

async function getJson(endpoint) {
  const res = await fetch(`${BASE}/${endpoint}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`${endpoint} -> HTTP ${res.status}`);
  }
  return res.json();
}

const catalog = await getJson("catalog/cards/live");
const circulation = await getJson("catalog/circulation");

await writeFile(
  path.join(OUT_DIR, "raw_catalog.json"),
  JSON.stringify(catalog, null, 2),
);
await writeFile(
  path.join(OUT_DIR, "raw_circulation.json"),
  JSON.stringify(circulation, null, 2),
);

console.log(
  `Saved raw_catalog.json (${catalog.items.length} items, ${catalog.npcs.length} npcs)` +
    ` and raw_circulation.json (${Object.keys(circulation.cards).length} entries)` +
    ` generatedAt=${circulation.generatedAt}`,
);
