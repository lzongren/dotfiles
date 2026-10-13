import { useCallback, useEffect, useRef, useState } from 'react'
import { getNote, getNoteDays, putNote } from '../api'

const SAVE_MS = 600
const OPEN_KEY = 'devbox.notes.open'
const OPEN_ITEM = /^\s*[-*] \[ \] .+$/gm

type Status = 'loading' | 'saved' | 'saving' | 'unsaved' | 'error'

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

export function Notes() {
  const [today, setToday] = useState(localDay)
  const [day, setDay] = useState(today)
  const [text, setText] = useState('')
  const [days, setDays] = useState<string[]>([])
  const [carry, setCarry] = useState<{ from: string; items: string[] } | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [open, setOpen] = useState(readOpen)
  const pending = useRef<{ day: string; text: string } | null>(null)
  const timer = useRef<number | null>(null)
  const area = useRef<HTMLTextAreaElement | null>(null)

  const refreshDays = useCallback(async () => {
    const result = await getNoteDays()
    if (result.kind === 'ok' && Array.isArray(result.data.days)) setDays(result.data.days)
  }, [])

  const flush = useCallback(async () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    const job = pending.current
    if (!job) return
    pending.current = null
    setStatus('saving')
    const result = await putNote(job.day, job.text)
    if (result.kind === 'ok') {
      setStatus(pending.current ? 'unsaved' : 'saved')
      void refreshDays()
    } else {
      pending.current = pending.current ?? job
      setStatus('error')
      timer.current = window.setTimeout(() => void flush(), 5000)
    }
  }, [refreshDays])

  useEffect(() => {
    let live = true
    setStatus('loading')
    setCarry(null)
    void (async () => {
      await flush()
      const result = await getNote(day)
      if (!live) return
      const loaded = result.kind === 'ok' && typeof result.data.text === 'string' ? result.data.text : ''
      setText(loaded)
      setStatus(result.kind === 'ok' ? 'saved' : 'error')
      const days = await getNoteDays()
      if (!live || days.kind !== 'ok' || !Array.isArray(days.data.days)) return
      setDays(days.data.days)
      const previous = days.data.days.find((d) => d < day)
      if (loaded.trim() === '' && previous) {
        const before = await getNote(previous)
        const items = before.kind === 'ok' && typeof before.data.text === 'string' ? openItems(before.data.text) : []
        if (live && items.length > 0) setCarry({ from: previous, items })
      }
    })()
    return () => {
      live = false
    }
  }, [day, flush])

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
    const warn = (event: BeforeUnloadEvent) => {
      if (pending.current) event.preventDefault()
    }
    const focusPad = (event: KeyboardEvent) => {
      if (event.key !== 'n' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable], .terminals')) return
      event.preventDefault()
      setOpen(true)
      window.setTimeout(() => area.current?.focus(), 0)
    }
    window.addEventListener('beforeunload', warn)
    document.addEventListener('keydown', focusPad)
    return () => {
      window.removeEventListener('beforeunload', warn)
      document.removeEventListener('keydown', focusPad)
      void flush()
    }
  }, [flush])

  const edit = (next: string) => {
    setText(next)
    setCarry(null)
    pending.current = { day, text: next }
    setStatus('unsaved')
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void flush(), SAVE_MS)
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

  const timeline = [...new Set([today, ...days])].sort().reverse()
  const index = timeline.indexOf(day)
  const older = timeline[index + 1]
  const newer = index > 0 ? timeline[index - 1] : undefined
  const remaining = openItems(text).length

  return (
    <section className="notes" aria-label="notes">
      <header className="notes-head">
        <button type="button" className="notes-toggle" aria-expanded={open} onClick={toggle}>
          Notes · {dayLabel(day, today)}
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
            aria-label={`notes for ${dayLabel(day, today).toLowerCase()}`}
            placeholder={'What are you on today?\n- [ ] a thing to finish\n- [x] a thing done'}
            spellCheck
            readOnly={status === 'loading'}
            value={text}
            onChange={(e) => edit(e.target.value)}
            onBlur={() => void flush()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') e.currentTarget.blur()
            }}
          />
          <footer className="notes-foot">
            {carry ? (
              <button type="button" className="notes-carry" onClick={() => edit(`${carry.items.join('\n')}\n`)}>
                Carry over {carry.items.length} open from {dayLabel(carry.from, today)}
              </button>
            ) : null}
            <span className={`notes-status notes-status-${status}`} role="status">
              {status === 'error' ? 'not saved, will retry' : status === 'saved' ? 'saved' : status === 'loading' ? '' : 'saving…'}
            </span>
          </footer>
        </>
      ) : null}
    </section>
  )
}
