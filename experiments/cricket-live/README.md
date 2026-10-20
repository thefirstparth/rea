# Crease: live cricket for India and the IPL

A small live-score web app built from Cricbuzz and Cricinfo data, styled after the
House of 1400 Sport app with a sticker layer: the score or next match is a
die-cut card with a tangerine state label (Live, Stumps, a countdown), and the
top of each page takes the colour of the team it follows. It shows live scores, ball-by-ball commentary, full
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

| App route                                  | Cricbuzz source                                                                                                                                                                                               | Cache                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `GET /api/matches`                         | live, recent and upcoming list pages (RSC payload) and `/api/home`                                                                                                                                            | 15s to 5m                             |
| `GET /api/match/:id`                       | `/api/mcenter/comm/:id` (header, miniscore, latest commentary)                                                                                                                                                | 10s                                   |
| `GET /api/match/:id/commentary?inn&before` | `/api/mcenter/commentary-pagination/:id/:inn/:beforeTimestamp`                                                                                                                                                | 60s                                   |
| `GET /api/match/:id/scorecard`             | `/live-cricket-scorecard/:id/x` page, `scoreCard` in the RSC payload                                                                                                                                          | 10s                                   |
| `GET /api/schedule`                        | India's team schedule and results pages (team 2), the league schedule page, the IPL series page, this and last year's series archive (`/cricket-scorecard-archives/:year`, for last IPL season and its final) | 30m (league schedule 6h, archive 24h) |
| `GET /api/series/:id/table`                | `/cricket-series/:id/x/points-table` page, `pointsTableData` for that series id                                                                                                                               | 5m                                    |
| `GET /api/team/:id`                        | `/cricket-team/x/:id/schedule` and `/results` pages, for any team (a country or an IPL side)                                                                                                                  | 30m                                   |
| `GET /api/match/:id/squads`                | `/cricket-match-squads/:id/x` page, `team1`/`team2` in the RSC payload                                                                                                                                        | 60s                                   |

| App route                                       | Cricinfo source (ESPN API)                                      | Cache |
| ----------------------------------------------- | --------------------------------------------------------------- | ----- |
| `GET /api/match/:id/cricinfo`                   | `/{league}/summary?event=` (officials, notes, debuts, venue)    | 60s   |
| `GET /api/match/:id/cricinfo/commentary[?page]` | `/{league}/playbyplay?event=&page=` (balls plus live-blog text) | 15s   |

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

Cricinfo's own data API (`hs-consumer-api.cricinfo.com`) answers only browsers
that have passed its bot check. Plain requests get Akamai "Access Denied". In a
real Chromium session the site loads, and REA's passive page inspection
(`rea inspect-web-page … --include-json-body-shapes`, with the API origin added
via `--allowed-origins`) recorded what the page calls:
`/v1/pages/match/commentary`, `/v1/pages/match/scorecard`, and
`/v1/global/fastscore/message/base` for live updates. Its commentary carries 48
fields per ball against ESPN's 25, including wagon wheel (`wagonX`, `wagonY`,
`wagonZone`), pitch map (`pitchLine`, `pitchLength`), `shotType`, `shotControl`
and per-ball win `predictions`. Using it from the server would mean getting
around that bot protection, so Crease doesn't. At stumps the page made no
requests in 25 seconds (no polling, no WebSocket).

Cricinfo is an ESPN property, and ESPN's public sports API serves the same
match data, minus that ball-tracking detail, under Cricinfo's event ids. A fixture is matched
to its Cricinfo event when both team names agree, after dropping qualifiers
such as "(India)" and punctuation, and the start times are within 36 hours.
Commentary pages come oldest first with 25 balls each. The adapter reads the
page count from page 1, then serves the newest page (plus the one before it
when the newest is nearly empty). Each ball's `preText` and `postText` live-blog
entries are placed around it.

