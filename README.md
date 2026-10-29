[![Backroads by kevinschaich](https://kevinschaich.com/og/backroads.png)](https://kevinschaich.com/project/backroads/)

# Backroads

Find the roads worth driving, anywhere.

**[Try it →](https://kevinschaich.com/project/backroads/)**

## How it works

- 🟢 **Great**: few stops, open land alongside, curves or hills
- 🟡 **OK**: plain roads, and freeways through open country
- 🔴 **Bad**: stoplight-and-strip-mall arterials, neighborhood streets and built-up freeways (hidden by default)

As you pan, the page fetches OpenStreetMap roads for the areas in view and scores them in the browser.
Each road is measured over about a mile of the same street: lights and stops, turn-offs, buildings,
commercial frontage, open land (ESA WorldCover), curves, hairpins and hills (Mapterhorn elevation).
Speeds are never guessed: a posted limit is used only where OpenStreetMap has one. Tap any road to see
its measurements and why it got its color, and tune the weights with the sliders.

## Data sources

| What | Where it's from | License |
|---|---|---|
| Roads, junctions, signals, speed limits | [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, via Geofabrik Postpass, the OSM API and Overpass API | ODbL |
| Buildings | [Overture Maps Foundation](https://overturemaps.org) | ODbL |
| Land cover | [ESA WorldCover 2021](https://esa-worldcover.org), via Microsoft Planetary Computer | CC BY 4.0 |
| Elevation | [Mapterhorn](https://mapterhorn.com) | Open data, see source |
| Dark and Streets basemaps | [OpenStreetMap](https://www.openstreetmap.org/copyright) tiles | ODbL |
| Satellite basemap | [USGS The National Map](https://www.usgs.gov/programs/national-geospatial-program/national-map) | Public domain |
| Place search | [Photon](https://photon.komoot.io) by Komoot | OSM data, ODbL |

## Run locally

```sh
bun install && bun dev
```
