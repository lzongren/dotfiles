import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { getNote, getNoteDays, putNote, type ApiResult } from '../api'
import { ignoredTarget } from './Overview'

const SAVE_MS = 600
const RETRY_MS = 5000
const OPEN_KEY = 'devbox.notes.open'
const DRAFT = 'devbox.notes.draft.'
const OPEN_ITEM = /^\s*[-*] \[ \] .+$/gm

interface Draft {
  text: string
  base: string
}

const memory = new Map<string, Draft>()

const drafts = {
  get(day: string): Draft | undefined {
    if (memory.has(day)) return memory.get(day)
    try {
      const raw = JSON.parse(sessionStorage.getItem(DRAFT + day) ?? 'null') as Draft | null
      return raw && typeof raw.text === 'string' && typeof raw.base === 'string' ? raw : undefined
    } catch {
      return undefined
    }
  },
  set(day: string, draft: Draft): void {
    try {
      sessionStorage.setItem(DRAFT + day, JSON.stringify(draft))
      memory.delete(day)
    } catch {
      memory.set(day, draft)
    }
  },
  clear(day: string, ifText?: string): void {
    if (ifText !== undefined && drafts.get(day)?.text !== ifText) return
    memory.delete(day)
    try {
      sessionStorage.removeItem(DRAFT + day)
    } catch {
      void 0
    }
  },
  days(): string[] {
    const found = new Set(memory.keys())
    try {
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const key = sessionStorage.key(i)
        if (key?.startsWith(DRAFT)) found.add(key.slice(DRAFT.length))
      }
    } catch {
      void 0
    }
    return [...found].sort()
  },
}

