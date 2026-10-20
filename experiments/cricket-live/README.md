# Crease: live cricket for India and the IPL

A small live-score web app built from Cricbuzz and Cricinfo data, styled after the
House of 1400 Sport app. It shows live scores, ball-by-ball commentary, full
scorecards, squads and match info for India sides and the IPL. An **All live**
tab lists every other match in progress.

Cricbuzz is the live spine: match lists, scores, current batters and bowlers,
scorecards and squads. Cricinfo adds its live blog as a second commentary
source, plus umpires, referee, hours of play, close-of-play summaries, debuts,
session notes and the IPL season summary.

```sh
cd experiments/cricket-live
node server.mjs            # http://127.0.0.1:5173
PORT=8080 HOST=0.0.0.0 node server.mjs
```

Requires Node 20 or later. There are no dependencies and no build step. Behind an
HTTPS proxy, run it with `NODE_USE_ENV_PROXY=1` (Node 22.21 or later) so the
server's `fetch` respects `HTTPS_PROXY`.

## Deploy to Vercel

The folder is a self-contained Vercel project: `public/` is served as static
files, and `api/index.mjs` runs the same JSON API as a function. `vercel.json`
rewrites `/api/*` to that function and pins it to Mumbai (`bom1`), close to the
Indian users and to the sources' Indian edge. API answers carry
`s-maxage`, so Vercel's CDN shares each one for 10s to 1h depending on the route,
and concurrent viewers don't multiply upstream requests.

```sh
cd experiments/cricket-live
npx vercel@latest deploy --prod      # first run links or creates the project
```

In the Vercel dashboard, the equivalent is to import the repository and set
**Root Directory** to `experiments/cricket-live`, with no build command.

## How it works

```
browser (public/)  ──►  server.mjs /api/*  ──┬─►  lib/cricbuzz.mjs  ──►  www.cricbuzz.com
 vanilla JS PWA          static + JSON        └─►  lib/cricinfo.mjs  ──►  site.web.api.espn.com
                                                   lib/http.mjs (fetch + cache), lib/html.mjs (sanitiser)
```

The browser can't call either source directly because of CORS, so `server.mjs`
serves the PWA and a small JSON API. Each adapter is the only module that knows
its source's formats and normalises into the shapes the client reads. The
server composes them: Cricbuzz match ids drive every route, and the Cricinfo
event is found from the same fixture.

| App route                                  | Cricbuzz source                                                        | Cache     |
| ------------------------------------------ | ---------------------------------------------------------------------- | --------- |
| `GET /api/matches`                         | live, recent and upcoming list pages (RSC payload) and `/api/home`     | 15s to 5m |
| `GET /api/match/:id`                       | `/api/mcenter/comm/:id` (header, miniscore, latest commentary)         | 10s       |
| `GET /api/match/:id/commentary?inn&before` | `/api/mcenter/commentary-pagination/:id/:inn/:beforeTimestamp`         | 60s       |
| `GET /api/match/:id/scorecard`             | `/live-cricket-scorecard/:id/x` page, `scoreCard` in the RSC payload   | 15s       |
| `GET /api/match/:id/squads`                | `/cricket-match-squads/:id/x` page, `team1`/`team2` in the RSC payload | 60s       |

| App route                                       | Cricinfo source (ESPN API)                                      | Cache |
| ----------------------------------------------- | --------------------------------------------------------------- | ----- |
| `GET /api/match/:id/cricinfo`                   | `/{league}/summary?event=` (officials, notes, debuts, venue)    | 60s   |
| `GET /api/match/:id/cricinfo/commentary[?page]` | `/{league}/playbyplay?event=&page=` (balls plus live-blog text) | 15s   |
| `GET /api/ipl`                                  | `/8048/scoreboard` (season calendar, latest result)             | 1h    |

Event lookup uses `/scorepanel` (cached 30s). Cricinfo routes return
`{ "available": false }` when no Cricinfo event matches the fixture.

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

Cricinfo's own hosts (`www.cricinfo.com`, `www.espncricinfo.com` and
`hs-consumer-api.espncricinfo.com`) answered every request with an Akamai
"Access Denied" page from this development environment, so their page code
could not be inspected. Cricinfo is an ESPN property, and ESPN's public sports
API serves the same match data under Cricinfo's event ids. A fixture is matched
to its Cricinfo event when both team names agree, after dropping qualifiers
such as "(India)" and punctuation, and the start times are within 36 hours.
Commentary pages come oldest first with 25 balls each. The adapter reads the
page count from page 1, then serves the newest page (plus the one before it
when the newest is nearly empty). Each ball's `preText` and `postText` live-blog
entries are placed around it.

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
- Commentary HTML from both sources is sanitised on the server. Only `b`, `i`
  and `br` are kept, links are reduced to their text, and every other
  character is escaped.
- The commentary toggle defaults to the Cricinfo live blog when Cricinfo has the
  match, and remembers the choice in `localStorage`.
- Light and dark themes follow the system setting, and the moon/sun button
  overrides it.

## Limits

- Both sources are unofficial, undocumented endpoints. They can change without
  notice, so the app suits personal or local use. The server caches every
  upstream call and makes at most a few requests per 15s per open match.
- Cricinfo enrichment covers only events in its current score panel (live,
  today's and very recent matches). Older matches show Cricbuzz data alone.
- Out of season the IPL tab shows the last season's dates and its final result.
- Both sources may treat datacenter traffic differently from home connections.
  Cricinfo's own hosts already refuse it, which is why the ESPN API is used.
  If a deployment shows "Cricbuzz returned 403", the source is blocking
  Vercel's network, and the local server is the fallback.
- There are no push notifications or service worker yet. The web manifest only
  makes the app installable.
