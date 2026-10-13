import { useReducer, useRef } from 'react'
import type { AgentInsight, Session } from '../shared/types'
import { displayTitle } from '../insights'
import { ago } from '../time'

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

function byRecency(sessions: Session[]): string[] {
  return [...sessions]
    .sort((a, b) => b.activityEpoch - a.activityEpoch || a.name.localeCompare(b.name))
    .map((s) => s.name)
}

const ATTENTION: Partial<Record<AgentInsight['state'], string>> = { waiting: 'waiting', working: 'working', error: 'error' }

export function SessionList({
  sessions,
  insights = new Map(),
  now,
  active,
  onAttach,
}: {
  sessions: Session[]
  insights?: Map<string, AgentInsight>
  now: number
  active: string | null
  onAttach: (name: string) => void
}) {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const navRef = useRef<HTMLElement | null>(null)
  const pointerInside = useRef(false)
  const held = useRef<string[]>([])

  if (sessions.length === 0) {
    pointerInside.current = false
    held.current = []
    return <p className="empty">No sessions yet. Type a name above to start one.</p>
  }

  const byName = new Map(sessions.map((s) => [s.name, s]))
  const live = byRecency(sessions)
  const focusInside = navRef.current?.contains(document.activeElement) ?? false
  const holding = pointerInside.current || focusInside
  if (!holding) held.current = live
  const order = holding
    ? [...held.current.filter((n) => byName.has(n)), ...live.filter((n) => !held.current.includes(n))]
    : live
  const ringing = sessions
    .filter((s) => s.bell)
    .map((s) => s.name)
    .sort()

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
      <ul className="session-list">
        {order.map((name) => {
          const s = byName.get(name)
          if (!s) return null
          const insight = insights.get(s.name)
          const title = insight ? displayTitle(headline(s), insight) : ''
          const info = title ? { text: title, live: true } : sessionSummary(s)
          const attention = insight ? ATTENTION[insight.state] : undefined
          return (
            <li key={s.name}>
              <button
                type="button"
                className="session"
                aria-current={s.name === active ? 'true' : undefined}
                aria-disabled={s.attachable ? undefined : 'true'}
                title={s.attachable ? s.path : 'this name cannot be used from the web'}
                onClick={() => {
                  if (s.attachable) onAttach(s.name)
                }}
              >
                <span className="session-top">
                  <span className="session-state">
                    {s.attached ? '●' : '○'}
                    {s.clients > 1 ? <span className="clients">×{s.clients}</span> : null}
                  </span>
                  <span className="session-name">{s.name}</span>
                  {attention ? <span className={`chip chip-${attention}`}>{attention}</span> : null}
                  {s.bell ? <span className="bell-badge">bell</span> : null}
                  <span className="session-idle">{ago(now, s.activityEpoch)}</span>
                </span>
                <span className={info.live ? 'session-headline' : 'session-headline session-headline-dim'}>
                  {info.text}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
