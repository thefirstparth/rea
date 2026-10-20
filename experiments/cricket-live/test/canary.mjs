// Crease's daily check against the live sources, through the deployed app's own API
// (so Vercel, the adapters and Cricbuzz/ESPN are all on the path a reader uses).
// Each check asserts what must hold on any day of the year, quiet or not: a source
// that changed its format fails here before a reader notices.
//
//   node experiments/cricket-live/test/canary.mjs [https://trycrease.vercel.app]
//
// Prints a Markdown report; exits 1 when any check fails. .github/workflows/
// crease-canary.yml runs it daily and opens an issue on failure.

const BASE = (process.argv[2] ?? "https://trycrease.vercel.app").replace(
  /\/$/,
  "",
);
const results = [];

async function get(path) {
  const res = await fetch(BASE + path, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(60000),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON: the check reports the status.
  }
  return { status: res.status, body };
}

// One named check: `fn` throws (or returns a string) to fail.
async function check(name, fn) {
  try {
    const note = await fn();
    results.push({ name, ok: true, note: note ?? "" });
  } catch (e) {
    results.push({ name, ok: false, note: e.message });
  }
}

const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function ok(path) {
  const r = await get(path);
  must(
    r.status === 200,
    `${path} answered ${r.status}${r.body?.error ? `: ${r.body.error}` : ""}`,
  );
  return r.body;
}

const PHASES = new Set(["live", "upcoming", "done"]);
let list = [];
let sched = null;
let tour = null;

await check("Page loads", async () => {
  const res = await fetch(BASE + "/", { signal: AbortSignal.timeout(60000) });
  must(res.status === 200, `/ answered ${res.status}`);
  must((await res.text()).includes('id="view"'), "the page has no #view");
});

await check("Match lists (Cricbuzz list pages and home feed)", async () => {
  const d = await ok("/api/matches");
  list = d.matches ?? [];
  must(list.length > 0, "no matches at all (live, recent or upcoming)");
  for (const m of list) {
    must(Number.isInteger(m.id), `a match without an id`);
    must(m.t1?.name && m.t2?.name, `match ${m.id} has no team names`);
    must(PHASES.has(m.phase), `match ${m.id} has phase ${m.phase}`);
  }
  must(Date.now() - d.asOf < 10 * 60000, "the list is over ten minutes old");
  return `${list.length} matches, ${list.filter((m) => m.phase === "live").length} live`;
});

await check("Schedules (India's pages, league schedule, archive)", async () => {
  sched = await ok("/api/schedule");
  must(
    !sched.failed?.length,
    `parts failed: ${(sched.failed ?? []).join(", ")}`,
  );
  must(sched.indiaResults?.length > 0, "India have no results listed");
  must(sched.iplLast?.id, "no finished IPL season found in the archive");
  must(sched.iplLast.final, "last IPL season's final not found");
  return `India: ${sched.india.length} ahead; IPL: ${sched.ipl?.name ?? "none listed"}, last ${sched.iplLast.name}`;
});

await check("IPL points table (last finished season)", async () => {
  must(sched?.iplLast?.id, "no season to check");
  const t = await ok(`/api/series/${sched.iplLast.id}/table`);
  const teams = t.groups?.[0]?.teams ?? [];
  must(teams.length >= 8, `only ${teams.length} teams`);
  must(
    teams.every((x) => x.short && Number.isFinite(x.points)),
    "a team without a name or points",
  );
});

await check("ICC event (World Cup tab)", async () => {
  tour = await ok("/api/tournament");
  if (!tour.event) return "none ahead for India";
  must(tour.event.fixtures?.length > 0, "the event has no matches");
  must(
    tour.event.fixtures.every((m) => m.seriesId === tour.event.id),
    "matches from another series",
  );
  const t = await get(`/api/series/${tour.event.id}/table`);
  // A table can be published late; only a broken route fails.
  must(t.status === 200 || t.status === 404, `table answered ${t.status}`);
  return `${tour.event.name}: ${tour.event.fixtures.length} matches, table ${t.status === 200 ? "published" : "not yet"}`;
});

await check("Team pages (following a team)", async () => {
  const d = await ok("/api/team/2");
  must(!d.failed, "one of India's team pages failed");
  must(d.results.length > 0, "no results on India's team page");
});

// A match to open: live first, else the latest finished one.
const pickMatch = () =>
  list.find((m) => m.phase === "live" && /in progress/i.test(m.state)) ??
  list.find((m) => m.phase === "live") ??
  [...list]
    .filter((m) => m.phase === "done")
    .sort((a, b) => b.start - a.start)[0];

await check("Match centre, scorecard and squads", async () => {
  const m = pickMatch();
  must(m, "no live or finished match to open");
  const d = await ok(`/api/match/${m.id}`);
  must(d.header?.t1?.name, "the match centre has no header");
  must(Array.isArray(d.commentary), "no commentary list");
  const card = await ok(`/api/match/${m.id}/scorecard`);
  must(Array.isArray(card.innings), "the scorecard has no innings list");
  if (m.phase !== "upcoming")
    must(card.innings.length > 0, "a started match with an empty scorecard");
  const sq = await ok(`/api/match/${m.id}/squads`);
  must(Array.isArray(sq.teams), "squads have no team list");
  return `${m.t1.short} v ${m.t2.short} (${m.phase}): ${d.commentary.length} commentary items, ${card.innings.length} innings`;
});

await check("Cricinfo (ESPN) for the same match", async () => {
  const m = pickMatch();
  must(m, "no match to look up");
  const d = await ok(`/api/match/${m.id}/cricinfo`);
  // Not every match is on Cricinfo; a broken ESPN API fails the request instead.
  return d.available ? "found" : "not listed (fine)";
});

const failed = results.filter((r) => !r.ok);
console.log(
  `## Crease canary: ${failed.length ? `${failed.length} of ${results.length} checks failed` : "all checks passed"}\n`,
);
console.log(`Against ${BASE} at ${new Date().toISOString()}.\n`);
console.log("| Check | Result | Detail |\n| --- | --- | --- |");
for (const r of results)
  console.log(
    `| ${r.name} | ${r.ok ? "pass" : "**FAIL**"} | ${r.note.replace(/\|/g, "/")} |`,
  );
if (failed.length)
  console.log(
    '\nA failing check names the route and what broke. See experiments/cricket-live/README.md, "When a source changes".',
  );
process.exitCode = failed.length ? 1 : 0;
