// Local zero-dependency server: the static PWA from ./public plus the JSON API in
// lib/api.mjs. On Vercel the same API runs as api/index.mjs.
// Run with `node server.mjs` (Node 20+). PORT defaults to 5173.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi } from "./lib/api.mjs";

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

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
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
  if (url.pathname.startsWith("/api/"))
    return handleApi(res, url.pathname, url.searchParams);
  await serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Crease is live at http://${HOST}:${PORT}`);
});
