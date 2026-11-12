# RunWay Routes: Website Version 1 Plan

Status: agreed, ready to build. Builds on the [product plan](route-planner-plan.md) and the [routing prototype](prototype/README.md).

## Goal
A public website where a runner picks a starting point and distance, gets a route with few likely stops, and downloads it as a GPX file for their watch. It should be good enough to use for real runs and to show employers.

## What the prototype proved
- **Routing:** BRouter with custom running profiles works, within the memory and storage the budget allows.
- **Stop estimates:** likely stops, meaning signals and roads of 5 or more lanes, matched real stops in two runs.
- **Sidewalks:** routes avoid road sections with no sign of a sidewalk, though neighborhood streets sometimes cause false alarms.
- **Watch:** GPX files import to COROS, turn alerts are correct, and the turnaround waypoint is announced.

## Version 1 features
### Choosing a route
1. **Find the area:** search by address or ZIP code to center the map, using a search button. The site never asks for device location.
2. **Set the start:** click or tap the map.
3. **Choose options:** distance in kilometers or miles, then out-and-back or loop.
4. **Generate:** get one route. "Generate another" gives a noticeably different one.

### The results
- **Map:** the route, start, turnaround, likely stops, other crossings and sections with no sign of a sidewalk
- **Summary:** actual distance, likely stops, other crossings, elevation gain
- **Elevation profile:** a small chart along the route
- **Warnings:** anything the route couldn't meet, such as "4.8 km, the closest match found"
- **Download:** a GPX file with the turnaround waypoint, plus short import steps for COROS and Garmin
- **Safety note:** routes are estimates from map data, and runners must follow traffic rules

### Added after testing
- **3 options at once, and closest matches:** a 20-mile out-and-back from Doral found no route that met every rule. Each request now returns up to 3 routes as tabs. When none meets every rule, the closest matches come back with a warning for each rule they miss.
- **Draw your own:** runners click points on the map, and the route follows roads and paths between them. It ends as drawn, goes back to the start, or comes back the same way. The same stop estimate, warnings, elevation and GPX download apply, so runners can check routes they already run.

### Not in version 1
- **Elevation choice (Flat, Rolling, Hilly):** Doral is too flat to test it. Version 1 shows elevation but doesn't let runners choose it.
- **Surface choice and a busy-roads switch:** routes always avoid busy roads with no sidewalk.
- **Accounts, saved routes and shareable links**
- **Ideas from the product plan for later:** extensions, shortcuts, distance markers and workout-shaped routes
- **Point to point:** a fewest-stops route from a start to a chosen end first, then point to point at a set distance. Drawing mode covers simple point-to-point routes in the meantime.
- **Dragging drawn points and freehand drawing:** drawn routes snap to roads and paths, and points can only be undone, not moved.

