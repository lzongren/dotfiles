import { useId, useReducer, useRef, useState } from 'react'
import type { AgentInsight, Session } from '../shared/types'
import { changeMark, displayTitle, heardAt, isFresh, laneOf, sinceOf, type Lane } from '../insights'
import { ago } from '../time'
import { Icon, StateIcon, toneOf, type Tone } from './Icon'

const SHELLS = ['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh']

export function headline(session: Session): string {
  const title = (session.title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim()
  return /^(claude code|codex)$/i.test(title) ? '' : title
}

export function sessionSummary(session: Session): { text: string; live: boolean } {
  const title = headline(session)
  if (title && !SHELLS.includes(session.cmd)) return { text: title, live: true }
  if (title) return { text: `last: ${title}`, live: false }
  return { text: [session.cmd, session.path].filter(Boolean).join(' · '), live: false }
}

export function Name({ name }: { name: string }) {
  const dated = /^(\d{3,4}_)(.+)$/.exec(name)
  return dated ? (
    <>
      <span className="name-prefix">{dated[1]}</span>
      {dated[2]}
    </>
  ) : (
    <>{name}</>
  )
}

const GROUPS: Array<{ lane: Lane; title: string }> = [
  { lane: 'blocked', title: 'Needs you' },
  { lane: 'working', title: 'Working' },
  { lane: 'ready', title: 'New since you looked' },
  { lane: 'recent', title: 'Recent' },
  { lane: 'parked', title: 'Idle over a week' },
]

const STATES: Record<Tone, string> = { waiting: 'waiting', bell: 'bell', error: 'error', working: 'working', quiet: 'working, quiet', fresh: 'new', idle: '' }

function whyOf(tone: Tone, insight: AgentInsight | undefined): string {
  if (tone === 'waiting') return insight?.waitingFor ? insight.waitingFor.replace(/^./, (c) => c.toUpperCase()) : 'Waiting on you'
  if (tone === 'bell') return 'Bell rang'
  if (tone === 'error') return insight?.error ? `Error: ${insight.error}` : 'Error'
  return ''
}

export function SessionList({
  sessions,
  insights = new Map(),
  now,
  seenAt = () => Infinity,
  active,
  onAttach,
  needs = new Map(),
  others = false,
}: {
  needs?: Map<string, string>
  others?: boolean
  sessions: Session[]
  insights?: Map<string, AgentInsight>
  now: number
  seenAt?: (name: string) => number
  active: string | null
  onAttach: (name: string) => void
}) {
  const id = useId()
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const [parkedOpen, setParkedOpen] = useState(false)
  const navRef = useRef<HTMLElement | null>(null)
  const pointerInside = useRef(false)
  const held = useRef<Array<{ name: string; lane: Lane }>>([])

  if (sessions.length === 0) {
    pointerInside.current = false
    held.current = []
    return <p className="empty">No sessions yet. Type a name above to start one.</p>
  }

  const byName = new Map(sessions.map((s) => [s.name, s]))
  const lanes = new Map(sessions.map((s) => [s.name, needs.has(s.name) ? 'blocked' : laneOf(s, insights.get(s.name), seenAt(s.name), now)]))
  const mark = (s: Session) => changeMark(s, insights.get(s.name))
  const order: Record<Lane, (a: Session, b: Session) => number> = {
    blocked: (a, b) => mark(a) - mark(b),
    working: (a, b) => mark(a) - mark(b),
    ready: (a, b) => mark(b) - mark(a),
    recent: (a, b) => b.activityEpoch - a.activityEpoch,
    parked: (a, b) => b.activityEpoch - a.activityEpoch,
  }
  const live = new Map(
    GROUPS.map(({ lane }) => [
      lane,
      sessions
        .filter((s) => lanes.get(s.name) === lane)
        .sort((a, b) => order[lane](a, b) || a.name.localeCompare(b.name))
        .map((s) => s.name),
    ]),
  )
  const focused = document.activeElement?.closest('.session') ?? null
  const holding = pointerInside.current || (focused !== null && (navRef.current?.contains(focused) ?? false))
  if (!holding) held.current = [...live].flatMap(([lane, names]) => names.map((name) => ({ name, lane })))
  const placedNames = new Set(held.current.map((p) => p.name))
  const placed = (lane: Lane) =>
    holding
      ? [
          ...held.current.filter((p) => p.lane === lane && byName.has(p.name)).map((p) => p.name),
          ...(live.get(lane) ?? []).filter((n) => !placedNames.has(n)),
        ]
      : (live.get(lane) ?? [])
  const ringing = sessions
    .filter((s) => s.bell)
    .map((s) => s.name)
    .sort()

  const row = (name: string) => {
    const s = byName.get(name)
    if (!s) return null
    const insight = insights.get(s.name)
    const title = insight ? displayTitle(headline(s), insight) : ''
    const info = title ? { text: title, live: true } : sessionSummary(s)
    const own = toneOf(s, insight, isFresh(s, insight, seenAt(s.name)), now)
    const tone = needs.has(s.name) && own !== 'waiting' && own !== 'error' ? 'bell' : own
    const why = needs.get(s.name) ?? whyOf(tone, insight)
    const bell = s.bell && tone !== 'bell'
    return (
      <li key={s.name}>
        <button
          type="button"
          className="session"
          data-tone={tone}
          aria-current={s.name === active ? 'true' : undefined}
          aria-disabled={s.attachable ? undefined : 'true'}
          title={s.attachable ? [s.name, info.text, s.path, s.attached ? `attached in ${s.clients > 1 ? `${s.clients} terminals` : 'a terminal'}` : ''].filter(Boolean).join('\n') : 'this name cannot be used from the web'}
          onClick={() => {
            if (s.attachable) onAttach(s.name)
          }}
        >
          <StateIcon tone={tone} />
          <span className="session-name">
            <Name name={s.name} />
          </span>
          {bell ? (
            <span className="session-bell">
              <Icon name="bell" size={14} />
            </span>
          ) : null}
          <span className="session-idle">{tone === 'quiet' ? `quiet ${ago(now, heardAt(s, insight))}` : ago(now, sinceOf(s, insight, lanes.get(s.name) ?? 'recent'))}</span>
          {why ? <span className="session-why">{why}</span> : null}
          <span className="visually-hidden">
            {STATES[tone] && !why ? `, ${STATES[tone]}` : ''}
            {bell ? ', bell' : ''}
            {s.attached ? ', attached' : ''}, {info.text}
          </span>
        </button>
      </li>
    )
  }

  return (
    <nav
      ref={navRef}
      aria-label="sessions"
      onMouseEnter={() => {
        pointerInside.current = true
      }}
      onMouseLeave={() => {
        pointerInside.current = false
        rerender()
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) rerender()
      }}
    >
      <div aria-live="polite" className="visually-hidden">
        {ringing.length > 0 ? `${ringing.join(', ')} needs attention` : ''}
      </div>
      {GROUPS.map(({ lane, title }) => {
        const names = placed(lane)
        if (names.length === 0 && (lane !== 'blocked' || others)) return null
        const open = lane !== 'parked' || parkedOpen
        const label = names.length ? (
          <>
            {title} <span className="session-count">{names.length}</span>
          </>
        ) : (
          'Nothing needs you'
        )
        return (
          <div key={lane} className="session-group" data-lane={lane} role="group" aria-labelledby={`${id}-${lane}`}>
            <h2 id={`${id}-${lane}`} className="session-group-head">
              {lane === 'parked' ? (
                <button type="button" aria-expanded={open} onClick={() => setParkedOpen(!open)}>
                  <Icon name="next" size={14} />
                  {label}
                </button>
              ) : (
                label
              )}
            </h2>
            {names.some((n) => open || n === active) ? (
              <ul className="session-list">{(open ? names : names.filter((n) => n === active)).map(row)}</ul>
            ) : null}
          </div>
        )
      })}
    </nav>
  )
}
