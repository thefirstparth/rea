// Crease in a real browser, offline (test/ui-harness.mjs), on harder data and other
// dates than the recording's: the worst live match to lay out, the IPL tab between
// seasons and mid-season, a followed team, and the World Cup tab around its event.
//
// Run: node --test "experiments/cricket-live/test/*.test.mjs"

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as cb } from "../lib/cricbuzz.mjs";
import {
  audit,
  live,
  open,
  rec,
  setApi,
  skip,
  start,
  stop,
} from "./ui-harness.mjs";

before(start);
after(stop);

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
  // Followed, so it is live on the Now and India tabs: the tab bar's Live stickers show.
  row.tags = ["india"];
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
    setApi(worstCase());
    try {
      const problems = [];
      const views = ["light", "dark"].flatMap((theme) =>
        [
          [320, 640],
          [412, 915],
          [1280, 800],
        ].flatMap(([width, height]) =>
          [`#m/${live}/live`, "#all", "#now"].map((r) => ({
            r,
            width,
            height,
            theme,
          })),
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
      assert.deepEqual(
        await v.page
          .locator("#tabs .lv")
          .evaluateAll((els) => els.map((e) => e.closest("a").dataset.tab)),
        ["now", "india"],
      );
      // Flash notes and the review notes are folded into their deliveries.
      assert.doesNotMatch(text, /THATS OUT!!/);
      await v.close();
    } finally {
      setApi();
    }
  },
);

// India A plays at the same time as the senior team, and started first: it never leads.
test(
  "India means the senior team; India A is listed below it, never ahead",
  { skip },
  async () => {
    const hard = structuredClone(rec.api);
    const list = hard["/api/matches"].body.matches;
    const senior = list.find((x) => String(x.id) === live);
    senior.tags = ["india"];
    list.push({
      ...structuredClone(senior),
      id: 999001,
      series: "India A tour of New Zealand, 2026",
      seriesId: 999,
      t1: { ...senior.t1, id: 9001, name: "India A", short: "INDA" },
      t2: { ...senior.t2, id: 9002, name: "New Zealand A", short: "NZA" },
      tags: [],
      indiaOther: true,
      start: senior.start - 3 * 3600e3,
    });
    setApi(hard);
    try {
      const v = await open("#now");
      const now = await v.page.locator("#view").innerText();
      assert.doesNotMatch(now, /India A|New Zealand A/);
      await v.page.evaluate(() => (location.hash = "#india"));
      const head = v.page.locator("h2", {
        hasText: "India A and other India sides",
      });
      await head.waitFor();
      // The section comes after everything else on the tab.
      assert.equal(
        await head.evaluate(
          (h) => [...document.querySelectorAll("#view h2")].at(-1) === h,
        ),
        true,
      );
      assert.match(
        await v.page.locator('[data-k="oil"]').innerText(),
        /India A/,
      );
      assert.doesNotMatch(
        await v.page.locator(".hero").first().innerText(),
        /India A/,
      );
      await v.page.evaluate(() => (location.hash = "#all"));
      await v.page.locator("h2", { hasText: "India A tour" }).waitFor();
      assert.deepEqual(v.errors, []);
      await v.close();
    } finally {
      setApi();
    }
  },
);

test(
  "a series with a match on marks the live one, not the next",
  { skip },
  async () => {
    const hard = structuredClone(rec.api);
    const list = hard["/api/matches"].body.matches;
    const on = list.find((x) => String(x.id) === live);
    on.tags = ["india"];
    on.t2 = { ...on.t2, id: 2, name: "India", short: "IND" };
    // Two fixtures still to come in the same series.
    for (const [n, days] of [
      ["3rd", 3],
      ["4th", 6],
    ])
      list.push({
        ...structuredClone(on),
        id: 999100 + days,
        desc: `${n} Test`,
        phase: "upcoming",
        state: "Preview",
        status: "",
        start: on.start + days * 864e5,
      });
    setApi(hard);
    try {
      const v = await open("#now");
      const chips = v.page.locator(".series-now .rc");
      await chips.first().waitFor();
      assert.equal(await v.page.locator(".series-now .rc.live").count(), 1);
      assert.equal(await v.page.locator(".series-now .rc.next").count(), 0);
      // Each chip's text sits in its middle, whichever font size it uses.
      const offCentre = await chips.evaluateAll((list) =>
        list
          .map((c) => {
            const box = c.getBoundingClientRect();
            const text = c.querySelector("b").getBoundingClientRect();
            const off = text.top + text.height / 2 - (box.top + box.height / 2);
            return [c.textContent, Math.round(off * 10) / 10];
          })
          .filter(([, off]) => Math.abs(off) > 1),
      );
      assert.deepEqual(offCentre, []);
      assert.deepEqual(await audit(v.page), []);
      await v.close();
    } finally {
      setApi();
    }
  },
);

