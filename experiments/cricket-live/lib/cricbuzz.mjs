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

async function getFlight(path) {
  const res = await get(path, "text/html");
  const html = await res.text();
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
  if (!flight) throw new UpstreamError("Cricbuzz page carried no data payload");
  return flight;
}

// Slice one balanced JSON value that starts at `start` and parse it.
function jsonAt(text, start) {
  const open = text[start];
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) return undefined;
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
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1), rscValue);
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

// React's flight encoding writes absent values as the string "$undefined".
const rscValue = (_, v) => (v === "$undefined" ? undefined : v);

function valueAfter(text, key, from = 0) {
  const at = text.indexOf(`"${key}":`, from);
  if (at < 0) return undefined;
  return jsonAt(text, at + key.length + 3);
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

function team(t) {
  return {
    id: t?.teamId ?? t?.id ?? null,
    name: t?.teamName ?? t?.name ?? "",
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
  if (home.status === "fulfilled")
    add((home.value?.matches ?? []).map(summary).filter(Boolean));
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
    startIST: h.matchStartTimeIST ?? "",
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

export async function match(id) {
  const raw = await cached(`comm:${id}`, 10000, () =>
    getJson(`/api/mcenter/comm/${id}`),
  );
  if (!raw?.matchHeader) throw new UpstreamError("No such match", 404);
  const h = header(raw.matchHeader);
  return {
    asOf: Date.now(),
    refresh: h.phase === "live" ? 15000 : 0,
    header: h,
    mini: miniscore(raw.miniscore),
    commentary: commList(raw.matchCommentary),
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

export async function scorecard(id) {
  const flight = await cached(`scard:${id}`, 15000, () =>
    getFlight(`/live-cricket-scorecard/${id}/x`),
  );
  const cards = valueAfter(flight, "scoreCard");
  const info = valueAfter(flight, "matchInfo");
  return {
    asOf: Date.now(),
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

export async function squads(id) {
  const flight = await cached(`squads:${id}`, 60000, () =>
    getFlight(`/cricket-match-squads/${id}/x`),
  );
  const t1 = squadTeam(
    valueAfter(flight, "team1", flight.indexOf('"team1":{"team":')),
  );
  const t2 = squadTeam(
    valueAfter(flight, "team2", flight.indexOf('"team2":{"team":')),
  );
  return { asOf: Date.now(), teams: [t1, t2].filter(Boolean) };
}