The live-scores pages only look a few days ahead, so the schedule comes from
India's team schedule page (`/cricket-team/x/2/schedule`, about a year of
fixtures) and the next IPL season from Cricbuzz's league schedule page. That
page lists a season's window before fixtures exist (IPL 2027: 10 Mar – 15 May
2027). The app shows it as Cricbuzz's listing, not an official date. Once
fixtures are published, the series page (`/cricket-series/{id}/x/matches`)
lists them. Scheduled matches have no match centre until shortly before the
start, so their pages render from the fixture itself and fill in when Cricbuzz
opens it.

Classification:

- **Men's cricket only**: Cricbuzz has no gender field, so any match whose team
  or series name says "Women" (India Women, Women's Premier League) is dropped
  where matches are first parsed. Their match pages are refused as well.
- **India**: either team's name starts with `India` (India, India A, India U19).
- **IPL**: the series name matches `Indian Premier League` or `IPL`.
- **Phase**: `Preview` and `Upcoming` are upcoming. `Complete`, `Abandon` and
  `No result` are done. Everything else is live. Stumps, lunch, tea, rain and
  other breaks show as paused rather than as a pulsing LIVE badge.

## Tests

```sh
node --test "experiments/cricket-live/test/*.test.mjs"
NODE_USE_ENV_PROXY=1 node experiments/cricket-live/test/capture.mjs   # refresh fixtures
```

The tests run offline against real payloads in `test/fixtures/`, recorded by
`test/capture.mjs`, which also writes `manifest.json` with the matches it
followed. Each adapter exports its parsers as `parse`, separate from fetching,
so the same code is tested that serves the app. Page payloads keep only the
JSON values the adapter reads, in their original text and order. That includes
the site-wide ticker's `matchInfo` entries, which the scorecard must not mistake
for its own. Cricinfo payloads are cut down to the fields the adapter reads.

Most assertions are invariants that hold for any capture: valid men's matches,
no women's matches, overs never shown as `x.6`, commentary newest first and
sanitised, no `$undefined`. Re-capturing therefore refreshes the evidence
without rewriting tests. The scorecard venue regression fails when the old
first-`matchInfo` lookup is put back.

## Front end

- **Now** (home) is only what matters now: the live India or IPL match, else
  the soonest fixture of either, and that match's series (played so far, the
  latest result, the next three fixtures). Everything else lives in its tab.
