import { useCallback, useEffect, useRef, useState } from 'react'
import { getSessions } from './api'
import type { SessionsResponse } from './shared/types'
import { SessionTable } from './components/SessionTable'

type View =
  | { phase: 'loading' }
  | { phase: 'unauthorized' }
  | { phase: 'down'; message: string }
  | { phase: 'ready'; data: SessionsResponse; staleSince: number | null }

export function App() {
  const [view, setView] = useState<View>({ phase: 'loading' })
  const [now, setNow] = useState(() => Date.now())
  const lastGood = useRef<SessionsResponse | null>(null)

  const refresh = useCallback(async () => {
    const result = await getSessions()
    if (result.kind === 'ok') {
      lastGood.current = result.data
      setView({ phase: 'ready', data: result.data, staleSince: null })
      return
    }
    if (result.kind === 'unauthorized') {
      setView({ phase: 'unauthorized' })
      return
    }
    const message = result.message
    setView((prev) => {
      if (lastGood.current) {
        const since = prev.phase === 'ready' && prev.staleSince !== null ? prev.staleSince : Date.now()
        return { phase: 'ready', data: lastGood.current, staleSince: since }
      }
      return { phase: 'down', message }
    })
  }, [])

  useEffect(() => {
    void refresh()
    const poll = setInterval(() => {
      void refresh()
    }, 5000)
    const tick = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    const onFocus = () => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(poll)
      clearInterval(tick)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  if (view.phase === 'unauthorized') {
    return (
      <main className="notice">
        <h1>devbox</h1>
        <p>server restarted — run devbox web</p>
      </main>
    )
  }
  if (view.phase === 'loading') {
    return (
      <main className="notice">
        <h1>devbox</h1>
        <p>loading sessions…</p>
      </main>
    )
  }
  if (view.phase === 'down') {
    return (
      <main className="notice">
        <h1>devbox</h1>
        <p role="alert" className="banner">
          host unreachable: {view.message}
        </p>
      </main>
    )
  }

  const { data, staleSince } = view
  return (
    <main>
      <header>
        <h1>devbox — {data.host}</h1>
        {staleSince !== null ? (
          <p role="alert" className="banner">
            host unreachable — showing sessions as of {Math.max(0, Math.round((now - staleSince) / 1000))}s ago
          </p>
        ) : null}
      </header>
      <SessionTable sessions={data.sessions} now={now} />
    </main>
  )
}
