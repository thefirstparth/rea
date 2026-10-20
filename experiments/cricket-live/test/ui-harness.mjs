// The offline browser harness shared by Crease's UI tests: a server for public/ that
// replays every /api answer from test/fixtures/ui-api.json (recorded by
// test/capture-ui.mjs), a Chromium, a page opener with its clock and the reader's
// choices preset, and the layout audit (test/ui-audit.mjs) over a whole page.
// Other hosts are stubbed (images) or refused (fonts), so the tests need no network.
//
// Needs Chromium: CREASE_BROWSER, else Playwright's own; tests skip when there is none.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { auditScript } from "./ui-audit.mjs";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
export const rec = JSON.parse(
  await readFile(new URL("./fixtures/ui-api.json", import.meta.url), "utf8"),
);
export const { live, done, next } = rec.matches;
// What the server answers; scenario tests swap in a changed copy (setApi).
let api = rec.api;
export const setApi = (answers = rec.api) => {
  api = answers;
};
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
export const skip =
  !chromium || !executablePath ? "no Chromium available" : false;

let server;
let base;
let browser;

export async function start() {
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
}

export async function stop() {
  await browser?.close();
  server?.close();
}

// `at` sets the page clock (default: when the data was recorded); `store` presets the
// reader's choices in localStorage.
export async function open(
  hash,
  {
    width = 390,
    height = 844,
    theme = "light",
    at = rec.capturedAt,
    store = {},
    // The service worker answers the page's requests itself; most tests block it so
    // their page.route() failures reach the page. The offline test allows it.
    serviceWorkers = "block",
  } = {},
) {
  const context = await browser.newContext({
    viewport: { width, height },
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    serviceWorkers,
  });
  await context.addInitScript(
    ([t, extra]) => {
      try {
        localStorage.setItem("crease-theme", t);
        for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
      } catch {
        // Storage blocked: the defaults apply.
      }
    },
    [theme, store],
  );
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.host === new URL(base).host) return route.continue();
    if (route.request().resourceType() === "image")
      return route.fulfill({ contentType: "image/png", body: PIXEL });
    return route.abort();
  });
  const page = await context.newPage();
  await page.clock.install({ time: new Date(at) });
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
export async function audit(page) {
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