## How it fits together
1. **Browser:** a Next.js page with a MapLibre map. It sends the start point and options to the site's own server, and builds the GPX file itself, so routes are never stored.
2. **Route service:** TypeScript code from the prototype (the stop counter, route generator and GPX writer), moved into a shared package and run by the Next.js server.
3. **BRouter:** runs in its own container on the same server, with routing data for the launch area.
4. **Stop data:** crossings, signals, gates and road details from OpenStreetMap, prepared in advance and split into small map tiles. The service loads only the tiles around a route, so memory stays low. (The prototype loaded a 106 MB file for Doral alone, which doesn't scale.)
5. **Address search:** the site's server forwards searches to Nominatim, the free OpenStreetMap search service. Doing it on the server lets the site follow Nominatim's rules: identify the app, stay under about one request per second in total, and cache repeat searches.
6. **Map display:** OpenFreeMap map tiles, free with attribution.

### Privacy
- Store no accounts, routes or start points.
- Keep start points and addresses out of URLs and server logs.
- Build GPX files in the browser.

### Protecting the server
- Limit how many routes each visitor can generate per minute.
- Reject distances outside a set range, proposed as 1–42 km.

## Launch area
The prototype covers one map tile around Doral. Routing data for the whole world is only about 10 GB, but stop data has to be prepared separately for every area served. That makes the launch area the biggest decision for version 1.

**Proposed launch regions:** North America, Europe and the best-mapped parts of East Asia (Japan, South Korea and Taiwan). This covers areas with detailed map data without preparing data for the whole world.

- **Build and test with Florida first:** develop the stop data preparation with [Geofabrik's daily Florida extract](https://download.geofabrik.de/north-america/us/florida-latest.osm.pbf), which is quick to process and matches the field-test area. Add the other regions once the preparation works, before launch. The tile format means adding a region needs no code changes.
- **Data size:** an undated listing of [Geofabrik's extracts](https://download.geofabrik.de) shows about 14.5 GB for North America and 28.8 GB for Europe, compressed. Japan, South Korea and Taiwan are smaller country extracts. The stop tiles keep only roads, crossings, signals and gates, so they should be much smaller than the source files, but that still needs measuring.
- **Preparation:** too heavy for a small server. Run it on a local computer, which has about 350 GB free, and upload the finished tiles. Refresh them monthly.
- **Server storage:** routing data for these regions is part of BRouter's roughly 10 GB worldwide total, plus the stop tiles.
- **China:** leave it out. OpenStreetMap coverage there is much thinner, and map data in China has legal restrictions and a known position offset.
- **Data quality:** detail varies even within these regions, so the site should warn where crossing or sidewalk data looks sparse.

## Hosting
- **One server:** a virtual server with about 4 GB of memory runs the website, route service and BRouter, using Docker.
- **Cost:** late-2026 price lists for 4 GB servers range from about $5 to $24 per month. Prices rose sharply in 2026 at some providers. [Hetzner's](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) 8 GB US server reportedly rose to about $73 per month. Check current prices before choosing. Low stop-data memory is what keeps this within budget.
- **Domain:** optional. It makes the portfolio link look better, but costs a yearly fee.
- **HTTPS:** a web server such as Caddy, which sets up free certificates automatically.

## Testing
- **Route logic:** the existing 34 tests move with the code, plus tests for the stop tiles and the route service.
- **Website:** Playwright tests for the main flow: search, set a start, generate, download.
- **Automatic checks:** GitHub Actions runs the tests on every pull request.
- **Data check:** routes built from the new stop tiles must match the prototype's results for the same Doral requests.
- **Field test:** run at least one route generated by the live site.

## Build stages
Each stage ends in a pull request.

| Stage | Work | Done when |
|---|---|---|
| 1. Reorganize | Move route code into a shared package, set up the Next.js app, add automatic test runs | The prototype and tests still work from the new layout |
| 2. Stop data | Build the tile preparation script with Florida, load tiles on demand, then prepare all launch regions | Doral results match the prototype, memory stays low, and tile sizes for all regions are measured |
| 3. Route service | Server endpoint that takes a start and options and returns the route, stops and warnings | It returns Doral routes in under 10 seconds, with input checks and rate limits |
| 4. Website | Map, search, options, results and GPX download | The full flow works on phone and computer, and Playwright tests pass |
| 5. Deploy | Server, Docker, HTTPS, optional domain, data refresh | The public site works, within budget |
| 6. Polish and field test | README, screenshots, architecture notes, a run from the live site | Ready to share with employers |

## Risks
- **Stop data preparation:** reading OpenStreetMap extract files on Windows may need extra tools. Fallback: run the preparation in a container or on the server.
- **Sharing free services:** Nominatim and OpenFreeMap are run by volunteers or on donations. If traffic grows, self-host search or switch to a paid provider.
- **Data quality outside Doral:** other areas may have less detailed sidewalk and crossing data. Show a warning where data looks sparse.
- **Garmin:** still untested.

## Decisions
1. **Launch area:** North America, Europe, Japan, South Korea and Taiwan, built and tested with Florida first. This replaces the product plan's worldwide launch.
2. **Elevation:** version 1 shows elevation gain and a profile. The Flat, Rolling and Hilly choice comes later, once it can be tested in a hilly area.
3. **Domain:** use the server's address while building, and buy a domain before sharing the site with employers.
