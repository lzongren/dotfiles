import { useEffect, useId, useRef, useState } from 'react'
import type { AgentInsight, ReturnSummary, Session } from '../shared/types'
import { displayTitle, isFresh, laneOf, type Lane } from '../insights'
import { AgentIcon, agentOf, Icon, toneOf } from './Icon'
import { titleOf } from './PickUp'
import { headline } from './SessionList'
import { returnNote, returnNotes, type HomeItem } from './work'

const ORDER: Lane[] = ['blocked', 'working', 'ready', 'recent', 'parked']

export const workFor = (works: HomeItem[], name: string) => works.find((w) => w.session.name === name || w.brief?.work.members.some((m) => m.name === name))

function stateOf(session: Session, insight: AgentInsight | undefined, fresh: boolean, now: number, summary?: ReturnSummary): string {
  const notes = returnNotes(summary)
  if (notes.length) return notes.join(' · ')
  const tone = toneOf(session, insight, fresh, now)
  if (tone === 'waiting') return `Waiting on you${insight?.waitingFor ? `: ${insight.waitingFor}` : ''}`
  if (tone === 'error') return insight?.error ? `Error: ${insight.error}` : 'Error'
  if (tone === 'bell') return 'Bell rang'
  if (tone === 'working' || tone === 'quiet') return 'Working'
  if (tone === 'fresh') return 'New turn'
  return insight ? 'Idle, its turn is done' : 'Idle'
}

function rowKeys(event: KeyboardEvent, list: HTMLElement | null, search: HTMLElement | null) {
  const letter = event.key === 'j' || event.key === 'k'
  if ((!letter && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || event.metaKey || event.ctrlKey || event.altKey || !list) return
  const rows = [...list.querySelectorAll<HTMLElement>('[data-row]:not(:disabled)')]
  const at = rows.indexOf(document.activeElement as HTMLElement)
  const typing = event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable], dialog[open]') !== null
  if (letter ? typing : at < 0 && !(event.target === search && event.key === 'ArrowDown')) return
  const next = rows[at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (event.key === 'j' || event.key === 'ArrowDown' ? 1 : -1)))]
  if (!next) return
  event.preventDefault()
  next.focus()
  next.scrollIntoView?.({ block: 'nearest' })
}

export function SessionsPage({
  sessions,
  insights,
  now,
  seenAt,
  returns,
  host,
  works,
  visible,
  onOpen,
  onBack,
}: {
  sessions: Session[]
  insights: Map<string, AgentInsight>
  now: number
  seenAt: (name: string) => number
  returns: Record<string, ReturnSummary>
  host: string
  works: HomeItem[]
  visible: boolean
  onOpen: (name: string) => void
  onBack: () => void
}) {
  const id = useId()
  const [query, setQuery] = useState('')
  const list = useRef<HTMLUListElement | null>(null)
  const search = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (!visible) return
    const listener = (event: KeyboardEvent) => rowKeys(event, list.current, search.current)
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [visible])

  const rows = sessions
    .map((session) => {
      const insight = insights.get(session.name)
      const seen = seenAt(session.name)
      const fresh = isFresh(session, insight, seen)
      const work = workFor(works, session.name)
      const own = works.find((w) => w.session.name === session.name)
      const note = returnNote(returns[session.name])
      return {
        session,
        insight,
        title: displayTitle(headline(session), insight) || session.name,
        work: work ? titleOf(work) : '',
        lane: own?.attention === 'needs' ? 'blocked' : laneOf(session, insight, seen, now),
        tone: note ? undefined : (own?.tone ?? toneOf(session, insight, fresh, now)),
        state: own?.tone === 'error' && !note ? own.status : stateOf(session, insight, fresh, now, returns[session.name]),
      }
    })
    .sort((a, b) => ORDER.indexOf(a.lane) - ORDER.indexOf(b.lane) || b.session.activityEpoch - a.session.activityEpoch)
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = rows.filter((r) => {
    const text = [r.session.name, r.title, r.session.path, r.work, returns[r.session.name]?.goal].join(' ').toLowerCase()
    return words.every((w) => text.includes(w))
  })

  return (
    <section className="page" aria-labelledby={`${id}-title`}>
      <button type="button" className="link page-back" onClick={onBack}>
        <Icon name="back" />
        Back to Now
      </button>
      <h2 id={`${id}-title`} className="page-title">
        All sessions <span className="lane-count">{sessions.length}</span>
      </h2>
      <p className="page-sub">Each session keeps its own records. Grouping them into work never moves or closes one.</p>
      <label className="page-search">
        <Icon name="search" />
        <input ref={search} type="search" aria-label="Search sessions" placeholder="Search sessions, folders or work" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <p className="page-count" aria-live="polite">
        {shown.length} result{shown.length === 1 ? '' : 's'}
        <span className="page-keys"> · ↓ from the search box, then j and k between rows, Enter to open</span>
      </p>
      <ul ref={list} className="page-rows">
        {shown.map((r) => (
          <li key={r.session.name}>
            <button type="button" className="page-row" data-row data-session={r.session.name} disabled={!r.session.attachable} onClick={() => onOpen(r.session.name)}>
              <AgentIcon agent={agentOf(r.session, r.insight)} />
              <span className="page-row-main">
                <strong>{r.title}</strong>
                <small>{[r.title === r.session.name ? '' : r.session.name, host, r.session.path, r.insight?.agent === 'codex' ? 'Codex: no brief or repair yet' : ''].filter(Boolean).join(' · ')}</small>
                {returns[r.session.name]?.goal ? <small>Your goal: {returns[r.session.name]?.goal}</small> : null}
              </span>
              <span className="page-row-work" data-none={r.work ? undefined : 'true'}>
                {r.work || 'Nothing new'}
              </span>
              <span className="page-row-state" data-lane={r.lane} data-tone={r.tone}>
                {r.state}
              </span>
              <Icon name="next" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
