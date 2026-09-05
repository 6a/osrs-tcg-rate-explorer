const D = window.PULL_DATA;
// Version skew (stale cached data.js + fresh page, or vice versa) must never
// blank the page: missing data fails loudly in the header, a pre-Tags payload
// just renders with an empty Tags filter until the cache catches up.
if (!D || !Array.isArray(D.cards)) {
  document.getElementById('sub').textContent =
    'Data failed to load - your browser cached an old data file. Hard-refresh (Ctrl+Shift+R) to fix this.';
  throw new Error('PULL_DATA missing or stale');
}
if (!Array.isArray(D.tagGroups)) D.tagGroups = [];
// "npc:{id}" rows that failed to resolve are parser failures - hide them.
D.cards = D.cards.filter(c => c.kind !== 'unknown');
// supply-vs-pulls scarcity: pulled minus currently-existing copies (normal+foil)
D.cards.forEach(c => { c.scarcity = (c.pulledNormal + c.pulledFoil) - ((c.existNormal ?? 0) + (c.existFoil ?? 0)); });
const tbody = document.querySelector('#table tbody');
const searchEl = document.getElementById('search');
let sortKeys = (() => {
  // restore the visitor's last sort config; default is tier rank, low to high
  const DEFAULT = [{ k: 'rarity', dir: 1 }];
  try {
    const saved = JSON.parse(localStorage.getItem('tcgSort') || 'null');
    const keys = new Set([...document.querySelectorAll('th')].map(th => th.dataset.k));
    if (Array.isArray(saved) && saved.length &&
        saved.every(s => s && keys.has(s.k) && (s.dir === 1 || s.dir === -1))) return saved;
  } catch {}
  return DEFAULT;
})();
function saveSort() { try { localStorage.setItem('tcgSort', JSON.stringify(sortKeys)); } catch {} }
const defaultDir = (k) => (k === 'name' || k === 'rarity') ? 1 : -1;

// viewer's local timezone when possible, UTC fallback
function fmtGenerated() {
  const d = new Date(D.generatedAt);
  if (isNaN(d)) return 'unknown';
  try { return d.toLocaleString(undefined, { timeZoneName: 'short' }); }
  catch { return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC'); }
}
document.getElementById('sub').innerHTML =
  'Generated ' + fmtGenerated() +
  ' &middot; this site updates once per hour, on the hour';
const foilSum = D.cards.reduce((s, c) => s + c.pulledFoil, 0);
const trackedFoilRate = D.totalPulled ? foilSum / D.totalPulled : 0;
document.getElementById('foil-rate').textContent = (trackedFoilRate * 100).toFixed(2) + '%';
// All-time foil bounds, computed live (never hardcoded): the low end assumes
// no removed card was ever a foil, the high end assumes removed cards match
// the tracked rate. Stale data without the official figure degrades to tracked.
const foilLowRate = D.officialPulled ? foilSum / D.officialPulled : trackedFoilRate;
document.getElementById('foil-bounds').textContent =
  `${(foilLowRate * 100).toFixed(3)}% - ${(trackedFoilRate * 100).toFixed(3)}%`;
document.getElementById('unowned').textContent =
  D.totalExistCards != null ? (D.totalPulled - D.totalExistCards).toLocaleString() : 'unknown';

document.getElementById('stats').innerHTML = `
  <div class="stat chamfer-sm"><b>${D.cards.length.toLocaleString()}</b><span>cards</span></div>
  <div class="stat chamfer-sm"><b>${(D.officialPulled ?? D.totalPulled).toLocaleString()}</b><span>total card pulls</span></div>
  <div class="stat chamfer-sm"><b>${foilSum.toLocaleString()}</b><span>foil pulls</span></div>` +
  (D.packsOpened != null ? `<div class="stat chamfer-sm"><b>${D.packsOpened.toLocaleString()}</b><span>packs opened</span></div>` : '') +
  (D.totalExistCards != null ? `<div class="stat chamfer-sm"><b>${D.totalExistCards.toLocaleString()} / ${D.totalExistFoils.toLocaleString()}</b><span>cards / foils in circulation</span></div>` : '');

// Official tier palette, decoded from the osrs-tcg.net client bundle.
const TIER_ORDER = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic', 'Godly'];
const TIER_RANK = Object.fromEntries(TIER_ORDER.map((t, i) => [t, i]));
const COLLECTIONS = ['F2P', 'Kandarin', 'Misthalin', 'Asgarnia', 'Varlamore', 'Tirannwn',
                     'Fremennik', 'Kourend', 'Wilderness', 'Morytania', 'Sailing', 'Desert',
                     'Karamja', 'Clue'];

function fmt(n) { return n == null ? '-' : n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 2 }); }
function artSrc(c) { return c.imagePath ? 'art' + c.imagePath.replace(/^\/images\/?/, '/') : null; }
function escapeAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
// shared triangle icon (filter carets + sort indicators), ascending = flipped
const TRI = '<svg class="tri" viewBox="0 0 10 7" width="10" height="7" aria-hidden="true"><path d="M0 0H10L5 7Z" fill="currentColor"/></svg>';
const TRI_UP = '<svg class="tri up" viewBox="0 0 10 7" width="10" height="7" aria-hidden="true"><path d="M0 0H10L5 7Z" fill="currentColor"/></svg>';
function wikiUrl(c) {
  const base = 'https://oldschool.runescape.wiki/w/';
  return c.wiki ? base + encodeURIComponent(c.wiki.replace(/ /g, '_')) : null;
}

