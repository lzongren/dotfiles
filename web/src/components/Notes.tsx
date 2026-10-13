import { useCallback, useEffect, useRef, useState } from 'react'
import { getNote, getNoteDays, putNote, type ApiResult } from '../api'
import { ignoredTarget } from './Overview'

const SAVE_MS = 600
const RETRY_MS = 5000
const OPEN_KEY = 'devbox.notes.open'
const DRAFT = 'devbox.notes.draft.'
const OPEN_ITEM = /^\s*[-*] \[ \] .+$/gm

type Status = 'loading' | 'load-error' | 'saved' | 'unsaved' | 'saving' | 'offline' | 'rejected'

const memory = new Map<string, string>()

const drafts = {
  get(day: string): string | undefined {
    if (memory.has(day)) return memory.get(day)
    try {
      return localStorage.getItem(DRAFT + day) ?? undefined
    } catch {
      return undefined
    }
  },
  set(day: string, text: string): void {
    try {
      localStorage.setItem(DRAFT + day, text)
      memory.delete(day)
    } catch {
      memory.set(day, text)
    }
  },
  clear(day: string, ifText?: string): void {
    if (ifText !== undefined && drafts.get(day) !== ifText) return
    memory.delete(day)
    try {
      localStorage.removeItem(DRAFT + day)
    } catch {
      void 0
    }
  },
  days(): string[] {
    const found = new Set(memory.keys())
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)
        if (key?.startsWith(DRAFT)) found.add(key.slice(DRAFT.length))
      }
    } catch {
      void 0
    }
    return [...found]
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
  const [carry, setCarry] = useState<{ from: string; items: string[] } | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [problem, setProblem] = useState('')
  const [reload, setReload] = useState(0)
  const [open, setOpen] = useState(readOpen)
  const dayRef = useRef(day)
  const textRef = useRef(text)
  const chain = useRef<Promise<void>>(Promise.resolve())
  const debounce = useRef<number | null>(null)
  const retry = useRef<number | null>(null)
  const disposed = useRef(false)
  const area = useRef<HTMLTextAreaElement | null>(null)
  const toggleRef = useRef<HTMLButtonElement | null>(null)
  dayRef.current = day

  const save = useCallback((): Promise<void> => {
    for (const timer of [debounce, retry]) {
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
    }
    chain.current = chain.current.then(async () => {
      let failure: ApiResult<unknown> | null = null
      for (const d of drafts.days()) {
        const body = drafts.get(d)
        if (body === undefined) continue
        if (d === dayRef.current) setStatus('saving')
        const result = await putNote(d, body)
        if (result.kind !== 'ok') {
          failure = result
          break
        }
        drafts.clear(d, body)
        setDays((prev) => (body.trim() ? (prev.includes(d) ? prev : [...prev, d].sort().reverse()) : prev.filter((x) => x !== d)))
      }
      if (disposed.current) return
      const current = dayRef.current
      if (drafts.get(current) === undefined) {
        setStatus('saved')
      } else if (failure && retriable(failure)) {
        setStatus('offline')
        retry.current = window.setTimeout(() => void save(), RETRY_MS)
      } else if (failure) {
        setStatus('rejected')
        setProblem(failure.kind === 'error' ? failure.message : 'the dashboard needs a reload')
      } else {
        setStatus('unsaved')
      }
    })
    return chain.current
  }, [])

  useEffect(() => {
    let live = true
    setStatus('loading')
    setCarry(null)
    void (async () => {
      await save()
      if (!live) return
      const local = drafts.get(day)
      const result = await getNote(day)
      if (!live) return
      const ok = result.kind === 'ok' && typeof result.data.text === 'string'
      if (!ok && local === undefined) {
        setStatus('load-error')
        return
      }
      const server = ok ? result.data.text : ''
      const shown = local ?? server
      setText(shown)
      textRef.current = shown
      if (local !== undefined && local !== server) {
        setStatus('unsaved')
        void save()
      } else {
        drafts.clear(day)
        setStatus('saved')
      }
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
      if (drafts.days().length > 0) event.preventDefault()
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
    setText(next)
    textRef.current = next
    setCarry(null)
    drafts.set(day, next)
    setStatus('unsaved')
    if (debounce.current !== null) window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => void save(), SAVE_MS)
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

  const timeline = [...new Set([today, day, ...days])].sort().reverse()
  const index = timeline.indexOf(day)
  const older = timeline[index + 1]
  const newer = index > 0 ? timeline[index - 1] : undefined
  const remaining = openItems(text).length
  const label = dayLabel(day, today)
  const shownStatus = {
    loading: '',
    'load-error': "couldn't load this note",
    saved: 'saved',
    unsaved: 'editing…',
    saving: 'saving…',
    offline: 'not saved yet, retrying',
    rejected: `not saved: ${problem}`,
  }[status]
  const alarming = status === 'load-error' || status === 'offline' || status === 'rejected'

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
            readOnly={status === 'loading' || status === 'load-error'}
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
            {status === 'load-error' ? (
              <button type="button" className="notes-carry" onClick={() => setReload((n) => n + 1)}>
                Retry
              </button>
            ) : null}
            <span className={`notes-status${alarming ? ' notes-status-error' : ''}`}>{shownStatus}</span>
            <span className="visually-hidden" role="status">
              {alarming ? shownStatus : ''}
            </span>
          </footer>
        </>
      ) : null}
    </section>
  )
}
