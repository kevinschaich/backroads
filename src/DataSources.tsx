import type { DataSource } from '@kevinschaich/components'
import { BASEMAP_SOURCES, PHOTON_SOURCE } from '@kevinschaich/components/map'

// Where everything on the map comes from. Keep in step with the README.
export const SOURCES: DataSource[] = [
    { what: 'Roads, junctions, signals, speed limits', from: 'OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright', license: 'ODbL' },
    { what: 'Buildings', from: 'Overture Maps Foundation', href: 'https://overturemaps.org', license: 'ODbL' },
    { what: 'Land cover', from: 'ESA WorldCover 2021', href: 'https://esa-worldcover.org', license: 'CC BY 4.0' },
    { what: 'Elevation', from: 'Mapterhorn', href: 'https://mapterhorn.com', license: 'Open data, see source' },
    ...BASEMAP_SOURCES,
    PHOTON_SOURCE,
]
