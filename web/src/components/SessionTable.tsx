import type { Session } from '../shared/types'

export function ago(nowMs: number, activityEpoch: number): string {
  const d = Math.max(0, Math.floor(nowMs / 1000) - activityEpoch)
  if (d < 60) return `${d}s`
  if (d < 3600) return `${Math.floor(d / 60)}m`
  if (d < 86400) return `${Math.floor(d / 3600)}h`
  return `${Math.floor(d / 86400)}d`
}

export function SessionTable({
  sessions,
  now,
  onAttach,
}: {
  sessions: Session[]
  now: number
  onAttach: (name: string) => void
}) {
  if (sessions.length === 0) {
    return (
      <p className="empty">
        No sessions. Run <code>devbox &lt;name&gt;</code> to start one.
      </p>
    )
  }
  const ringing = sessions.filter((s) => s.bell).map((s) => s.name)
  return (
    <>
      <div aria-live="polite" className="visually-hidden">
        {ringing.length > 0 ? `${ringing.join(', ')} needs attention` : ''}
      </div>
      <table>
        <thead>
          <tr>
            <th scope="col">state</th>
            <th scope="col">session</th>
            <th scope="col">idle</th>
            <th scope="col">cmd</th>
            <th scope="col">path</th>
            <th scope="col">bell</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr
              key={s.name}
              className={s.attachable ? undefined : 'unattachable'}
              title={s.attachable ? undefined : 'this name cannot be used from the web'}
            >
              <td className="state">
                {s.attached ? '●' : '○'}
                {s.clients > 1 ? <span className="clients">×{s.clients}</span> : null}
              </td>
              <td className="name">
                {s.attachable ? (
                  <button type="button" className="attach" onClick={() => onAttach(s.name)}>
                    {s.name}
                  </button>
                ) : (
                  s.name
                )}
              </td>
              <td className="idle">{ago(now, s.activityEpoch)}</td>
              <td className="cmd">{s.cmd}</td>
              <td className="path">{s.path}</td>
              <td className="bell">{s.bell ? <span className="bell-badge">bell</span> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
