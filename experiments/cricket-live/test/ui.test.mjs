// Crease in a real browser, offline: the app from public/ with every /api answer replayed
// from test/fixtures/ui-api.json (recorded by test/capture-ui.mjs) and the page clock set
// to the recording time. Other hosts are stubbed (images) or refused (fonts), so the run
// needs no network.
//
// Every view is audited at phone and desktop widths in light and dark (test/ui-audit.mjs):
// nothing may overlap, overflow, be cut off, fall below WCAG AA contrast, be too small
// to tap, or log an error. Then the behaviours readers tripped over are checked.
//
// Needs Chromium: CREASE_BROWSER, else Playwright's own; skips when there is none.
// Run: node --test "experiments/cricket-live/test/*.test.mjs"

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { auditScript } from "./ui-audit.mjs";
import { parse as cb } from "../lib/cricbuzz.mjs";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const rec = JSON.parse(
  await readFile(new URL("./fixtures/ui-api.json", import.meta.url), "utf8"),
);
const { live, done, next } = rec.matches;
// What the server answers; the worst-case test swaps in a harder version.
let api = rec.api;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};
// A 1x1 transparent PNG for every image from another host.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

let chromium = null;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  // playwright-core not installed: the browser tests skip.
}
const executablePath =
  process.env.CREASE_BROWSER ||
  ["/opt/pw-browsers/chromium", "/usr/bin/google-chrome"].find(existsSync);
const skip = !chromium || !executablePath ? "no Chromium available" : false;

let server;
let base;
let browser;

before(async () => {
  if (skip) return;
  server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/")) {
      const hit = api[url.pathname + url.search];
      res.writeHead(hit?.status ?? 404, { "content-type": "application/json" });
      return res.end(JSON.stringify(hit?.body ?? { error: "Not recorded" }));
    }
    const file = normalize(
      join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname),
    );
    try {
      if (!file.startsWith(PUBLIC)) throw new Error("outside");
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "text/plain",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath,
    // CI runners need Chrome's sandbox off, as the repo's other browser jobs do.
    args: process.env.CREASE_BROWSER_NO_SANDBOX ? ["--no-sandbox"] : [],
  });
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function open(hash, { width = 390, height = 844, theme = "light" } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  });
  await context.addInitScript((t) => {
    try {
      localStorage.setItem("crease-theme", t);
    } catch {
      // Storage blocked: the default theme applies.
    }
  }, theme);
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.host === new URL(base).host) return route.continue();
    if (route.request().resourceType() === "image")
      return route.fulfill({ contentType: "image/png", body: PIXEL });
    return route.abort();
  });
  const page = await context.newPage();
  await page.clock.install({ time: new Date(rec.capturedAt) });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // Requests to other hosts are refused on purpose (fonts); only the app's count.
    const at = m.location()?.url ?? "";
    if (at && !at.startsWith(base)) return;
    // A recorded 404 (a fixture without a match centre) is expected; others are not.
    if (m.type() === "error" && !/status of 404/.test(m.text()))
      errors.push(m.text());
  });
  await page.goto(`${base}/${hash}`);
  // The app renders into #view; the About page is static.
  await page.locator(hash.endsWith(".html") ? "main" : "#view .page").waitFor();
  await page.waitForTimeout(400);
  return { page, errors, close: () => context.close() };
}

// Run the audit over the whole page: layout once, contrast at each scroll position.
async function audit(page) {
  await page.evaluate(() =>
    document.querySelectorAll("details").forEach((d) => (d.open = true)),
  );
  await page.waitForTimeout(100);
  const found = await page.evaluate(auditScript());
  const { inner, total } = await page.evaluate(() => ({
    inner: innerHeight,
    total: document.scrollingElement.scrollHeight,
  }));
  for (let y = inner - 120; y < total; y += inner - 120) {
    await page.evaluate((top) => scrollTo(0, top), y);
    // Let the top bar finish fading to solid before judging contrast.
    await page.waitForTimeout(400);
    found.push(...(await page.evaluate(auditScript("contrast"))));
  }
  return found;
}

