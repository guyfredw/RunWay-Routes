# Stop-data pipeline

Turns an OpenStreetMap extract into small stop-data tiles that the route service loads on demand.

## What goes in a tile
Each tile covers 0.05° of latitude and longitude, about 5.5 km north to south, and is stored as `<row>_<column>.json.gz`.

- **Ways:** roads and paths, with node IDs, coordinates (degrees × 10⁷) and only the tags the stop counter uses: highway, name, lanes, sidewalk, footway, crossing, oneway, access, foot, service, bridge and tunnel.
- **Nodes:** traffic signals, crossings, stop and yield signs, and gates.
- **Ways crossing a tile edge:** stored in each tile they touch, and loaded once.

Each output folder also has a `manifest.json` with the source file, build time, counts and sizes.

## Building tiles
Download an extract from [Geofabrik](https://download.geofabrik.de/) into `data/osm/`, then run:

```bash
npm run build:florida -w @runway/pipeline
```

For other areas:

```bash
node --max-old-space-size=16000 pipeline/src/build-stop-tiles.ts data/osm/<area>-latest.osm.pbf data/stop-tiles/<area>
```

### All launch regions
`regions/launch.txt` lists the 117 Geofabrik extracts that cover the launch regions: the US, Canada, Mexico, Greenland, Europe, Japan, South Korea and Taiwan. Overlapping extracts, such as Great Britain inside Britain and Ireland, are left out. To build them all into one folder, run:

```bash
npm run build:launch -w @runway/pipeline
```

The script downloads one extract at a time, checks its checksum, builds it into `data/stop-tiles/launch`, then deletes the download. Neighbouring regions share tiles at borders, so each way appears once. A region that can't be downloaded is skipped and listed at the end. Rerunning the script builds only the regions that are missing.

The reader in `src/osm-pbf.ts` handles OpenStreetMap's PBF format with zlib or uncompressed blocks, which is what Geofabrik publishes. `data/` isn't stored in Git.

## Map data licence
Tiles contain OpenStreetMap data, © OpenStreetMap contributors, available under the [Open Database License](https://www.openstreetmap.org/copyright).

## Florida results
Built from Geofabrik's Florida extract of 11 November 2026, on a Windows PC with 31 GB of memory.

| Measure | Result |
|---|---|
| Source file | 661 MB |
| Roads and paths kept | 2.9 million, using 17.2 million nodes |
| Signals, crossings, stop signs and gates | 580,000 |
| Tiles | 5,796, 276 MB in total (largest 1.3 MB) |
| Build time | 91 seconds |
| Peak memory while building | 1.4 GB |
| Loading a 9 km radius for a 16 km route | 20 tiles in 0.6 seconds, using about 390 MB of memory |

**Checked against the prototype:** 22 of 27 saved Doral routes gave identical stop estimates from tiles and from the prototype's Overpass download of 4 November. Totals across all 27 routes were 119 against 118 likely stops, and 783 against 777 other crossings. The small differences are likely map edits made in the week between the two downloads. Routes generated from the field-test start point were identical with either source.

## Launch region results
Built from Geofabrik extracts of 8 to 11 November 2026, on the same PC.

| Measure | Result |
|---|---|
| Regions | 117 extracts, 54.9 GB downloaded |
| Tiles | 898,000, 22.9 GB in total (24 GB on disk) |
| Tile sizes | Median 10 KB, 99% under 250 KB, largest 2.5 MB (central Paris) |
| Build time | 2 hours of processing, about 4.5 hours with downloads |
| Peak memory while building | 12 GB for France, 6.5 GB for Germany, under 2 GB for most regions |

Building needs more memory than the route server will have, so tiles are built on a desktop and copied to the server. The route service still loads only the tiles around each request.
