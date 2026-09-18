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

Legend used to be the end of it — every level past 80 said "top rank" and
nothing changed again, which turns the last rank into a wall on a ladder that
is otherwise endless. Past the named ranks it carries on in numbered eras of
twenty levels, Legend II, Legend III and so on, each with its own colour from a
cycle of nine. There is always a next thing named and a distance to it.

## The level gauge

A level was a number, and a number is the same shape at 3 as at 300. It is a
rev counter now, read the way a rev counter is read: the needle sits at how far
through the rank you are and the redline is where the rank ends, so the gauge
answers "how close am I" at a glance, which a number never did.

The dial itself climbs. Every 25 levels it gains a number on the face, 8 up to
14, and then the face is remade and the mark advances — MK I, MK II, MK III.
Roman numerals do not run out, so there is no last gauge: the dial just keeps
being rebuilt for a bigger engine.

Every level moves the needle, every 25 rebuilds the face, and every rank
changes the colour, so nothing about it can settle.

The needle starts just above zero on a new rank rather than against the stop,
because a needle on its stop reads as broken. It runs into the redline over the
last sixth of a rank, which is the point of drawing it this way: revving out
means a promotion is close. It never passes the end stop at any level.

It sits above the xp bar and fills the level-up card.

Two of these can be on screen at once, so each carries its own filter id; a
shared one would have the small gauge glowing through the big one.

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
gap in your coverage, the first run down a road in the opposite direction, a
clean run (sensor only), and pushing one of your eight borders outward.

Standing pots: day streak, completed weekly challenges, three or more distinct
routes in a week, each logged service (more if done before it fell due), and
any tank that beat your own measured consumption,
and each region tier reached.

Multiplying the per-drive total: the age of the car that drove it.

## Drive grade

Every drive over 1.5 km gets a letter, S down to E, weighted over four
components: Control (smoothness, 35), Road (twistiness, 25), Commitment (peak
g, 25) and Journey (distance, 15). Control and Commitment pull against each
other on purpose — either one alone is easy, and holding a high line smoothly
is the thing worth grading.

A component with no data drops out and the rest are re-weighted, so a phone
with no motion sensor is graded on what it does know rather than marked down
for what it does not.

New road is a bonus of up to 14 points on top, never part of the weighting. It
was a weighted component to begin with, and that was wrong: almost every drive
is down a road you have already been, so almost every drive forfeited a
quarter of its grade before it started, and a physically perfect run on known
roads could not beat 78. Finding new road is a bonus for how you drove, not a
tax on driving the same road well.

The anchors — where each component reads nothing and where it reads full marks
— are set against the 66 recorded drives rather than estimated. Each pair sits
at roughly the 5th and 95th percentile of what those drives actually produced:
smoothness 36 to 86, twist 10 to 57°/km, peak g 0.19 to 0.47, distance 5 to
70 km.

Twist is the one worth explaining. The first attempt asked for 130°/km,
reasoning from a twisty-road challenge that asks 140. No recorded drive has
ever passed 68 and the median is under 20, so Road scored a flat zero on
almost everything and a quarter of the grade did nothing at all. These roads
are not those roads.

Distance tops out at 55 km rather than the 70 the long drives reach, because
the drives fall into two clumps — a ten kilometre commute and a fifty
kilometre run — and a ramp reaching the far end left more than half of them
pinned at full marks, which is a component carrying no information.

Across the 66 the ladder reads E 3, D 13, C 29, B 16, A 5, centred on C with
the best drive at 82. S is deliberately just out of reach of anything driven
so far. `gradeSpread()` reprints all of it from your own data.

## Clean run

The longest stretch of a drive that never provoked the accelerometer, worth a
multiplier from ×1.0 to ×2.0, one step per 150 seconds. It is computed after
the drive and shown in the sheet, so there is nothing to watch while driving.

Standing still provokes nothing either, so stopped time is taken out before the
stretch is measured: a drive with a ten-minute wait in the middle of it scores
the driving, not the waiting. Otherwise a level crossing would out-score any
real piece of road.

The sensor only ever stored a jolt *count*, so drives recorded before this
build have no timings to work from. They fall back to a gps estimate, which is
shown with a `gps` marker but never paid xp — the same footing smoothness sits
on, and for the same reason: there is nothing to calibrate it against.

## Route medals

Distance piled onto a single route, which is a different achievement from
driving it quickly: it is the road you actually know. Bronze at 100 km, then
Silver, Gold, Platinum, Crown and Legend at 5 000 km. Shown on each route with
the distance still to go.

## The eight borders

