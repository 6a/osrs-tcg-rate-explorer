# Full-Art Stars — Implementation Plan

Status: VALID — approved by independent review round 5 (zero blocking issues; 3 nits folded in). Ready for implementation.

## 1. Goal

Per table row, show a gold star (★) next to the Item/NPC kind tag when a
community full-art version of that card exists. Hovering the star shows the
full art in the hover preview. Everything is derived hourly from public
upstream data — no hardcoded card lists, ever.

## 2. Verified facts (two independent probes, 2026-09-05)

- The official `/cards` "Full art only" toggle is a **pure client-side
  filter** over the already-fetched `GET /api/v1/catalog/circulation`
  payload. No extra request fires on toggle (confirmed via CDP network
  capture AND bundle code).
- Official predicate (verbatim from their bundle): a card counts iff
  `Number(pulledFoil) > 0 && typeof foilImagePath === "string" &&
  foilImagePath.trim() !== ""`. We mirror this predicate exactly.
- Full-art entries carry `foilImagePath` (signed artwork URL),
  `artistName`, `artistColor`, `artistUrl` alongside the normal counts.
  Example: `"Chicken": {..., "foilImagePath":
  "/api/v1/artwork/files/01M0VVM1Z4H3X9CGYY616WQZDR?token=MTc4OTIwMjE1Mw...."}`.
- Count today: **146 of 5,209** circulation entries.
- Only *pulled* full arts surface (predicate requires `pulledFoil > 0`), so
  the set grows as new arts get pulled — matches the expected dynamic
  behavior. Unpulled approved arts are invisible to us (accepted limitation,
  documented in FAQ).
- Image URL form: `https://osrs-tcg.net/api/v1/artwork/files/<ULID>?token=<exp>.<sig>`
  (`<exp>` = base64 expiry, ~7 days). Tokenless fetch →
  `artwork_file_forbidden`. Full bytes: `image/png` (~40–75 KB).
  `Cache-Control: private, max-age=86400`.
- `GET /api/v1/catalog/card-art` is a documented stub (`cards` always `{}`).
  No all-time-foil/total-art endpoint exists (~60 guessed routes 404).
