// The Planetary Computer SAS token for ESA WorldCover, fetched once for all workers. Its token endpoint rate-limits
// (429) when every worker asks for its own, and land cover then silently went missing. The token is shared,
// remembered for this browser session until shortly before it expires, and retried with backoff when throttled.
const TOKEN_URL = 'https://planetarycomputer.microsoft.com/api/sas/v1/token/ai4edataeuwest/esa-worldcover'
const STORE_KEY = 'worldcover-token'

let pending: Promise<string> | null = null

export function landcoverToken(): Promise<string> {
    try {
        const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? 'null')
        if (saved && saved.expires > Date.now() + 5 * 60_000) return Promise.resolve(saved.token)
    } catch {}
    pending ??= fetchToken().finally(() => (pending = null))
    return pending
}

async function fetchToken(): Promise<string> {
    for (let i = 0; ; i++) {
        const r = await fetch(TOKEN_URL)
        if (r.ok) {
            const j = await r.json()
            const expires = Date.parse(j['msft:expiry']) || Date.now() + 30 * 60_000
            try {
                sessionStorage.setItem(STORE_KEY, JSON.stringify({ token: j.token, expires }))
            } catch {}
            return j.token
        }
        if (i >= 3 || (r.status !== 429 && r.status < 500)) throw new Error(`land cover token: HTTP ${r.status}`)
        await new Promise((res) => setTimeout(res, 2000 * 2 ** i))
    }
}
