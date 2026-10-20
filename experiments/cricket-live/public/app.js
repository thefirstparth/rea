// Crease client. Hash routes: #now #india #ipl #all, #india/results (the India tab at its
// results), and #m/{id}/{live|scorecard|squads|info}.
// One poll loop refreshes whatever the current route shows; renders are morphed into the DOM
// so live updates keep scroll, focus, images and open sections.

import { reviewLabel, snapshot, step } from "./alerts.js";

const POLL_MS = 15000;
const LIST_TABS = ["now", "india", "ipl", "all"];
const MATCH_TABS = ["live", "scorecard", "squads", "info"];

const S = {
  list: null, // { asOf, matches }
  listErr: null,
  match: new Map(), // id -> /api/match payload
  matchErr: new Map(),
  card: new Map(), // id -> scorecard
  cardErr: new Map(), // id -> message of the last failed scorecard load
  squad: new Map(), // id -> squads
  squadErr: new Map(),
  missing: new Set(), // ids Cricbuzz has no match for and no fixture lists
  older: new Map(), // id -> { items, inn, before, done, busy }
  open: new Map(), // id -> Set of open innings numbers (scorecard)
  squadTeam: new Map(), // id -> 0|1
  ci: new Map(), // id -> Cricinfo info, or { available: false, error?, at }
  ciComm: new Map(), // id -> { items, olderPage, older, busy, error }
  ipl: null, // Cricinfo IPL season summary (last result)
  sched: null, // { asOf, india: fixtures, ipl: { name, start, end, fixtures } }
  schedErr: null,
  openSeries: new Set(), // expanded series ids on list pages
  busy: 0,
};

// Commentary source: Cricbuzz's ball-by-ball by default; Cricinfo's live blog (which
// can run several overs behind and mixes in reader comments) when chosen.
let commSrc = "cb";
try {
  commSrc = localStorage.getItem("crease-comm") === "ci" ? "ci" : "cb";
} catch {
  // Storage blocked: keep the default.
}
const useCricinfo = (id) => commSrc === "ci" && S.ci.get(id)?.available;

// Alerts for India and IPL matches: on only after the browser grants permission.
const canAlert = "Notification" in window && "serviceWorker" in navigator;
let alertsOn = false;
try {
  alertsOn =
    canAlert &&
    Notification.permission === "granted" &&
    localStorage.getItem("crease-alerts") === "on";
} catch {
  // Storage blocked: alerts start off.
}
const alertState = new Map(); // match id -> step() state

const $ = (sel) => document.querySelector(sel);
const view = $("#view");

// ---------- utils

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

// Errors carry the HTTP status (0 when the request never reached the server) and a
// message a reader can act on, not the browser's "Failed to fetch".
async function api(path) {
  let res;
  try {
    // Never the browser's copy: a poll must show what the server has now.
    res = await fetch(path, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    throw Object.assign(
      new Error(
        navigator.onLine === false
          ? "You're offline."
          : "Couldn't reach Crease.",
      ),
      { status: 0 },
    );
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error page.
  }
  if (!res.ok)
    throw Object.assign(
      new Error(body?.error || `The server answered ${res.status}.`),
      { status: res.status },
    );
  return body;
}

// Dates and times in the UI's language (English), shaped by the reader's English
// variant when they use one; times still follow the 12/24-hour choice and time zone.
const LOCALE = /^en\b/i.test(navigator.language) ? navigator.language : "en-IN";

const dayFmt = new Intl.DateTimeFormat(LOCALE, {
  weekday: "short",
  day: "numeric",
  month: "short",
});
// Clock: the reader's choice of 12- or 24-hour times, else their locale's own.
// Every time on screen goes through these formatters.
let h12 = !!new Intl.DateTimeFormat(LOCALE, {
  hour: "numeric",
}).resolvedOptions().hour12;
try {
  const c = localStorage.getItem("crease-clock");
  if (c === "12" || c === "24") h12 = c === "12";
} catch {
  // Storage blocked: keep the locale's clock.
}
let timeFmt, fullFmt, istFmt, utcFmt;
function setClock(twelve) {
  h12 = twelve;
  const clock = {
    hour: twelve ? "numeric" : "2-digit",
    minute: "2-digit",
    hourCycle: twelve ? "h12" : "h23",
  };
  timeFmt = new Intl.DateTimeFormat(LOCALE, clock);
  fullFmt = new Intl.DateTimeFormat(LOCALE, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZoneName: "short",
    ...clock,
  });
  istFmt = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    ...clock,
  });
  // For clocks Crease shifts itself (a venue's UTC offset): format as UTC.
  utcFmt = new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", ...clock });
}
setClock(h12);

// The reader's time zone as a short label ("IST", "BST", "MESZ").
function zoneOf(ts) {
  return (
    new Intl.DateTimeFormat(LOCALE, { timeZoneName: "short" })
      .formatToParts(ts)
      .find((p) => p.type === "timeZoneName")?.value ?? ""
  );
}
const IST_OFFSET = -330;
const inIndia = (ts) => new Date(ts).getTimezoneOffset() === IST_OFFSET;

// "Thu 22 Oct, 12:30 pm IST": always says whose time it is.
const startsShort = (ts) =>
  `${dayLabel(ts)}, ${timeFmt.format(ts)} ${zoneOf(ts)}`.trim();

// The full start, plus India's time when the reader's clock is elsewhere.
const startsLong = (ts) =>
  inIndia(ts)
    ? fullFmt.format(ts)
    : `${fullFmt.format(ts)} (${istFmt.format(ts)} in India)`;

// The start on the ground's own clock, when that isn't India's: "8:00 pm" in
// Christchurch, with a sun, a setting sun or a moon for a day, day-night or night start.
// Cricbuzz gives each venue's UTC offset; India is +5:30.
const IST_MINUTES = 330;
const PART_ICON = {
  day: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3"/></svg>',
  "day-night":
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 11a4.5 4.5 0 0 1 9 0z" class="fill"/><path d="M1.5 11h13M8 3.5v1.6M3.2 5.7l1.1 1.1M12.8 5.7l-1.1 1.1"/></svg>',
  night:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 10.2A5.5 5.5 0 0 1 5.8 3a5.5 5.5 0 1 0 7.2 7.2z" class="fill"/></svg>',
};
const PART_WORDS = {
  day: "a day start",
  "day-night": "a day-night start",
  night: "a night start",
};
function venueClock(m, venue = m.venue) {
  const off = venue?.utcOffset;
  if (off == null || off === IST_MINUTES || !m.start) return null;
  const local = m.start + off * 60000;
  const hour = new Date(local).getUTCHours();
  return {
    time: utcFmt.format(local),
    place: venue.city || venue.ground || "the ground",
    part: hour < 13 ? "day" : hour < 17 ? "day-night" : "night",
  };
}

function venueTime(m) {
  const c = venueClock(m);
  if (!c) return "";
  return `<span class="lt" title="${esc(`${c.time} in ${c.place}, ${PART_WORDS[c.part]}`)}">${PART_ICON[c.part]}<span class="vh">Local time: </span>${esc(c.time)} ${esc(c.place)}</span>`;
}

// The full start for Info: the reader's time, then the ground's when it differs.
function startsAt(m, venue) {
  const c = venueClock(m, venue);
  return `${startsLong(m.start)}${c ? `; ${c.time} in ${c.place}` : ""}`;
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const diff = Math.round(
    (new Date(d).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) /
      864e5,
  );
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return dayFmt.format(d);
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)} min ago`;
}

const score = (i) => `${i.r}${i.w < 10 ? `/${i.w}` : ""}${i.dec ? "d" : ""}`;
// A no-break space: "28.3" never ends a line with "ov" on the next.
const oversTxt = (o) => (o ? `${o}\u00a0ov` : "");

function flag(t, lg = false) {
  const cls = `flag${lg ? " lg" : ""}`;
  if (t?.flag)
    return `<img class="${cls}" src="${esc(t.flag)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`;
  return `<span class="${cls} mono" aria-hidden="true">${esc((t?.short || "").slice(0, 3))}</span>`;
}

// Short state word for the status track.
function stateWord(m) {
  const s = m.state || "";
  if (/in progress/i.test(s))
    return m.format === "TEST"
      ? (m.status.match(/Day \d+/)?.[0] ?? "Live")
      : "Live";
  return s.replace(/ Break$/i, "");
}

function loser(m) {
  if (m.phase !== "done") return null;
  if (m.status.startsWith(`${m.t1.name} won`)) return m.t2.id;
  if (m.status.startsWith(`${m.t2.name} won`)) return m.t1.id;
  return null;
}

// Match is on but no ball is being bowled: stumps, meal breaks, rain.
const PAUSED = /stumps|lunch|tea|dinner|break|rain|drinks|bad light|delay|wet/i;
const paused = (m) => m.phase === "live" && PAUSED.test(m.state || "");
const liveBadge = (m) =>
  paused(m)
    ? `<span class="live paused"><i></i>${esc(stateWord(m))}</span>`
    : '<span class="live"><i></i>Live</span>';

// The tangerine label stuck on a sticker card: live, the pause (Stumps, Lunch), or the countdown.
function stateSticker(m) {
  if (m.phase === "live")
    return paused(m)
      ? `<span class="stk">${esc(stateWord(m))}</span>`
      : '<span class="stk"><i></i>Live</span>';
  if (m.phase === "upcoming" && m.start)
    return `<span class="stk">${esc(countdown(m.start))}</span>`;
  return "";
}

// Team colours, by Cricbuzz short name, that tint the top of a page. India leads when India
// play; otherwise the home side (listed first). Unknown teams leave the page untinted.
const TEAM_COLOR = {
  IND: "#1f5fd6",
  AUS: "#f2b705",
  RSA: "#007749",
  ENG: "#1d3c8f",
  NZ: "#3a3a3a",
  PAK: "#01411c",
  SL: "#0033a0",
  BAN: "#006a4e",
  WI: "#7a1f3d",
  AFG: "#0066b3",
  IRE: "#169b62",
  ZIM: "#d21034",
  NED: "#f36c21",
  CSK: "#f9cd05",
  MI: "#004ba0",
  RCB: "#d1171b",
  KKR: "#3a225d",
  SRH: "#f26522",
  RR: "#ea1a85",
  DC: "#17449b",
  PBKS: "#d71920",
  GT: "#1b2133",
  LSG: "#0057a8",
};
const LIST_SCENE = {
  now: TEAM_COLOR.IND,
  india: TEAM_COLOR.IND,
  ipl: "#4a2fb0",
};

function sceneOf(m) {
  if (!m) return null;
  const india = [m.t1, m.t2].find((t) => /^India(\s|$)/.test(t?.name ?? ""));
  if (india) return TEAM_COLOR.IND;
  return TEAM_COLOR[m.t1?.short] ?? TEAM_COLOR[m.t2?.short] ?? null;
}

const byStartAsc = (a, b) => (a.start ?? 0) - (b.start ?? 0);
const byStartDesc = (a, b) => (b.start ?? 0) - (a.start ?? 0);

// ---------- DOM morph (keyed when every child carries data-k)

function morph(el, html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  // Indentation between tags is not content; dropping it lets keyed diffing see only elements.
  const walk = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  const blank = [];
  while (walk.nextNode())
    if (!walk.currentNode.nodeValue.trim()) blank.push(walk.currentNode);
  for (const n of blank) n.remove();
  kids(el, tpl.content);
}

function kids(a, b) {
  const next = [...b.childNodes];
  if (next.length && next.every((n) => n.nodeType === 1 && n.dataset.k)) {
    const old = new Map();
    // Snapshot: removing from a live NodeList while iterating skips nodes.
    for (const c of Array.from(a.childNodes)) {
      if (c.nodeType === 1 && c.dataset.k && !old.has(c.dataset.k))
        old.set(c.dataset.k, c);
      else c.remove();
    }
    next.forEach((y, i) => {
      const x = old.get(y.dataset.k);
      if (x) old.delete(y.dataset.k);
      const node = x ? patch(x, y) : y;
      const at = a.childNodes[i] ?? null;
      if (at !== node) a.insertBefore(node, at);
    });
    for (const x of old.values()) x.remove();
    return;
  }
  const prev = [...a.childNodes];
  next.forEach((y, i) => (prev[i] ? patch(prev[i], y) : a.appendChild(y)));
  for (let i = next.length; i < prev.length; i++) prev[i].remove();
}

function patch(x, y) {
  if (
    x.nodeType !== y.nodeType ||
    x.nodeName !== y.nodeName ||
    (x.nodeType === 1 && x.dataset.k !== y.dataset.k)
  ) {
    x.replaceWith(y);
    return y;
  }
  if (x.nodeType !== 1) {
    if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue;
    return x;
  }
  for (const { name } of Array.from(x.attributes))
    if (!y.hasAttribute(name)) x.removeAttribute(name);
  for (const { name, value } of y.attributes)
    if (x.getAttribute(name) !== value) x.setAttribute(name, value);
  kids(x, y);
  return x;
}

