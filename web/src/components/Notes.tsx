import { useCallback, useEffect, useRef, useState } from 'react'
import { getNote, getNoteDays, putNote, type ApiResult } from '../api'
import { ignoredTarget } from './Overview'

const SAVE_MS = 600
const RETRY_MS = 5000
const OPEN_KEY = 'devbox.notes.open'
const DRAFT = 'devbox.notes.draft.'
const LEGACY_BASE = '\u0000legacy'
const OPEN_ITEM = /^\s*[-*] \[ \] .+$/gm
const DAY = /^\d{4}-\d{2}-\d{2}$/
const LOCK = 'devbox.notes'

interface Draft {
  day: string
  text: string
  base: string
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'offline' }
  | { kind: 'rejected'; text: string; problem: string }
  | { kind: 'conflict'; text: string; version: string }

const IDLE: Phase = { kind: 'idle' }

function stored(text: string): string {
  return text.trim() === '' ? '' : text
}

function quietly<T>(run: () => T, fallback: T): T {
  try {
    return run()
  } catch {
    return fallback
  }
}

function remember(key: string, value: string): void {
  quietly(() => localStorage.setItem(key, value), undefined)
}

function readDraft(day: string): Draft | null {
  const raw = quietly(() => localStorage.getItem(DRAFT + day), null)
  if (raw === null) return null
  const parsed = quietly(() => JSON.parse(raw) as Partial<Draft> | null, null)
  return parsed && typeof parsed.text === 'string' && typeof parsed.base === 'string'
    ? { day, text: parsed.text, base: parsed.base }
    : { day, text: raw, base: LEGACY_BASE }
}

function draftDays(): string[] {
  const keys = quietly(() => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? ''), [])
  return keys.filter((key) => key.startsWith(DRAFT) && DAY.test(key.slice(DRAFT.length))).map((key) => key.slice(DRAFT.length)).sort()
}

