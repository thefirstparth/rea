// Vercel function for every /api/* request (vercel.json rewrites them here).
// The rewrite passes the original path as ?route=; other query parameters are kept.

import { handleApi } from "../lib/api.mjs";

export default function handler(req, res) {
  const url = new URL(req.url ?? "/", "http://local");
  const route = url.searchParams.get("route");
  url.searchParams.delete("route");
  const pathname = route === null ? url.pathname : `/api/${route}`;
  return handleApi(res, pathname, url.searchParams);
}
