import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Engine, type Snapshot } from './engine'
import { Panel } from './Panel'
import { RoadCard } from './RoadCard'

const EMPTY = () => null

/** Full-bleed map with the control panel (top left) and the road card (top right); both are bottom sheets on phones. */
export function App() {
    const ref = useRef<HTMLDivElement>(null)
    const [engine, setEngine] = useState<Engine | null>(null)

    useEffect(() => {
        const e = new Engine(ref.current!)
        setEngine(e)
        if (import.meta.env.DEV) Object.assign(window, { engine: e }) // for poking at it from the console
        return () => e.destroy()
    }, [])

    const snap = useSyncExternalStore(engine?.subscribe ?? (() => () => {}), engine?.getSnapshot ?? EMPTY) as Snapshot | null

    return (
        <>
            {/* MapLibre sets position: relative on its container, so the wrapper does the positioning. */}
            <div className="fixed inset-0">
                <div ref={ref} className="h-full w-full" />
            </div>
            {engine && snap && (
                <>
                    <Panel engine={engine} snap={snap} />
                    {snap.card && <RoadCard engine={engine} card={snap.card} weights={snap.weights} />}
                </>
            )}
        </>
    )
}