// ---------- routing

// Match ids are Cricbuzz's (1 to 9 digits, as the API accepts). Anything else is not
// a route: it is replaced by #now so the address bar never shows junk.
function route() {
  const h = location.hash.replace(/^#\/?/, "");
  const m = h.match(/^m\/(\d{1,9})(?:\/(\w+))?$/);
  if (m && Number(m[1]) > 0) {
    const id = String(Number(m[1]));
    const tab = MATCH_TABS.includes(m[2]) ? m[2] : "live";
    // "#m/00001/bogus" is shown as the route it resolves to, "#m/1/live".
    if (`m/${id}/${tab}` !== h)
      history.replaceState(null, "", `#m/${id}/${tab}`);
    return { kind: "match", id, tab };
  }
  if (h === "india/results")
    return { kind: "list", tab: "india", section: "results" };
  if (h && !LIST_TABS.includes(h)) history.replaceState(null, "", "#now");
  return { kind: "list", tab: LIST_TABS.includes(h) ? h : "now" };
}

// A section a route asks to be shown (#india/results): scrolled to and focused once it
// has rendered, which may be a poll later.
let reveal = null;
function revealSection() {
  if (!reveal) return;
  const el = document.getElementById(reveal);
  if (!el) {
    // Loaded, and still no such section (India have no results listed): give up.
    if (S.sched || S.schedErr) reveal = null;
    return;
  }
  reveal = null;
  el.scrollIntoView({ block: "start" });
  el.focus({ preventScroll: true });
}

let lastRouteKey = "";
let cameFromList = false;
let leaving = false; // Back was pressed and the route hasn't changed yet

function onRoute() {
  const r = route();
  const key = r.kind === "match" ? `m${r.id}` : r.tab;
  const changed = key !== lastRouteKey;
  if (r.kind === "match" && lastRouteKey && !lastRouteKey.startsWith("m"))
    cameFromList = true;
  lastRouteKey = key;
  leaving = false;
  reveal = r.section ?? null;
  if (changed) {
    view.innerHTML = "";
    window.scrollTo(0, 0);
  }
  render();
  // Another section of the same match polls on the usual cycle; it fetches now only
  // what it has never loaded.
  if (changed || lacksData(r)) refresh();
}

function lacksData(r) {
  if (r.kind !== "match") return false;
  if (r.tab === "scorecard") return !S.card.has(r.id);
  if (r.tab === "squads") return !S.squad.has(r.id);
  if (r.tab === "live") return commSrc === "ci" && !S.ciComm.has(r.id);
  return !S.ci.has(r.id);
}

// ---------- data loading

let timer = 0;
let inflight = null;
let inflightFor = "";

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(refresh, POLL_MS);
}

async function refresh(force = false) {
  // A poll for this route is already running: share it, even when forced (ten taps on
  // Refresh make one request). A poll for another route is followed by one for this.
  if (inflight)
    return inflightFor === location.hash
      ? inflight
      : inflight.then(() => refresh(force));
  inflightFor = location.hash;
  const job = poll(force);
  inflight = job;
  try {
    await job;
  } finally {
    if (inflight === job) inflight = null;
    // With alerts on, a background tab keeps polling (browsers may slow it down).
    if (!document.hidden || alertsOn) schedule();
  }
}

async function poll(force) {
  const r = route();
  S.busy++;
  view.setAttribute("aria-busy", "true");
  const jobs = [];
  if (r.kind === "list" || !S.list) jobs.push(loadList());
  if (r.kind === "list" && r.tab === "ipl" && !S.ipl) jobs.push(loadIpl());
  if (r.kind === "list" && r.tab !== "all" && schedStale())
    jobs.push(loadSched());
  if (r.kind === "match") jobs.push(...matchJobs(r, force));
  if (alertsOn && r.kind === "match") jobs.push(loadList());
  await Promise.allSettled(jobs);
  if (alertsOn) await checkAlerts(r);
  if (!--S.busy) view.removeAttribute("aria-busy");
  render();
}

const SOON = 60 * 60000;
const CI_RETRY = 60000;

// Loads for one match view: live data every poll, finished data once, and anything
// whose last load failed again on the next poll. Each resource loads at most once
// per poll (a Map keyed by resource).
function matchJobs({ id, tab }, force) {
  if (S.missing.has(id) && !force) return [];
  const want = new Map();
  const sm = summaryOf(id);
  // A scheduled match may only be known from the long-range schedule.
  if (!sm && schedStale()) want.set("sched", loadSched);
  if (tab === "squads" && due(id, force, S.squad, S.squadErr))
    want.set("squad", () => loadSquad(id));
  if (!tooEarly(id, sm, force))
    addMatchCentreJobs(want, { id, tab, force, sm });
  return [...want.values()].map((load) => load());
}

const isLive = (id) =>
  S.match.get(id)?.header.phase === "live" || summaryOf(id)?.phase === "live";

// Live data, data never loaded, and data whose last load failed are due.
const due = (id, force, data, failed = null) =>
  force || isLive(id) || !data.has(id) || !!failed?.has(id);

// More than an hour before the start Cricbuzz has no match centre: don't ask.
const tooEarly = (id, sm, force) =>
  !force &&
  !S.match.has(id) &&
  sm?.phase === "upcoming" &&
  sm.start - Date.now() > SOON;

function addMatchCentreJobs(want, { id, tab, force, sm }) {
  if (tab === "live" || due(id, force, S.match))
    want.set("match", () => loadMatch(id));
  const ci = S.ci.get(id);
  const ciRetry = ci?.error && Date.now() - ci.at > CI_RETRY;
  if (!ci || ciRetry || (force && !ci.available))
    want.set("ci", () => loadCi(id));
  if (tab === "live" && commSrc === "ci" && due(id, force, S.ciComm))
    want.set("ciComm", () => loadCiComm(id));
  // The live tab shows the batting side's fall of wickets, which only the scorecard
  // has; a match missing from the lists takes its hero scores from it too.
  const needCard = tab === "scorecard" || tab === "live" || (!sm && S.list);
  if (needCard && due(id, force, S.card, S.cardErr))
    want.set("card", () => loadCard(id));
}

// An answer that isn't the expected shape is a failure, not data to render.
function expect(ok, body) {
  if (!ok)
    throw Object.assign(new Error("Crease got an answer it couldn't read."), {
      status: 0,
    });
  return body;
}

async function loadList() {
  try {
    const body = await api("/api/matches");
    S.list = expect(Array.isArray(body?.matches), body);
    S.listErr = null;
  } catch (e) {
    S.listErr = e.message;
  }
}

// How far a live match has got: innings, then balls bowled in it.
function progress(d) {
  const last = d?.mini?.innings?.at(-1);
  return last ? last.inn * 10000 + ballsAt(last.o) : null;
}

// Cricbuzz's servers don't always agree: one answer can be a ball behind the last.
// A live score never steps back; an older answer is set aside, unless two polls in a
// row bring it (then it is a correction, and it stands).
const behindCount = new Map();
function keepNewest(id, next) {
  const prev = S.match.get(id);
  const a = progress(prev);
  const b = progress(next);
  const back = next.header.phase === "live" && a != null && b != null && b < a;
  const n = back ? (behindCount.get(id) ?? 0) + 1 : 0;
  behindCount.set(id, n);
  if (back && n < 2) return;
  S.match.set(id, next);
}

async function loadMatch(id) {
  try {
    const body = await api(`/api/match/${id}`);
    keepNewest(id, expect(!!body?.header, body));
    S.matchErr.delete(id);
  } catch (e) {
    S.matchErr.set(id, e.message);
    // No match and no fixture by that id: stop asking until the reader retries.
    if (e.status === 404 && !summaryOf(id) && S.list && S.sched)
      S.missing.add(id);
  }
}

// Failures are kept apart from data, so a failed load never stands in for the data
// and the next poll tries again.
async function loadCard(id) {
  try {
    S.card.set(id, await api(`/api/match/${id}/scorecard`));
    S.cardErr.delete(id);
  } catch (e) {
    S.cardErr.set(id, e.message);
  }
}

async function loadSquad(id) {
  try {
    S.squad.set(id, await api(`/api/match/${id}/squads`));
    S.squadErr.delete(id);
  } catch (e) {
    S.squadErr.set(id, e.message);
  }
}

async function loadCi(id) {
  try {
    S.ci.set(id, await api(`/api/match/${id}/cricinfo`));
  } catch (e) {
    // Cricinfo is an enrichment: a failure leaves the Cricbuzz view intact, and the
    // lookup is retried a minute later (matchJobs) rather than given up for good.
    if (!S.ci.get(id)?.available)
      S.ci.set(id, { available: false, error: e.message, at: Date.now() });
  }
}

async function loadCiComm(id) {
  let c = S.ciComm.get(id);
  if (!c) {
    c = { items: [], older: [], olderPage: null, busy: false, error: null };
    S.ciComm.set(id, c);
  }
  try {
    const got = await api(`/api/match/${id}/cricinfo/commentary`);
    if (!got.available) return;
    // Updated in place: an "earlier commentary" load running now keeps its busy flag.
    // Older pages already loaded keep their place; the latest pages replace the top.
    c.items = got.items;
    if (!c.older.length) c.olderPage = got.olderPage;
    c.error = null;
  } catch (e) {
    c.error = e.message;
  }
}

async function loadCiOlder(id) {
  const c = S.ciComm.get(id);
  if (!c?.olderPage || c.busy) return;
  c.busy = true;
  render();
  try {
    const got = await api(
      `/api/match/${id}/cricinfo/commentary?page=${c.olderPage}`,
    );
    c.older.push(...got.items);
    c.olderPage = got.olderPage;
    c.error = null;
  } catch (e) {
    c.error = e.message;
  }
  c.busy = false;
  render();
}

// Fixtures a year ahead change rarely; refetch every half hour, not every poll.
const schedStale = () => !S.sched || Date.now() - S.sched.asOf > 30 * 60000;

async function loadSched() {
  try {
    S.sched = await api("/api/schedule");
    S.schedErr = null;
  } catch (e) {
    S.schedErr = e.message;
  }
}

async function loadIpl() {
  try {
    S.ipl = await api("/api/ipl");
  } catch {
    // The IPL card falls back to a generic off-season note.
  }
}

async function loadOlder(id) {
  const d = S.match.get(id);
  if (!d) return;
  const o = S.older.get(id) ?? { items: [], done: false, busy: false };
  if (o.busy || o.done) return;
  const all = commentary(id);
  const last = all.at(-1);
  if (!last) return;
  o.busy = true;
  S.older.set(id, o);
  render();
  let inn = o.inn ?? last.inn ?? 1;
  let before = o.before ?? last.ts;
  try {
    let got = (
      await api(`/api/match/${id}/commentary?inn=${inn}&before=${before}`)
    ).commentary;
    // An innings ran out: step back to the end of the previous one.
    while (!got.length && inn > 1) {
      inn--;
      before = Date.now();
      got = (
        await api(`/api/match/${id}/commentary?inn=${inn}&before=${before}`)
      ).commentary;
    }
    if (!got.length) o.done = true;
    else {
      o.items.push(...got);
      const tail = got.at(-1);
      o.inn = tail.inn ?? inn;
      o.before = tail.ts;
    }
  } catch (e) {
    o.error = e.message;
  }
  o.busy = false;
  render();
}

// The chosen source's items only: while Cricinfo's first page loads there are none,
// never Cricbuzz's under Cricinfo's name.
function commentary(id) {
  const ci = useCricinfo(id)
    ? (S.ciComm.get(id) ?? { items: [], older: [] })
    : null;
  const sources = ci
    ? [ci.items, ci.older]
    : [S.match.get(id)?.commentary ?? [], S.older.get(id)?.items ?? []];
  const seen = new Set();
  const out = [];
  for (const c of sources.flat()) {
    const k = `${c.kind}${c.ts}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out.sort((a, b) => b.ts - a.ts);
}

// ---------- alerts

const followed = () =>
  (S.list?.matches ?? []).filter(
    (m) => m.tags.length && (m.phase === "live" || m.phase === "upcoming"),
  );

// Wickets and milestones need each live followed match's own payload; the open match
// already has a fresh one from this poll.
async function checkAlerts(r) {
  const open = r.kind === "match" ? r.id : null;
  const live = followed().filter(
    (m) => m.phase === "live" && String(m.id) !== open,
  );
  await Promise.allSettled(live.map((m) => loadMatch(String(m.id))));
  for (const m of followed()) {
    const id = String(m.id);
    const { state, events } = step(
      alertState.get(id),
      snapshot(m, S.match.get(id)),
    );
    alertState.set(id, state);
    for (const ev of events) showAlert(ev);
  }
}

async function showAlert(ev) {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;
  await reg.showNotification(ev.title, {
    body: ev.body,
    tag: ev.tag,
    icon: "/icon.svg",
    data: { url: `/#m/${ev.id}/live` },
  });
}

