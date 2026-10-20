// Crease client. Hash routes: #now #india #ipl #all, and #m/{id}/{live|scorecard|squads|info}.
// One poll loop refreshes whatever the current route shows; renders are morphed into the DOM
// so live updates keep scroll, focus, images and open sections.

const POLL_MS = 15000;
const LIST_TABS = ["now", "india", "ipl", "all"];
const MATCH_TABS = ["live", "scorecard", "squads", "info"];

const S = {
  list: null, // { asOf, matches }
  listErr: null,
  match: new Map(), // id -> /api/match payload
  matchErr: new Map(),
  card: new Map(), // id -> scorecard
  squad: new Map(), // id -> squads
  older: new Map(), // id -> { items, inn, before, done, busy }
  open: new Map(), // id -> Set of open innings numbers (scorecard)
  squadTeam: new Map(), // id -> 0|1
  ci: new Map(), // id -> Cricinfo info, or { available: false }
  ciComm: new Map(), // id -> { items, olderPage, older, busy, error }
  ipl: null, // Cricinfo IPL season summary
  busy: 0,
};

// Commentary source: Cricinfo's live blog when it has the match, else Cricbuzz.
let commSrc = "ci";
try {
  commSrc = localStorage.getItem("crease-comm") === "cb" ? "cb" : "ci";
} catch {
  // Storage blocked: keep the default.
}
const useCricinfo = (id) => commSrc === "ci" && S.ci.get(id)?.available;

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

async function api(path) {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error page.
  }
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

const dayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});
const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const fullFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

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
const oversTxt = (o) => (o ? `${o} ov` : "");

