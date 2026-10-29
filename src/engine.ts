// The map and area loading, outside React: MapLibre, the worker pool that fetches and measures ~5 km areas, the
// IndexedDB cache, and the road layers. React reads a snapshot (subscribe/getSnapshot) and calls the setters.
import * as maplibregl from 'maplibre-gl'
import type { ErrorEvent, GeoJSONSource, MapMouseEvent } from 'maplibre-gl'
// MapLibre 6 loads its worker relative to its own module, which bundlers don't pick up; bundle it explicitly.
import maplibreWorker from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

maplibregl.setWorkerUrl(maplibreWorker)
import { buildingTile } from './buildings'
import { landcoverToken } from './landcover'
import { finalize } from './smooth'
import { classExpr, DEFAULT_WEIGHTS, type Road, type Verdict, type Weights, COLORS } from './scoring'

const TILE_Z = 13
const MAX_TILES = 100 // more visible than this and nothing new loads ("Zoom in")
const KEEP_TILES = 140 // areas kept in memory; the rest stay in IndexedDB
// Loading an area is mostly waiting on the network (measuring takes ~20 ms), so more workers load more in parallel.
const WORKERS = Math.min(6, Math.max(3, (navigator.hardwareConcurrency || 4) - 1))
const CACHE_VERSION = 10 // bump whenever the worker's measurements change

type Feature = { type: 'Feature'; properties: Road & Partial<Verdict>; geometry: { type: 'LineString'; coordinates: number[][] } }
type Tile = {
    key: string
    x: number
    y: number
    state: 'queued' | 'loading' | 'done' | 'error'
    used: number
    roads?: Feature[]
    stage?: string
    started?: number
    error?: string
}
export type Basemap = 'dark' | 'streets' | 'satellite' | 'none'
export type Place = { name: string; detail: string; lat: number; lon: number; extent?: [number, number, number, number] }
/** A loaded road matching a search: all its segments, and the longest one for its card. */
export type RoadHit = { name: string; detail: string; miles: number; k: number; bounds: [number, number, number, number]; road: Road }
export type Snapshot = {
    status: { busy: number; done: number; error?: string; tooMany: boolean }
    jobs: { stage: string; seconds: number }[]
    miles: [number, number, number]
    hidden: number[]
    weights: Weights
    basemap: Basemap
    card: { road: Road; pinned: boolean } | null
}

const BASEMAPS: Record<Basemap, { tiles?: string[]; attribution?: string; maxzoom?: number; bg: string; paint?: Record<string, number> }> = {
    // OSM tiles inverted and desaturated (Carto's dark tiles now need an API key).
    dark: {
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        attribution: '© OpenStreetMap contributors',
        maxzoom: 19,
        bg: '#18181b',
        paint: { 'raster-brightness-min': 0.9, 'raster-brightness-max': 0.08, 'raster-saturation': -0.85, 'raster-contrast': 0.1 },
    },
    streets: { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attribution: '© OpenStreetMap contributors', maxzoom: 19, bg: '#f2efe9' },
    satellite: {
        tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'],
        attribution: 'USGS The National Map',
        maxzoom: 16,
        bg: '#111',
    },
    none: { bg: '#18181b' },
}

