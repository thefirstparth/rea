// Offline tests over real payloads recorded by test/capture.mjs. Assertions are
// invariants that hold for any capture, plus regressions for bugs already seen.
// Run: node --test "experiments/cricket-live/test/*.test.mjs"

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as cb } from "../lib/cricbuzz.mjs";
import { parse as ci } from "../lib/cricinfo.mjs";
import { cleanHtml } from "../lib/html.mjs";
import { handleApi } from "../lib/api.mjs";

const read = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const json = (name) => JSON.parse(read(name));
const manifest = json("manifest.json");

const PHASES = new Set(["live", "upcoming", "done"]);
const WOMEN = /\bwomen/i;

// What every normalised match must satisfy, whichever feed it came from.
function assertMatch(m) {
  assert.ok(Number.isInteger(m.id), `id ${m.id}`);
  assert.ok(m.t1.name && m.t2.name, `teams of ${m.id}`);
  assert.ok(PHASES.has(m.phase), `phase ${m.phase} of ${m.id}`);
  assert.doesNotMatch(`${m.t1.name} ${m.t2.name} ${m.series}`, WOMEN);
  assert.doesNotMatch(
    m.t1.name,
    /^[A-Z\s]{8,}$/,
    "all-caps name not title-cased",
  );
  for (const i of [...m.s1, ...m.s2])
    assert.notEqual(Math.round((i.o % 1) * 10), 6, `overs ${i.o} of ${m.id}`);
  for (const t of m.tags) assert.ok(t === "india" || t === "ipl");
}

test("live-scores list parses into valid men's matches", () => {
  const list = cb.list(read("cb-live-list.flight.txt"));
  assert.ok(list.length > 0);
  list.forEach(assertMatch);
  assert.ok(
    list.some((m) => m.id === manifest.live.id),
    "captured live match listed",
  );
});

test("home feed parses into valid men's matches", () => {
  cb.home(json("cb-home.json")).forEach(assertMatch);
});

test("women's matches are dropped where matches are first parsed", () => {
  const entry = (team1, team2, seriesName) => ({
    matchInfo: {
      matchId: 1,
      seriesName,
      state: "In Progress",
      team1: { teamName: team1 },
      team2: { teamName: team2 },
    },
  });
  const flight = `"typeMatches":${JSON.stringify([
    {
      seriesMatches: [
        {
          seriesAdWrapper: {
            matches: [
              entry(
                "India Women",
                "Zimbabwe Women",
                "Zimbabwe Women tour of India",
              ),
              entry(
                "Mumbai Indians",
                "Delhi Capitals",
                "Women's Premier League 2027",
              ),
              entry("India", "New Zealand", "India tour of New Zealand"),
            ],
          },
        },
      ],
    },
  ])}`;
  assert.deepEqual(
    cb.list(flight).map((m) => m.t1.name),
    ["India"],
  );
  assert.throws(
    () =>
      cb.match({
        matchHeader: {
          matchId: 2,
          seriesName: "Zimbabwe Women tour of India",
          team1: { name: "India Women" },
          team2: { name: "Zimbabwe Women" },
        },
      }),
    { status: 404 },
  );
});

test("live match centre: header, miniscore and sanitised newest-first commentary", () => {
  const m = cb.match(json("cb-comm-live.json"));
  assert.equal(m.header.id, manifest.live.id);
  assert.ok(PHASES.has(m.header.phase));
  const ts = m.commentary.map((c) => c.ts);
  assert.deepEqual(
    ts,
    ts.toSorted((a, b) => b - a),
  );
  for (const c of m.commentary) {
    assert.ok(["ball", "note", "over"].includes(c.kind));
    if (c.html)
      assert.doesNotMatch(c.html, /<(?!\/?(b|i|br)>)/, "only b, i, br tags");
    if (c.event) assert.ok(["four", "six", "wicket"].includes(c.event));
  }
  if (m.mini)
    for (const i of m.mini.innings)
      assert.notEqual(Math.round((i.o % 1) * 10), 6);
});

