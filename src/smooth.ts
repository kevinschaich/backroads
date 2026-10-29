// Turns per-segment classes into what the map shows, using how segments connect (which a per-road GPU expression
// can't see). Rule: every colored stretch on the map is at least RULES.min_length_m of continuous road.
//
// A "road" is segments that continue into each other: the same name through an intersection, or for unnamed
// roads, two segments meeting with nothing else there. Along each road, any run of one class shorter than the
// minimum takes the class of the road around it (a 200 m yellow blip on a bad road becomes bad; a 200 m gap in a
// great road becomes great). A short road with nothing around it becomes bad.
//
// Also: a residential road only counts as a remote backroad if both its ends meet another road; twisty
// subdivision streets that dead-end in the hills aren't drives.
//
// Runs that reach an area that isn't loaded yet are left alone, since the road may continue there.
import { classify, RULES, type Road, type Verdict, type Weights } from './scoring'

export type Line = { properties: Road & Partial<Verdict>; geometry: { coordinates: number[][] } }

const key = (c: number[]) => `${c[0].toFixed(5)},${c[1].toFixed(5)}`

export function finalize(lines: Line[], weights: Weights, loaded: (lonLat: number[]) => boolean) {
    const at = new Map<string, number[]>() // endpoint -> segments touching it
    const open = new Set<string>() // endpoints in areas that aren't loaded
    const ends = lines.map((l, i) => {
        const c = l.geometry.coordinates
        const e: [string, string] = [key(c[0]), key(c[c.length - 1])]
        for (const k of e) at.has(k) ? at.get(k)!.push(i) : at.set(k, [i])
        if (!loaded(c[0])) open.add(e[0])
        if (!loaded(c[c.length - 1])) open.add(e[1])
        return e
    })
    const v: Verdict[] = lines.map((l) => classify(l.properties, weights))
    const name = (i: number) => lines[i].properties.n
    const len = (i: number) => lines[i].properties.l

    // Dead-end backroads: a remote residential road whose outer end meets nothing.
    const deadEnd = (i: number) => ends[i].some((k) => at.get(k)!.length === 1 && !open.has(k))
    const byName = new Map<string, number[]>()
    lines.forEach((_, i) => {
        const n = name(i)
        if (n) byName.has(n) ? byName.get(n)!.push(i) : byName.set(n, [i])
    })
    for (const idx of byName.values())
        if (idx.some(deadEnd))
            for (const i of idx) if (v[i].r === 'backroad' || v[i].r === 'backroad_twisty') v[i] = { ...v[i], k: 0, r: 'dead_end' }
    lines.forEach((_, i) => {
        if (!name(i) && (v[i].r === 'backroad' || v[i].r === 'backroad_twisty') && deadEnd(i)) v[i] = { ...v[i], k: 0, r: 'dead_end' }
    })

    // Segments that continue each other as one road.
    const next = (i: number) =>
        ends[i].flatMap((k) => {
            const segs = at.get(k)!
            const n = name(i)
            return n ? segs.filter((j) => j !== i && name(j) === n) : segs.length === 2 ? segs.filter((j) => j !== i && !name(j)) : []
        })

    // Absorb short runs into the road around them, shortest first, until none are left.
    for (let pass = 0; pass < 50; pass++) {
        const run = new Array<number>(lines.length).fill(-1)
        const runs: { segs: number[]; k: number; length: number; open: boolean }[] = []
        for (let s = 0; s < lines.length; s++) {
            if (run[s] !== -1) continue
            const id = runs.length
            const segs = [s]
            run[s] = id
            for (let q = 0; q < segs.length; q++)
                for (const j of next(segs[q]))
                    if (run[j] === -1 && v[j].k === v[s].k) {
                        run[j] = id
                        segs.push(j)
                    }
            runs.push({
                segs,
                k: v[s].k,
                length: segs.reduce((t, i) => t + len(i), 0),
                open: segs.some((i) => ends[i].some((k) => open.has(k))),
            })
        }
        // Each short run with road around it takes the class of its longest neighbor; neighbors of a changed run
        // wait for the next pass, so merges cascade from the shortest pieces up.
        let changed = false
        const order = runs.map((_, id) => id).sort((a, b) => runs[a].length - runs[b].length)
        const touched = new Set<number>()
        for (const id of order) {
            const r = runs[id]
            if (r.length >= RULES.min_length_m) break
            if (r.open || touched.has(id)) continue
            const around = new Map<number, number>() // neighbor run -> its length
            for (const i of r.segs) for (const j of next(i)) if (run[j] !== id) around.set(run[j], runs[run[j]].length)
            let k: 0 | 1 | 2
            if (around.size) {
                const [best] = [...around.entries()].sort((a, b) => b[1] - a[1])[0]
                k = runs[best].k as 0 | 1 | 2
                for (const n of around.keys()) touched.add(n)
            } else k = 0 // a short road on its own
            if (k === r.k) continue
            for (const i of r.segs) v[i] = { ...v[i], k, r: k === 0 ? 'short' : r.k === 0 ? 'continues' : v[i].r }
            touched.add(id)
            changed = true
        }
        if (!changed) break
    }

    lines.forEach((l, i) => Object.assign(l.properties, v[i]))
}
