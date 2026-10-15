import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createSession, getWorkspaces } from '../api'
import type { AgentChoice, Session, Workspace } from '../shared/types'
import { isValidSessionName } from '../shared/validate'
import { ago } from '../time'
import { Icon } from './Icon'

interface Item {
  key: string
  kind: 'live' | 'folder' | 'create'
  name: string
  root: string | null
  ts: number
}

const MAX_ITEMS = 15

const AGENTS: Array<{ value: AgentChoice; label: string }> = [
  { value: 'cc', label: 'claude' },
  { value: 'codex', label: 'codex' },
  { value: 'shell', label: 'shell' },
]

export function buildItems(
  query: string,
  sessions: Session[],
  workspaces: Workspace[],
  createRoot: string | null,
): Item[] {
  const q = query.trim().toLowerCase()
  const live = new Map(sessions.filter((s) => s.attachable).map((s) => [s.name, s]))
  const items: Item[] = []
  const seen = new Set<string>()
  for (const w of workspaces) {
    const session = live.get(w.name)
    items.push({
      key: `w:${w.root}:${w.name}`,
      kind: session ? 'live' : 'folder',
      name: w.name,
      root: w.root,
      ts: Math.max(w.mtime, session?.activityEpoch ?? 0),
    })
    seen.add(w.name)
  }
  for (const s of live.values()) {
    if (!seen.has(s.name)) items.push({ key: `s:${s.name}`, kind: 'live', name: s.name, root: null, ts: s.activityEpoch })
  }
  const matched = items
    .filter((item) => item.name.toLowerCase().includes(q))
    .sort((a, b) => b.ts - a.ts || a.name.localeCompare(b.name))
    .slice(0, MAX_ITEMS)
  const typed = query.trim().toLowerCase()
  const exact = items.some((item) => item.name.toLowerCase() === typed)
  if (q !== '' && !exact && createRoot !== null && isValidSessionName(query.trim())) {
    matched.push({ key: 'create', kind: 'create', name: query.trim(), root: createRoot, ts: 0 })
  }
  return matched
}

export function WorkspacePalette({
  sessions,
  now,
  onOpen,
  onSessionsChanged,
}: {
  sessions: Session[]
  now: number
  onOpen: (name: string) => void
  onSessionsChanged?: () => void
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [roots, setRoots] = useState<string[]>([])
  const [root, setRoot] = useState<string | null>(null)
  const [agent, setAgent] = useState<AgentChoice>('cc')
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listId = useId()

  const refresh = useCallback(async () => {
    const result = await getWorkspaces()
    if (result.kind !== 'ok') return
    setWorkspaces(result.data.workspaces)
    const names = result.data.roots.map((r) => r.name)
    setRoots(names)
    setRoot((prev) => (prev !== null && names.includes(prev) ? prev : (names[0] ?? null)))
  }, [])

  useEffect(() => {
    void refresh()
    const onFocus = () => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const active = document.activeElement as HTMLElement | null
      if (active && (active.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName))) return
      event.preventDefault()
      inputRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const items = useMemo(() => buildItems(query, sessions, workspaces, root), [query, sessions, workspaces, root])
  const found = items.findIndex((item) => item.key === selectedKey)
  const index = found === -1 ? 0 : found
  const current = items[index]
  const move = (delta: number) => {
    const next = items[Math.min(Math.max(index + delta, 0), Math.max(0, items.length - 1))]
    if (next) setSelectedKey(next.key)
  }

  const activate = async (item: Item) => {
    setError(null)
    if (item.kind === 'live') {
      setQuery('')
      setSelectedKey(null)
      inputRef.current?.blur()
      onOpen(item.name)
      return
    }
    const target = item.root ?? root
    if (target === null) {
      setError('no sync root configured')
      return
    }
    setBusy(item.name)
    const result = await createSession({ name: item.name, root: target, agent })
    setBusy(null)
    if (result.kind === 'ok') {
      setQuery('')
      setSelectedKey(null)
      inputRef.current?.blur()
      void refresh()
      onSessionsChanged?.()
      onOpen(item.name)
    } else if (result.kind === 'unauthorized') {
      setError('server restarted — run devbox web')
    } else {
      setError(result.message)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (current && busy === null) void activate(current)
    } else if (event.key === 'Escape') {
      setQuery('')
      setSelectedKey(null)
      setError(null)
      inputRef.current?.blur()
    }
  }

  return (
    <section
      className="palette"
      aria-label="workspaces"
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setOpen(false)
        setError(null)
      }}
    >
      <div className="palette-bar">
        <span className="palette-field">
          <Icon name="search" />
          <input
            ref={inputRef}
            className="palette-input"
            type="text"
            role="combobox"
            aria-expanded={open && items.length > 0}
            aria-controls={listId}
            aria-activedescendant={open && current ? `${listId}-${current.key}` : undefined}
            aria-label="search or create a workspace"
            placeholder="Search or create a workspace"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelectedKey(null)
              setError(null)
            }}
            onKeyDown={onKeyDown}
            onFocus={() => setOpen(true)}
          />
          <kbd aria-hidden="true">/</kbd>
        </span>
        <div
          role="radiogroup"
          aria-label="agent"
          className="palette-agents"
          onMouseDown={(event) => event.preventDefault()}
        >
          {AGENTS.map((a) => (
            <label key={a.value} className="palette-agent" data-checked={agent === a.value}>
              <input
                type="radio"
                name="agent"
                value={a.value}
                checked={agent === a.value}
                onChange={() => setAgent(a.value)}
              />
              {a.label}
            </label>
          ))}
        </div>
        {roots.length > 1 ? (
          <select aria-label="sync root" value={root ?? ''} onChange={(event) => setRoot(event.target.value)}>
            {roots.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="palette-pop" hidden={!open || (items.length === 0 && error === null)}>
      {error !== null ? (
        <p role="alert" className="banner palette-error">
          {error}
        </p>
      ) : null}
      <ul
        id={listId}
        role="listbox"
        className="palette-list"
        hidden={items.length === 0}
        onMouseDown={(event) => event.preventDefault()}
      >
        {items.map((item) => (
          <li
            key={item.key}
            id={`${listId}-${item.key}`}
            role="option"
            aria-selected={item === current}
            className="palette-item"
            data-kind={item.kind}
            onMouseEnter={() => setSelectedKey(item.key)}
            onClick={() => {
              if (busy === null) void activate(item)
            }}
          >
            <span className="palette-dot">
              <Icon name={item.kind === 'live' ? 'terminal' : item.kind === 'create' ? 'plus' : 'folder'} size={14} />
            </span>
            <span className="palette-name">
              {item.kind === 'create' ? `create ${item.name}` : item.name}
            </span>
            <span className="palette-root">{item.root ?? ''}</span>
            <span className="palette-age">{item.kind === 'create' ? '' : ago(now, item.ts)}</span>
            <span className="palette-hint">
              {busy === item.name ? 'starting…' : item.kind === 'live' ? 'attach' : `start ${agent === 'cc' ? 'claude' : agent}`}
            </span>
          </li>
        ))}
      </ul>
      </div>
    </section>
  )
}