test("completed match centre carries a result", () => {
  const m = cb.match(json("cb-comm-done.json"));
  assert.equal(m.header.id, manifest.done.id);
  assert.equal(m.header.phase, "done");
  assert.ok(m.header.status);
});

test("a match centre that isn't open yet is a 404, not a crash", () => {
  assert.throws(() => cb.match(json("cb-comm-upcoming.json")), {
    status: 404,
    message: /hasn't opened/,
  });
});

test("older commentary pages come before the latest page", () => {
  const latest = cb.match(json("cb-comm-live.json")).commentary;
  const older = cb.commentary(json("cb-comm-page.json"));
  assert.ok(older.length > 0);
  assert.ok(older[0].ts < latest.at(-1).ts);
});

test("scorecard reads the requested match, never the site-wide ticker", () => {
  const listed = cb
    .list(read("cb-live-list.flight.txt"))
    .find((m) => m.id === manifest.live.id);
  const card = cb.scorecard(
    read("cb-scorecard-live.flight.txt"),
    manifest.live.id,
  );
  assert.ok(card.innings.length > 0);
  assert.deepEqual(
    card.innings.map((i) => i.inn),
    card.innings.map((i) => i.inn).toSorted((a, b) => a - b),
  );
  if (listed?.venue) assert.equal(card.venue?.ground, listed.venue.ground);

  // Regression: this page has no matchInfo of its own, only the ticker's. The
  // adapter used to take the first one and report another match's venue.
  const upcoming = read("cb-scorecard-upcoming.flight.txt");
  assert.match(upcoming, /"venueInfo":/, "precondition: ticker venues present");
  const empty = cb.scorecard(upcoming, manifest.upcoming.id);
  assert.equal(empty.venue, null);
  assert.deepEqual(empty.innings, []);
});

test("squads: two sides, RSC $undefined removed, staff carry no captaincy", () => {
  const { teams } = cb.squads(read("cb-squads.flight.txt"));
  assert.equal(teams.length, 2);
  assert.doesNotMatch(JSON.stringify(teams), /\$undefined/);
  for (const t of teams)
    for (const g of t.groups)
      if (/staff/i.test(g.label))
        for (const p of g.players)
          assert.ok(!p.c && !p.wk && !p.bat && !p.bowl);
  // A page without the squads widget (only the ticker's team1/team2) yields no teams.
  assert.deepEqual(
    cb.squads(read("cb-scorecard-upcoming.flight.txt")).teams,
    [],
  );
});

test("India's schedule: men's India fixtures, beyond the live feeds' horizon", () => {
  const fixtures = cb.fixtures(
    read("cb-india-schedule.flight.txt"),
    "teamMatchesData",
  );
  assert.ok(fixtures.length > 0);
  fixtures.forEach(assertMatch);
  for (const m of fixtures)
    assert.ok(m.tags.includes("india"), `${m.id} tagged india`);
  assert.ok(fixtures.some((m) => m.id === manifest.upcoming.id));
});

test("IPL series page: a full season, title-cased, tagged ipl", () => {
  const all = cb.seriesFixtures(
    read("cb-ipl-series.flight.txt"),
    manifest.pastIplSeries,
  );
  assert.ok(all.length >= 70, `${all.length} IPL fixtures`);
  all.forEach(assertMatch);
  for (const m of all) assert.ok(m.tags.includes("ipl"));
  assert.ok(all.some((m) => m.desc === "Final" && m.phase === "done"));
});

test("India results page: completed India matches with a result line", () => {
  const all = cb.fixtures(
    read("cb-india-results.flight.txt"),
    "teamMatchesData",
  );
  assert.ok(all.length > 0);
  all.forEach(assertMatch);
  for (const m of all) {
    assert.equal(m.phase, "done");
    assert.ok(m.tags.includes("india"), `${m.t1.name} v ${m.t2.name}`);
    assert.ok(m.status, "result line");
  }
});

