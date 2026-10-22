import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { getBrief, getInsights, getReturnSummary, getSessions, type ApiResult, type BriefResponse } from './api'
import type { AgentInsight, ReturnSummary, SessionsResponse } from './shared/types'
import { changeMark, displayTitle, laneOf, loadSeen, markSeen, type Lane } from './insights'
import { usePoll } from './poll'
import { clause, holdingOf, lower } from './shared/recover'
import { initToken } from './token'
import { ConnectionStatus, INSIGHTS_STALE_MS, type Cause, type Failure } from './components/ConnectionStatus'
import { Gradient, mostSerious } from './components/Icon'
import { Overview } from './components/Overview'
import { PickUpRail, titleOf } from './components/PickUp'
import { homeItems, type HomeItem } from './components/work'
import { ArtifactsPage } from './components/ArtifactsPage'
import { SessionsPage, workFor } from './components/SessionsPage'
import { ReturnView } from './components/ReturnView'
import { headline, SessionList } from './components/SessionList'
import { TerminalTabs } from './components/TerminalTabs'
import type { FileRef } from './components/FilePreview'
import { Notes } from './components/Notes'
import { ThemePicker } from './components/ThemePicker'
import { NewPage } from './components/NewSession'
import { WorkspacePalette } from './components/WorkspacePalette'

const SESSIONS_POLL_MS = 5000
const INSIGHTS_POLL_MS = 15000
const PICKUPS = 8
const BRIEF_RETRY = 60_000

