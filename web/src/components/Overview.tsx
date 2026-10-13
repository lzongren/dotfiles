import { useEffect, useId, useReducer, useRef, useState } from 'react'
import type { AgentInsight, Artifact, Session } from '../shared/types'
import {
  artifactName,
  changeMark,
  displayTitle,
  isFresh,
  laneOf,
  ledger,
  modelName,
  projectOf,
  rankArtifacts,
  type Lane,
} from '../insights'
import { ago } from '../time'
import { headline } from './SessionList'
import { FileList, FilePreview, type FileRef } from './FilePreview'

interface Row {
  session: Session
  insight?: AgentInsight
  lane: Lane
  fresh: boolean
}

const AUTO_SEEN_MS = 2000
const LANES: Array<{ lane: Lane; title: string; empty: string }> = [
  { lane: 'blocked', title: 'Blocked on you', empty: 'No agent is waiting on you.' },
  { lane: 'ready', title: 'Ready to review', empty: 'Nothing new since you last looked.' },
  { lane: 'working', title: 'Working', empty: 'No agent is mid-turn.' },
  { lane: 'recent', title: 'Recent', empty: 'Nothing else active this week.' },
]
const ORDER: Record<Lane, (a: Row, b: Row) => number> = {
  blocked: (a, b) => changeMark(a.session, a.insight) - changeMark(b.session, b.insight),
  ready: (a, b) => changeMark(b.session, b.insight) - changeMark(a.session, a.insight),
  working: (a, b) => changeMark(a.session, a.insight) - changeMark(b.session, b.insight),
  recent: (a, b) => b.session.activityEpoch - a.session.activityEpoch,
  parked: (a, b) => b.session.activityEpoch - a.session.activityEpoch,
}

function stateLabel(row: Row): { text: string; tone: string } {
  const i = row.insight
  if (i?.state === 'waiting') return { text: i.waitingFor ? `waiting · ${i.waitingFor}` : 'waiting', tone: 'waiting' }
  if (i?.state === 'error') return { text: i.error ? `error · ${i.error}` : 'error', tone: 'error' }
  if (i?.state === 'working') return { text: 'working', tone: 'working' }
  if (i?.state === 'ready') return row.fresh ? { text: 'ready · new', tone: 'fresh' } : { text: 'ready', tone: 'idle' }
  if (row.session.bell) return { text: 'bell', tone: 'waiting' }
  return { text: row.session.cmd || 'shell', tone: 'idle' }
}

function ageOf(row: Row): number {
  return row.lane === 'recent' || row.lane === 'parked' ? row.session.activityEpoch : changeMark(row.session, row.insight)
}

function layout(rows: Row[]): Record<Lane, string[]> {
  const out: Record<Lane, string[]> = { blocked: [], ready: [], working: [], recent: [], parked: [] }
  for (const lane of Object.keys(out) as Lane[]) {
    out[lane] = rows
      .filter((r) => r.lane === lane)
      .sort((a, b) => ORDER[lane](a, b) || a.session.name.localeCompare(b.session.name))
      .map((r) => r.session.name)
  }
  return out
}

function hold(held: Record<Lane, string[]>, live: Record<Lane, string[]>): Record<Lane, string[]> {
  const exists = new Set(Object.values(live).flat())
  const placed = new Set(Object.values(held).flat())
  const out = { ...held }
  for (const lane of Object.keys(live) as Lane[]) {
    out[lane] = [...held[lane].filter((n) => exists.has(n)), ...live[lane].filter((n) => !placed.has(n))]
  }
  return out
}

function Card({
  row,
  now,
  selected,
  tabbable,
  onSelect,
}: {
  row: Row
  now: number
  selected: boolean
  tabbable: boolean
  onSelect: () => void
}) {
  const id = useId()
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
        aria-pressed={selected}
        aria-labelledby={`${id}-title`}
        aria-describedby={insight?.summary ? `${id}-state ${id}-summary` : `${id}-state`}
        tabIndex={tabbable ? 0 : -1}
        onClick={onSelect}
      >
        <span className="card-top">
          <span id={`${id}-state`} className={`chip chip-${state.tone}`}>
            {state.text}
          </span>
          <span id={`${id}-title`} className="card-title">
            {title || session.name}
          </span>
          <span className="card-age">{ago(now, ageOf(row))}</span>
        </span>
        {insight?.summary ? (
          <span id={`${id}-summary`} className="card-summary">
            {insight.summary}
          </span>
        ) : null}
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
          {insight?.files?.length ? (
            <span>
              {insight.files.length} file{insight.files.length === 1 ? '' : 's'}
            </span>
          ) : null}
          {insight?.model ? <span>{modelName(insight.model)}</span> : null}
        </span>
      </button>
    </li>
  )
}