- **India** has the live or next match, India's last ten results grouped by
  series (from the team's results page), and every series ahead, each
  expanding to its fixtures. **IPL** has the next IPL match, or out of season
  the next season's window and last season's final.
- Hash routes: `#now`, `#india`, `#ipl`, `#all`, and `#m/{id}/{live|scorecard|squads|info}`.
- One poll loop runs every 15s and pauses while the tab is hidden. It refreshes
  only what the current view shows. Finished matches are not re-polled.
- Renders go through a small keyed DOM morph (`data-k`). Live updates keep the
  scroll position, open scorecard innings and loaded images.
- Commentary HTML from both sources is sanitised on the server. Only `b`, `i`
  and `br` are kept, links are reduced to their text, and every other
  character is escaped.
- Commentary defaults to Cricbuzz's ball-by-ball. The Cricinfo live blog is the
  other choice (it can run overs behind, and says so when it does), and the
  choice is remembered in `localStorage`.
- **Settings** (the gear): 12- or 24-hour time (default: the locale's), and
  light, dark or the device's theme. **About & privacy** (`/about.html`) says
  where the data comes from, what is stored (five `localStorage` keys, no
  cookies, no analytics) and which other sites the browser contacts.
- Every time on screen names its zone ("12:30 pm IST"); the match Info tab adds
  India's time only for readers elsewhere. Dates are in English, like the rest
  of the UI.
- Page tints come from a small table of team colours keyed by Cricbuzz short
  name (`TEAM_COLOR` in `public/app.js`). A match page uses India's colour when
  India play, otherwise the home side's; teams not in the table leave the page
  plain.
- The live tab also loads the scorecard so it can show the batting side's fall
  of wickets.
- **Caching**: browsers never keep API answers (`cache-control: no-store`); only
  the CDN shares them, for the times above (`CDN-Cache-Control`). Each answer's
  `asOf` is when Crease fetched it from the source, so "Updated …" is honest. A
  live score never steps back a ball on a lagging answer, the scorecard says when
  it trails the live score, and the commentary says when Cricbuzz has posted no
  ball for 8 minutes of play.
- **DRS reviews**: Cricbuzz marks a reviewed delivery with the `udrs` event. The
  adapter reads the verdict from its text only when it is stated plainly
  ("overturned", "wastes a review", "umpire's call … retained"); otherwise the
  review shows without one. Cricbuzz's "THATS OUT!!" flash and its "X reviews"
  note are folded into the delivery once it is posted; until then the note shows
  as a review in progress. The live tab shows reviews left when the match uses
  DRS. Cricinfo's blog marks no reviews, so its commentary shows none.
- **Venue time**: next-match cards and Info show the start on the ground's own
  clock (from Cricbuzz's venue UTC offset), with a day, day-night or night glyph,
  whenever the ground isn't on India's time.
- **Series results**: India's games as chips, a row per format: match number and
  the winner's short name, NR or Draw, the date of one to come; the standing per
  format ("ODIs: IND won 2–1") replaces a single mixed tally. On the India tab
  each recent series is one closed line ("ODIs IND 2–1 · T20Is 2–2 · 1 NR") that
  opens to its chips and matches; each series ahead leads with a calendar tile.
- **IPL**: while a season runs (first match to three days after the last), the
  next match, the points table, fixtures and results. Between seasons, the next
  season's dates as Cricbuzz lists them, and the last finished season (found by
  name in Cricbuzz's yearly archive) with its champion and final table. Nothing
  names a year: each season is found from the data.
- **Following a team**: tap a team in a points table, or pick one in Settings
  (IPL sides from the tables, countries from the known fixtures). Its live match
  joins Now, its next fixture shows as "Your team" (from its Cricbuzz team page),
  and alerts include its matches. Between IPL seasons an IPL side shows its last
  finish and the next season's start. The choice is stored in `crease-team`.
- **Alerts** (the bell): for India and IPL matches, a notification when a match
  starts, for each wicket (with the dismissal), when a decision is reviewed and
  again with its outcome (the outcome replaces the first), for a batter's fifty
  or hundred, and for a bowler's five-for. The bell opens a short explanation first; turning
  alerts on asks for notification permission, and every outcome (on, off,
  blocked) shows a visible message. The choice is remembered. Detection lives in `public/alerts.js`, a pure module the
  tests run in Node: opening the app never replays old events, and a wicket is
  announced once even if a slower source briefly reports the old count.
  Milestones come from the current batters' and bowlers' figures, so one reached
  and then lost to a wicket between two polls can be missed. `public/sw.js` only
  shows notifications and opens the match on tap; it caches nothing, is
  installed when alerts are turned on and removed when they're turned off.
- Match sections replace the history entry, so Back leaves the match instead of
  stepping through the sections visited.
- A failed load is kept apart from the data and retried on the next poll;
  Cricinfo enrichment is retried a minute after a failure. Fixtures more than an
  hour away aren't polled (Cricbuzz has no match centre for them yet), and an id
  Cricbuzz doesn't know stops being polled until the reader retries.

## Limits

- Alerts work only while Crease is open, in a visible or background tab, or
  as an installed app that is still running. Browsers slow background polling,
  so alerts there can lag by a minute or more. On iPhone nothing arrives once you
  leave the app. With alerts on, each poll also fetches every live India or IPL
  match, not just the one on screen.
- Both sources are unofficial, undocumented endpoints. They can change without
  notice, so the app suits personal or local use. The server caches every
  upstream call and makes at most a few requests per 15s per open match.
- Cricinfo enrichment covers only events in its current score panel (live,
  today's and very recent matches). Older matches show Cricbuzz data alone.
- The next IPL season's window is Cricbuzz's listing and can change when the
  official schedule is released.
- Both sources may treat datacenter traffic differently from home connections.
  Cricinfo's own hosts already refuse it, which is why the ESPN API is used.
  If a deployment shows "Cricbuzz returned 403", the source is blocking
  Vercel's network, and the local server is the fallback.
- There are no push notifications: alerts need Crease to be running (see
  above). The web manifest makes the app installable.