const SIDEBAR_KEY = 'devbox.sidebar'
const VISITS_KEY = 'devbox.visits'
const withAsks = (returns: Record<string, ReturnSummary>): Record<string, ReturnSummary> => {
  try {
    const asks = Object.keys(sessionStorage).flatMap((k) => (k.startsWith('devbox-ask:') && sessionStorage.getItem(k)?.trim() ? [k.slice(11)] : []))
    return { ...returns, ...Object.fromEntries(asks.map((name) => [name, { ...(returns[name] ?? { draft: false, asking: 0, answered: 0 }), question: true }])) }
  } catch {
    return returns
  }
}
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
  const [dock, setDock] = useState<FileRef | null>(null)
  const [pickup, setPickup] = useState<string | null>(null)
  const [returns, setReturns] = useState<Record<string, ReturnSummary>>({})
  const [briefs, setBriefs] = useState<Record<string, { mark: number; left: number; visit: number; data?: BriefResponse; failed?: number }>>({})
  const [visits, setVisits] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(VISITS_KEY) ?? '{}') as Record<string, number>
    } catch {
      return {}
    }
  })
  const [briefing, setBriefing] = useState(false)
  const [view, setView] = useState<'now' | 'sessions' | 'artifacts' | 'new'>('now')
  const [switchTo, setSwitchTo] = useState<{ name: string; at: number } | null>(null)
  const [focus, setFocus] = useState<{ name: string; at: number; terminal?: boolean } | null>(null)
  const [homeAt, setHomeAt] = useState(0)
  const [backTo, setBackTo] = useState<'sessions' | 'artifacts' | null>(null)
  const [openMembers, setOpenMembers] = useState<string[]>([])
  const insightsAt = useRef(0)
  const failing = useRef(false)

  const latest = useRef<{ sessions: SessionsResponse['sessions']; insights: Map<string, AgentInsight> }>({
    sessions: [],
    insights: new Map(),
  })
  const seen = useCallback((names: string[], at?: (name: string) => number) => {
    const { sessions, insights: byName } = latest.current
    markSeen(
      names,
      at ??
        ((name) => {
          const session = sessions.find((s) => s.name === name)
          return session ? changeMark(session, byName.get(name)) : Math.floor(Date.now() / 1000)
        }),
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
  const openBeside = useCallback(
    (file: FileRef) => {
      openTerminal(file.session)
      setDock(file)
    },
    [openTerminal],
  )
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

  const refreshReturns = useCallback(() => {
    void getReturnSummary().then((r) => {
      if (r.kind === 'ok') setReturns(withAsks(r.data.sessions))
    })
  }, [])

  const refreshInsights = useCallback(async () => {
    void getReturnSummary().then((r) => {
      if (r.kind === 'ok') setReturns(withAsks(r.data.sessions))
    })
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
  const lanes = new Map<Lane, string[]>()
  for (const s of data?.sessions ?? []) {
    const lane = laneOf(s, insights.get(s.name), seenAt(s.name), now)
    lanes.set(lane, [...(lanes.get(lane) ?? []), s.name])
  }
  useEffect(() => {
    try {
      sessionStorage.setItem(VISITS_KEY, JSON.stringify(visits))
    } catch {
      void 0
    }
  }, [visits])
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth))
    } catch {
      void 0
    }
  }, [sidebarWidth])

  const titles = useMemo(
    () =>
      Object.fromEntries(
        (data?.sessions ?? []).flatMap((s) => {
          const t = displayTitle(headline(s), insights.get(s.name))
          return t && t !== s.name ? [[s.name, t]] : []
        }),
      ),
    [data, insights],
  )
  const known = useMemo(() => Object.fromEntries(Object.entries(briefs).flatMap(([name, b]) => (b.data ? [[name, b.data]] : []))), [briefs])
  const pickups = homeItems(data?.sessions ?? [], insights, seenAt, now, returns, known)
    .slice(0, PICKUPS)
    .map((i) => (briefs[i.session.name] ? i : { ...i, reading: true }))
  const groups: HomeItem[] = [
    ...pickups,
    ...Object.values(known).flatMap((b): HomeItem[] => {
      const session = data?.sessions.find((x) => x.name === b.session)
      const insight = insights.get(b.session)
      if (!session || !insight || pickups.some((i) => i.session.name === b.session || i.brief?.work.members.some((m) => m.name === b.session))) return []
      return [{ session, insight, attention: 'new', tone: 'fresh', status: '', action: '', brief: b }]
    }),
  ]
  const needPickups = pickups.filter((i) => i.attention === 'needs')
  const needing = new Set([...(lanes.get('blocked') ?? []), ...needPickups.map((i) => i.session.name)])
  const waiting = new Set([...needing, ...(lanes.get('ready') ?? [])]).size
  const listed = new Set(pickups.flatMap((i) => [i.session.name, ...(i.brief?.work.members.map((m) => m.name) ?? [])]))
  const pickupItem = pickups.find((i) => i.session.name === pickup)
  const pickupRow = data?.sessions.find((s) => s.name === pickup)
  const pickupTitle = pickupItem ? titleOf(pickupItem) : pickupRow && pickup ? displayTitle(headline(pickupRow), insights.get(pickup)) || undefined : undefined
  const covered = Object.keys(visits).flatMap((n) => known[n]?.work.members.map((m) => m.name) ?? [n])
  const blockedOnly = (lanes.get('blocked') ?? []).filter((n) => !listed.has(n))
  const needsYou = needPickups.length + blockedOnly.length
  const needsTone = mostSerious([
    ...needPickups.map((i) => i.tone),
    ...blockedOnly.flatMap((n) => {
      const state = insights.get(n)?.state
      return state === 'error' || state === 'waiting' ? [state] : []
    }),
  ])
  const needsMap = new Map(needPickups.map((i) => [i.session.name, i.status]))
  const besides = (l: Lane) => (lanes.get(l) ?? []).filter((n) => !needsMap.has(n)).length
  useEffect(() => {
    const place = activeTab ?? (view === 'now' ? pickup : null) ?? host
    document.title = `${waiting > 0 ? `(${waiting}) ` : ''}${place ? `${place} · ` : ''}devbox`
    document.querySelector('link[rel="icon"]')?.setAttribute('href', waiting > 0 ? '/favicon-alert.svg' : '/favicon.svg')
  }, [waiting, activeTab, host, view, pickup])
  const wanted = JSON.stringify(
    [
      ...pickups,
      ...(data?.sessions ?? [])
        .filter((x) => returns[x.name]?.looked !== undefined && x.attachable && insights.get(x.name)?.agent === 'claude' && !pickups.some((i) => i.session.name === x.name || i.brief?.work.members.some((m) => m.name === x.name)))
        .map((x) => ({ session: x, insight: insights.get(x.name) })),
    ].flatMap((i) => {
      const b = briefs[i.session.name]
      if (pickup !== null && b) return []
      const mark = changeMark(i.session, i.insight)
      const left = seenAt(i.session.name)
      const visit = visits[i.session.name] ?? 0
      const current = b?.left === left && b.visit === visit && (b.failed === undefined ? b.mark === mark : now - b.failed < BRIEF_RETRY)
      return current ? [] : [[i.session.name, mark, left, visit]]
    }),
  )
  useEffect(() => {
    const next = (JSON.parse(wanted) as Array<[string, number, number, number]>)[0]
    if (!next || briefing) return
    const [name, mark, left, visit] = next
    setBriefing(true)
    void getBrief(name, left).then((result) => {
      setBriefs((prev) => ({ ...prev, [name]: result.kind === 'ok' ? { mark, left, visit, data: result.data } : { mark, left, visit, data: prev[name]?.data, failed: Date.now() } }))
      setBriefing(false)
      refreshReturns()
    })
  }, [wanted, briefing])
  const opened = useRef(new Map<string, number>())
  const openPickup = useCallback((name: string) => {
    const { sessions, insights: byName } = latest.current
    opened.current = new Map(sessions.map((s) => [s.name, changeMark(s, byName.get(s.name))]))
    setPickup(name)
  }, [])
  const [entry] = useState(() => window.location.hash)
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !data) return
    restored.current = true
    const [, kind, raw] = /^#(w|s)=(.+)$/.exec(entry) ?? []
    const name = data.sessions.find((s) => encodeURIComponent(s.name) === raw)?.name
    const page = /^#(sessions|artifacts|new)$/.exec(entry)?.[1] as typeof view | undefined
    if (name !== undefined && kind === 'w') openPickup(name)
    else if (name !== undefined) openTerminal(name)
    else if (page) setView(page)
  }, [data, entry, openPickup, openTerminal])
  useEffect(() => {
    if (!restored.current) return
    const hash = activeTab !== null ? `#s=${encodeURIComponent(activeTab)}` : view !== 'now' ? `#${view}` : pickup !== null ? `#w=${encodeURIComponent(pickup)}` : ''
    if (hash !== window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search + hash)
  }, [activeTab, view, pickup, data])
  const show = (next: typeof view, home = true) => {
    if (home) setBackTo(null)
    if (home && next === 'now' && pickup !== null) setHomeAt((n) => n + 1)
    setView(next)
    setActiveTab(null)
  }
  const go = (name: string, to?: 'changes' | 'terminal') => {
    const work = workFor(groups, name)?.session.name ?? name
    setBackTo(activeTab === null && (view === 'sessions' || view === 'artifacts') ? view : null)
    show('now', false)
    setFocus({ name: to === 'changes' ? work : name, at: Date.now(), terminal: to === 'terminal' || (to === undefined && !insights.get(name)) })
    if (pickup === null) openPickup(work)
    else if (work !== pickup) setSwitchTo({ name: work, at: Date.now() })
  }
  const done = (name: string, members: string[], next?: string) => {
    seen([name])
    seen(
      members.filter((n) => n !== name && n !== next),
      (n) => opened.current.get(n) ?? 0,
    )
    setVisits((prev) => ({ ...prev, [name]: (prev[name] ?? 0) + 1 }))
  }

  const status = (
    <ConnectionStatus
      sessions={{ ...sessionsHealth, pendingSince: sessionsPoll.pendingSince, nextAt: sessionsPoll.nextAt }}
      insights={{ ...insightsHealth, pendingSince: insightsPoll.pendingSince, nextAt: insightsPoll.nextAt }}
      agentStates={insights.size > 0}
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
    <div className="app" data-focus={activeTab === null ? 'true' : undefined} style={{ '--sidebar-w': `${sidebarWidth}px` } as CSSProperties}>
      <header className="topbar">
        <h1 className="brand">
          <svg className="brand-mark" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <Gradient id="devbox-grad" />
            <rect className="mark-bg" x="1.5" y="1.5" width="21" height="21" rx="6" />
            <path className="mark-prompt" d="M7 8.5l3.5 3.5L7 15.5" />
            <rect className="mark-cursor" x="12.5" y="14" width="5" height="2" rx="1" />
          </svg>
          devbox <span className="host">{data.host}</span>
        </h1>
        <nav className="topnav" aria-label="Pages">
          {(
            [
              ['now', 'Now'],
              ['sessions', 'All sessions'],
              ['artifacts', 'Artifacts'],
            ] as const
          ).map(([key, label]) => (
            <button key={key} type="button" aria-current={view === key && activeTab === null ? 'page' : undefined} onClick={() => show(key)}>
              {label}
              {key === 'sessions' ? <span className="lane-count">{data.sessions.length}</span> : null}
            </button>
          ))}
        </nav>
        <WorkspacePalette
          sessions={data.sessions}
          titles={titles}
          now={now}
          onOpen={(name) => go(name)}
          onNew={() => show('new')}
          onSessionsChanged={pollSessions}
        />
        <ThemePicker />
      </header>
      <aside className="sidebar">
        <div className="sidebar-sessions">
          {pickups.length ? <PickUpRail items={pickups} current={activeTab ?? ''} onSwitch={(name) => go(name, 'changes')} /> : null}
          <SessionList
            sessions={data.sessions.filter((s) => !listed.has(s.name))}
            others={pickups.length > 0}
            insights={insights}
            now={now}
            seenAt={seenAt}
            active={activeTab ?? (view === 'now' ? pickup : null)}
            onAttach={(name) => go(name)}
            needs={needsMap}
          />
        </div>
        {activeTab === null ? null : status}
        <Notes />
        <SidebarHandle width={sidebarWidth} onWidth={setSidebarWidth} />
      </aside>
      <main className="workspace">
        {activeTab === null ? status : null}
        <TerminalTabs
          tabs={tabs}
          active={activeTab}
          focusSignal={openCount}
          reconnectSignal={recoveries}
          sessions={data.sessions}
          insights={insights}
          now={now}
          counts={{ needs: needsYou, tone: needsTone, working: besides('working'), fresh: besides('ready') }}
          home={view === 'sessions' ? 'All sessions' : view === 'artifacts' ? 'Artifacts' : view === 'new' ? 'New session' : pickup !== null ? (pickupTitle ?? pickup) : 'Now'}
          seenAt={seenAt}
          dock={dock}
          banner={(name) => {
            const work = workFor(groups, name)
            const b = work?.brief?.brief
            if (!work || !b) return null
            const { rules, more } = holdingOf(b, work.session.name)
            const holding = [...b.holds.map((h) => lower(h.limit.shown)), ...rules.map((r) => clause(r.sentence)), ...(more ? [more] : [])]
            return (
              <div className="hold-bar term-hold" role="note">
                <strong>In {titleOf(work)} · keeps holding: </strong>
                {holding.length ? holding.join(' · ') : 'no limit or rule recorded yet'}
                <small>
                  {' '}
                  What you type here goes straight to {name}, unchecked.{' '}
                  <button type="button" className="link" onClick={() => go(name, 'changes')}>
                    Back to the work
                  </button>
                </small>
              </div>
            )
          }}
          onSelect={setActiveTab}
          onClose={closeTerminal}
        />
        <div className="overview-wrap" hidden={activeTab !== null || view !== 'now' || pickup !== null}>
          <Overview sessions={data.sessions} insights={insights} now={now} seenAt={seenAt} pickups={pickups} visited={Object.keys(visits)} covered={covered} onOpen={(name) => go(name, 'terminal')} onPickUp={(name) => (pickups.find((i) => i.session.name === name)?.action === 'Answer the question' ? go(name, 'terminal') : openPickup(name))} onAll={() => show('sessions')} host={host} connected={sessionsHealth.failure === null} returns={returns} />
        </div>
        {view === 'sessions' ? (
          <div className="overview-wrap" hidden={activeTab !== null}>
            <SessionsPage sessions={data.sessions} insights={insights} now={now} seenAt={seenAt} returns={returns} host={host} works={groups} visible={activeTab === null} onOpen={go} onBack={() => show('now')} />
          </div>
        ) : null}
        {view === 'artifacts' ? (
          <div className="overview-wrap" hidden={activeTab !== null}>
            <ArtifactsPage sessions={data.sessions} insights={insights} now={now} works={groups} onOpen={(name) => go(name, 'changes')} onBack={() => show('now')} onDock={openBeside} />
          </div>
        ) : null}
        {view === 'new' ? (
          <div className="overview-wrap" hidden={activeTab !== null}>
            <NewPage
              taken={data.sessions.map((s) => s.name)}
              host={host}
              onCreated={(name) => {
                pollSessions()
                go(name, 'terminal')
              }}
              onBack={() => show('now')}
            />
          </div>
        ) : null}
        {pickup !== null ? (
          <div className="overview-wrap" hidden={activeTab !== null || view !== 'now'}>
            <ReturnView
              key={pickup}
              session={pickup}
              title={pickupTitle}
              left={seenAt(pickup)}
              works={pickups}
              onSwitch={(name, members, here) => {
                done(pickup, members, name)
                if (here) setBackTo(null)
                openPickup(name)
              }}
              active={activeTab === null && view === 'now'}
              onClose={(members) => {
                done(pickup, members)
                setPickup(null)
                if (backTo) setView(backTo)
                setBackTo(null)
                pollInsights()
              }}
              back={backTo === 'sessions' ? 'All sessions' : backTo === 'artifacts' ? 'Artifacts' : 'Now'}
              onOpenTerminal={openTerminal}
              onSessionsChanged={pollSessions}
              elsewhere={data.sessions.filter((s) => !listed.has(s.name) && !covered.includes(s.name) && !openMembers.includes(s.name) && s.name !== pickup).length}
              onAll={() => show('sessions')}
              switchTo={switchTo}
              focus={focus}
              homeAt={homeAt}
              insights={insights}
              onStateChanged={(regrouped, work, brief) => {
                if (work) setOpenMembers(work.members.map((m) => m.name))
                setBriefs((prev) => {
                  const b = prev[pickup]
                  if (!b) return prev
                  if (regrouped) return { ...prev, [pickup]: { ...b, visit: -1 } }
                  const next = b.data && { ...b.data, ...(work ? { work } : {}), ...(brief ? { brief } : {}) }
                  return next && JSON.stringify(next) !== JSON.stringify(b.data) ? { ...prev, [pickup]: { ...b, data: next } } : prev
                })
                refreshReturns()
              }}
            />
          </div>
        ) : null}
      </main>
    </div>
  )
}
