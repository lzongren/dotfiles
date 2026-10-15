import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { getInsights, getSessions, type ApiResult } from './api'
import type { AgentInsight, SessionsResponse } from './shared/types'
import { changeMark, laneOf, loadSeen, markSeen, type Lane } from './insights'
import { usePoll } from './poll'
import { initToken } from './token'
import { ConnectionStatus, INSIGHTS_STALE_MS, type Cause, type Failure } from './components/ConnectionStatus'
import { Overview } from './components/Overview'
import { SessionList } from './components/SessionList'
import { TerminalTabs } from './components/TerminalTabs'
import { Notes } from './components/Notes'
import { ThemePicker } from './components/ThemePicker'
import { WorkspacePalette } from './components/WorkspacePalette'

const SESSIONS_POLL_MS = 5000
const INSIGHTS_POLL_MS = 15000

const SIDEBAR_KEY = 'devbox.sidebar'
const SIDEBAR = { min: 200, initial: 320, max: 640 }

function storedWidth(): number {
  try {
    const n = Number(localStorage.getItem(SIDEBAR_KEY))
    return n >= SIDEBAR.min ? Math.min(n, SIDEBAR.max) : SIDEBAR.initial
  } catch {
    return SIDEBAR.initial
  }
}

function SidebarHandle({ width, onWidth }: { width: number; onWidth: (n: number) => void }) {
  const dragged = useRef<number | null>(null)
  const max = Math.max(SIDEBAR.min, Math.min(SIDEBAR.max, Math.floor(window.innerWidth / 2)))
  const shown = Math.min(width, max)
  const clamp = (n: number) => Math.round(Math.min(max, Math.max(SIDEBAR.min, n)))
  const set = (n: number) => onWidth(clamp(n))
  const drop = () => {
    if (dragged.current !== null) onWidth(dragged.current)
    dragged.current = null
  }
  return (
    <div
      className="sidebar-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sessions sidebar"
      aria-valuemin={SIDEBAR.min}
      aria-valuemax={max}
      aria-valuenow={shown}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const aside = event.currentTarget.parentElement
        if (!aside || !event.currentTarget.hasPointerCapture(event.pointerId)) return
        dragged.current = clamp(event.clientX - aside.getBoundingClientRect().left)
        event.currentTarget.closest<HTMLElement>('.app')?.style.setProperty('--sidebar-w', `${dragged.current}px`)
      }}
      onPointerUp={drop}
      onLostPointerCapture={drop}
      onDoubleClick={() => set(SIDEBAR.initial)}
      onKeyDown={(event) => {
        const step = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
        if (!step) return
        event.preventDefault()
        set(shown + step)
      }}
    />
  )
}

interface Health {
  okAt: number | null
  failure: Failure | null
}

const UNKNOWN: Health = { okAt: null, failure: null }

function causeOf(result: Exclude<ApiResult<unknown>, { kind: 'ok' }>): Cause {
  if (result.kind === 'unauthorized') return 'auth'
  if (result.kind === 'unreachable') return 'remote'
  return result.kind === 'network' ? 'local' : 'probe'
}

function failed(prev: Health, result: Exclude<ApiResult<unknown>, { kind: 'ok' }>, at: number): Health {
  const message = result.kind === 'unauthorized' ? '' : result.message
  return { okAt: prev.okAt, failure: { cause: causeOf(result), message, since: prev.failure?.since ?? at } }
}

