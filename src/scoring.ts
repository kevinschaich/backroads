// How roads are scored. classify() (road card, mile totals) and classExpr() (map colors, as a MapLibre expression
// so sliders recolor on the GPU without re-sending data) implement the same rules: keep them in sync.

/** One road's measurements over its ~1 mile corridor, as the worker reports them. */
export type Road = {
    id: number
    h: string // OSM highway type
    n?: string // name or ref
    l: number // this way's length, m
    cl?: number // corridor length (same-name stretch), m; missing in old caches
    c: number // curves, °/km
    e: number // hills, m climbed + descended per km
    st: number // lights and stops per mile
    a: number // turn-offs per mile
    b: number // buildings per mile
    cm: number // share of frontage that's commercial
    nt: number | null // share of frontage that's open land
    hp?: number // hairpins per mile
    de?: number // ends that meet no other road (0-2), from OSM's node network
    s?: number // speed limit, mph
    ss?: 'posted' | 'street'
}

export type Weights = Record<Factor, number>
export type Factor = 'curves' | 'hills' | 'nature' | 'stops' | 'access' | 'buildings' | 'commercial' | 'hairpins'

export const RULES = {
    slow_below_mph: 30,
    built_up_buildings_per_mi: 100,
    fast_above_mph: 55,
    remote_max_buildings_per_mi: 25,
    remote_max_stops_per_mi: 1,
    remote_max_commercial: 0.1,
    great_min_score: 62,
    ok_min_score: 40,
    // Every colored stretch on the map is at least this long; shorter pieces take the class of the road around them.
    min_length_m: 1000,
}

/** Points each factor can add or take away, and where it maxes out. */
export const SCORE = {
    base: 50,
    curves: { points: 25, full_at: 200 },
    hills: { points: 12, full_at: 40 },
    nature: { points: 15 },
    stops: { points: -40, full_at: 4 },
    access: { points: -20, free: 4, full_at: 24 },
    buildings: { points: -20, full_at: 80 },
    commercial: { points: -20 },
    // Off by default: tight switchbacks are fun in a small car, not in a big one.
    hairpins: { points: 0, full_at: 2 },
}

/** Slider order, label, max points. Positive factors are "Prefer", negative "Avoid"; 0 ignores one. */
export const SLIDERS: [Factor, string, number, 1 | -1][] = [
    ['curves', 'Prefer curves', 50, 1],
    ['hills', 'Prefer hills', 30, 1],
    ['nature', 'Prefer open land', 30, 1],
    ['stops', 'Avoid lights & stops', 60, -1],
    ['access', 'Avoid turn-offs', 40, -1],
    ['buildings', 'Avoid buildings', 40, -1],
    ['commercial', 'Avoid commercial', 40, -1],
    ['hairpins', 'Avoid hairpins', 40, -1],
]

export const DEFAULT_WEIGHTS = Object.fromEntries(SLIDERS.map(([k]) => [k, SCORE[k].points])) as Weights

export const CLASS = ['Bad', 'OK', 'Great'] as const
export const COLORS = ['#ff4646', '#ffd60a', '#2bff88'] as const

export const REASONS: Record<string, string> = {
    freeway_open: 'Freeway through open country.',
    freeway_built: 'Freeway through built-up land.',
    ramp: 'Highway ramp.',
    neighborhood: 'Residential street in a built-up area.',
    backroad: 'Quiet road with few houses, but nothing special to drive.',
    backroad_great: 'Quiet rural road: few houses, no lights, open country.',
    short: 'Too short a stretch to be worth driving to.',
    dead_end: 'Quiet road, but a dead end.',
    continues: 'A short piece of a longer good stretch.',
}
export const FACTORS: Record<string, string> = {
    '+curves': 'curvy',
    '+hills': 'hilly',
    '+nature': 'open land or forest alongside',
    '-stops': 'frequent lights or stop signs',
    '-access': 'lots of driveways and side streets',
    '-buildings': 'built up on both sides',
    '-commercial': 'commercial frontage',
    '-hairpins': 'tight hairpin turns',
}

const FREEWAYS = ['motorway']
const RESIDENTIAL = ['residential', 'living_street']
// Freeways have no lights or driveways and rarely hairpins; judge them only on what's alongside.
const FREEWAY_FACTORS: Factor[] = ['curves', 'hills', 'nature', 'buildings', 'commercial']

const min1 = (v: number) => Math.min(v, 1)

function parts(p: Road, w: Weights): Record<Factor, number> {
    const s = SCORE
    return {
        curves: w.curves * min1(p.c / s.curves.full_at),
        hills: w.hills * min1(p.e / s.hills.full_at),
        nature: w.nature * (p.nt ?? 0),
        stops: w.stops * min1(p.st / s.stops.full_at),
        access: w.access * min1(Math.max(p.a - s.access.free, 0) / (s.access.full_at - s.access.free)),
        buildings: w.buildings * min1(p.b / s.buildings.full_at),
        commercial: w.commercial * p.cm,
        hairpins: w.hairpins * min1((p.hp ?? 0) / s.hairpins.full_at),
    }
}

