// Cricinfo adapter. www.cricinfo.com and its hs-consumer-api sit behind an edge that
// refuses non-browser clients, but Cricinfo's match data is also served by ESPN's
// public sports API (Cricinfo is an ESPN property). Cricinfo event ids match the
// espncricinfo.com URLs. Routes used:
//   /scorepanel                         every current event, grouped by league
//   /{league}/summary?event={id}        officials, notes, debuts, venue, rosters, scorecard
//   /{league}/playbyplay?event={id}     ball-by-ball with the live blog (pre/postText), 25 per page, oldest first
//   /{league}/scoreboard                a league's season calendar and latest events (IPL is 8048)
// Cricbuzz stays the live spine; this module adds what Cricinfo does better.

import { cached, getJson } from "./http.mjs";
import { cleanHtml } from "./html.mjs";

const API = "https://site.web.api.espn.com/apis/site/v2/sports/cricket";
const SOURCE = "Cricinfo";
const IPL_LEAGUE = "8048";
const SAME_MATCH_MS = 36 * 3600 * 1000;

const json = (path) => getJson(API + path, SOURCE);

// ---------- event lookup

// "Hyderabad (India)" and "Hyderabad" are the same side; spacing and punctuation vary.
const teamKey = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z]/g, "");

function panelFrom(d) {
  const out = [];
  for (const group of d?.scores ?? []) {
    const league = group.leagues?.[0]?.id;
    for (const e of group.events ?? []) {
      const comps = e.competitions?.[0]?.competitors ?? [];
      out.push({
        league,
        id: e.id,
        date: Date.parse(e.date) || null,
        homeId: comps.find((c) => c.homeAway === "home")?.id ?? null,
        teams: comps.map((c) => teamKey(c.team?.displayName)),
        link: e.links?.find((l) => /\/game\//.test(l.href ?? ""))?.href ?? null,
      });
    }
  }
  return out;
}

const panelEvents = () =>
  cached("ci:panel", 30000, async () => panelFrom(await json("/scorepanel")));

// Match a Cricbuzz fixture to its Cricinfo event by both team names and start time.
// Returns null when the event is not in the current panel; unknown is not "absent".
function eventIn(events, { t1, t2, start }) {
  const want = [teamKey(t1), teamKey(t2)].sort().join("|");
  return (
    events.find(
      (e) =>
        e.teams.slice().sort().join("|") === want &&
        (!start || !e.date || Math.abs(e.date - start) < SAME_MATCH_MS),
    ) ?? null
  );
}

export async function findEvent(fixture) {
  return eventIn(await panelEvents(), fixture);
}

// ---------- match info

const NOTE_KEEP = new Set([
  "hoursofplay",
  "matchdays",
  "matchnumber",
  "livecommentator",
]);

function infoFrom(d, ev) {
  const g = d?.gameInfo ?? {};
  const notes = d?.notes ?? [];
  const pick = (type) =>
    notes.filter((n) => n.type === type).map((n) => n.text);
  const venue = g.venue;
  const w = g.weather;
  return {
    link: ev.link,
    venue: venue
      ? {
          name: venue.fullName ?? "",
          city: venue.address?.city ?? "",
          country: venue.address?.country ?? "",
          capacity: venue.capacity || null,
        }
      : null,
    weather: w?.temperature
      ? [w.temperature, w.skyCode].filter(Boolean).join(" · ")
      : "",
    officials: (g.officials ?? []).map((o) => ({
      role: o.position?.displayName ?? "",
      name: o.displayName ?? "",
      country: o.flag?.alt ?? "",
    })),
    notes: Object.fromEntries(
      notes.filter((n) => NOTE_KEEP.has(n.type)).map((n) => [n.type, n.text]),
    ),
    closeOfPlay: pick("closeofplay"),
    milestones: pick("matchnote").slice(-6).reverse(),
    debuts: (d?.debuts ?? [])
      .map((t) => ({
        team: t.team?.displayName ?? "",
        players: (t.roster ?? [])
          .map((r) => r.athlete?.displayName)
          .filter(Boolean),
      }))
      .filter((t) => t.players.length),
  };
}

export async function info(ev) {
  const d = await cached(`ci:sum:${ev.id}`, 60000, () =>
    json(`/${ev.league}/summary?event=${ev.id}`),
  );
  return infoFrom(d, ev);
}

// ---------- live blog commentary

const figs = (b) =>
  b
    ? `${b.overs ?? 0}-${b.maidens ?? 0}-${b.conceded ?? 0}-${b.wickets ?? 0}`
    : "";
const batLine = (b) =>
  b?.athlete
    ? {
        name: b.athlete.displayName,
        score: `${b.totalRuns ?? 0}(${b.faced ?? 0})`,
      }
    : null;

function eventOf(item) {
  if (item.dismissal?.dismissal) return "wicket";
  const t = String(item.playType?.description ?? "").toLowerCase();
  return t === "four" || t === "six" ? t : null;
}

// One ESPN item becomes up to four entries: blog text before the ball, the ball, an
// end-of-over card, blog text after. `ts` orders them (sequence * 4 + slot) and is unique.
function expand(item, homeId) {
  const seq = (item.sequence ?? Number(item.id)) * 4;
  const out = [];
  const blog = (html, slot) =>
    html && out.push({ kind: "note", ts: seq + slot, html: cleanHtml(html) });
  blog(item.preText, 0);
  const o = item.over ?? {};
  out.push({
    kind: "ball",
    ts: seq + 1,
    inn: item.innings?.number ?? item.period ?? null,
    ball: typeof o.actual === "number" ? o.actual : null,
    event: eventOf(item),
    html: `<b>${cleanHtml(item.shortText)}</b>${item.text ? `, ${cleanHtml(item.text)}` : ""}`,
  });
  if (o.complete) {
    out.push({
      kind: "over",
      ts: seq + 2,
      over: o.number,
      runs: o.runs ?? 0,
      balls: [],
      team: item.team?.abbreviation ?? "",
      score:
        String(item.team?.id) === String(homeId)
          ? item.homeScore
          : item.awayScore,
      bat: [batLine(item.batsman), batLine(item.otherBatsman)].filter(Boolean),
      bowl: item.bowler?.athlete
        ? { name: item.bowler.athlete.displayName, figs: figs(item.bowler) }
        : null,
    });
  }
  blog(item.postText, 3);
  return out;
}

async function page(ev, n) {
  return cached(`ci:pbp:${ev.id}:${n}`, 15000, async () => {
    const d = await json(`/${ev.league}/playbyplay?event=${ev.id}&page=${n}`);
    return d?.commentary ?? { items: [], pageCount: 0 };
  });
}

// Latest commentary, or one older page when `before` (a page number) is given.
export async function commentary(ev, before) {
  let nums = [before];
  if (!before) {
    const last = (await page(ev, 1)).pageCount || 1;
    const top = await page(ev, last);
    // A fresh page may hold a ball or two; show a full screen.
    nums =
      last > 1 && (top.items?.length ?? 0) < 12 ? [last - 1, last] : [last];
  }
  const pages = await Promise.all(nums.map((n) => page(ev, n)));
  return commentaryFrom(pages, ev.homeId, nums[0]);
}

// Newest first; `oldest` is the lowest page number included.
function commentaryFrom(pages, homeId, oldest) {
  const items = pages
    .flatMap((p) => p.items ?? [])
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .flatMap((i) => expand(i, homeId))
    .reverse();
  return { items, olderPage: oldest > 1 ? oldest - 1 : null };
}

// ---------- IPL season

function iplSeasonFrom(d) {
  const lg = d?.leagues?.[0];
  const cal = lg?.calendar ?? [];
  const latest = (d?.events ?? []).map((e) => {
    const c = e.competitions?.[0] ?? {};
    const sides = (c.competitors ?? []).map((x) => ({
      name: x.team?.displayName ?? "",
      score: x.score ?? "",
      won: String(x.winner) === "true",
    }));
    const potm = c.status?.featuredAthletes?.find(
      (f) => f.abbreviation === "POTM",
    );
    return {
      name: e.name ?? "",
      date: Date.parse(e.date) || null,
      state: c.status?.type?.description ?? "",
      sides,
      winner: sides.find((s) => s.won)?.name ?? null,
      potm: potm?.athlete?.displayName ?? null,
      link:
        e.links?.find((l) => /\/scorecard\//.test(l.href ?? ""))?.href ?? null,
    };
  });
  return {
    seasonStart: Date.parse(cal[0]) || null,
    seasonEnd: Date.parse(cal.at(-1)) || null,
    latest,
  };
}

export async function iplSeason() {
  return iplSeasonFrom(
    await cached("ci:ipl", 3600000, () => json(`/${IPL_LEAGUE}/scoreboard`)),
  );
}

// Pure parsers over captured upstream payloads, for the fixture tests.
export const parse = {
  panel: panelFrom,
  event: eventIn,
  info: infoFrom,
  commentary: commentaryFrom,
  iplSeason: iplSeasonFrom,
};
