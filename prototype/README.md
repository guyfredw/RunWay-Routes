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

## Field test
Routes now start from the owner's private start point, stored in `data/local-start.json`. That file and the generated routes are excluded from Git by `.gitignore`, so don't share them publicly. Generate them with `src/run-local.ts`, then open `output/local/viewer.html`.

Check each route on the viewer and in person before relying on it. Follow traffic rules, and skip any section that looks unsafe or private.

1. `output/local/runway-5km-out-and-back.gpx`: 12 estimated stops, against 19 for the comparison route. The farthest point is 1.9 km from the start.
2. `output/local/runway-5km-loop.gpx`: 30 estimated stops, against 35 for the comparison route, with no signals on the chosen route. It's 4.83 km and includes several side streets.

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
node --test src/stops.test.ts
```

```bash
node --max-old-space-size=4096 src/run-test.ts
```

```bash
node --max-old-space-size=4096 src/audit.ts
```

Results are written to `output/`. Open `output/viewer.html` to see the routes on a map.

The test data in `data/` came from a one-off download from the public Overpass service. The finished site shouldn't rely on that service.
