// Alert detection (public/alerts.js) over a recorded live match, then controlled changes
// to it: what fires, what fires once, and what never fires on first sight.
// Run: node --test "experiments/cricket-live/test/*.test.mjs"

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as cb } from "../lib/cricbuzz.mjs";
import { snapshot, step } from "../public/alerts.js";

const live = cb.match(
  JSON.parse(
    readFileSync(new URL("./fixtures/cb-comm-live.json", import.meta.url)),
  ),
);
const listEntry = {
  id: 1,
  phase: "live",
  t1: live.header.t1,
  t2: live.header.t2,
  desc: live.header.desc,
  status: live.header.status,
  s1: [],
  s2: [],
};

// The recorded payload with its live figures changed.
function changed({ wkts = 0, bat = {}, bowl = {}, phase } = {}) {
  const d = structuredClone(live);
  if (phase) d.header.phase = phase;
  d.mini.innings.at(-1).w += wkts;
  Object.assign(d.mini.striker, bat);
  Object.assign(d.mini.bowler, bowl);
  return snapshot(listEntry, d);
}

const run = (...snaps) => {
  let state;
  return snaps.map((s) => {
    const out = step(state, s);
    state = out.state;
    return out.events;
  });
};

test("snapshot reads the recorded live payload", () => {
  const s = snapshot(listEntry, live);
  const total = live.mini.innings.reduce((n, i) => n + i.w, 0);
  assert.equal(s.wkts, total);
  assert.equal(s.phase, "live");
  assert.ok(s.bat.length && s.bat.every((p) => p.name && Number.isFinite(p.r)));
  assert.match(s.score, /^\d+\/\d+ \(\d+(\.\d)? ov\)$/);
});

test("first sight replays nothing, even milestones already reached", () => {
  const [first] = run(changed({ bat: { r: 120 }, bowl: { w: 6 } }));
  assert.deepEqual(first, []);
});

test("match start fires when a followed match goes live", () => {
  const [, events] = run(changed({ phase: "upcoming" }), changed());
  assert.equal(events.length, 1);
  assert.match(events[0].title, /has started$/);
});

test("a wicket fires once, with the dismissal; a stale count does not repeat it", () => {
  const base = changed();
  const out = run(base, changed({ wkts: 1 }), base, changed({ wkts: 1 }));
  assert.equal(out[1].length, 1);
  assert.match(out[1][0].title, /^Wicket! /);
  assert.equal(
    out[1][0].body,
    live.mini.lastWicket.replace(/\s+/g, " ").trim(),
  );
  assert.deepEqual(out[2], []);
  assert.deepEqual(out[3], []);
  const [, two] = run(base, changed({ wkts: 2 }));
  assert.match(two[0].title, /^2 wickets! /);
});

test("fifty, then hundred, each once per batter", () => {
  const out = run(
    changed({ bat: { r: 48 } }),
    changed({ bat: { r: 51 } }),
    changed({ bat: { r: 60 } }),
    changed({ bat: { r: 100 } }),
  );
  assert.deepEqual(
    out.map((e) => e.map((x) => x.title.split(" for ")[0])),
    [[], ["Fifty"], [], ["Hundred"]],
  );
});

test("a five-for fires once", () => {
  const out = run(
    changed({ bowl: { w: 4 } }),
    changed({ bowl: { w: 5 } }),
    changed({ bowl: { w: 6 } }),
  );
  assert.deepEqual(
    out.map((e) => e.length),
    [0, 1, 0],
  );
  assert.match(out[1][0].title, /^Five-for for /);
});

// The Jewel Andrew review (test/fixtures/cb-comm-reviews.json): asked for, then decided.
test("a review fires when asked for and again with its outcome, under one tag", () => {
  const raw = JSON.parse(
    readFileSync(new URL("./fixtures/cb-comm-reviews.json", import.meta.url)),
  );
  const upTo = (ts) => {
    const d = structuredClone(live);
    d.commentary = cb.commentary(
      raw.filter((v) => v.timestamp >= 1791985946891 && v.timestamp <= ts),
      { live: true },
    );
    return snapshot(listEntry, d);
  };
  const out = run(
    upTo(1791985946891),
    upTo(1791985980199),
    upTo(1791986065519),
    upTo(1791986065519),
  );
  assert.deepEqual(out[0], []);
  assert.match(out[1][0].title, /^Review! /);
  assert.match(out[1][0].body, /Jewel Andrew reviews/);
  assert.match(out[2][0].title, /^Review: Out stands · review lost · /);
  assert.equal(out[1][0].tag, out[2][0].tag);
  assert.deepEqual(out[3], []);
  // Opening the app on a decided review doesn't replay it.
  assert.deepEqual(run(upTo(1791986065519))[0], []);
});