// `save` is for the reader's own choice; showing the state on load stores nothing.
function setAlerts(on, save = true) {
  alertsOn = on;
  $("#alerts").classList.toggle("on", on);
  $("#alerts").setAttribute("aria-label", on ? "Alerts: on" : "Alerts: off");
  if (save)
    try {
      localStorage.setItem("crease-alerts", on ? "on" : "off");
    } catch {
      // Storage blocked: the choice lasts for this visit only.
    }
  showAlertsSheet();
}

// A visible message (the toast is a status region, so screen readers hear it too).
let toastTimer = 0;
function say(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
}

const BLOCKED =
  "Notifications are blocked for this site. Allow them in your browser's site settings, then try again.";

function showAlertsSheet() {
  const blocked = Notification.permission === "denied";
  $("#alertsStatus").textContent = alertsOn
    ? "Alerts are on."
    : blocked
      ? BLOCKED
      : "Alerts are off.";
  $("#alertsToggle").textContent = alertsOn
    ? "Turn alerts off"
    : "Turn alerts on";
  $("#alertsToggle").disabled = !alertsOn && blocked;
}

let alertsBusy = false;
async function toggleAlerts() {
  // One change at a time: taps while permission is being asked are ignored.
  if (alertsBusy) return;
  alertsBusy = true;
  try {
    if (alertsOn) {
      setAlerts(false);
      // The worker exists only to show alerts; with them off it goes.
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.unregister();
      return say("Alerts off.");
    }
    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
    if (permission !== "granted") {
      showAlertsSheet();
      return say(BLOCKED);
    }
    await navigator.serviceWorker.register("/sw.js");
    alertState.clear();
    setAlerts(true);
    say(
      "Alerts on for India and IPL matches, while Crease is open. Turn them off from the bell.",
    );
    refresh(true);
  } finally {
    alertsBusy = false;
  }
}

// ---------- list views

function pick(tab) {
  const all = S.list?.matches ?? [];
  if (tab === "all") return all;
  if (tab === "now") return all.filter((m) => m.tags.length);
  return all.filter((m) => m.tags.includes(tab));
}

function rowScore(m, inns, isBat) {
  if (!inns.length) return "";
  const last = inns.at(-1);
  const prev =
    inns.length > 1 ? `${inns.slice(0, -1).map(score).join(" & ")} & ` : "";
  const ov = isBat ? `<small>${esc(last.o)}</small>` : "";
  // Spaces between the parts let a long two-innings score wrap.
  return `${esc(prev)}${esc(score(last))} ${ov}`;
}

function side(m, t, inns) {
  const isBat = m.phase === "live" && m.batting === t.id;
  const cls = ["side", isBat ? "bat" : "", loser(m) === t.id ? "lose" : ""]
    .join(" ")
    .trim();
  return `<div class="${cls}">${flag(t)}<span class="nm">${esc(t.name)}${isBat ? '<span class="vh"> (batting)</span>' : ""}</span><span class="sc">${rowScore(m, inns, isBat)}</span></div>`;
}

function statusTrack(m) {
  if (m.phase === "live")
    return paused(m)
      ? `${liveBadge(m)}<span>${esc(m.format)}</span>`
      : `<span class="live"><i></i>Live</span><span>${esc(stateWord(m))}</span>`;
  if (m.phase === "upcoming" && m.start)
    return `<span class="num">${esc(timeFmt.format(m.start))}</span><span>${esc(dayLabel(m.start))}</span>`;
  return `<span>${esc(m.state === "Complete" ? "Result" : m.state)}</span><span>${m.start ? esc(dayLabel(m.start)) : ""}</span>`;
}

function row(m) {
  const why =
    m.phase !== "upcoming"
      ? m.status
      : [m.desc, m.series].filter(Boolean).join(" · ");
  // Before the toss there is no commentary yet; open on match info.
  const tab = m.phase === "upcoming" ? "info" : "live";
  return `<a class="mr" data-k="r${m.id}" href="#m/${m.id}/${tab}">
    <div class="st">${statusTrack(m)}</div>
    <div class="sides">${side(m, m.t1, m.s1)}${side(m, m.t2, m.s2)}</div>
    <div class="why${m.phase === "live" ? " on" : ""}">${esc(why)}</div>
  </a>`;
}

const WEEK = 7 * 864e5;
const calDay = new Intl.DateTimeFormat(LOCALE, { day: "numeric" });
const calWeek = new Intl.DateTimeFormat(LOCALE, { weekday: "short" });
const calMonth = new Intl.DateTimeFormat(LOCALE, { month: "short" });

// A tear-off calendar date: weekday, day, month.
const calTile = (ts) =>
  ts
    ? `<span class="cal" aria-hidden="true"><small>${esc(calWeek.format(ts))}</small><b>${esc(calDay.format(ts))}</b><small>${esc(calMonth.format(ts))}</small></span>`
    : '<span class="cal" aria-hidden="true"></span>';

// A fixture inside a series or "Then" list: a calendar date, the match and city, then
// start time and ground (or the teams, when the series has more than one pairing).
// The series' next match carries its countdown as a sticker.
function fixtureRow(m, { next = false, teams = false } = {}) {
  const city = m.venue?.city || "";
  const detail = [
    m.start ? `${timeFmt.format(m.start)} ${zoneOf(m.start)}` : "",
    teams ? `${m.t1.short} v ${m.t2.short}` : m.venue?.ground || "",
  ]
    .filter(Boolean)
    .join(" · ");
  const label = [m.start ? fullFmt.format(m.start) : "", m.desc, city]
    .filter(Boolean)
    .join(", ");
  return `<a class="mr fxr${next ? " is-next" : ""}" data-k="r${m.id}" href="#m/${m.id}/info" aria-label="${esc(label)}">
    ${calTile(m.start)}
    <div class="fxm"><div class="nm">${esc([m.desc, city].filter(Boolean).join(" · "))}</div><div class="why">${esc(detail)}</div></div>
    ${next && m.start && m.start - Date.now() < WEEK ? `<span class="chip-next">${esc(countdown(m.start))}</span>` : ""}
  </a>`;
}

// Fixture rows for one series, with a small heading where the format changes
// (T20Is, then ODIs, then Tests) and the next match marked.
function fixtureList(fixtures) {
  const teams =
    new Set(fixtures.map((m) => [m.t1.name, m.t2.name].sort().join())).size > 1;
  const mixed = new Set(fixtures.map((m) => m.format)).size > 1;
  const next = fixtures.find((m) => m.phase === "upcoming");
  return fixtures
    .map((m, i) => {
      const head =
        mixed && m.format !== fixtures[i - 1]?.format
          ? `<div class="fmt-h" data-k="fh${m.id}">${esc(formatName(m.format, fixtures))}</div>`
          : "";
      return head + fixtureRow(m, { next: m === next, teams });
    })
    .join("");
}

// "T20Is · 5" for a format group within a series.
function formatName(format, fixtures) {
  const n = fixtures.filter((m) => m.format === format).length;
  const f = FORMAT_LABEL[format] ?? format;
  return `${f}${n > 1 ? "s" : ""} · ${n}`;
}

function tags(m) {
  return m.tags
    .map(
      (t) => `<span class="tag ${t}">${t === "ipl" ? "IPL" : "India"}</span>`,
    )
    .join("");
}

function heroScore(m, inns, isBat) {
  if (!inns.length)
    return m.phase === "live" ? "<small>Yet to bat</small>" : "";
  const last = inns.at(-1);
  const prev =
    inns.length > 1
      ? `<span class="prev">${esc(inns.slice(0, -1).map(score).join(" & "))} &amp;</span>`
      : "";
  const ov =
    isBat || m.phase !== "done"
      ? `<small>${esc(oversTxt(last.o))}</small>`
      : "";
  return `${prev} ${esc(score(last))} ${ov}`;
}

function hrow(m, t, inns) {
  const isBat = m.phase === "live" && m.batting === t.id;
  return `<div class="hrow${loser(m) === t.id ? " lose" : ""}">${flag(t, true)}<span class="nm">${esc(t.name)}</span><span class="sc">${heroScore(m, inns, isBat)}</span></div>`;
}

function hero(m) {
  const live = m.phase === "live";
  return `<a class="hero${live ? " is-live" : ""}${paused(m) ? " paused" : ""}" data-k="h${m.id}" href="#m/${m.id}/live">
    ${stateSticker(m)}
    <div class="meta">${tags(m)}<span>${esc([m.format, m.desc].filter(Boolean).join(" · "))}</span></div>
    <div class="rows">${hrow(m, m.t1, m.s1)}${hrow(m, m.t2, m.s2)}</div>
    <div class="status">${esc(m.status)}</div>
    <div class="dim" style="font-size:var(--t-cap);margin-top:3px">${esc(m.series)}${m.venue ? ` · ${esc(m.venue.city || m.venue.ground)}` : ""}</div>
  </a>`;
}

function skeleton(n = 2) {
  return `<div class="skel" data-k="s1"></div>${n > 1 ? '<div class="skel sm" data-k="s2"></div><div class="skel sm" data-k="s3"></div>' : ""}`;
}

const TITLES = { now: "Live now", india: "India", ipl: "IPL", all: "All live" };
const SUBS = {
  now: "India and IPL, ball by ball",
  india: "India men, plus A and U19 sides",
  ipl: "Indian Premier League",
  all: "Every match under way, including those at a break",
};
const IDLE = {
  now: "No India or IPL match is live right now.",
  india: "India aren't playing right now.",
  ipl: "No IPL match is live right now.",
};

function listView(tab) {
  if (tab === "all") return allLiveView();
  if (tab === "now") return homeView();
  if (tab === "india") return indiaView();
  return iplView();
}

const liveIn = (tab) =>
  pick(tab)
    .filter((m) => m.phase === "live")
    .sort((a, b) => b.tags.length - a.tags.length || byStartAsc(a, b));

// The page's heading, which the top bar and the document title repeat.
// Home's heading depends on the data ("Live now" or "Up next"): none until it loads,
// so it never flips from one to the other.
function headingOf(tab) {
  if (tab !== "now") return TITLES[tab];
  if (!S.list) return "";
  return liveIn("now").length ? TITLES.now : "Up next";
}

function pageHead(tab, live) {
  const title = headingOf(tab);
  if (!title)
    return `<div class="ph" data-k="ph"><h1><span class="skel line" aria-hidden="true"></span><span class="vh">Loading</span></h1><p>${esc(SUBS[tab])}</p></div>`;
  const others = pick("all").filter(
    (m) => m.phase === "live" && !m.tags.length,
  ).length;
  const sub =
    S.list && !live.length
      ? `${esc(IDLE[tab])}${others ? ` <a class="link" href="#all">${others} other match${others > 1 ? "es" : ""} live →</a>` : ""}`
      : esc(SUBS[tab]);
  return `<div class="ph" data-k="ph"><h1>${title}</h1><p>${sub}</p></div>`;
}

const liveSection = (live) =>
  live.length
    ? `<div class="sec" data-k="lh"><span>Live</span><small>${live.length} match${live.length > 1 ? "es" : ""}</small></div>${live.map(hero).join("")}`
    : "";

// Home is only what matters now: the live India or IPL match, else the soonest
// fixture of either, and that match's series. Everything else lives in its tab.
function homeView() {
  const live = liveIn("now");
  let html = pageHead("now", live);
  if (!S.list) return html + (S.listErr ? errorCard(S.listErr) : skeleton());
  html += liveSection(live);
  const next = live.length
    ? null
    : [upcoming("india")[0], upcoming("ipl")[0]]
        .filter(Boolean)
        .sort(byStartAsc)[0];
  if (next)
    html += `<div class="sec" data-k="nh"><span>Next match</span></div>${nextCard(next)}`;
  else if (!live.length)
    html +=
      !S.sched && !S.schedErr
        ? skeleton(1)
        : empty(
            "Nothing scheduled",
            "Cricbuzz lists no upcoming India or IPL matches yet.",
          );
  const focus = live[0] ?? next;
  if (focus) html += currentSeries(focus);
  return html + foot();
}

// India: the live or next match, recent results by series, and every series ahead.
function indiaView() {
  const live = liveIn("india");
  let html = pageHead("india", live);
  if (!S.list) return html + (S.listErr ? errorCard(S.listErr) : skeleton());
  html += liveSection(live);
  const fixtures = upcoming("india");
  if (!live.length && fixtures.length)
    html += `<div class="sec" data-k="nh"><span>Next match</span></div>${nextCard(fixtures[0])}`;
  html += indiaResultsSection();
  if (fixtures.length)
    html += `<div class="sec" data-k="sh"><span>Series ahead</span></div><div class="list" data-k="sl">${groupSeries(fixtures).slice(0, 12).map(seriesRow).join("")}</div>`;
  else if (!S.sched && !S.schedErr) html += skeleton(1);
  else if (!live.length)
    html += empty(
      "No India fixtures listed",
      "Cricbuzz hasn't published India's next matches yet.",
    );
  return html + foot();
}

