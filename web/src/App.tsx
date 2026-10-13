import { useCallback, useEffect, useRef, useState } from 'react'
import { getInsights, getSessions } from './api'
import type { AgentInsight, SessionsResponse } from './shared/types'
import { loadSeen, markSeen } from './insights'
import { Overview } from './components/Overview'
import { SessionList } from './components/SessionList'
import { TerminalTabs } from './components/TerminalTabs'
import { WorkspacePalette } from './components/WorkspacePalette'

type Cause = 'remote' | 'local' | 'probe'

type View =
  | { phase: 'loading' }
  | { phase: 'unauthorized' }
  | { phase: 'down'; cause: Cause; message: string }
  | { phase: 'ready'; data: SessionsResponse; staleSince: number | null; staleCause: Cause | null }

export function App() {
  const [view, setView] = useState<View>({ phase: 'loading' })
  const [now, setNow] = useState(() => Date.now())
  const [tabs, setTabs] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const [openCount, setOpenCount] = useState(0)
  const [insights, setInsights] = useState<Map<string, AgentInsight>>(() => new Map())
  const [insightsNotice, setInsightsNotice] = useState<string | null>(null)
  const [, setSeenVersion] = useState(0)
  const lastGood = useRef<SessionsResponse | null>(null)

  const seen = useCallback((name: string) => {
    markSeen(name, Date.now())
    setSeenVersion((n) => n + 1)
  }, [])
  const openTerminal = useCallback((name: string) => {
    markSeen(name, Date.now())
    setSeenVersion((n) => n + 1)
    setTabs((prev) => (prev.includes(name) ? prev : [...prev, name]))
    setActiveTab(name)
    setOpenCount((n) => n + 1)
  }, [])
  const closeTerminal = useCallback(
    (name: string) => {
      const index = tabs.indexOf(name)
      const next = tabs.filter((tab) => tab !== name)
      setTabs(next)
      if (activeTab === name) setActiveTab(next[Math.min(index, next.length - 1)] ?? null)
    },
    [tabs, activeTab],
  )

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

  const refreshInsights = useCallback(async () => {
    const result = await getInsights()
    if (result.kind === 'ok' && Array.isArray(result.data.agents)) {
      setInsights(new Map(result.data.agents.map((a) => [a.session, a])))
      setInsightsNotice(null)
    } else if (result.kind !== 'ok') {
      setInsightsNotice(result.kind === 'unauthorized' ? null : `agent details unavailable: ${result.message}`)
    }
  }, [])

  useEffect(() => {
    void refresh()
    void refreshInsights()
    const poll = setInterval(() => {
      void refresh()
    }, 5000)
    const insightsPoll = setInterval(() => {
      void refreshInsights()
    }, 15000)
    const tick = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    const onFocus = () => {
      void refresh()
      void refreshInsights()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(poll)
      clearInterval(insightsPoll)
      clearInterval(tick)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh, refreshInsights])

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
    <div className="app">
      <header className="topbar">
        <h1>
          devbox <span className="host">{data.host}</span>
        </h1>
        <WorkspacePalette
          sessions={data.sessions}
          now={now}
          onOpen={openTerminal}
          onSessionsChanged={() => {
            void refresh()
          }}
        />
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
      <aside className="sidebar">
        <SessionList
          sessions={data.sessions}
          insights={insights}
          now={now}
          active={activeTab}
          onAttach={openTerminal}
        />
      </aside>
      <main className="workspace">
        <TerminalTabs
          tabs={tabs}
          active={activeTab}
          focusSignal={openCount}
          onSelect={setActiveTab}
          onClose={closeTerminal}
        />
        <div className="overview-wrap" hidden={activeTab !== null}>
          <Overview
            sessions={data.sessions}
            insights={insights}
            now={now}
            seenAt={loadSeen(now).seenAt}
            notice={insightsNotice}
            onOpen={openTerminal}
            onSeen={seen}
          />
        </div>
      </main>
    </div>
  )
}
