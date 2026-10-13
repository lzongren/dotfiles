import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { getFile, openFile, type ApiResult } from '../api'
import type { FileTouch, FileView } from '../shared/types'
import { highlight, languageOf } from '../highlight'
import { renderMarkdown } from '../markdown'
import { ago } from '../time'

export interface FileRef {
  session: string
  path: string
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function failure(r: ApiResult<unknown>): string {
  return r.kind === 'unauthorized' ? 'server restarted — run devbox web' : r.kind === 'ok' ? '' : r.message
}

function baseName(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1)
}

export function FileList({
  files,
  now,
  onPick,
}: {
  files: Array<FileTouch & { session: string; cwd: string; label?: string }>
  now: number
  onPick: (file: FileRef) => void
}) {
  return (
    <ul className="file-list">
      {files.map((f) => {
        const rel = f.path.startsWith(`${f.cwd}/`) ? f.path.slice(f.cwd.length + 1) : f.path
        const parts = rel.split('/').slice(0, -1)
        const dir = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/')
        return (
          <li key={`${f.session}${f.path}`} className={f.gone ? 'file-gone' : undefined}>
            {f.gone ? (
              <span className="file-name">{baseName(f.path)}</span>
            ) : (
              <button type="button" className="file-name" title={f.path} onClick={() => onPick({ session: f.session, path: f.path })}>
                {baseName(f.path)}
              </button>
            )}
            {dir ? <span className="file-dir">{dir}</span> : null}
            <span className="artifact-note">{f.gone ? 'gone' : f.action}</span>
            {f.label ? <span className="artifact-session">{f.label}</span> : null}
            <span className="artifact-note">{ago(now, f.at)}</span>
          </li>
        )
      })}
    </ul>
  )
}

type Format = 'markdown' | 'json' | 'table' | 'html'

const FORMATS: Record<string, Format> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.json': 'json',
  '.csv': 'table',
  '.tsv': 'table',
  '.html': 'html',
  '.htm': 'html',
}
const TABLE_ROWS = 1000

function extension(file: string): string {
  const name = baseName(file)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

export function parseDelimited(text: string, sep: string, max = TABLE_ROWS): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let touched = false
  for (let i = 0; i < text.length && rows.length < max; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"' && cell === '') quoted = touched = true
    else if (c === sep) {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      if (row.length === 0 && cell === '' && !touched) continue
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      touched = false
    } else cell += c
  }
  if ((cell !== '' || row.length > 0 || (touched && !quoted)) && rows.length < max) rows.push([...row, cell])
  return rows
}

export function indentJson(text: string): string {
  let out = ''
  let depth = 0
  const pad = () => `\n${'  '.repeat(depth)}`
  const blank = (c: string | undefined) => c === ' ' || c === '\n' || c === '\r' || c === '\t'
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let end = i + 1
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
      out += text.slice(i, end + 1)
      i = end
    } else if (c === '{' || c === '[') {
      let next = i + 1
      while (blank(text[next])) next++
      if (text[next] === (c === '{' ? '}' : ']')) {
        out += c + text[next]
        i = next
      } else {
        depth++
        out += c + pad()
      }
    } else if (c === '}' || c === ']') {
      depth--
      out += pad() + c
    } else if (c === ',') out += `,${pad()}`
    else if (c === ':') out += ': '
    else if (!blank(c)) out += c
  }
  return out
}