function ArtifactList({
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
            {artifactName(a)}
            {a.key ? (
              <span className="artifact-key" title="named in the summary">
                {' '}
                ★
              </span>
            ) : null}
            <span className="visually-hidden">{a.key ? ' (named in the summary)' : ''} (opens in a new tab)</span>
          </a>
          {a.action ? <span className="artifact-note">{a.action}</span> : null}
          {a.hits > 1 ? <span className="artifact-note">×{a.hits}</span> : null}
          {a.session ? <span className="artifact-session">{a.session}</span> : null}
          <span className="artifact-note">{ago(now, a.session ? a.first : a.at)}</span>
        </li>
      ))}
    </ul>
  )
}

function Detail({
  row,
  now,
  onOpen,
  onSeen,
  onPick,
}: {
  row: Row
  now: number
  onOpen: () => void
  onSeen: () => void
  onPick: (file: FileRef) => void
}) {
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
          <span className={`chip chip-${state.tone}`}>{state.text}</span> {ago(now, changeMark(session, insight))} ago
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
            <dd>
              {insight.summary}
              {insight.summaryAt ? <span className="when"> · {ago(now, insight.summaryAt)} ago</span> : null}
            </dd>
          </>
        ) : null}
        {tasks ? (
          <>
            <dt>Tasks</dt>
            <dd>
              <progress max={tasks.total} value={tasks.done} aria-label={`${tasks.done} of ${tasks.total} tasks done`} />{' '}
              {tasks.done}/{tasks.total}
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
        {insight?.files?.length ? (
          <>
            <dt>Files</dt>
            <dd>
              <FileList
                files={insight.files.map((f) => ({ ...f, session: session.name, cwd: session.path }))}
                now={now}
                onPick={onPick}
              />
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

export function ignoredTarget(target: EventTarget | null): boolean {
  return (
    document.querySelector('dialog[open]') !== null ||
    (target instanceof Element && target.closest('input, textarea, select, [contenteditable], .terminals, a, summary, .detail-actions') !== null)
  )
}

export function Overview({
  sessions,
  insights,
  now,
  seenAt,
  visible = true,
  notice,
  onOpen,
  onSeen,
}: {
  sessions: Session[]
  insights: Map<string, AgentInsight>
  now: number
  seenAt: (name: string) => number
  visible?: boolean
  notice?: string | null
  onOpen: (name: string) => void
  onSeen: (names: string[]) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [parkedOpen, setParkedOpen] = useState(false)
  const [preview, setPreview] = useState<FileRef | null>(null)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const lanesRef = useRef<HTMLDivElement | null>(null)
  const pointerInside = useRef(false)
  const held = useRef<Record<Lane, string[]> | null>(null)
  const refocus = useRef(false)
  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined)

  const rows = new Map<string, Row>(
    sessions.map((session) => {
      const insight = insights.get(session.name)
      const seen = seenAt(session.name)
      return [
        session.name,
        { session, insight, lane: laneOf(session, insight, seen, now), fresh: isFresh(session, insight, seen) },
      ]
    }),
  )
  const live = layout([...rows.values()])
  const holding = pointerInside.current || (lanesRef.current?.contains(document.activeElement) ?? false)
  const placed = holding && held.current ? hold(held.current, live) : live
  if (!holding) held.current = live
  const lane = (l: Lane) => placed[l].map((n) => rows.get(n)).filter((r): r is Row => r !== undefined)
  const groups = new Map<string, Row[]>()
  for (const row of lane('recent')) {
    const key = projectOf(row.session.path)
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const order = [
    ...lane('blocked'),
    ...lane('ready'),
    ...lane('working'),
    ...[...groups.values()].flat(),
    ...(parkedOpen ? lane('parked') : []),
  ].map((r) => r.session.name)
  const current = selected === null ? null : (rows.get(selected) ?? null)
  const tabStop = current && order.includes(current.session.name) ? current.session.name : order[0]
  const readyNames = lane('ready')
    .filter((r) => r.fresh)
    .map((r) => r.session.name)

  useEffect(() => {
    if (!refocus.current || selected === null) return
    refocus.current = false
    lanesRef.current?.querySelector<HTMLElement>(`.card[data-session="${CSS.escape(selected)}"]`)?.focus()
  })

  const currentName = current?.session.name
  const currentFresh = current?.fresh === true
  useEffect(() => {
    if (!visible || !currentFresh || currentName === undefined) return
    const timer = setTimeout(() => onSeen([currentName]), AUTO_SEEN_MS)
    return () => clearTimeout(timer)
  }, [visible, currentName, currentFresh, onSeen])

  keys.current = (event: KeyboardEvent) => {
    if (!visible || event.metaKey || event.ctrlKey || event.altKey || ignoredTarget(event.target)) return
    const index = selected === null ? -1 : order.indexOf(selected)
    if (event.key === 'j' || event.key === 'k') {
      const next = order[Math.min(order.length - 1, Math.max(0, index + (event.key === 'j' ? 1 : -1)))]
      if (!next) return
      refocus.current = true
      setSelected(next)
    } else if (event.key === 'Enter' && !event.repeat && current?.session.attachable) {
      const onCard = event.target instanceof Element && event.target.closest('.card') !== null
      if (!onCard && event.target !== document.body) return
      onOpen(current.session.name)
    } else if (event.key === 'e' && current) {
      refocus.current = true
      onSeen([current.session.name])
    } else {
      return
    }
    event.preventDefault()
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event)
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [])

  const card = (row: Row) => (
    <Card
      key={row.session.name}
      row={row}
      now={now}
      selected={row.session.name === selected}
      tabbable={row.session.name === tabStop}
      onSelect={() => setSelected(row.session.name)}
    />
  )
  const artifacts = ledger([...rows.values()].map((r) => ({ name: r.session.name, artifacts: r.insight?.artifacts ?? [] })))
  const recentFiles = [...rows.values()]
    .flatMap((r) => (r.insight?.files ?? []).map((f) => ({ ...f, session: r.session.name, cwd: r.session.path, label: r.session.name })))
    .filter((f) => !f.gone)
    .sort((a, b) => b.at - a.at)
    .slice(0, 12)

  return (
    <section className="overview" aria-label="overview">
      <div
        ref={lanesRef}
        className="lanes"
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
        <p className="overview-notice" role="status" hidden={!notice}>
          {notice}
        </p>
        {LANES.map(({ lane: l, title, empty }) => (
          <section key={l} className="lane" aria-labelledby={`lane-${l}`}>
            <div className="lane-head">
              <h2 id={`lane-${l}`} className="lane-title">
                {title} <span className="lane-count">{placed[l].length}</span>
              </h2>
              {l === 'ready' && readyNames.length > 1 ? (
                <button type="button" className="lane-action" onClick={() => onSeen(readyNames)}>
                  Mark all seen
                </button>
              ) : null}
            </div>
            {placed[l].length === 0 ? <p className="lane-empty">{empty}</p> : null}
            {l === 'recent' ? (
              [...groups.entries()].map(([project, items]) => (
                <div key={project} className="group">
                  <h3 className="group-title">{project}</h3>
                  <ul className="cards">{items.map(card)}</ul>
                </div>
              ))
            ) : (
              <ul className="cards">{lane(l).map(card)}</ul>
            )}
          </section>
        ))}
        {placed.parked.length > 0 ? (
          <section className="lane" aria-labelledby="lane-parked">
            <details open={parkedOpen} onToggle={(e) => setParkedOpen(e.currentTarget.open)}>
              <summary className="parked-toggle">
                <h2 id="lane-parked" className="lane-title">
                  Parked · idle over a week <span className="lane-count">{placed.parked.length}</span>
                </h2>
              </summary>
              <ul className="cards">{lane('parked').map(card)}</ul>
            </details>
          </section>
        ) : null}
      </div>
      <aside className="detail" aria-label="session details">
        {current ? (
          <Detail
            row={current}
            now={now}
            onOpen={() => onOpen(current.session.name)}
            onSeen={() => onSeen([current.session.name])}
            onPick={setPreview}
          />
        ) : (
          <div className="detail-body">
            <h2>Latest artifacts</h2>
            {selected !== null ? <p className="lane-empty">{selected} has ended.</p> : null}
            {artifacts.length > 0 ? (
              <ArtifactList artifacts={artifacts} now={now} />
            ) : (
              <p className="lane-empty">No pull requests or reviews seen yet.</p>
            )}
            {recentFiles.length > 0 ? (
              <>
                <h2 className="detail-section">Recent files</h2>
                <FileList files={recentFiles} now={now} onPick={setPreview} />
              </>
            ) : null}
            <p className="hint">
              Select a session to see where it stands. <kbd>j</kbd>/<kbd>k</kbd> move, <kbd>Enter</kbd> opens,{' '}
              <kbd>e</kbd> marks seen.
            </p>
          </div>
        )}
      </aside>
      {preview ? <FilePreview file={preview} onClose={() => setPreview(null)} /> : null}
    </section>
  )
}
