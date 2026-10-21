import type { AgentInsight, Artifact, ReturnSummary, Session } from '../shared/types'
import { artifactName, displayTitle, laneOf } from '../insights'
import { ago } from '../time'
import { headline } from './SessionList'
import { Icon } from './Icon'
import { PickUpList } from './PickUp'
import { returnNote, type HomeItem } from './work'

export function ArtifactList({
  artifacts,
  now,
}: {
  artifacts: Array<Artifact & { session?: string; key?: boolean }>
  now: number
}) {
  return (
    <ul className="artifact-list">
      {artifacts.map((a) => (
        <li key={`${a.session ?? ''}${a.url}`}>
          <a href={a.url} target="_blank" rel="noreferrer noopener">
            <Icon name="pr" size={14} />
            {artifactName(a)}
            {a.key ? (
              <span className="artifact-key" title="named in the summary">
                {' '}
                ★
              </span>
            ) : null}
            <span className="visually-hidden">{a.key ? ' (named in the summary)' : ''} (opens in a new tab)</span>
          </a>
          {a.action ? <span className="artifact-note">{a.action}{a.session ? ' by' : ''}</span> : a.session ? <span className="artifact-note">from</span> : null}
          {a.session ? <span className="artifact-session">{a.session}</span> : null}
          <span className="artifact-note">{ago(now, a.first)} ago</span>
          {a.hits > 1 ? <span className="artifact-note">· named {a.hits} times</span> : null}
        </li>
      ))}
    </ul>
  )
}

export function ignoredTarget(target: EventTarget | null): boolean {
  return (
    document.querySelector('dialog[open]') !== null ||
    (target instanceof Element && target.closest('input, textarea, select, [contenteditable], .terminals, a, summary, .detail-actions, .theme-picker') !== null)
  )
}

export function Overview({
  sessions,
  insights,
  now,
  seenAt,
  pickups,
  visited,
  onOpen,
  onPickUp,
  onAll,
  host = '',
  connected = true,
  returns = {},
  covered = [],
}: {
  sessions: Session[]
  insights: Map<string, AgentInsight>
  now: number
  seenAt: (name: string) => number
  pickups: HomeItem[]
  visited: string[]
  onOpen: (name: string) => void
  onPickUp: (name: string) => void
  onAll: () => void
  host?: string
  connected?: boolean
  returns?: Record<string, ReturnSummary>
  covered?: string[]
}) {
  const listed = new Set(pickups.flatMap((i) => [i.session.name, ...(i.brief?.work.members.map((m) => m.name) ?? [])]))
  const others = sessions.filter((s) => !listed.has(s.name) && !covered.includes(s.name))
  const need = others.filter((s) => laneOf(s, insights.get(s.name), seenAt(s.name), now) === 'blocked').length
  const seen = visited.flatMap((name) => {
    const session = sessions.find((s) => s.name === name)
    return session && !listed.has(name) ? [{ name, title: displayTitle(headline(session), insights.get(name)) || name }] : []
  })
  const today = new Date(now)
  return (
    <section className="overview" aria-label="overview">
      <p className="home-date">
        <time dateTime={today.toISOString().slice(0, 10)}>{today.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</time>{' '}
        <span>{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
        {host ? (
          <span className="home-cover" data-ok={connected}>
            <span className="dot" aria-hidden="true" />
            {connected ? `Reading ${host}` : `Not reaching ${host}`} · {sessions.length} session{sessions.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </p>
      <PickUpList items={pickups} now={now} elsewhere={need} onContinue={onPickUp} onOpen={onOpen} />
      {seen.length ? (
        <details className="home-seen quiet" open={seen.some((s) => returnNote(returns[s.name])) || undefined}>
          <summary>
            Seen this visit <span className="lane-count">{seen.length}</span>
          </summary>
          <ul>
            {seen.map((s) => (
              <li key={s.name}>
                <button type="button" className="link" onClick={() => onPickUp(s.name)}>
                  {s.title}
                </button>
                {returnNote(returns[s.name]) ? <small> · {returnNote(returns[s.name])}</small> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <button type="button" className="pickup-all" onClick={onAll}>
        {others.length ? `${others.length} other session${others.length === 1 ? '' : 's'}` : 'No other sessions'}
        {others.length ? need ? <span className="pickup-all-need"> · {need} need{need === 1 ? 's' : ''} you</span> : ' · none need you' : null}
        <span className="visually-hidden"> · </span>
        <span className="pickup-all-go">
          View all <Icon name="next" size={14} />
        </span>
      </button>
    </section>
  )
}