function Formatted({ format, text, path, onLink }: { format: Format; text: string; path: string; onLink: (path: string) => void }) {
  const html = useMemo(() => (format === 'markdown' ? renderMarkdown(text, path) : ''), [format, text, path])
  const rows = useMemo(() => (format === 'table' ? parseDelimited(text, extension(path) === '.tsv' ? '\t' : ',', TABLE_ROWS + 2) : []), [format, text, path])
  const json = useMemo(() => {
    if (format !== 'json') return null
    const pretty = indentJson(text)
    return { pretty, html: highlight(pretty, 'json') }
  }, [format, text])
  const name = baseName(path)
  if (format === 'markdown') {
    const activate = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
      const link = (event.target as Element).closest('a[role="link"]')
      if (!link || ('key' in event && event.key !== 'Enter')) return
      event.preventDefault()
      const anchor = link.getAttribute('data-anchor')
      const heading = anchor ? document.getElementById(anchor) : null
      if (heading) {
        heading.focus({ preventScroll: true })
        heading.scrollIntoView?.({ block: 'start' })
      } else if (link.hasAttribute('data-path')) onLink(link.getAttribute('data-path')!)
    }
    return <article className="md" aria-label={`${name}, rendered`} dangerouslySetInnerHTML={{ __html: html }} onClick={activate} onKeyDown={activate} />
  }
  if (json) {
    return json.html !== null ? (
      <pre className="file-text file-solo" tabIndex={0} aria-label={`${name}, formatted`} dangerouslySetInnerHTML={{ __html: json.html }} />
    ) : (
      <pre className="file-text file-solo" tabIndex={0} aria-label={`${name}, formatted`}>
        {json.pretty}
      </pre>
    )
  }
  if (format === 'html') return <iframe className="file-frame" sandbox="" srcDoc={text} title={`${name}, rendered without scripts`} />
  const [head, ...body] = rows.slice(0, TABLE_ROWS + 1)
  return (
    <div className="file-table-wrap" role="region" tabIndex={0} aria-label={`${name}, as a table`}>
      <table className="file-table">
        <thead>
          <tr>
            {head?.map((cell, i) => (
              <th key={i} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) => (
                <td key={i}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > TABLE_ROWS + 1 ? <p className="hint">Showing the first {TABLE_ROWS} rows.</p> : null}
    </div>
  )
}

function Source({ text, wrap, path }: { text: string; wrap: boolean; path: string }) {
  const name = baseName(path)
  const html = useMemo(() => highlight(text, languageOf(path)), [text, path])
  const numbers = useMemo(() => {
    const count = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    return Array.from({ length: Math.max(1, count) }, (_, i) => i + 1).join('\n')
  }, [text])
  return (
    <div className={`file-source${wrap ? ' file-wrap' : ''}`}>
      {wrap ? null : (
        <pre className="file-gutter" aria-hidden="true">
          {numbers}
        </pre>
      )}
      {html !== null ? (
        <pre className="file-text" tabIndex={0} aria-label={`${name} contents`} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="file-text" tabIndex={0} aria-label={`${name} contents`}>
          {text}
        </pre>
      )}
    </div>
  )
}

function formatOf(view: FileView): Format | null {
  const format = FORMATS[extension(view.path)]
  if (!format || view.kind !== 'text' || view.text === undefined) return null
  if (format === 'json') {
    try {
      JSON.parse(view.text)
    } catch {
      return null
    }
  }
  return format
}

export function FilePreview({ file, known, onClose }: { file: FileRef; known: string[]; onClose: () => void }) {
  const id = useId()
  const ref = useRef<HTMLDialogElement | null>(null)
  const title = useRef<HTMLHeadingElement | null>(null)
  const moved = useRef(false)
  const [trail, setTrail] = useState([file.path])
  const [result, setResult] = useState<ApiResult<FileView> | null>(null)
  const [note, setNote] = useState('')
  const [source, setSource] = useState(false)
  const [wrap, setWrap] = useState(false)
  const path = trail[trail.length - 1]
  const follow = (target: string) => {
    if (target === path) return
    if (known.includes(target)) {
      moved.current = true
      setTrail((t) => [...t, target])
      setSource(false)
    } else setNote(`${baseName(target)} isn't a file this agent wrote, so it can't be opened here`)
  }

  useEffect(() => {
    const dialog = ref.current
    if (!dialog || dialog.open) return
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
  }, [])

  useEffect(() => {
    let live = true
    setResult(null)
    setNote('')
    void getFile(file.session, path).then((r) => {
      if (live) setResult(r)
    })
    return () => {
      live = false
    }
  }, [file.session, path])

  useEffect(() => {
    if (moved.current) title.current?.focus()
  }, [path])

  const close = () => {
    if (typeof ref.current?.close === 'function' && ref.current.open) ref.current.close()
    else onClose()
  }
  const copy = () => {
    void navigator.clipboard
      ?.writeText(path)
      .then(() => setNote('Path copied'))
      .catch(() => setNote('Could not copy — select the path above'))
  }
  const open = () => {
    void openFile(file.session, path).then((r) =>
      setNote(r.kind !== 'ok' ? failure(r) : r.data.revealed ? 'Not a document type, so it is shown in its folder instead' : 'Opened on this laptop'),
    )
  }

  const view = result?.kind === 'ok' ? result.data : null
  const name = baseName(path)
  const format = useMemo(() => (view ? formatOf(view) : null), [view])
  const showSource = !format || source
  return (
    <dialog ref={ref} className="file-preview" aria-labelledby={id} onClose={onClose}>
      <header className="file-head">
        <div className="file-title">
          <h2 id={id} ref={title} tabIndex={-1}>
            {name}
          </h2>
          <p className="file-path">{path}</p>
          {view ? (
            <p className="file-facts">
              {size(view.size)} · changed {ago(Date.now(), view.mtime)} ago · {view.local ? 'laptop copy' : 'read from host'}
            </p>
          ) : null}
        </div>
        <div className="detail-actions">
          {trail.length > 1 ? (
            <button
              type="button"
              onClick={() => {
                moved.current = true
                setTrail((t) => t.slice(0, -1))
                setSource(false)
              }}
            >
              Back
            </button>
          ) : null}
          {view?.local ? (
            <button type="button" className="primary" onClick={open}>
              Open on laptop
            </button>
          ) : null}
          {view?.data ? (
            <a className="button" href={view.data} download={name}>
              Download
            </a>
          ) : null}
          <button type="button" onClick={copy}>
            Copy path
          </button>
          <button type="button" onClick={close}>
            Close
          </button>
        </div>
      </header>
      <div className="file-bar">
        {format ? (
          <div className="file-modes" role="group" aria-label="view">
            <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>
              {format === 'table' ? 'Table' : format === 'json' ? 'Formatted' : 'Rendered'}
            </button>
            <button type="button" aria-pressed={source} onClick={() => setSource(true)}>
              Source
            </button>
          </div>
        ) : null}
        {format === 'html' && !source ? <span className="file-hint">Scripts are off; files it links to don't load</span> : null}
        {view?.kind === 'text' && showSource ? (
          <button type="button" className="file-toggle" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
            Wrap lines
          </button>
        ) : null}
        <p className="file-note" role="status">
          {note}
        </p>
      </div>
      <div className="file-body">
        {result === null ? <p className="lane-empty">Loading…</p> : null}
        {result && result.kind !== 'ok' ? (
          <p role="alert" className="banner">
            {failure(result)}
          </p>
        ) : null}
        {view?.kind === 'text' && view.text !== undefined ? (
          showSource || !format ? (
            <Source text={view.text} wrap={wrap} path={path} />
          ) : (
            <Formatted format={format} text={view.text} path={path} onLink={follow} />
          )
        ) : null}
        {view?.kind === 'image' && view.data ? <img className="file-image" src={view.data} alt={name} /> : null}
        {view?.kind === 'binary' ? (
          <p className="lane-empty">{view.truncated ? 'Too large to preview here.' : 'Binary file — download it or open it on the laptop.'}</p>
        ) : null}
        {view?.kind === 'text' && view.truncated ? <p className="hint">Showing the first 1 MB of {size(view.size)}.</p> : null}
      </div>
    </dialog>
  )
}
