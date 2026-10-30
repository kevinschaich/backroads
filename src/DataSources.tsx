import type { DataSource } from '@kevinschaich/components'

// Where everything on the map comes from. Keep in step with the README.
export const SOURCES: DataSource[] = [
    { what: 'Roads, junctions, signals, speed limits', from: 'OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright', license: 'ODbL' },
    { what: 'Buildings', from: 'Overture Maps Foundation', href: 'https://overturemaps.org', license: 'ODbL' },
    { what: 'Land cover', from: 'ESA WorldCover 2021', href: 'https://esa-worldcover.org', license: 'CC BY 4.0' },
    { what: 'Elevation', from: 'Mapterhorn', href: 'https://mapterhorn.com', license: 'Open data, see source' },
    { what: 'Dark and Streets basemaps', from: 'OpenStreetMap tiles', href: 'https://www.openstreetmap.org/copyright', license: 'ODbL' },
    { what: 'Satellite basemap', from: 'USGS The National Map', href: 'https://www.usgs.gov/programs/national-geospatial-program/national-map', license: 'Public domain' },
    { what: 'Place search', from: 'Photon by Komoot', href: 'https://photon.komoot.io', license: 'OSM data, ODbL' },
]