function dropDraft(day: string, ifText: string): string[] {
  const current = readDraft(day)
  if (current && stored(current.text) === stored(ifText)) quietly(() => localStorage.removeItem(DRAFT + day), undefined)
  return draftDays()
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

function retriable(result: ApiResult<unknown>): boolean {
  return result.kind === 'network' || result.kind === 'unreachable' || (result.kind === 'error' && (result.status ?? 500) >= 500)
}

export function Notes() {
  const [today, setToday] = useState(localDay)
  const [drafts, setDrafts] = useState(draftDays)
  const [day, setDay] = useState(() => drafts[0] ?? today)
  const [editor, setEditor] = useState<boolean | null>(() => (navigator.locks ? null : true))
  const [text, setText] = useState('')
  const [days, setDays] = useState<string[]>([])
  const [loaded, setLoaded] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [carry, setCarry] = useState<{ from: string; items: string[] } | null>(null)
  const [draft, setDraftState] = useState<Draft | null>(null)
  const [phase, setPhaseState] = useState<Phase>(IDLE)
  const [blocked, setBlocked] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [reload, setReload] = useState(0)
  const [open, setOpen] = useState(() => quietly(() => localStorage.getItem(OPEN_KEY) !== '0', true))
  const editorRef = useRef(editor)
  const take = useRef(() => undefined as void)
  const leavingRef = useRef(false)
  const draftRef = useRef<Draft | null>(null)
  const phaseRef = useRef<Phase>(IDLE)
  const versionRef = useRef('')
  const sent = useRef(new Set<string>())
  const textRef = useRef('')
  const following = useRef<{ from: string; to: string } | null>(null)
  const chain = useRef<Promise<void>>(Promise.resolve())
  const debounce = useRef<number | null>(null)
  const retry = useRef<number | null>(null)
  const disposed = useRef(false)
  const area = useRef<HTMLTextAreaElement | null>(null)
  const toggleRef = useRef<HTMLButtonElement | null>(null)

  const follow = () => {
    const move = following.current
    if (!move || draftRef.current) return
    following.current = null
    setDay((current) => (current === move.from ? move.to : current))
  }
  const show = (value: string) => {
    setText(value)
    textRef.current = value
  }
  const role = (next: boolean, jump = true) => {
    editorRef.current = next
    setEditor(next)
    if (!next) {
      if (document.activeElement === area.current) area.current?.blur()
      return
    }
    const left = draftDays()
    setDrafts(left)
    if (jump && left[0]) setDay(left[0])
  }
  const setDraft = (next: Draft | null) => {
    draftRef.current = next
    if (next && editorRef.current) remember(DRAFT + next.day, JSON.stringify({ text: next.text, base: next.base }))
    else {
      setBlocked(false)
      follow()
    }
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
    const step = async (): Promise<void> => {
      const job = draftRef.current
      const now = phaseRef.current
      if (!editorRef.current || !job || now.kind === 'conflict' || (now.kind === 'rejected' && now.text === job.text)) return
      if (!disposed.current) setPhase({ kind: 'saving' })
      sent.current.add(stored(job.text))
      const result = await putNote(job.day, job.text, job.base)
      const body = result.kind === 'error' ? ((result.body ?? {}) as { text?: unknown; version?: unknown }) : {}
      const theirs = typeof body.text === 'string' ? body.text : ''
      const raw = result.kind === 'ok' ? result.data.version : body.version
      const version = typeof raw === 'string' ? raw : ''
      const known = [...sent.current, stored(draftRef.current?.text ?? job.text)].includes(stored(theirs))
      const conflict = result.kind === 'error' && result.status === 409
      const saved = result.kind === 'ok' ? job.text : conflict && known ? theirs : null
      if (saved !== null) {
        setDrafts(dropDraft(job.day, saved))
        if (disposed.current) return
        versionRef.current = version
        sent.current.clear()
        setDays((prev) => (stored(saved) ? (prev.includes(job.day) ? prev : [...prev, job.day].sort().reverse()) : prev.filter((d) => d !== job.day)))
        const current = draftRef.current
        if (current && stored(current.text) === stored(saved)) setDraft(null)
        else if (current) {
          setDraft({ ...current, base: version })
          if (result.kind !== 'ok') return step()
        }
        setPhase(IDLE)
        return
      }
      if (disposed.current) return
      if (!draftRef.current) setPhase(IDLE)
      else if (conflict) setPhase({ kind: 'conflict', text: theirs, version })
      else if (retriable(result)) {
        setPhase({ kind: 'offline' })
        retry.current = window.setTimeout(() => void save(), RETRY_MS)
      } else setPhase({ kind: 'rejected', text: job.text, problem: result.kind === 'error' ? result.message : 'reload the dashboard' })
    }
    chain.current = chain.current.then(step).catch(() => undefined)
    return chain.current
  }, [])

  const go = async (target: string | undefined) => {
    if (!target) return
    following.current = null
    await save()
    if (draftRef.current) setBlocked(true)
    else setDay(target)
  }

  useEffect(() => {
    const locks = navigator.locks
    if (!locks) return
    let live = true
    let release = () => undefined as void
    let cancel = () => undefined as void
    const hold = (jump: boolean) => {
      if (!live) return Promise.resolve()
      role(true, jump)
      return new Promise<void>((resolve) => {
        release = resolve
      })
    }
    const ask = (options: LockOptions) => {
      let ours = false
      const stop = options.steal || options.ifAvailable ? null : new AbortController()
      cancel = () => {
        ours = true
        stop?.abort()
      }
      locks
        .request(LOCK, stop ? { ...options, signal: stop.signal } : options, (lock) => {
          if (lock) return hold(!options.steal)
          if (live) {
            role(false)
            ask({})
          }
          return undefined
        })
        .catch((err: unknown) => {
          if (ours || !live) return
          if (!(err instanceof DOMException && err.name === 'AbortError')) return role(true)
          leavingRef.current = true
          setLeaving(true)
          void save().finally(() => {
            leavingRef.current = false
            setLeaving(false)
            if (!live) return
            role(false)
            ask({})
          })
        })
    }
    take.current = () => {
      if (editorRef.current !== false) return
      cancel()
      ask({ steal: true })
    }
    ask({ ifAvailable: true })
    return () => {
      live = false
      take.current = () => undefined
      cancel()
      release()
    }
  }, [])

  useEffect(() => {
    if (editor === null) return
    let live = true
    setLoaded(null)
    setLoadError(false)
    setCarry(null)
    setBlocked(false)
    setPhase(IDLE)
    sent.current.clear()
    void (async () => {
      const result = await getNote(day)
      if (!live) return
      const ok = result.kind === 'ok' && typeof result.data.text === 'string'
      let kept = readDraft(day)
      if (!ok && !kept) {
        setLoadError(true)
        return
      }
      const server = ok ? result.data.text : null
      versionRef.current = ok ? (typeof result.data.version === 'string' ? result.data.version : '') : (kept?.base ?? '')
      if (kept && server !== null && kept.text === server) {
        if (editor) setDrafts(dropDraft(day, server))
        kept = null
      }
      const shown = kept?.text ?? server ?? ''
      show(shown)
      setDraft(editor ? kept : null)
      setLoaded(day)
      if (kept && editor) void save()
      const list = await getNoteDays()
      if (!live || list.kind !== 'ok' || !Array.isArray(list.data.days)) return
      setDays(list.data.days)
      const previous = list.data.days.find((d) => d < day)
      if (!editor || shown.trim() !== '' || !previous) return
      const before = await getNote(previous)
      const items = before.kind === 'ok' && typeof before.data.text === 'string' ? openItems(before.data.text) : []
      if (live && items.length > 0 && textRef.current.trim() === '') setCarry({ from: previous, items })
    })()
    return () => {
      live = false
    }
  }, [day, reload, editor])

  useEffect(() => {
    const tick = window.setInterval(() => {
      const now = localDay()
      if (now === today) return
      setToday(now)
      following.current = { from: today, to: now }
      void save().then(follow)
    }, 60_000)
    return () => window.clearInterval(tick)
  }, [today, save])

  useEffect(() => {
    const mirror = (event: StorageEvent) => {
      if (!event.key?.startsWith(DRAFT)) return
      if (event.oldValue === null || event.newValue === null) setDrafts(draftDays())
      if (editor !== false || event.key !== DRAFT + day) return
      const next = readDraft(day)
      if (next) show(next.text)
      else setReload((n) => n + 1)
    }
    window.addEventListener('storage', mirror)
    return () => window.removeEventListener('storage', mirror)
  }, [day, editor])

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
    const now = phaseRef.current
    if (!editor || leavingRef.current || loaded !== day || now.kind === 'conflict') return
    following.current = null
    show(next)
    setCarry(null)
    setDraft({ day, text: next, base: draftRef.current?.base ?? versionRef.current })
    if (now.kind === 'rejected' && now.text !== next) setPhase(IDLE)
    if (debounce.current !== null) window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => void save(), SAVE_MS)
  }

  const discard = () => {
    if (draftRef.current) setDrafts(dropDraft(day, draftRef.current.text))
    setDraft(null)
    setReload((n) => n + 1)
  }

  const keep = () => {
    const conflict = phaseRef.current
    if (conflict.kind !== 'conflict' || !draftRef.current) return
    sent.current.clear()
    setPhase(IDLE)
    setDraft({ ...draftRef.current, base: conflict.version })
    void save()
  }

  const toggle = () => {
    remember(OPEN_KEY, open ? '0' : '1')
    setOpen(!open)
  }

  const timeline = [...new Set([today, day, ...days, ...drafts])].sort().reverse()
  const index = timeline.indexOf(day)
  const older = timeline[index + 1]
  const newer = index > 0 ? timeline[index - 1] : undefined
  const remaining = openItems(text).length
  const label = dayLabel(day, today)
  const [status, warning] = loadError
    ? ["couldn't load this note", true]
    : loaded !== day
      ? ['', false]
      : !editor || leaving
        ? [leaving ? 'handing over…' : 'editing in another tab', false]
        : phase.kind === 'conflict'
          ? ['changed elsewhere', true]
          : phase.kind === 'rejected'
            ? [`not saved: ${phase.problem}`, true]
            : phase.kind === 'offline'
              ? ['not saved yet, retrying', true]
              : draft
                ? [phase.kind === 'saving' ? 'saving…' : 'editing…', false]
                : ['saved', false]
  const then =
    phase.kind === 'conflict' ? 'resolve the conflict first' : phase.kind === 'rejected' ? 'discard or edit it first' : 'switch days once it saves'
  const [shown, alarming] = blocked && draft ? [`${warning ? status : 'not saved yet'} — ${then}`, true] : [status, warning]

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
            readOnly={!editor || leaving || loaded !== day || phase.kind === 'conflict'}
            value={text}
            onChange={(e) => edit(e.target.value)}
            onFocus={() => take.current()}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') toggleRef.current?.focus()
            }}
          />
          <footer className="notes-foot">
            {carry && !leaving ? (
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
            {!leaving && (phase.kind === 'rejected' || phase.kind === 'conflict') ? (
              <button type="button" className="notes-carry" onClick={discard}>
                {phase.kind === 'conflict' ? 'Use saved' : 'Discard unsaved'}
              </button>
            ) : null}
            {!leaving && phase.kind === 'conflict' ? (
              <button type="button" className="notes-carry" onClick={keep}>
                Keep mine
              </button>
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
