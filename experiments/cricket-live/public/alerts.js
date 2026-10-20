// Crease alerts: compare what we knew about a followed match with its latest data and
// describe what happened (match started, wickets, DRS reviews, fifties and hundreds,
// five-fors).
// No DOM here, so the tests run it in Node; app.js fetches the data and shows the alerts.

const BAT_MILESTONES = [50, 100];
const FIVE_FOR = 5;

// Every innings so far: the live miniscore's when loaded, else the match list's.
function inningsOf(m, mini) {
  if (mini?.innings?.length) return mini.innings;
  return [...(m.s1 ?? []), ...(m.s2 ?? [])];
}

function scoreOf(mini) {
  const last = mini?.innings?.at(-1);
  return last ? `${last.r}/${last.w} (${last.o} ov)` : "";
}

// A review's outcome in words. The verdict is the adapter's (lib/cricbuzz.mjs); with
// none, only the decision after the review is known: out when the ball is a wicket.
export function reviewLabel(review, wicket) {
  const decision = wicket ? "out" : "not out";
  if (review.verdict === "stands")
    return `${wicket ? "Out" : "Not out"} stands · review lost`;
  if (review.verdict === "overturned") return `Overturned · ${decision}`;
  if (review.verdict === "umpires-call")
    return `Umpire's call · ${decision}, review kept`;
  return `${wicket ? "Out" : "Not out"} after review`;
}

const text = (html) =>
  String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
const clip = (s, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The newest review in the latest commentary: one being decided, or one decided.
function latestReview(d) {
  const c = (d?.commentary ?? []).find((x) => x.review);
  if (!c) return null;
  if (c.review.pending)
    return { key: `p${c.ts}`, pending: true, body: clip(text(c.html)) };
  return {
    key: `b${c.ts}`,
    label: reviewLabel(c.review, c.event === "wicket"),
    body: clip(text(c.html)),
  };
}

// The facts an alert needs, from a list entry and (when loaded) its /api/match payload.
export function snapshot(m, d) {
  const mini = d?.mini;
  return {
    id: String(m.id),
    phase: d?.header?.phase ?? m.phase,
    name: `${m.t1.short} v ${m.t2.short}`,
    desc: m.desc ?? "",
    status: d?.header?.status || m.status || "",
    wkts: inningsOf(m, mini).reduce((n, i) => n + (i.w ?? 0), 0),
    score: scoreOf(mini),
    lastWicket: (mini?.lastWicket ?? "").replace(/\s+/g, " ").trim(),
    bat: [mini?.striker, mini?.nonStriker].filter(Boolean),
    bowl: [mini?.bowler, mini?.otherBowler].filter(Boolean),
    review: latestReview(d),
  };
}

// Milestones and reviews the snapshot already shows, as stable keys.
function reached(s) {
  const keys = s.review ? [`review:${s.review.key}`] : [];
  for (const p of s.bat)
    for (const n of BAT_MILESTONES) if (p.r >= n) keys.push(`bat:${p.id}:${n}`);
  for (const p of s.bowl) if (p.w >= FIVE_FOR) keys.push(`bowl:${p.id}`);
  return keys;
}

// Advance one match's alert state. The first sighting only records what is already true,
// so opening the app never replays old events. Wickets count up from the highest total
// seen, so a briefly stale source cannot announce the same wicket twice.
export function step(state, s) {
  if (!state)
    return {
      state: { phase: s.phase, wkts: s.wkts, seen: reached(s) },
      events: [],
    };
  const events = [];
  const tag = (kind) => `${s.id}:${kind}`;
  if (state.phase === "upcoming" && s.phase === "live")
    events.push({
      id: s.id,
      tag: tag("start"),
      title: `${s.name} has started`,
      body: [s.desc, s.status].filter(Boolean).join(" · "),
    });
  if (s.wkts > state.wkts) {
    const n = s.wkts - state.wkts;
    events.push({
      id: s.id,
      tag: tag(`w${s.wkts}`),
      title: `${n > 1 ? `${n} wickets` : "Wicket"}! ${s.name}${s.score ? ` ${s.score}` : ""}`,
      body: s.lastWicket || s.desc,
    });
  }
  const seen = new Set(state.seen);
  // A review alerts when it is asked for and again with its outcome; both share a tag,
  // so the outcome replaces the "review" notification instead of stacking under it.
  if (s.review && !seen.has(`review:${s.review.key}`)) {
    seen.add(`review:${s.review.key}`);
    events.push({
      id: s.id,
      tag: tag("review"),
      title: s.review.pending
        ? `Review! ${s.name}`
        : `Review: ${s.review.label} · ${s.name}`,
      body: s.review.body,
    });
  }
  for (const p of s.bat)
    for (const n of BAT_MILESTONES) {
      const key = `bat:${p.id}:${n}`;
      if (p.r < n || seen.has(key)) continue;
      seen.add(key);
      events.push({
        id: s.id,
        tag: tag(key),
        title: `${n === 100 ? "Hundred" : "Fifty"} for ${p.name}`,
        body: `${p.name} ${p.r}* (${p.b}) · ${s.name}`,
      });
    }
  for (const p of s.bowl) {
    const key = `bowl:${p.id}`;
    if (p.w < FIVE_FOR || seen.has(key)) continue;
    seen.add(key);
    events.push({
      id: s.id,
      tag: tag(key),
      title: `Five-for for ${p.name}`,
      body: `${p.name} ${p.w}/${p.r} in ${p.o} ov · ${s.name}`,
    });
  }
  return {
    state: {
      phase: s.phase,
      wkts: Math.max(state.wkts, s.wkts),
      seen: [...seen],
    },
    events,
  };
}
