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
  shownArtifacts,
  type Lane,
} from '../insights'
import { mmr, rarity, sharedRarest, similarity, topicsOf, words } from '../topics'
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
type Kind = 'needs' | 'working' | 'recent' | 'parked'
interface Shelf {
  kind: Kind
  key: string
  label: string
  names: string[]
}
const SECTIONS: Array<{ kind: Exclude<Kind, 'parked'>; title: string; empty: string }> = [
  { kind: 'needs', title: 'Needs you', empty: 'No agent is waiting on you.' },
  { kind: 'working', title: 'Working', empty: 'No agent is mid-turn.' },
  { kind: 'recent', title: 'Topics', empty: 'Nothing else active this week.' },
]
const KINDS: Kind[] = [...SECTIONS.map((s) => s.kind), 'parked']
const byChange = (dir: 1 | -1) => (a: Row, b: Row) => dir * (changeMark(a.session, a.insight) - changeMark(b.session, b.insight))
const byActivity = (a: Row, b: Row) => b.session.activityEpoch - a.session.activityEpoch
const shelfId = (s: Shelf) => `${s.kind}:${s.key}`

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

function layout(rows: Row[]): Shelf[] {
  const pick = (lane: Lane, sort: (a: Row, b: Row) => number) =>
    rows.filter((r) => r.lane === lane).sort((a, b) => sort(a, b) || a.session.name.localeCompare(b.session.name))
  const names = (list: Row[]) => list.map((r) => r.session.name)
  const tokens = new Map(
    rows.map((r) => {
      const name = words(r.session.name)
      const tagged = new Set([...name, ...words(projectOf(r.session.path))])
      return [r, { name, tagged, titled: new Set([...tagged, ...words(displayTitle(headline(r.session), r.insight))]) }]
    }),
  )
  const none = { name: new Set<string>(), tagged: new Set<string>(), titled: new Set<string>() }
  const tok = (r: Row) => tokens.get(r) ?? none
  const corpus = rows.map((r) => tok(r).name)
  const kin = sharedRarest(rows.map((r) => tok(r).tagged))
  const weight = rarity(rows.map((r) => tok(r).titled))
  const ready = pick('ready', byChange(-1))
  const picks = mmr(
    ready,
    (_, i) => 1 - i / ready.length,
    (a, b) => Math.max(kin(tok(a).tagged, tok(b).tagged), similarity(tok(a).titled, tok(b).titled, weight)),
  )
  const shelves = (kind: Kind, lane: Lane) =>
    topicsOf(pick(lane, byActivity), (r) => tok(r).name, corpus).map((t) => ({
      kind,
      key: t.key,
      label: t.label,
      names: names(t.items),
    }))
  return [
    { kind: 'needs', key: 'blocked', label: '', names: names(pick('blocked', byChange(1))) },
    { kind: 'needs', key: 'ready', label: '', names: names(picks) },
    { kind: 'working', key: '', label: '', names: names(pick('working', byChange(1))) },
    ...shelves('recent', 'recent'),
    ...shelves('parked', 'parked'),
  ]
}