// ---- multi-select filters ----
const sel = { tier: new Set(), coll: new Set(), type: new Set(), tags: new Set() };
const countBy = (fn) => { const m = {}; for (const c of D.cards) { const v = fn(c); if (v != null) m[v] = (m[v] || 0) + 1; } return m; };
const tierCounts = countBy(c => c.rarity);
const collCounts = {}; for (const c of D.cards) for (const v of (c.collections || [])) collCounts[v] = (collCounts[v] || 0) + 1;
const tagCounts = {};
for (const c of D.cards) for (const t of (c.tags || [])) tagCounts[t] = (tagCounts[t] || 0) + 1;
const ALL_TAGS = new Set(D.tagGroups.flatMap((g) => g.tags));
const MS_DEFS = [
  { id: 'tier', emptyLabel: 'All tiers', values: TIER_ORDER.filter(t => tierCounts[t]).map(v => ({ v, l: `${v} (${tierCounts[v]})` })) },
  { id: 'coll', emptyLabel: 'All collections', values: COLLECTIONS.filter(v => collCounts[v]).map(v => ({ v, l: `${v} (${collCounts[v]})` })) },
  { id: 'type', emptyLabel: 'All types', values: [{ v: 'item', l: 'Item' }, { v: 'npc', l: 'NPC' }] },
  { id: 'tags', emptyLabel: 'All tags', groups: D.tagGroups.map((g) => ({ label: g.label, values: g.tags.filter((t) => tagCounts[t]).map((v) => ({ v, l: `${v} (${tagCounts[v]})` })) })).filter((g) => g.values.length) },
];
// ---- persisted filters: search + dropdowns are remembered between visits ----
const FILTER_KEY = 'tcgFilters';
function saveFilters() {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify({
      tier: [...sel.tier], coll: [...sel.coll], type: [...sel.type], tags: [...sel.tags], q: searchEl.value,
    }));
  } catch {}
}
function loadFilters() {
  let f;
  try { f = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null'); } catch { return; }
  if (!f || typeof f !== 'object') return;
  if (Array.isArray(f.tier)) for (const v of f.tier) if (TIER_ORDER.includes(v)) sel.tier.add(v);
  if (Array.isArray(f.coll)) for (const v of f.coll) if (COLLECTIONS.includes(v)) sel.coll.add(v);
  if (Array.isArray(f.type)) for (const v of f.type) if (v === 'item' || v === 'npc') sel.type.add(v);
  if (Array.isArray(f.tags)) for (const v of f.tags) if (ALL_TAGS.has(v)) sel.tags.add(v);
  if (typeof f.q === 'string') searchEl.value = f.q;
}
loadFilters();
const msEls = {};
for (const def of MS_DEFS) {
  const root = document.getElementById('ms-' + def.id);
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'mselect__btn';
  const menu = document.createElement('div');
  menu.className = 'mselect__menu'; menu.hidden = true;
  for (const sec of (def.groups || [{ values: def.values }])) {
    if (sec.label) {
      const h = document.createElement('div');
      h.className = 'mselect__group';
      h.textContent = sec.label;
      menu.appendChild(h);
    }
    for (const { v, l } of sec.values) {
    const opt = document.createElement('button');
    opt.type = 'button'; opt.className = 'mselect__opt'; opt.dataset.v = v;
    opt.innerHTML = `<span class="box"></span><span>${escapeAttr(l)}</span>`;
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      sel[def.id].has(v) ? sel[def.id].delete(v) : sel[def.id].add(v);
      syncMS(def.id);
      render();
    });
    menu.appendChild(opt);
    }
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    for (const other of Object.values(msEls)) if (other.menu !== menu) other.menu.hidden = true;
    menu.hidden = !menu.hidden;
    if (!menu.hidden) placeMenu(btn, menu);
  });
  root.append(btn);
  // menus live on <body>, not inside .panel: the panel's drop-shadow filter
  // would otherwise capture fixed positioning (any non-none filter becomes
  // the containing block), misplacing every menu by the panel's own offset
  document.body.appendChild(menu);
  msEls[def.id] = { btn, menu };
  syncMS(def.id);
}
function msLabel(def, v) {
  const all = def.groups ? def.groups.flatMap((g) => g.values) : def.values;
  const hit = all.find((x) => x.v === v);
  return hit ? hit.l : v;
}
function syncMS(id) {
  const def = MS_DEFS.find(d => d.id === id);
  const chosen = sel[id];
  const { btn, menu } = msEls[id];
  btn.classList.toggle('has-sel', chosen.size > 0);
  btn.innerHTML = chosen.size === 0 ? `${def.emptyLabel} ${TRI}`
    : chosen.size === 1 ? `${msLabel(def, [...chosen][0])} ${TRI}`
    : `${def.emptyLabel}: ${chosen.size} selected ${TRI}`;
  for (const opt of menu.children) opt.classList.toggle('is-selected', chosen.has(opt.dataset.v));
}
document.addEventListener('click', () => { for (const { menu } of Object.values(msEls)) menu.hidden = true; });
// menus float fixed-positioned from <body>, so anchor each one to its button
// rect on open (same width as the button, clamped into the viewport) and
// close them on any scroll/resize, when the anchor would otherwise drift away
function placeMenu(btn, menu) {
  const r = btn.getBoundingClientRect();
  menu.style.width = Math.max(0, Math.min(r.width, window.innerWidth - 16)) + 'px';
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = (r.bottom + 4) + 'px';
  menu.style.maxHeight = Math.max(140, window.innerHeight - r.bottom - 16) + 'px';
}
function closeMenus() { for (const { menu } of Object.values(msEls)) menu.hidden = true; }
window.addEventListener('scroll', closeMenus, true);
window.addEventListener('resize', closeMenus);
function toggleTier(t) { sel.tier.has(t) ? sel.tier.delete(t) : sel.tier.add(t); syncMS('tier'); render(); }