const ROUTES = [
  "#now",
  "#india",
  "#ipl",
  "#all",
  ...[live, done, next].flatMap((id) =>
    ["live", "scorecard", "squads", "info"].map((s) => `#m/${id}/${s}`),
  ),
  "/about.html",
];

for (const theme of ["light", "dark"])
  for (const [width, height] of [
    [320, 640],
    [390, 844],
    [1280, 800],
  ])
    test(
      `every view is readable at ${width}px in ${theme}`,
      { skip },
      async () => {
        const problems = [];
        for (const r of ROUTES) {
          const v = await open(r.startsWith("/") ? r.slice(1) : r, {
            width,
            height,
            theme,
          });
          for (const f of await audit(v.page))
            problems.push(
              `${r}: ${f.kind}${f.severity ? `/${f.severity}` : ""} ${f.a}${f.b ? ` ⟂ ${f.b}` : ""} ${f.detail ?? ""}`,
            );
          for (const e of v.errors) problems.push(`${r}: error ${e}`);
          await v.close();
        }
        assert.deepEqual(problems, []);
      },
    );

test("the audit catches what it is meant to catch", { skip }, async () => {
  const v = await open("#now");
  await v.page
    .setContent(`<body style="margin:0;font:16px sans-serif;background:#fff">
    <div style="width:42px;white-space:nowrap">7.1<span class="b" style="display:inline-block;width:24px;height:24px;margin-left:-6px;background:#7a2fc0"></span></div>
    <p style="color:#bbb">too faint</p>
    <div style="width:600px">too wide</div>
    <button style="width:20px;height:20px">x</button>
    <img src="data:," alt="" style="width:10px;height:10px">
  </body>`);
  const kinds = new Set(
    (await v.page.evaluate(auditScript())).map((f) => f.kind),
  );
  for (const k of ["overlap", "contrast", "overflow", "target", "image"])
    assert.ok(kinds.has(k), `audit should report ${k}`);
  await v.close();
});

test("commentary badges sit under their ball numbers", { skip }, async () => {
  const v = await open(`#m/${done}/live`);
  const pairs = await v.page.evaluate(() =>
    [...document.querySelectorAll(".ci .ball")]
      .filter((b) => b.querySelector(".b"))
      .map((b) => {
        const n = b.firstElementChild.getBoundingClientRect();
        const chip = b.querySelector(".b").getBoundingClientRect();
        return chip.top >= n.bottom - 0.5;
      }),
  );
  assert.ok(pairs.length, "the recording has 4/6/W balls");
  assert.ok(pairs.every(Boolean));
  await v.close();
});

test(
  "Back leaves a match, whatever sections were visited",
  { skip },
  async () => {
    const v = await open("#now");
    await v.page.evaluate((id) => (location.hash = `#m/${id}/info`), done);
    await v.page.locator(".seg:not(.sub) a", { hasText: "Scorecard" }).click();
    await v.page.locator(".seg:not(.sub) a", { hasText: "Squads" }).click();
    await v.page.locator("#back").click();
    await v.page.waitForFunction(() => location.hash === "#now");
    await v.close();
  },
);

test(
  "a junk address goes home; an unknown match says so",
  { skip },
  async () => {
    const v = await open("#m/abc<script>");
    assert.equal(await v.page.evaluate(() => location.hash), "#now");
    await v.page.evaluate(() => (location.hash = "#m/999999999/live"));
    await v.page.getByText("We couldn't find this match").waitFor();
    await v.close();
  },
);

test(
  "times name their zone, and Settings switches the clock",
  { skip },
  async () => {
    const v = await open("#now");
    const when = () => v.page.locator(".hero.next .when").innerText();
    assert.match(await when(), /\b(am|pm) IST\b/i);
    await v.page.locator("#settingsBtn").click();
    await v.page.locator('input[name=clock][value="24"]').check();
    assert.match(await when(), /\b\d{2}:\d{2} IST\b/);
    assert.doesNotMatch(await when(), /\b(am|pm)\b/i);
    await v.close();
  },
);