test("next IPL season: from the league schedule, never a finished one", () => {
  const series = cb.leagueSeries(read("cb-series-league.flight.txt"));
  assert.ok(series.length > 0);
  const at = Date.parse(manifest.capturedAt);
  // The league schedule lists the next IPL all year; the streaming-only API did not.
  const next = cb.iplSeries(series, at);
  assert.ok(next, "IPL season listed");
  assert.match(next.name, /premier league|ipl/i);
  assert.ok(next.end >= at);
  assert.notEqual(cb.iplSeries(series, next.end + 1)?.id, next.id);
});

test("league schedule without its series list is a failure, not an empty calendar", () => {
  assert.throws(() => cb.leagueSeries('"other":[]'), /no series list/);
});

test("Cricinfo: fixture lookup, match info and live-blog commentary", (t) => {
  const events = ci.panel(json("ci-panel.json"));
  assert.ok(events.every((e) => e.league && e.id));
  if (!manifest.cricinfoEvent)
    return t.skip("no Cricinfo event matched at capture");
  const ev = ci.event(events, {
    t1: manifest.live.name.split(" v ")[0],
    t2: manifest.live.name.split(" v ")[1],
    start: manifest.cricinfoEvent.date,
  });
  assert.equal(ev?.id, manifest.cricinfoEvent.id);
  assert.equal(
    ci.event(events, { t1: "Nowhere", t2: "Nobody", start: null }),
    null,
  );

  const info = ci.info(json("ci-summary.json"), ev);
  assert.ok(Array.isArray(info.officials));

  const last = (() => {
    try {
      return json("ci-pbp-last.json");
    } catch {
      return json("ci-pbp-first.json");
    }
  })();
  const { items, olderPage } = ci.commentary(
    [last],
    ev.homeId,
    last.pageIndex ?? 1,
  );
  const ts = items.map((i) => i.ts);
  assert.equal(new Set(ts).size, ts.length, "each entry has its own ts");
  assert.deepEqual(
    ts,
    ts.toSorted((a, b) => b - a),
  );
  for (const i of items)
    if (i.html) assert.doesNotMatch(i.html, /<a\b|<script/i);
  assert.equal(
    olderPage,
    (last.pageIndex ?? 1) > 1 ? last.pageIndex - 1 : null,
  );
});

test("Cricinfo IPL scoreboard: season window and latest result", () => {
  const s = ci.iplSeason(json("ci-ipl.json"));
  assert.ok(s.seasonStart && s.seasonEnd && s.seasonStart < s.seasonEnd);
  for (const m of s.latest) {
    assert.equal(m.sides.length, 2);
    // The card shows each side's own logo and abbreviation, not initials of its name.
    for (const x of m.sides) {
      assert.match(x.short, /^[A-Z]{2,5}$/);
      assert.match(x.logo, /^https:\/\/.+\.png$/);
    }
  }
});

test("commentary sanitiser keeps b/i/br, unwraps links, escapes the rest", () => {
  assert.equal(
    cleanHtml('<b>Four!</b> <a href="x">MATCH UP</a>'),
    "<b>Four!</b> MATCH UP",
  );
  assert.equal(
    cleanHtml("<script>x</script>"),
    "&lt;script&gt;x&lt;/script&gt;",
  );
  assert.equal(cleanHtml("R &amp; D & co, 97/5"), "R &amp; D &amp; co, 97/5");
  assert.equal(cleanHtml("</b>stray <i>open"), "stray <i>open</i>");
  assert.equal(cleanHtml("<strong>a</strong><br/>b"), "<b>a</b><br>b");
});

test("API rejects bad input before touching upstream", async () => {
  const call = (path, query = "") =>
    new Promise((resolve) => {
      const res = {
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
        end(body) {
          resolve({
            status: this.status,
            cache: this.headers["cache-control"],
            body: JSON.parse(body),
          });
        },
      };
      handleApi(res, path, new URLSearchParams(query));
    });
  assert.equal((await call("/api/nope")).status, 404);
  assert.equal((await call("/api/match/abc")).status, 404);
  assert.equal((await call("/api/match/1/scorecard/x")).status, 404);
  const bad = await call("/api/match/1/cricinfo/commentary", "page=x");
  assert.equal(bad.status, 400);
  assert.equal(bad.cache, "no-store");
  assert.equal((await call("/api/match/1/commentary", "inn=1")).status, 400);
});
