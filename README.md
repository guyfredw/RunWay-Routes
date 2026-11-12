# RunWay Routes

A free website, in development, that generates running routes with fewer stops. Runners choose a starting point, distance and course type, then download a GPX file for a COROS or Garmin watch.

## Status
The routing approach has been tested in three runs in Doral, FL, and the website is now being built.

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

`npm run dev` starts the website at http://localhost:3000. Route generation also needs BRouter running and stop tiles built. See [the prototype README](prototype/README.md) for BRouter setup and [the pipeline README](pipeline/README.md) for tiles.

| Setting | Default | Purpose |
|---|---|---|
| `BROUTER_URL` | `http://localhost:17777/brouter` | Where BRouter runs |
| `STOP_TILES_DIR` | `../data/stop-tiles/launch` | Stop tiles, relative to `web/` |

## Route service
`POST /api/route` with a JSON body generates one route. A POST keeps the start point out of URLs and server logs, and nothing is stored.

```json
{ "lat": 25.8195, "lon": -80.3553, "distanceKm": 5, "type": "loop", "variant": 0 }
```

- **Inputs:** `distanceKm` from 1 to 42, and `type` either `loop` or `out-and-back`. `variant` picks another route for a redo. The service ranks up to 5 routes that overlap each other by no more than half, and the count is returned as `options`.
- **Response:** the route's coordinates with elevation, distance, climb, each stop and crossing, sections with no mapped sidewalk, the turnaround point for out-and-back routes, and warnings. The browser builds the GPX file from the coordinates.
- **Rules:** within 5% of the distance, with no private roads or gates, no more than 2% on busy roads with no sign of a sidewalk, and no more than 5% on service roads. Service roads within 400 m of the start or finish don't count, so a route can leave a parking lot. Loops may repeat no more than 25% of their ground. When no route meets the rules, the service returns status 422 with an explanation.
- **Limits:** 6 routes per visitor per minute and 60 per hour (429), 2 routes generated at once across all visitors (503), and request bodies up to 2 KB (413).

In Doral, routes took 0.6 to 9.6 seconds on the development PC, with most under 4 seconds. Loops from Doral's business district often find no route, because the busy roads there have no mapped sidewalks.

## Map data
Routes use data from [OpenStreetMap](https://www.openstreetmap.org/copyright), © OpenStreetMap contributors, and are generated with [BRouter](https://github.com/abrensch/brouter).

## Safety
Routes and stop counts are estimates from map data. They aren't guaranteed to be safe, accurate or passable, so follow local traffic rules and use your own judgment.