// ---- fixed filter-button widths (widest option label, so changing the
// selection never resizes the buttons or shifts the row) ----
const CARET_W = 16; // svg caret width + gap
function lockFilterWidths() {
  for (const def of MS_DEFS) {
    const all = def.groups ? def.groups.flatMap((g) => g.values) : def.values;
    let w = textW(def.emptyLabel, .9, 400) + CARET_W;
    const multi = textW(`${def.emptyLabel}: ${all.length} selected`, .9, 400) + CARET_W;
    if (multi > w) w = multi;
    for (const { l } of all) {
      const v = textW(l, .9, 400) + CARET_W;
      if (v > w) w = v;
    }
    msEls[def.id].btn.style.width = Math.ceil(w + rootPx * 1.5 + 2) + 'px';
  }
}

// Cards whose item and NPC versions are tracked separately share a name;
// tag each row so the two can be told apart.
const splitNames = new Set();
{
  const counts = {};
  D.cards.forEach(c => { if (c.kind === 'item' || c.kind === 'npc') counts[c.name.toLowerCase()] = (counts[c.name.toLowerCase()] || 0) + 1; });
  Object.entries(counts).forEach(([n, k]) => { if (k > 1) splitNames.add(n); });
}
const KIND_TAG = { item: 'Item', npc: 'NPC', 'item+npc': 'Item+NPC' };

