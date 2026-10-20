// Cricbuzz adapter. Two upstream shapes, both reverse-engineered from the public site:
//   1. JSON routes the site's own client calls: /api/home, /api/mcenter/comm/{id},
//      /api/mcenter/commentary-pagination/{id}/{innings}/{beforeTimestamp}.
//   2. Server-rendered pages whose React Server Components payload
//      (self.__next_f.push chunks) embeds the full JSON: live-scores lists,
//      the scorecard and the squads pages.
// Everything is normalised here so the browser only sees one small, stable shape.

import {
  cached,
  get as fetchFrom,
  getJson as jsonFrom,
  UpstreamError,
} from "./http.mjs";
import { cleanHtml } from "./html.mjs";

const ORIGIN = "https://www.cricbuzz.com";
const IMG = "https://static.cricbuzz.com/a/img/v1";
const get = (path, accept) => fetchFrom(ORIGIN + path, accept, "Cricbuzz");
const getJson = (path) => jsonFrom(ORIGIN + path, "Cricbuzz");

// ---------- RSC flight payload

// Join a page's self.__next_f.push([1, "..."]) chunks into the flight text.
function flightOf(html) {
  let flight = "";
  const re = /self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g;
  for (const m of html.matchAll(re)) {
    try {
      const chunk = JSON.parse(m[1]);
      if (typeof chunk[1] === "string") flight += chunk[1];
    } catch {
      // A chunk that is not plain JSON carries no data we read.
    }
  }
  return flight;
}

async function getFlight(path) {
  const res = await get(path, "text/html");
  const flight = flightOf(await res.text());
  if (!flight) throw new UpstreamError("Cricbuzz page carried no data payload");
  return flight;
}