function iplView() {
  const live = liveIn("ipl");
  let html = pageHead("ipl", live);
  if (!S.list) return html + (S.listErr ? errorCard(S.listErr) : skeleton());
  html += liveSection(live) + iplAhead(live);
  const done = pick("ipl")
    .filter((m) => m.phase === "done")
    .sort(byStartDesc)
    .slice(0, 10);
  if (done.length)
    html += `<div class="sec" data-k="rh"><span>Results</span></div><div class="list" data-k="rl">${done.map(row).join("")}</div>`;
  if (!live.length && !upcoming("ipl").length) html += iplLatest();
  return html + foot();
}

// All live order: India and IPL first, then internationals, leagues, domestic.
const TYPE_RANK = { International: 1, League: 2, Domestic: 3 };
const groupRank = (list) =>
  list.some((m) => m.tags.length) ? 0 : (TYPE_RANK[list[0].type] ?? 4);

function allLiveView() {
  let html = `<div class="ph" data-k="ph"><h1>${TITLES.all}</h1><p>${SUBS.all}</p></div>`;
  if (!S.list) return html + (S.listErr ? errorCard(S.listErr) : skeleton());
  const live = pick("all").filter((m) => m.phase === "live");
  if (!live.length)
    html += empty("Nothing is live right now", "Check back when play starts.");
  const groups = new Map();
  for (const m of live) {
    if (!groups.has(m.series)) groups.set(m.series, []);
    groups.get(m.series).push(m);
  }
  const ordered = [...groups.entries()].sort(
    (a, b) => groupRank(a[1]) - groupRank(b[1]),
  );
  for (const [series, list] of ordered)
    html += `<div class="sec"><span>${esc(series)}</span></div><div class="list">${list.map(row).join("")}</div>`;
  return html + foot();
}

// Upcoming fixtures for a tag: the near-term live feed plus the long-range schedule.
function upcoming(tag) {
  const fromSched =
    tag === "ipl" ? (S.sched?.ipl?.fixtures ?? []) : (S.sched?.india ?? []);
  const byId = new Map();
  for (const m of [...pick(tag), ...fromSched])
    if (m.phase === "upcoming" && m.tags.includes(tag) && !byId.has(m.id))
      byId.set(m.id, m);
  return [...byId.values()].sort(byStartAsc);
}

// The India side in a fixture ("India", "India A"), for its tag.
const sideOf = (m) =>
  [m.t1.name, m.t2.name].find((n) => /^India(\s|$)/.test(n)) ?? "India";

function iplAhead(live) {
  if (live.length) {
    const next = upcoming("ipl").slice(0, 10);
    return next.length
      ? `<div class="sec" data-k="ih"><span>IPL up next</span></div><div class="list" data-k="il">${next.map(row).join("")}</div>`
      : "";
  }
  const fixtures = upcoming("ipl");
  if (fixtures.length) {
    return `<div class="sec" data-k="ih"><span>Next IPL match</span></div>${nextCard(fixtures[0])}<div class="sec" data-k="if"><span>Fixtures</span><small>${fixtures.length} to play</small></div><div class="list" data-k="il">${fixtures.slice(1).map(row).join("")}</div>`;
  }
  return seasonCard();
}

// Off-season: the next IPL season as Cricbuzz lists it, before fixtures exist.
function seasonCard() {
  const season = S.sched?.ipl;
  if (!season) {
    if (!S.sched && !S.schedErr) return skeleton(1);
    if (S.schedErr || S.sched.failed.includes("ipl"))
      return empty(
        "Couldn't load the IPL calendar",
        "Cricbuzz didn't answer. Crease tries again every half hour.",
      );
    return empty(
      "No IPL season listed",
      "The next season appears here once Cricbuzz lists it.",
    );
  }
  const starts = season.start && season.start > Date.now();
  return `<div class="sec" data-k="ih"><span>IPL</span></div>
    <div class="card season" data-k="season">
      <div class="meta"><span class="tag ipl">IPL</span><span>${esc(season.name)}</span></div>
      ${starts ? `<div class="when"><span class="cd">${esc(countdown(season.start, false))}</span><span>to go</span></div>` : ""}
      <div class="kv" style="border:0;padding:8px 0 0"><span class="lbl">Season window</span>${esc(dateRange(season.start, season.end))} <span class="dim">(as listed by Cricbuzz)</span></div>
      <div class="kv" style="border:0;padding:8px 0 0"><span class="lbl">Fixtures</span>Not announced yet. They appear here as soon as Cricbuzz publishes them.</div>
    </div>`;
}

// "in 2d 4h"; with prefix false, "2d 4h" for use before "to go".
function countdown(ts, prefix = true) {
  const mins = Math.round((ts - Date.now()) / 60000);
  // Past the start and still not under way: the start is late, however Cricbuzz words it.
  if (mins < -15) return "Start delayed";
  if (mins <= 0) return "Starting";
  const h = Math.floor(mins / 60);
  const d = Math.floor(h / 24);
  const span =
    mins < 60
      ? `${mins} min`
      : h < 24
        ? `${h}h ${mins % 60}m`
        : d < 7
          ? `${d}d ${h % 24}h`
          : `${d} days`;
  return prefix ? `in ${span}` : span;
}

// "3rd T20I" already names its format; "Group C" does not.
const matchLabel = (m) => {
  const f = FORMAT_LABEL[m.format] ?? m.format;
  return f && !new RegExp(`\\b${f}`, "i").test(m.desc)
    ? `${f} · ${m.desc}`
    : m.desc;
};

const shortDate = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
});
const yearDate = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

// "Oct 22 – Nov 26"; the year appears once, at the end, when it isn't this year.
function dateRange(a, b = a) {
  if (!a) return "";
  const year = new Date(b).getFullYear();
  const end = (year === new Date().getFullYear() ? shortDate : yearDate).format(
    b,
  );
  if (shortDate.format(a) === shortDate.format(b)) return end;
  const start = (
    new Date(a).getFullYear() === year ? shortDate : yearDate
  ).format(a);
  return `${start} – ${end}`;
}

function nextCard(m) {
  const tag = m.tags.includes("ipl")
    ? '<span class="tag ipl">IPL</span>'
    : `<span class="tag india">${esc(sideOf(m))}</span>`;
  const where = m.venue
    ? [m.venue.ground, m.venue.city].filter(Boolean).join(", ")
    : "";
  const when = m.start ? startsShort(m.start) : "";
  return `<a class="hero next" data-k="n${m.id}" href="#m/${m.id}/info">
    ${stateSticker(m)}
    <div class="meta">${tag}<span>${esc(matchLabel(m))}</span></div>
    <div class="rows">${hrow(m, m.t1, [])}${hrow(m, m.t2, [])}</div>
    <div class="when"><span>${esc([when, where].filter(Boolean).join(" · "))}</span></div>
    ${venueTime(m)}
    <div class="dim" style="font-size:var(--t-cap);margin-top:4px">${esc(m.series)}</div>
  </a>`;
}

// Group fixtures by series, in order of each series' next fixture.
function groupSeries(fixtures) {
  const groups = new Map();
  for (const m of fixtures) {
    const k = m.seriesId ?? m.series;
    if (!groups.has(k))
      groups.set(k, { id: String(k), name: m.series, fixtures: [] });
    groups.get(k).fixtures.push(m);
  }
  return [...groups.values()];
}

const FORMAT_LABEL = { T20: "T20I", ODI: "ODI", TEST: "Test" };
const BILATERAL = /^(\d+(st|nd|rd|th)|One-off) (T20I|ODI|Test)$/;

// "5 T20Is · 5 ODIs · 2 Tests" for a bilateral series, "5 matches" for a tournament
// ("5 India matches" when `side` names whose games these are).
function composition(fixtures, side = "") {
  const n = fixtures.length;
  if (!fixtures.every((m) => BILATERAL.test(m.desc)))
    return `${n} ${side ? `${side} ` : ""}match${n > 1 ? "es" : ""}`;
  const counts = new Map();
  for (const m of fixtures) {
    const f = FORMAT_LABEL[m.format] ?? m.format;
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts]
    .map(([f, c]) => `${c} ${f}${c > 1 ? "s" : ""}`)
    .join(" · ");
}

const INDIA = /^India(\s|$)/;
const indiaSide = (m) => [m.t1, m.t2].find((t) => INDIA.test(t.name)) ?? null;

// India's result in a completed match: won, lost, draw (a drawn Test) or nr.
function outcome(m) {
  const lost = loser(m);
  if (!lost) return /\bdrawn?\b/i.test(m.status) ? "draw" : "nr";
  return lost === indiaSide(m)?.id ? "lost" : "won";
}

// "1st ODI" → "1"; knockouts by their stage; other tournament games by their order.
// Knockout stages first: "2nd Quarter-Final" is a QF, not match 2.
function matchNo(m, i) {
  if (/semi/i.test(m.desc)) return "SF";
  if (/quarter/i.test(m.desc)) return "QF";
  if (/final|medal/i.test(m.desc)) return "F";
  const n = m.desc.match(/^(\d+)(st|nd|rd|th)\b/);
  if (n) return n[1];
  if (/^one-off/i.test(m.desc)) return "1";
  return String(i + 1);
}

const PLURAL = { T20: "T20Is", ODI: "ODIs", TEST: "Tests" };

// India's games in a series, split by format in the order played.
function byFormat(fixtures) {
  const rows = [];
  for (const m of fixtures.filter(indiaSide)) {
    const last = rows.at(-1);
    if (last?.format === m.format) last.list.push(m);
    else rows.push({ format: m.format, list: [m] });
  }
  return rows;
}

// One format's results so far, from India's side, and who is ahead.
function countFormat({ list }) {
  const n = { won: 0, lost: 0, draw: 0, nr: 0 };
  for (const m of list) if (m.phase === "done") n[outcome(m)]++;
  const india = indiaSide(list[0]);
  const other = [list[0].t1, list[0].t2].find((t) => t !== india);
  const leader =
    n.won > n.lost
      ? india.short || "India"
      : n.lost > n.won
        ? other?.short || "Opponents"
        : "";
  return {
    ...n,
    leader,
    hi: Math.max(n.won, n.lost),
    lo: Math.min(n.won, n.lost),
    over: list.every((m) => m.phase === "done"),
  };
}

// One format's standing in words: "India won 2–1", "WI lead 2–1", "level 1–1",
// "drawn 1–1", with draws and no-results after it.
function standing(r) {
  const c = countFormat(r);
  const extra = [
    c.draw ? `${c.draw} draw${c.draw > 1 ? "s" : ""}` : "",
    c.nr ? `${c.nr} no result` : "",
  ].filter(Boolean);
  if (!c.won && !c.lost) return extra.join(", ");
  const lead = c.leader
    ? `${c.leader} ${c.over ? "won" : "lead"}`
    : c.over
      ? "drawn"
      : "level";
  return `${lead} ${c.hi}–${c.lo}${extra.length ? ` (${extra.join(", ")})` : ""}`;
}