const link = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`
const CREDITS = [
    `Roads © ${link('https://www.openstreetmap.org/copyright', 'OpenStreetMap')} via Postpass / OSM API / Overpass`,
    `buildings ${link('https://overturemaps.org', 'Overture Maps')}`,
    `land cover ${link('https://esa-worldcover.org', 'ESA WorldCover 2021')}`,
    `elevation ${link('https://mapterhorn.com', 'Mapterhorn')}`,
]

const store = (k: string, v?: unknown) => {
    try {
        v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v))
    } catch {}
}
const recall = <T,>(k: string): T | null => {
    try {
        return JSON.parse(localStorage.getItem(k) ?? 'null')
    } catch {
        return null
    }
}

// ---------------------------------------------------------------- IndexedDB tile cache

// The cache is an optimization: if opening it stalls (another tab, a pending deletion), carry on without it.
const db: Promise<IDBDatabase | null> = new Promise((res) => {
    setTimeout(() => res(null), 2000)
    try {
        const req = indexedDB.open('driving-live', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('tiles')
        req.onsuccess = () => res(req.result)
        req.onerror = () => res(null)
        req.onblocked = () => res(null)
    } catch {
        res(null)
    }
})
async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
    const d = await db
    if (!d) return null
    return new Promise((res) => {
        try {
            const r = fn(d.transaction('tiles', mode).objectStore('tiles'))
            r.onsuccess = () => res(r.result)
            r.onerror = () => res(null)
        } catch {
            res(null)
        }
    })
}

const lon2x = (lon: number) => Math.floor(((lon + 180) / 360) * 2 ** TILE_Z)
const lat2y = (lat: number) => Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** TILE_Z)
const tileKey = (x: number, y: number) => `v${CACHE_VERSION}/${TILE_Z}/${x}/${y}`
// Read once at startup: removing a map (React's dev mode mounts twice) clears the hash it was managing.
const INITIAL_HASH = location.hash

export class Engine {
    map: maplibregl.Map
    private tiles = new Map<string, Tile>()
    private queue: Tile[] = []
    private pool: { w: Worker; busy: boolean }[] = []
    private seq = 0
    private tooMany = false
    private features: Feature[] = []
    private renderTimer: number | null = null
    private totalsTimer: number | undefined
    private statusTimer: number | undefined
    private refreshing: Promise<void> | null = null
    private refreshAgain = false
    private listeners = new Set<() => void>()
    private snap: Snapshot
    private narrow = matchMedia('(max-width: 640px)').matches
    timings: Record<string, number>[] = []

    constructor(container: HTMLElement) {
        const weights = { ...DEFAULT_WEIGHTS, ...(recall<Weights>('weights') ?? {}) }
        const basemap = (recall<Basemap>('basemap') ?? 'dark') in BASEMAPS ? (recall<Basemap>('basemap') ?? 'dark') : 'dark'
        // Bad roads are hidden by default: the map reads cleaner with just the roads worth driving.
        const hidden = recall<number[]>('hidden') ?? [0]
        this.snap = { status: { busy: 0, done: 0, tooMany: false }, jobs: [], miles: [0, 0, 0], hidden, weights, basemap, card: null }

        for (let i = 0; i < WORKERS; i++) this.pool.push({ w: this.worker(), busy: false })
        // A #zoom/lat/lon link wins over the last view remembered in this browser.
        const [z, lat, lon] = INITIAL_HASH.slice(1).split('/').map(Number)
        const home = [z, lat, lon].every(Number.isFinite)
            ? { center: [lon, lat] as [number, number], zoom: z }
            : (recall<{ center: [number, number]; zoom: number }>('view') ?? { center: [-105.0166, 39.6133], zoom: 12 })
        this.map = new maplibregl.Map({
            container,
            center: home.center,
            zoom: home.zoom,
            // The URL carries #zoom/lat/lon, updated when the map stops moving, so links reopen the same view.
            hash: true,
            dragRotate: false,
            attributionControl: { compact: true, customAttribution: CREDITS },
            style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#18181b' } }] },
        })
        this.map.touchZoomRotate.disableRotation()
        this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
        this.map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: false } }), 'top-right')
        // MapLibre reports problems (e.g. its worker failing to rebuild the road data) here rather than throwing.
        this.map.on('error', (e: ErrorEvent) => console.warn('map error', e.error || e))
        this.map.on('load', () => this.onLoad())
        this.map.on('moveend', () => {
            store('view', { center: this.map.getCenter().toArray(), zoom: this.map.getZoom() })
            this.refresh()
        })
        this.wireInteraction()
    }

    private worker() {
        return new Worker(`${import.meta.env.BASE_URL}worker.js`)
    }

    // ------------------------------------------------------------ React bridge

    subscribe = (fn: () => void) => {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
    }
    getSnapshot = () => this.snap
    private set(patch: Partial<Snapshot>) {
        this.snap = { ...this.snap, ...patch }
        this.listeners.forEach((fn) => fn())
    }

    // ------------------------------------------------------------ map layers

    private onLoad() {
        const map = this.map
        map.addSource('roads', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'id' })
        const W = [
            [0.4, 1.2, 3],
            [1, 2.4, 6],
            [1.2, 2.8, 7],
        ] // width at zoom 8 / 12 / 16: bad roads stay thin
        for (const k of [0, 1, 2])
            map.addLayer({
                id: `r${k}`,
                type: 'line',
                source: 'roads',
                filter: ['==', ['get', 'k'], k],
                layout: { 'line-cap': 'round', 'line-join': 'round', visibility: this.snap.hidden.includes(k) ? 'none' : 'visible' },
                paint: {
                    'line-color': COLORS[k],
                    'line-opacity': 0.75, // see the basemap underneath
                    'line-width': ['interpolate', ['linear'], ['zoom'], 8, W[k][0], 12, W[k][1], 16, W[k][2]],
                },
            })
        map.addLayer(
            {
                id: 'hl',
                type: 'line',
                source: 'roads',
                filter: ['==', ['id'], -1],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: { 'line-color': '#fff', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 16, 10], 'line-opacity': 0.55 },
            },
            'r0',
        )
        this.setBasemap(this.snap.basemap)
        this.render()
        this.refresh()
    }

    setBasemap(name: Basemap) {
        store('basemap', name)
        document.documentElement.classList.toggle('dark', name !== 'streets')
        const map = this.map
        const B = BASEMAPS[name]
        if (map.getLayer('base')) map.removeLayer('base')
        if (map.getSource('base')) map.removeSource('base')
        map.setPaintProperty('bg', 'background-color', B.bg)
        if (B.tiles) {
            map.addSource('base', { type: 'raster', tiles: B.tiles, tileSize: 256, maxzoom: B.maxzoom, attribution: B.attribution })
            map.addLayer({ id: 'base', type: 'raster', source: 'base', paint: B.paint ?? { 'raster-opacity': 0.85 } }, 'hl')
        }
        this.set({ basemap: name })
    }

    setHidden(k: number, hide: boolean) {
        const hidden = hide ? [...new Set([...this.snap.hidden, k])] : this.snap.hidden.filter((h) => h !== k)
        this.map.setLayoutProperty(`r${k}`, 'visibility', hide ? 'none' : 'visible')
        store('hidden', hidden)
        this.set({ hidden })
    }

    // While a slider moves, the GPU recolors instantly from the per-road expression; once it settles, the
    // connectivity pass (src/smooth.ts) recomputes the final classes and the layers switch back to them.
    // One-off changes (Reset) skip the preview and go straight to the final classes.
    setWeights(weights: Weights, settled = false) {
        store('weights', weights)
        this.set({ weights })
        clearTimeout(this.totalsTimer)
        if (settled) return this.draw()
        const e = classExpr(weights)
        for (const k of [0, 1, 2]) this.map.setFilter(`r${k}`, ['==', e, k] as never)
        this.totalsTimer = window.setTimeout(() => this.draw(), 300)
    }

    // ------------------------------------------------------------ area loading

    private wanted(): [number, number][] {
        const b = this.map.getBounds()
        const c = this.map.getCenter()
        const cx = lon2x(c.lng)
        const cy = lat2y(c.lat)
        const x0 = lon2x(b.getWest()), x1 = lon2x(b.getEast()), y0 = lat2y(b.getNorth()), y1 = lat2y(b.getSouth())
        this.tooMany = (x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES
        if (this.tooMany) return []
        const out: [number, number][] = []
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y])
        return out.sort((a, q) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy))
    }

    // One pass at a time: a pan during a pass asks for one more, which then reads the latest view.
    refresh() {
        if (this.refreshing) {
            this.refreshAgain = true
            return
        }
        this.refreshing = this.refreshOnce()
            .catch((err) => console.warn('refresh failed', err))
            .finally(() => {
                this.refreshing = null
                this.updateStatus()
                if (this.refreshAgain) {
                    this.refreshAgain = false
                    this.refresh()
                }
            })
    }

    private async refreshOnce() {
        const want = this.wanted()
        const wantKeys = new Set(want.map(([x, y]) => tileKey(x, y)))
        // Drop queued tiles that scrolled out of view; in-flight ones finish and stay cached.
        for (let i = this.queue.length - 1; i >= 0; i--)
            if (!wantKeys.has(this.queue[i].key)) {
                this.tiles.delete(this.queue[i].key)
                this.queue.splice(i, 1)
            }
        const now = Date.now()
        for (const key of wantKeys) {
            const t = this.tiles.get(key)
            if (t) t.used = now
        }
        this.evict()
        const fresh: Tile[] = want
            .map(([x, y]) => ({ state: 'queued' as const, x, y, key: tileKey(x, y), used: now }))
            .filter((t) => !this.tiles.has(t.key))
        for (const t of fresh) this.tiles.set(t.key, t)
        // Look all new areas up in the cache at once; the misses go to the workers, nearest first.
        const cached = await Promise.all(fresh.map((t) => idb<{ roads: Feature[] }>('readonly', (s) => s.get(t.key))))
        fresh.forEach((t, i) => {
            if (this.tiles.get(t.key) !== t) return // replaced or dropped meanwhile
            const hit = cached[i]
            if (hit) Object.assign(t, { roads: hit.roads, state: 'done' })
            else this.queue.push(t)
        })
        if (cached.some(Boolean)) this.render()
        this.pump()
    }

    // Keep only the most recently viewed areas in memory, so the map never holds more roads than it can redraw quickly.
    private evict() {
        const kept = [...this.tiles.values()].filter((t) => t.state === 'done').sort((a, b) => b.used - a.used)
        if (kept.length <= KEEP_TILES) return
        for (const t of kept.slice(KEEP_TILES)) this.tiles.delete(t.key)
        this.render()
    }

    private pump() {
        for (const slot of this.pool) {
            if (slot.busy || !this.queue.length) continue
            const t = this.queue.shift()!
            const id = ++this.seq
            slot.busy = true
            Object.assign(t, { state: 'loading', stage: 'Starting', started: Date.now() })
            slot.w.onmessage = (e) => {
                const m = e.data
                if (m.type === 'buildings') return this.sendBuildings(slot.w, m)
                if (m.type === 'token')
                    return landcoverToken().then(
                        (list) => slot.w.postMessage({ type: 'token', rid: m.rid, list }),
                        (err) => slot.w.postMessage({ type: 'token', rid: m.rid, error: String(err?.message ?? err) }),
                    )
                if (m.id !== id) return
                if (m.stage) {
                    t.stage = m.stage
                    this.updateStatus()
                    return
                }
                slot.busy = false
                if (m.ok) {
                    Object.assign(t, { state: 'done', roads: m.roads, used: Date.now() })
                    if (import.meta.env.DEV) this.timings.push(m.timings) // per-source load times, for profiling
                    idb('readwrite', (s) => s.put({ roads: m.roads, sources: m.sources, at: Date.now() }, t.key))
                    this.evict()
                    this.render()
                } else {
                    Object.assign(t, { state: 'error', error: m.error })
                    console.warn('tile', t.key, m.error)
                }
                this.pump()
                this.updateStatus()
            }
            // A worker that crashes (e.g. out of memory) is replaced, and its area retries on the next pan.
            slot.w.onerror = (e) => {
                e.preventDefault()
                console.warn('worker crashed on', t.key, e.message)
                slot.w.terminate()
                slot.w = this.worker()
                slot.busy = false
                Object.assign(t, { state: 'error', error: 'the worker crashed' })
                this.pump()
                this.updateStatus()
            }
            slot.w.postMessage({ id, x: t.x, y: t.y, z: TILE_Z })
        }
    }

    // Workers ask the page for building tiles so each one is downloaded once (src/buildings.ts).
    private sendBuildings(w: Worker, m: { rid: number; z: number; x: number; y: number }) {
        buildingTile(m.z, m.x, m.y).then(
            (list) => w.postMessage({ type: 'buildings', rid: m.rid, list }),
            (err) => w.postMessage({ type: 'buildings', rid: m.rid, error: String(err?.message ?? err) }),
        )
    }

    private updateStatus() {
        const all = [...this.tiles.values()]
        const done = all.filter((t) => t.state === 'done').length
        const busy = all.filter((t) => t.state === 'loading' || t.state === 'queued').length
        const errored = all.filter((t) => t.state === 'error')
        const jobs = all
            .filter((t) => t.state === 'loading')
            .map((t) => ({ stage: t.stage ?? '', seconds: Math.round((Date.now() - (t.started ?? Date.now())) / 1000) }))
        this.set({
            status: { busy, done, tooMany: this.tooMany, error: errored.length ? `${errored.length} area${errored.length > 1 ? 's' : ''} didn't load (${errored[0].error})` : undefined },
            jobs,
        })
        clearTimeout(this.statusTimer)
        if (busy) this.statusTimer = window.setTimeout(() => this.updateStatus(), 1000)
        if (!busy && errored.length) for (const t of errored) this.tiles.delete(t.key) // retried on next pan
    }

    // ------------------------------------------------------------ rendering

    // Redrawing re-sends every road to the map, so batch tile arrivals into at most two redraws a second.
    // Sliders never come through here: they only swap the layer filters (setWeights).
    private render() {
        if (this.renderTimer == null)
            this.renderTimer = window.setTimeout(() => {
                this.renderTimer = null
                this.draw()
            }, 500)
    }
    private draw() {
        const seen = new Set<number>()
        this.features = []
        for (const t of this.tiles.values())
            if (t.state === 'done' && t.roads)
                for (const f of t.roads) {
                    if (seen.has(f.properties.id)) continue
                    seen.add(f.properties.id)
                    this.features.push(f)
                }
        finalize(this.features, this.snap.weights, ([lon, lat]) => this.tiles.get(tileKey(lon2x(lon), lat2y(lat)))?.state === 'done')
        ;(this.map.getSource('roads') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: this.features as never })
        for (const k of [0, 1, 2]) if (this.map.getLayer(`r${k}`)) this.map.setFilter(`r${k}`, ['==', ['get', 'k'], k])
        const km: [number, number, number] = [0, 0, 0]
        for (const f of this.features) km[f.properties.k ?? 0] += f.properties.l / 1000
        // Keep an open card in step with the final classes.
        const card = this.snap.card && this.features.find((f) => f.properties.id === this.snap.card!.road.id)
        this.set({ miles: km.map((v) => v * 0.621371) as [number, number, number], ...(card ? { card: { ...this.snap.card!, road: { ...card.properties } } } : {}) })
    }

    // ------------------------------------------------------------ places and roads

    /** Fit a place with at least ~5 km around it; zoom into the middle of big places until they fit the area limit. */
    fitPlace(s: number, w: number, n: number, e: number) {
        const pad = Math.max(0, 0.03 - (n - s) / 2)
        this.map.fitBounds(
            [
                [w - pad, s - pad],
                [e + pad, n + pad],
            ],
            { padding: this.narrow ? 20 : { top: 40, bottom: 40, left: 360, right: 40 }, maxZoom: 14, animate: false },
        )
        for (let i = 0; i < 20 && (this.wanted(), this.tooMany); i++) this.map.setZoom(this.map.getZoom() + 0.25)
        this.refresh()
    }

    /** Roads already loaded whose name contains the query, longest first. */
    searchRoads(text: string): RoadHit[] {
        const q = text.trim().toLowerCase()
        if (q.length < 2) return []
        const byName = new Map<string, Feature[]>()
        for (const f of this.features) {
            const n = f.properties.n
            if (n && n.toLowerCase().includes(q)) byName.has(n) ? byName.get(n)!.push(f) : byName.set(n, [f])
        }
        const LABEL = ['Bad', 'OK', 'Great']
        return [...byName.entries()]
            .map(([name, fs]) => {
                const meters = fs.reduce((t, f) => t + f.properties.l, 0)
                const best = fs.reduce((a, f) => (f.properties.l > a.properties.l ? f : a))
                const shown = [0, 0, 0]
                for (const f of fs) shown[f.properties.k ?? 0] += f.properties.l
                const k = shown.indexOf(Math.max(...shown))
                let w = 180, s = 90, e = -180, n = -90
                for (const f of fs)
                    for (const [lon, lat] of f.geometry.coordinates) {
                        w = Math.min(w, lon)
                        e = Math.max(e, lon)
                        s = Math.min(s, lat)
                        n = Math.max(n, lat)
                    }
                const miles = meters / 1609.344
                return { name, detail: `Road on the map · ${miles.toFixed(1)} mi · mostly ${LABEL[k]}`, miles, k, bounds: [w, s, e, n] as [number, number, number, number], road: { ...best.properties } }
            })
            .sort((a, b) => b.miles - a.miles)
            .slice(0, 4)
    }

    /** Fit a loaded road on screen, highlight all of it, and pin its card. */
    focusRoad(hit: RoadHit) {
        const [w, s, e, n] = hit.bounds
        this.map.fitBounds(
            [
                [w, s],
                [e, n],
            ],
            { padding: this.narrow ? 40 : { top: 60, bottom: 60, left: 380, right: 380 }, maxZoom: 15, animate: false },
        )
        this.map.setFilter('hl', ['==', ['get', 'n'], hit.name])
        this.set({ card: { road: hit.road, pinned: true } })
        this.refresh()
    }

    private pick(point: { x: number; y: number }, pad: number): Road | null {
        const layers = ['r2', 'r1', 'r0'].filter((id) => this.map.getLayoutProperty(id, 'visibility') !== 'none')
        const hits = this.map.queryRenderedFeatures(
            [
                [point.x - pad, point.y - pad],
                [point.x + pad, point.y + pad],
            ],
            { layers },
        )
        return hits.length ? (hits[0].properties as Road) : null
    }

    private showCard(road: Road | null, pinned = false) {
        this.map.setFilter('hl', ['==', ['id'], road ? road.id : -1])
        this.set({ card: road ? { road, pinned } : null })
    }

    closeCard() {
        this.showCard(null)
    }

    // Hovering previews a road; clicking one pins its card (hover stops changing it) until it's closed.
    private wireInteraction() {
        const hoverable = matchMedia('(hover: hover)').matches
        if (hoverable)
            this.map.on('mousemove', (e: MapMouseEvent) => {
                if (!this.map.getLayer('r0')) return
                const road = this.pick(e.point, 4)
                this.map.getCanvas().style.cursor = road ? 'pointer' : ''
                if (this.snap.card?.pinned) return
                if ((road?.id ?? null) !== (this.snap.card?.road.id ?? null)) this.showCard(road)
            })
        this.map.on('click', (e: MapMouseEvent) => {
            if (!this.map.getLayer('r0')) return
            const road = this.pick(e.point, this.narrow ? 12 : 5)
            if (road) this.showCard(road, true)
        })
    }

    async clearCache() {
        await idb('readwrite', (s) => s.clear())
        for (const [k, t] of this.tiles) if (t.state === 'done' || t.state === 'error') this.tiles.delete(k)
        this.render()
        this.refresh()
    }

    /** Photon search (OSM-based, made for search-as-you-type), biased toward the current view. */
    async search(text: string, signal: AbortSignal): Promise<Place[]> {
        const c = this.map.getCenter()
        const r = await fetch(
            `https://photon.komoot.io/api/?q=${encodeURIComponent(text)}&limit=6&lang=en&lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}`,
            { signal },
        )
        const d = await r.json()
        return d.features.map((f: { properties: Record<string, string> & { extent?: [number, number, number, number] }; geometry: { coordinates: [number, number] } }) => {
            const p = f.properties
            const [lon, lat] = f.geometry.coordinates
            const street = p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street
            const name = p.name || street || p.city || p.postcode || 'Unnamed place'
            const detail = [p.name && street !== name ? street : null, p.city !== name ? p.city : null, p.state, p.countrycode !== 'US' ? p.country : null]
                .filter(Boolean)
                .join(', ')
            return { name, detail, lat, lon, extent: p.extent }
        })
    }

    goTo(place: Place) {
        if (place.extent) {
            const [w, n, e, s] = place.extent
            this.fitPlace(s, w, n, e)
        } else this.fitPlace(place.lat, place.lon, place.lat, place.lon)
    }

    destroy() {
        this.pool.forEach((s) => s.w.terminate())
        this.map.remove()
    }
}
