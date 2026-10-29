import {
    Button,
    Byline,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Checkbox,
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
    Separator,
    Slider,
    Segmented,
    SegmentedItem,
} from '@kevinschaich/components'
import { ChevronDown } from 'lucide-react'
import type { Basemap, Engine, Snapshot } from './engine'
import { COLORS, DEFAULT_WEIGHTS, SLIDERS } from './scoring'
import { Search } from './Search'

const LEGEND = [
    { k: 2, label: 'Great', hint: 'curves, hills, open land' },
    { k: 1, label: 'OK', hint: 'plain roads, open freeways' },
    { k: 0, label: 'Bad', hint: 'lights, strip malls, neighborhoods' },
]

export function Panel({ engine, snap }: { engine: Engine; snap: Snapshot }) {
    return (
        <Card
            size="sm"
            className="fixed z-10 max-h-[46%] gap-0 overflow-auto py-0 max-sm:inset-x-2 max-sm:bottom-[calc(8px+env(safe-area-inset-bottom))] sm:top-3 sm:left-3 sm:max-h-[calc(100%-24px)] sm:w-80"
        >
            <CardHeader className="gap-1 pt-4">
                <CardTitle>Backroads</CardTitle>
                <CardDescription>Pan anywhere. Roads are fetched and scored in your browser from open data.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-3 pb-4">
                <Search engine={engine} />
                <Legend engine={engine} snap={snap} />
                <Status snap={snap} />
                <Separator />
                <div className="flex flex-col gap-2">
                    <span className="text-sm font-medium">Basemap</span>
                    <Segmented value={snap.basemap} onValueChange={(v: Basemap) => engine.setBasemap(v)}>
                        <SegmentedItem value="dark">Dark</SegmentedItem>
                        <SegmentedItem value="streets">Streets</SegmentedItem>
                        <SegmentedItem value="satellite">Satellite</SegmentedItem>
                        <SegmentedItem value="none">None</SegmentedItem>
                    </Segmented>
                </div>
                <Separator />
                <Tune engine={engine} snap={snap} />
                <Separator />
                <Byline repo="kevinschaich/backroads" />
            </CardContent>
        </Card>
    )
}

function Legend({ engine, snap }: { engine: Engine; snap: Snapshot }) {
    return (
        <div className="flex flex-col gap-2.5">
            {LEGEND.map(({ k, label, hint }) => (
                <label key={k} className="flex cursor-pointer items-center gap-2.5 text-sm select-none">
                    <Checkbox checked={!snap.hidden.includes(k)} onCheckedChange={(on) => engine.setHidden(k, !on)} />
                    <span className="h-1.5 w-5 shrink-0 rounded-full" style={{ background: COLORS[k] }} />
                    <span className="min-w-0 flex-1">
                        <span className="font-medium">{label}</span>{' '}
                        <span className="text-muted-foreground max-sm:hidden">{hint}</span>
                    </span>
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">
                        {snap.miles[k] ? `${Math.round(snap.miles[k]).toLocaleString()} mi` : ''}
                    </span>
                </label>
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
