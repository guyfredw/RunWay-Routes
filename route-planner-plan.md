# RunWay Routes: Product Plan

Status: draft for discussion. The tech stack is deliberately not decided here.

## Summary
A free website that generates a running route from a starting point and a set of preferences, with the goal of **limiting stops during a run**. Runners download the route as a GPX file and import it to a COROS or Garmin watch.

## Goals
- Build a useful tool that the owner will use for their own runs.
- Create a strong portfolio project for the current job search, built with AI-assisted coding.
- Keep running costs low. This is a personal project, not a business for now.

## Constraints
- **Budget:** up to $50 per month for tools and services beyond the Claude membership.
- **Time:** full time, with no deadline.
- **Test watch:** COROS. No Garmin watch is available yet.
- **Test area:** Doral, FL.

## Non-goals for the first version
- Accounts or saved routes
- Direct Garmin or COROS integration
- Manual route editing
- Portable toilets and water fountains (planned for later)
- Payments or advertising

## How it works
1. The runner enters an address or ZIP/postal code, which centers the map.
2. The runner clicks the map to set the starting point. The site does not ask for device location.
3. The runner selects their preferences.
4. The site generates one route.
5. The runner reviews the map, elevation profile, stats and likely stops.
6. The runner either generates another route or downloads the GPX file.

## Route preferences
| Preference | Options | Rule |
|---|---|---|
| Distance | Value entered by runner, in km or miles | Within 5% of the request |
| Course type | Out-and-back or loop | Start and finish at the same point |
| Elevation | Flat, Rolling or Hilly, plus optional target gain | Show the actual gain |
| Stops | A "fewer interruptions" setting | Reduce crosswalks and intersections |
| Surface | Road, trail or mixed | Best effort, depending on map data |
| Busy roads | Avoid (on or off) | Best effort, depending on map data |

### What counts as a likely stop
Crosswalks and intersections are the feature's main measure, so the plan treats them as a weighted estimate:
- **Highest cost:** traffic signals
- **Medium cost:** marked crosswalks and crossings of major roads
- **Low cost:** crossings of minor side streets

A route's estimate counts each pass, so an out-and-back route counts a crossing twice if the runner passes it in both directions. Exact weights will be tuned during testing.

### When preferences conflict
Confirmed priority order:
1. Same start and finish, on routes that are legally runnable according to the map data
2. Distance within 5%
3. Fewest likely stops
4. Elevation
5. Surface and busy-road preferences

If a selection can't be met, the site shows the closest match and explains the difference, for example "2 km flatter than requested".

### Generating another route
Each new attempt should produce a noticeably different route. It should avoid repeating routes already shown in the current session.

## Route results page
- Map with the route and start/finish marked
- Likely stops marked on the map
- Elevation profile
- Actual distance, elevation gain and estimated stops
- Explanation of any preference that was missed
- Generate another and Download GPX buttons
- Short import instructions for COROS and Garmin

## GPX export and watch support
- No official integration is needed, because both watch brands accept imported GPX routes.
- Turn prompts must be tested on real watches, because reports on prompts from imported GPX files are mixed.
- COROS documents turn-by-turn navigation and GPX import. Users report mixed results for prompts on imported routes.
- Garmin course points generally need a format such as FIT or TCX. Users report that Garmin Connect sometimes adds prompts to imported GPX courses.
- If GPX prompts prove unreliable, consider adding FIT or TCX downloads later.

## Scope and data
- **Launch:** worldwide, with local testing in Doral, FL first.
- **Doral checks:** confirm that routes handle gated communities, private roads, canals and major roads correctly.
- **Data quality:** crossing and signal data varies by area, so counts are estimates and are labelled that way.
- **Coverage warning:** the site warns when an area appears to have sparse crossing data.
- **Attribution:** comply with the licenses of all map and elevation data used.

## Safety and privacy
- State clearly that routes are not guaranteed to be safe or passable and that runners must obey local traffic rules.
- Don't present any route as having "no stops". Use "estimated stops".
- Store no accounts or personal data.
- Keep addresses and starting points out of URLs and logs where possible, since a start point may be a runner's home.

## Delivery stages
### 1. Prove the core route logic
Generate local routes, count likely stops and compare them with what's really on the ground. This is the highest-risk stage, so it comes first.

### 2. Build the core website
Add the address search, map click, all preferences, the results page and GPX download. It must work well on phones and computers.

### 3. Test on real watches and real runs
Import to a COROS watch, check prompts and run several routes in Doral. Check Garmin import with a borrowed watch or a volunteer, and label Garmin support as untested until then.

### 4. Launch worldwide
Test routes in several cities and countries, add data warnings and publish the site.

### 5. Finish the portfolio package
Add a public demo, README, architecture notes, automated tests, screenshots and an account of how AI was used.

### Later
- Portable toilets and water fountains along the route
- Manual route editing
- Shareable route links
- FIT or TCX downloads

## Proposed success targets
- At least 90% of test routes land within 5% of the requested distance.
- Routes generate quickly enough to feel responsive. Proposed limit: 10 seconds.
- Routes have at least 30% fewer estimated stops than a comparison route of the same distance that ignores stops.
- Estimated stops are checked against at least five real runs, and the results are published.
- GPX files import successfully on a COROS watch, and on a Garmin watch once one is available for testing.
- The site works on current phone and desktop browsers.

## Open questions
- Do real runs and a COROS import confirm the Doral test? See `prototype/README.md`.
- Does the proposed stack below still hold after those runs?

## Proposed tech stack
Not final until the field test passes.
- **Routing:** self-hosted BRouter, using custom running profiles, plus our own route generator
- **Website:** Next.js, React and TypeScript
- **Map display:** MapLibre with OpenFreeMap
- **Address search:** Nominatim, using a search button rather than search-as-you-type
- **Stop data:** extract of crossings, signals and roads from OpenStreetMap
- **Hosting:** one small virtual server using Docker, priced against the $50 budget
- **Testing and code hosting:** Vitest, Playwright and GitHub

## Next step
Complete the field test, then decide on the stack.
