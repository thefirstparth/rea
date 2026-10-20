// Records every /api answer the Crease UI asks for while visiting each view, for the
// offline UI tests (test/ui.test.mjs). Run against a running local server:
//
//   NODE_USE_ENV_PROXY=1 node experiments/cricket-live/server.mjs &
//   node experiments/cricket-live/test/capture-ui.mjs [http://127.0.0.1:5173]
//
// It picks a live match, a finished India match and India's next fixture from the
// server's own lists, opens each of their sections, loads earlier commentary and
// switches the commentary source, so the recording covers what those views fetch. It
// follows an IPL side throughout, for the team card and the IPL tab's tables.
// Browser: CREASE_BROWSER, else Playwright's default Chromium.

import { writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "http://127.0.0.1:5173";
// Royal Challengers Bengaluru, Cricbuzz team 59: the followed team in the recording.
const FOLLOWED = {
  id: 59,
  name: "Royal Challengers Bengaluru",
  short: "RCB",
  flag: null,
  ipl: true,
};
const OUT = new URL("./fixtures/ui-api.json", import.meta.url);

const get = async (path) => (await fetch(BASE + path)).json();
const list = (await get("/api/matches")).matches;
const sched = await get("/api/schedule");
const pick = {
  live:
    list.find((m) => m.phase === "live" && /in progress/i.test(m.state)) ??
    list.find((m) => m.phase === "live"),
  done: sched.indiaResults?.[0] ?? list.find((m) => m.phase === "done"),
  next: sched.india?.[0],
};
for (const [k, m] of Object.entries(pick))
  if (!m) throw new Error(`No ${k} match to record`);

const browser = await chromium.launch({
  executablePath: process.env.CREASE_BROWSER || undefined,
  args: process.env.HTTPS_PROXY
    ? [
        `--proxy-server=https=${new URL(process.env.HTTPS_PROXY).host}`,
        "--proxy-bypass-list=<-loopback>",
      ]
    : [],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
// Follow an IPL side, so the recording has a team's fixtures and last season's table.
await page.addInitScript(
  (t) => localStorage.setItem("crease-team", t),
  JSON.stringify(FOLLOWED),
);
const api = {};
page.on("response", async (res) => {
  const url = new URL(res.url());
  if (!url.pathname.startsWith("/api/")) return;
  try {
    api[url.pathname + url.search] = {
      status: res.status(),
      body: await res.json(),
    };
  } catch {
    // Not JSON: nothing to replay.
  }
});
// A full load per view (not a hash change), so each view fetches what it needs.
const visit = async (hash) => {
  await page.goto("about:blank");
  await page.goto(`${BASE}/${hash}`);
  await page.locator("#view .page").waitFor();
  await page.waitForTimeout(2500);
};
const clickIf = async (selector) => {
  const el = page.locator(selector).first();
  if (!(await el.count())) return console.log(`(no ${selector})`);
  await el.dispatchEvent("click");
  await page.waitForTimeout(3000);
};

for (const tab of ["#now", "#india", "#ipl", "#all"]) await visit(tab);
for (const m of Object.values(pick))
  for (const section of ["live", "scorecard", "squads", "info"]) {
    await visit(`#m/${m.id}/${section}`);
    if (section === "live") {
      await clickIf('button[data-act="older"]');
      await clickIf('button[data-act="src"][data-src="ci"]');
      await clickIf('button[data-act="ci-older"]');
      await clickIf('button[data-act="src"][data-src="cb"]');
    }
  }
await browser.close();

await writeFile(
  OUT,
  `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    matches: Object.fromEntries(
      Object.entries(pick).map(([k, m]) => [k, String(m.id)]),
    ),
    api,
  })}\n`,
);
console.log(
  `${Object.keys(api).length} answers recorded`,
  pick.live.id,
  pick.done.id,
  pick.next.id,
);
