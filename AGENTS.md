> **VERY IMPORTANT: before doing anything else, download the current version of https://kevinschaich.com/AGENTS.md and read it. It holds the shared rules for all of Kevin's projects. Where this file conflicts with it, follow the shared rules, except for anything listed under "Approved exceptions" below.**

# Backroads

A map that colors every road great / ok / bad for driving, scored from open data. Slug `backroads`, title
`Backroads | by kevinschaich`, canonical URL `kevinschaich.com/project/backroads`.

Owner preferences: measured open data only (never guess values like speed limits), phone-friendly, minimal
effort for the owner to see results.

## Live version (`live/`): the product

Static page, no build step: `live/index.html` + `live/worker.js`. Run locally with
`python3 -m http.server 8765 -d live` (also in `.claude/launch.json`).

- The browser fetches and scores ~5 km areas (z13 tiles) on demand in Web Workers. Every visible area loads;
  more than 100 visible → "Zoom in". Only the ~140 most recently viewed areas stay in memory.
- Map data: Postpass (`postpass.geofabrik.de`), then the OSM editing API, then `overpass-api.de`, each with a
  deadline; a 429 benches a provider for 60 s. **Never use maps.mail.ru or overpass.private.coffee** (owner
  asked to remove them). Postpass has no node ids, so junctions and signals match by exact coordinates.
- Buildings: Overture PMTiles (`tiles.overturemaps.org/<release>/buildings.pmtiles`, z14), not OSM. OSM lacks
  house footprints in many suburbs, which made whole subdivisions read 0 buildings/mi and score Great. An
  area fails and retries rather than scoring without buildings.
- Land cover: ESA WorldCover via a Planetary Computer SAS token and geotiff.js windowed reads.
  Elevation: Mapterhorn Terrarium tiles (`tiles.mapterhorn.com/{z}/{x}/{y}.webp`, 512 px).
- Measurements cache in IndexedDB under `v{CACHE_VERSION}/…`; bump `CACHE_VERSION` whenever worker
  measurements change.
- Scoring runs on the main thread, twice: `classify()` in JS (road card, mile totals) and `classExpr()` as a
  MapLibre expression (map colors, so sliders recolor on the GPU without re-sending data). Keep them in sync.
- Basemaps: Dark (OSM tiles inverted in MapLibre; Carto now needs an API key), Streets (OSM), Satellite (USGS),
  None. Overlays are dark except on Streets.
- Search: Photon (`photon.komoot.io`), which allows search-as-you-type (Nominatim's policy forbids it).
  The URL carries `#zoom/lat/lon`, updated when the map stops moving.

## Scoring rules

Each road is measured over a ~1 mile same-name corridor (stops/mi, turn-offs/mi, buildings/mi, commercial
frontage, open land, curves °/km, hills m/km), then scored with the weights in `DEFAULTS` in `live/index.html`:

- freeway, ramp, or posted >55 mph → ok
- residential, posted <30, or posted 30 with ≥100 buildings/mi → bad, unless remote (≤25 buildings/mi,
  ≤1 stop/mi, ≤10% commercial); remote + twisty + named → great, remote otherwise → ok
- everything else: score ≥62 great, ≥40 ok, else bad. Crosswalks are ignored (mapped unevenly).

Spot checks that should keep holding: Broadway, Federal, Bowles, University ~100% bad; High Grade, Kuehster,
Turkey Creek, Parmalee Gulch, Lookout Mountain, Bear Creek Rd mostly great; C-470 all ok; Stanford's Campus
Drive and Ken Caryl's South Continental Divide Rd bad.

## Approved exceptions

- **Stack (Vite + React + TypeScript + Tailwind 4):** Backroads is a no-build static page in `live/` using the
  runtime kit, so its `vercel.json` sets `framework: null`, no install or build, `outputDirectory: "live"`.
  Why: it predates the stack rule, which keeps no-build pages on the runtime kit until they need React
  components. Recorded 2026-10-28.
