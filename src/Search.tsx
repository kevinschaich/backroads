import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@kevinschaich/components'
import { MapPin, Route } from 'lucide-react'
import { useRef, useState } from 'react'
import type { Engine, Place, RoadHit } from './engine'

/**
 * Search: roads already loaded on the map (listed first; choosing one fits it, highlights it and pins its card),
 * then places with suggestions as you type (Photon), biased toward the current map view.
 */
export function Search({ engine }: { engine: Engine }) {
    const [text, setText] = useState('')
    const [roads, setRoads] = useState<RoadHit[]>([])
    const [places, setPlaces] = useState<Place[]>([])
    const [message, setMessage] = useState<string | null>(null)
    const [focused, setFocused] = useState(false)
    const ctrl = useRef<AbortController | null>(null)
    const timer = useRef<number | undefined>(undefined)

    const reset = () => {
        setText('')
        setRoads([])
        setPlaces([])
        setMessage(null)
        ;(document.activeElement as HTMLElement | null)?.blur()
    }
    const onChange = (value: string) => {
        setText(value)
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
                setPlaces(await engine.search(q, ctrl.current.signal))
                setMessage(null)
            } catch (err) {
                if ((err as Error).name !== 'AbortError') {
                    setPlaces([])
                    setMessage("Place search isn't available right now")
                }
            }
        }, 250)
    }
    const open = focused && text.trim().length > 0

    return (
        <Command shouldFilter={false} className="h-auto overflow-visible bg-transparent p-0" onKeyDown={(e) => e.key === 'Escape' && reset()}>
            <CommandInput
                value={text}
                onValueChange={onChange}
                placeholder="Search a road, town, address or ZIP"
                onFocus={() => setFocused(true)}
                onBlur={() => setTimeout(() => setFocused(false), 150)}
            />
            {open && (
                <CommandList className="mt-1.5 rounded-lg border bg-popover shadow-md">
                    <CommandEmpty>{message ?? 'No matches yet'}</CommandEmpty>
                    {roads.length > 0 && (
                        <CommandGroup heading="On the map">
                            {roads.map((r, i) => (
                                <CommandItem key={`road-${i}`} value={`road-${i}`} onSelect={() => (reset(), engine.focusRoad(r))}>
                                    <Route />
                                    <span className="flex min-w-0 flex-col">
                                        <span>{r.name}</span>
                                        {r.detail && <span className="text-xs text-muted-foreground">{r.detail}</span>}
                                    </span>
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    )}
                    {places.length > 0 && (
                        <CommandGroup heading="Places">
                            {places.map((p, i) => (
                                <CommandItem key={`place-${i}`} value={`place-${i}`} onSelect={() => (reset(), engine.goTo(p))}>
                                    <MapPin />
                                    <span className="flex min-w-0 flex-col">
                                        <span>{p.name}</span>
                                        {p.detail && <span className="text-xs text-muted-foreground">{p.detail}</span>}
                                    </span>
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    )}
                </CommandList>
            )}
        </Command>
    )
}
