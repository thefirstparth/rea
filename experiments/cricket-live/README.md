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
| `GET /api/tournament`                      | the ICC event (World Cup, T20 World Cup, Champions Trophy) found by name in India's schedule and results, with every match from its series page                                                               | 10m                                   |
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
- **India**: the senior men's team, a side named exactly `India`. India A, India U19
  and other India sides (`indiaOther`) aren't tagged: they never lead home or the
  India tab, and alerts don't cover them. The India tab lists them in their own
  section at the bottom; All live puts them right after India and the IPL.
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

The browser tests (`test/ui.test.mjs`, `test/ui-scenarios.test.mjs`, over the
harness in `test/ui-harness.mjs`) replay `test/fixtures/ui-api.json`, recorded
by `test/capture-ui.mjs` while following an IPL side with the World Cup tab on.
Every view is audited for overlap, overflow, clipping, contrast, tap size and
empty space under the page heading at 320, 390 and 1280px in light and dark.
Other tests reopen the app offline through the service worker, and feed it a
Wi-Fi login page and an answer of the wrong shape. The scenarios move the clock and the
data: the worst live match to lay out, the IPL tab between seasons and
mid-season (the recorded 2026 season, half of it turned back into fixtures), and
the World Cup tab a week before its event and under each setting.

## Keeping it running

Nothing in Crease names a season, a year or a series: the IPL season comes from
Cricbuzz's league schedule, the last one from its yearly archive, the ICC event
from India's fixtures, a followed team from its team page. So the app moves from
season to season and event to event on its own, for as long as its sources keep
their formats.

`.github/workflows/crease-canary.yml` checks that every day. It runs
`test/canary.mjs` against the deployed app (`vars.CREASE_URL`, default
https://trycrease.vercel.app): the page, the match lists, the schedules and
archive, an IPL points table, the ICC event, a team page, a match centre with
its scorecard and squads, and Cricinfo for the same match. Each check asserts
only what holds on any day. A failure opens one issue labelled `crease-canary`
(later failures comment on it), and the next passing run closes it. Run it by
hand with `node experiments/cricket-live/test/canary.mjs [url]`, or from the
Actions tab. GitHub pauses scheduled workflows in a repository with no activity
for 60 days and emails before it does; re-enable it from the Actions tab.

### When a source changes

1. The failing check names the route and what broke (an HTTP status, or a
   missing field). Reproduce it locally: `NODE_USE_ENV_PROXY=1 node
   experiments/cricket-live/server.mjs`, then the canary against
   `http://localhost:5173`.
2. Find the parser: every route and its source page are listed under "How it
   works"; each adapter (`lib/cricbuzz.mjs`, `lib/cricinfo.mjs`) is the only
   place that knows its source's format, and exports its parsers as `parse`.
3. Re-record the fixtures (`test/capture.mjs`, then `test/capture-ui.mjs`
   against a running local server), run the tests, and fix the parser until
   they pass. The invariants don't need rewriting for new data.
4. "Cricbuzz returned 403" on Vercel but not locally means the source blocks
   Vercel's network, not a format change (see Limits).

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
  where the data comes from, what is stored (six `localStorage` keys, no
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
- **Matchday poster**: when no India or IPL match is live, home leads with the
  next one as a poster: both sides' flags on their team colours (darkened until
  white text passes WCAG AA), the countdown to the first ball, and the start in
  IST and at the ground.
- **IPL**: while a season runs (first match to three days after the last), the
  next match, the points table, fixtures and results. Between seasons, the next
  season's dates as Cricbuzz lists them, and the last finished season (found by
  name in Cricbuzz's yearly archive) with its champion and final table. Nothing
  names a year: each season is found from the data.
- **World Cup**: an ICC men's event India play in (found by name, qualifiers left
  out) gets a fifth tab: a countdown, India's matches, the group tables, the full
  schedule and results. Settings → World Cup tab: Automatic (default: from two
  weeks before its first match to two days after its last), Always, or Off,
  stored in `crease-wc`. The next event is picked up the same way, without code.
- **Following a team**: tap the star beside a team in a points table (the name
  itself does nothing; switching teams offers Undo), or pick one in Settings (IPL
  sides from the tables; the Test nations and leading associates by their fixed
  Cricbuzz ids, plus any side in the known fixtures; not India, which is always
  on Now). Its live match joins Now marked "Your team", its next fixture shows as
  "Your team" (from its Cricbuzz team page) even while it plays, and alerts
  include its matches. Between IPL seasons an IPL side shows its last
  finish and the next season's start. The choice is stored in `crease-team`.
- **Alerts** (the bell): for India and IPL matches and the followed team's (the
  sheet names them, and says so when the open match isn't covered), a notification when a match
  starts, for each wicket (with the dismissal), when a decision is reviewed and
  again with its outcome (the outcome replaces the first), for a batter's fifty
  or hundred, and for a bowler's five-for. The bell opens a short explanation first; turning
  alerts on asks for notification permission, and every outcome (on, off,
  blocked) shows a visible message. The choice is remembered. Detection lives in `public/alerts.js`, a pure module the
  tests run in Node: opening the app never replays old events, and a wicket is
  announced once even if a slower source briefly reports the old count.
  Milestones come from the current batters' and bowlers' figures, so one reached
  and then lost to a wicket between two polls can be missed.
- **Offline**: `public/sw.js` is installed on the first visit. It shows alerts and
  opens a tapped alert's match, and it keeps Crease's own files and the last answer
  to each API request (up to 60, without query strings) in cache storage. Every
  request goes to the network first, so online nothing is served from the copy;
  offline, or when the connection stalls for 8 seconds (one bar of signal), the
  app opens with its last scores and the top bar gives their age ("Offline" when
  the device knows it is). Only answers the app can read are kept, so a Wi-Fi
  login page never replaces them. About & privacy says the same.
- **Bad answers**: anything that isn't Crease's JSON (a Wi-Fi login page, a cut-off
  body) or has the wrong shape is a failure the page shows and retries, never data;
  a view that still fails to render shows an error card. An answer older than the
  one on screen (a stale CDN copy on a forced refresh) is set aside.
- **Results settle the match**: Cricbuzz can post "X won by …" minutes before its
  state leaves "In Progress"; the adapter reads a result in the status as finished.
  A side that declared isn't shown batting through the break.
- **Screen readers and keyboards**: section labels are headings, commentary is a
  list, a polite live region announces wickets, overs, breaks and the result (not
  every ball), focus moves to the new page's heading and back to the opened card on
  Back, and there is a skip link.
- Match sections replace the history entry, so Back leaves the match instead of
  stepping through the sections visited. Bottom tabs do the same between tabs
  other than Now, so Back returns to Now and then leaves.
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