// The same, short, for a one-line summary: "IND 2–1", "2–2 · 1 NR"; India ahead is
// marked so it can be coloured.
function standingShort(r) {
  const c = countFormat(r);
  const score =
    c.won || c.lost ? `${c.leader ? `${c.leader} ` : ""}${c.hi}–${c.lo}` : "";
  const text = [
    score,
    c.draw ? `${c.draw} draw${c.draw > 1 ? "s" : ""}` : "",
    c.nr ? `${c.nr} NR` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { text, ahead: c.won > c.lost };
}

// "T20Is: WI lead 2–1 · ODIs: IND won 2–1" across a series' formats.
function standings(fixtures) {
  return byFormat(fixtures)
    .map((r) => {
      const st = standing(r);
      return st ? `${PLURAL[r.format] ?? r.format}: ${st}` : "";
    })
    .filter(Boolean)
    .join(" · ");
}

// India's games as result chips, a row per format (see .rcr in app.css): one labelled
// image, not links. They are too small to tap reliably, and the matches beside them
// (the series' rows, home's "Then" list) open each game.
// Before a ball is bowled the chips would only repeat the fixture list: none then.
function resultChips(fixtures) {
  const rows = byFormat(fixtures);
  if (!rows.length || fixtures.every((m) => m.phase === "upcoming")) return "";
  const next = fixtures.find((m) => m.phase === "upcoming");
  const words = [];
  const html = rows.map(({ format, list }) => {
    const chips = list.map((m, i) => {
      const no = matchNo(m, i);
      let cls = "";
      let text = "";
      if (m.phase === "live") [cls, text] = ["live", "Live"];
      else if (m.phase === "upcoming")
        [cls, text] = [
          `ahead${m === next ? " next" : ""}`,
          m.start ? shortDate.format(m.start) : "TBC",
        ];
      else {
        const o = outcome(m);
        const winner = [m.t1, m.t2].find((t) => t.id !== loser(m));
        cls = o === "draw" ? "nr" : o;
        text = o === "nr" ? "NR" : o === "draw" ? "Draw" : winner.short;
      }
      const said = `${m.desc}: ${m.phase === "upcoming" ? (m.start ? startsShort(m.start) : "to come") : m.status || stateWord(m)}`;
      words.push(said);
      return `<span class="rc ${cls}"><small>${esc(no)}</small><b>${esc(text)}</b></span>`;
    });
    return `<div><span class="lbl">${esc(PLURAL[format] ?? format)}</span><span class="rcs">${chips.join("")}</span></div>`;
  });
  return `<div class="rcr" role="img" aria-label="${esc(words.join("; "))}">${html.join("")}</div>`;
}

const sameSeries = (a, b) =>
  String(a.seriesId ?? a.series) === String(b.seriesId ?? b.series);

// Every known match of `focus`'s series, freshest copy first: live list, schedule, results.
function seriesOf(focus) {
  const byId = new Map();
  for (const m of knownMatches())
    if (sameSeries(m, focus) && !byId.has(String(m.id)))
      byId.set(String(m.id), m);
  return [...byId.values()].sort(byStartAsc);
}

// Home's second card: where the live or next match sits in its series.
function currentSeries(focus) {
  const all = seriesOf(focus);
  if (all.length < 2) return "";
  const played = all.filter((m) => m.phase === "done");
  const ahead = all
    .filter((m) => m.phase !== "done" && String(m.id) !== String(focus.id))
    .slice(0, 3);
  const latest = played.at(-1);
  const record = standings(all);
  const tab = focus.tags.includes("ipl") ? "ipl" : "india";
  return `<div class="sec" data-k="csh"><span>This series</span><small>${played.length} of ${all.length} played</small></div>
    <div class="card series-now" data-k="cs">
      <div class="nm">${esc(focus.series)}</div>
      <div class="sub">${esc(dateRange(all[0].start, all.at(-1).start))} · ${esc(composition(all))}${record ? ` · ${esc(record)}` : ""}</div>
      ${resultChips(all)}
      ${latest ? `<div class="latest"><span class="lbl">Latest</span>${esc(`${latest.desc}: ${latest.status}`)}</div>` : ""}
    </div>
    ${ahead.length ? `<div class="sec" data-k="cah"><span>Then</span></div><div class="list" data-k="csl">${ahead.map((m) => fixtureRow(m)).join("")}</div>` : ""}
    <a class="to-tab" data-k="cslink" href="#${tab === "india" ? "india/results" : tab}">${tab === "ipl" ? "All IPL fixtures and results" : "India's results and every series ahead"} →</a>`;
}

// India's recent results, freshest first: the live list's finished matches, then the
// results page. Null only when nothing is known and the results page failed.
function indiaResults() {
  const byId = new Map();
  for (const m of [
    ...pick("india").filter((m) => m.phase === "done"),
    ...(S.sched?.indiaResults ?? []),
  ])
    if (!byId.has(String(m.id))) byId.set(String(m.id), m);
  const all = [...byId.values()].sort(byStartDesc);
  return all.length || S.sched?.indiaResults ? all : null;
}

function indiaResultsSection() {
  if (!S.sched && !S.schedErr) return skeleton(1);
  const results = indiaResults();
  if (!results)
    return empty(
      "Couldn't load India's results",
      "Cricbuzz didn't answer. Crease tries again every half hour.",
    );
  if (!results.length) return "";
  return `<div class="sec" id="results" tabindex="-1" data-k="rh"><span>Recent series</span></div><div class="list" data-k="rl">${groupSeries(
    results,
  )
    .map(resultsRow)
    .join("")}</div>`;
}

// A recent series in one line: its standing per format ("ODIs IND 2–1 · T20Is 2–2 ·
// 1 NR") and when it ended. It opens to the result chips and each match.
function resultsRow(g) {
  const played = g.fixtures.slice().reverse();
  const key = `r${g.id}`;
  const last = played.at(-1);
  const line = byFormat(played)
    .map((r) => {
      const st = standingShort(r);
      return st.text
        ? `<span>${esc(PLURAL[r.format] ?? r.format)} <b${st.ahead ? ' class="w"' : ""}>${esc(st.text)}</b></span>`
        : "";
    })
    .filter(Boolean)
    .join("");
  return `<details class="sr" data-k="rs${esc(g.id)}" data-series="${esc(key)}"${S.openSeries.has(key) ? " open" : ""}>
    <summary><div><div class="nm">${esc(withoutYear(g.name))}</div>${line ? `<div class="stand"><span class="vh">${esc(standings(played))}</span><span class="stand-l" aria-hidden="true">${line}</span></div>` : ""}</div>
      <div class="nx">${last.start ? esc(dayMonth(last.start)) : ""}<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></div></summary>
    <div class="sr-chips">${resultChips(played)}</div>
    ${g.fixtures.map(row).join("")}
  </details>`;
}

// "Sri Lanka tour of India, 2026" → "Sri Lanka tour of India": the dates carry the year.
const withoutYear = (name) =>
  name.replace(/,?\s+\d{4}(-\d{2,4})?$/, "") || name;

// "27 Feb", or "27 Feb 2027" when it isn't this year.
const dayMonth = (ts) =>
  (new Date(ts).getFullYear() === new Date().getFullYear()
    ? shortDate
    : yearDate
  ).format(ts);

// A series to come: its start as a calendar tile, then what it holds and when it ends.
function seriesRow(g) {
  const first = g.fixtures[0];
  const last = g.fixtures.at(-1);
  const open = S.openSeries.has(g.id);
  const until =
    last.start && dayMonth(last.start) !== dayMonth(first.start)
      ? ` · until ${dayMonth(last.start)}`
      : "";
  return `<details class="sr ahead" data-k="sr${esc(g.id)}" data-series="${esc(g.id)}"${open ? " open" : ""}>
    <summary>${calTile(first.start)}<div><div class="nm">${esc(withoutYear(g.name))}</div><div class="sub">${first.start ? `<span class="vh">From ${esc(fullFmt.format(first.start))}: </span>` : ""}${esc(composition(g.fixtures, sideOf(first)))}${esc(until)}</div></div>
      <div class="nx"><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></div></summary>
    ${fixtureList(g.fixtures)}
  </details>`;
}

// A Cricinfo team's crest; its abbreviation when Cricinfo has no logo.
function teamLogo(x) {
  if (x.logo)
    return `<img class="flag logo" src="${esc(x.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  return `<span class="flag mono" aria-hidden="true">${esc(x.short ?? "")}</span>`;
}

// The last IPL result Cricinfo lists, usually the final.
function iplLatest() {
  const m = S.ipl?.latest?.[0];
  if (!m || m.state !== "Result") return "";
  const rows = m.sides
    .map(
      (x) =>
        `<div class="side${m.winner && !x.won ? " lose" : ""}">${teamLogo(x)}<span class="nm">${esc(x.name)}</span><span class="sc" style="font-size:1rem">${esc(x.score.split(" (")[0])}</span></div>${x.score.includes(" (") ? `<div class="dim" style="font-size:var(--t-cap);margin:-2px 0 2px 30px">${esc(x.score.slice(x.score.indexOf(" (") + 1))}</div>` : ""}`,
    )
    .join("");
  const line = [
    m.winner ? `${m.winner} won` : m.state,
    m.potm ? `Player of the match: ${m.potm}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<div class="sec" data-k="iplh"><span>Last season</span><small>${m.date ? esc(yearDate.format(m.date)) : ""}</small></div>
    <div class="card" data-k="ipll"><div class="dim" style="font-size:var(--t-meta);margin-bottom:8px">${esc(m.name)}</div><div class="sides">${rows}</div>
    <div style="font-size:var(--t-meta);font-weight:650;margin-top:10px">${esc(line)}</div>
    ${m.link ? `<a class="link" style="margin-top:6px" href="${esc(m.link)}" target="_blank" rel="noopener noreferrer">Full scorecard on ESPN (opens a new tab) →</a>` : ""}</div>`;
}

function empty(title, body, rawBody = false) {
  return `<div class="empty" data-k="empty"><b>${esc(title)}</b><span>${rawBody ? body : esc(body)}</span></div>`;
}

// What failed, why, and that Crease keeps trying; the button retries now.
// Upstream messages don't always end a sentence ("Cricbuzz returned 503").
const sentence = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);

function errorCard(msg, what = "scores") {
  return `<div class="empty" data-k="err"><b class="err">Couldn't load ${esc(what)}</b><span>${esc(sentence(msg))} Crease tries again every 15 seconds.</span><span><button class="btn" type="button" data-act="retry">Try again now</button></span></div>`;
}

// Where to read about sources and privacy. How fresh the data is, and refreshing it,
// live in the top bar (freshness()).
const foot = () =>
  '<p class="foot" data-k="foot"><a class="link" href="/about.html">About &amp; privacy</a></p>';

// ---------- match view

// A fixture from the live feed or, further ahead, from the schedule.
// Every match the app knows of, freshest source first: the live list, then India's
// schedule and results, then the IPL season. Lookups by id or series read this pool.
const knownMatches = () => [
  ...(S.list?.matches ?? []),
  ...(S.sched?.india ?? []),
  ...(S.sched?.indiaResults ?? []),
  ...(S.sched?.ipl?.fixtures ?? []),
];

function summaryOf(id) {
  return knownMatches().find((m) => String(m.id) === String(id)) ?? null;
}

// Innings per team: live miniscore first, then the list feed, then the scorecard.
function teamInnings(id, h) {
  const d = S.match.get(id);
  const sm = summaryOf(id);
  const mini = d?.mini?.innings ?? [];
  if (mini.length)
    return [h.t1, h.t2].map((t) => mini.filter((i) => i.teamId === t.id));
  if (sm && (sm.s1.length || sm.s2.length)) return [sm.s1, sm.s2];
  const card = S.card.get(id)?.innings ?? [];
  return [h.t1, h.t2].map((t) =>
    card.filter((i) => i.short === t.short || i.team === t.name),
  );
}

function matchView(r) {
  const id = r.id;
  const d = S.match.get(id);
  const err = S.matchErr.get(id);
  if (!d) {
    const fixture = summaryOf(id);
    // Only a match that hasn't started shows its fixture preview; a live or finished
    // one that failed to load says so.
    if (fixture?.phase === "upcoming") return previewView(r, fixture);
    if (S.missing.has(id))
      return `${empty("We couldn't find this match", "The link may be wrong or the match was removed.")}<a class="to-tab" data-k="home" href="#now">Go to the home page →</a>`;
    return err ? errorCard(err, "this match") : skeleton(1) + skeleton();
  }
  const h = d.header;
  const sm = summaryOf(id);
  // The list may name the sides in the other order: match flags by team id.
  const flagOf = (t) =>
    [sm?.t1, sm?.t2].find((x) => x && String(x.id) === String(t.id))?.flag;
  const t1 = { ...h.t1, flag: flagOf(h.t1) };
  const t2 = { ...h.t2, flag: flagOf(h.t2) };
  const live = h.phase === "live";
  const [i1, i2] = teamInnings(id, h);
  const m = {
    ...h,
    t1,
    t2,
    s1: i1,
    s2: i2,
    batting: d.mini?.batTeam ?? sm?.batting,
  };
  const mini = d.mini;
  const eq = [];
  if (live && mini) {
    if (mini.crr)
      eq.push(`<span class="pill">Run rate <b>${esc(mini.crr)}</b></span>`);
    if (mini.target)
      eq.push(`<span class="pill">Target <b>${esc(mini.target)}</b></span>`);
    if (mini.rrr)
      eq.push(`<span class="pill">Needed rate <b>${esc(mini.rrr)}</b></span>`);
    if (mini.partnership?.b)
      eq.push(
        `<span class="pill">Partnership <b>${esc(mini.partnership.r)}</b> off ${esc(mini.partnership.b)}</span>`,
      );
  }
  const heroHtml = `<section class="mhero" data-k="mh">
    ${stateSticker(h)}
    <div class="series">${tags(h)}<span>${esc(h.series)}</span></div>
    <h1>${esc(h.t1.short)} v ${esc(h.t2.short)} · ${esc(h.desc)}</h1>
    <div class="rows">${hrow(m, t1, i1)}${hrow(m, t2, i2)}</div>
    <div class="status">${esc(h.status || (h.start ? `Starts ${startsShort(h.start)}` : ""))}</div>
    ${eq.length ? `<div class="eq">${eq.join("")}</div>` : ""}
  </section>`;
  const seg = matchTabs(id, r.tab);
  let body = "";
  if (r.tab === "live") body = liveTab(id, d);
  else if (r.tab === "scorecard") body = scorecardTab(id, h);
  else if (r.tab === "squads") body = squadsTab(id);
  else body = infoTab(id, d);
  return `${heroHtml}${seg}<div data-k="body-${r.tab}">${body}</div>${foot()}`;
}

// The first section is "Commentary" in every phase: one name for one place.
function matchTabs(id, tab) {
  const tabs = [
    ["live", "Commentary"],
    ["scorecard", "Scorecard"],
    ["squads", "Squads"],
    ["info", "Info"],
  ];
  const ti = MATCH_TABS.indexOf(tab);
  return `<div class="segbar" data-k="seg"><nav class="seg" style="--n:4;--i:${ti}" aria-label="Match sections"><i class="thumb" aria-hidden="true"></i>${tabs
    .map(
      ([k, label]) =>
        `<a href="#m/${id}/${k}" aria-current="${k === tab}">${label}</a>`,
    )
    .join("")}</nav></div>`;
}

// Before Cricbuzz opens the match centre, show what the fixture list knows.
// The page fills in on its own once the match centre opens (the poll keeps trying).
function previewView(r, m) {
  const where = m.venue
    ? [m.venue.ground, m.venue.city].filter(Boolean).join(", ")
    : "";
  const hero = `<section class="mhero" data-k="mh">
    ${stateSticker(m)}
    <div class="series">${tags(m)}<span>${esc(m.series)}</span></div>
    <h1>${esc(m.t1.short)} v ${esc(m.t2.short)} · ${esc(m.desc)}</h1>
    <div class="rows">${hrow(m, m.t1, [])}${hrow(m, m.t2, [])}</div>
    ${m.start ? `<div class="when"><span>${esc(startsShort(m.start))}</span></div>${venueTime(m)}` : ""}
  </section>`;
  const late = m.start && m.start <= Date.now();
  const start = !m.start
    ? "hasn't started"
    : late
      ? `was due to start at ${timeFmt.format(m.start)} ${zoneOf(m.start)} and hasn't begun`
      : `starts ${countdown(m.start)}`;
  let body;
  if (r.tab === "squads") body = squadsTab(r.id);
  else if (r.tab === "info")
    body = `<div class="card flush" data-k="info">${[
      ["Series", m.series],
      ["Match", matchLabel(m)],
      ["Starts", m.start ? startsAt(m) : ""],
      ["Venue", where],
    ]
      .filter(([, v]) => v)
      .map(
        ([k, v]) =>
          `<div class="kv" style="border-top:0"><span class="lbl">${esc(k)}</span>${esc(v)}</div>`,
      )
      .join("")}</div>`;
  else
    body = empty(
      "Not started yet",
      `This match ${esc(start)}. Commentary and the scorecard begin at the toss; squads appear once they're named. Meanwhile: <a class="link" href="#all">see what's live now</a> or <a class="link" href="#india/results">India's latest results</a>.`,
      true,
    );
  return `${hero}${matchTabs(r.id, r.tab)}<div data-k="body-${r.tab}">${body}</div>`;
}

// Cricbuzz's ball codes: runs ("0".."6"), "W", and extras as a letter and runs:
// "Wd" or "2Wd" (wides), "N1"/"Nb" (no-ball), "L1"/"Lb" (leg byes), "B4" (byes).
const EXTRAS = {
  wd: "Wide",
  nb: "No-ball",
  n: "No-ball",
  lb: "Leg byes",
  l: "Leg byes",
  b: "Byes",
};
function ballChip(t) {
  const v = String(t);
  const extra = v.match(/^(\d*)(wd|nb|lb|n|l|b)(\d*)$/i);
  let cls = "";
  let title = "";
  if (v === "0" || v === ".") [cls, title] = ["dot", "No run"];
  else if (/^\d*W\d*$/.test(v)) [cls, title] = ["w", "Wicket"];
  else if (extra) {
    const runs = Number(extra[1] || extra[3] || 0);
    cls = "x";
    title = `${EXTRAS[extra[2].toLowerCase()]}${runs ? `, ${runs} run${runs > 1 ? "s" : ""}` : ""}`;
  } else if (v === "4") [cls, title] = ["f4", "Four"];
  else if (v === "6") [cls, title] = ["f6", "Six"];
  else if (/^\d+$/.test(v)) title = `${v} run${v === "1" ? "" : "s"}`;
  return `<span class="b ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(v === "0" ? "•" : v)}</span>`;
}

// Column headings with their full meaning for hover, touch-and-hold and screen readers.
const COLS = {
  R: "Runs",
  B: "Balls faced",
  "4s": "Fours",
  "6s": "Sixes",
  SR: "Strike rate: runs per 100 balls",
  O: "Overs bowled",
  M: "Maidens: overs with no runs",
  W: "Wickets",
  Econ: "Economy: runs given per over",
};
const head = (first, cols) =>
  `<thead><tr><th scope="col">${first}</th>${cols.map((c) => `<th scope="col"><abbr title="${esc(COLS[c])}">${esc(c)}</abbr></th>`).join("")}</tr></thead>`;
const BAT_COLS = ["R", "B", "4s", "6s", "SR"];
const BOWL_COLS = ["O", "M", "R", "W", "Econ"];

// The same words, spelled out once below the tables.
const statKey = (extra = "") =>
  `<p class="key" data-k="key"><b>Key</b> R runs · B balls · 4s fours · 6s sixes · SR runs per 100 balls · O overs · M maiden (no-run) overs · W wickets · Econ runs per over · * on strike or bowling${extra}</p>`;

function liveTab(id, d) {
  const mini = d.mini;
  let html = "";
  // Batters and bowlers "now" only while the match is on; a finished match has its
  // scorecard instead.
  if (d.header.phase === "live" && mini && (mini.striker || mini.bowler)) {
    const bats = [mini.striker, mini.nonStriker].filter(Boolean);
    const bowls = [mini.bowler, mini.otherBowler].filter(Boolean);
    html += `<div class="card flush now" data-k="now">
      <table class="tbl">${head("Batter", BAT_COLS)}<tbody>
      ${bats.map((p, i) => `<tr class="${i === 0 ? "on" : ""}"><td><span class="who">${esc(p.name)}</span></td><td class="n hi">${p.r}</td><td class="n">${p.b}</td><td class="n">${p.f4}</td><td class="n">${p.f6}</td><td class="n">${esc(p.sr)}</td></tr>`).join("")}
      </tbody></table>
      <table class="tbl">${head("Bowler", BOWL_COLS)}<tbody>
      ${bowls.map((p, i) => `<tr class="${i === 0 ? "on" : ""}"><td><span class="who">${esc(p.name)}</span></td><td class="n">${esc(p.o)}</td><td class="n">${p.m}</td><td class="n">${p.r}</td><td class="n hi">${p.w}</td><td class="n">${esc(p.econ)}</td></tr>`).join("")}
      </tbody></table>
      ${recentOvers(mini)}
      ${mini.lastWicket ? `<div class="kv"><span class="lbl">Last wicket</span>${esc(mini.lastWicket.replace(/\s+/g, " "))}</div>` : ""}
      ${reviewsLeft(mini.reviews, d.header)}
      ${fallOfWickets(id, mini.inn)}
      ${statKey(" · Overs: • no run, W wicket, Wd wide, N no-ball, L leg byes, B byes (with the runs, as in L1)")}
    </div>`;
  }
  const ci = useCricinfo(id);
  const source = ci ? "Cricinfo" : "Cricbuzz";
  const live = d.header.phase === "live";
  const items = commentary(id);
  const quiet = !ci && live && !paused(d.header) ? quietFor(items, d.asOf) : 0;
  html += `<div class="sec" data-k="ch"><span>Commentary</span>${live && !quiet ? "<small>Updates every 15 seconds</small>" : ""}</div>`;
  if (S.ci.get(id)?.available) {
    const i = ci ? 1 : 0;
    html += `<div class="seg sub" data-k="srcseg" style="--n:2;--i:${i}" role="group" aria-label="Commentary source"><i class="thumb" aria-hidden="true"></i>
      <button type="button" data-act="src" data-src="cb" aria-pressed="${!ci}">Cricbuzz · ball by ball</button>
      <button type="button" data-act="src" data-src="ci" aria-pressed="${!!ci}">Cricinfo · live blog</button></div>`;
  }
  if (ci && live) html += behindNote(items, mini);
  if (quiet) html += quietNote(id, quiet);
  if (!items.length) {
    const waiting = ci && !S.ciComm.has(id);
    html += waiting
      ? skeleton(1)
      : empty(
          "No commentary yet",
          d.header.phase === "upcoming"
            ? "Ball-by-ball starts with the toss."
            : `${source} has no commentary for this match.`,
        );
    return html;
  }
  html += `<div class="card flush" data-k="cm-${ci ? "ci" : "cb"}"><div class="comm">${items.map(commItem).join("")}</div>${ci ? ciMore(id) : cbMore(id)}</div>`;
  return html;
}

// Minutes since Cricbuzz's newest ball, when that is long enough to suspect its feed
// stalled (an over takes about four). Both times are servers' clocks: the ball's stamp
// and when Crease fetched it.
const QUIET_MIN = 8;
function quietFor(items, asOf) {
  const ball = items.find((c) => c.kind === "ball");
  if (!ball?.ts || !asOf) return 0;
  const mins = Math.floor((asOf - ball.ts) / 60000);
  return mins >= QUIET_MIN ? mins : 0;
}

function quietNote(id, mins) {
  const other = S.ci.get(id)?.available
    ? '<button class="link" type="button" data-act="src" data-src="ci">Check Cricinfo\'s live blog</button>'
    : "";
  return `<div class="notice" data-k="quiet"><span>No new ball from Cricbuzz for ${esc(mins)} min. Play may be held up, or Cricbuzz is behind.</span>${other}</div>`;
}

// Cricinfo's live blog can run overs behind the score; say so, and offer Cricbuzz.
// Balls bowled at an over count; 31.6 and 32 are the same moment.
const ballsAt = (o) => {
  const [w, b = 0] = String(o).split(".").map(Number);
  return w * 6 + b;
};

function behindNote(items, mini) {
  const latest = items.find((c) => c.kind === "ball" && c.ball != null);
  const now = mini?.innings?.at(-1)?.o;
  if (!latest || now == null || ballsAt(now) - ballsAt(latest.ball) < 6)
    return "";
  return `<div class="notice" data-k="behind"><span>Cricinfo's blog is at over ${esc(latest.ball)}; the score is at ${esc(now)}.</span><button class="link" type="button" data-act="src" data-src="cb">Show Cricbuzz's latest balls</button></div>`;
}

// The over in progress and the one before, each on its own row. Cricbuzz lists recent
// overs oldest first; the last is the current over (complete when the overs count is
// whole), which numbers the rows.
function recentOvers(mini) {
  const overs = mini.recent.slice(-2);
  if (!overs.length) return "";
  const o = mini.innings?.at(-1)?.o;
  const current = o == null ? null : Math.ceil(ballsAt(o) / 6);
  const label = (i) => {
    const n = current == null ? 0 : current - (overs.length - 1 - i);
    if (n >= 1) return `Over ${n}`;
    return i === overs.length - 1 ? "Latest" : "Before";
  };
  return `<div class="recent">${overs
    .map(
      (balls, i) =>
        `<div class="ov"><span class="lbl">${label(i)}</span><span class="balls">${balls.map(ballChip).join("")}</span></div>`,
    )
    .join("")}</div>`;
}

// DRS reviews each side has left, when the match uses DRS.
function reviewsLeft(reviews, h) {
  if (!reviews) return "";
  const sides = reviews.map((r) => {
    const t = [h.t1, h.t2].find((x) => x.id === r.teamId);
    return `${esc(t?.short ?? "")} <b class="num">${esc(r.left)}</b>`;
  });
  return `<div class="kv"><span class="lbl">Reviews left</span>${sides.join(" · ")}</div>`;
}

// The batting innings' wickets as score chips, the latest stuck on in tangerine.
// The last wicket's batter is already named in the row above.
function fallOfWickets(id, inn) {
  const fow = S.card.get(id)?.innings?.find((i) => i.inn === inn)?.fow ?? [];
  if (!fow.length) return "";
  return `<div class="fowx"><span class="lbl">Fall of wickets</span>
    <ol>${fow.map((f, i) => `<li${i === fow.length - 1 ? ' class="last"' : ""} title="${esc(`${f.name}, ${f.over} ov`)}"><b>${esc(f.score)}</b>${esc(ordinal(f.n))}</li>`).join("")}</ol></div>`;
}

function ordinal(n) {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${(!teen && ["th", "st", "nd", "rd"][n % 10]) || "th"}`;
}

function moreButton(act, state) {
  if (state.done)
    return `<button class="more" type="button" disabled>Start of commentary</button>`;
  const label = state.busy
    ? "Loading…"
    : state.error
      ? `Couldn't load. ${esc(sentence(state.error))} Try again`
      : "Load earlier commentary";
  return `<button class="more" type="button" data-act="${act}"${state.busy ? " disabled" : ""}>${label}</button>`;
}

const cbMore = (id) => moreButton("older", S.older.get(id) ?? {});
function ciMore(id) {
  const c = S.ciComm.get(id) ?? {};
  return moreButton("ci-older", { ...c, done: !c.olderPage });
}

const LONG_NOTE = 360;

function commItem(c) {
  const k = `${c.kind}${c.ts}`;
  if (c.kind === "over") {
    return `<div class="ov-card" data-k="${k}">
      <div class="top-line"><b>End of over ${esc(c.over)}</b><span><span class="dim">${esc(c.runs)} run${c.runs === 1 ? "" : "s"} · </span><b class="num">${esc(c.team)} ${esc(c.score)}</b></span></div>
      ${c.balls.length ? `<div class="balls">${c.balls.map(ballChip).join("")}</div>` : ""}
      <div class="who">${c.bat.map((p) => `<span><b>${esc(p.name)}</b> ${esc(p.score)}</span>`).join("")}${c.bowl ? `<span><b>${esc(c.bowl.name)}</b> ${esc(c.bowl.figs)}</span>` : ""}</div>
    </div>`;
  }
  // A review being decided: Cricbuzz's note, marked until the reviewed ball is posted.
  if (c.kind === "note" && c.review?.pending)
    return `<div class="ci note rv-wait" data-k="${k}"><div class="tx"><span class="rv-h"><i></i>Review in progress</span>${c.html}</div></div>`;
  // Long notes (press conferences, previews) start folded to four lines.
  if (c.kind === "note")
    return c.html.length > LONG_NOTE
      ? `<details class="ci note long" data-k="${k}"><summary><div class="tx">${c.html}</div><span class="link more-note">Read more</span></summary></details>`
      : `<div class="ci note" data-k="${k}"><div class="tx">${c.html}</div></div>`;
  const badge =
    c.event === "four"
      ? ballChip("4")
      : c.event === "six"
        ? ballChip("6")
        : c.event === "wicket"
          ? ballChip("W")
          : "";
  const rv = c.review
    ? `<div class="rv"><b>Review</b> ${esc(reviewLabel(c.review, c.event === "wicket"))}${(c.review.notes ?? []).map((n) => `<div class="rv-note">${n}</div>`).join("")}</div>`
    : "";
  const cls = [
    "ci",
    c.event ? `ev-${c.event}` : "",
    c.review ? "ev-review" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<div class="${cls}" data-k="${k}"><div class="ball"><span>${esc(c.ball)}</span>${badge}${c.review ? '<span class="b drs" title="Decision reviewed (DRS)">DRS</span>' : ""}</div><div class="tx">${c.html}${rv}</div></div>`;
}

function scorecardTab(id, h) {
  const card = S.card.get(id);
  if (!card)
    return S.cardErr.has(id)
      ? errorCard(S.cardErr.get(id), "the scorecard")
      : skeleton();
  if (!card.innings.length)
    return empty(
      "No scorecard yet",
      h.phase === "upcoming"
        ? "The scorecard fills in once the first ball is bowled."
        : "Cricbuzz has no scorecard for this match.",
    );
  const open = S.open.get(id) ?? new Set([card.innings.at(-1).inn]);
  S.open.set(id, open);
  const liveInn = h.phase === "live" ? S.match.get(id)?.mini?.inn : null;
  const mini = S.match.get(id)?.mini;
  const onBat = new Set(
    [mini?.striker?.id, mini?.nonStriker?.id].filter(Boolean),
  );
  const lag = cardLag(card, liveInn, mini);
  return (
    lag ? `<div class="notice" data-k="lag"><span>${esc(lag)}</span></div>` : ""
  ).concat(
    card.innings
      .slice()
      .reverse()
      .map((inn) => {
        const isLive = inn.inn === liveInn;
        const bat = inn.bat
          .map((p) => {
            const notOut = !p.out || /not out|batting/i.test(p.out);
            // "batting" only while this innings is in progress; afterwards they were not out.
            const how = notOut && !isLive ? "not out" : p.out || "not out";
            return `<tr class="${isLive && onBat.has(p.id) ? "on" : ""}"><td><span class="who">${esc(p.name)}${p.c ? '<small title="Captain">(c)</small>' : ""}${p.wk ? '<small title="Wicketkeeper">(wk)</small>' : ""}</span><span class="out${notOut ? " not" : ""}">${esc(how)}</span></td><td class="n hi">${p.r}</td><td class="n">${p.b}</td><td class="n">${p.f4}</td><td class="n">${p.f6}</td><td class="n">${esc(p.sr)}</td></tr>`;
          })
          .join("");
        const bowl = inn.bowl
          .map(
            (p) =>
              `<tr><td><span class="who">${esc(p.name)}</span></td><td class="n">${esc(p.o)}</td><td class="n">${p.m}</td><td class="n">${p.r}</td><td class="n hi">${p.w}</td><td class="n">${esc(p.econ)}</td></tr>`,
          )
          .join("");
        const ex = inn.extras;
        return `<details class="inn" data-k="i${inn.inn}" data-inn="${inn.inn}"${open.has(inn.inn) ? " open" : ""}>
        <summary><div class="inn-h"><b>${esc(inn.team)}${isLive ? ' <span class="live" style="margin-left:6px"><i></i>Batting</span>' : ""}</b><span><span class="num">${esc(score(inn))}<small>${esc(oversTxt(inn.o))}</small></span><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></span></div></summary>
        <table class="tbl">${head("Batter", BAT_COLS)}<tbody>${bat}</tbody>
          <tfoot><tr><td>Extras <span class="dim" style="font-weight:500">(byes ${ex.b}, leg byes ${ex.lb}, wides ${ex.w}, no-balls ${ex.nb}${ex.p ? `, penalty ${ex.p}` : ""})</span></td><td class="n">${ex.total}</td><td colspan="4"></td></tr>
          <tr><td>Total <span class="dim" style="font-weight:500">${esc(oversTxt(inn.o))}${inn.rr ? ` · run rate ${esc(inn.rr)}` : ""}</span></td><td colspan="5" class="tot">${esc(score(inn))}</td></tr></tfoot></table>
        ${inn.yetToBat.length ? `<div class="kv"><span class="lbl">${isLive || inn.w < 10 ? "Yet to bat" : "Did not bat"}</span>${esc(inn.yetToBat.join(", "))}</div>` : ""}
        ${inn.fow.length ? `<div class="kv"><span class="lbl">Fall of wickets</span><div class="fow">${inn.fow.map((f) => `<span><b>${f.score}/${f.n}</b> ${esc(f.name)}, ${esc(f.over)} ov</span>`).join("")}</div></div>` : ""}
        <table class="tbl" style="margin-top:4px">${head("Bowler", BOWL_COLS)}<tbody>${bowl}</tbody></table>
      </details>`;
      })
      .join(""),
    statKey(" · (c) captain · (wk) wicketkeeper"),
  );
}

// Cricbuzz's scorecard page updates later than its live score; say so when they differ.
function cardLag(card, liveInn, mini) {
  const inCard = card.innings.find((i) => i.inn === liveInn);
  const now = mini?.innings?.find((i) => i.inn === liveInn);
  if (!inCard || !now || ballsAt(now.o) <= ballsAt(inCard.o)) return "";
  return `This scorecard is at ${inCard.o} ov; the live score is at ${now.o} ov. Cricbuzz's scorecard usually catches up within a minute.`;
}

function squadsTab(id) {
  const sq = S.squad.get(id);
  if (!sq)
    return S.squadErr.has(id)
      ? errorCard(S.squadErr.get(id), "squads")
      : skeleton();
  if (!sq.teams.length)
    return empty(
      "Squads not announced",
      "Cricbuzz hasn't published squads for this match yet.",
    );
  const ti = Math.min(S.squadTeam.get(id) ?? 0, sq.teams.length - 1);
  const t = sq.teams[ti];
  const seg =
    sq.teams.length > 1
      ? `<div class="seg sub" data-k="sqseg" style="--n:${sq.teams.length};--i:${ti}"><i class="thumb" aria-hidden="true"></i>${sq.teams
          .map(
            (x, i) =>
              `<button type="button" data-act="team" data-i="${i}" aria-pressed="${i === ti}">${esc(x.name)}</button>`,
          )
          .join("")}</div>`
      : "";
  const groups = t.groups
    .map(
      (g) =>
        `<div class="grp-h">${esc(g.label)} <span style="font-weight:600">· ${g.players.length}</span></div>${g.players
          .map(
            (
              p,
            ) => `<div class="pl"><img class="face" src="${esc(p.face ?? "")}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">
            <div><div class="nm">${esc(p.name)}${p.c ? '<span class="badge c" title="Captain">C</span>' : ""}${p.wk ? '<span class="badge" title="Wicketkeeper">WK</span>' : ""}${p.overseas ? '<span class="badge" title="Overseas">✈</span>' : ""}</div>
            <div class="rl">${esc([p.role, p.bat ? `${p.bat[0]}${p.bat.slice(1).toLowerCase()}-hand bat` : "", p.bowl].filter(Boolean).join(" · "))}</div></div><span></span></div>`,
          )
          .join("")}`,
    )
    .join("");
  return `${seg}<div class="card flush" data-k="sq${ti}">${groups || '<div class="kv">No players listed.</div>'}</div>`;
}

function infoTab(id, d) {
  const h = d.header;
  const sm = summaryOf(id);
  const venue = sm?.venue ?? S.card.get(id)?.venue;
  const rows = [
    ["Series", h.series],
    ["Match", [h.desc, h.format].filter(Boolean).join(" · ")],
    ["Starts", h.start ? startsAt(h, venue) : ""],
    [
      "Venue",
      venue ? [venue.ground, venue.city].filter(Boolean).join(", ") : "",
    ],
    ["Toss", h.toss],
    [h.phase === "done" ? "Result" : "Status", h.status],
  ].filter(([, v]) => v);
  return `<div class="card flush" data-k="info">${rows.map(([k, v]) => `<div class="kv" style="border-top:0"><span class="lbl">${esc(k)}</span>${esc(v)}</div>`).join("")}
    ${h.potm.map((p) => `<div class="potm"><img class="face" src="${esc(p.face ?? "")}" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'"><div><span class="kv" style="padding:0;border:0"><span class="lbl">Player of the match</span></span><b>${esc(p.name)}</b><div class="dim" style="font-size:var(--t-meta)">${esc(p.line)}</div></div></div>`).join("")}
  </div>${cricinfoInfo(id)}`;
}

const ROLE = {
  umpire: "Umpires",
  "tv umpire": "TV umpire",
  referee: "Match referee",
  "reserve umpire": "Reserve umpire",
};

// What Cricinfo adds: officials, hours of play, close of play, debuts, session notes.
function cricinfoInfo(id) {
  const ci = S.ci.get(id);
  if (!ci)
    return `<div class="sec" data-k="cih"><span>From Cricinfo</span></div>${skeleton(1)}`;
  if (!ci.available)
    return ci.error
      ? `<div class="sec" data-k="cih"><span>From Cricinfo</span></div><div class="notice" data-k="cierr"><span>Couldn't reach Cricinfo. ${esc(sentence(ci.error))} Crease tries again in a minute.</span><button class="link" type="button" data-act="retry">Try again now</button></div>`
      : "";
  const officials = new Map();
  for (const o of ci.officials) {
    const role = ROLE[o.role] ?? o.role;
    if (!officials.has(role)) officials.set(role, []);
    officials.get(role).push(o.country ? `${o.name} (${o.country})` : o.name);
  }
  const rows = [
    ["Match", ci.notes.matchnumber],
    ["Days", ci.notes.matchdays],
    ["Hours of play", ci.notes.hoursofplay],
    ...[...officials].map(([role, names]) => [role, names.join(", ")]),
    [
      "Ground",
      ci.venue
        ? [
            ci.venue.name,
            ci.venue.capacity
              ? `capacity ${ci.venue.capacity.toLocaleString()}`
              : "",
          ]
            .filter(Boolean)
            .join(" · ")
        : "",
    ],
    ["Weather", ci.weather],
    ["Live commentary", ci.notes.livecommentator],
  ].filter(([, v]) => v);
  const list = (label, items) =>
    items.length
      ? `<div class="kv"><span class="lbl">${esc(label)}</span>${items.map((t) => `<div>${esc(t)}</div>`).join("")}</div>`
      : "";
  const debuts = ci.debuts.map((t) => `${t.team}: ${t.players.join(", ")}`);
  return `<div class="sec" data-k="cih"><span>From Cricinfo</span></div>
    <div class="card flush" data-k="ciinfo">${rows.map(([k, v]) => `<div class="kv" style="border-top:0"><span class="lbl">${esc(k)}</span>${esc(v)}</div>`).join("")}
    ${list("Debuts", debuts)}${list("Close of play", ci.closeOfPlay)}${list("Latest notes", ci.milestones)}</div>
    ${ci.link ? `<a class="to-tab" data-k="cilink" href="${esc(ci.link)}" target="_blank" rel="noopener noreferrer">Open this match on ESPNcricinfo (new tab) →</a>` : ""}`;
}

// ---------- freshness (the top bar's second line)

// What the reader is looking at, how old it is, and whether it can still change:
// grey while fine, amber once a minute has passed without new data (normal polling
// and caching stay under that), red when refreshing fails, no timer when nothing will
// change (a break, a finished or unstarted match). Ages are from when Crease fetched
// the data from its source (asOf).
const FRESH_WARN = 60000;
let checking = false;

function viewData(r) {
  if (r.kind === "list") return { asOf: S.list?.asOf, err: S.listErr };
  const d = S.match.get(r.id);
  const h = d?.header ?? summaryOf(r.id);
  const still = !h
    ? ""
    : h.phase === "done"
      ? "Final"
      : h.phase === "upcoming"
        ? "Not started"
        : paused(h)
          ? stateWord(h)
          : "";
  // Before Cricbuzz opens the match centre the page is the fixture from the lists;
  // its "not found" is expected, not a failed refresh.
  if (!d) return { asOf: S.list?.asOf, err: S.listErr, still };
  // The scorecard has its own fetch time, which can trail the live score.
  if (r.tab === "scorecard")
    return { asOf: S.card.get(r.id)?.asOf, err: S.cardErr.get(r.id), still };
  return { asOf: d.asOf, err: S.matchErr.get(r.id), still };
}

const minsOld = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 1 ? `${Math.max(1, Math.round(ms / 1000))}s old` : `${m} min old`;
};

function freshness(r) {
  if (checking) return { cls: "spin", text: "Checking…" };
  const { asOf, err, still } = viewData(r);
  const offline = navigator.onLine === false;
  if (!asOf)
    return err ? { cls: "bad", text: offline ? "Offline" : "Retrying" } : null;
  // Narrow screens keep the short part: "Offline", or the data's age in red.
  if (err)
    return offline
      ? {
          cls: "bad",
          text: "Offline",
          more: ` · ${minsOld(Date.now() - asOf)}`,
        }
      : {
          cls: "bad",
          lead: "Refresh failed · ",
          text: minsOld(Date.now() - asOf),
        };
  if (still) return { cls: "", text: still, asOf };
  // On narrow screens the line drops its first word: "18s ago".
  return {
    cls: Date.now() - asOf > FRESH_WARN ? "old" : "",
    lead: "Updated ",
    text: ago(asOf),
    asOf,
  };
}

let shownAsOf = null;
function showFreshness(r) {
  const f = freshness(r);
  const line = $("#freshLine");
  line.hidden = !f;
  const words = f ? `${f.lead ?? ""}${f.text}${f.more ?? ""}` : "";
  $("#fresh").setAttribute(
    "aria-label",
    words ? `${words}. Refresh now` : "Refresh now",
  );
  if (!f) return;
  $("#freshText").innerHTML =
    `${f.lead ? `<span class="fx">${esc(f.lead)}</span>` : ""}${esc(f.text)}${f.more ? `<span class="fx">${esc(f.more)}</span>` : ""}`;
  const tick = f.asOf && shownAsOf && f.asOf !== shownAsOf;
  if (f.asOf) shownAsOf = f.asOf;
  line.className = `fresh${f.cls ? ` ${f.cls}` : ""}`;
  // New data: the dot blinks once.
  if (tick) {
    void line.offsetWidth;
    line.classList.add("tick");
  }
}

async function refreshNow() {
  if (checking) return;
  checking = true;
  render();
  try {
    await refresh(true);
  } finally {
    checking = false;
    render();
  }
}

// ---------- render

// Tints the top of the page with the view's team colour; see TEAM_COLOR.
function applyScene(r, teams) {
  const color = r.kind === "match" ? sceneOf(teams) : LIST_SCENE[r.tab];
  const root = document.documentElement.style;
  if (color) root.setProperty("--scene", color);
  else root.removeProperty("--scene");
}

function render() {
  const r = route();
  const html = r.kind === "match" ? matchView(r) : listView(r.tab);
  morph(
    view,
    `<div class="page" data-k="${r.kind === "match" ? `m${r.id}` : r.tab}">${html}</div>`,
  );

  const tabs = $("#tabs");
  const idx = r.kind === "list" ? LIST_TABS.indexOf(r.tab) : -1;
  tabs.classList.toggle("none", idx < 0);
  if (idx >= 0) tabs.style.setProperty("--ti", idx);
  for (const a of tabs.querySelectorAll("a")) {
    if (a.dataset.tab === r.tab && r.kind === "list")
      a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
    const hasLive = pick(a.dataset.tab).some((m) => m.phase === "live");
    let lv = a.querySelector(".lv");
    if (hasLive && a.dataset.tab !== "all" && !lv) {
      lv = document.createElement("b");
      lv.className = "lv";
      lv.textContent = "Live";
      a.append(lv);
    } else if (!hasLive && lv) lv.remove();
  }
  $("#back").hidden = r.kind !== "match";
  $("#brand").hidden = r.kind === "match";
  tabs.dataset.ready = "";
  const d = r.kind === "match" ? S.match.get(r.id) : null;
  const teams = d?.header ?? (r.kind === "match" ? summaryOf(r.id) : null);
  applyScene(r, teams);
  const title =
    r.kind === "match"
      ? teams
        ? `${teams.t1.short} v ${teams.t2.short}`
        : "Match"
      : headingOf(r.tab);
  $("#topTitle").textContent = title;
  showFreshness(r);
  document.title =
    r.kind === "match" && d
      ? `${title} · ${d.header.status} · Crease`
      : title
        ? `${title} · Crease`
        : "Crease";
  revealSection();
}

// ---------- events

addEventListener("hashchange", onRoute);
// The top bar turns solid once the page scrolls; the match sections' band does when it
// sticks under the bar.
function onScroll() {
  const top = $("#top");
  top.classList.toggle("solid", scrollY > 8);
  const bar = view.querySelector(".segbar");
  bar?.classList.toggle(
    "stuck",
    bar.getBoundingClientRect().top <= top.getBoundingClientRect().bottom,
  );
}
addEventListener("scroll", onScroll, { passive: true });
$("#fresh").addEventListener("click", refreshNow);

// Back online: refresh now rather than at the next poll.
addEventListener("online", () => refresh(true));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
  else if (!alertsOn) clearTimeout(timer);
});
// ---------- top bar and sheets

