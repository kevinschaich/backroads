// Turns per-segment classes into what the map shows, using how segments connect, which a per-road GPU expression
// can't see:
// - Runs: each segment is scored on the ~mile of road around it, so neighbors see slightly different windows and a
//   road near a threshold flickers between classes. Any run of OK/Great shorter than RULES.min_length_m along the
//   same named road becomes Bad.
// - Dead ends: a residential road only counts as a remote backroad (OK/Great) if both its ends meet another road.
//   Twisty subdivision streets that dead-end in the hills aren't drives.
// Both skip anything that reaches an area that isn't loaded yet, where a road only looks like it stops.
import { classify, RULES, type Road, type Verdict, type Weights } from './scoring'

export type Line = { properties: Road & Partial<Verdict>; geometry: { coordinates: number[][] } }

const key = (c: number[]) => `${c[0].toFixed(5)},${c[1].toFixed(5)}`

export function finalize(lines: Line[], weights: Weights, loaded: (lonLat: number[]) => boolean) {
    // How many segments touch each endpoint, across every road.
    const degree = new Map<string, number>()
    const open = new Set<string>() // endpoints in areas that aren't loaded
    const ends = lines.map((l) => {
        const c = l.geometry.coordinates
        const e: [string, string] = [key(c[0]), key(c[c.length - 1])]
        if (!loaded(c[0])) open.add(e[0])
        if (!loaded(c[c.length - 1])) open.add(e[1])
        for (const k of e) degree.set(k, (degree.get(k) ?? 0) + 1)
        return e
    })
    const verdicts = lines.map((l) => classify(l.properties, weights))

    // Same-name roads: their segments, and which ones meet at each endpoint.
    const byName = new Map<string, number[]>()
    lines.forEach((l, i) => {
        const n = l.properties.n
        if (!n) return
        byName.has(n) ? byName.get(n)!.push(i) : byName.set(n, [i])
    })

    for (const idx of byName.values()) {
        const at = new Map<string, number[]>()
        for (const i of idx) for (const k of ends[i]) at.has(k) ? at.get(k)!.push(i) : at.set(k, [i])
        const seen = new Set<number>()
        // Walk each run of connected segments that are all shown (OK or Great).
        for (const start of idx) {
            if (seen.has(start) || verdicts[start].k === 0) continue
            const run: number[] = []
            const stack = [start]
            seen.add(start)
            while (stack.length) {
                const i = stack.pop()!
                run.push(i)
                for (const k of ends[i])
                    for (const j of at.get(k) ?? [])
                        if (!seen.has(j) && verdicts[j].k > 0) {
                            seen.add(j)
                            stack.push(j)
                        }
            }
            const length = run.reduce((t, i) => t + lines[i].properties.l, 0)
            const reachesUnloaded = run.some((i) => ends[i].some((k) => open.has(k)))
            if (length < RULES.min_length_m && !reachesUnloaded) for (const i of run) verdicts[i] = { ...verdicts[i], k: 0, r: 'short' }
        }
        // Dead-end check for remote residential roads: the road's outer ends must meet some other road.
        const outer = [...at.entries()].filter(([, segs]) => segs.length === 1).map(([k]) => k)
        const deadEnd = outer.some((k) => (degree.get(k) ?? 0) <= 1 && !open.has(k))
        if (deadEnd)
            for (const i of idx)
                if (verdicts[i].r === 'backroad' || verdicts[i].r === 'backroad_twisty') verdicts[i] = { ...verdicts[i], k: 0, r: 'dead_end' }
    }

    // Unnamed roads aren't grouped, so check each one's own ends.
    lines.forEach((l, i) => {
        const r = verdicts[i].r
        if (!l.properties.n && (r === 'backroad' || r === 'backroad_twisty') && ends[i].some((k) => (degree.get(k) ?? 0) <= 1 && !open.has(k)))
            verdicts[i] = { ...verdicts[i], k: 0, r: 'dead_end' }
    })

    lines.forEach((l, i) => Object.assign(l.properties, verdicts[i]))
}
