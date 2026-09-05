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

import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
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

// ---- full-art mirror (community full-art versions, art/full/<ULID>.<ext>) ----
// Real extension per file (sniffed): uploads are not all PNGs. build.mjs
// probes for the actual file, so the two never disagree.
// URL list: read raw_circulation.json, apply the official predicate per entry
// (pulledFoil > 0 + non-empty foilImagePath; no case-merge needed for the
// download list), dedupe by ULID. Fetch BASE + foilImagePath verbatim.
// ULID regex duplicated from build.mjs (separate processes; build.mjs
// executes on import so one cannot import the other).
const circulation = JSON.parse(await readFile(path.join(HERE, "raw_circulation.json"), "utf8"));
const fullArtByUlid = new Map(); // ULID -> signed foilImagePath (first wins)
for (const stats of Object.values(circulation.cards ?? {})) {
  if (!(Number(stats.pulledFoil) > 0)) continue;
  if (typeof stats.foilImagePath !== "string" || stats.foilImagePath.trim() === "") continue;
  const m = /\/files\/([A-Za-z0-9]+)/.exec(stats.foilImagePath);
  if (!m) continue;
  if (!fullArtByUlid.has(m[1])) fullArtByUlid.set(m[1], stats.foilImagePath);
}

// Community uploads are not all PNGs (phone-photo JPEGs seen in the wild),
// so the mirror keeps each file's real extension. List duplicated in
// build.mjs (separate processes; build.mjs executes on import so one cannot
// import the other) - the build's existence gate probes these in order.
const FULL_ART_EXTS = ["png", "jpg", "jpeg", "webp", "gif"];

async function existingFullArt(ulid) {
  for (const ext of FULL_ART_EXTS) {
    const p = path.join(ART_DIR, "full", `${ulid}.${ext}`);
    try {
      const st = await stat(p);
      return { path: p, mtimeMs: st.mtimeMs };
    } catch { /* try next extension */ }
  }
  return null;
}

// Sniff the real image type: Content-Type first, magic bytes as fallback
// (upstream has served both correctly and incorrectly labeled bytes).
function sniffFullArtExt(res, buf) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (buf.toString("latin1", 0, 6).startsWith("GIF8")) return "gif";
  return "png"; // last resort preserves the historical behavior
}

async function downloadFullArt(ulid, foilImagePath) {
  const existing = await existingFullArt(ulid);
  if (existing && Date.now() - existing.mtimeMs < REVALIDATE_AFTER_MS) {
    return { status: "skipped", rel: path.relative(HERE, existing.path).replace(/\\/g, "/") };
  }

  // Fetch verbatim (no ?cb=: the weekly-rotating token already busts caches,
  // and an extra query risks signature invalidation). downloadFile maps
  // destinations via imagePath.replace(/^\/images\/?/,...) and appends ?cb=,
  // so it must NOT be reused here: ?token= would land in the filename.
  const url = `${BASE}${foilImagePath}`;
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
      const dest = path.join(ART_DIR, "full", `${ulid}.${sniffFullArtExt(res, buf)}`);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      // Drop the orphan when a re-upload changed formats (e.g. png -> jpg).
      if (existing && existing.path !== dest) await rm(existing.path, { force: true });
      return { status: existing ? "refreshed" : "downloaded", rel: path.relative(HERE, dest).replace(/\\/g, "/") };
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

const fullArtEntries = [...fullArtByUlid.entries()];
let fullDownloaded = 0, fullRefreshed = 0, fullSkipped = 0;
const fullFailures = [];
const fullArtActual = []; // real mirror paths (with sniffed extensions)
let fullNext = 0;

async function fullWorker() {
  while (fullNext < fullArtEntries.length) {
    const [ulid, foilImagePath] = fullArtEntries[fullNext++];
    try {
      const { status, rel } = await downloadFullArt(ulid, foilImagePath);
      fullArtActual.push(rel);
      if (status === "downloaded") fullDownloaded++;
      else if (status === "refreshed") fullRefreshed++;
      else fullSkipped++;
    } catch (err) {
      fullFailures.push(`art/full/${ulid}.*: ${err.message}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, fullWorker));

await writeFile(
  path.join(HERE, "art-manifest.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      imagePaths,
      fullArtPaths: [...fullArtActual].sort(),
    },
    null,
    2,
  ),
);

console.log(
  `art: ${downloaded} downloaded, ${refreshed} refreshed, ${skipped} already present, ${failures.length} failed` +
    (failures.length ? `\n${failures.slice(0, 10).join("\n")}` : ""),
);
console.log(
  `full-art: ${fullDownloaded} downloaded, ${fullRefreshed} refreshed, ${fullSkipped} already present, ${fullFailures.length} failed of ${fullArtEntries.length} expected` +
    (fullFailures.length ? `\n${fullFailures.slice(0, 10).join("\n")}` : ""),
);
if (failures.length) process.exit(2);
// Full-art failures only log and continue - EXCEPT the run exits 2 when the
// failure rate exceeds 20% of expected (covers total outages: token rotation,
// CORP change, endpoint death). expected === 0 never exits.
if (fullArtEntries.length > 0 && fullFailures.length / fullArtEntries.length > 0.2) process.exit(2);
