// Overture building footprints, fetched once per z14 tile for all workers. Neighboring ~5 km areas (plus their
// margins) overlap the same tiles and load at the same time, so when each worker fetched its own, the same tile
// was downloaded several times at once. Workers now ask here: one download per tile, shared by everyone waiting
// on it, and cached in IndexedDB across visits.
//
// OSM is missing house footprints in many suburbs (whole subdivisions read 0 buildings/mi), so buildings come
// from Overture, which adds Microsoft and Google footprints. Read from its PMTiles archive by range request.
import { PMTiles } from 'pmtiles'

const OVERTURE_BUILDINGS = 'https://tiles.overturemaps.org/2026-10-21.0/buildings.pmtiles'
const MAX_IN_FLIGHT = 8

let archive: PMTiles | null = null
const inFlight = new Map<string, Promise<Float64Array>>()

/** Buildings in one z14 tile, as a flat [lat, lon, area m², ...] array. */
export function buildingTile(z: number, x: number, y: number): Promise<Float64Array> {
    const key = `${OVERTURE_BUILDINGS}/${z}/${x}/${y}`
    let p = inFlight.get(key)
    if (!p) {
        p = load(key, z, x, y).finally(() => inFlight.delete(key))
        inFlight.set(key, p)
    }
    return p
}

async function load(key: string, z: number, x: number, y: number) {
    const hit = await store<Float64Array>('readonly', (s) => s.get(key))
    if (hit) return hit
    const t = await limit(() => withRetry(() => (archive ??= new PMTiles(OVERTURE_BUILDINGS)).getZxy(z, x, y)))
    const list = t ? decode(t.data, z, x, y) : new Float64Array()
    store('readwrite', (s) => s.put(list, key))
    return list
}

// Overture's CDN drops some parallel range requests and answers 403/429 when a visitor asks too fast, so retry
// with backoff (much longer when throttled). pmtiles caches a failed header or directory fetch inside the archive
// object, so a retry starts from a fresh archive.
async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
    for (let i = 0; ; i++) {
        try {
            return await fn()
        } catch (err) {
            if (i >= tries - 1) throw err
            archive = null
            const throttled = /\b(403|429)\b/.test(String((err as Error)?.message))
            await new Promise((r) => setTimeout(r, (throttled ? 3000 : 400) * 2 ** i))
        }
    }
}

let slots = MAX_IN_FLIGHT
const waiting: (() => void)[] = []
async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (slots > 0) slots--
    else await new Promise<void>((r) => waiting.push(r))
    try {
        return await fn()
    } finally {
        const next = waiting.shift()
        if (next) next()
        else slots++
    }
}

// The cache is an optimization: if opening it stalls (another tab, a pending deletion), carry on without it.
const db: Promise<IDBDatabase | null> = new Promise((res) => {
    setTimeout(() => res(null), 2000)
    try {
        const req = indexedDB.open('backroads-overture', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('tiles')
        req.onsuccess = () => res(req.result)
        req.onerror = () => res(null)
        req.onblocked = () => res(null)
    } catch {
        res(null)
    }
})
async function store<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
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

/** Minimal Mapbox Vector Tile reader: [lat, lon, area m²] for each polygon in the "building" layer. */
function decode(buf: ArrayBuffer, z: number, x: number, y: number): Float64Array {
    const b = new Uint8Array(buf)
    const out: number[] = []
    let pos = 0
    const varint = () => {
        let v = 0, s = 1, c
        do {
            c = b[pos++]
            v += (c & 0x7f) * s
            s *= 128
        } while (c & 0x80)
        return v
    }
    const skip = (wt: number) => {
        if (wt === 0) varint()
        else if (wt === 1) pos += 8
        else if (wt === 2) {
            const L = varint()
            pos += L
        } else if (wt === 5) pos += 4
    }
    const zz = (n: number) => (n >>> 1) ^ -(n & 1)
    while (pos < b.length) {
        const tag = varint()
        if (tag >> 3 !== 3 || (tag & 7) !== 2) {
            skip(tag & 7)
            continue
        }
        const layerEnd = varint() + pos
        let name = ''
        let extent = 4096
        const geoms: [number, number][] = []
        while (pos < layerEnd) {
            const t = varint(), f = t >> 3
            if (f === 1) {
                const L = varint()
                name = new TextDecoder().decode(b.subarray(pos, pos + L))
                pos += L
            } else if (f === 5) extent = varint()
            else if (f === 2) {
                const featEnd = varint() + pos
                let type = 0
                let g: [number, number] | null = null
                while (pos < featEnd) {
                    const ft = varint(), ff = ft >> 3
                    if (ff === 3) type = varint()
                    else if (ff === 4) {
                        const L = varint()
                        g = [pos, pos + L]
                        pos += L
                    } else skip(ft & 7)
                }
                if (type === 3 && g) geoms.push(g)
            } else skip(t & 7)
        }
        if (name !== 'building') {
            pos = layerEnd
            continue
        }
        const save = pos, n2 = 2 ** z
        for (const [g0, g1] of geoms) {
            pos = g0
            let cx = 0, cy = 0, sx = 0, sy = 0, cnt = 0, area = 0
            let ring: [number, number][] = []
            const flush = () => {
                if (ring.length < 3) return
                let a = 0
                for (let i = 0; i < ring.length; i++) {
                    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length]
                    a += x1 * y2 - x2 * y1
                }
                area += a / 2 // outer rings and holes have opposite signs, so this nets out holes
                if (!cnt)
                    for (const [px, py] of ring) {
                        sx += px
                        sy += py
                        cnt++
                    }
            }
            while (pos < g1) {
                const cmd = varint(), id = cmd & 7, count = cmd >> 3
                if (id === 7) {
                    flush()
                    ring = []
                    continue
                }
                for (let i = 0; i < count; i++) {
                    cx += zz(varint())
                    cy += zz(varint())
                    if (id === 1) {
                        flush()
                        ring = []
                    }
                    ring.push([cx, cy])
                }
            }
            flush()
            if (!cnt) continue
            const lon = ((x + sx / cnt / extent) / n2) * 360 - 180
            const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + sy / cnt / extent)) / n2))) * 180) / Math.PI
            const m = (40075016 * Math.cos((lat * Math.PI) / 180)) / n2 / extent // meters per tile unit
            out.push(lat, lon, Math.abs(area) * m * m)
        }
        pos = Math.max(save, layerEnd)
    }
    return Float64Array.from(out)
}
