import { useRef, useState } from 'react'
import type { Session } from '../shared/types'
import { ago } from '../time'

const AGENT_COMMANDS = ['claude', 'codex']

export function headline(session: Session): string {
  return (session.title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim()
}

export function describe(session: Session): { text: string; live: boolean } {
  const title = headline(session)
  if (title && AGENT_COMMANDS.includes(session.cmd)) return { text: title, live: true }
  if (title) return { text: `last: ${title}`, live: false }
  return { text: [session.cmd, session.path].filter(Boolean).join(' · '), live: false }
}

function byRecency(sessions: Session[]): string[] {
  return [...sessions]
    .sort((a, b) => b.activityEpoch - a.activityEpoch || a.name.localeCompare(b.name))
    .map((s) => s.name)
}

export function SessionList({
  sessions,
  now,
  active,
  onAttach,
}: {
  sessions: Session[]
  now: number
  active: string | null
  onAttach: (name: string) => void
}) {
  const [frozen, setFrozen] = useState<string[] | null>(null)
  const pointerInside = useRef(false)
  const focusInside = useRef(false)

  if (sessions.length === 0) {
    return <p className="empty">No sessions yet. Type a name above to start one.</p>
  }

  const byName = new Map(sessions.map((s) => [s.name, s]))
  const live = byRecency(sessions)
  const order = frozen === null ? live : [...frozen.filter((n) => byName.has(n)), ...live.filter((n) => !frozen.includes(n))]
  const ringing = sessions
    .filter((s) => s.bell)
    .map((s) => s.name)
    .sort()

  const hold = () => setFrozen((prev) => prev ?? live)
  const release = () => {
    if (!pointerInside.current && !focusInside.current) setFrozen(null)
  }

  return (
    <nav
      aria-label="sessions"
      onMouseEnter={() => {
        pointerInside.current = true
        hold()
      }}
      onMouseLeave={() => {
        pointerInside.current = false
        release()
      }}
      onFocus={() => {
        focusInside.current = true
        hold()
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        focusInside.current = false
        release()
      }}
    >
      <div aria-live="polite" className="visually-hidden">
        {ringing.length > 0 ? `${ringing.join(', ')} needs attention` : ''}
      </div>
      <ul className="session-list">
        {order.map((name) => {
          const s = byName.get(name)
          if (!s) return null
          const info = describe(s)
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