// An open sheet is a history entry: Back closes it instead of leaving the page.
function openSheet(id) {
  const d = $(id);
  if (d.open) return;
  d.showModal();
  history.pushState({ sheet: id }, "", location.href);
}
addEventListener("popstate", () => {
  for (const d of document.querySelectorAll("dialog.sheet[open]"))
    if (history.state?.sheet !== `#${d.id}`) d.close();
});

// Outside the sheet's box: a press that starts and ends on the backdrop. Taps on the
// sheet's own padding or gaps, or drags that end outside, keep it open.
const outside = (d, e) => {
  const r = d.getBoundingClientRect();
  return (
    e.clientX < r.left ||
    e.clientX > r.right ||
    e.clientY < r.top ||
    e.clientY > r.bottom
  );
};
for (const d of document.querySelectorAll("dialog.sheet")) {
  let downOutside = false;
  d.addEventListener("pointerdown", (e) => {
    downOutside = e.target === d && outside(d, e);
  });
  d.addEventListener("click", (e) => {
    const backdrop = downOutside && e.target === d && outside(d, e);
    downOutside = false;
    if (backdrop || e.target.closest("[data-close]")) d.close();
  });
  // However it closes (button, Escape, backdrop), its history entry goes too.
  d.addEventListener("close", () => {
    if (history.state?.sheet === `#${d.id}`) history.back();
  });
}

