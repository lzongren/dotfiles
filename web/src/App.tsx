import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getInsights, getSessions } from './api'
import type { AgentInsight, SessionsResponse } from './shared/types'
import { changeMark, laneOf, loadSeen, markSeen } from './insights'
import { Overview } from './components/Overview'
import { SessionList } from './components/SessionList'
import { TerminalTabs } from './components/TerminalTabs'
import { Notes } from './components/Notes'
import { ThemePicker } from './components/ThemePicker'
import { WorkspacePalette } from './components/WorkspacePalette'

type Cause = 'remote' | 'local' | 'probe'

const INSIGHTS_STALE_MS = 60_000

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
  const [seenVersion, setSeenVersion] = useState(0)
  const insightsAt = useRef(0)
  const lastGood = useRef<SessionsResponse | null>(null)

  const latest = useRef<{ sessions: SessionsResponse['sessions']; insights: Map<string, AgentInsight> }>({
    sessions: [],
    insights: new Map(),
  })
  const seen = useCallback((names: string[]) => {
    const { sessions, insights: byName } = latest.current
    markSeen(
      names,
      (name) => {
        const session = sessions.find((s) => s.name === name)
        return session ? changeMark(session, byName.get(name)) : Math.floor(Date.now() / 1000)
      },
      Date.now(),
    )
    setSeenVersion((n) => n + 1)
  }, [])
  const seenAt = useMemo(() => loadSeen(Date.now()).seenAt, [seenVersion])
  const leaving = useRef<string | null>(null)
  useEffect(() => {
    if (leaving.current !== null && leaving.current !== activeTab) seen([leaving.current])
    leaving.current = activeTab
  }, [activeTab, seen])
  const openTerminal = useCallback((name: string) => {
    seen([name])
    setTabs((prev) => (prev.includes(name) ? prev : [...prev, name]))
    setActiveTab(name)
    setOpenCount((n) => n + 1)
  }, [seen])
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
      insightsAt.current = Date.now()
      setInsights(new Map(result.data.agents.map((a) => [a.session, a])))
      setInsightsNotice(null)
    } else if (result.kind !== 'ok') {
      if (Date.now() - insightsAt.current > INSIGHTS_STALE_MS) setInsights(new Map())
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

  const host = view.phase === 'ready' ? view.data.host : ''
  const waiting =
    view.phase === 'ready'
      ? view.data.sessions.filter((s) => ['blocked', 'ready'].includes(laneOf(s, insights.get(s.name), seenAt(s.name), now))).length
      : 0
  useEffect(() => {
    const place = activeTab ?? host
    document.title = `${waiting > 0 ? `(${waiting}) ` : ''}${place ? `${place} · ` : ''}devbox`
    document.querySelector('link[rel="icon"]')?.setAttribute('href', waiting > 0 ? '/favicon-alert.svg' : '/favicon.svg')
  }, [waiting, activeTab, host])

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
  latest.current = { sessions: data.sessions, insights }
  return (
    <div className="app">
      <header className="topbar">
        <h1 className="brand">
          <svg className="brand-mark" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <rect className="mark-bg" x="1.5" y="1.5" width="21" height="21" rx="6" />
            <path className="mark-prompt" d="M7 8.5l3.5 3.5L7 15.5" />
            <rect className="mark-cursor" x="12.5" y="14" width="5" height="2" rx="1" />
          </svg>
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
        <ThemePicker />
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
        <div className="sidebar-sessions">
          <SessionList
            sessions={data.sessions}
            insights={insights}
            now={now}
            seenAt={seenAt}
            active={activeTab}
            onAttach={openTerminal}
          />
        </div>
        <Notes />
      </aside>
      <main className="workspace">
        <TerminalTabs
          tabs={tabs}
          active={activeTab}
          focusSignal={openCount}
          sessions={data.sessions}
          insights={insights}
          now={now}
          needs={waiting}
          seenAt={seenAt}
          onSelect={setActiveTab}
          onClose={closeTerminal}
        />
        <div className="overview-wrap" hidden={activeTab !== null}>
          <Overview
            sessions={data.sessions}
            insights={insights}
            now={now}
            seenAt={seenAt}
            visible={activeTab === null}
            notice={insightsNotice}
            onOpen={openTerminal}
            onSeen={seen}
          />
        </div>
      </main>
    </div>
  )
}
