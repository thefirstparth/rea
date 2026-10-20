// Zero-dependency server: static PWA from ./public plus a small JSON API that
// composes the Cricbuzz adapter (live spine) with the Cricinfo adapter (enrichment). Run with `node server.mjs` (Node 20+). PORT defaults to 5173.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  match,
  matches,
  olderCommentary,
  scorecard,
  squads,
} from "./lib/cricbuzz.mjs";
import * as cricinfo from "./lib/cricinfo.mjs";
import { UpstreamError } from "./lib/http.mjs";

const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

const ID = /^\d{1,9}$/;

// Cricbuzz ids drive the app; the Cricinfo event is found from the same fixture.
async function cricinfoEvent(id) {
  const { header } = await match(id);
  return cricinfo.findEvent({
    t1: header.t1.name,
    t2: header.t2.name,
    start: header.start,
  });
}

async function cricinfoRoute(id, rest, query) {
  const ev = await cricinfoEvent(id);
  if (!ev) return { available: false };
  if (!rest) return { available: true, ...(await cricinfo.info(ev)) };
  if (rest === "commentary") {
    const page = query.get("page");
    if (page !== null && !/^\d{1,4}$/.test(page))
      throw new UpstreamError("page must be a number", 400);
    return {
      available: true,
      ...(await cricinfo.commentary(ev, page ? Number(page) : undefined)),
    };
  }
  throw new UpstreamError("Unknown route", 404);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res, status, data, maxAge = 0) {
  send(res, status, JSON.stringify(data), {
    "content-type": "application/json; charset=utf-8",
    "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
  });
}

async function api(path, query) {
  const parts = path.split("/").filter(Boolean); // ["api", ...]
  if (parts[1] === "matches" && parts.length === 2) return matches();
  if (parts[1] === "ipl" && parts.length === 2) return cricinfo.iplSeason();
  if (parts[1] === "match" && ID.test(parts[2] ?? "")) {
    const id = parts[2];
    if (parts.length === 3) return match(id);
    if (parts[3] === "scorecard") return scorecard(id);
    if (parts[3] === "squads") return squads(id);
    if (parts[3] === "cricinfo") return cricinfoRoute(id, parts[4], query);
    if (parts[3] === "commentary") {
      const inn = query.get("inn");
      const before = query.get("before");
      if (!/^\d{1,2}$/.test(inn ?? "") || !/^\d{10,14}$/.test(before ?? ""))
        throw new UpstreamError("inn and before are required", 400);
      return olderCommentary(id, inn, before);
    }
  }
  throw new UpstreamError("Unknown route", 404);
}

async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden");
  try {
    const body = await readFile(file);
    send(res, 200, body, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
  } catch {
    send(res, 404, "Not found", { "content-type": "text/plain" });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  if (req.method !== "GET" && req.method !== "HEAD")
    return send(res, 405, "Method not allowed");
  if (url.pathname.startsWith("/api/")) {
    try {
      json(res, 200, await api(url.pathname, url.searchParams));
    } catch (err) {
      const status = err instanceof UpstreamError ? err.status : 500;
      if (status >= 500) console.error(`[api] ${url.pathname}:`, err.message);
      json(res, status, { error: err.message || "Something went wrong" });
    }
    return;
  }
  await serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Crease is live at http://${HOST}:${PORT}`);
});