// ---- locked column widths ----
// Measured client-side from ALL cards (not just the rendered page) so lazy
// loading the next chunks never reflows the table. Canvas measureText is
// environment-accurate (user fonts/DPI) unlike anything precomputed at build
// time; re-measured once webfonts finish loading.
const tableEl = document.getElementById('table');
const CELL_PAD = 24; // .7rem x2 cell padding + border fudge
const ARROW_W = 26;  // sort arrow + (up to 2-digit) precedence number
const TAG_EXTRA = 24; // kindtag padding + border + margin-left
const NAME_EXTRA = 43; // 34px icon slot + flex gap
const measCtx = document.createElement('canvas').getContext('2d');
const bodyFont = getComputedStyle(document.body).fontFamily;
const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
function textW(s, sizeRem, weight) {
  measCtx.font = `${weight} ${sizeRem * rootPx}px ${bodyFont}`;
  return measCtx.measureText(s).width;
}
const COL_DEFS = [
  { k: 'name', header: 'Card' },
  { k: 'rarity', header: 'Tier' },
  { k: 'pulledNormal', header: 'Pulled (normal)' },
  { k: 'pulledFoil', header: 'Pulled (foil)' },
  { k: 'pulled', header: 'Total pulled' },
  { k: 'pullRatePct', header: 'Pull rate %' },
  { k: 'oneInX', header: '1 in X' },
  { k: 'existNormal', header: 'Exist (normal)' },
  { k: 'existFoil', header: 'Exist (foil)' },
  { k: 'scarcity', header: 'Pulled - exist' },
];
function lockColumnWidths() {
  const maxes = COL_DEFS.map(() => 0);
  for (const c of D.cards) {
    const tag = KIND_TAG[c.kind] && (c.kind !== 'item+npc' || splitNames.has(c.name.toLowerCase()));
    const nameW = textW(c.name, .84, 600) + (tag ? textW(KIND_TAG[c.kind], .68, 600) + TAG_EXTRA : 0);
    if (nameW > maxes[0]) maxes[0] = nameW;
    const chipW = textW(c.rarity || '?', .84, 400);
    if (chipW > maxes[1]) maxes[1] = chipW;
    const vals = [
      c.pulledNormal.toLocaleString(),
      c.pulledFoil.toLocaleString(),
      c.pulled.toLocaleString(),
      fmt(c.pullRatePct),
      c.oneInX ? Math.round(c.oneInX).toLocaleString() : '-',
      c.existNormal == null ? '-' : c.existNormal.toLocaleString(),
      c.existFoil == null ? '-' : c.existFoil.toLocaleString(),
      (c.scarcity > 0 ? '+' : '') + c.scarcity.toLocaleString(),
    ];
    for (let i = 0; i < vals.length; i++) {
      const w = textW(vals[i], .84, 400);
      if (w > maxes[i + 2]) maxes[i + 2] = w;
    }
  }
  const widths = COL_DEFS.map((d, i) =>
    Math.ceil(Math.max(maxes[i], textW(d.header, .8, 600)) +
      (i === 0 ? NAME_EXTRA : 0) + CELL_PAD + ARROW_W));
  let cg = tableEl.querySelector('colgroup');
  if (!cg) { cg = document.createElement('colgroup'); tableEl.insertBefore(cg, tableEl.firstElementChild); }
  cg.innerHTML = widths.map(w => `<col style="width:${w}px">`).join('');
}
lockColumnWidths();
lockFilterWidths();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { lockColumnWidths(); lockFilterWidths(); });

