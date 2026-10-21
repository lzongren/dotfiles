import { useEffect, useId, useState, type ReactNode } from 'react'
import { createSession, explain, getWorkspaces } from '../api'
import type { AgentChoice, WorkspacesResponse } from '../shared/types'
import { SESSION_NAME_RE } from '../shared/validate'
import { AgentIcon, Icon, type AgentKind } from './Icon'

const KINDS: Array<{ agent: AgentChoice; kind: AgentKind; label: string; note: string }> = [
  { agent: 'shell', kind: 'shell', label: 'Shell', note: 'A terminal on the host, in that folder' },
  { agent: 'cc', kind: 'claude', label: 'Claude', note: 'A new Claude Code conversation there' },
  { agent: 'codex', kind: 'codex', label: 'Codex', note: 'A new Codex conversation there' },
]

export interface Place {
  key: string
  label: string
  stem: string
  join: string | null
  why: string
  caveat?: (flag: AgentChoice) => string
  at: { root: string } | { beside: string }
}

export function NewSession({
  places,
  taken,
  host,
  label,
  join,
  done,
  context,
  onCreated,
  onCancel,
}: {
  places: Place[]
  taken: string[]
  host: string
  label: string
  join: string
  done: string
  context: (place: Place | undefined) => ReactNode
  onCreated: (name: string, kind: AgentKind) => void
  onCancel: () => void
}) {
  const id = useId()
  const [agent, setAgent] = useState<AgentChoice>('cc')
  const [key, setKey] = useState(places[0]?.key ?? '')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const kind = KINDS.find((k) => k.agent === agent) ?? KINDS[0]
  const place = places.find((p) => p.key === key) ?? places[0]
  const suffix = agent === 'shell' ? 'sh' : kind.kind
  const full = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const slug = (full.length > 32 ? full.slice(0, 32).replace(/-[^-]*$/, '') : full).replace(/(?:-(?:the|a|an|for|to|of|and|in|on|with|at|by))+$/, '')
  const stem = slug || [place?.stem.slice(0, 60 - suffix.length - 1), suffix].filter(Boolean).join('-')
  const name = [stem, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${stem}-${n}`)].find((n) => !taken.includes(n)) ?? stem
  const submit = async () => {
    if (!place) return setError('There is no folder to start it in.')
    if (!SESSION_NAME_RE.test(name)) return setError('A name is letters, digits, - and _, up to 64, starting with a letter or digit.')
    setBusy(true)
    setError(null)
    const result = await createSession({ name, agent, ...place.at, ...(goal.trim() ? { goal: goal.trim() } : {}) })
    setBusy(false)
    if (result.kind !== 'ok') setError(explain(result))
    else if (!result.data.created) setError(`A session named ${name} is already running. Describe it differently.`)
    else onCreated(name, kind.kind)
  }
  return (
    <div className="work-new-wrap">
      <form
        className="work-new"
        aria-label={label}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <fieldset>
          <legend>Session type</legend>
          {KINDS.map((k) => (
            <label key={k.agent} className="work-kind">
              <input type="radio" name={`${id}-kind`} checked={agent === k.agent} onChange={() => setAgent(k.agent)} />
              <AgentIcon agent={k.kind} />
              <span>
                <strong>{k.label}</strong>
                <small>{k.note}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="work-field">
          <label htmlFor={`${id}-goal`}>Your goal for it (optional, for you only)</label>
          <input id={`${id}-goal`} type="text" placeholder="It names the session and shows beside it. It isn't sent to the agent." value={goal} onChange={(e) => setGoal(e.target.value)} />
          <small>Session name: {name}</small>
        </div>
        <div className="work-where">
          <div className="work-field">
            <label htmlFor={`${id}-host`}>Machine</label>
            <select id={`${id}-host`} disabled value={host}>
              <option value={host}>{host}</option>
            </select>
          </div>
          <div className="work-field">
            <label htmlFor={`${id}-folder`}>Folder</label>
            <select id={`${id}-folder`} value={place?.key ?? ''} onChange={(e) => setKey(e.target.value)}>
              {places.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="work-join" data-joins={place?.join ? true : undefined} role="status">
          <strong>{place?.join ? `${join} “${place.join}”` : 'Opens on its own page'}</strong>
          <span>{place?.why}</span>
        </p>
        <p className="lane-empty">
          {agent !== 'shell' && place?.caveat ? `${place.caveat(agent)} ` : ''}
          {done}
        </p>
        {error ? (
          <p className="return-notice" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flow-actions">
          <button type="submit" className="primary" disabled={busy}>
            Create {kind.label} session
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
      <aside className="work-context" aria-label="Current context">
        <h3>Current context</h3>
        {context(place)}
      </aside>
    </div>
  )
}

export function NewPage({ taken, host, onCreated, onBack }: { taken: string[]; host: string; onCreated: (name: string, kind: AgentKind) => void; onBack: () => void }) {
  const id = useId()
  const [found, setFound] = useState<WorkspacesResponse | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    void getWorkspaces().then((r) => (r.kind === 'ok' ? setFound(r.data) : setFailed(explain(r))))
  }, [])
  const places: Place[] = (found?.roots ?? []).map((r) => ({
    key: r.name,
    label: `${r.name} · a new folder named after the session`,
    stem: '',
    join: null,
    why: "A new folder has no pull request or branch yet, so it isn't grouped with other work. It joins work once it shares one.",
    at: { root: r.name },
  }))
  return (
    <section className="page" aria-labelledby={`${id}-title`}>
      <button type="button" className="link page-back" onClick={onBack}>
        <Icon name="back" />
        Back to Now
      </button>
      <h2 id={`${id}-title`} className="page-title">
        Start another piece of work
      </h2>
      <p className="page-sub">The sessions already running keep running.</p>
      {failed ? (
        <p className="return-notice" role="alert">
          Couldn't read the sync roots: {failed}
        </p>
      ) : null}
      {found && !places.length ? <p className="lane-empty">No sync root is set up, so there's nowhere to start a session yet.</p> : null}
      {places.length ? (
        <NewSession
          places={places}
          taken={[...taken, ...(found?.workspaces ?? []).map((w) => w.name)]}
          host={host}
          label="New session"
          join="Joins"
          done="Nothing is typed into it. It opens at its terminal, on a page of its own beside what holds and the evidence."
          context={() => <p className="lane-empty">Started from the top bar, so it isn't tied to any work. There's no project to pick or create first.</p>}
          onCreated={onCreated}
          onCancel={onBack}
        />
      ) : null}
    </section>
  )
}
