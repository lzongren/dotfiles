import { useEffect, useId, useRef, useState } from 'react'
import { getFile, openFile, type ApiResult } from '../api'
import type { FileTouch, FileView } from '../shared/types'
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

export function FilePreview({ file, onClose }: { file: FileRef; onClose: () => void }) {
  const id = useId()
  const ref = useRef<HTMLDialogElement | null>(null)
  const [result, setResult] = useState<ApiResult<FileView> | null>(null)
  const [note, setNote] = useState('')

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
    void getFile(file.session, file.path).then((r) => {
      if (live) setResult(r)
    })
    return () => {
      live = false
    }
  }, [file.session, file.path])

  const close = () => {
    if (typeof ref.current?.close === 'function' && ref.current.open) ref.current.close()
    else onClose()
  }
  const copy = () => {
    void navigator.clipboard
      ?.writeText(file.path)
      .then(() => setNote('Path copied'))
      .catch(() => setNote('Could not copy — select the path above'))
  }
  const open = () => {
    void openFile(file.session, file.path).then((r) =>
      setNote(r.kind !== 'ok' ? failure(r) : r.data.revealed ? 'Not a document type, so it is shown in its folder instead' : 'Opened on this laptop'),
    )
  }

  const view = result?.kind === 'ok' ? result.data : null
  const name = baseName(file.path)
  return (
    <dialog ref={ref} className="file-preview" aria-labelledby={id} onClose={onClose}>
      <header className="file-head">
        <div className="file-title">
          <h2 id={id}>{name}</h2>
          <p className="file-path">{file.path}</p>
          {view ? (
            <p className="file-facts">
              {size(view.size)} · changed {ago(Date.now(), view.mtime)} ago · {view.local ? 'laptop copy' : 'read from host'}
            </p>
          ) : null}
        </div>
        <div className="detail-actions">
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
      <p className="file-note" role="status">
        {note}
      </p>
      <div className="file-body">
        {result === null ? <p className="lane-empty">Loading…</p> : null}
        {result && result.kind !== 'ok' ? (
          <p role="alert" className="banner">
            {failure(result)}
          </p>
        ) : null}
        {view?.kind === 'text' ? (
          <pre className="file-text" tabIndex={0} aria-label={`${name} contents`}>
            {view.text}
          </pre>
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
