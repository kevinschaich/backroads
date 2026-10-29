import { Input } from '@kevinschaich/components'
import { MapPin, Route, Search as SearchIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import type { Engine, Place, RoadHit } from './engine'

type Hit = { kind: 'road'; hit: RoadHit } | { kind: 'place'; hit: Place }

/**
 * Search: roads already loaded on the map (instant, listed first; choosing one fits it, highlights it and pins its
 * card), then places with suggestions as you type (Photon), biased toward the current map view.
 */
export function Search({ engine }: { engine: Engine }) {
    const [text, setText] = useState('')
    const [roads, setRoads] = useState<RoadHit[]>([])
    const [places, setPlaces] = useState<Place[]>([])
    const [message, setMessage] = useState<string | null>(null)
    const [active, setActive] = useState(0)
    const ctrl = useRef<AbortController | null>(null)
    const timer = useRef<number | undefined>(undefined)
    const input = useRef<HTMLInputElement>(null)

    const hits: Hit[] = [...roads.map((hit) => ({ kind: 'road' as const, hit })), ...places.map((hit) => ({ kind: 'place' as const, hit }))]

    const close = () => {
        setRoads([])
        setPlaces([])
        setMessage(null)
    }
    const choose = (h: Hit) => {
        close()
        input.current?.blur()
        if (h.kind === 'road') engine.focusRoad(h.hit)
        else engine.goTo(h.hit)
    }
    const onChange = (value: string) => {
        setText(value)
        setActive(0)
        clearTimeout(timer.current)
        const q = value.trim()
        setRoads(engine.searchRoads(q))
        if (q.length < 3) {
            ctrl.current?.abort()
            setPlaces([])
            setMessage(null)
            return
        }
        timer.current = window.setTimeout(async () => {
            ctrl.current?.abort()
            ctrl.current = new AbortController()
            try {
                const list = await engine.search(q, ctrl.current.signal)
                setPlaces(list)
                setMessage(null)
            } catch (err) {
                if ((err as Error).name !== 'AbortError') {
                    setPlaces([])
                    setMessage("Place search isn't available right now")
                }
            }
        }, 250)
    }
    const open = hits.length > 0 || message !== null

    return (
        <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
                ref={input}
                type="search"
                value={text}
                placeholder="Search a road, town, address or ZIP"
                autoComplete="off"
                spellCheck={false}
                role="combobox"
                aria-expanded={open}
                aria-controls="search-results"
                aria-activedescendant={hits.length ? `hit-${active}` : undefined}
                className="h-9 pl-8"
                onChange={(e) => onChange(e.target.value)}
                onBlur={() => setTimeout(close, 100)}
                onKeyDown={(e) => {
                    if (e.key === 'ArrowDown' && hits.length) {
                        e.preventDefault()
                        setActive((active + 1) % hits.length)
                    } else if (e.key === 'ArrowUp' && hits.length) {
                        e.preventDefault()
                        setActive((active - 1 + hits.length) % hits.length)
                    } else if (e.key === 'Escape') {
                        close()
                        input.current?.blur()
                    } else if (e.key === 'Enter' && hits[active]) {
                        e.preventDefault()
                        choose(hits[active])
                    }
                }}
            />
            {open && (
                <ul id="search-results" role="listbox" className="mt-1.5 rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-md">
                    {hits.map((h, i) => {
                        const Icon = h.kind === 'road' ? Route : MapPin
                        return (
                            <li
                                key={`${h.kind}-${i}`}
                                id={`hit-${i}`}
                                role="option"
                                aria-selected={i === active}
                                className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 aria-selected:bg-accent hover:bg-accent"
                                onMouseDown={(e) => {
                                    e.preventDefault()
                                    choose(h)
                                }}
                            >
                                <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                                <span className="flex min-w-0 flex-col">
                                    <span>{h.hit.name}</span>
                                    {h.hit.detail && <span className="text-xs text-muted-foreground">{h.hit.detail}</span>}
                                </span>
                            </li>
                        )
                    })}
                    {message && <li className="px-2 py-1.5 text-muted-foreground">{message}</li>}
                </ul>
            )}
        </div>
    )
}
