import type { Session } from '../shared/types'
import { ago } from '../time'

export function headline(session: Session): string {
  return session.title.replace(/^[^\p{L}\p{N}]+/u, '').trim()
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
  if (sessions.length === 0) {
    return <p className="empty">No sessions yet. Type a name above to start one.</p>
  }
  const sorted = [...sessions].sort((a, b) => b.activityEpoch - a.activityEpoch || a.name.localeCompare(b.name))
  const ringing = sorted.filter((s) => s.bell).map((s) => s.name)
  return (
    <nav aria-label="sessions">
      <div aria-live="polite" className="visually-hidden">
        {ringing.length > 0 ? `${ringing.join(', ')} needs attention` : ''}
      </div>
      <ul className="session-list">
        {sorted.map((s) => {
          const text = headline(s)
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
                <span className={text ? 'session-headline' : 'session-headline session-headline-empty'}>
                  {text || [s.cmd, s.path].filter(Boolean).join(' · ')}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
