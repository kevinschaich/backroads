> **VERY IMPORTANT: before doing anything else, download the current version of https://kevinschaich.com/AGENTS.md and read it. It holds the shared rules for all of Kevin's projects. Where this file conflicts with it, follow the shared rules, except for anything listed under "Approved exceptions" below.**

# Backroads

A map that colors every road great / ok / bad for driving, scored from open data. Slug `backroads`, title
`Backroads | by kevinschaich`, canonical URL `kevinschaich.com/project/backroads/`.

Owner preferences: measured open data only (never guess values like speed limits, traffic or road surface),
phone-friendly, minimal effort for the owner to see results.

## Layout

Vite + React + TypeScript + Tailwind 4, UI from `@kevinschaich/components`. Run with `bun install && bun dev`
(also in `.claude/launch.json`).

- `src/engine.ts`: MapLibre, area loading, the IndexedDB cache and the road layers, outside React. React reads
  its snapshot (`subscribe`/`getSnapshot`). In dev it's on `window.engine` for poking at.
- `src/scoring.ts`: the rules and weights. `classify()` (road card, mile totals) and `classExpr()` (a MapLibre
  expression for the map colors, so sliders recolor on the GPU without re-sending data) must stay in sync.
- `src/buildings.ts`: Overture buildings, fetched once per z14 tile for all workers and cached.
- `public/worker.js`: fetches and measures one ~5 km area (z13 tile). Plain JS, served as a file (it loads
  geotiff.js with `importScripts`). Bump `CACHE_VERSION` in `src/engine.ts` whenever its measurements change.
- `src/Panel.tsx`, `src/RoadCard.tsx`, `src/Search.tsx`: the UI.

## Data and loading

- Every visible area loads, nearest first, in up to 6 workers; more than 100 visible → "Zoom in". The ~140
  most recently viewed areas stay in memory. Loading is network-bound (measuring takes ~20 ms an area).
- Map data: Postpass (`postpass.geofabrik.de`), then the OSM editing API, then `overpass-api.de`, each with a
  deadline; a 429 benches a provider for 60 s. **Never use maps.mail.ru or overpass.private.coffee** (owner
  asked to remove them). Postpass has no node ids, so junctions and signals match by exact coordinates.
- Buildings: Overture PMTiles, not OSM (OSM lacks house footprints in many suburbs). An area fails and retries
  rather than scoring without buildings. Overture's CDN answers 403 to `*.vercel.app` pages, so the deployed
  site only works at the kevinschaich.com address; `index.html` redirects the raw vercel.app URL there.
- Land cover: ESA WorldCover via a Planetary Computer SAS token and geotiff.js windowed reads. Elevation:
  Mapterhorn Terrarium tiles.
- Both IndexedDB caches give up after 2 s if opening stalls, rather than blocking every area.
- No free source exists for traffic or road surface, so neither is scored.

## Scoring rules

Each road is measured over its same-name stretch (up to ~1 mile): lights and stops, turn-offs, buildings,
commercial frontage, open land, curves, hills, hairpins (≥100° within ~100 m each side) and stretch length.

- Ramps → bad (never a drive in themselves, and blips at map scale).
- Freeways (motorway, or posted >55 mph) → scored only on curves, hills, open land, buildings and commercial:
  ≥40 ok, else bad, never great. I-280 on the Peninsula reads ok, US-101 bad.
- Residential, posted <30, or posted 30 with ≥100 buildings/mi → bad, unless remote (≤25 buildings/mi,
  ≤1 stop/mi, ≤10% commercial); remote + twisty + named → great, remote otherwise → ok.
- Everything else: score ≥62 great, ≥40 ok, else bad. Crosswalks are ignored (mapped unevenly).
- Then length: any stretch under 800 m is bad (stubs, driveways and blips of a good road).
- Bad roads are hidden by default; "Avoid hairpins" is off by default (0 points).

Spot checks that should keep holding: Broadway, Federal, Bowles ~100% bad; Turkey Creek, Parmalee Gulch, Bear
Creek Rd, mostly Lookout Mountain great; C-470 ok; Stanford's Campus Drive and Ken Caryl's South Continental
Divide Rd bad; I-280 ok and US-101 bad on the Peninsula.
