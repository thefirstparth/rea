// Records real Cricbuzz and Cricinfo payloads into test/fixtures/ for the offline tests.
//
//   NODE_USE_ENV_PROXY=1 node experiments/cricket-live/test/capture.mjs   (behind a proxy)
//   node experiments/cricket-live/test/capture.mjs
//
// Page payloads keep only the JSON values the adapter reads, in their original text
// and order (including the site-wide ticker's matchInfo entries, which the scorecard
// must not confuse with its own). JSON routes are stored as returned, except the
// Cricinfo ones, which are cut down to the fields the adapter reads.

import { mkdir, writeFile } from "node:fs/promises";
import { parse as cricbuzz } from "../lib/cricbuzz.mjs";
import { parse as cricinfo } from "../lib/cricinfo.mjs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const CB = "https://www.cricbuzz.com";
const CI = "https://site.web.api.espn.com/apis/site/v2/sports/cricket";
// IPL 2026 is complete, so its series page is a stable in-season fixture source.
const PAST_IPL_SERIES = 9241;
const INDIA_TEAM = 2;
const FIXTURES = new URL("./fixtures/", import.meta.url);

async function fetchText(url, accept) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

const json = async (url) =>
  JSON.parse((await fetchText(url, "application/json")) || "null");

// Every value of the given keys, top level only, as `"key":<original text>` lines.
function keepValues(flight, keys) {
  const found = [];
  for (const key of keys) {
    const pat = `"${key}":`;
    for (
      let at = flight.indexOf(pat);
      at >= 0;
      at = flight.indexOf(pat, at + 1)
    ) {
      const start = at + pat.length;
      const end = cricbuzz.jsonEnd(flight, start);
      if (end > 0)
        found.push({ at, end, line: `${pat}${flight.slice(start, end)}` });
    }
  }
  found.sort((a, b) => a.at - b.at);
  const kept = [];
  let covered = -1;
  for (const f of found) {
    if (f.at < covered) continue; // nested inside a value already kept
    kept.push(f.line);
    covered = f.end;
  }
  return `${kept.join("\n")}\n`;
}

async function page(path, keys) {
  const flight = cricbuzz.flight(await fetchText(CB + path, "text/html"));
  if (!flight) throw new Error(`${path} carried no flight payload`);
  return keepValues(flight, keys);
}

async function save(name, data) {
  const text = typeof data === "string" ? data : `${JSON.stringify(data)}\n`;
  await writeFile(new URL(name, FIXTURES), text);
  console.log(`${name.padEnd(28)} ${String(text.length).padStart(8)} bytes`);
}

await mkdir(FIXTURES, { recursive: true });

// --- Cricbuzz match lists, and the matches the rest of the capture follows.
const liveList = await page("/cricket-match/live-scores", ["typeMatches"]);
await save("cb-live-list.flight.txt", liveList);
const home = await json(`${CB}/api/home`);
await save("cb-home.json", home);
const listed = [...cricbuzz.list(liveList), ...cricbuzz.home(home)];
const live =
  listed.find((m) => m.phase === "live" && m.tags.includes("india")) ??
  listed.find((m) => m.phase === "live" && /in progress/i.test(m.state)) ??
  listed.find((m) => m.phase === "live");
const done = listed.find((m) => m.phase === "done");
if (!live || !done)
  throw new Error("Need one live and one completed match in the feeds");

// --- India's schedule; its furthest fixture has no match centre yet.
const schedule = await page(`/cricket-team/x/${INDIA_TEAM}/schedule`, [
  "teamMatchesData",
]);
await save("cb-india-schedule.flight.txt", schedule);
await save(
  "cb-india-results.flight.txt",
  await page(`/cricket-team/x/${INDIA_TEAM}/results`, ["teamMatchesData"]),
);
const ahead = cricbuzz
  .fixtures(schedule, "teamMatchesData")
  .filter((m) => m.phase === "upcoming")
  .at(-1);
