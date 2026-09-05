// Downloads all card art from osrs-tcg.net into a local art/ mirror, so the
// site can serve images same-origin (osrs-tcg.net sets Cross-Origin-Resource-
// Policy: same-site, which blocks hotlinking from other sites).
//
// Incremental: files already present and fresh (< 7 days old) are skipped,
// so hourly runs only download new art. Files older than that are re-fetched
// with a cache-busting query (upstream replaces art in place and Cloudflare
// caches it, so replacements would otherwise never be picked up).
//
// Usage: node fetch-art.mjs

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART_DIR = path.join(HERE, "art");
const BASE = "https://osrs-tcg.net";

const RETRIES = 4;
const BASE_DELAY_MS = 3000;
const CONCURRENCY = 10;
// Files older than this are re-fetched (upstream art replacements +
// Cloudflare edge staleness otherwise stick forever).
const REVALIDATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  Referer: "https://osrs-tcg.net/cards",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function downloadFile(imagePath) {
  const rel = imagePath.replace(/^\/images\/?/, "/");
  const dest = path.join(ART_DIR, rel);
  let hadFile = false;
  try {
    const st = await stat(dest);
    hadFile = true;
    if (Date.now() - st.mtimeMs < REVALIDATE_AFTER_MS) return "skipped";
  } catch { /* missing: download below */ }

  // Cache-busting query forces Cloudflare to serve the origin copy, so a
  // stale edge cache can't bake old bytes into our mirror (same trick as
  // fetch-data.mjs). Saved to dest without the query string.
  const url = `${BASE}${imagePath}?cb=${Date.now()}`;
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const err = new Error(`${url} -> HTTP ${res.status}`);
        err.retryable = res.status === 403 || res.status === 429 || res.status >= 500;
        throw err;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      return hadFile ? "refreshed" : "downloaded";
    } catch (err) {
      lastErr = err;
      const retryable =
        err.retryable || err.name === "TimeoutError" || err.name === "AbortError" ||
        err.cause?.code === "ECONNRESET" || err.cause?.code === "ETIMEDOUT";
      if (!retryable || attempt === RETRIES) throw err;
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}

const catalog = JSON.parse(await readFile(path.join(HERE, "raw_catalog.json"), "utf8"));
const imagePaths = [
  ...new Set([
    ...catalog.items.map((i) => i.imagePath),
    ...catalog.npcs.map((i) => i.imagePath),
    "/images/background/osrs_card_pile_perspective_bg.jpg", // page background
  ].filter(Boolean)),
];

let downloaded = 0, refreshed = 0, skipped = 0;
const failures = [];
let next = 0;

async function worker() {
  while (next < imagePaths.length) {
    const imagePath = imagePaths[next++];
    try {
      const result = await downloadFile(imagePath);
      if (result === "downloaded") downloaded++;
      else if (result === "refreshed") refreshed++;
      else skipped++;
    } catch (err) {
      failures.push(`${imagePath}: ${err.message}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

await writeFile(
  path.join(HERE, "art-manifest.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), imagePaths }, null, 2),
);

console.log(
  `art: ${downloaded} downloaded, ${refreshed} refreshed, ${skipped} already present, ${failures.length} failed` +
    (failures.length ? `\n${failures.slice(0, 10).join("\n")}` : ""),
);
if (failures.length) process.exit(2);