function flag(t, lg = false) {
  const cls = `flag${lg ? " lg" : ""}`;
  if (t?.flag)
    return `<img class="${cls}" src="${esc(t.flag)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
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

function route() {
  const h = location.hash.replace(/^#\/?/, "");
  const m = h.match(/^m\/(\d+)(?:\/(\w+))?/);
  if (m)
    return {
      kind: "match",
      id: m[1],
      tab: MATCH_TABS.includes(m[2]) ? m[2] : "live",
    };
  return { kind: "list", tab: LIST_TABS.includes(h) ? h : "now" };
}

let lastRouteKey = "";
let cameFromList = false;

function onRoute() {
  const r = route();
  const key = r.kind === "match" ? `m${r.id}` : r.tab;
  const changed = key !== lastRouteKey;
  if (r.kind === "match" && lastRouteKey && !lastRouteKey.startsWith("m"))
    cameFromList = true;
  lastRouteKey = key;
  if (changed) {
    view.innerHTML = "";
    window.scrollTo(0, 0);
  }
  render();
  refresh();
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
  // A poll for another route is still running: follow it with one for this route.
  if (inflight && !force)
    return inflightFor === location.hash
      ? inflight
      : inflight.then(() => refresh());
  inflightFor = location.hash;
  const job = poll(force);
  inflight = job;
  try {
    await job;
  } finally {
    if (inflight === job) inflight = null;
    if (!document.hidden) schedule();
  }
}

async function poll(force) {
  const r = route();
  const spin = $("#refresh");
  S.busy++;
  spin.classList.add("spin");
  const jobs = [];
  if (r.kind === "list" || !S.list) jobs.push(loadList());
  if (r.kind === "list" && r.tab === "ipl" && !S.ipl) jobs.push(loadIpl());
  if (r.kind === "match") jobs.push(...matchJobs(r, force));
  await Promise.allSettled(jobs);
  if (!--S.busy) spin.classList.remove("spin");
  render();
}

// Loads for one match view: live data refreshes every poll, finished data once.
function matchJobs({ id, tab }, force) {
  const d = S.match.get(id);
  const fresh = (have) => force || d?.header.phase === "live" || !have;
  const jobs = [];
  if (fresh(d) || tab === "live") jobs.push(loadMatch(id));
  if (!S.ci.has(id) || (force && tab === "info")) jobs.push(loadCi(id));
  if (tab === "live" && commSrc === "ci" && fresh(S.ciComm.has(id)))
    jobs.push(loadCiComm(id));
  if (tab === "scorecard" && fresh(S.card.has(id))) jobs.push(loadCard(id));
  if (tab === "squads" && (force || !S.squad.has(id))) jobs.push(loadSquad(id));
  // Hero scores fall back to the scorecard when a match is not in the lists.
  if (!S.card.has(id) && S.list && !summaryOf(id)) jobs.push(loadCard(id));
  return jobs;
}

async function loadList() {
  try {
    S.list = await api("/api/matches");
    S.listErr = null;
  } catch (e) {
    S.listErr = e.message;
  }
}

async function loadMatch(id) {
  try {
    S.match.set(id, await api(`/api/match/${id}`));
    S.matchErr.delete(id);
  } catch (e) {
    S.matchErr.set(id, e.message);
  }
}

async function loadCard(id) {
  try {
    S.card.set(id, await api(`/api/match/${id}/scorecard`));
  } catch (e) {
    if (!S.card.has(id)) S.card.set(id, { error: e.message, innings: [] });
  }
}

async function loadSquad(id) {
  try {
    S.squad.set(id, await api(`/api/match/${id}/squads`));
  } catch (e) {
    if (!S.squad.has(id)) S.squad.set(id, { error: e.message, teams: [] });
  }
}

async function loadCi(id) {
  try {
    S.ci.set(id, await api(`/api/match/${id}/cricinfo`));
  } catch (e) {
    // Cricinfo is an enrichment: a failure leaves the Cricbuzz view intact.
    if (!S.ci.has(id)) S.ci.set(id, { available: false, error: e.message });
  }
}

async function loadCiComm(id) {
  const prev = S.ciComm.get(id) ?? { items: [], older: [], olderPage: null };
  try {
    const got = await api(`/api/match/${id}/cricinfo/commentary`);
    if (!got.available) return;
    // Older pages already loaded keep their place; the latest pages replace the top.
    S.ciComm.set(id, {
      ...prev,
      items: got.items,
      olderPage: prev.older.length ? prev.olderPage : got.olderPage,
      error: null,
    });
  } catch (e) {
    S.ciComm.set(id, { ...prev, error: e.message });
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

function commentary(id) {
  const ci = useCricinfo(id) ? S.ciComm.get(id) : null;
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
  return `${esc(prev)}${esc(score(last))}${ov}`;
}

function side(m, t, inns) {
  const isBat = m.phase === "live" && m.batting === t.id;
  const cls = ["side", isBat ? "bat" : "", loser(m) === t.id ? "lose" : ""]
    .join(" ")
    .trim();
  return `<div class="${cls}">${flag(t)}<span class="nm">${esc(t.name)}</span><span class="sc">${rowScore(m, inns, isBat)}</span></div>`;
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
  const why = m.phase === "upcoming" ? `${m.desc} · ${m.series}` : m.status;
  return `<a class="mr" data-k="r${m.id}" href="#m/${m.id}/live">
    <div class="st">${statusTrack(m)}</div>
    <div class="sides">${side(m, m.t1, m.s1)}${side(m, m.t2, m.s2)}</div>
    <div class="why${m.phase === "live" ? " on" : ""}">${esc(why)}</div>
  </a>`;
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
  return `${prev}${esc(score(last))}${ov}`;
}

function hrow(m, t, inns) {
  const isBat = m.phase === "live" && m.batting === t.id;
  return `<div class="hrow${loser(m) === t.id ? " lose" : ""}">${flag(t, true)}<span class="nm">${esc(t.name)}</span><span class="sc">${heroScore(m, inns, isBat)}</span></div>`;
}

function hero(m) {
  const live = m.phase === "live";
  return `<a class="hero${live ? " is-live" : ""}${paused(m) ? " paused" : ""}" data-k="h${m.id}" href="#m/${m.id}/live">
    <div class="meta">${live ? liveBadge(m) : ""}${tags(m)}<span>${esc([m.format, m.desc].filter(Boolean).join(" · "))}</span></div>
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
  india: "Men's, women's and age-group India sides",
  ipl: "Indian Premier League",
  all: "Every match in progress",
};

