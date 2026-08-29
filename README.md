# ODO

A private drive logger. All data stays on your phone; nothing is sent anywhere except
optional weather lookups (Open-Meteo) and optional place-name lookups (Nominatim).

## Deploying

Put every file in this folder at the root of the repo served by GitHub Pages:

    index.html
    app.css
    app.js
    sw.js
    manifest.webmanifest
    icon-192.png
    icon-512.png
    icon-maskable-512.png

`index.html` loads `app.css` and `app.js` with a `?v=N` query. Bump N on every
deploy that changes either file. A cached worker matches on the full URL, so a
new N is a guaranteed miss and the browser has to go to the network — without
it, a worker that caches `index.html` keeps serving the old page, which asks for
the old script, and no fix can reach the phone.

Then open the site in Chrome and use "Add to Home screen". The service worker
serves the app shell network first, so a deploy lands on the next load rather
than the one after; the cache is there for offline use. If a new worker takes
over a page that was already running, the page reloads itself once so the whole
app is on one version. The Garage tab shows which build is running.

## Data

Stored in IndexedDB, falling back to localStorage. Both are per-origin, so drives do
not follow you to a different domain — use Export backup and Import backup to move
them. Export CSV gives one row per drive for use in a spreadsheet.

## Notes

- Location and motion sensors both require an https origin.
- The tab must stay visible while recording; a backgrounded browser tab stops
  receiving GPS updates.
- Coverage is measured on a 100 m grid and reads roughly 10% high because of GPS
  scatter.
- Peak g is measured by estimating the gravity vector per axis and subtracting it.
  It is approximate in absolute terms but consistent between drives.

## Later additions

- Replay a drive on the map, or race two runs of the same route against each
  other with a live gap in metres.
- Best roads: every drive is cut into ~2 km stretches and scored on curvature,
  relief, how freely you moved and your own star rating. Duplicates of the same
  stretch collapse into one entry.
- Acceleration records (0–100, 0–50, 50–100) extracted from stored GPS speed.
  Runs slower than a plausible full-throttle pull are discarded rather than
  recorded as records.
- Light and dark: solar elevation computed from position and time, so distance
  in darkness, twilight, golden hour and daylight is exact rather than guessed
  from clock hours.
- Season and year in review, swipeable and shareable as a card.
- Diary: a photo, a note and a rating per drive. Photos are shrunk to about
  200 kB and stored under their own key so the main drive record stays small.

## The logbook

Thirty-nine detectors examine each period and either stay quiet or return one
sentence with an interest score. The writer takes the highest scorer as a
headline, then fills the paragraph from the next few, allowing only one
observation per subject so it never lists four distance facts in a row.

Rules that keep it readable:

- Observations describing a standing state (an empty compass direction, a
  record that has stood a long time) are suppressed if they were said in the
  previous entry — a two-entry window for months, three for weeks.
- A live trend that genuinely continues is allowed to repeat, prefixed with
  "Again,".
- Forward-looking lines (projections, service due dates) appear only in the
  current period, since predicting from a historical entry makes no sense.
- Numbers are rounded the way a person would say them: "just under 650 km",
  not 647.3.

## New roads

`firstTimeSegments()` replays every drive in chronological order and marks a
stretch as new only on the day you first reached it, so it works on drives
recorded long before the feature existed. It powers three things: a green
overlay on the heat map for the current week, month or year; a green
highlighter stroke under the route on a single drive's map, showing what was
new to you that day; and a "See new roads" button on logbook entries, which
opens the heat map with that month's new stretches picked out.

## Fuel log

Log a fill-up with litres, cost, an optional dash odometer reading, and whether
you filled right up. A "tank" is the stretch between two fill-ups: the litres
you just put in replaced what you burned since the last one, so litres over
that distance is real consumption. Partial fills carry forward until the next
full one.

Distance comes from odometer readings when you enter them — exact, and it
counts kilometres driven without recording — and falls back to logged drives
when you don't. Each row says which method it used.

Once two fill-ups exist, the measured figure replaces the estimated L/100 km
everywhere: per-drive fuel and cost, lifetime totals, the Scale comparisons and
per-route running costs. Price per litre comes from your most recent fill-up
rather than the number typed into the car record.

## Ranks and xp

Nine ranks, each split into tiers shown in Roman numerals, with a colour that
runs cold to hot across the ladder: Learner, Commuter, Regular, Road tripper,
Long hauler, Pathfinder, Ironbutt, Cartographer, Legend. The rank colour drives
the accent on the level number, the tier pips under the xp bar and the level-up
card.

`driveXp()` is now the sum of `xpBreakdown()`, so the itemised list can never
disagree with the total. The breakdown appears in each drive's sheet, on the
level-up card, and aggregated on the Stats tab as where your xp comes from.

## Elevation

Raw GPS altitude wanders by several metres even standing still, so summing
every small rise turns a flat motorway into a mountain — a Dutch commute was
reporting around 150 m of climb per trip. `cleanGain()` smooths the profile
over an eleven-point window, then only banks a climb once it has risen 10 m
without reversing. Tested against noisy synthetic profiles: a flat motorway
reports 0 m where the old method reported 500+, and a genuine 400 m climb still
measures 395 m. Drives recorded before per-point altitude existed report no
elevation and earn no climbing xp, rather than earning it from noise.

The threshold that protects against noise also hides genuine small hills, which
matters on flat terrain: a profile with a 7 m bridge and a 5 m dip measured 0 m
on a single run. So for any route with five or more runs, the altitude profile
is rebuilt by taking the median across every run at each 50 m along the route.
The GPS error averages out while the road stays put, allowing a much finer 3 m
threshold. Tested against a simulated commute with two small bridges and a dip:
16 m of true climb, 0 m from a single run, 15 m from 22 runs averaged. A
genuinely flat road still returns 0 by either method.

## Xp sources

Per drive: distance, a flat logging bonus, long run, after dark, smoothness,
twistiness (ramping in from 80°/km), new road, climbing, endurance over two
hours, rain, snow, fog, driving through sunrise or sunset, filling an enclosed
gap in your coverage, and the first run down a road in the opposite direction.

Standing pots: day streak, completed weekly challenges, three or more distinct
routes in a week, each logged service (more if done before it fell due), and
any tank that beat your own measured consumption.