export function localDay(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dayLabel(day: string, today: string): string {
  if (day === today) return 'Today'
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function openItems(text: string): string[] {
  return text.match(OPEN_ITEM) ?? []
}

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

function retriable(result: ApiResult<unknown>): boolean {
  return result.kind === 'network' || result.kind === 'unreachable' || (result.kind === 'error' && (result.status ?? 500) >= 500)
}

export function Notes() {
  const [today, setToday] = useState(localDay)
  const [day, setDay] = useState(today)
  const [text, setText] = useState('')
  const [days, setDays] = useState<string[]>([])
  const [loaded, setLoaded] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [carry, setCarry] = useState<{ from: string; items: string[] } | null>(null)
  const [saving, setSaving] = useState(false)
  const [offline, setOffline] = useState(false)
  const [reload, setReload] = useState(0)
  const [open, setOpen] = useState(readOpen)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const dayRef = useRef(day)
  const loadedRef = useRef(loaded)
  const textRef = useRef(text)
  const versions = useRef(new Map<string, string>())
  const rejected = useRef(new Map<string, { text: string; message: string }>())
  const conflicts = useRef(new Map<string, { text: string; version: string }>())
  const chain = useRef<Promise<void>>(Promise.resolve())
  const debounce = useRef<number | null>(null)
  const retry = useRef<number | null>(null)
  const disposed = useRef(false)
  const area = useRef<HTMLTextAreaElement | null>(null)
  const toggleRef = useRef<HTMLButtonElement | null>(null)
  dayRef.current = day
  loadedRef.current = loaded

  const pendingDays = () =>
    drafts.days().filter((d) => !conflicts.current.has(d) && rejected.current.get(d)?.text !== drafts.get(d)?.text)

  const save = useCallback((): Promise<void> => {
    for (const timer of [debounce, retry]) {
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
    }
    const step = async () => {
      let again = false
      for (const d of pendingDays()) {
        const draft = drafts.get(d)
        if (!draft) continue
        if (!disposed.current) setSaving(true)
        const result = await putNote(d, draft.text, draft.base)
        if (result.kind === 'ok') {
          const version = typeof result.data.version === 'string' ? result.data.version : ''
          versions.current.set(d, version)
          rejected.current.delete(d)
          const latest = drafts.get(d)
          if (latest?.text === draft.text) drafts.clear(d)
          else if (latest) drafts.set(d, { text: latest.text, base: version })
          setDays((prev) =>
            draft.text.trim() ? (prev.includes(d) ? prev : [...prev, d].sort().reverse()) : prev.filter((x) => x !== d),
          )
        } else if (result.kind === 'error' && result.status === 409) {
          const body = (result.body ?? {}) as { text?: unknown; version?: unknown }
          conflicts.current.set(d, {
            text: typeof body.text === 'string' ? body.text : '',
            version: typeof body.version === 'string' ? body.version : '',
          })
        } else if (retriable(result)) {
          again = true
        } else {
          rejected.current.set(d, { text: draft.text, message: result.kind === 'error' ? result.message : 'reload the dashboard' })
        }
      }
      if (disposed.current) return
      setSaving(false)
      setOffline(again)
      rerender()
      if (again) retry.current = window.setTimeout(() => void save(), RETRY_MS)
    }
    chain.current = chain.current.then(() => step().catch(() => undefined))
    return chain.current
  }, [])

  useEffect(() => {
    let live = true
    setLoaded(null)
    setLoadError(false)
    setCarry(null)
    void (async () => {
      await save()
      const result = await getNote(day)
      if (!live) return
      const ok = result.kind === 'ok' && typeof result.data.text === 'string'
      if (ok) versions.current.set(day, typeof result.data.version === 'string' ? result.data.version : '')
      const draft = drafts.get(day)
      if (!ok && !draft) {
        setLoadError(true)
        return
      }
      const server = ok ? result.data.text : ''
      const shown = draft?.text ?? server
      if (draft && draft.text === server) drafts.clear(day, server)
      setText(shown)
      textRef.current = shown
      setLoaded(day)
      if (draft && draft.text !== server) void save()
      const list = await getNoteDays()
      if (!live || list.kind !== 'ok' || !Array.isArray(list.data.days)) return
      setDays(list.data.days)
      const previous = list.data.days.find((d) => d < day)
      if (shown.trim() !== '' || !previous) return
      const before = await getNote(previous)
      const items = before.kind === 'ok' && typeof before.data.text === 'string' ? openItems(before.data.text) : []
      if (live && items.length > 0 && textRef.current.trim() === '') setCarry({ from: previous, items })
    })()
    return () => {
      live = false
    }
  }, [day, reload, save])

  useEffect(() => {
    const tick = window.setInterval(() => {
      const now = localDay()
      if (now === today) return
      setDay((current) => (current === today ? now : current))
      setToday(now)
    }, 60_000)
    return () => window.clearInterval(tick)
  }, [today])

  useEffect(() => {
    disposed.current = false
    const warn = (event: BeforeUnloadEvent) => {
      if (pendingDays().length > 0 || conflicts.current.size > 0) event.preventDefault()
    }
    const focusPad = (event: KeyboardEvent) => {
      if (event.key !== 'n' || event.metaKey || event.ctrlKey || event.altKey || ignoredTarget(event.target)) return
      event.preventDefault()
      setOpen(true)
      window.setTimeout(() => area.current?.focus(), 0)
    }
    window.addEventListener('beforeunload', warn)
    document.addEventListener('keydown', focusPad)
    return () => {
      window.removeEventListener('beforeunload', warn)
      document.removeEventListener('keydown', focusPad)
      void save()
      disposed.current = true
    }
  }, [save])

  const edit = (next: string) => {
    if (loadedRef.current !== day) return
    setText(next)
    textRef.current = next
    setCarry(null)
    drafts.set(day, { text: next, base: drafts.get(day)?.base ?? versions.current.get(day) ?? '' })
    rerender()
    if (debounce.current !== null) window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => void save(), SAVE_MS)
  }

  const resolve = (keep: boolean) => {
    const conflict = conflicts.current.get(day)
    if (!conflict) return
    conflicts.current.delete(day)
    versions.current.set(day, conflict.version)
    if (keep) {
      drafts.set(day, { text: textRef.current, base: conflict.version })
      void save()
    } else {
      drafts.clear(day)
      setText(conflict.text)
      textRef.current = conflict.text
    }
    rerender()
  }

  const toggle = () => {
    setOpen((was) => {
      try {
        localStorage.setItem(OPEN_KEY, was ? '0' : '1')
      } catch {
        void 0
      }
      return !was
    })
  }

  const timeline = [...new Set([today, day, ...days, ...drafts.days()])].sort().reverse()
  const index = timeline.indexOf(day)
  const older = timeline[index + 1]
  const newer = index > 0 ? timeline[index - 1] : undefined
  const remaining = openItems(text).length
  const label = dayLabel(day, today)
  const draft = drafts.get(day)
  const conflict = conflicts.current.get(day)
  const refusal = draft && rejected.current.get(day)?.text === draft.text ? rejected.current.get(day)!.message : null
  const others = pendingDays().filter((d) => d !== day).length
  const [shown, alarming] = loadError
    ? ["couldn't load this note", true]
    : loaded !== day
      ? ['', false]
      : conflict
        ? ['changed elsewhere', true]
        : refusal
          ? [`not saved: ${refusal}`, true]
          : draft
            ? offline
              ? ['not saved yet, retrying', true]
              : [saving ? 'saving…' : 'editing…', false]
            : offline && others > 0
              ? [`${others} other day${others === 1 ? '' : 's'} not saved yet, retrying`, true]
              : ['saved', false]

  return (
    <section className="notes" aria-label="notes">
      <header className="notes-head">
        <button ref={toggleRef} type="button" className="notes-toggle" aria-expanded={open} onClick={toggle}>
          Notes · {label}
          {remaining > 0 ? <span className="notes-count"> · {remaining} open</span> : null}
        </button>
        {open ? (
          <span className="notes-nav">
            <button type="button" aria-label="older notes" disabled={!older} onClick={() => older && setDay(older)}>
              ‹
            </button>
            <button type="button" aria-label="newer notes" disabled={!newer} onClick={() => newer && setDay(newer)}>
              ›
            </button>
          </span>
        ) : null}
      </header>
      {open ? (
        <>
          <textarea
            ref={area}
            className="notes-text"
            aria-label={`notes for ${label.toLowerCase()}`}
            placeholder={'What are you on today?\n- [ ] a thing to finish\n- [x] a thing done'}
            spellCheck
            readOnly={loaded !== day || conflict !== undefined}
            value={text}
            onChange={(e) => edit(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') toggleRef.current?.focus()
            }}
          />
          <footer className="notes-foot">
            {carry ? (
              <button
                type="button"
                className="notes-carry"
                onClick={() => {
                  const items = `${carry.items.join('\n')}\n`
                  edit(textRef.current.trim() ? `${textRef.current.replace(/\n*$/, '\n')}${items}` : items)
                }}
              >
                Carry over {carry.items.length} open from {dayLabel(carry.from, today)}
              </button>
            ) : null}
            {loadError ? (
              <button type="button" className="notes-carry" onClick={() => setReload((n) => n + 1)}>
                Retry
              </button>
            ) : null}
            {conflict ? (
              <>
                <button type="button" className="notes-carry" onClick={() => resolve(false)}>
                  Use saved
                </button>
                <button type="button" className="notes-carry" onClick={() => resolve(true)}>
                  Keep mine
                </button>
              </>
            ) : null}
            <span className={`notes-status${alarming ? ' notes-status-error' : ''}`}>{shown}</span>
            <span className="visually-hidden" role="status">
              {alarming ? shown : ''}
            </span>
          </footer>
        </>
      ) : null}
    </section>
  )
}
