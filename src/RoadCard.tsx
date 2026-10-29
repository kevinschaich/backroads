import { Badge, Button, Card, CardAction, CardContent, CardHeader, CardTitle } from '@kevinschaich/components'
import { ArrowUpRight, X } from 'lucide-react'
import type { Engine, Snapshot } from './engine'
import { CLASS, classify, COLORS, FACTORS, REASONS, type Weights } from './scoring'

const n1 = (v: number) => Math.round(v * 10) / 10

/** The hovered or pinned road: its class, why, and every measurement behind it. */
export function RoadCard({ engine, card, weights }: { engine: Engine; card: NonNullable<Snapshot['card']>; weights: Weights }) {
    const p = card.road
    // The final class (after the connectivity pass) rides on the road; the score and factors follow the live weights.
    const live = classify(p, weights)
    const { sc, f } = live
    const k = (p as { k?: 0 | 1 | 2 }).k ?? live.k
    const r = (p as { r?: string }).r ?? live.r
    const why = r === 'score' ? (f.length ? f.map((x) => FACTORS[x]).join(', ') : 'nothing stands out') : REASONS[r]
    const rows: [string, string][] = [
        ['Speed limit', p.s != null ? `${p.s} mph${p.ss === 'street' ? ' (on this street)' : ''}` : 'not in data'],
        ['Stretch', p.cl != null ? `${n1(p.cl / 1609.344)} mi` : '—'],
        ['Lights & stops', `${n1(p.st)} / mi`],
        ['Turn-offs', `${n1(p.a)} / mi`],
        ['Buildings', `${Math.round(p.b)} / mi`],
        ['Commercial', `${Math.round(p.cm * 100)}% of frontage`],
        ['Open land', p.nt == null ? 'unavailable' : `${Math.round(p.nt * 100)}% of frontage`],
        ['Curves', `${Math.round(p.c)}° / km`],
        ['Hairpins', p.hp != null ? `${n1(p.hp)} / mi` : '—'],
        ['Hills', `${Math.round(p.e)} m / km`],
    ]

    return (
        <Card
            size="sm"
            role="dialog"
            aria-live="polite"
            className="fixed z-20 max-h-[60%] gap-3 overflow-auto max-sm:inset-x-2 max-sm:bottom-[calc(8px+env(safe-area-inset-bottom))] sm:top-3 sm:right-14 sm:w-80"
        >
            <CardHeader>
                <CardTitle className="text-base">{p.n || `Unnamed ${p.h.replace(/_/g, ' ')} road`}</CardTitle>
                {card.pinned && (
                    <CardAction>
                        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => engine.closeCard()}>
                            <X />
                        </Button>
                    </CardAction>
                )}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                    <Badge className="text-zinc-950" style={{ background: COLORS[k] }}>
                        {CLASS[k]}
                    </Badge>
                    {r === 'score' && (
                        <Badge variant="outline" className="font-mono">
                            score {sc}/100
                        </Badge>
                    )}
                </div>
                <p className="text-sm">
                    {why.charAt(0).toUpperCase() + why.slice(1)}
                    {why.endsWith('.') ? '' : '.'}
                </p>
                <dl className="grid grid-cols-[auto_1fr] border-t text-sm">
                    {rows.map(([label, value]) => (
                        <div key={label} className="contents">
                            <dt className="border-b py-1.5 text-muted-foreground">{label}</dt>
                            <dd className="border-b py-1.5 text-right font-medium tabular-nums">{value}</dd>
                        </div>
                    ))}
                </dl>
                <a
                    href={`https://www.openstreetmap.org/way/${p.id}`}
                    target="_blank"
                    rel="noopener"
                    className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                    Open in OpenStreetMap <ArrowUpRight className="size-3.5" />
                </a>
                {!card.pinned && <p className="text-xs text-muted-foreground max-sm:hidden">Click the road to keep this open.</p>}
            </CardContent>
        </Card>
    )
}