function listView(tab) {
  const head = `<div class="ph"><h1>${TITLES[tab]}</h1><p>${SUBS[tab]}</p></div>`;
  if (!S.list) {
    if (S.listErr) return head + errorCard(S.listErr);
    return head + skeleton();
  }
  const ms = pick(tab);
  const live = ms
    .filter((m) => m.phase === "live")
    .sort((a, b) => b.tags.length - a.tags.length || byStartAsc(a, b));
  const next = ms.filter((m) => m.phase === "upcoming").sort(byStartAsc);
  const done = ms.filter((m) => m.phase === "done").sort(byStartDesc);
  let html = head;

  if (tab === "all") {
    if (!live.length)
      html += empty(
        "Nothing is live right now",
        "Check back when play starts.",
      );
    const groups = new Map();
    for (const m of live) {
      if (!groups.has(m.series)) groups.set(m.series, []);
      groups.get(m.series).push(m);
    }
    const ordered = [...groups.entries()].sort(
      (a, b) =>
        b[1].some((m) => m.tags.length) - a[1].some((m) => m.tags.length),
    );
    for (const [series, list] of ordered)
      html += `<div class="sec"><span>${esc(series)}</span></div><div class="list">${list.map(row).join("")}</div>`;
    return html + foot();
  }

  if (live.length) {
    html += `<div class="sec"><span>Live</span><small>${live.length} match${live.length > 1 ? "es" : ""}</small></div>`;
    html += live.map(hero).join("");
  } else {
    const n = pick("all").filter((m) => m.phase === "live").length;
    const what =
      tab === "ipl"
        ? "No IPL match is live"
        : tab === "india"
          ? "India aren't playing right now"
          : "Nothing live for India or the IPL";
    let why = next[0]?.start
      ? esc(
          `Next up ${dayLabel(next[0].start).toLowerCase()} at ${timeFmt.format(next[0].start)}: ${next[0].t1.short} v ${next[0].t2.short}.`,
        )
      : "";
    if (tab === "ipl" && !ms.length) why = iplOffSeason();
    html += empty(
      what,
      `${why}${n ? ` <a href="#all" style="color:var(--accent);font-weight:650">${n} other match${n > 1 ? "es" : ""} live →</a>` : ""}`,
      true,
    );
    if (tab === "ipl" && !ms.length) html += iplLatest();
  }
  const cap = tab === "now" ? 4 : 12;
  if (next.length)
    html += `<div class="sec"><span>Up next</span></div><div class="list">${next.slice(0, cap).map(row).join("")}</div>`;
  if (done.length)
    html += `<div class="sec"><span>Results</span></div><div class="list">${done.slice(0, cap).map(row).join("")}</div>`;
  return html + foot(S.list?.asOf, S.listErr, tab === "ipl" && !!S.ipl);
}

const shortDate = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});

function iplOffSeason() {
  const ipl = S.ipl;
  if (!ipl?.seasonStart)
    return "No IPL fixtures appear in the current feeds. The season usually runs March to May.";
  const year = new Date(ipl.seasonStart).getFullYear();
  return esc(
    `IPL ${year} ran ${shortDate.format(ipl.seasonStart)} to ${shortDate.format(ipl.seasonEnd)}. Fixtures for the next season appear here once they're scheduled.`,
  );
}

