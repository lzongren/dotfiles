import { useCallback, useEffect, useRef, useState } from 'react'
import { getSessions } from './api'
import type { SessionsResponse } from './shared/types'
import { SessionTable } from './components/SessionTable'

type View =
  | { phase: 'loading' }
  | { phase: 'unauthorized' }
  | { phase: 'down'; cause: Cause; message: string }
  | { phase: 'ready'; data: SessionsResponse; staleSince: number | null; staleCause: Cause | null }

type Cause = 'remote' | 'local' | 'probe'

export function App() {
  const [view, setView] = useState<View>({ phase: 'loading' })
  const [now, setNow] = useState(() => Date.now())
  const lastGood = useRef<SessionsResponse | null>(null)

  const refresh = useCallback(async () => {
    const result = await getSessions()
    if (result.kind === 'ok') {
      lastGood.current = result.data
      setView({ phase: 'ready', data: result.data, staleSince: null, staleCause: null })
      return
    }
    if (result.kind === 'unauthorized') {
      setView({ phase: 'unauthorized' })
      return
    }
    const cause: Cause = result.kind === 'unreachable' ? 'remote' : result.kind === 'network' ? 'local' : 'probe'
    const message = result.message
    setView((prev) => {
      if (lastGood.current) {
        const since = prev.phase === 'ready' && prev.staleSince !== null ? prev.staleSince : Date.now()
        return { phase: 'ready', data: lastGood.current, staleSince: since, staleCause: cause }
      }
      return { phase: 'down', cause, message }
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
          {view.cause === 'remote'
            ? `host unreachable: ${view.message}`
            : view.cause === 'local'
              ? 'dashboard server unreachable — run devbox web'
              : `probe failed: ${view.message}`}
        </p>
      </main>
    )
  }

  const { data, staleSince, staleCause } = view
  return (
    <main>
      <header>
        <h1>devbox — {data.host}</h1>
        {staleSince !== null ? (
          <p role="alert" className="banner">
            {staleCause === 'local'
              ? 'dashboard server stopped — run devbox web'
              : staleCause === 'probe'
                ? 'probe failed'
                : 'host unreachable'}{' '}
            — showing sessions as of {Math.max(0, Math.round((now - staleSince) / 1000))}s ago
          </p>
        ) : null}
      </header>
      <SessionTable sessions={data.sessions} now={now} />
    </main>
  )
}
