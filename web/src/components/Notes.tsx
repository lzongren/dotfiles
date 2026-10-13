import { useCallback, useEffect, useRef, useState } from 'react'
import { getNote, getNoteDays, putNote, type ApiResult } from '../api'
import { ignoredTarget } from './Overview'

const SAVE_MS = 600
const RETRY_MS = 5000
const OPEN_KEY = 'devbox.notes.open'
const DRAFT = 'devbox.notes.draft.'
const LEGACY_BASE = '\u0000legacy'
const OPEN_ITEM = /^\s*[-*] \[ \] .+$/gm

interface Draft {
  day: string
  text: string
  base: string
}

type Phase = 'idle' | 'saving' | 'offline' | 'rejected' | 'conflict'

function readDraft(day: string): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT + day)
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw) as Partial<Draft> | null
      if (parsed && typeof parsed.text === 'string' && typeof parsed.base === 'string') return { day, text: parsed.text, base: parsed.base }
    } catch {
      void 0
    }
    return { day, text: raw, base: LEGACY_BASE }
  } catch {
    return null
  }
}

function writeDraft(draft: Draft): void {
  try {
    localStorage.setItem(DRAFT + draft.day, JSON.stringify({ text: draft.text, base: draft.base }))
  } catch {
    void 0
  }
}

function dropDraft(day: string, ifText?: string): void {
  try {
    if (ifText !== undefined && readDraft(day)?.text !== ifText) return
    localStorage.removeItem(DRAFT + day)
  } catch {
    void 0
  }
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
  const [draft, setDraftState] = useState<Draft | null>(null)
  const [phase, setPhaseState] = useState<Phase>('idle')
  const [problem, setProblem] = useState('')
  const [conflict, setConflict] = useState<{ text: string; version: string } | null>(null)
  const [reload, setReload] = useState(0)
  const [open, setOpen] = useState(readOpen)
  const draftRef = useRef<Draft | null>(null)
  const phaseRef = useRef<Phase>('idle')
  const refusedText = useRef<string | null>(null)
  const versionRef = useRef('')
  const textRef = useRef('')
  const loadedRef = useRef<string | null>(null)
  const chain = useRef<Promise<void>>(Promise.resolve())
  const debounce = useRef<number | null>(null)
  const retry = useRef<number | null>(null)
  const disposed = useRef(false)
  const area = useRef<HTMLTextAreaElement | null>(null)
  const toggleRef = useRef<HTMLButtonElement | null>(null)
  loadedRef.current = loaded

  const setDraft = (next: Draft | null) => {
    draftRef.current = next
    if (next) writeDraft(next)
    setDraftState(next)
  }
  const setPhase = (next: Phase) => {
    phaseRef.current = next
    setPhaseState(next)
  }

  const save = useCallback((): Promise<void> => {
    for (const timer of [debounce, retry]) {
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
    }
    const step = async () => {
      const job = draftRef.current
      if (!job || phaseRef.current === 'conflict' || refusedText.current === job.text) return
      if (!disposed.current) setPhase('saving')
      const result = await putNote(job.day, job.text, job.base)
      const body = result.kind === 'error' ? ((result.body ?? {}) as { text?: unknown; version?: unknown }) : {}
      const landed =
        result.kind === 'ok' ? (typeof result.data.version === 'string' ? result.data.version : '') : result.kind === 'error' && result.status === 409 && body.text === job.text ? String(body.version ?? '') : null
      if (landed !== null) {
        dropDraft(job.day, job.text)
        if (disposed.current) return
        versionRef.current = landed
        refusedText.current = null
        const current = draftRef.current
        if (current?.text === job.text) setDraft(null)
        else if (current) setDraft({ ...current, base: landed })
        setDays((prev) => (job.text.trim() ? (prev.includes(job.day) ? prev : [...prev, job.day].sort().reverse()) : prev.filter((d) => d !== job.day)))
        setPhase('idle')
        return
      }
      if (disposed.current) return
      if (result.kind === 'error' && result.status === 409) {
        setConflict({ text: typeof body.text === 'string' ? body.text : '', version: typeof body.version === 'string' ? body.version : '' })
        setPhase('conflict')
      } else if (retriable(result)) {
        setPhase('offline')
        retry.current = window.setTimeout(() => void save(), RETRY_MS)
      } else {
        refusedText.current = job.text
        setProblem(result.kind === 'error' ? result.message : 'reload the dashboard')
        setPhase('rejected')
      }
    }
    chain.current = chain.current.then(step).catch(() => undefined)
    return chain.current
  }, [])

  const go = async (target: string | undefined) => {
    if (!target) return
    await save()
    if (!draftRef.current) setDay(target)
  }

  useEffect(() => {
    let live = true
    setLoaded(null)
    setLoadError(false)
    setCarry(null)
    setConflict(null)
    setPhase('idle')
    refusedText.current = null
    void (async () => {
      const result = await getNote(day)
      if (!live) return
      const ok = result.kind === 'ok' && typeof result.data.text === 'string'
      let stored = readDraft(day)
      if (!ok && !stored) {
        setLoadError(true)
        return
      }
      const server = ok ? result.data.text : null
      versionRef.current = ok ? (typeof result.data.version === 'string' ? result.data.version : '') : (stored?.base ?? '')
      if (stored && server !== null && stored.text === server) {
        dropDraft(day, server)
        stored = null
      }
      const shown = stored?.text ?? server ?? ''
      setText(shown)
      textRef.current = shown
      setDraft(stored)
      setLoaded(day)
      if (stored) void save()
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
  }, [day, reload])

  useEffect(() => {
    const tick = window.setInterval(() => {
      const now = localDay()
      if (now === today || draftRef.current) return
      setDay((current) => (current === today ? now : current))
      setToday(now)
    }, 60_000)
    return () => window.clearInterval(tick)
  }, [today])

  useEffect(() => {
    disposed.current = false
    const warn = (event: BeforeUnloadEvent) => {
      if (draftRef.current) event.preventDefault()
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
    if (loadedRef.current !== day || phaseRef.current === 'conflict') return
    setText(next)
    textRef.current = next
    setCarry(null)
    setDraft({ day, text: next, base: draftRef.current?.base ?? versionRef.current })
    if (phaseRef.current === 'rejected' && refusedText.current !== next) setPhase('idle')
    if (debounce.current !== null) window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => void save(), SAVE_MS)
  }

  const resolve = (keep: boolean) => {
    if (!conflict) return
    versionRef.current = conflict.version
    setConflict(null)
    setPhase('idle')
    if (keep && draftRef.current) {
      setDraft({ ...draftRef.current, base: conflict.version })
      void save()
    } else {
      dropDraft(day)
      setDraft(null)
      setText(conflict.text)
      textRef.current = conflict.text
    }
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
  const [shown, alarming] = loadError
    ? ["couldn't load this note", true]
    : loaded !== day
      ? ['', false]
      : phase === 'conflict'
        ? ['changed elsewhere', true]
        : phase === 'rejected'
          ? [`not saved: ${problem}`, true]
          : phase === 'offline'
            ? ['not saved yet, retrying', true]
            : draft
              ? [phase === 'saving' ? 'saving…' : 'editing…', false]
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
            <button type="button" aria-label="older notes" disabled={!older} onClick={() => void go(older)}>
              ‹
            </button>
            <button type="button" aria-label="newer notes" disabled={!newer} onClick={() => void go(newer)}>
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
            readOnly={loaded !== day || phase === 'conflict'}
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
