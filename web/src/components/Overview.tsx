import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { AgentInsight, Artifact, Session } from '../shared/types'
import { artifactName, displayTitle, laneOf, modelName, projectOf, rankArtifacts, unread, type Lane } from '../insights'
import { ago } from '../time'
import { headline } from './SessionList'

interface Row {
  session: Session
  insight?: AgentInsight
  lane: Lane
  fresh: boolean
}

const LANES: Array<{ lane: Lane; title: string; empty: string }> = [
  { lane: 'needs', title: 'Needs you', empty: 'Nothing is waiting on you.' },
  { lane: 'working', title: 'Working', empty: 'No agent is mid-turn.' },
  { lane: 'recent', title: 'Recent', empty: 'Nothing else active this week.' },
]

function stateLabel(row: Row): { text: string; tone: string } {
  const i = row.insight
  if (i?.state === 'waiting') return { text: i.waitingFor ? `waiting · ${i.waitingFor}` : 'waiting', tone: 'waiting' }
  if (i?.state === 'error') return { text: i.error ? `error · ${i.error}` : 'error', tone: 'error' }
  if (i?.state === 'working') return { text: 'working', tone: 'working' }
  if (i?.state === 'ready') return row.fresh ? { text: 'ready · new', tone: 'fresh' } : { text: 'ready', tone: 'idle' }
  if (row.session.bell) return { text: 'bell', tone: 'waiting' }
  return { text: row.session.cmd || 'shell', tone: 'idle' }
}

function changedAt(row: Row): number {
  return row.insight?.since ?? row.insight?.summaryAt ?? row.session.activityEpoch
}

function Card({ row, now, selected, onSelect }: { row: Row; now: number; selected: boolean; onSelect: () => void }) {
  const { session, insight } = row
  const state = stateLabel(row)
  const title = displayTitle(headline(session), insight)
  const notable = rankArtifacts(insight?.artifacts ?? [], insight?.summary).filter((a) => a.key || a.said)
  const shown = notable.slice(0, 3)
  return (
    <li>
      <button
        type="button"
        className="card"
        data-session={session.name}
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
      >
        <span className="card-top">
          <span className={`chip chip-${state.tone}`}>{state.text}</span>
          <span className="card-title">{title || session.name}</span>
          <span className="card-age">{ago(now, changedAt(row))}</span>
        </span>
        {insight?.summary ? <span className="card-summary">{insight.summary}</span> : null}
        <span className="card-meta">
          {title ? <span>{session.name}</span> : null}
          {insight?.tasks ? (
            <span>
              {insight.tasks.done}/{insight.tasks.total} tasks
            </span>
          ) : null}
          {shown.map((a) => (
            <span key={a.url} className="pill">
              {artifactName(a)}
            </span>
          ))}
          {notable.length > shown.length ? <span>+{notable.length - shown.length}</span> : null}
          {insight?.model ? <span>{modelName(insight.model)}</span> : null}
        </span>
      </button>
    </li>
  )
}

function ArtifactList({ artifacts, now }: { artifacts: Array<Artifact & { session?: string; key?: boolean }>; now: number }) {
  return (
    <ul className="artifact-list">
      {artifacts.map((a) => (
        <li key={`${a.session ?? ''}${a.url}`} data-key={a.key ? 'true' : undefined}>
          <a href={a.url} target="_blank" rel="noreferrer noopener">
            {artifactName(a)}
          </a>
          {a.action ? <span className="artifact-action">{a.action}</span> : null}
          {a.hits > 1 ? <span className="artifact-action">×{a.hits}</span> : null}
          {a.session ? <span className="artifact-session">{a.session}</span> : null}
          <span className="artifact-age">{ago(now, a.at)}</span>
        </li>
      ))}
    </ul>
  )
}

