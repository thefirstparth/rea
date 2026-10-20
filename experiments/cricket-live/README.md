# Crease: live cricket for India and the IPL

A small live-score web app inspired by Cricbuzz and ESPNcricinfo, styled after the
House of 1400 Sport app. It shows live scores, ball-by-ball commentary, full
scorecards, squads and match info for India sides and the IPL. An **All live**
tab lists every other match in progress.

```sh
cd experiments/cricket-live
node server.mjs            # http://127.0.0.1:5173
PORT=8080 HOST=0.0.0.0 node server.mjs
```

Requires Node 20 or later. There are no dependencies and no build step. Behind an
HTTPS proxy, run it with `NODE_USE_ENV_PROXY=1` (Node 22.21 or later) so the
server's `fetch` respects `HTTPS_PROXY`.

## How it works

```
browser (public/)  ──►  server.mjs /api/*  ──►  lib/cricbuzz.mjs  ──►  www.cricbuzz.com
 vanilla JS PWA          static + JSON          fetch, cache, normalise
```

The browser can't call Cricbuzz directly because of CORS, so `server.mjs` serves
the PWA and a small JSON API. `lib/cricbuzz.mjs` is the only module that knows
Cricbuzz's formats. It normalises everything into one compact shape.

| App route                                  | Cricbuzz source                                                        | Cache     |
| ------------------------------------------ | ---------------------------------------------------------------------- | --------- |
| `GET /api/matches`                         | live, recent and upcoming list pages (RSC payload) and `/api/home`     | 15s to 5m |
| `GET /api/match/:id`                       | `/api/mcenter/comm/:id` (header, miniscore, latest commentary)         | 10s       |
| `GET /api/match/:id/commentary?inn&before` | `/api/mcenter/commentary-pagination/:id/:inn/:beforeTimestamp`         | 60s       |
| `GET /api/match/:id/scorecard`             | `/live-cricket-scorecard/:id/x` page, `scoreCard` in the RSC payload   | 15s       |
| `GET /api/match/:id/squads`                | `/cricket-match-squads/:id/x` page, `team1`/`team2` in the RSC payload | 60s       |

### How the endpoints were found

Cricbuzz is a Next.js App Router site. Its route chunks
(`/_next/static/chunks/app/cricbuzz/(mCenter)/…`) contain a table of the
site's internal `/api/mcenter/*` routes, which return JSON. Scorecards and
squads have no public JSON route, because the server fetches them from a
private backend (`/m/mcenter/v1/{id}/scard`, `/teams`). The rendered page
still embeds the full objects in its `self.__next_f.push(...)` flight chunks.
The adapter joins those chunks and pulls out the balanced JSON value after a
known key. It also converts React's `"$undefined"` sentinel to a real absent
value.

Classification:

- **India**: either team's name starts with `India` (India, India Women, India A, India U19).
- **IPL**: the series name matches `Indian Premier League` or `IPL`.
- **Phase**: `Preview` and `Upcoming` are upcoming. `Complete`, `Abandon` and
  `No result` are done. Everything else is live. Stumps, lunch, tea, rain and
  other breaks show as paused rather than as a pulsing LIVE badge.

## Front end

- Hash routes: `#now`, `#india`, `#ipl`, `#all`, and `#m/{id}/{live|scorecard|squads|info}`.
- One poll loop runs every 15s and pauses while the tab is hidden. It refreshes
  only what the current view shows. Finished matches are not re-polled.
- Renders go through a small keyed DOM morph (`data-k`). Live updates keep the
  scroll position, open scorecard innings and loaded images.
- Commentary HTML is sanitised on the server. Only `b`, `i` and `br` are kept,
  and every other character is escaped.
- Light and dark themes follow the system setting, and the moon/sun button
  overrides it.

## Limits

- The app uses Cricbuzz's unofficial, undocumented endpoints. They can change
  without notice, so it suits personal or local use. The server caches every
  upstream call and makes at most a few requests per 15s per open match.
- The IPL tab is empty out of season. It reports that no IPL fixtures appear in
  the live, upcoming or recent feeds.
- There are no push notifications or service worker yet. The web manifest only
  makes the app installable.
