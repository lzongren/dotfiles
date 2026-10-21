import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import { explain, getFile, openFile, retriable, type ApiResult } from '../api'
import type { FileTouch, FileView } from '../shared/types'
import { highlight, languageOf } from '../highlight'
import { renderMarkdown } from '../markdown'
import { ago } from '../time'
import { Icon, type IconName } from './Icon'
import type { TerminalHandle } from './Terminal'

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
  return r.kind === 'unreachable' ? "Can't reach the host to read this file. Check your VPN or proxy sign-in, then try again." : explain(r)
}

export function baseName(file: string): string {
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
        const rel = f.cwd && f.path.startsWith(`${f.cwd}/`) ? f.path.slice(f.cwd.length + 1) : f.path
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
            {dir ? <span className="file-dir">in {dir}/</span> : null}
            <span className="artifact-note">
              {f.gone ? 'gone' : f.action}
              {f.label ? ' by' : ''}
            </span>
            {f.label ? <span className="artifact-session">{f.label}</span> : null}
            <span className="artifact-note">{ago(now, f.at)} ago</span>
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
const LONG_PASTE = 800
const STALE_RETRY_MS = 2000

function extension(file: string): string {
  const name = baseName(file)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

export function parseDelimited(text: string, sep: string, max = TABLE_ROWS): string[][] {
  const body = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let touched = false
  let open = -1
  for (let i = 0; i <= body.length && rows.length < max; i++) {
    if (i === body.length) {
      if (!quoted) break
      cell = '"'
      quoted = touched = false
      i = open
      continue
    }
    const c = body[i]
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"' && cell === '') {
      quoted = touched = true
      open = i
    } else if (c === sep) {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i++
      if (row.length === 0 && cell === '' && !touched) continue
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      touched = false
    } else cell += c
  }
  if ((cell !== '' || row.length > 0 || touched) && rows.length < max) rows.push([...row, cell])
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

function Formatted({ format, text, path, prefix, onLink }: { format: Format; text: string; path: string; prefix: string; onLink: (path: string) => void }) {
  const html = useMemo(() => (format === 'markdown' ? renderMarkdown(text, path, prefix) : ''), [format, text, path, prefix])
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
      const heading = anchor ? event.currentTarget.querySelector<HTMLElement>(`[id="${anchor}"]`) : null
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

export function FilePreview({
  file,
  files,
  onClose,
  onDock,
  terminal,
  canQuote = false,
  visible = true,
}: {
  file: FileRef
  files: FileTouch[]
  onClose: () => void
  onDock?: (file: FileRef) => void
  terminal?: RefObject<TerminalHandle | null>
  canQuote?: boolean
  visible?: boolean
}) {
  const id = useId()
  const docked = terminal !== undefined
  const ref = useRef<HTMLDialogElement | null>(null)
  const title = useRef<HTMLHeadingElement | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const moved = useRef(false)
  const noteSeq = useRef(0)
  const loaded = useRef({ key: '', stamp: '' })
  const [shown, setShown] = useState(file)
  const [trail, setTrail] = useState([file.path])
  const [read, setRead] = useState<{ key: string; result: ApiResult<FileView> } | null>(null)
  const [note, setNote] = useState('')
  const [source, setSource] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [quotable, setQuotable] = useState(false)
  if (shown !== file) {
    setShown(file)
    setTrail([file.path])
    setSource(false)
  }
  const path = trail[trail.length - 1]
  const key = `${file.session}\n${path}\n${attempt}`
  const result = read?.key === key ? read.result : null
  const hold = quotable || !visible
  const at = files.findIndex((f) => f.path === path)
  const touch = files[at]
  const stamp = touch ? `${touch.at} ${touch.count} ${touch.gone}` : ''
  const prev = at < 0 ? undefined : files.slice(0, at).findLast((f) => !f.gone)
  const next = at < 0 ? undefined : files.slice(at + 1).find((f) => !f.gone)
  const latestNote = () => {
    const at = ++noteSeq.current
    return (message: string) => {
      if (noteSeq.current === at) setNote(message)
    }
  }
  const follow = (target: string) => {
    if (target === path) return
    if (files.some((f) => f.path === target)) {
      moved.current = true
      setTrail((t) => [...t, target])
      setSource(false)
    } else latestNote()(`${baseName(target)} isn't a file this agent wrote, so it can't be opened here`)
  }
  const step = (to: FileTouch | undefined) => {
    if (!to) return
    moved.current = false
    setTrail([to.path])
    setSource(false)
  }

  useEffect(() => {
    const dialog = ref.current
    if (!dialog || dialog.open) return
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
  }, [])

  useEffect(() => {
    const refresh = loaded.current.key === key
    if (refresh && (!stamp || stamp === loaded.current.stamp || touch?.gone || hold)) return
    const before = result?.kind === 'ok' ? result.data : null
    let live = true
    let retry = 0
    const say = latestNote()
    if (!refresh) setNote('')
    const fetchFile = (tries: number) =>
      void getFile(file.session, path).then((r) => {
        if (!live) return
        const same = refresh && r.kind === 'ok' && r.data.mtime === before?.mtime && r.data.size === before.size && r.data.text === before.text
        if (refresh && (same || r.kind !== 'ok') && tries > 0) {
          retry = window.setTimeout(() => fetchFile(tries - 1), STALE_RETRY_MS)
          return
        }
        if (refresh && r.kind !== 'ok') return
        loaded.current = { key, stamp }
        setRead({ key, result: r })
        if (refresh && !same) say("Updated to the agent's latest edit")
      })
    fetchFile(loaded.current.stamp ? 2 : 0)
    return () => {
      live = false
      window.clearTimeout(retry)
    }
  }, [key, stamp, hold])

  useEffect(() => {
    if (moved.current) title.current?.focus()
  }, [path])

  useEffect(() => {
    const check = () => {
      const selection = document.getSelection()
      const root = body.current?.parentElement
      const inside = (node: Node | null) => node !== null && body.current?.contains(node) === true
      setQuotable(
        selection !== null && !selection.isCollapsed && inside(selection.anchorNode) && inside(selection.focusNode) && root?.contains(document.activeElement) === true,
      )
    }
    document.addEventListener('selectionchange', check)
    document.addEventListener('focusin', check)
    return () => {
      document.removeEventListener('selectionchange', check)
      document.removeEventListener('focusin', check)
    }
  }, [])

  const close = () => {
    if (docked) {
      terminal.current?.focus()
      onClose()
    } else if (typeof ref.current?.close === 'function' && ref.current.open) ref.current.close()
    else onClose()
  }
  const copy = (text: string, done: string, instead: string) => {
    const say = latestNote()
    const failed = `Could not copy — ${instead}`
    if (!navigator.clipboard) say(failed)
    else
      void navigator.clipboard.writeText(text).then(
        () => say(done),
        () => say(failed),
      )
  }
  const open = () => {
    const say = latestNote()
    void openFile(file.session, path).then((r) =>
      say(r.kind !== 'ok' ? failure(r) : r.data.revealed ? 'Not a document type, so it is shown in its folder instead' : 'Opened on this laptop'),
    )
  }
  const quote = () => {
    const say = latestNote()
    const text = quotable ? (document.getSelection()?.toString().trimEnd() ?? '') : ''
    if (!text || !terminal?.current) return say('Select text in the file first, then quote it into your reply')
    const block = text
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n')
    if (!canQuote || !terminal.current.paste(`${block}\n\n`)) return say("The agent isn't in front in this terminal, so nothing was sent")
    terminal.current.focus()
    say(block.length > LONG_PASTE ? 'Quoted. Claude Code shows a long quote as [Pasted text], and the agent still gets all of it' : 'Quoted into your reply, not sent')
  }
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    const term = terminal?.current
    if (!term) return
    if (event.key === 'Escape' || event.key === 'F6') {
      event.preventDefault()
      term.focus(event.key === 'Escape')
    } else if (
      event.key.length === 1 &&
      event.key !== ' ' &&
      !event.metaKey &&
      !event.nativeEvent.isComposing &&
      ((event.getModifierState('AltGraph') && !/^[a-z\d]$/i.test(event.key)) || (!event.ctrlKey && (!event.altKey || String(navigator.platform).startsWith('Mac'))))
    ) {
      event.preventDefault()
      event.stopPropagation()
      term.focus()
      term.input(event.key)
    }
  }

  const view = result?.kind === 'ok' ? result.data : null
  const text = view?.kind === 'text' ? view.text : undefined
  const name = baseName(path)
  const format = useMemo(() => (view ? formatOf(view) : null), [view])
  const showSource = !format || source
  const cut = path.lastIndexOf('/', path.lastIndexOf('/') - 1) + 1
  const copyText = (body: string) =>
    copy(body, view?.truncated ? 'Copied the first 1 MB' : 'Text copied', showSource ? 'select the text below' : 'switch to Source and select it')
  const act = (icon: IconName, label: string) => (
    <>
      <Icon name={icon} size={14} />
      <span className="file-act">{label}</span>
    </>
  )
  const content = (
    <>
      <header className="file-head">
        <div className="file-title">
          <h2 id={id} ref={title} tabIndex={-1}>
            {name}
          </h2>
          <p className="file-path" title={path}>
            <span className="file-path-head">{path.slice(0, cut)}</span>
            <span className="file-path-tail">{path.slice(cut)}</span>
          </p>
          {view ? (
            <p className="file-facts">
              {size(view.size)} · changed {ago(Date.now(), view.mtime)} ago · {view.local ? 'laptop copy' : 'read from host'}
            </p>
          ) : null}
        </div>
        <div className="detail-actions">
          {prev || next ? (
            <span className="file-step">
              <button type="button" aria-disabled={!prev} title={prev ? `Previous file: ${baseName(prev.path)}` : 'This is the first file'} onClick={() => step(prev)}>
                {act('previous', 'Previous file')}
              </button>
              <button type="button" aria-disabled={!next} title={next ? `Next file: ${baseName(next.path)}` : 'This is the last file'} onClick={() => step(next)}>
                {act('next', 'Next file')}
              </button>
            </span>
          ) : null}
          {trail.length > 1 ? (
            <button
              type="button"
              title="Back"
              onClick={() => {
                moved.current = true
                setTrail((t) => t.slice(0, -1))
                setSource(false)
              }}
            >
              {act('back', 'Back')}
            </button>
          ) : null}
          {docked ? (
            <button
              type="button"
              aria-disabled={!quotable || !canQuote}
              title={canQuote ? 'Quote the selected text into your reply' : "Quoting works while the agent's prompt is in front in this terminal"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={quote}
            >
              {act('quote', 'Quote into reply')}
            </button>
          ) : null}
          {onDock ? (
            <button type="button" title="Keep this file open beside the session's terminal" onClick={() => onDock({ session: file.session, path })}>
              {act('side', 'Open beside terminal')}
            </button>
          ) : null}
          {view?.local ? (
            <button type="button" className={docked ? undefined : 'primary'} title="Open on laptop" onClick={open}>
              {act('open', 'Open on laptop')}
            </button>
          ) : null}
          {view?.data ? (
            <a className="button" href={view.data} download={name} title="Download">
              {act('download', 'Download')}
            </a>
          ) : null}
          {text ? (
            <button type="button" title="Copy text" onClick={() => copyText(text)}>
              {act('copy', 'Copy text')}
            </button>
          ) : null}
          <button type="button" title="Copy path" onClick={() => copy(path, 'Path copied', 'select the path above')}>
            {act('link', 'Copy path')}
          </button>
          <button type="button" title={docked ? 'Close (Esc returns to the terminal)' : 'Close'} onClick={close}>
            {act('x', 'Close')}
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
      <div className="file-body" ref={body} role="region" aria-labelledby={id} tabIndex={0}>
        {touch?.gone && view ? <p className="banner">The agent deleted this file; this is the last copy read.</p> : null}
        {result === null ? <p className="lane-empty">Loading…</p> : null}
        {result && result.kind !== 'ok' ? (
          <p role="alert" className="banner">
            {failure(result)}
            {retriable(result) ? (
              <button type="button" className="conn-retry" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            ) : null}
          </p>
        ) : null}
        {view?.kind === 'text' && view.text !== undefined ? (
          showSource || !format ? (
            <Source text={view.text} wrap={wrap} path={path} />
          ) : (
            <Formatted format={format} text={view.text} path={path} prefix={id} onLink={follow} />
          )
        ) : null}
        {view?.kind === 'image' && view.data ? <img className="file-image" src={view.data} alt={name} /> : null}
        {view?.kind === 'binary' ? (
          <p className="lane-empty">{view.truncated ? 'Too large to preview here.' : 'Binary file — download it or open it on the laptop.'}</p>
        ) : null}
        {view?.kind === 'text' && view.truncated ? <p className="hint">Showing the first 1 MB of {size(view.size)}.</p> : null}
      </div>
    </>
  )
  return docked ? (
    <aside
      className="file-pane"
      aria-labelledby={id}
      onKeyDown={keys}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.dataset.settled = ''
      }}
    >
      {content}
    </aside>
  ) : (
    <dialog ref={ref} className="file-preview" aria-labelledby={id} onClose={onClose}>
      {content}
    </dialog>
  )
}
