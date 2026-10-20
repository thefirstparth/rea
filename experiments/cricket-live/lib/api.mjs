// The JSON API, shared by the local server (server.mjs) and the Vercel function
// (api/index.mjs). Cricbuzz ids drive every route; the Cricinfo event is found
// from the same fixture.

import {
  match,
  matches,
  olderCommentary,
  schedule,
  scorecard,
  squads,
} from "./cricbuzz.mjs";
import * as cricinfo from "./cricinfo.mjs";
import { UpstreamError } from "./http.mjs";

const ID = /^\d{1,9}$/;

async function cricinfoEvent(id) {
  const { header } = await match(id);
  return cricinfo.findEvent({
    t1: header.t1.name,
    t2: header.t2.name,
    start: header.start,
  });
}

async function cricinfoInfo(id) {
  const ev = await cricinfoEvent(id);
  return ev
    ? { available: true, ...(await cricinfo.info(ev)) }
    : { available: false };
}

async function cricinfoCommentary(id, page) {
  const ev = await cricinfoEvent(id);
  if (!ev) return { available: false };
  return { available: true, ...(await cricinfo.commentary(ev, page)) };
}

function olderCricbuzz(id, query) {
  const inn = query.get("inn");
  const before = query.get("before");
  if (!/^\d{1,2}$/.test(inn ?? "") || !/^\d{10,14}$/.test(before ?? ""))
    throw new UpstreamError("inn and before are required", 400);
  return { ttl: 60, load: () => olderCommentary(id, inn, before) };
}

function cricinfoPage(id, query) {
  const page = query.get("page");
  if (page === null) return { ttl: 15, load: () => cricinfoCommentary(id) };
  if (!/^\d{1,4}$/.test(page))
    throw new UpstreamError("page must be a number", 400);
  return { ttl: 60, load: () => cricinfoCommentary(id, Number(page)) };
}

// Each route names its loader and how long a shared cache may keep the answer.
function resolve(pathname, query) {
  const [root, kind, id, sub, rest, ...extra] = pathname
    .split("/")
    .filter(Boolean);
  if (root !== "api" || extra.length) return null;
  if (kind === "matches" && !id) return { ttl: 10, load: matches };
  if (kind === "ipl" && !id) return { ttl: 3600, load: cricinfo.iplSeason };
  if (kind === "schedule" && !id) return { ttl: 600, load: schedule };
  if (kind !== "match" || !ID.test(id ?? "")) return null;
  if (!sub) return { ttl: 10, load: () => match(id) };
  if (rest && sub !== "cricinfo") return null;
  // Same lifetime as the match payload, so the hero and scorecard agree.
  if (sub === "scorecard") return { ttl: 10, load: () => scorecard(id) };
  if (sub === "squads") return { ttl: 60, load: () => squads(id) };
  if (sub === "commentary") return olderCricbuzz(id, query);
  if (sub === "cricinfo" && !rest)
    return { ttl: 60, load: () => cricinfoInfo(id) };
  if (sub === "cricinfo" && rest === "commentary")
    return cricinfoPage(id, query);
  return null;
}

function send(res, status, data, headers) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(data));
}

// Browsers must not keep answers: stale-while-revalidate in Cache-Control applies to
// their own cache too, which served every poll the previous answer. Only the CDN in
// front (Vercel's, via CDN-Cache-Control) shares answers for `ttl` seconds, and each
// answer's asOf says when it was fetched upstream.
export async function handleApi(res, pathname, query) {
  try {
    const route = resolve(pathname, query);
    if (!route) throw new UpstreamError("Unknown route", 404);
    const data = await route.load();
    send(res, 200, data, {
      "cache-control": "no-store",
      "cdn-cache-control": `public, max-age=${route.ttl}, stale-while-revalidate=${route.ttl}`,
    });
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 500;
    if (status >= 500) console.error(`[api] ${pathname}:`, err.message);
    send(
      res,
      status,
      { error: err.message || "Something went wrong" },
      { "cache-control": "no-store" },
    );
  }
}