// The last IPL result Cricinfo lists, usually the final.
function iplLatest() {
  const m = S.ipl?.latest?.[0];
  if (!m) return "";
  const rows = m.sides
    .map(
      (x) =>
        `<div class="side${m.winner && !x.won ? " lose" : ""}"><span class="flag mono" aria-hidden="true">${esc(
          x.name
            .split(/\s+/)
            .map((w) => w[0])
            .join(""),
        )}</span><span class="nm">${esc(x.name)}</span><span class="sc" style="font-size:1rem">${esc(x.score)}</span></div>`,
    )
    .join("");
  const line = [
    m.winner ? `${m.winner} won` : m.state,
    m.potm ? `Player of the match: ${m.potm}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<div class="sec" data-k="iplh"><span>Last result</span><small>${m.date ? esc(dayFmt.format(m.date)) : ""}</small></div>
    <div class="card" data-k="ipll"><div class="dim" style="font-size:var(--t-meta);margin-bottom:8px">${esc(m.name)}</div><div class="sides">${rows}</div>
    <div style="font-size:var(--t-meta);font-weight:650;margin-top:10px">${esc(line)}</div>
    ${m.link ? `<a class="more" style="padding:12px 0 0;margin-top:10px" href="${esc(m.link)}" target="_blank" rel="noopener noreferrer">Scorecard on ESPNcricinfo →</a>` : ""}</div>`;
}

function empty(title, body, rawBody = false) {
  return `<div class="empty" data-k="empty"><b>${esc(title)}</b><span>${rawBody ? body : esc(body)}</span></div>`;
}

function errorCard(msg) {
  return `<div class="empty" data-k="err"><b class="err">Couldn't load scores</b><span>${esc(msg)}</span><span><button class="pill" type="button" data-act="retry">Try again</button></span></div>`;
}

function foot(asOf = S.list?.asOf, err = S.listErr, cricinfo = false) {
  if (!asOf) return "";
  const from = cricinfo ? "Cricbuzz and Cricinfo" : "Cricbuzz";
  return `<p class="foot" data-k="foot">${err ? `<span class="err">Refresh failed: ${esc(err)}</span> · ` : ""}Updated ${esc(ago(asOf))} · Data from ${from}</p>`;
}

// ---------- match view

function summaryOf(id) {
  return S.list?.matches.find((m) => String(m.id) === String(id)) ?? null;
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
  if (!d) return err ? errorCard(err) : skeleton(1) + skeleton();
  const h = d.header;
  const sm = summaryOf(id);
  const t1 = { ...h.t1, flag: sm?.t1.flag };
  const t2 = { ...h.t2, flag: sm?.t2.flag };
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
      eq.push(`<span class="pill">CRR <b>${esc(mini.crr)}</b></span>`);
    if (mini.target)
      eq.push(`<span class="pill">Target <b>${esc(mini.target)}</b></span>`);
    if (mini.rrr)
      eq.push(`<span class="pill">RRR <b>${esc(mini.rrr)}</b></span>`);
    if (mini.partnership?.b)
      eq.push(
        `<span class="pill">P'ship <b>${esc(mini.partnership.r)}</b>(${esc(mini.partnership.b)})</span>`,
      );
  }
  const heroHtml = `<section class="mhero${live ? " is-live" : ""}${paused(h) ? " paused" : ""}" data-k="mh">
    <div class="series">${live ? liveBadge(h) : ""}${tags(h)}<span>${esc(h.series)}</span></div>
    <h1>${esc(h.t1.short)} v ${esc(h.t2.short)} · ${esc(h.desc)}</h1>
    <div class="rows">${hrow(m, t1, i1)}${hrow(m, t2, i2)}</div>
    <div class="status">${esc(h.status || (h.start ? `Starts ${dayLabel(h.start)} ${timeFmt.format(h.start)}` : ""))}</div>
    ${eq.length ? `<div class="eq">${eq.join("")}</div>` : ""}
  </section>`;
  const tabs = [
    ["live", live ? "Live" : "Commentary"],
    ["scorecard", "Scorecard"],
    ["squads", "Squads"],
    ["info", "Info"],
  ];
  const ti = MATCH_TABS.indexOf(r.tab);
  const seg = `<nav class="seg" data-k="seg" style="--n:4;--i:${ti}" aria-label="Match sections"><i class="thumb" aria-hidden="true"></i>${tabs
    .map(
      ([k, label]) =>
        `<a href="#m/${id}/${k}" aria-current="${k === r.tab}">${label}</a>`,
    )
    .join("")}</nav>`;
  let body = "";
  if (r.tab === "live") body = liveTab(id, d);
  else if (r.tab === "scorecard") body = scorecardTab(id, h);
  else if (r.tab === "squads") body = squadsTab(id);
  else body = infoTab(id, d);
  return `${heroHtml}${seg}<div data-k="body-${r.tab}">${body}</div>${foot(d.asOf, err, !!S.ci.get(id)?.available)}`;
}