export function App() {
  const [data, setData] = useState<SessionsResponse | null>(null)
  const [sessionsHealth, setSessionsHealth] = useState<Health>(UNKNOWN)
  const [insightsHealth, setInsightsHealth] = useState<Health>(UNKNOWN)
  const [recoveredAt, setRecoveredAt] = useState<number | null>(null)
  const [recoveries, setRecoveries] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [tabs, setTabs] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const [openCount, setOpenCount] = useState(0)
  const [insights, setInsights] = useState<Map<string, AgentInsight>>(() => new Map())
  const [seenVersion, setSeenVersion] = useState(0)
  const [sidebarWidth, setSidebarWidth] = useState(storedWidth)
  const insightsAt = useRef(0)
  const failing = useRef(false)

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
    const at = Date.now()
    if (result.kind === 'ok') {
      setData(result.data)
      setSessionsHealth({ okAt: at, failure: null })
      if (failing.current) {
        setRecoveredAt(at)
        setRecoveries((n) => n + 1)
      }
      failing.current = false
      return true
    }
    failing.current = true
    setSessionsHealth((prev) => failed(prev, result, at))
    return result.kind !== 'unauthorized'
  }, [])

  const refreshInsights = useCallback(async () => {
    const result = await getInsights()
    const at = Date.now()
    if (result.kind === 'ok' && Array.isArray(result.data.agents)) {
      insightsAt.current = at
      setInsights(new Map(result.data.agents.map((a) => [a.session, a])))
      setInsightsHealth({ okAt: at, failure: null })
    } else if (result.kind !== 'ok') {
      if (at - insightsAt.current > INSIGHTS_STALE_MS && !failing.current) setInsights(new Map())
      setInsightsHealth((prev) => failed(prev, result, at))
    }
    return result.kind !== 'unauthorized'
  }, [])

  const sessionsPoll = usePoll(refresh, SESSIONS_POLL_MS)
  const insightsPoll = usePoll(refreshInsights, INSIGHTS_POLL_MS)
  const pollSessions = sessionsPoll.run
  const pollInsights = insightsPoll.run
  const retry = useCallback(() => {
    pollSessions()
    pollInsights()
  }, [pollSessions, pollInsights])

  useEffect(() => {
    if (recoveries > 0) pollInsights()
  }, [recoveries, pollInsights])

  useEffect(() => {
    setNow(Date.now())
  }, [sessionsPoll.pendingSince, sessionsPoll.nextAt, insightsPoll.pendingSince, insightsPoll.nextAt])

  useEffect(() => {
    const tick = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    const onHash = () => {
      initToken()
      retry()
    }
    window.addEventListener('focus', retry)
    window.addEventListener('hashchange', onHash)
    return () => {
      clearInterval(tick)
      window.removeEventListener('focus', retry)
      window.removeEventListener('hashchange', onHash)
    }
  }, [retry])

  const host = data?.host ?? ''
  const lanes = new Map<Lane, number>()
  for (const s of data?.sessions ?? []) {
    const lane = laneOf(s, insights.get(s.name), seenAt(s.name), now)
    lanes.set(lane, (lanes.get(lane) ?? 0) + 1)
  }
  const lane = (l: Lane) => lanes.get(l) ?? 0
  const waiting = lane('blocked') + lane('ready')
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth))
    } catch {
      void 0
    }
  }, [sidebarWidth])
  useEffect(() => {
    const place = activeTab ?? host
    document.title = `${waiting > 0 ? `(${waiting}) ` : ''}${place ? `${place} · ` : ''}devbox`
    document.querySelector('link[rel="icon"]')?.setAttribute('href', waiting > 0 ? '/favicon-alert.svg' : '/favicon.svg')
  }, [waiting, activeTab, host])

  const status = (
    <ConnectionStatus
      sessions={{ ...sessionsHealth, pendingSince: sessionsPoll.pendingSince, nextAt: sessionsPoll.nextAt }}
      insights={{ ...insightsHealth, pendingSince: insightsPoll.pendingSince, nextAt: insightsPoll.nextAt }}
      host={host}
      now={now}
      recoveredAt={recoveredAt}
      page={data === null}
      onRetry={retry}
    />
  )
  if (data === null) {
    return (
      <main className="notice">
        <h1>devbox</h1>
        {status}
      </main>
    )
  }

  latest.current = { sessions: data.sessions, insights }
  return (
    <div className="app" style={{ '--sidebar-w': `${sidebarWidth}px` } as CSSProperties}>
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
          onSessionsChanged={pollSessions}
        />
        <ThemePicker />
      </header>
      {status}
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
        <SidebarHandle width={sidebarWidth} onWidth={setSidebarWidth} />
      </aside>
      <main className="workspace">
        <TerminalTabs
          tabs={tabs}
          active={activeTab}
          focusSignal={openCount}
          reconnectSignal={recoveries}
          sessions={data.sessions}
          insights={insights}
          now={now}
          counts={{ needs: lane('blocked'), working: lane('working'), fresh: lane('ready') }}
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
            onOpen={openTerminal}
            onSeen={seen}
          />
        </div>
      </main>
    </div>
  )
}
