import { Input } from '@kevinschaich/components'
import { Search as SearchIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import type { Engine, Place } from './engine'

/** Place search with suggestions as you type (Photon), biased toward the current map view. */
export function Search({ engine }: { engine: Engine }) {
    const [text, setText] = useState('')
    const [hits, setHits] = useState<Place[]>([])
    const [message, setMessage] = useState<string | null>(null)
    const [active, setActive] = useState(0)
    const ctrl = useRef<AbortController | null>(null)
    const timer = useRef<number | undefined>(undefined)
    const input = useRef<HTMLInputElement>(null)

    const close = () => {
        setHits([])
        setMessage(null)
    }
    const choose = (p: Place) => {
        close()
        input.current?.blur()
        engine.goTo(p)
    }
    const onChange = (value: string) => {
        setText(value)
        clearTimeout(timer.current)
        const q = value.trim()
        if (q.length < 3) {
            ctrl.current?.abort()
            close()
            return
        }
        timer.current = window.setTimeout(async () => {
            ctrl.current?.abort()
            ctrl.current = new AbortController()
            try {
                const list = await engine.search(q, ctrl.current.signal)
                setHits(list)
                setActive(0)
                setMessage(list.length ? null : 'No places found')
            } catch (err) {
                if ((err as Error).name !== 'AbortError') {
                    setHits([])
                    setMessage("Search isn't available right now")
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
                placeholder="Search a town, address or ZIP"
                autoComplete="off"
                spellCheck={false}
                role="combobox"
                aria-expanded={open}
                aria-controls="search-results"
                aria-activedescendant={hits.length ? `place-${active}` : undefined}
                className="pl-8"
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
                    {message ? (
                        <li className="px-2 py-1.5 text-muted-foreground">{message}</li>
                    ) : (
                        hits.map((h, i) => (
                            <li
                                key={i}
                                id={`place-${i}`}
                                role="option"
                                aria-selected={i === active}
                                className="flex cursor-pointer flex-col rounded-md px-2 py-1.5 aria-selected:bg-accent hover:bg-accent"
                                onMouseDown={(e) => {
                                    e.preventDefault()
                                    choose(h)
                                }}
                            >
                                <span>{h.name}</span>
                                {h.detail && <span className="text-xs text-muted-foreground">{h.detail}</span>}
                            </li>
                        ))
                    )}
                </ul>
            )}
        </div>
    )
}