How far out you have reached in each compass sector, measured from the place
you set off from most often. A point under 2 km from home cannot set a border,
so circling your own town does not count as a direction.

`borderPushes()` replays the drives in the order you made them, the way
`markPbs()` and `firstTimeSegments()` do, so a push keeps the xp it earned on
the day even after a later drive goes further. The push is measured against
where the border stood *before the drive*, not against the previous point:
driving steadily outward extends a sector a few metres at a time, and per-point
increments would score a 50 km push as a string of 200 m ones and pay for none
of them.

The first drive into an empty sector earns nothing — there was no border there
to push.

## An old car earns more

A car can carry the year it was built, and earns one percent more xp per year
of its age. A 1991 car drove for 35% more in 2026; a 2024 one for 2%.

The age is taken at the date of the drive, not today, so a drive keeps the xp
it earned rather than quietly gaining a percent every New Year — the same
reason `markPbs()` replays the history instead of measuring against today's
best. Set the year on a car that has already been driven and its whole history
is recounted at once.

The boost multiplies what the drive itself earned and appears as its own row
at the bottom of the breakdown. Streaks, weekly challenges and services are
not the car's doing and are left alone, which keeps the Stats xp breakdown
honest: one named row rather than a thumb on every other scale. Because it is
worked out per drive from the car that drove it, two cars earn at their own
rates from the same wheel.

A car with no year set earns exactly what it earned before.

## Which car was that

After a drive is saved, the Drive tab asks which car it was, with a button per
car you have entered and the active one already chosen. Asked afterwards
rather than before, because the answer is obvious once you are standing next
to the thing, and a question before the key turns is one more screen between
you and driving. One car is one glance and no taps.

Changing the answer re-earns the drive: the age bonus is worked out per drive
from the car that drove it, so moving a drive between a 1991 car and a new one
moves its xp with it.

## Fog of war

A toggle on the heat map that takes the map out from under the coverage,
leaving only the roads you have actually driven. It is the same data seen as a
different question — the shape of what you know, rather than where you have
been on a map of somewhere else.

Roads alone float in nothing, so the towns are labelled back in, and from your
own driving rather than from a label layer. "Name the towns" clusters every
driven point at 8 km — about one town — and reverse-geocodes one point per
cluster, one call each, a second apart, the way route endpoints are already
named. The answers are kept, so it is asked once. On 66 drives that is 29
lookups, about 35 seconds.

The map then names the places you have been and stays quiet about everywhere
else. Two clusters either side of a town both answer with the town, so the
name is shown once, at whichever you have been near most. Labels are sized by
how often you have been there, so home reads loudest.

Nominatim answers one point at a time and rate-limits bulk reverse geocoding,
so a run of thirty can be cut off part way. That used to pass in silence: a
cluster whose lookup failed was skipped, and every square nearest to it kept a
grid reference with nothing on screen saying why. The run now shows a bar, the
reason for each failure, and a Stop button, exactly as measuring does, and a
place that could not be named is asked about again on the next run rather than
written off for good.

The name is taken from the widest thing that names a place a driver would
recognise — city, then town, village, municipality — and then narrower ones,
borough, district, suburb, hamlet, locality, and finally whatever the point
itself is called. The narrow ones matter in the countryside, where there is no
town for several kilometres but there is a hamlet with a name. The first list
stopped at municipality and county, which is why some squares kept a grid
reference even though OpenStreetMap knew perfectly well what was there.

## Roads you know, by area

The coverage grid grouped into 10 km squares, so exploring is broken into
places rather than being one number that only ever goes up. Four tiers per
square, by distance of road driven in it: Been through at 2 km, Driven a fair
bit at 10, Driven a lot at 30, Driven a great deal at 60. Each tier reached is
a standing pot of xp and cannot be lost.

The tiers are named for distance driven because that is all that is measured.
An earlier set called them Scouted, Known, Owned and Mastered, which promises
a share of the roads that exist — exactly the denominator the next paragraph
explains the app cannot have. 78 km of road inside a square holding a city is
a great deal of driving and nothing like all of it, and a tier that says
"Owned" when you have driven perhaps a fifth of a town is simply lying.

Progress is kilometres of distinct road driven inside a square, not a
percentage of it. A percentage needs to know how much road the square holds,
which needs the road network, which the app does not have and cannot get
offline — and most of a 10 km square is fields, so any honest denominator
would pin every region at two or three percent forever. Coverage already
refuses to fake this and so does this.