// End (exclusive) of the balanced JSON object or array starting at `start`, or -1.
function jsonEnd(text, start) {
  if (text[start] !== "{" && text[start] !== "[") return -1;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// Parse the balanced JSON value that starts at `start`.
function jsonAt(text, start) {
  const end = jsonEnd(text, start);
  if (end < 0) return undefined;
  try {
    return JSON.parse(text.slice(start, end), rscValue);
  } catch {
    return undefined;
  }
}

// React's flight encoding writes absent values as the string "$undefined".
const rscValue = (_, v) => (v === "$undefined" ? undefined : v);

function valueAfter(text, key, from = 0) {
  const at = text.indexOf(`"${key}":`, from);
  if (at < 0) return undefined;
  return jsonAt(text, at + key.length + 3);
}

// Pages also embed the site-wide score ticker, so a key like "matchInfo" occurs for
// many matches. Pick the value that belongs to `id`; absent means not on this page.
function valueFor(text, key, id) {
  for (
    let at = text.indexOf(`"${key}":`);
    at >= 0;
    at = text.indexOf(`"${key}":`, at + 1)
  ) {
    const v = jsonAt(text, at + key.length + 3);
    if (v && String(v.matchId) === String(id)) return v;
  }
  return undefined;
}

// ---------- classification

const DONE = /^(complete|abandon|abandoned|no result|cancelled|result)$/i;
const UPCOMING = /^(preview|upcoming|delayed start)$/i;

function phaseOf(state) {
  if (!state) return "upcoming";
  if (DONE.test(state)) return "done";
  if (UPCOMING.test(state)) return "upcoming";
  return "live";
}

const isIndia = (name) => /^India(\s|$)/.test(name || "");

// The app covers men's cricket only. Cricbuzz has no gender field: women's sides
// are named "X Women" and women's competitions say so ("Women's Premier League").
const WOMEN = /\bwomen('?s)?\b/i;
const isWomens = (series, a, b) =>
  WOMEN.test(a ?? "") || WOMEN.test(b ?? "") || WOMEN.test(series ?? "");
const isIpl = (series) => /indian premier league|\bipl\b/i.test(series || "");

function tagsFor(series, a, b) {
  const tags = [];
  if (isIndia(a) || isIndia(b)) tags.push("india");
  if (isIpl(series)) tags.push("ipl");
  return tags;
}

const flagUrl = (imageId) =>
  imageId ? `${IMG}/72x54/i1/c${imageId}/i.jpg` : null;
const faceUrl = (imageId) =>
  imageId ? `${IMG}/75x75/i1/c${imageId}/i.jpg` : null;

// ---------- match lists

// Cricbuzz writes a completed over as x.6 in some feeds and x+1 in others.
const overs = (o) => {
  const n = Number(o) || 0;
  const whole = Math.trunc(n);
  return Math.round((n - whole) * 10) >= 6 ? whole + 1 : n;
};

function innings(score) {
  if (!score) return [];
  return Object.keys(score)
    .sort()
    .map((k) => score[k])
    .filter(Boolean)
    .map((s) => ({
      r: s.runs ?? 0,
      w: s.wickets ?? 0,
      o: overs(s.overs),
      dec: !!s.isDeclared,
      fo: !!s.isFollowOn,
    }));
}

// Series pages write some names in capitals ("ROYAL CHALLENGERS BENGALURU").
const displayName = (name) =>
  /[a-z]/.test(name)
    ? name
    : name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

function team(t) {
  return {
    id: t?.teamId ?? t?.id ?? null,
    name: displayName(t?.teamName ?? t?.name ?? ""),
    short: t?.teamSName ?? t?.shortName ?? "",
    flag: flagUrl(t?.imageId),
  };
}

function summary(entry) {
  const i = entry.matchInfo ?? entry.match?.matchInfo;
  if (!i) return null;
  const s = entry.matchScore ?? entry.match?.matchScore;
  const t1 = team(i.team1);
  const t2 = team(i.team2);
  if (isWomens(i.seriesName, t1.name, t2.name)) return null;
  return {
    id: i.matchId,
    series: i.seriesName ?? "",
    seriesId: i.seriesId ?? null,
    desc: i.matchDesc ?? "",
    format: i.matchFormat ?? "",
    type: i.matchType ?? "",
    start: Number(i.startDate) || null,
    state: i.state ?? "",
    status: i.status ?? "",
    phase: phaseOf(i.state),
    venue: i.venueInfo
      ? { ground: i.venueInfo.ground ?? "", city: i.venueInfo.city ?? "" }
      : null,
    batting: i.currBatTeamId ?? null,
    t1,
    t2,
    s1: innings(s?.team1Score),
    s2: innings(s?.team2Score),
    tags: tagsFor(i.seriesName, t1.name, t2.name),
  };
}

function matchesFromFlight(flight) {
  const out = [];
  const typeMatches = valueAfter(flight, "typeMatches");
  if (!Array.isArray(typeMatches)) return out;
  for (const type of typeMatches) {
    for (const series of type.seriesMatches ?? []) {
      for (const m of series.seriesAdWrapper?.matches ?? []) {
        const sm = summary(m);
        if (sm) out.push(sm);
      }
    }
  }
  return out;
}

const LIST_PAGES = {
  live: "/cricket-match/live-scores",
  recent: "/cricket-match/live-scores/recent-matches",
  upcoming: "/cricket-match/live-scores/upcoming-matches",
};

const homeMatches = (json) =>
  (json?.matches ?? []).map(summary).filter(Boolean);

function listPage(kind, ttl) {
  return cached(`list:${kind}`, ttl, async () =>
    matchesFromFlight(await getFlight(LIST_PAGES[kind])),
  );
}

export async function matches() {
  // Live drives the 15s refresh; recent/upcoming change slowly.
  const [live, recent, upcoming, home] = await Promise.allSettled([
    listPage("live", 15000),
    listPage("recent", 120000),
    listPage("upcoming", 300000),
    cached("home", 15000, () => getJson("/api/home")),
  ]);
  if (live.status === "rejected" && home.status === "rejected")
    throw live.reason;
  const byId = new Map();
  const add = (list) => {
    for (const m of list) {
      const prev = byId.get(m.id);
      // Prefer the fresher record: live list, then home feed, then the rest.
      if (!prev) byId.set(m.id, m);
    }
  };
  if (live.status === "fulfilled") add(live.value);
  if (home.status === "fulfilled") add(homeMatches(home.value));
  if (recent.status === "fulfilled") add(recent.value);
  if (upcoming.status === "fulfilled") add(upcoming.value);
  const all = [...byId.values()];
  all.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  return {
    asOf: Date.now(),
    partial: [live, recent, upcoming].some((r) => r.status === "rejected"),
    matches: all,
  };
}

// ---------- schedules

// Team and series pages list fixtures by day:
// [{ matchDetailsMap: { key: "Thu, 22 Oct 2026", match: [{ matchInfo, matchScore }] } }].
function fixturesFrom(flight, key) {
  const days = valueAfter(flight, key);
  if (!Array.isArray(days)) return [];
  return days
    .flatMap((d) => d?.matchDetailsMap?.match ?? [])
    .map(summary)
    .filter(Boolean);
}

// India's team pages (id 2): "schedule" lists fixtures about a year ahead, far beyond
// the upcoming-matches page; "results" lists the last ten completed matches.
const INDIA_TEAM = 2;
const SCHEDULE_TTL = 30 * 60000;

function teamFixtures(id, page = "schedule") {
  return cached(`team:${id}:${page}`, SCHEDULE_TTL, async () =>
    fixturesFrom(
      await getFlight(`/cricket-team/x/${id}/${page}`),
      "teamMatchesData",
    ),
  );
}

// A series page also carries the ticker's matches; keep this series' own.
const seriesFixturesFrom = (flight, id) =>
  fixturesFrom(flight, "matchDetails").filter((m) => m.seriesId === id);

function seriesFixtures(id) {
  return cached(`series:${id}`, SCHEDULE_TTL, async () =>
    seriesFixturesFrom(await getFlight(`/cricket-series/${id}/x/matches`), id),
  );
}

// Every league series by month, from the league schedule page. The /api/series/schedule
// route looked similar but lists only series Cricbuzz streams in the caller's country,
// so from India (where the server runs) it left out the IPL.
const LEAGUE_SCHEDULE = "/cricket-schedule/series/league";

function leagueSeriesFrom(flight) {
  const months = valueAfter(flight, "seriesScheduleData");
  // Missing data is a changed page, not an empty calendar: report it as a failure.
  if (!Array.isArray(months))
    throw new UpstreamError("Cricbuzz's league schedule has no series list");
  return months
    .flatMap((month) => month?.series ?? [])
    .map((x) => ({
      id: x.id,
      name: x.name ?? "",
      start: Number(x.startDt) || null,
      end: Number(x.endDt) || null,
    }));
}

function iplSeriesFrom(series, now) {
  return (
    series
      .filter((x) => isIpl(x.name) && (x.end ?? Infinity) >= now)
      .sort((a, b) => (a.start ?? 0) - (b.start ?? 0))[0] ?? null
  );
}

async function iplSeries() {
  const series = await cached("league-schedule", 6 * 3600000, async () =>
    leagueSeriesFrom(await getFlight(LEAGUE_SCHEDULE)),
  );
  return iplSeriesFrom(series, Date.now());
}

export async function schedule() {
  const [ipl, india, results] = await Promise.allSettled([
    iplSeries(),
    teamFixtures(INDIA_TEAM),
    teamFixtures(INDIA_TEAM, "results"),
  ]);
  if (ipl.status === "rejected" && india.status === "rejected")
    throw india.reason;
  const series = ipl.status === "fulfilled" ? ipl.value : null;
  // The results page stops at ten matches, which can cut a series in half; each
  // series it shows is completed from that series' own page.
  const done = results.status === "fulfilled" ? results.value : [];
  const seriesIds = [...new Set(done.map((m) => m.seriesId).filter(Boolean))];
  const full = await Promise.allSettled(
    seriesIds.slice(0, 4).map((id) => seriesFixtures(id)),
  );
  const resultsById = new Map(done.map((m) => [m.id, m]));
  for (const r of full)
    if (r.status === "fulfilled")
      for (const m of r.value)
        if (
          m.phase === "done" &&
          m.tags.includes("india") &&
          !resultsById.has(m.id)
        )
          resultsById.set(m.id, m);
  let iplFixtures = [];
  if (series) {
    try {
      iplFixtures = await seriesFixtures(series.id);
    } catch {
      // The season card still shows its dates without fixtures.
    }
  }
  return {
    asOf: Date.now(),
    // Which parts failed, so the app can say "couldn't load" rather than "none".
    failed: [
      ...Object.entries({ ipl, india, indiaResults: results })
        .filter(([, r]) => r.status === "rejected")
        .map(([part]) => part),
      ...(full.some((r) => r.status === "rejected") ? ["resultSeries"] : []),
    ],
    india: (india.status === "fulfilled" ? india.value : [])
      .filter((m) => m.phase !== "done")
      .sort((a, b) => (a.start ?? 0) - (b.start ?? 0)),
    // Null when the results page failed: unknown, not "no results".
    indiaResults:
      results.status === "fulfilled"
        ? [...resultsById.values()]
            .filter((m) => m.phase === "done")
            .sort((a, b) => (b.start ?? 0) - (a.start ?? 0))
        : null,
    ipl: series
      ? {
          ...series,
          fixtures: iplFixtures.sort((a, b) => (a.start ?? 0) - (b.start ?? 0)),
        }
      : null,
  };
}

// ---------- commentary

function eventOf(events) {
  const e = (events ?? []).map((x) => String(x).toLowerCase());
  if (e.includes("wicket")) return "wicket";
  if (e.includes("six")) return "six";
  if (e.includes("four")) return "four";
  return null;
}

function commItem(v) {
  if (!v || typeof v !== "object") return null;
  if (v.commType === "over-separator" && v.overSeparator) {
    const o = v.overSeparator;
    return {
      kind: "over",
      ts: v.timestamp,
      inn: v.inningsId ?? null,
      over: o.overNumber,
      runs: o.overRuns,
      balls: String(o.overSummary ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean),
      team: o.batTeamObj?.teamName ?? "",
      score: o.batTeamObj?.teamScore ?? "",
      bat: [o.batStrikerObj, o.batNonStrikerObj]
        .filter((p) => p?.playerName)
        .map((p) => ({ name: p.playerName, score: p.playerScore })),
      bowl: o.bowlerObj?.playerName
        ? { name: o.bowlerObj.playerName, figs: o.bowlerObj.playerScore }
        : null,
    };
  }
  if (v.commType !== "commentary" || !v.commText) return null;
  const hasBall = typeof v.ballMetric === "number";
  return {
    kind: hasBall ? "ball" : "note",
    ts: v.timestamp,
    inn: v.inningsId ?? null,
    ball: hasBall ? v.ballMetric : null,
    event: eventOf(v.event),
    html: cleanHtml(v.commText),
  };
}

function commList(raw) {
  const list = Array.isArray(raw) ? raw : Object.values(raw ?? {});
  return list
    .map(commItem)
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts);
}

function header(h) {
  if (!h) return null;
  const t1 = {
    id: h.team1?.id ?? null,
    name: h.team1?.name ?? "",
    short: h.team1?.shortName ?? "",
  };
  const t2 = {
    id: h.team2?.id ?? null,
    name: h.team2?.name ?? "",
    short: h.team2?.shortName ?? "",
  };
  return {
    id: h.matchId,
    desc: h.matchDescription ?? "",
    format: h.matchFormat ?? "",
    type: h.matchType ?? "",
    series: h.seriesName ?? h.seriesDesc ?? "",
    seriesId: h.seriesId ?? null,
    start: h.matchStartTimestamp ?? null,
    state: h.state ?? "",
    status: h.status ?? "",
    phase: phaseOf(h.state),
    toss: h.tossResults?.tossWinnerName
      ? `${h.tossResults.tossWinnerName} won the toss and chose to ${
          /bat/i.test(h.tossResults.decision) ? "bat" : "bowl"
        }`
      : "",
    potm: (h.playersOfTheMatch ?? []).map((p) => ({
      id: p.id,
      name: p.fullName || p.name,
      face: faceUrl(p.faceImageId ?? p.imageDetails?.imageId),
      line: [p.battingSummary, p.bowlingSummary].filter(Boolean).join(" · "),
    })),
    t1,
    t2,
    tags: tagsFor(h.seriesName, t1.name, t2.name),
  };
}

function batter(p) {
  if (!p?.name) return null;
  return {
    id: p.id,
    name: p.name,
    r: p.runs ?? 0,
    b: p.balls ?? 0,
    f4: p.fours ?? 0,
    f6: p.sixes ?? 0,
    sr: p.strikeRate ?? "",
  };
}

function bowler(p) {
  if (!p?.name) return null;
  return {
    id: p.id,
    name: p.name,
    o: p.overs ?? 0,
    m: p.maidens ?? 0,
    r: p.runs ?? 0,
    w: p.wickets ?? 0,
    econ: p.economy ?? "",
  };
}

function miniscore(ms) {
  if (!ms) return null;
  return {
    inn: ms.inningsId ?? null,
    batTeam: ms.batTeam?.teamId ?? null,
    innings: (ms.matchScoreDetails?.inningsScoreList ?? [])
      .slice()
      .sort((a, b) => a.inningsId - b.inningsId)
      .map((s) => ({
        inn: s.inningsId,
        team: s.batTeamName,
        teamId: s.batTeamId,
        r: s.score ?? 0,
        w: s.wickets ?? 0,
        o: overs(s.overs),
        dec: !!s.isDeclared,
        fo: !!s.isFollowOn,
      })),
    striker: batter(ms.batsmanStriker),
    nonStriker: batter(ms.batsmanNonStriker),
    bowler: bowler(ms.bowlerStriker),
    otherBowler: bowler(ms.bowlerNonStriker),
    crr: ms.currentRunRate ?? null,
    rrr: ms.requiredRunRate || null,
    target: ms.target ?? null,
    toWin: ms.remRunsToWin || null,
    partnership: ms.partnerShip
      ? { r: ms.partnerShip.runs, b: ms.partnerShip.balls }
      : null,
    lastWicket: ms.lastWicket ?? "",
    recent: String(ms.recentOvsStats ?? "")
      .replace(/^\.\.\.\s*/, "")
      .split("|")
      .map((o) => o.trim().split(/\s+/).filter(Boolean))
      .filter((o) => o.length),
    status: ms.status ?? "",
  };
}

function matchFrom(raw) {
  // Cricbuzz opens a match centre shortly before the start; until then the feed is empty.
  if (!raw?.matchHeader)
    throw new UpstreamError(
      "Cricbuzz hasn't opened this match centre yet",
      404,
    );
  const h = header(raw.matchHeader);
  if (isWomens(h.series, h.t1.name, h.t2.name))
    throw new UpstreamError("Crease covers men's cricket only", 404);
  return {
    header: h,
    mini: miniscore(raw.miniscore),
    commentary: commList(raw.matchCommentary),
  };
}

export async function match(id) {
  const raw = await cached(`comm:${id}`, 10000, () =>
    getJson(`/api/mcenter/comm/${id}`),
  );
  const m = matchFrom(raw);
  return {
    asOf: Date.now(),
    refresh: m.header.phase === "live" ? 15000 : 0,
    ...m,
  };
}

export async function olderCommentary(id, inn, before) {
  const raw = await cached(`page:${id}:${inn}:${before}`, 60000, () =>
    getJson(`/api/mcenter/commentary-pagination/${id}/${inn}/${before}`),
  );
  return { commentary: commList(raw ?? []) };
}

// ---------- scorecard

function scorecardInnings(sc) {
  const bat = Object.values(sc.batTeamDetails?.batsmenData ?? {}).map((p) => ({
    id: p.batId,
    name: p.batName,
    c: !!p.isCaptain,
    wk: !!p.isKeeper,
    out: p.outDesc ?? "",
    r: p.runs ?? 0,
    b: p.balls ?? 0,
    f4: p.fours ?? 0,
    f6: p.sixes ?? 0,
    sr: p.strikeRate ?? 0,
  }));
  const batted = bat.filter((p) => p.b > 0 || p.out);
  const yetToBat = bat.filter((p) => !(p.b > 0 || p.out)).map((p) => p.name);
  const bowl = Object.values(sc.bowlTeamDetails?.bowlersData ?? {}).map(
    (p) => ({
      id: p.bowlerId,
      name: p.bowlName,
      o: p.overs ?? 0,
      m: p.maidens ?? 0,
      r: p.runs ?? 0,
      w: p.wickets ?? 0,
      nb: p.no_balls ?? 0,
      wd: p.wides ?? 0,
      econ: p.economy ?? 0,
    }),
  );
  const fow = Object.values(sc.wicketsData ?? {})
    .sort((a, b) => a.wktNbr - b.wktNbr)
    .map((w) => ({
      n: w.wktNbr,
      name: w.batName,
      score: w.wktRuns,
      over: w.wktOver,
    }));
  const sd = sc.scoreDetails ?? {};
  const ex = sc.extrasData ?? {};
  return {
    inn: sc.inningsId,
    team: sc.batTeamDetails?.batTeamName ?? "",
    short: sc.batTeamDetails?.batTeamShortName ?? "",
    r: sd.runs ?? 0,
    w: sd.wickets ?? 0,
    o: sd.overs ?? 0,
    rr: sd.runRate ?? null,
    dec: !!(sd.isDeclared || sd.declared),
    fo: !!(sd.isFollowOn || sd.followOn),
    extras: {
      total: ex.total ?? 0,
      b: ex.byes ?? 0,
      lb: ex.legByes ?? 0,
      w: ex.wides ?? 0,
      nb: ex.noBalls ?? 0,
      p: ex.penalty ?? 0,
    },
    bat: batted,
    yetToBat,
    bowl,
    fow,
  };
}

function scorecardFrom(flight, id) {
  const cards = valueAfter(flight, "scoreCard")?.filter?.(
    (c) => String(c.matchId) === String(id),
  );
  const info = valueFor(flight, "matchInfo", id);
  return {
    innings: Array.isArray(cards)
      ? cards
          .slice()
          .sort((a, b) => a.inningsId - b.inningsId)
          .map(scorecardInnings)
      : [],
    venue: info?.venueInfo
      ? { ground: info.venueInfo.ground ?? "", city: info.venueInfo.city ?? "" }
      : null,
  };
}

export async function scorecard(id) {
  const flight = await cached(`scard:${id}`, 15000, () =>
    getFlight(`/live-cricket-scorecard/${id}/x`),
  );
  return { asOf: Date.now(), ...scorecardFrom(flight, id) };
}

// ---------- squads

function squadTeam(entry) {
  if (!entry?.team) return null;
  const groups = Object.entries(entry.players ?? {})
    .filter(([, list]) => Array.isArray(list) && list.length)
    .map(([label, list]) => {
      const staff = /staff/i.test(label);
      return {
        label: label
          .replace(/\bxi\b/i, "XI")
          .replace(/^./, (c) => c.toUpperCase()),
        players: list.map((p) => ({
          id: p.id,
          name: p.fullName || p.name,
          role: p.role ?? "",
          // Support staff rows carry placeholder captain/keeper flags.
          c: !staff && p.captain === true,
          wk: !staff && p.keeper === true,
          overseas: p.isOverseas === true,
          face: faceUrl(p.imageDetails?.imageId ?? p.faceImageId),
          bat: staff ? "" : (p.battingStyle ?? ""),
          bowl: staff ? "" : (p.bowlingStyle ?? ""),
        })),
      };
    });
  return {
    ...team(entry.team),
    flag: flagUrl(entry.team.imageDetails?.imageId),
    groups,
  };
}

// The squads widget is the only place a side is written as {"team1":{"team":...}};
// without it the page has no squads (searching from the start would hit the ticker).
function squadSide(flight, key) {
  const at = flight.indexOf(`"${key}":{"team":`);
  return at < 0 ? null : squadTeam(valueAfter(flight, key, at));
}

const squadsFrom = (flight) => ({
  teams: [squadSide(flight, "team1"), squadSide(flight, "team2")].filter(
    Boolean,
  ),
});

export async function squads(id) {
  const flight = await cached(`squads:${id}`, 60000, () =>
    getFlight(`/cricket-match-squads/${id}/x`),
  );
  return { asOf: Date.now(), ...squadsFrom(flight) };
}

// Pure parsers over captured upstream payloads, for the fixture tests.
export const parse = {
  flight: flightOf,
  jsonEnd,
  list: matchesFromFlight,
  home: homeMatches,
  fixtures: fixturesFrom,
  seriesFixtures: seriesFixturesFrom,
  leagueSeries: leagueSeriesFrom,
  iplSeries: iplSeriesFrom,
  match: matchFrom,
  commentary: commList,
  scorecard: scorecardFrom,
  squads: squadsFrom,
};
