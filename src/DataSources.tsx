import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@kevinschaich/components'
import { Info } from 'lucide-react'

// Where everything on the map comes from. Keep in step with the README.
const SOURCES: { what: string; from: string; href: string; license: string }[] = [
    { what: 'Roads, junctions, signals, speed limits', from: 'OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright', license: 'ODbL' },
    { what: 'Road data servers', from: 'Geofabrik Postpass, OSM API, Overpass API', href: 'https://postpass.geofabrik.de', license: 'ODbL data' },
    { what: 'Buildings', from: 'Overture Maps Foundation', href: 'https://overturemaps.org', license: 'ODbL' },
    { what: 'Land cover', from: 'ESA WorldCover 2021, via Microsoft Planetary Computer', href: 'https://esa-worldcover.org', license: 'CC BY 4.0' },
    { what: 'Elevation', from: 'Mapterhorn', href: 'https://mapterhorn.com', license: 'Open data, see source' },
    { what: 'Dark and Streets basemaps', from: 'OpenStreetMap tiles', href: 'https://www.openstreetmap.org/copyright', license: 'ODbL' },
    { what: 'Satellite basemap', from: 'USGS The National Map', href: 'https://www.usgs.gov/programs/national-geospatial-program/national-map', license: 'Public domain' },
    { what: 'Place search', from: 'Photon by Komoot', href: 'https://photon.komoot.io', license: 'OSM data, ODbL' },
    { what: 'Map rendering', from: 'MapLibre GL JS', href: 'https://maplibre.org', license: 'BSD-3-Clause' },
]

/** The (i) in the map controls and the dialog it opens, crediting every source. */
export function DataSources() {
    return (
        <Dialog>
            <DialogTrigger
                render={
                    <button type="button" aria-label="Data sources" title="Data sources" className="grid place-items-center text-zinc-500 hover:text-zinc-800">
                        <Info className="size-4" />
                    </button>
                }
            />
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Data sources</DialogTitle>
                    <DialogDescription>Everything is measured from open data, fetched and scored in your browser.</DialogDescription>
                </DialogHeader>
                <dl className="grid grid-cols-[1fr_auto] border-t text-sm">
                    {SOURCES.map((s) => (
                        <div key={s.what} className="contents">
                            <dt className="border-b py-2 pr-3">
                                {s.what}
                                <a href={s.href} target="_blank" rel="noopener" className="block text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                                    {s.from}
                                </a>
                            </dt>
                            <dd className="border-b py-2 text-right text-xs text-muted-foreground">{s.license}</dd>
                        </div>
                    ))}
                </dl>
            </DialogContent>
        </Dialog>
    )
}
