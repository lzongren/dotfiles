import { useEffect, useId, useRef, useState, type DragEvent } from 'react'
import { uploadFile } from '../api'
import { openableCount, shownArtifacts } from '../insights'
import type { AgentInsight, Session } from '../shared/types'
import { UPLOAD_MAX, UPLOAD_TOO_LARGE } from '../shared/validate'
import { FileList, FilePreview, type FileRef } from './FilePreview'
import { ArtifactList } from './Overview'
import { TerminalPane } from './Terminal'

const NOTE_MS = 8000

type UploadJob = { current: string; files: File[]; placed: Array<{ name: string; path: string }>; problems: string[] }

const carriesFiles = (event: { dataTransfer: DataTransfer | null }) => event.dataTransfer?.types.includes('Files') ?? false

export function TerminalTabs({
  tabs,
  active,
  focusSignal = 0,
  sessions,
  insights,
  now,
  onSelect,
  onClose,
}: {
  tabs: string[]
  active: string | null
  focusSignal?: number
  sessions: Session[]
  insights: Map<string, AgentInsight>
  now: number
  onSelect: (name: string | null) => void
  onClose: (name: string) => void
}) {
  const id = useId()
  const [filesOpen, setFilesOpen] = useState<string | null>(null)
  const [preview, setPreview] = useState<FileRef | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const timers = useRef(new Map<string, number>())
  const jobs = useRef(new Map<string, UploadJob>())
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

  if (filesOpen !== null && (filesOpen !== active || !insights.has(filesOpen))) setFilesOpen(null)
  useEffect(() => {
    if (filesOpen === null) return
    const away = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest('.term-files, dialog'))) setFilesOpen(null)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [filesOpen])

  const note = (tab: string, text: string, sticky = false) => {
    if (!alive.current) return
    setNotes((n) => ({ ...n, [tab]: text }))
    window.clearTimeout(timers.current.get(tab))
    if (!sticky) timers.current.set(tab, window.setTimeout(() => setNotes((n) => ({ ...n, [tab]: '' })), NOTE_MS))
  }

  const progress = (tab: string, job: UploadJob) =>
    note(tab, `Copying ${job.current}…${job.files.length ? ` (${job.files.length} more)` : ''}`, true)

  const enqueue = (tab: string, files: File[], folders: number) => {
    const running = jobs.current.get(tab)
    const job: UploadJob = running ?? { current: '', files: [], placed: [], problems: [] }
    job.files.push(...files)
    if (folders) job.problems.push(`${folders === 1 ? 'a folder' : `${folders} folders`} skipped, drop files instead`)
    if (running) return progress(tab, job)
    jobs.current.set(tab, job)
    void (async () => {
      try {
        for (let file = job.files.shift(); file && alive.current; file = job.files.shift()) {
          job.current = file.name
          if (file.size > UPLOAD_MAX) {
            job.problems.push(`${file.name} is ${UPLOAD_TOO_LARGE}`)
            continue
          }
          progress(tab, job)
          const result = await uploadFile(tab, file)
          if (result.kind === 'ok') job.placed.push({ name: file.name, path: result.data.path })
          else job.problems.push(`${file.name}: ${result.kind === 'unauthorized' ? 'server restarted — run devbox web' : result.message}`)
        }
      } catch {
        job.problems.push(`${job.current}: upload failed${job.files.length ? `, ${job.files.length} more not copied` : ''}`)
      } finally {
        jobs.current.delete(tab)
        const { placed } = job
        const dir = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'
        const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)
        const lines = [...job.problems]
        if (placed.length === 1) lines.unshift(`Copied to ${placed[0].path}`)
        else if (placed.length) {
          const renamed = placed.filter((p) => base(p.path) !== p.name).map((p) => `${p.name} saved as ${base(p.path)}`)
          const shared = new Set(placed.map((p) => dir(p.path))).size === 1
          lines.unshift(
            `Copied ${placed.length} files${shared ? ` to ${dir(placed[0].path)}` : ''}`,
            ...renamed.slice(0, 3),
            ...(renamed.length > 3 ? [`${renamed.length - 3} more renamed`] : []),
          )
        }
        note(tab, lines.join(' · '))
      }
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
      {tabs.map((tab, index) => {
        const insight = insights.get(tab)
        const open = filesOpen === tab && insight !== undefined
        const panel = `${id}-files-${index}`
        const artifacts = open ? shownArtifacts(insight) : []
        const cwd = open ? (sessions.find((s) => s.name === tab)?.path ?? '') : ''
        const files = open ? (insight.files ?? []).map((f) => ({ ...f, session: tab, cwd })) : []
        return (
          <div key={tab} className="termpane" style={{ display: tab === active ? 'flex' : 'none' }} data-drop={over === tab} {...zone(tab)}>
            <TerminalPane
              name={tab}
              active={tab === active}
              focusSignal={tab === active ? focusSignal : 0}
              tools={
                insight ? (
                  <div
                    className="term-files"
                    tabIndex={-1}
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape' || !open) return
                      setFilesOpen(null)
                      event.currentTarget.querySelector<HTMLElement>('.files-toggle')?.focus()
                    }}
                    onBlur={(event) => {
                      const next = event.relatedTarget
                      if (next instanceof Element && !event.currentTarget.contains(next) && !next.closest('dialog')) setFilesOpen(null)
                    }}
                  >
                    <button
                      type="button"
                      className="files-toggle"
                      aria-expanded={open}
                      aria-controls={open ? panel : undefined}
                      onClick={() => setFilesOpen(open ? null : tab)}
                    >
                      Artifacts{' '}
                      <span className="files-count">{openableCount(insight)}</span>
                    </button>
                    {open ? (
                      <section id={panel} className="files-panel" aria-label={`${tab} artifacts`}>
                        <h2>Artifacts</h2>
                        {artifacts.length ? (
                          <>
                            <ArtifactList artifacts={artifacts} now={now} />
                            {insight.artifacts.length > artifacts.length ? (
                              <p className="lane-empty">{insight.artifacts.length - artifacts.length} more not shown</p>
                            ) : null}
                          </>
                        ) : (
                          <p className="lane-empty">No pull requests or reviews seen yet.</p>
                        )}
                        <h2>Files</h2>
                        {files.length ? <FileList files={files} now={now} onPick={setPreview} /> : <p className="lane-empty">No files written yet.</p>}
                      </section>
                    ) : null}
                  </div>
                ) : null
              }
            />
            {over === tab ? <div className="drop-hint">Drop to copy into {tab}'s folder</div> : null}
            <p className="drop-note" role="status">
              {notes[tab] ?? ''}
            </p>
          </div>
        )
      })}
      {preview ? (
        <FilePreview
          key={`${preview.session}${preview.path}`}
          file={preview}
          known={(insights.get(preview.session)?.files ?? []).map((f) => f.path)}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </section>
  )
}