function Detail({ row, now, onOpen, onSeen }: { row: Row; now: number; onOpen: () => void; onSeen: () => void }) {
  const { session, insight } = row
  const state = stateLabel(row)
  const tasks = insight?.tasks
  return (
    <article className="detail-body" aria-label={`${session.name} details`}>
      <header className="detail-head">
        <h2>{displayTitle(headline(session), insight) || session.name}</h2>
        <p className="detail-sub">
          {session.name} · {session.path}
        </p>
        <div className="detail-actions">
          <button type="button" className="primary" onClick={onOpen} disabled={!session.attachable}>
            Open terminal
          </button>
          {row.fresh ? (
            <button type="button" onClick={onSeen}>
              Mark seen
            </button>
          ) : null}
        </div>
      </header>
      <dl className="facts">
        <dt>State</dt>
        <dd>
          <span className={`chip chip-${state.tone}`}>{state.text}</span> {ago(now, changedAt(row))} ago
        </dd>
        {insight?.firstAsk ? (
          <>
            <dt>Goal</dt>
            <dd>{insight.firstAsk}</dd>
          </>
        ) : null}
        {insight?.ask && insight.ask !== insight.firstAsk ? (
          <>
            <dt>Latest ask</dt>
            <dd>
              {insight.ask}
              {insight.askAt ? <span className="when"> · {ago(now, insight.askAt)} ago</span> : null}
            </dd>
          </>
        ) : null}
        {insight?.summary ? (
          <>
            <dt>Where it stands</dt>
            <dd className="detail-summary">
              {insight.summary}
              {insight.summaryAt ? <span className="when"> · {ago(now, insight.summaryAt)} ago</span> : null}
            </dd>
          </>
        ) : null}
        {tasks ? (
          <>
            <dt>Tasks</dt>
            <dd>
              <progress max={tasks.total} value={tasks.done} aria-label="tasks done" /> {tasks.done}/{tasks.total}
              {tasks.current ? <span className="when"> · now: {tasks.current}</span> : null}
            </dd>
          </>
        ) : null}
        {insight && insight.artifacts.length > 0 ? (
          <>
            <dt>Artifacts</dt>
            <dd>
              <ArtifactList artifacts={rankArtifacts(insight.artifacts, insight.summary).slice(0, 15)} now={now} />
            </dd>
          </>
        ) : null}
        <dt>Agent</dt>
        <dd>
          {insight ? [insight.agent, insight.model && modelName(insight.model)].filter(Boolean).join(' · ') : session.cmd}
          {insight?.branch ? ` · ${insight.branch}` : ''}
          {insight?.commits ? ` · ${insight.commits} commit${insight.commits === 1 ? '' : 's'}` : ''}
        </dd>
      </dl>
    </article>
  )
}