test(
  "between seasons the IPL tab shows last season, and a tapped team is followed",
  { skip },
  async () => {
    const v = await open("#ipl");
    await v.page.locator(".card.champ").waitFor();
    assert.match(
      await v.page.locator(".card.champ").innerText(),
      /Champions \d{4}/,
    );
    const rows = v.page.locator(".tbl.pts tbody tr");
    assert.equal(await rows.count(), 10);
    assert.equal(await v.page.locator(".tbl.pts tr.cut").count(), 1);
    // Follow the table's leader by its star; the choice is stored and shows on Now.
    const stored = () =>
      v.page.evaluate(() => localStorage.getItem("crease-team"));
    const top = rows.first().locator("button.star-btn");
    const name = (await top.getAttribute("aria-label")).match(/\((.+)\)$/)[1];
    await top.click();
    assert.equal(await top.getAttribute("aria-pressed"), "true");
    assert.match(await stored(), new RegExp(name));
    // A tap on another team's name changes nothing; its star switches, with an Undo.
    await rows.nth(1).locator(".who").click();
    assert.match(await stored(), new RegExp(name));
    await rows.nth(1).locator("button.star-btn").click();
    assert.doesNotMatch(await stored(), new RegExp(name));
    await v.page.locator("#toast").getByText("instead of").waitFor();
    await v.page.locator("#toast button", { hasText: "Undo" }).click();
    assert.match(await stored(), new RegExp(name));
    await v.page.evaluate(() => (location.hash = "#now"));
    await v.page.locator('[data-k="fh"]').waitFor();
    assert.match(await v.page.locator("#view").innerText(), new RegExp(name));
    // Settings lists the team, selected; "No team" stops following it.
    await v.page.locator("#settingsBtn").click();
    const sel = v.page.locator("#teamSelect");
    assert.equal(await sel.evaluate((s) => s.selectedOptions[0].text), name);
    await sel.selectOption("");
    assert.equal(
      await v.page.evaluate(() => localStorage.getItem("crease-team")),
      null,
    );
    await v.close();
  },
);

test(
  "the World Cup tab follows its setting: around the event, always, or off",
  { skip },
  async () => {
    const ev = rec.api["/api/tournament"].body.event;
    const wcTab = (v) => v.page.locator('#tabs a[data-tab="wc"]');
    // Automatic, far ahead: hidden. Always: shown. Off: hidden.
    const v = await open("#now");
    await v.page.waitForFunction(() =>
      document.querySelector("#tabs[data-ready]"),
    );
    assert.equal(await wcTab(v).isVisible(), false);
    await v.page.locator("#settingsBtn").click();
    await v.page.locator('input[name=wc][value="on"]').check();
    await wcTab(v).waitFor();
    assert.equal(
      await v.page
        .locator("#tabs")
        .evaluate((t) => t.style.getPropertyValue("--n")),
      "5",
    );
    await v.page.locator('input[name=wc][value="off"]').check();
    await wcTab(v).waitFor({ state: "hidden" });
    await v.close();
    // Automatic, a week before the first match: shown, with the countdown on its page.
    const w = await open("#wc", { at: ev.start - 7 * 864e5 });
    await wcTab(w).waitFor();
    assert.match(await w.page.locator("#view").innerText(), /7 days\s*to go/i);
    assert.ok(await w.page.locator(".tbl.pts").count());
    await w.close();
  },
);

// Mid-season, from the recorded 2026 season: its second half turned back into fixtures
// to come, and the clock set to the first of them.
function midSeason() {
  const hard = structuredClone(rec.api);
  const fixtures = cb
    .seriesFixtures(
      readFileSync(
        new URL("./fixtures/cb-ipl-series.flight.txt", import.meta.url),
        "utf8",
      ),
      9241,
    )
    .sort((a, b) => a.start - b.start);
  const half = Math.floor(fixtures.length / 2);
  for (const m of fixtures.slice(half))
    Object.assign(m, {
      phase: "upcoming",
      state: "Preview",
      status: "",
      s1: [],
      s2: [],
    });
  const sched = hard["/api/schedule"].body;
  sched.ipl = {
    id: 9241,
    name: "Indian Premier League 2026",
    start: fixtures[0].start,
    end: fixtures.at(-1).start,
    fixtures,
  };
  return { hard, at: fixtures[half].start - 6 * 3600000 };
}

test(
  "mid-season the IPL tab shows the next match, the table, fixtures and results",
  { skip },
  async () => {
    const { hard, at } = midSeason();
    setApi(hard);
    try {
      const problems = [];
      for (const theme of ["light", "dark"])
        for (const [width, height] of [
          [320, 640],
          [1280, 800],
        ]) {
          const v = await open("#ipl", { width, height, theme, at });
          for (const f of await audit(v.page))
            problems.push(
              `${width} ${theme}: ${f.kind} ${f.a}${f.b ? ` ⟂ ${f.b}` : ""} ${f.detail ?? ""}`,
            );
          await v.close();
        }
      assert.deepEqual(problems, []);
      const v = await open("#ipl", { at });
      const text = await v.page.locator("#view").innerText();
      // The next match leads, straight under the heading.
      assert.equal(await v.page.locator(".ph + .hero.next").count(), 1);
      for (const part of [/Points table/i, /Fixtures/i, /Results/i])
        assert.match(text, part);
      assert.doesNotMatch(text, /Last season/i);
      await v.close();
    } finally {
      setApi();
    }
  },
);