test(
  "the bell explains alerts before asking, and says when they're blocked",
  { skip },
  async () => {
    const v = await open("#now");
    await v.page.locator("#alerts").click();
    const sheet = v.page.locator("#alertsSheet");
    await sheet.getByText("only while Crease is open").waitFor();
    assert.equal(
      await sheet.locator("#alertsToggle").innerText(),
      "Turn alerts on",
    );
    await v.close();
  },
);

test("India's latest result is on screen without a tap", { skip }, async () => {
  const v = await open("#india");
  const first = v.page.locator("details[data-default-open]").first();
  assert.equal(await first.evaluate((d) => d.open), true);
  assert.ok(await first.locator(".mr").first().isVisible());
  await v.close();
});

// The recorded live match made as hard to lay out as real matches get: long team names,
// a declared first innings in a two-innings score, a ten-ball over with every extras
// code, reviews left, and real DRS reviews (test/fixtures/cb-comm-reviews.json) with one
// still being decided at the top.
function worstCase() {
  const hard = structuredClone(rec.api);
  const m = hard[`/api/match/${live}`].body;
  const [a, b] = [m.header.t1, m.header.t2];
  a.name = "Himachal Pradesh";
  b.name = "Western Australia";
  const inns = m.mini.innings;
  Object.assign(inns[0], { r: 528, w: 8, dec: true, o: 151 });
  Object.assign(inns.at(-1), { r: 210, w: 4, o: 63.4 });
  m.mini.recent = [
    ["1", "Wd", "Wd", "N1", "4", "W", "L1", "6", "1", "2"],
    ["0", "B4", "2Wd", "6", "W"],
  ];
  m.mini.reviews = [
    { teamId: a.id, left: 2 },
    { teamId: b.id, left: 0 },
  ];
  const raw = JSON.parse(
    readFileSync(new URL("./fixtures/cb-comm-reviews.json", import.meta.url)),
  );
  const top = m.commentary[0].ts;
  const reviews = cb
    .commentary(raw)
    .map((c, i) => ({ ...c, ts: top - 1000 - i }));
  const pending = {
    kind: "note",
    ts: top + 1,
    inn: inns.at(-1).inn,
    ball: null,
    event: null,
    html: "<b>Given out LBW. Aryan Bora reviews.</b> Looked to be sliding down leg.",
    review: { pending: true },
  };
  m.commentary = [pending, ...m.commentary.slice(0, 3), ...reviews];
  const row = hard["/api/matches"].body.matches.find(
    (x) => String(x.id) === live,
  );
  row.t1.name = a.name;
  row.t2.name = b.name;
  row.s1 = [
    { r: 528, w: 8, dec: true, o: 151 },
    { r: 210, w: 4, o: 63.4 },
  ];
  return hard;
}

test(
  "the hardest live match still fits, and shows its reviews",
  { skip },
  async () => {
    api = worstCase();
    try {
      const problems = [];
      const views = ["light", "dark"].flatMap((theme) =>
        [
          [320, 640],
          [412, 915],
          [1280, 800],
        ].flatMap(([width, height]) =>
          [`#m/${live}/live`, "#all"].map((r) => ({ r, width, height, theme })),
        ),
      );
      for (const { r, ...at } of views) {
        const v = await open(r, at);
        for (const f of await audit(v.page))
          problems.push(
            `${at.width} ${at.theme} ${r}: ${f.kind} ${f.a}${f.b ? ` ⟂ ${f.b}` : ""} ${f.detail ?? ""}`,
          );
        for (const e of v.errors) problems.push(`${r}: error ${e}`);
        await v.close();
      }
      assert.deepEqual(problems, []);
      const v = await open(`#m/${live}/live`);
      const text = await v.page.locator("#view").innerText();
      assert.match(text, /Review in progress/i);
      assert.match(text, /Out stands · review lost/);
      assert.match(text, /Overturned · not out/);
      assert.match(text, /Reviews left/i);
      assert.equal(await v.page.locator(".ci .b.drs").count(), 4);
      // Flash notes and the review notes are folded into their deliveries.
      assert.doesNotMatch(text, /THATS OUT!!/);
      await v.close();
    } finally {
      api = rec.api;
    }
  },
);