- A public per-artist endpoint exists
  (`GET /api/v1/artwork/artists/:name`, no auth) but enumerating artists
  dynamically is unsolved — NOT used by this plan (circulation covers all
  pulled arts, which is the feature's definition).
- Same-origin rule (already established for card art): osrs-tcg.net sends
  `Cross-Origin-Resource-Policy: same-site`, so we must mirror bytes, never
  hotlink — doubly so here because tokens expire weekly.

## 3. Data flow (hourly, existing pipeline stages)

```
fetch-data.mjs          NO CHANGE (circulation already fetched; foilImagePath rides along)
      |
      v
raw_circulation.json    already contains foilImagePath per card (signed, ~7d life)
      |
      +---> build.mjs ──> data.js: per-row { fullArt: 0/1, fullArtPath: "art/full/<ULID>.png"|null }
      |                   (local mirror path only — NEVER the signed URL: data.js is
      |                    long-cached and public, tokens die in ~7 days)
      |                   CLOSED LOOP: build forces fullArt=0 when the mirror file
      |                   is absent (see §4.1) — a star can never point at a 404.
      |                   Cost: brand-new arts appear one hourly run later.
      |
      +---> fetch-art.mjs ──> art/full/<ULID>.png  (downloaded with the fresh token)
      |
      v
index.html/app.js       gold ★ next to kind tag iff fullArt; hover swaps preview src
```

NOTE on pipeline order: `publish-site.ps1` runs build BEFORE fetch-art.
The existence gate above is what makes that order safe (stars only for
bytes already mirrored). Do NOT reorder the pipeline to "fix" this — the
gate is the fix.

## 4. File-by-file changes

### 4.1 `build.mjs`
- In `circMerged` construction (currently merges only the 4 numeric fields):
  carry `foilImagePath` as first-non-empty-wins, explicitly:
  `if (!prev.foilImagePath && stats.foilImagePath) prev.foilImagePath = stats.foilImagePath;`
  (a Hoop-Snake-style case split where the first-seen variant lacks the path
  must not lose the star). Predicate runs on merged `pulledFoil` + merged path.
- In `rowFrom(e, stats)`, compute from `stats` (and, for split-tracked NPC
  rows, from the resolved `npc:{id}` entry the same way `highestFoilCondition`
  is resolved today — hook art off that same re-resolved `stats` object):
  `fullArt = (stats.pulledFoil > 0 && typeof stats.foilImagePath === "string" && stats.foilImagePath.trim() !== "") ? 1 : 0`
- `fullArtPath = fullArt ? "art/full/<ULID>.png" : null`, where ULID is
  extracted via `/\/files\/([A-Za-z0-9]+)/` on `foilImagePath`. If the regex
  misses, `fullArt = 0` (fail closed — no star pointing at a bad URL).
- SQLite: add `full_art INTEGER NOT NULL DEFAULT 0`, `full_art_path TEXT`
  columns (+ include in INSERT).
- `frontendData.cards[]`: add `fullArt`, `fullArtPath`.
- EXISTENCE GATE (closes the build-before-fetch ordering hole: the pipeline
  runs build BEFORE fetch-art, so a star must never be emitted for bytes not
  yet mirrored). After `allRows` is built, second pass with `existsSync`
  (import from `node:fs`; `build.mjs` already imports from
  `node:fs/promises`):
  `for (const r of allRows) if (r.fullArt && !existsSync(path.join(HERE, r.fullArtPath))) { r.fullArt = 0; r.fullArtPath = null; }`
  Mirror files persist in the working copy, so in steady state this changes
  nothing; on a first-ever run (empty mirror) no stars render and they appear
  from the next hourly run onward. PLACEMENT IS LOAD-BEARING: the gate must
  run immediately after `const allRows = ...sort(...)` and BEFORE
  `totalExistCards`, the SQLite INSERTs, and `frontendData` — anywhere later
  leaves dangling stars in the DB/`data.js`. Do NOT reorder the pipeline —
  the gate is the fix.
- `extraRows` (unknown-kind): apply the same computation (harmless; the
  frontend filters those rows from the table anyway). NOTE: `extraRows`
  builds its row literal inline and bypasses `rowFrom` — duplicate the
  fullArt/fullArtPath computation there explicitly.

### 4.2 `fetch-art.mjs` — separate branch (do NOT reuse `downloadFile` as-is)
- URL-list wiring (stated explicitly — the implementer must add this):
  read `raw_circulation.json`, apply the §4.1 predicate per entry
  (`pulledFoil > 0` + non-empty `foilImagePath`; no case-merge needed for the
  download list), dedupe by ULID. Fetch `BASE + foilImagePath` verbatim.
- ULID regex is duplicated one line in `build.mjs` and here with a comment
  pointing at the other copy (the two files are separate processes; one
  cannot import the other because `build.mjs` executes on import).
  `downloadFile` maps destinations via `imagePath.replace(/^\/images\/?/,…)`
  and always appends `?cb=`; applied naively, `?token=` would land in the
  filename and the extra `?cb=` risks signature invalidation. New dedicated
  path instead: extract ULID via `/\/files\/([A-Za-z0-9]+)/`, set
  `dest = art/full/<ULID>.png`, fetch verbatim (no `?cb=`; the
  weekly-rotating token already busts caches).
- Reuse the retry/backoff worker shape and the 7-day `REVALIDATE_AFTER_MS`
  check (weekly re-downloads pick up replaced artworks for free).
- **Failure semantics must split**: base-art failures keep `process.exit(2)`
  (publish aborts on `$LASTEXITCODE -ne 0`). Full-art failures only log and
  continue — EXCEPT the run exits 2 when `failures / expected > 0.2`, with
  an explicit `expected === 0 → no exit` guard (covers total outages: token
  rotation, CORP change, endpoint death — without it a 100% failure still
  logs `OK - site pushed` while serving week-stale bytes that never
  refresh).
  Expected count comes from the §4.1 predicate over the just-fetched
  circulation, so the threshold self-adjusts (including to zero).
- `art-manifest.json`: add a `fullArtPaths` key (ULID list) next to
  `imagePaths`. No deploy change: the manifest stays server-side (publish
  does not copy it) and serves as mirror-state provenance for debugging.

### 4.3 `index.html` / `app.js` / `styles.css`
- `rowHtml`: after the kind tag, emit
  `<span class="fastar" data-fullsrc="<fullArtPath>" title="Full art available">★</span>`
  iff `c.fullArt`. Escape `fullArtPath` with the existing `escapeAttr`.
- CSS (exact): `.fastar { color: #F2C94C; cursor: help; margin-left: .4rem; font-size: .84rem; font-weight: 400; }`
  (same size as the name cell, regular weight — the measurement below uses
  these exact values).
- **Column widths**: `lockColumnWidths` measures the name cell under
  `table-layout: fixed` + ellipsis clipping, so the star MUST be measured
  too or it clips. In the per-card measurement loop, fold the star into the
  `nameW` initializer (it is declared `const`, so `+=` would throw):
  `const nameW = <existing expression> + (c.fullArt ? textW('★', .84, 400) + rootPx * .4 : 0);`
  (margin-left converted via the existing `rootPx`; the star is always
  emitted inside the name cell when `fullArt` is set, so no
  tag-present/absent branch). The falsy `c.fullArt` ternary keeps stale
  payloads without the field measuring exactly as today. Re-verified by the
  existing `document.fonts.ready` re-lock with no change needed there.
- **Hover** (null-safe, fully generalized — the current code assumes the
  card-art trigger only). Mouseover delegation:
  `const trig = e.target.closest('.icon-slot,.fastar'); if (!trig) return;`
  `const src = trig.dataset.src || trig.dataset.fullsrc; if (!src) return;`
  (logical-OR, not `??`, so an empty-string attribute also falls through)
  then the existing show logic with the single shared `previewTimer`
  cleared on either trigger. Mouseout:
  `if (!e.target.closest('.icon-slot,.fastar')) return;`
  `if (e.relatedTarget?.closest?.('.icon-slot,.fastar')) return;`
  then hide (no flicker moving icon↔star within one row). Plus
  `previewImg.onerror = () => preview.style.display = 'none'` so a missing
  file hides instead of showing a broken icon.
- Stale-data safety: old cached `data.js` lacks the fields → `c.fullArt`
  undefined → falsy → no star. Degrades silently, consistent with the
  existing skew-guard philosophy.
- FAQ: one short paragraph under "How the odds are calculated" (or the
  controls section): stars mark cards with a pulled community full-art
  version; the set changes as new arts get pulled; hovering previews it.

### 4.4 `publish-site.ps1` / server `publish.ps1`
- `robocopy art /E` + `git add art` already cover a new `art/full/`
  subtree — BUT this repo's `.gitignore` contains `art/`, so a one-time
  manual check is not enough (silent success shapes: `git add` on an
  ignored path adds nothing yet exits 0, then amend+push succeed shipping
  `data.js` paths with zero bytes). Add a fail-closed guard in
  `publish-site.ps1` (mirrored to the server copy) after `git add`: count
  `"fullArt":1` rows in the just-built `data.js` (match with quotes, or
  preferably strip the `window.PULL_DATA = ...;` wrapper first and
  `JSON.parse` the payload, then count
  `cards.filter(c => c.fullArt === 1).length`); if > 0, abort (`throw`)
  unless `git ls-files --cached art/full` is non-empty AND
  `git check-ignore -q` reports the files NOT ignored (`check-ignore -q`
  signals via exit code: in PowerShell, `$LASTEXITCODE -eq 1` means NOT
  ignored — that is the passing condition; pass it a concrete mirrored
  file, e.g. the first `fullArtPath` from the just-built `data.js`, not
  the bare directory). Run the
  `check-ignore`/`ls-files` verification on the server before the first
  full-art deploy; keep the guard permanently (it self-skips when the
  expected count is 0).

## 5. Edge cases & decisions (locked)

| # | Case | Handling |
|---|------|----------|
| 1 | Token expiry | Bytes mirrored within the same hourly run that fetched them; `data.js` carries only local paths. Stale mirror files still render (last good copy) until revalidation refreshes them. |
| 2 | `foilImagePath` present but `pulledFoil == 0` | No star (mirror official predicate; observed 0 such entries). |
| 3 | ULID regex miss / malformed path | `fullArt = 0`, path null. Fail closed. |
| 4 | Case-variant keys (`Hoop Snake` vs `Hoop snake`) | First-non-empty-wins on merge; same card ⇒ same art. |
| 5 | Split item/NPC rows (`npc:{id}`) | Resolve art from the same stats object the row's counts come from. |
| 6 | Unknown-kind extra rows | Computed but never rendered (frontend filters them). No special handling. |
| 7 | Art download fails, partial or total (403/404 mid-rotation up to full outage) | Logged; run continues unless the full-art failure rate exceeds 20% of expected — at 100% (token rotation, CORP change, endpoint death) exit 2 makes publish abort loud instead of serving week-stale bytes forever. A row whose file is missing renders no star at all (existence gate), and hover `onerror` hides the preview as backstop. |
| 8 | Stale cached `data.js` (no new fields) | No stars render. No throw (existing guard + falsy checks). |
| 9 | Rate limits | Circulation already fetched hourly (limit 120); +~146 small files on first run, then missing/7d-old only, at concurrency 10. |
| 10 | `&variant=thumb` | NOT used: full PNG (~40–75 KB × 146 ≈ ≤11 MB mirror) is fine and avoids a second code path. Revisit if mirror size becomes a concern. |
| 11 | Stale `data.js` reads | Every new read (`c.fullArt`, `c.fullArtPath`) falsy-guarded; `escapeAttr` called only when a path is present. FAQ star paragraph renders regardless (harmless with zero stars). |

## 6. Testing (extends the jsdom harness at
`C:\Users\james\AppData\Local\Temp\opencode\jsdomtest\test.js` — scratch
tooling, NOT committed to the repo; run with `node test.js` in that
directory after `npm install jsdom` there; it rebuilds fixture pages from
the repo on every run)