if (canAlert) {
  $("#alerts").hidden = false;
  setAlerts(alertsOn, false);
  $("#alerts").addEventListener("click", () => {
    showAlertsSheet();
    openSheet("#alertsSheet");
  });
  $("#alertsToggle").addEventListener("click", toggleAlerts);
  // The worker exists only to show alerts: without permission for them it goes.
  if (alertsOn) navigator.serviceWorker.register("/sw.js");
  else if (Notification.permission !== "granted")
    navigator.serviceWorker.getRegistration().then((reg) => reg?.unregister());
  // A tapped alert asks this page to open its match.
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "open" && /^#m\/\d+/.test(e.data.hash))
      location.hash = e.data.hash;
  });
}

// Theme: "light" or "dark" when chosen, otherwise the device's setting (also when
// storage holds anything else).
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
// With storage blocked the choice is kept for this visit here instead.
let themeThisVisit = "system";
function themeChoice() {
  try {
    const t = localStorage.getItem("crease-theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return themeThisVisit;
  }
}
function applyTheme() {
  const t = themeChoice();
  const dark = t === "dark" || (t === "system" && darkQuery.matches);
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  $("#themeColor").content = dark ? "#000000" : "#f3f3f5";
}
darkQuery.addEventListener("change", applyTheme);

$("#settingsBtn").addEventListener("click", () => {
  const sheet = $("#settingsSheet");
  sheet.querySelector(
    `input[name=clock][value="${h12 ? "12" : "24"}"]`,
  ).checked = true;
  sheet.querySelector(`input[name=theme][value="${themeChoice()}"]`).checked =
    true;
  openSheet("#settingsSheet");
});
$("#settingsSheet").addEventListener("change", (e) => {
  const { name, value } = e.target;
  if (name === "theme") themeThisVisit = value;
  try {
    if (name === "clock") localStorage.setItem("crease-clock", value);
    if (name === "theme")
      if (value === "system") localStorage.removeItem("crease-theme");
      else localStorage.setItem("crease-theme", value);
  } catch {
    // Storage blocked: the choice lasts for this visit only.
  }
  if (name === "clock") {
    setClock(value === "12");
    render();
  }
  if (name === "theme") applyTheme();
});

// One Back per press: a second click before the route changes is ignored.
$("#back").addEventListener("click", () => {
  if (leaving) return;
  leaving = true;
  if (cameFromList && history.length > 1) history.back();
  else location.hash = "#now";
});

// Match sections replace the history entry instead of adding one: Back leaves the
// match, not the last section. The new section starts at its top.
view.addEventListener("click", (e) => {
  const a = e.target.closest(".seg:not(.sub) a[href]");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  history.replaceState(null, "", a.getAttribute("href"));
  onRoute();
  // A stuck bar reports where it sticks, not where it sits: measure from the match
  // header above it, so the new section opens at its top.
  const hero = view.querySelector(".mhero");
  const top = hero
    ? hero.getBoundingClientRect().bottom +
      scrollY -
      $("#top").getBoundingClientRect().bottom
    : 0;
  if (scrollY > top) scrollTo(0, top);
  onScroll();
});

view.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const r = route();
  if (btn.dataset.act === "retry") refresh(true);
  else if (btn.dataset.act === "older" && r.kind === "match") loadOlder(r.id);
  else if (btn.dataset.act === "ci-older" && r.kind === "match")
    loadCiOlder(r.id);
  else if (btn.dataset.act === "src" && r.kind === "match") {
    commSrc = btn.dataset.src === "cb" ? "cb" : "ci";
    try {
      localStorage.setItem("crease-comm", commSrc);
    } catch {
      // Storage blocked: the choice lasts for this visit only.
    }
    render();
    if (lacksData(r)) refresh();
  } else if (btn.dataset.act === "team" && r.kind === "match") {
    S.squadTeam.set(r.id, Number(btn.dataset.i));
    render();
  }
});

// Remember which innings and series are expanded so live re-renders keep them.
view.addEventListener(
  "toggle",
  (e) => {
    const el = e.target;
    if (!(el instanceof HTMLDetailsElement)) return;
    if (el.dataset.series) {
      if (el.open) S.openSeries.add(el.dataset.series);
      else S.openSeries.delete(el.dataset.series);
      return;
    }
    const r = route();
    if (!el.dataset.inn || r.kind !== "match") return;
    const set = S.open.get(r.id) ?? new Set();
    const n = Number(el.dataset.inn);
    if (el.open) set.add(n);
    else set.delete(n);
    S.open.set(r.id, set);
  },
  true,
);

// Keep relative "Updated …" text honest between polls.
setInterval(() => {
  if (!document.hidden) render();
}, 10000);

onRoute();
