// Downloads the OSRS TCG card catalog and circulation (pull) data from the
// public backing API used by https://osrs-tcg.net/cards
//
// Endpoints (discovered from the site's JS bundles):
//   GET /api/v1/catalog/cards/live   -> card catalog: name, rarity, tags, images
//   GET /api/v1/catalog/circulation  -> per-card pull/exist counts
//
// Uses cascading retries with exponential backoff - the site sits behind
// Cloudflare and occasionally 403s or drops connections.
//
// Usage: node fetch-data.mjs

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://osrs-tcg.net/api/v1";
const OUT_DIR = path.dirname(fileURLToPath(import.meta.url));

const RETRIES = 6;
const BASE_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 60000;

const HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  Referer: "https://osrs-tcg.net/cards",
  Origin: "https://osrs-tcg.net",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJsonOnce(endpoint) {
  // Cloudflare caches these API responses at the edge and can serve stale
  // copies (seen: 18h old). A cache-busting query param forces an origin fetch.
  const url = `${BASE}/${endpoint}?cb=${Date.now()}`;
  const res = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`${endpoint} -> HTTP ${res.status}`);
    err.retryable = res.status === 403 || res.status === 429 || res.status >= 500;
    throw err;
  }
  return res.json();
}

const MAX_AGE_MS = 2 * 60 * 60 * 1000; // circulation should be at most 2h old

function warnIfStale(circulation) {
  const age = Date.now() - new Date(circulation.generatedAt).getTime();
  if (age > MAX_AGE_MS) {
    console.log(
      `WARNING: circulation data is ${Math.round(age / 60000)} min old ` +
        `(generatedAt=${circulation.generatedAt}) - Cloudflare served a stale copy`,
    );
  }
}

async function getJson(endpoint) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      return await getJsonOnce(endpoint);
    } catch (err) {
      lastErr = err;
      const retryable =
        err.retryable || err.name === "TimeoutError" || err.name === "AbortError" ||
        err.cause?.code === "ECONNRESET" || err.cause?.code === "ETIMEDOUT";
      if (!retryable || attempt === RETRIES) throw err;
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 1000;
      console.log(`${endpoint}: attempt ${attempt} failed (${err.message}), retrying in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

const catalog = await getJson("catalog/cards/live");
const circulation = await getJson("catalog/circulation");
warnIfStale(circulation);

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
