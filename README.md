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

`npm run dev` starts the website at http://localhost:3000. Route generation also needs BRouter running. See [the prototype README](prototype/README.md) for setup.

## Map data
Routes use data from [OpenStreetMap](https://www.openstreetmap.org/copyright), © OpenStreetMap contributors, and are generated with [BRouter](https://github.com/abrensch/brouter).

## Safety
Routes and stop counts are estimates from map data. They aren't guaranteed to be safe, accurate or passable, so follow local traffic rules and use your own judgment.