- New assertions on the fresh page: star count equals number of `fullArt`
  rows in `data.js`; every `.fastar` has a `data-fullsrc` starting with
  `art/full/`; no star has an empty/missing src. To exercise stars locally
  (the existence gate nulls flags when the mirror is empty): derive ULIDs
  from `raw_circulation.json` via the §4.1 predicate BEFORE building, then
  `New-Item -ItemType File -Force art/full/<ULID>.png` per ULID (repo has
  no `art/` dir — bare `New-Item` will not create missing parents), THEN
  run the local `node build.mjs`, then assert star count > 0. (Deriving
  ULIDs from the just-built `data.js` would be circular — the gate would
  already have nulled them.)
- Stale fixtures: build a dedicated stale-C WITHOUT `fullArt`/`fullArtPath`
  on any card (deleting `tagGroups` alone is no longer sufficient, since
  implemented `data.js` carries the art fields) → zero stars, zero errors.
  Keep the existing stale-A (no `PULL_DATA`) guard-message verdict.
- Column-width fit for starred rows CANNOT be asserted headless (no layout
  engine) — verify visually once in a real browser that ★ never clips or
  ellipsizes the name cell.
- Syntax: `node --check` verifies exactly ONE file per invocation — run
  once per file (`node --check app.js`, `node --check build.mjs`,
  `node --check fetch-art.mjs`), never as a multi-arg single call; plus CSS
  brace balance.