export type Verdict = { k: 0 | 1 | 2; r: string; sc: number; f: string[] }

export function classify(p: Road, w: Weights): Verdict {
    const R = RULES
    const all = parts(p, w)
    const freeway = FREEWAYS.includes(p.h) || (p.s != null && p.s > R.fast_above_mph)
    const used = freeway ? FREEWAY_FACTORS : (Object.keys(all) as Factor[])
    const score = Math.max(0, Math.min(100, SCORE.base + used.reduce((t, k) => t + all[k], 0)))
    const f = used
        .filter((k) => Math.abs(all[k]) >= 4)
        .sort((a, b) => Math.abs(all[b]) - Math.abs(all[a]))
        .slice(0, 3)
        .map((k) => (all[k] > 0 ? '+' : '-') + k)
    // Remote means few houses AND no lights or shops: campuses and office parks have few (big) buildings.
    const remote = p.b <= R.remote_max_buildings_per_mi && p.st <= R.remote_max_stops_per_mi && p.cm <= R.remote_max_commercial
    let k: 0 | 1 | 2, r: string
    if (p.h.endsWith('_link')) [k, r] = [0, 'ramp']
    else if (freeway) [k, r] = score >= R.ok_min_score ? [1, 'freeway_open'] : [0, 'freeway_built']
    else if (
        RESIDENTIAL.includes(p.h) ||
        (p.s != null && (p.s < R.slow_below_mph || (p.s === R.slow_below_mph && p.b >= R.built_up_buildings_per_mi)))
    )
        // OSM tags many rural roads "residential" too; a remote, named one is judged on its score like any road.
        [k, r] = remote && p.n && score >= R.great_min_score ? [2, 'backroad_great'] : remote ? [1, 'backroad'] : [0, 'neighborhood']
    else [k, r] = [score >= R.great_min_score ? 2 : score >= R.ok_min_score ? 1 : 0, 'score']
    // Stretches under the minimum count as Bad (hidden by default), however good they are.
    if ((p.cl ?? Infinity) < R.min_length_m && k > 0) [k, r] = [0, 'short']
    return { k, r, sc: Math.round(score), f }
}

type Expr = unknown[] | string | number | boolean

/** classify() as a MapLibre expression evaluating to 0, 1 or 2. */
export function classExpr(w: Weights): Expr {
    const s = SCORE
    const R = RULES
    const g = (k: string): Expr => ['get', k]
    const m1 = (x: Expr): Expr => ['min', x, 1]
    const speed: Expr = ['to-number', g('s')]
    const term: Record<Factor, Expr> = {
        curves: ['*', w.curves, m1(['/', g('c'), s.curves.full_at])],
        hills: ['*', w.hills, m1(['/', g('e'), s.hills.full_at])],
        nature: ['*', w.nature, ['coalesce', g('nt'), 0]],
        stops: ['*', w.stops, m1(['/', g('st'), s.stops.full_at])],
        access: ['*', w.access, m1(['/', ['max', ['-', g('a'), s.access.free], 0], s.access.full_at - s.access.free])],
        buildings: ['*', w.buildings, m1(['/', g('b'), s.buildings.full_at])],
        commercial: ['*', w.commercial, g('cm')],
        hairpins: ['*', w.hairpins, m1(['/', ['coalesce', g('hp'), 0], s.hairpins.full_at])],
    }
    const score = ['+', s.base, ...(Object.keys(term) as Factor[]).map((k) => term[k])]
    const freewayScore = ['+', s.base, ...FREEWAY_FACTORS.map((k) => term[k])]
    const freeway: Expr = ['any', ['in', g('h'), ['literal', FREEWAYS]], ['all', ['has', 's'], ['>', speed, R.fast_above_mph]]]
    const remote: Expr = [
        'all',
        ['<=', g('b'), R.remote_max_buildings_per_mi],
        ['<=', g('st'), R.remote_max_stops_per_mi],
        ['<=', g('cm'), R.remote_max_commercial],
    ]
    const slow: Expr = [
        'any',
        ['in', g('h'), ['literal', RESIDENTIAL]],
        ['all', ['has', 's'], ['any', ['<', speed, R.slow_below_mph], ['all', ['==', speed, R.slow_below_mph], ['>=', g('b'), R.built_up_buildings_per_mi]]]],
    ]
    const base: Expr = [
        'case',
        // Ramps are never a drive in themselves, and at map scale they read as blips.
        ['in', '_link', g('h')], 0,
        freeway, ['case', ['>=', freewayScore, R.ok_min_score], 1, 0],
        slow, ['case', ['all', remote, ['has', 'n'], ['>=', score, R.great_min_score]], 2, remote, 1, 0],
        ['>=', score, R.great_min_score], 2,
        ['>=', score, R.ok_min_score], 1,
        0,
    ]
    const cl: Expr = ['coalesce', g('cl'), 1e9]
    return ['case', ['<', cl, R.min_length_m], 0, base]
}
