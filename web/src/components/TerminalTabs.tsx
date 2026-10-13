import { useEffect, useRef, useState, type DragEvent } from 'react'
import { uploadFile } from '../api'
import { UPLOAD_MAX, UPLOAD_TOO_LARGE } from '../shared/validate'
import { TerminalPane } from './Terminal'

const NOTE_MS = 8000

const carriesFiles = (event: { dataTransfer: DataTransfer | null }) => event.dataTransfer?.types.includes('Files') ?? false

export function TerminalTabs({
  tabs,
  active,
  focusSignal = 0,
  onSelect,
  onClose,
}: {
  tabs: string[]
  active: string | null
  focusSignal?: number
  onSelect: (name: string | null) => void
  onClose: (name: string) => void
}) {
  const [over, setOver] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const timers = useRef(new Map<string, number>())
  const jobs = useRef(new Map<string, { current: string; files: File[]; placed: string[]; problems: string[] }>())
  const alive = useRef(true)

  useEffect(() => {
    const block = (event: globalThis.DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    const pending = timers.current
    alive.current = true
    return () => {
      alive.current = false
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
      for (const timer of pending.values()) window.clearTimeout(timer)
    }
  }, [])

  const note = (tab: string, text: string, sticky = false) => {
    if (!alive.current) return
    setNotes((n) => ({ ...n, [tab]: text }))
    window.clearTimeout(timers.current.get(tab))
    if (!sticky) timers.current.set(tab, window.setTimeout(() => setNotes((n) => ({ ...n, [tab]: '' })), NOTE_MS))
  }

  const progress = (tab: string, job: { current: string; files: File[] }) =>
    note(tab, `Copying ${job.current}…${job.files.length ? ` (${job.files.length} more)` : ''}`, true)

  const enqueue = (tab: string, files: File[], folders: number) => {
    const running = jobs.current.get(tab)
    const job = running ?? { current: '', files: [], placed: [], problems: [] }
    job.files.push(...files)
    if (folders) job.problems.push(`${folders === 1 ? 'a folder' : `${folders} folders`} skipped, drop files instead`)
    if (running) return progress(tab, job)
    jobs.current.set(tab, job)
    void (async () => {
      for (let file = job.files.shift(); file && alive.current; file = job.files.shift()) {
        job.current = file.name
        if (file.size > UPLOAD_MAX) {
          job.problems.push(`${file.name} is ${UPLOAD_TOO_LARGE}`)
          continue
        }
        progress(tab, job)
        const result = await uploadFile(tab, file)
        if (result.kind === 'ok') job.placed.push(result.data.path)
        else job.problems.push(`${file.name}: ${result.kind === 'unauthorized' ? 'server restarted — run devbox web' : result.message}`)
      }
      jobs.current.delete(tab)
      const { placed } = job
      const done = placed.length === 1 ? `Copied to ${placed[0]}` : placed.length ? `Copied ${placed.length} files to ${placed[0].slice(0, placed[0].lastIndexOf('/'))}` : ''
      note(tab, [done, ...job.problems].filter(Boolean).join(' · '))
    })()
  }

  const zone = (tab: string) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
      setOver(tab)
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null)
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      setOver(null)
      const entries = [...event.dataTransfer.items].filter((item) => item.kind === 'file')
      const folders = entries.filter((item) => item.webkitGetAsEntry?.()?.isDirectory).length
      const files = entries.filter((item) => !item.webkitGetAsEntry?.()?.isDirectory).flatMap((item) => item.getAsFile() ?? [])
      onSelect(tab)
      if (files.length || folders) enqueue(tab, files, folders)
    },
  })

  if (tabs.length === 0) return null
  return (
    <section className="terminals" data-overview={active === null}>
      <div className="tabstrip" role="tablist">
        <span className="tab" data-active={active === null}>
          <button type="button" role="tab" aria-selected={active === null} onClick={() => onSelect(null)}>
            Overview
          </button>
        </span>
        {tabs.map((tab) => (
          <span key={tab} className="tab" data-active={tab === active} data-drop={over === tab} {...zone(tab)}>
            <button type="button" role="tab" aria-selected={tab === active} onClick={() => onSelect(tab)}>
              {tab}
            </button>
            <button type="button" aria-label={`close ${tab}`} className="tab-close" onClick={() => onClose(tab)}>
              ×
            </button>
          </span>
        ))}
      </div>
      {tabs.map((tab) => (
        <div key={tab} className="termpane" style={{ display: tab === active ? 'flex' : 'none' }} data-drop={over === tab} {...zone(tab)}>
          <TerminalPane name={tab} active={tab === active} focusSignal={tab === active ? focusSignal : 0} />
          {over === tab ? <div className="drop-hint">Drop to copy into {tab}'s folder</div> : null}
          <p className="drop-note" role="status">
            {notes[tab] ?? ''}
          </p>
        </div>
      ))}
    </section>
  )
}