- Pre-push local `node build.mjs` against local raw files to validate new
  fields end-to-end (gitignored artifacts, server rebuilds fresh).
- Post-deploy: live `data.js` range-check for `"fullArt":1` entries (with
  quotes — strip the `window.PULL_DATA = ...;` wrapper and `JSON.parse`
  the payload, then count `cards.filter(c =>
  c.fullArt === 1).length` is preferred over substring matching); live
  `app.js` contains `fastar`; spot-check one `art/full/<ULID>.png` URL
  returns 200. Follows the established verify pattern.
- The harness writes `bi_*.html`/`stalA.js` fixtures into the repo dir on
  every run: add TWO lines to the repo `.gitignore` (`bi_*.html` on one
  line, `stalA.js` on the next — a single space-separated line matches
  nothing) so fixtures can never be committed.

## 7. Rollout

0. Pre-flight on the server: `git check-ignore -v art/full/<ULID>.png`
   and `git ls-files art | Select-Object -First 10` in the `site`-branch
   checkout (feeds the §4.4 guard design; do not skip). NOTE: this is
   PowerShell — no Unix `| head`.
1. Implement §4 (code only, no manual data).
2. Full harness green + syntax clean.
3. Commit + push `main`.
4. Manual `publish.ps1` run (pulls code, fetches, builds, downloads ~146
   full arts, pushes `site`).
5. Verify per §6; confirm `art/full/` landed in the site branch.
6. Steady state: no action needed. New art BYTES land via `fetch-art` in
   the hour they are discovered, but (build-before-fetch + existence gate)
   the star itself renders starting from the NEXT hourly `build` — a
   locked-in one-run delay, not same-run.

## 8. Explicit non-goals

- Unpulled approved arts (invisible in public data by official design).
- Per-artist pages/credits beyond `title="Full art available"` (artist
  metadata stays in raw files only).
- Cache-busting `?cb=` on signed artwork URLs (signature risk; rotation
  suffices).
- Changing the existing card-art hover behavior.