export function Overview({
  sessions,
  insights,
  now,
  seenAt,
  notice,
  onOpen,
  onSeen,
}: {
  sessions: Session[]
  insights: Map<string, AgentInsight>
  now: number
  seenAt: (name: string) => number
  notice?: string | null
  onOpen: (name: string) => void
  onSeen: (name: string) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [parkedOpen, setParkedOpen] = useState(false)
  const rootRef = useRef<HTMLElement | null>(null)
  const moved = useRef(false)
  useEffect(() => {
    if (!moved.current || selected === null) return
    moved.current = false
    rootRef.current?.querySelector<HTMLElement>(`.card[data-session="${CSS.escape(selected)}"]`)?.focus()
  }, [selected])
  const rows: Row[] = sessions.map((session) => {
    const insight = insights.get(session.name)
    const seen = seenAt(session.name)
    return {
      session,
      insight,
      lane: laneOf(session, insight, seen, now),
      fresh: insight?.state === 'ready' && unread(insight, seen),
    }
  })
  const byLane = (lane: Lane) => rows.filter((r) => r.lane === lane)
  const needs = byLane('needs').sort((a, b) => changedAt(a) - changedAt(b) || a.session.name.localeCompare(b.session.name))
  const working = byLane('working').sort((a, b) => changedAt(a) - changedAt(b) || a.session.name.localeCompare(b.session.name))
  const recent = byLane('recent').sort((a, b) => b.session.activityEpoch - a.session.activityEpoch)
  const parked = byLane('parked').sort((a, b) => b.session.activityEpoch - a.session.activityEpoch)
  const groups = new Map<string, Row[]>()
  for (const row of recent) {
    const key = projectOf(row.session.path)
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const lanes: Record<Lane, Row[]> = { needs, working, recent: [...groups.values()].flat(), parked }
  const visible = [...needs, ...working, ...lanes.recent, ...(parkedOpen ? parked : [])].map((r) => r.session.name)
  const current = rows.find((r) => r.session.name === selected) ?? null
  const ledger = rows
    .flatMap((r) => (r.insight?.artifacts ?? []).filter((a) => a.said).map((a) => ({ ...a, session: r.session.name })))
    .sort((a, b) => b.at - a.at)
    .slice(0, 12)

  const card = (row: Row) => (
    <Card
      key={row.session.name}
      row={row}
      now={now}
      selected={row.session.name === selected}
      onSelect={() => setSelected(row.session.name)}
    />
  )
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLElement && event.target.closest('a, input, textarea, select, summary')) return
    const index = selected === null ? -1 : visible.indexOf(selected)
    if (event.key === 'j' || event.key === 'k') {
      const next = visible[Math.min(visible.length - 1, Math.max(0, index + (event.key === 'j' ? 1 : -1)))]
      if (!next) return
      moved.current = true
      setSelected(next)
    } else if (
      event.key === 'Enter' &&
      current?.session.attachable &&
      (event.target as HTMLElement).closest('.card')?.getAttribute('data-session') === current.session.name
    ) {
      onOpen(current.session.name)
    } else if (event.key === 'e' && current) {
      onSeen(current.session.name)
    } else {
      return
    }
    event.preventDefault()
  }

  return (
    <section ref={rootRef} className="overview" aria-label="overview" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="lanes">
        {notice ? <p className="overview-notice">{notice}</p> : null}
        {LANES.map(({ lane, title, empty }) => (
          <section key={lane} className="lane" aria-labelledby={`lane-${lane}`}>
            <h2 id={`lane-${lane}`} className="lane-title">
              {title} <span className="lane-count">{lanes[lane].length}</span>
            </h2>
            {lanes[lane].length === 0 ? <p className="lane-empty">{empty}</p> : null}
            {lane === 'recent' ? (
              [...groups.entries()].map(([project, items]) => (
                <div key={project} className="group">
                  <h3 className="group-title">{project}</h3>
                  <ul className="cards">{items.map(card)}</ul>
                </div>
              ))
            ) : (
              <ul className="cards">{lanes[lane].map(card)}</ul>
            )}
          </section>
        ))}
        {parked.length > 0 ? (
          <details className="lane parked" open={parkedOpen} onToggle={(e) => setParkedOpen(e.currentTarget.open)}>
            <summary className="lane-title">
              Parked · idle over a week <span className="lane-count">{parked.length}</span>
            </summary>
            <ul className="cards">{parked.map(card)}</ul>
          </details>
        ) : null}
      </div>
      <aside className="detail" aria-label="session details">
        {current ? (
          <Detail
            row={current}
            now={now}
            onOpen={() => onOpen(current.session.name)}
            onSeen={() => onSeen(current.session.name)}
          />
        ) : (
          <div className="detail-body">
            <h2>Latest artifacts</h2>
            {ledger.length > 0 ? (
              <ArtifactList artifacts={ledger} now={now} />
            ) : (
              <p className="lane-empty">No pull requests or reviews seen yet.</p>
            )}
            <p className="hint">
              Select a session to see where it stands. <kbd>j</kbd>/<kbd>k</kbd> move, <kbd>Enter</kbd> opens,{' '}
              <kbd>e</kbd> marks seen.
            </p>
          </div>
        )}
      </aside>
    </section>
  )
}
