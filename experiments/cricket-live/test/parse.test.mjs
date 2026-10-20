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

test("list matches carry their group's type, and venues their UTC offset", () => {
  const list = cb.list(read("cb-live-list.flight.txt"));
  assert.ok(list.length);
  assert.ok(
    list.every((m) => m.type),
    "every match has a type",
  );
  const pindi = list.find((m) => m.venue?.city === "Rawalpindi");
  assert.equal(pindi?.venue.utcOffset, 300);
  const nz = cb
    .fixtures(read("cb-india-schedule.flight.txt"), "teamMatchesData")
    .find((m) => m.venue?.city === "Christchurch");
  assert.equal(nz?.venue.utcOffset, 13 * 60);
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

// Real reviews from three matches (test/fixtures/cb-comm-reviews.json): a batter's lost
// review with Cricbuzz's flash and review notes before the delivery, one with no verdict
// in the text, and two overturned decisions (one each way).
test("DRS reviews: verdicts from the reviewed delivery, flash and review notes folded in", () => {
  const raw = json("cb-comm-reviews.json");
  const items = cb.commentary(raw);
  const at = (ball) => items.find((c) => c.kind === "ball" && c.ball === ball);
  assert.deepEqual(
    [4.2, 8.5, 49.6, 64.4].map((b) => [at(b).event, at(b).review?.verdict]),
    [
      ["wicket", "stands"],
      ["wicket", null],
      ["wicket", "overturned"],
      [null, "overturned"],
    ],
  );
  assert.equal(at(64.3).review, undefined);
  // The duplicates in between are gone; the review note travels with its delivery.
  assert.ok(
    !items.some((c) => c.kind === "note"),
    "no flash or review notes left",
  );
  assert.match(at(4.2).review.notes[0], /Jewel Andrew reviews/);
  // While the reviewed ball isn't posted, the newest review note is pending (live only).
  const asked = raw.filter(
    (v) => v.timestamp >= 1791985946891 && v.timestamp < 1791986064623,
  );
  const pending = cb.commentary(asked, { live: true })[0];
  assert.equal(pending.kind, "note");
  assert.deepEqual(pending.review, { pending: true });
  assert.equal(cb.commentary(asked)[0].review, undefined);
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
  const { items, olderPage } = ci.commentary([last], last.pageIndex ?? 1);
  const ts = items.map((i) => i.ts);
  assert.equal(new Set(ts).size, ts.length, "each entry has its own ts");
  assert.deepEqual(
    ts,
    ts.toSorted((a, b) => b - a),
  );
  for (const i of items)
    if (i.html) assert.doesNotMatch(i.html, /<a\b|<script/i);
  // Regressions: over summaries carry the batting side's real score (homeScore read
  // "0" for a side 241 all out), and blog-only entries add no empty ball row.
  for (const o of items.filter((i) => i.kind === "over"))
    assert.match(o.score, /^\d+\/\d+$/);
  for (const b of items.filter((i) => i.kind === "ball"))
    assert.ok(b.html.replace(/<[^>]+>/g, "").trim(), "ball row has text");
  const raw = last.items.find((i) => i.over?.complete && i.innings);
  if (raw)
    assert.equal(
      items.find((i) => i.kind === "over" && i.over === raw.over.number)?.score,
      `${raw.innings.runs}/${raw.innings.wickets}`,
    );
  assert.equal(
    olderPage,
    (last.pageIndex ?? 1) > 1 ? last.pageIndex - 1 : null,
  );
});

test("points tables: a finished league in order, a group tournament before a ball", () => {
  const [ipl] = cb.pointsTable(read("cb-points-ipl.flight.txt"), 9241);
  assert.equal(ipl.teams.length, 10);
  assert.equal(ipl.qualify, 4);
  // Table order: points never rise down the table.
  for (let i = 1; i < ipl.teams.length; i++)
    assert.ok(ipl.teams[i].points <= ipl.teams[i - 1].points);
  for (const t of ipl.teams) {
    assert.equal(t.played, t.won + t.lost + t.tied + t.nr + t.drawn);
    assert.match(t.short, /^[A-Z]{2,5}$/);
    assert.ok(t.form.length <= 5 && t.form.every((f) => /^[WLN]$/.test(f)));
    assert.equal(t.next, null, "a finished season has nothing next");
  }
  assert.equal(ipl.teams.filter((t) => t.status === "in").length, 4);

  const groups = cb.pointsTable(read("cb-points-tournament.flight.txt"), 13289);
  assert.ok(groups.length >= 2);
  const india = groups.flatMap((g) => g.teams).find((t) => t.short === "IND");
  assert.ok(india, "India is in a group");
  assert.equal(india.played, 0);
  assert.ok(india.next?.start > 0 && india.next.vs);
  // Another series' id finds nothing: never someone else's table.
  assert.equal(cb.pointsTable(read("cb-points-ipl.flight.txt"), 13289), null);
});

test("the series archive lists finished seasons with their dates", () => {
  const all = cb.archiveSeries(read("cb-archive.flight.txt"));
  const ipl = all.find((x) => x.name === "Indian Premier League 2026");
  assert.equal(ipl?.id, 9241);
  assert.ok(ipl.start < ipl.end);
  assert.throws(() => cb.archiveSeries('"other":[]'), /no series list/);
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
