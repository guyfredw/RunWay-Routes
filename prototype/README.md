# RunWay Routes: Doral Routing Test

A command-line prototype that tests whether BRouter can power RunWay Routes on a $50 monthly budget. It is not the final website.

## Status
**Computer test mostly passed. The field test on a real run and COROS watch hasn't been done, so BRouter isn't final yet.**

## Test setup
- **Routes:** 18 requests from 3 Doral parks, at 5, 10 and 16 km, as both out-and-back and loop
- **Comparison:** a route built with the same road rules and distance rule, chosen without considering stops
- **Map data:** OpenStreetMap, downloaded 4 November 2026

## Results
| Check | Target | Result | Status |
|---|---|---|---|
| Requests that get a usable route within 5% | 90% | 17 of 18 (94%) | Passed |
| Fewer estimated stops overall | n/a | 630 vs 1,107 (43% fewer) | n/a |
| Lower weighted stop score overall | 30% | 57% lower | Passed |
| Requests at 30% or better against one comparison route | n/a | 14 of 17 | n/a |
| Requests at 30% or better against the median comparison candidate | n/a | 16 of 17 | n/a |
| Traffic signals | n/a | 78 vs 256 | n/a |
| Generation time, this computer | 10 s | 0.9 s median, 2.5 s slowest | Passed |
| Memory | Low | Worked with a 256 MB Java limit, about 313 MB peak for the process | Passed |
| Worldwide routing data | Affordable | 1,142 tiles, about 10 GB in total; the Doral tile is 53 MB | Passed |
| Private roads or mapped gates on chosen routes | 0 | 0 | Passed |
| Different second route available | n/a | 17 of 18 | n/a |
| Stop counts match real runs | Five real runs | Not done | **Open** |
| GPX imports to COROS | Works | All files are valid XML, but none have been imported | **Open** |

Weighted score: signal = 5, crosswalk or major road = 3, side street = 1.

## Problems found
1. **Service roads:** unnamed service roads have few stops, so the first version chose them too often. One route used about 1.1 km of them. They now cost more and are limited to 10% of a route, down from about 14% of all distance to about 4%. A 727 m unnamed section remains on the Downtown Doral 10 km loop. Access to these roads can't be confirmed from the map.
2. **Busy roads:** about 6% of distance is on primary or secondary roads with no sidewalk tag. A sidewalk may exist but be unmapped, or the route may be on the road itself. This needs a stricter rule before launch.
3. **Gated communities:** the test only catches gates and private access that are mapped.
4. **One failed request:** the 5 km loop from Doral Central Park found no usable route, so the "closest match" fallback in the plan is needed.
5. **Short loops:** some repeat a section of road. The limit is 25% of a route.
6. **Elevation:** routes in very flat Doral report 7–49 m of gain, which may be data noise. Flat, Rolling and Hilly haven't been tested, and that needs a hilly area.
7. **Built-in loops:** BRouter's own loop option returned about 32 km for a 5 km request in one try, so this prototype builds its own loops.
8. **Other areas:** this area has unusually detailed sidewalk and crossing data, so results may be weaker elsewhere.
9. **Stop counting:** the counter has automated tests on small examples, but its real-world accuracy hasn't been measured.

## Rule changes since the results above
These stricter rules were added for the local routes, so the 18-route results above predate them:
- Service roads are limited to 5% of a route, down from 10%.
- Primary, secondary and trunk roads with no sidewalk tag are limited to 2% of a route.

## Field test 1: 5 km out-and-back
**Watch:** the route imported to COROS. Turn alerts appeared and were correct, and the start flag caused no problems. The turnaround wasn't tested because the runner left the route to stay on sidewalks.

**Stops:** about 6 actual stops on a 5 km run that left the planned route, against 12 estimated for the planned route. NW 74th St was one long crosswalk, with one stop on each pass.

**Route:** About 800 m of NW 102nd Ave, north of NW 66th St, had no sidewalk, so the route ran on the road. The map has no sidewalk tag or footpath alongside that stretch. The crossing of NW 74th St, mapped with 4–5 lanes, also suggested that wide roads mean longer waits.

**Changes made:**
- **Sidewalk evidence:** a road section counts as having a sidewalk if it's tagged with one or a mapped footpath runs within 20 m. Sections with neither add a penalty that grows with road width. Tertiary and busier roads with neither are limited to 2% of a route. Both route profiles also cost roads with no sidewalk tag more, by lane count.
- **Waits by road width:** each stop is rated short (1–2 lanes), medium (3–4) or long (5 or more), using the mapped lane count or a default for the road type. A traffic signal adds weight. Weights: short 1, medium 3, long 5, plus 3 for a signal.
- **Map viewer:** shows wait levels, signals, and road sections with no sign of a sidewalk.
- **One stop per intersection:** nearby crossings within 35 m of each other become one stop, up to 60 m in total. Both halves of a divided road with the same name become one crossing within 80 m, rated by their combined lanes. NW 74th St now counts once per pass, as a long wait with a signal (9 lanes across both halves).

**Checked against the run:** under the new rules, the planned route scores 10 estimated stops, against 12 before. It also has 3,241 m with no sign of a sidewalk, counting both directions, and the NW 74th St crossing rates as one long wait with a signal on each pass. The new 5 km out-and-back avoids that stretch, with 0 m flagged.

**Not yet measured:** stop-count accuracy, because the runner left the planned route. A GPX export of the actual run would allow a direct comparison.

