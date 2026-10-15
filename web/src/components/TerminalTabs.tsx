import { useEffect, useId, useRef, useState, type DragEvent } from 'react'
import { explain, uploadFile } from '../api'
import { heardAt, isFresh, openableCount, plain, shownArtifacts } from '../insights'
import type { AgentInsight, Session } from '../shared/types'
import { UPLOAD_MAX, UPLOAD_TOO_LARGE } from '../shared/validate'
import { ago } from '../time'
import { FileList, FilePreview, type FileRef } from './FilePreview'
import { Icon, StateIcon, toneOf, type Tone } from './Icon'
import { ArtifactList } from './Overview'
import { headline, sessionSummary } from './SessionList'
import { TerminalPane } from './Terminal'

const NOTE_MS = 8000
const TONES: Record<Tone, string> = {
  waiting: 'waiting on you',
  bell: 'bell rang',
  error: 'error',
  working: 'working',
  quiet: 'working, quiet',
  fresh: 'new turn',
  idle: '',
}
const WORDS: Partial<Record<Tone, string>> = { waiting: 'needs you', bell: 'bell', error: 'error', fresh: 'new' }

export interface TabCounts {
  needs: number
  working: number
  fresh: number
}

const undated = (name: string) => name.replace(/^\d{3,4}_(?=.)/, '')

function TabName({ name, keepDate }: { name: string; keepDate: boolean }) {
  const rest = keepDate ? name : undated(name)
  let cut = 0
  for (let i = rest.length - 1; i > 0 && !cut; i--) {
    if (/[_\-\s.]/.test(rest[i - 1]) || (/[A-Z]/.test(rest[i]) && /[a-z\d]/.test(rest[i - 1]))) cut = rest.length - i <= 12 ? i : -1
  }
  const tail = cut > 0 ? rest.slice(cut) : ''
  return (
    <>
      <span className="visually-hidden">{name}</span>
      <span className="tab-name" aria-hidden="true" style={tail ? { minWidth: `max(64px, ${tail.length + 3}ch)` } : undefined}>
        <span className="tab-head">{tail ? rest.slice(0, cut) : rest}</span>
        {tail ? <span className="tab-tail">{tail}</span> : null}
      </span>
    </>
  )
}

type UploadJob = { current: string; files: File[]; placed: Array<{ name: string; path: string }>; problems: string[] }

const carriesFiles = (event: { dataTransfer: DataTransfer | null }) => event.dataTransfer?.types.includes('Files') ?? false

export function TerminalTabs({
  tabs,
  active,
  focusSignal = 0,
  reconnectSignal = 0,
  sessions,
  insights,
  now,
  counts = { needs: 0, working: 0, fresh: 0 },
  seenAt = () => Infinity,
  onSelect,
  onClose,
}: {
  tabs: string[]
  active: string | null
  focusSignal?: number
  reconnectSignal?: number
  sessions: Session[]
  insights: Map<string, AgentInsight>
  now: number
  counts?: TabCounts
  seenAt?: (name: string) => number
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
          else job.problems.push(`${file.name}: ${explain(result)}`)
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
  const sums = [
    { tone: 'waiting' as const, n: counts.needs, say: `${counts.needs} need${counts.needs === 1 ? 's' : ''} you` },
    { tone: 'working' as const, n: counts.working, say: `${counts.working} working` },
    { tone: 'fresh' as const, n: counts.fresh, say: `${counts.fresh} new` },
  ].filter((c) => c.n > 0)
  return (
    <section className="terminals" data-overview={active === null}>
      <div className="tabstrip" role="tablist">
        <span className="tab" data-active={active === null}>
          <button
            type="button"
            role="tab"
            aria-selected={active === null}
            aria-describedby={sums.length ? `${id}-needs` : undefined}
            onClick={() => onSelect(null)}
          >
            <Icon name="overview" />
            Overview
            {sums.map((c) => (
              <span key={c.tone} className="tab-sum" data-tone={c.tone} aria-hidden="true">
                <StateIcon tone={c.tone} />
                {c.n}
              </span>
            ))}
          </button>
          <span id={`${id}-needs`} hidden>
            {sums.map((c) => c.say).join(', ')}
          </span>
        </span>
        {tabs.map((tab, index) => {
          const row = sessions.find((s) => s.name === tab)
          const insight = insights.get(tab)
          const tone = row ? toneOf(row, insight, isFresh(row, insight, seenAt(tab)), now) : 'idle'
          const label = TONES[tone]
          const word = tone === 'quiet' && row ? `quiet ${ago(now, heardAt(row, insight))}` : WORDS[tone]
          return (
            <span key={tab} className="tab" data-active={tab === active} data-drop={over === tab} {...zone(tab)}>
              <span id={`${id}-tone-${index}`} hidden>
                {label}
              </span>
              <button
                type="button"
                role="tab"
                aria-selected={tab === active}
                aria-describedby={label ? `${id}-tone-${index}` : undefined}
                aria-keyshortcuts="Delete Backspace"
                title={`${tab}\nDelete or Backspace closes this tab`}
                onClick={() => onSelect(tab)}
                onKeyDown={(event) => {
                  if (event.key !== 'Delete' && event.key !== 'Backspace') return
                  event.preventDefault()
                  const all = [...(event.currentTarget.closest('[role=tablist]')?.querySelectorAll<HTMLElement>('[role=tab]') ?? [])]
                  const at = all.indexOf(event.currentTarget)
                  const next = all[at + 1] ?? all[at - 1]
                  onClose(tab)
                  requestAnimationFrame(() => next?.focus())
                }}
              >
                <StateIcon tone={tone} />
                <TabName name={tab} keepDate={tabs.some((t) => t !== tab && undated(t) === undated(tab))} />
                {word ? (
                  <span className="tab-word" data-tone={tone} aria-hidden="true">
                    {word}
                  </span>
                ) : null}
              </button>
              <button type="button" tabIndex={-1} aria-label={`close ${tab}`} title={`Close ${tab}`} className="tab-close" onClick={() => onClose(tab)}>
                <Icon name="x" size={14} />
              </button>
            </span>
          )
        })}
      </div>
      {tabs.map((tab, index) => {
        const insight = insights.get(tab)
        const open = filesOpen === tab && insight !== undefined
        const panel = `${id}-files-${index}`
        const artifacts = open ? shownArtifacts(insight) : []
        const row = sessions.find((s) => s.name === tab)
        const cwd = open ? (row?.path ?? '') : ''
        const lead = insight?.summary ? plain(insight.summary) : row ? headline(row) || sessionSummary(row).text : ''
        const files = open ? (insight.files ?? []).map((f) => ({ ...f, session: tab, cwd })) : []
        return (
          <div key={tab} className="termpane" style={{ display: tab === active ? 'flex' : 'none' }} data-drop={over === tab} {...zone(tab)}>
            <TerminalPane
              name={tab}
              active={tab === active}
              focusSignal={tab === active ? focusSignal : 0}
              lead={lead ? <span className="terminal-lead">{lead}</span> : undefined}
              reconnectSignal={reconnectSignal}
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
                      <Icon name="file" size={14} />
                      Artifacts <span className="files-count">{openableCount(insight)}</span>
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
