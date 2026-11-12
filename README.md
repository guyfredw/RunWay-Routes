# RunWay Routes

A free website, in development, that generates running routes with fewer stops. Runners choose a starting point, distance and course type, then download a GPX file for a COROS or Garmin watch.

## Status
The routing approach has been tested in three runs in Doral, FL. The website works locally and is next to be deployed.

- [Product plan](route-planner-plan.md)
- [Website version 1 plan](website-v1-plan.md)
- [Routing prototype and field test results](prototype/README.md)

## Project layout
| Folder | Contents |
|---|---|
| `packages/routing` | Route generation, stop estimates and GPX output, shared by the website and the prototype |
| `web` | The Next.js website |
| `prototype` | Command-line routing prototype, BRouter profiles and field-test tools |

## Development
Requires Node.js 24 or later.

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run dev
```

Browser tests run against a production build:

```bash
npm run build
```

```bash
npm run test:e2e
```

The first run needs the test browser: `npx playwright install chromium` in `web/`. The browser tests replace the route, search and map-style requests with test data, so they don't need BRouter, Nominatim or map tiles.

`npm run dev` starts the website at http://localhost:3000. Route generation also needs BRouter running and stop tiles built. See [the prototype README](prototype/README.md) for BRouter setup and [the pipeline README](pipeline/README.md) for tiles.

| Setting | Default | Purpose |
|---|---|---|
| `BROUTER_URL` | `http://localhost:17777/brouter` | Where BRouter runs |
| `STOP_TILES_DIR` | `../data/stop-tiles/launch` | Stop tiles, relative to `web/` |
| `NOMINATIM_URL` | `https://nominatim.openstreetmap.org/search` | Address search service |
| `NEXT_PUBLIC_MAP_STYLE` | OpenFreeMap's Liberty style | Map style, set when building |

## Website
1. **Find your area:** search by address, place or ZIP code. When a search matches several places, the runner chooses one. The site never asks for device location.
2. **Set the start:** click or tap the map, zoomed in to at least street level.
3. **Choose options:** distance in kilometres or miles, and loop or out-and-back.
4. **Results:** the route on the map with likely stops, other crossings, sections with no mapped sidewalk and the turnaround. Also shown: distance, stop counts, climb, an elevation profile and any warnings.
5. **Compare:** up to 3 routes at once, as tabs showing each one's distance and likely stops. "Show more routes" brings the next set. When no route meets every rule, a notice says these are the closest matches, and each route lists what it misses.
6. **Download:** the browser builds the GPX file for the chosen route, with the turnaround waypoint for out-and-back routes.

**Draw your own** is the other mode. Each click or tap adds a point, and the route follows roads and paths between them. It can end as drawn, go back to the start, or come back the same way with a turnaround marker. Points can be undone or cleared. The route updates after each change, with the same stop estimate, warnings, elevation profile and GPX download.

Searches go through the site's server at `POST /api/search`, which follows [Nominatim's usage policy](https://operations.osmfoundation.org/policies/nominatim/). It identifies the app, sends at most about one request per second in total, and caches repeat searches in memory for an hour. Each visitor can search 10 times per minute.

## Route service
`POST /api/route` with a JSON body generates one route. A POST keeps the start point out of URLs and server logs, and nothing is stored.

```json
{ "lat": 25.8195, "lon": -80.3553, "distanceKm": 5, "type": "loop", "page": 0 }
```

- **Inputs:** `distanceKm` from 1 to 42, and `type` either `loop` or `out-and-back`. The service ranks up to 9 routes that overlap each other by no more than half. They come 3 at a time, and `page` picks the set.
- **Response:** up to 3 route options, each with coordinates and elevation, distance, climb, each stop and crossing, sections with no mapped sidewalk, the turnaround point for out-and-back routes, and warnings. The browser builds the GPX file from the coordinates.
- **Rules:** within 5% of the distance, with no private roads or gates, no more than 2% on busy roads with no sign of a sidewalk, and no more than 5% on service roads. Service roads within 400 m of the start or finish don't count, so a route can leave a parking lot. Loops may repeat no more than 25% of their ground. When no route meets every rule, the service returns the closest matches instead, with `meetsRules: false` and a warning on each one for every rule it misses. Closest matches must still be within 10% of the distance, with no private roads or gates. They are ranked by how many metres break the other rules, in 500 m steps, then by stops.
- **Limits:** 6 routes per visitor per minute and 60 per hour (429), 2 routes generated at once across all visitors (503), and request bodies up to 8 KB (413).

`POST /api/draw` joins drawn points:

```json
{ "points": [[25.8195, -80.3553], [25.8290, -80.3553]], "shape": "loop" }
```

- **Inputs:** 2 to 100 points as `[lat, lon]`, within about 50 km across. `shape` is `as-drawn`, `loop` (back to the start) or `out-and-back`.
- **Joining:** one BRouter request through all the points, with the baseline profile, so the route follows the runner's choices rather than avoiding stops.
- **Response:** one route in the same form as a generated option. Instead of being rejected, a drawn route gets warnings for private roads, gates and busy roads with no mapped sidewalk.
- **Limits:** the page asks again after each change, so drawing allows 60 requests per visitor per minute and 600 per hour, with 4 at once.

In Doral, most routes took under 4 seconds on the development PC. 20-mile out-and-backs took 5 to 9 seconds, and 20-mile loops 10 to 12 seconds. Long routes and loops from Doral's business district often get closest matches, because some busy roads there have no mapped sidewalks.

## Map data
Routes use data from [OpenStreetMap](https://www.openstreetmap.org/copyright), © OpenStreetMap contributors, and are generated with [BRouter](https://github.com/abrensch/brouter).

## Safety
Routes and stop counts are estimates from map data. They aren't guaranteed to be safe, accurate or passable, so follow local traffic rules and use your own judgment.