Squares are built from the coverage cells rather than the raw points, so a
region counts the same distinct road the heat map does and a commute driven
two hundred times counts once. They take the name of the nearest town already
looked up for the fog map, which costs nothing because that lookup has
happened anyway. Where there is no such town — the fog run was cut short, or
the nearest cluster could not be named — the square is looked up on its own
centre instead. Between the two, every square you have driven in gets a name.
A grid reference is not something anyone can read.

Measuring and naming are two halves of one job, so one button does both:
"Measure and name the squares", under the list it fills. It used to stop at
the first half and report "every square is measured" while half the rows still
read as grid references, with the naming on another tab entirely and no way to
reach it from here.

"Name the towns" stays on the map, because what it labels is the map.

### Measuring a square against the map

"Measure the squares", under the list on the Stats tab, asks Overpass for the
total length of drivable road in each square, which gives the denominator the paragraph above says the app does
not have. It is one request per square and about 350 bytes back, because
Overpass sums the length server-side rather than sending every street:

    way["highway"~"^(motorway|trunk|...)$"](bbox);
    make stat total=sum(length());

Only roads you could drive down are counted — no tracks, footpaths, service
roads or car parks. Answers are kept, so a square is asked about once.

Once a square is measured its tier is a real share: Been through at 2%, Driven
a fair bit at 6, Driven a lot at 12, Driven a great deal at 20. Those look low
and are not. Across twenty-one squares measured against the map the shares run
0.2% at the lowest, 2.6% a quarter of the way up, 3.4% at the half, 7.3% at
three-quarters and 15.7% at the top — that best one being Hasselt, 78.7 km
driven of the 499.9 km it holds. So the ladder puts most squares on the first
rung, the well-driven ones on the second, the best few on the third, and
leaves the fourth to be earned: 4 barely touched, 11 been through, 5 driven a
fair bit, 1 driven a lot. A tier at 75% would be one nobody ever reaches.

The share is conservative in a town. Driven distance is counted in distinct
100 m cells and a cell counts once whatever runs through it, so three parallel
streets count once on top and three times underneath. It is fair in the
countryside and an under-read in a city centre.

A bar under the button counts the squares as they are measured, names the one
being asked about and counts the seconds it has been waiting, so a slow square
looks slow rather than looking frozen. A Stop button ends the run after the
square in flight, and everything answered so far is kept.

Squares are asked six at a time. Overpass takes several bounding boxes in one
query and labels each answer, so thirty-three squares cost six requests rather
than thirty-three — and the number of requests is what matters, because the
public servers start queueing you. Asked one at a time, answers went from 2 s
to 20-30 s by the fourth request and squares began falling off the end of the
deadline. Asked six at a time, a request carrying six squares comes back in
about 23 s.

Which squares failed looked like it depended on their names. It did, but only
by accident: a square with no named town nearby is one you barely drove, those
sort last, and last is when the throttling is worst.

A batch that cannot be asked is split in half and tried again, down to single
squares, so one awkward square cannot take five good ones down with it every
time. The deadline scales with the batch — twenty seconds for one square,
nine more for each after — and the server-side allowance sits under it, so
the server gives up before we do and says why.

The public Overpass servers are free, need no key, and are frequently busy;
504 and 429 are normal. When a square fails, the reason is shown rather than
swallowed — "HTTP 504 Gateway Timeout ×8" says the servers are loaded and
trying later will work, where "HTTP 400" would mean the query is wrong and
trying later will not. Overpass reports a timeout two ways: usually an HTTP
status, but under load it answers 200 with no elements and a remark
explaining itself, which would otherwise read as a square holding no road at
all, so that case is caught and reported too. So three mirrors are tried in turn, each answered
square is saved as it arrives, and a square that could not be reached is left
unasked rather than recorded as having no roads — which would have marked
every square the server was too busy for as roadless for ever. Tapping the
button again picks up exactly where it stopped.

A square that has not been measured still shows distance driven, but it is not
given a tier once any other square has a real share. Distance tiers and share
tiers are different scales and side by side they lie: a square with 54.9 km
driven and no denominator filled its bar to the brim next to Hasselt, the best
known square there is, sitting at 16% of the road it actually holds. So an
unmeasured square reads "Not measured" and says what it is waiting for.

With nothing measured at all there is no second scale to be confused with, and
the distance ladder stands on its own.

Two squares either side of a town are both nearest to that town, so the list
showed the same name twice with no way to tell them apart. The closest keeps
the bare name and the others say which side they are on — "Nazareth" and
"Nazareth SW".

No tier means a square is finished, because the app has no way to know what
finished would be.

On 66 drives that is 33 squares touched, the best two past 60 km of road.
