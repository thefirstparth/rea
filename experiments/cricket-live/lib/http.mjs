// Upstream fetching and caching shared by the Cricbuzz and Cricinfo adapters.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

export class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const cache = new Map();
const CACHE_MAX = 400;

// One in-flight load per key; on failure keep serving the last good value briefly.
// Resolves to { value, at }: `at` is when the value was fetched upstream, which is
// what "Updated …" must mean, however long the answer then sat in a cache.
export function cachedAt(key, ttlMs, load) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.exp > now) return hit.pending ?? Promise.resolve(hit.good);
  const pending = load().then(
    (value) => {
      const good = { value, at: Date.now() };
      cache.set(key, { exp: good.at + ttlMs, good });
      return good;
    },
    (err) => {
      if (hit?.good) {
        cache.set(key, { exp: Date.now() + 5000, good: hit.good });
        return hit.good;
      }
      cache.delete(key);
      throw err;
    },
  );
  cache.delete(key); // re-insert so Map order tracks recency
  cache.set(key, { exp: now + ttlMs, pending, good: hit?.good });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return pending;
}

export const cached = async (key, ttlMs, load) =>
  (await cachedAt(key, ttlMs, load)).value;

// `source` names the upstream in error messages shown to the user.
export async function get(url, accept, source) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept,
        "accept-language": "en-IN,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
  } catch (err) {
    throw new UpstreamError(`${source} unreachable (${err.name})`);
  }
  if (res.status === 404)
    throw new UpstreamError(`Not found on ${source}`, 404);
  if (!res.ok) throw new UpstreamError(`${source} returned ${res.status}`);
  return res;
}

export async function getJson(url, source) {
  const res = await get(url, "application/json", source);
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError(`${source} sent malformed JSON`);
  }
}