function hold(held: Shelf[], live: Shelf[]): Shelf[] {
  const exists = new Set(live.flatMap((s) => s.names))
  const placed = new Set(held.flatMap((s) => s.names))
  const arrived = (s: Shelf | undefined) => (s ? s.names.filter((n) => !placed.has(n)) : [])
  const kept = held.map((s) => ({
    ...s,
    names: [...s.names.filter((n) => exists.has(n)), ...arrived(live.find((l) => shelfId(l) === shelfId(s)))],
  }))
  const added = live.filter((l) => !held.some((s) => shelfId(s) === shelfId(l))).map((l) => ({ ...l, names: arrived(l) }))
  return [...kept, ...added]
    .filter((s) => s.names.length > 0 || s.kind === 'needs' || s.kind === 'working')
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || Number(a.key === '') - Number(b.key === ''))
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
  const shown = shownArtifacts(insight)
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
              <ArtifactList artifacts={shown} now={now} />
              {insight.artifacts.length > shown.length ? <p className="lane-empty">{insight.artifacts.length - shown.length} more not shown</p> : null}
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
  const id = useId()
  const [selected, setSelected] = useState<string | null>(null)
  const [parkedOpen, setParkedOpen] = useState(false)
  const [preview, setPreview] = useState<FileRef | null>(null)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const lanesRef = useRef<HTMLDivElement | null>(null)
  const pointerInside = useRef(false)
  const held = useRef<Shelf[] | null>(null)
  const refocus = useRef<string | null>(null)
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
  const shown = placed
    .filter((s) => s.kind !== 'parked' || parkedOpen)
    .map((s) => ({ ...s, rows: s.names.map((n) => rows.get(n)).filter((r): r is Row => r !== undefined) }))
  const of = (kind: Kind) => shown.filter((s) => s.kind === kind)
  const count = (kind: Kind) => placed.filter((s) => s.kind === kind).reduce((n, s) => n + s.names.length, 0)
  const order = shown.flatMap((s) => s.rows.map((r) => r.session.name))
  const current = selected === null ? null : (rows.get(selected) ?? null)
  const tabStop = current && order.includes(current.session.name) ? current.session.name : order[0]
  const readyNames = of('needs')
    .flatMap((s) => s.rows)
    .filter((r) => r.lane === 'ready' && r.fresh)
    .map((r) => r.session.name)

  const focusCard = (name: string) => {
    const card = lanesRef.current?.querySelector<HTMLElement>(`.card[data-session="${CSS.escape(name)}"]`)
    card?.focus({ preventScroll: true })
    card?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }
  useEffect(() => {
    if (refocus.current === null) return
    const name = refocus.current
    refocus.current = null
    focusCard(name)
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
    const focused = event.target instanceof Element ? event.target.closest<HTMLElement>('.card') : null
    const onCard = focused !== null
    const from = focused?.dataset.session ?? selected
    const index = from === null || from === undefined ? -1 : order.indexOf(from)
    const target = onCard && from ? rows.get(from) : current
    const arrows = !event.shiftKey && (onCard || event.target === document.body)
    const step = event.key === 'j' || (arrows && event.key === 'ArrowRight') ? 1 : event.key === 'k' || (arrows && event.key === 'ArrowLeft') ? -1 : 0
    if (step !== 0) {
      const next = order[Math.min(order.length - 1, Math.max(0, index + step))]
      if (!next || (onCard && next === from)) return
      if (next === selected) focusCard(next)
      else {
        refocus.current = next
        setSelected(next)
      }
    } else if (event.key === 'Enter' && !event.repeat && target?.session.attachable) {
      if (!onCard && event.target !== document.body) return
      onOpen(target.session.name)
    } else if (event.key === 'e' && target) {
      refocus.current = target.session.name
      onSeen([target.session.name])
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
  const shelf = (kind: Kind) =>
    of(kind).map((s) => {
      const heading = `${id}-${kind}-${s.key || 'other'}`
      return (
        <div key={shelfId(s)} className="group">
          <h3 id={heading} className="group-title">
            {s.label} <span className="lane-count">{s.rows.length}</span>
          </h3>
          <ul className="cards shelf" aria-labelledby={heading}>
            {s.rows.map(card)}
          </ul>
        </div>
      )
    })
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
        {SECTIONS.map(({ kind, title, empty }) => (
          <section key={kind} className="lane" aria-labelledby={`lane-${kind}`}>
            <div className="lane-head">
              <h2 id={`lane-${kind}`} className="lane-title">
                {title} <span className="lane-count">{count(kind)}</span>
              </h2>
              {kind === 'needs' && readyNames.length > 1 ? (
                <button type="button" className="lane-action" onClick={() => onSeen(readyNames)}>
                  Mark all seen
                </button>
              ) : null}
            </div>
            {count(kind) === 0 ? <p className="lane-empty">{empty}</p> : null}
            {kind === 'recent' ? shelf('recent') : <ul className="cards">{of(kind).flatMap((s) => s.rows).map(card)}</ul>}
          </section>
        ))}
        {count('parked') > 0 ? (
          <section className="lane" aria-labelledby="lane-parked">
            <details open={parkedOpen} onToggle={(e) => setParkedOpen(e.currentTarget.open)}>
              <summary className="parked-toggle">
                <h2 id="lane-parked" className="lane-title">
                  Parked · idle over a week <span className="lane-count">{count('parked')}</span>
                </h2>
              </summary>
              {shelf('parked')}
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
              Select a session to see where it stands. <kbd>j</kbd>/<kbd>k</kbd> or <kbd>←</kbd>/<kbd>→</kbd> move, <kbd>Enter</kbd> opens,{' '}
              <kbd>e</kbd> marks seen.
            </p>
          </div>
        )}
      </aside>
      {preview ? (
        <FilePreview
          key={`${preview.session}${preview.path}`}
          file={preview}
          known={(rows.get(preview.session)?.insight?.files ?? []).map((f) => f.path)}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </section>
  )
}