function ballChip(t) {
  const v = String(t);
  let cls = "";
  if (v === "0" || v === ".") cls = "dot";
  else if (/^W$/i.test(v) || /^\d*W$/.test(v)) cls = "w";
  else if (/wd|nb|lb|b$/i.test(v)) cls = "x";
  else if (v === "4") cls = "f4";
  else if (v === "6") cls = "f6";
  return `<span class="b ${cls}">${esc(v === "0" ? "•" : v)}</span>`;
}

function liveTab(id, d) {
  const mini = d.mini;
  let html = "";
  if (mini && (mini.striker || mini.bowler)) {
    const bats = [mini.striker, mini.nonStriker].filter(Boolean);
    const bowls = [mini.bowler, mini.otherBowler].filter(Boolean);
    html += `<div class="card flush now" data-k="now">
      <table class="tbl"><thead><tr><th>Batter</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead><tbody>
      ${bats.map((p, i) => `<tr class="${i === 0 ? "on" : ""}"><td><span class="who">${esc(p.name)}</span></td><td class="n hi">${p.r}</td><td class="n">${p.b}</td><td class="n">${p.f4}</td><td class="n">${p.f6}</td><td class="n">${esc(p.sr)}</td></tr>`).join("")}
      </tbody></table>
      <table class="tbl"><thead><tr><th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Econ</th></tr></thead><tbody>
      ${bowls.map((p, i) => `<tr class="${i === 0 ? "on" : ""}"><td><span class="who">${esc(p.name)}</span></td><td class="n">${esc(p.o)}</td><td class="n">${p.m}</td><td class="n">${p.r}</td><td class="n hi">${p.w}</td><td class="n">${esc(p.econ)}</td></tr>`).join("")}
      </tbody></table>
      ${
        mini.recent.length
          ? `<div class="recent"><span class="dim" style="font-size:var(--t-cap);font-weight:650">Recent</span>${mini.recent
              .slice(-3)
              .map((o) => `<span class="ov">${o.map(ballChip).join("")}</span>`)
              .join("")}</div>`
          : ""
      }
      ${mini.lastWicket ? `<div class="kv"><span class="lbl">Last wicket</span>${esc(mini.lastWicket.replace(/\s+/g, " "))}</div>` : ""}
    </div>`;
  }
  const ci = useCricinfo(id);
  const source = ci ? "Cricinfo" : "Cricbuzz";
  html += `<div class="sec" data-k="ch"><span>Commentary</span>${d.header.phase === "live" ? `<small>Auto-updating</small>` : ""}</div>`;
  if (S.ci.get(id)?.available) {
    const i = ci ? 1 : 0;
    html += `<div class="seg sub" data-k="srcseg" style="--n:2;--i:${i}"><i class="thumb" aria-hidden="true"></i>
      <button type="button" data-act="src" data-src="cb" aria-pressed="${!ci}">Cricbuzz</button>
      <button type="button" data-act="src" data-src="ci" aria-pressed="${!!ci}">Cricinfo live blog</button></div>`;
  }
  const items = commentary(id);
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

function moreButton(act, state) {
  if (state.done)
    return `<button class="more" type="button" disabled>Start of commentary</button>`;
  const label = state.busy
    ? "Loading…"
    : state.error
      ? `Couldn't load (${esc(state.error)}). Try again`
      : "Load earlier commentary";
  return `<button class="more" type="button" data-act="${act}"${state.busy ? " disabled" : ""}>${label}</button>`;
}

const cbMore = (id) => moreButton("older", S.older.get(id) ?? {});
function ciMore(id) {
  const c = S.ciComm.get(id) ?? {};
  return moreButton("ci-older", { ...c, done: !c.olderPage });
}

function commItem(c) {
  const k = `${c.kind}${c.ts}`;
  if (c.kind === "over") {
    return `<div class="ov-card" data-k="${k}">
      <div class="top-line"><b>End of over ${esc(c.over)}</b><span><span class="dim">${esc(c.runs)} run${c.runs === 1 ? "" : "s"} · </span><b class="num">${esc(c.team)} ${esc(c.score)}</b></span></div>
      ${c.balls.length ? `<div class="balls">${c.balls.map(ballChip).join("")}</div>` : ""}
      <div class="who">${c.bat.map((p) => `<span><b>${esc(p.name)}</b> ${esc(p.score)}</span>`).join("")}${c.bowl ? `<span><b>${esc(c.bowl.name)}</b> ${esc(c.bowl.figs)}</span>` : ""}</div>
    </div>`;
  }
  if (c.kind === "note")
    return `<div class="ci note" data-k="${k}"><div class="tx">${c.html}</div></div>`;
  const badge =
    c.event === "four"
      ? ballChip("4")
      : c.event === "six"
        ? ballChip("6")
        : c.event === "wicket"
          ? ballChip("W")
          : "";
  return `<div class="ci${c.event ? ` ev-${c.event}` : ""}" data-k="${k}"><div class="ball">${esc(c.ball)}${badge}</div><div class="tx">${c.html}</div></div>`;
}

function scorecardTab(id, h) {
  const card = S.card.get(id);
  if (!card) return skeleton();
  if (card.error && !card.innings.length) return errorCard(card.error);
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
  return card.innings
    .slice()
    .reverse()
    .map((inn) => {
      const isLive = inn.inn === liveInn;
      const bat = inn.bat
        .map((p) => {
          const notOut = !p.out || /not out|batting/i.test(p.out);
          return `<tr class="${isLive && onBat.has(p.id) ? "on" : ""}"><td><span class="who">${esc(p.name)}${p.c ? "<small>(c)</small>" : ""}${p.wk ? "<small>(wk)</small>" : ""}</span><span class="out${notOut ? " not" : ""}">${esc(p.out || "not out")}</span></td><td class="n hi">${p.r}</td><td class="n">${p.b}</td><td class="n">${p.f4}</td><td class="n">${p.f6}</td><td class="n">${esc(p.sr)}</td></tr>`;
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
        <table class="tbl"><thead><tr><th>Batter</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead><tbody>${bat}</tbody>
          <tfoot><tr><td>Extras <span class="dim" style="font-weight:500">(b ${ex.b}, lb ${ex.lb}, w ${ex.w}, nb ${ex.nb}${ex.p ? `, p ${ex.p}` : ""})</span></td><td class="n">${ex.total}</td><td colspan="4"></td></tr>
          <tr><td>Total <span class="dim" style="font-weight:500">${esc(oversTxt(inn.o))}${inn.rr ? ` · RR ${esc(inn.rr)}` : ""}</span></td><td colspan="5" class="tot">${esc(score(inn))}</td></tr></tfoot></table>
        ${inn.yetToBat.length ? `<div class="kv"><span class="lbl">${isLive || inn.w < 10 ? "Yet to bat" : "Did not bat"}</span>${esc(inn.yetToBat.join(", "))}</div>` : ""}
        ${inn.fow.length ? `<div class="kv"><span class="lbl">Fall of wickets</span><div class="fow">${inn.fow.map((f) => `<span><b>${f.score}-${f.n}</b> ${esc(f.name)}, ${esc(f.over)} ov</span>`).join("")}</div></div>` : ""}
        <table class="tbl" style="margin-top:4px"><thead><tr><th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Econ</th></tr></thead><tbody>${bowl}</tbody></table>
      </details>`;
    })
    .join("");
}

function squadsTab(id) {
  const sq = S.squad.get(id);
  if (!sq) return skeleton();
  if (sq.error && !sq.teams.length) return errorCard(sq.error);
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
            <div><div class="nm">${esc(p.name)}${p.c ? '<span class="badge c">C</span>' : ""}${p.wk ? '<span class="badge">WK</span>' : ""}${p.overseas ? '<span class="badge" title="Overseas">✈</span>' : ""}</div>
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
    [
      "Starts",
      h.start
        ? fullFmt.format(h.start) + (h.startIST ? ` (${h.startIST} IST)` : "")
        : "",
    ],
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
  if (!ci.available) return "";
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
  return `<div class="sec" data-k="cih"><span>From Cricinfo</span>${ci.link ? `<small><a href="${esc(ci.link)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">Open match →</a></small>` : ""}</div>
    <div class="card flush" data-k="ciinfo">${rows.map(([k, v]) => `<div class="kv" style="border-top:0"><span class="lbl">${esc(k)}</span>${esc(v)}</div>`).join("")}
    ${list("Debuts", debuts)}${list("Close of play", ci.closeOfPlay)}${list("Latest notes", ci.milestones)}</div>`;
}

// ---------- render

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
    let dot = a.querySelector(".dot");
    if (hasLive && a.dataset.tab !== "all" && !dot) {
      dot = document.createElement("i");
      dot.className = "dot";
      a.append(dot);
    } else if (!hasLive && dot) dot.remove();
  }
  $("#back").hidden = r.kind !== "match";
  const d = r.kind === "match" ? S.match.get(r.id) : null;
  const title =
    r.kind === "match"
      ? d
        ? `${d.header.t1.short} v ${d.header.t2.short}`
        : "Match"
      : TITLES[r.tab];
  $("#topTitle").textContent = title;
  document.title =
    r.kind === "match" && d
      ? `${title} · ${d.header.status} · Crease`
      : `${title} · Crease`;
}

// ---------- events

addEventListener("hashchange", onRoute);
addEventListener(
  "scroll",
  () => $("#top").classList.toggle("solid", scrollY > 8),
  { passive: true },
);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(timer);
  else refresh();
});
$("#refresh").addEventListener("click", () => refresh(true));
$("#back").addEventListener("click", () => {
  if (cameFromList && history.length > 1) history.back();
  else location.hash = "#now";
});
$("#theme").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  $("#themeColor").content = dark ? "#000000" : "#f3f3f5";
  $("#theme").setAttribute("aria-pressed", String(dark));
  try {
    localStorage.setItem("crease-theme", dark ? "dark" : "light");
  } catch {
    // Storage blocked: the choice lasts for this visit only.
  }
});
$("#theme").setAttribute(
  "aria-pressed",
  String(document.documentElement.dataset.theme === "dark"),
);

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
    refresh(true);
  } else if (btn.dataset.act === "team" && r.kind === "match") {
    S.squadTeam.set(r.id, Number(btn.dataset.i));
    render();
  }
});

// Remember which innings are expanded so live re-renders keep them.
view.addEventListener(
  "toggle",
  (e) => {
    const el = e.target;
    if (!(el instanceof HTMLDetailsElement) || !el.dataset.inn) return;
    const r = route();
    if (r.kind !== "match") return;
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