if (!ahead) throw new Error("India's schedule lists no upcoming fixture");

// --- Match centre: live, completed and not yet open.
const commLive = await json(`${CB}/api/mcenter/comm/${live.id}`);
await save("cb-comm-live.json", commLive);
await save(
  "cb-comm-done.json",
  await json(`${CB}/api/mcenter/comm/${done.id}`),
);
await save(
  "cb-comm-upcoming.json",
  await json(`${CB}/api/mcenter/comm/${ahead.id}`),
);
const oldest = cricbuzz.commentary(commLive?.matchCommentary).at(-1);
if (oldest)
  await save(
    "cb-comm-page.json",
    await json(
      `${CB}/api/mcenter/commentary-pagination/${live.id}/${oldest.inn ?? 1}/${oldest.ts}`,
    ),
  );

// --- Scorecards, squads, series.
await save(
  "cb-scorecard-live.flight.txt",
  await page(`/live-cricket-scorecard/${live.id}/x`, [
    "scoreCard",
    "matchInfo",
  ]),
);
await save(
  "cb-scorecard-upcoming.flight.txt",
  await page(`/live-cricket-scorecard/${ahead.id}/x`, [
    "scoreCard",
    "matchInfo",
  ]),
);
await save(
  "cb-squads.flight.txt",
  await page(`/cricket-match-squads/${done.id}/x`, ["team1", "team2"]),
);
await save(
  "cb-ipl-series.flight.txt",
  await page(`/cricket-series/${PAST_IPL_SERIES}/x/matches`, ["matchDetails"]),
);
await save(
  "cb-series-league.flight.txt",
  await page("/cricket-schedule/series/league", ["seriesScheduleData"]),
);

// --- Cricinfo (ESPN API), cut down to the fields the adapter reads.
const panel = await json(`${CI}/scorepanel`);
await save("ci-panel.json", {
  scores: (panel?.scores ?? []).map((g) => ({
    leagues: [{ id: g.leagues?.[0]?.id }],
    events: (g.events ?? []).map((e) => ({
      id: e.id,
      date: e.date,
      links: (e.links ?? []).map((l) => ({ href: l.href })),
      competitions: [
        {
          competitors: (e.competitions?.[0]?.competitors ?? []).map((c) => ({
            id: c.id,
            homeAway: c.homeAway,
            team: { displayName: c.team?.displayName },
          })),
        },
      ],
    })),
  })),
});
const ev = cricinfo.event(cricinfo.panel(panel), {
  t1: live.t1.name,
  t2: live.t2.name,
  start: live.start,
});
if (ev) {
  const summary = await json(`${CI}/${ev.league}/summary?event=${ev.id}`);
  await save("ci-summary.json", {
    gameInfo: summary?.gameInfo,
    notes: summary?.notes,
    debuts: summary?.debuts,
  });
  const first = (
    await json(`${CI}/${ev.league}/playbyplay?event=${ev.id}&page=1`)
  )?.commentary;
  await save("ci-pbp-first.json", first);
  const lastPage = first?.pageCount || 1;
  if (lastPage > 1)
    await save(
      "ci-pbp-last.json",
      (
        await json(
          `${CI}/${ev.league}/playbyplay?event=${ev.id}&page=${lastPage}`,
        )
      )?.commentary,
    );
}
const ipl = await json(`${CI}/8048/scoreboard`);
await save("ci-ipl.json", {
  leagues: [{ calendar: ipl?.leagues?.[0]?.calendar }],
  events: ipl?.events,
});

const brief = (m) => ({
  id: m.id,
  name: `${m.t1.name} v ${m.t2.name}`,
  desc: m.desc,
  state: m.state,
});
await save("manifest.json", {
  capturedAt: new Date().toISOString(),
  live: brief(live),
  done: brief(done),
  upcoming: brief(ahead),
  pastIplSeries: PAST_IPL_SERIES,
  cricinfoEvent: ev,
});