// Rows are rendered incrementally (PAGE_SIZE at a time) so typing in the
// search box never rebuilds thousands of DOM nodes at once; the sentinel row
// loads the next chunk when it scrolls near the bottom of the table.
const PAGE_SIZE = 250;
let filtered = [];
let renderedCount = 0;
const sentinel = document.createElement('tr');
sentinel.id = 'sentinel';
sentinel.innerHTML = '<td colspan="10" style="text-align:center;color:var(--rl-muted)">loading more…</td>';
const sentinelIO = new IntersectionObserver(onSentinel, { root: document.querySelector('.tablewrap'), rootMargin: '800px' });

function onSentinel(entries) {
  for (const e of entries) {
    if (e.isIntersecting) renderMore();
  }
}

function applyFilter() {
  const q = searchEl.value.toLowerCase();
  filtered = D.cards.filter(c => {
    if (q && !c.name.toLowerCase().includes(q)) return false;
    if (sel.tier.size && !sel.tier.has(c.rarity)) return false;
    if (sel.type.size) {
      const types = c.kind === 'item+npc' ? ['item', 'npc'] : [c.kind];
      if (!types.some(t => sel.type.has(t))) return false;
    }
    if (sel.coll.size && !(c.collections || []).some(x => sel.coll.has(x))) return false;
    if (sel.tags.size && !(c.tags || []).some((t) => sel.tags.has(t))) return false;
    return true;
  });
  filtered.sort((a, b) => {
    for (const { k, dir } of sortKeys) {
      let va, vb;
      if (k === 'rarity') { va = TIER_RANK[a.rarity] ?? -1; vb = TIER_RANK[b.rarity] ?? -1; }
      else { va = a[k]; vb = b[k]; }
      const cmp = (va == null ? -1 : vb == null ? 1 : va < vb ? -1 : va > vb ? 1 : 0) * dir;
      if (cmp !== 0) return cmp;
    }
    // tie-break alphabetically by name (always ascending)
    const na = a.name.toLowerCase(), nb = b.name.toLowerCase();
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
}

function rowHtml(c) {
  const w = wikiUrl(c);
  const tag = KIND_TAG[c.kind] && (c.kind !== 'item+npc' || splitNames.has(c.name.toLowerCase()))
    ? ` <span class="kindtag">${KIND_TAG[c.kind]}</span>` : '';
  const tnameCls = c.rarity && TIER_ORDER.includes(c.rarity) ? ` tname-${c.rarity}` : '';
  const nameHtml = (w ? `<a class="tname${tnameCls}" href="${w}" target="_blank">${c.name}</a>`
                      : `<span class="tname${tnameCls}">${c.name}</span>`) + tag;
  const src = artSrc(c);
  const art = src
    ? `<span class="icon-slot" data-src="${escapeAttr(src)}"><img src="${escapeAttr(src)}" loading="lazy" decoding="async" fetchpriority="low" alt="" onerror="this.parentElement.classList.add('empty')"></span>`
    : '<span class="icon-slot empty"></span>';
  return `<tr>
    <td><span class="cardname">${art}${nameHtml}</span></td>
    <td>${c.rarity ? `<span class="tname tname-${c.rarity} rarity-chip" onclick="toggleTier('${c.rarity}')" title="Filter to ${c.rarity}">${c.rarity}</span>` : '<span style="color:var(--rl-muted)">?</span>'}</td>
    <td class="num">${c.pulledNormal.toLocaleString()}</td>
    <td class="num">${c.pulledFoil.toLocaleString()}</td>
    <td class="num">${c.pulled.toLocaleString()}</td>
    <td class="num">${fmt(c.pullRatePct)}</td>
    <td class="num">${c.oneInX ? Math.round(c.oneInX).toLocaleString() : '-'}</td>
    <td class="num">${c.existNormal == null ? '-' : c.existNormal.toLocaleString()}</td>
    <td class="num">${c.existFoil == null ? '-' : c.existFoil.toLocaleString()}</td>
    <td class="num">${(c.scarcity > 0 ? '+' : '') + c.scarcity.toLocaleString()}</td>
  </tr>`;
}

function renderMore() {
  if (renderedCount >= filtered.length) return;
  const end = Math.min(filtered.length, renderedCount + PAGE_SIZE);
  sentinel.remove();
  const chunk = filtered.slice(renderedCount, end).map(rowHtml).join('');
  tbody.insertAdjacentHTML('beforeend', chunk);
  renderedCount = end;
  if (renderedCount < filtered.length) {
    tbody.appendChild(sentinel);
    sentinelIO.observe(sentinel);
  }
}

function render() {
  saveFilters();
  applyFilter();
  updateSortIndicators();
  tbody.innerHTML = '';
  renderedCount = 0;
  renderMore();
}

// show ▲/▼ on every sorted column, with its precedence when multi-sorting
document.querySelectorAll('th').forEach(th => { th.dataset.label = th.textContent; });
function updateSortIndicators() {
  const multi = sortKeys.length > 1;
  document.querySelectorAll('th').forEach(th => {
    const i = sortKeys.findIndex(s => s.k === th.dataset.k);
    th.innerHTML = i === -1 ? th.dataset.label
      : escapeAttr(th.dataset.label) + (sortKeys[i].dir === 1 ? TRI_UP : TRI) +
        (multi ? `<sup>${i + 1}</sup>` : '');
  });
}

// click: (re)sort by that column alone; shift-click: toggle direction if
// already sorted by it, otherwise append it as a secondary sort key
document.querySelectorAll('th').forEach(th => th.addEventListener('click', (e) => {
  const k = th.dataset.k;
  const idx = sortKeys.findIndex(s => s.k === k);
  if (e.shiftKey) {
    if (idx !== -1) sortKeys[idx].dir = -sortKeys[idx].dir;
    else sortKeys.push({ k, dir: defaultDir(k) });
  } else {
    if (sortKeys.length === 1 && idx === 0) sortKeys[0].dir = -sortKeys[0].dir;
    else sortKeys = [{ k, dir: defaultDir(k) }];
  }
  saveSort();
  render();
}));
let searchTimer;
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 150);
});
render();

