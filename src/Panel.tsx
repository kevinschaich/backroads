import {
    Button,
    Byline,
    Checkbox,
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
    Label,
    Separator,
    Slider,
} from '@kevinschaich/components'
import { BasemapTabs, MapPanel, PlaceSearch } from '@kevinschaich/components/map'
import { ChevronDown, Route } from 'lucide-react'
import type { Engine, Snapshot } from './engine'
import { COLORS, DEFAULT_WEIGHTS, SLIDERS } from './scoring'

const LEGEND = [
    { k: 2, label: 'Great', hint: 'curves, hills, open land' },
    { k: 1, label: 'OK', hint: 'plain roads, open freeways' },
    { k: 0, label: 'Bad', hint: 'lights, strip malls, neighborhoods' },
]

export function Panel({ engine, snap }: { engine: Engine; snap: Snapshot }) {
    return (
        <MapPanel title="Backroads" description="Pan anywhere to find roads worth driving.">
            {/* Loaded roads first (choosing one fits it, highlights it and pins its card), then places. */}
            <PlaceSearch
                placeholder="Search a road, town, address or ZIP"
                featuresHeading="On the map"
                searchFeatures={(q) =>
                    engine.searchRoads(q).map((r, i) => ({ key: String(i), label: r.name, detail: r.detail, icon: <Route />, onSelect: () => engine.focusRoad(r) }))
                }
                onPlace={(p) => engine.goTo(p)}
            />
            <Legend engine={engine} snap={snap} />
            <Status snap={snap} />
            <Separator />
            <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">Basemap</span>
                <BasemapTabs />
            </div>
            <Separator />
            <Tune engine={engine} snap={snap} />
            <Separator />
            <Byline repo="kevinschaich/backroads" />
        </MapPanel>
    )
}

function Legend({ engine, snap }: { engine: Engine; snap: Snapshot }) {
    return (
        <div className="flex flex-col gap-2.5">
            {LEGEND.map(({ k, label, hint }) => (
                <Label key={k} className="cursor-pointer gap-2.5 font-normal select-none">
                    <Checkbox checked={!snap.hidden.includes(k)} onCheckedChange={(on) => engine.setHidden(k, !on)} />
                    <span className="h-1.5 w-5 shrink-0 rounded-full" style={{ background: COLORS[k] }} />
                    <span className="min-w-0 flex-1">
                        <span className="font-medium">{label}</span>{' '}
                        <span className="text-muted-foreground max-sm:hidden">{hint}</span>
                    </span>
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">
                        {snap.miles[k] ? `${Math.round(snap.miles[k]).toLocaleString()} mi` : ''}
                    </span>
                </Label>
            ))}
        </div>
    )
}

function Status({ snap }: { snap: Snapshot }) {
    const { busy, done, error, tooMany } = snap.status
    const text = busy
        ? `${done} of ${done + busy} areas ready (each ~5 km)`
        : error
          ? `${error}. Pan to retry.`
          : tooMany
            ? 'Zoom in to load roads here'
            : `${done} area${done === 1 ? '' : 's'} scored`
    return (
        <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
                <span className={`size-2 shrink-0 rounded-full ${busy ? 'animate-pulse bg-blue-500' : error ? 'bg-destructive' : 'bg-muted-foreground/40'}`} />
                {text}
            </div>
            {snap.jobs.length > 0 && (
                <ul className="ml-4 flex flex-col gap-0.5 text-xs">
                    {snap.jobs.map((j, i) => (
                        <li key={i} className="flex justify-between gap-2">
                            <span className="truncate">{j.stage}</span>
                            <span className="font-mono tabular-nums">{j.seconds}s</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

function Tune({ engine, snap }: { engine: Engine; snap: Snapshot }) {
    return (
        <Collapsible>
            <CollapsibleTrigger className="group flex w-full items-center justify-between text-sm font-medium">
                Tune the score
                <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-4 pt-3">
                <p className="text-sm text-muted-foreground">
                    How much each one counts toward a road's score out of 100. Slide right to care more, all the way left to ignore it.
                </p>
                {SLIDERS.map(([k, label, max, sign]) => {
                    const v = Math.abs(snap.weights[k])
                    return (
                        <div key={k} className="flex flex-col gap-2">
                            <div className="flex justify-between text-sm">
                                <span>{label}</span>
                                <span className="font-mono text-xs text-muted-foreground tabular-nums">{v ? `${sign > 0 ? '+' : '−'}${v}` : 'off'}</span>
                            </div>
                            <Slider
                                value={v}
                                max={max}
                                step={1}
                                onValueChange={(n) => engine.setWeights({ ...snap.weights, [k]: sign * (Array.isArray(n) ? n[0] : n) })}
                            />
                        </div>
                    )
                })}
                <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => engine.setWeights(DEFAULT_WEIGHTS, true)}>
                        Reset weights
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => engine.clearCache()}>
                        Clear cache
                    </Button>
                </div>
            </CollapsibleContent>
        </Collapsible>
    )
}