**Known limits:**
- **False alarms:** about half of the flagged distance on the route that was run, south of NW 66th St and along NW 62nd St, actually had sidewalks according to the runner. Neighborhood streets often have no mapped footpaths, so longer routes can show a lot of flagged distance.
- **Short waits:** quiet side streets often don't mean an actual stop, so totals may run high.
- **Signals on smaller roads:** crossing a small road at a signal on a big road can still mean a long wait, but it's rated by the smaller road's width.
- **16 km loop:** no candidate met the rules from the owner's start point.

## Field test 2: new 5 km out-and-back
**Watch:** the route stayed on course, with a median of 8 m and at most 61 m from the planned line, and the runner reached the turnaround. The GPS distance was 5.03 km.

**Stops:** the only crossing stops were at the traffic signal at NW 97th Ave, once each way, which was predicted. The runner didn't stop at the crosswalk with a stop sign for cars at NW 78th Terrace and NW 102nd Ave, because pedestrians have priority there, and the recording agrees. The other pauses were watch checks at the turnaround to confirm the right spot. The estimate had been 12 stops. Of the 10 unsignalled crossings predicted, the recording shows the runner passing nearly all at full running speed (about 2.2–2.7 m/s).

**Not on the map:** no stop or yield signs are mapped near the NW 78th Terrace and NW 102nd Ave crosswalk. It counts as an unsignalled 4-lane crossing, which matches what happened.

**Turnaround:** the runner had to check the watch to confirm the turnaround point. A marked turnaround point in the GPX file could help.

**Changes made:**
- **Likely stops:** only traffic signals and unsignalled crossings of 5 or more lanes now count as likely stops. Other crossings are counted separately and shown smaller on the map.
- **Weights:** signal crossings score 4–8 by road width. Unsignalled crossings score 0.5 (1–2 lanes), 1 (3–4 lanes) or 5 (5 or more lanes).

**Checked against the run:** the route that was run now scores 2 likely stops, both at the NW 97th Ave signal, plus 10 other crossings. That matches the 2 actual crossing stops.

## Turnaround marker
Out-and-back GPX files now include a waypoint named "Turnaround" at the halfway point, described as "Turn around here (2.50 km)", for example. The map viewer shows it as a black dot.

**Field test 3**, a repeat of the 5 km out-and-back (option 2):
- **Display:** the COROS app showed the turnaround marker on the route.
- **Alert:** the watch announced the turnaround as soon as the runner reached it.
- **Pauses:** near the turnaround, about 8 s stopped and 30 s slowed this time, against about 2 minutes of stops on the previous run, when the runner had to check the watch.
- **Stops:** the only crossing stops were again at the NW 97th Ave signal, for 14 s out and 38 s back. That matches the 2 predicted likely stops.
- **Route:** the run stayed close to the planned route, with a median of 8 m away, and was back at the start after 5.06 km by GPS. The runner then ran a little extra.

## Current routes
Routes start from the owner's private start point, stored in `data/local-start.json`. That file and the generated routes are excluded from Git by `.gitignore`, so don't share them publicly. Generate them with `src/run-local.ts`, then open `output/local/viewer.html`.

Check each route on the viewer and in person before relying on it. Follow traffic rules, and skip any section that looks unsafe or private.

1. `output/local/runway-5km-out-and-back.gpx`: 0 likely stops and 24 other crossings. It runs north along the NW 107th Ave sidewalk to NW 90th St. Its score is nearly tied with option 2, and it crosses several larger streets, such as NW 82nd St, where no signal is mapped, so check those crossings in person.
2. `output/local/runway-5km-out-and-back-option-2.gpx`: 2 likely stops (the NW 97th Ave signal) and 10 other crossings. It follows the same corridor as the route that was run.
3. `output/local/runway-10km-out-and-back.gpx`: 4 likely stops, all signals, and 15 other crossings. 330 m is flagged as having no sign of a sidewalk.

Other 5, 10 and 16 km routes are in the same folder.

Record:
- Whether the file imports and displays correctly on the COROS watch
- Whether turn alerts work
- Each actual stop, compared with the viewer's markers
- Any section that was blocked, private or unsafe

## Setup
These large or private files aren't stored in Git, so you need to add them after cloning:
- **Java:** a Java 21 runtime in `vendor/java/`, such as [Eclipse Temurin](https://adoptium.net/)
- **BRouter:** [version 1.7.10](https://github.com/abrensch/brouter/releases/tag/v1.7.10), unzipped to `vendor/brouter/`, with an empty `vendor/brouter/customprofiles/` folder
- **Routing data:** [`W85_N25.rd5`](https://brouter.de/brouter/segments4/W85_N25.rd5) in `vendor/brouter/segments4/`
- **Map data:** an [Overpass](https://overpass-api.de/) export of the Doral area saved as `data/doral-osm.json`, with `way["highway"]`, plus crossing, signal, stop and gate nodes, from `out body geom`
- **Your start point (`src/run-local.ts` only):** `data/local-start.json`, in the form `{ "lat": 0, "lon": 0 }`

`profiles/lookups.dat` is copied from BRouter 1.7.10.

## Running it
Start BRouter in one terminal, from this folder:

```bash
vendor/java/jdk-21.0.13+9-jre/bin/java -Xmx256M -cp vendor/brouter/brouter-1.7.10/brouter-1.7.10-all.jar btools.server.RouteServer vendor/brouter/segments4 profiles vendor/brouter/customprofiles 17777 2
```

Then run these in another terminal:

```bash
node --test src/stops.test.ts src/gpx.test.ts
```

```bash
node --max-old-space-size=4096 src/run-test.ts
```

```bash
node --max-old-space-size=4096 src/audit.ts
```

Results are written to `output/`. Open `output/viewer.html` to see the routes on a map.

The test data in `data/` came from a one-off download from the public Overpass service. The finished site shouldn't rely on that service.
