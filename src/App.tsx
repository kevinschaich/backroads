import { MapView, useMap } from '@kevinschaich/components/map'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { SOURCES } from './DataSources'
import { Engine, type Snapshot } from './engine'
import { Panel } from './Panel'
import { RoadCard } from './RoadCard'

/** Full-bleed map with the control panel (top left) and the road card (top right); both are bottom sheets on phones. */
export function App() {
    return (
        // Streets is a light map, so the panels switch to the light theme over it (an approved exception).
        <MapView center={[-105.0166, 39.6133]} zoom={12} storageKey="backroads" sources={SOURCES} lightUiOnLightBasemap>
            <Roads />
        </MapView>
    )
}

/** The road engine on the shared map: loading, scoring and the road layers, plus the UI that reads it. */
function Roads() {
    const { map } = useMap()
    const [engine, setEngine] = useState<Engine | null>(null)

    useEffect(() => {
        const e = new Engine(map)
        setEngine(e)
        if (import.meta.env.DEV) Object.assign(window, { engine: e }) // for poking at it from the console
        return () => e.destroy()
    }, [map])

    if (!engine) return null
    return <EngineUI engine={engine} />
}

function EngineUI({ engine }: { engine: Engine }) {
    const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot) as Snapshot
    return (
        <>
            <Panel engine={engine} snap={snap} />
            {snap.card && <RoadCard engine={engine} card={snap.card} weights={snap.weights} />}
        </>
    )
}