// 1s rainbow flash on each filter restored with an active selection;
// runs once on page load, never on filter changes
for (const def of MS_DEFS) {
  if (sel[def.id].size) {
    const btn = msEls[def.id].btn;
    btn.classList.add('flash-rainbow');
    setTimeout(() => btn.classList.remove('flash-rainbow'), 1000);
  }
}

// reset button: clear search + all filters
document.getElementById('reset-filters').addEventListener('click', () => {
  sel.tier.clear(); sel.coll.clear(); sel.type.clear(); sel.tags.clear();
  searchEl.value = '';
  for (const def of MS_DEFS) syncMS(def.id);
  render();
});

// ---- hover art preview (shows after ~1s over a card's art) ----
const preview = document.getElementById('preview');
const previewImg = preview.querySelector('img');
let previewTimer = null, mouseX = 0, mouseY = 0;
tbody.addEventListener('mousemove', (e) => { mouseX = e.clientX; mouseY = e.clientY; });
tbody.addEventListener('mouseover', (e) => {
  const slot = e.target.closest('.icon-slot');
  if (!slot || !slot.dataset.src) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewImg.src = slot.dataset.src;
    preview.style.display = 'block';
    const r = preview.getBoundingClientRect();
    let x = mouseX + 18, y = mouseY + 12;
    if (x + r.width > innerWidth - 8) x = mouseX - r.width - 18;
    if (y + r.height > innerHeight - 8) y = Math.max(8, innerHeight - r.height - 8);
    preview.style.left = x + 'px';
    preview.style.top = y + 'px';
  }, 1000);
});
tbody.addEventListener('mouseout', (e) => {
  if (!e.target.closest('.icon-slot')) return;
  clearTimeout(previewTimer);
  preview.style.display = 'none';
});
document.querySelector('.tablewrap').addEventListener('scroll', () => {
  clearTimeout(previewTimer);
  preview.style.display = 'none';
}, { passive: true });

// ---- FAQ modal ----
const faqEl = document.getElementById('faq');
document.getElementById('faq-btn').addEventListener('click', () => { faqEl.hidden = false; });
document.getElementById('faq-close').addEventListener('click', () => { faqEl.hidden = true; });
faqEl.addEventListener('click', (e) => { if (e.target === faqEl) faqEl.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') faqEl.hidden = true; });
