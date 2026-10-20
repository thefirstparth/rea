// Crease in a real browser, offline (test/ui-harness.mjs): the app with every /api
// answer replayed and the page clock set to the recording time.
//
// Every view is audited at phone and desktop widths in light and dark (test/ui-audit.mjs):
// nothing may overlap, overflow, be cut off, fall below WCAG AA contrast, be too small
// to tap, or log an error. Then the behaviours readers tripped over are checked.
// test/ui-scenarios.test.mjs covers harder data and other dates.
//
// Run: node --test "experiments/cricket-live/test/*.test.mjs"

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { auditScript } from "./ui-audit.mjs";
import {
  audit,
  done,
  live,
  next,
  open,
  skip,
  start,
  stop,
} from "./ui-harness.mjs";

before(start);
after(stop);

const ROUTES = [
  "#now",
  "#india",
  "#ipl",
  "#wc",
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
    <div id="view"><div class="ph"><h1>Title</h1></div><div class="card" style="margin-top:60px">x</div></div>
  </body>`);
  const kinds = new Set(
    (await v.page.evaluate(auditScript())).map((f) => f.kind),
  );
  for (const k of ["overlap", "contrast", "overflow", "target", "image", "gap"])
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
  "a junk address goes home; a broken or unknown match link says so",
  { skip },
  async () => {
    const v = await open("#junk<script>");
    assert.equal(await v.page.evaluate(() => location.hash), "#now");
    await v.page.evaluate(() => (location.hash = "#m/abc<script>"));
    await v.page.getByText("We couldn't find this match").waitFor();
    assert.equal(await v.page.locator("#view script").count(), 0);
    await v.page.evaluate(() => (location.hash = "#m/999999999/live"));
    await v.page.getByText("We couldn't find this match").waitFor();
    await v.close();
  },
);

// A Wi-Fi login page, a cut-off body or an answer of the wrong shape is a failure the
// page says and retries, never a page stuck loading or broken until a reload.
test(
  "an unreadable or wrong-shaped answer shows an error and recovers",
  { skip },
  async () => {
    // Info doesn't load the scorecard: opening Scorecard does, through the bad answer.
    const v = await open(`#m/${done}/info`);
    let bad = "<html>Wi-Fi login</html>";
    await v.page.route(/\/api\/match\/\d+\/scorecard$/, (r) =>
      r.fulfill({ status: 200, contentType: "text/html", body: bad }),
    );
    await v.page.locator(".seg:not(.sub) a", { hasText: "Scorecard" }).click();
    await v.page.getByText("Couldn't load the scorecard").waitFor();
    bad = '{"error":"rate limited"}';
    await v.page
      .locator("#view")
      .getByRole("button", { name: "Try again now" })
      .click();
    await v.page.getByText("Couldn't load the scorecard").waitFor();
    assert.deepEqual(v.errors, []);
    await v.page.unroute(/\/api\/match\/\d+\/scorecard$/);
    await v.page.locator("#fresh").click();
    await v.page.locator("details.inn").first().waitFor();
    assert.doesNotMatch(
      await v.page.locator("#freshText").innerText(),
      /Checking/,
    );
    await v.close();
  },
);

test(
  "times name their zone, and Settings switches the clock",
  { skip },
  async () => {
    const v = await open("#now");
    const when = () => v.page.locator(".poster .when").innerText();
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

test(
  "India's recent series are one line each, opening to their results",
  { skip },
  async () => {
    const v = await open("#india");
    const first = v.page.locator("#results ~ .list details.sr").first();
    assert.equal(await first.evaluate((d) => d.open), false);
    assert.match(await first.locator(".stand").innerText(), /\d–\d|NR/);
    await first.locator("summary").click();
    assert.equal(await first.evaluate((d) => d.open), true);
    assert.ok(await first.locator(".rc").first().isVisible());
    assert.ok(await first.locator(".mr").first().isVisible());
    await v.close();
  },
);

test(
  "results links land on India's results, not the top of the tab",
  { skip },
  async () => {
    const v = await open(`#m/${next}/live`);
    await v.page.getByRole("link", { name: "India's latest results" }).click();
    await v.page.waitForFunction(
      () => document.activeElement?.id === "results",
    );
    assert.equal(await v.page.evaluate(() => location.hash), "#india/results");
    // Just under the top bar.
    const [top, bar] = await v.page.evaluate(() => [
      document.getElementById("results").getBoundingClientRect().top,
      document.getElementById("top").getBoundingClientRect().bottom,
    ]);
    assert.ok(top >= bar && top < bar + 100, `results heading at ${top}px`);
    // Back returns to the match the link was followed from.
    await v.page.goBack();
    await v.page.waitForFunction(
      (id) => location.hash === `#m/${id}/live`,
      next,
    );
    await v.close();
    // Opened directly, the address scrolls there too.
    const w = await open("#india/results");
    await w.page.waitForFunction(
      () => document.activeElement?.id === "results",
    );
    await w.close();
  },
);

test(
  "reopened without a connection, Crease shows its last scores and says it's offline",
  { skip },
  async () => {
    const v = await open("#now", { serviceWorkers: "allow" });
    // The worker takes over the page, then a reload goes through it and is kept.
    await v.page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller)
        await new Promise((ok) =>
          navigator.serviceWorker.addEventListener("controllerchange", ok),
        );
    });
    await v.page.reload();
    await v.page.locator(".poster").waitFor();
    await v.page.context().setOffline(true);
    await v.page.reload();
    await v.page.locator(".poster").waitFor();
    assert.match(await v.page.locator("#freshText").innerText(), /^Offline/);
    await v.page.context().setOffline(false);
    await v.close();
  },
);

test(
  "the top bar says how fresh the data is, and tapping it refreshes",
  { skip },
  async () => {
    const fresh = (v) => v.page.locator("#freshText").innerText();
    const done_ = await open(`#m/${done}/live`);
    assert.equal(await fresh(done_), "Finished");
    await done_.close();
    const next_ = await open(`#m/${next}/info`);
    assert.equal(await fresh(next_), "Not started");
    await next_.close();
    const v = await open("#now");
    assert.match(await fresh(v), /^Updated (just now|\d+s ago|\d+ min ago)$/);
    // A failed refresh turns it red and keeps the data's age.
    await v.page.route("**/api/matches", (r) => r.abort());
    await v.page.locator("#fresh").click();
    await v.page.locator(".fresh.bad").waitFor();
    assert.match(await fresh(v), /min old|s old/);
    assert.match(
      await v.page.locator("#fresh").getAttribute("aria-label"),
      /^Refresh failed · .* old\. Refresh now$/,
    );
    await v.close();
  },
);
