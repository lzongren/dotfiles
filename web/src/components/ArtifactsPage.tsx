import { useId, useState } from 'react'
import type { AgentInsight, Artifact, Session } from '../shared/types'
import { artifactName, ledger } from '../insights'
import { ago } from '../time'
import { baseName, FilePreview, type FileRef } from './FilePreview'
import { Icon } from './Icon'
import { titleOf } from './PickUp'
import { workFor } from './SessionsPage'
import type { HomeItem } from './work'

export function ArtifactsPage({
  sessions,
  insights,
  now,
  works,
  onOpen,
  onBack,
  onDock,
}: {
  sessions: Session[]
  insights: Map<string, AgentInsight>
  now: number
  works: HomeItem[]
  onOpen: (name: string) => void
  onBack: () => void
  onDock?: (file: FileRef) => void
}) {
  const id = useId()
  const [preview, setPreview] = useState<FileRef | null>(null)
  const from = (names: string[], action: string | undefined, at: number) => {
    const work = workFor(works, names[0])
    return [work ? titleOf(work) : '', names.join(', '), action, `${ago(now, at)} ago`].filter(Boolean).join(' · ')
  }
  const live = new Set(sessions.filter((s) => s.attachable).map((s) => s.name))
  const links: Array<Artifact & { session: string; by: Array<{ name: string; action?: string; first: number }> }> = []
  for (const a of ledger(
    sessions.map((s) => ({ name: s.name, artifacts: insights.get(s.name)?.artifacts ?? [] })),
    60,
    20,
  )) {
    const by = { name: a.session, action: a.action, first: a.first }
    const same = links.find((l) => l.url === a.url)
    if (same) same.by = [...same.by, by].sort((x, y) => x.first - y.first)
    else links.push({ ...a, by: [by] })
  }
  const named = (by: (typeof links)[number]['by']) => {
    const work = workFor(works, by[0].name)
    return by.length === 1 ? from([by[0].name], by[0].action, by[0].first) : [work ? titleOf(work) : '', by.map((b) => [b.name, b.action, `${ago(now, b.first)} ago`].filter(Boolean).join(' ')).join(', ')].filter(Boolean).join(' · ')
  }
  const files = sessions
    .flatMap((s) => (insights.get(s.name)?.files ?? []).filter((f) => !f.gone).map((f) => ({ ...f, session: s.name })))
    .sort((a, b) => b.at - a.at)
    .slice(0, 40)

  return (
    <section className="page" aria-labelledby={`${id}-title`}>
      <button type="button" className="link page-back" onClick={onBack}>
        <Icon name="back" />
        Back to Now
      </button>
      <h2 id={`${id}-title`} className="page-title">
        Artifacts
      </h2>
      <p className="page-sub">What the records name: pull requests and reviews, then files, each newest first. Open one to go back to its work.</p>
      {links.length || files.length ? null : <p className="lane-empty">No pull requests, reviews or files in the records yet.</p>}
      <ul className="page-rows">
        {links.map((a) => (
          <li key={`${a.session}${a.url}`}>
            <button type="button" className="page-row" disabled={!a.by.some((b) => live.has(b.name))} onClick={() => onOpen(a.by.findLast((b) => live.has(b.name))?.name ?? a.session)}>
              <Icon name="pr" />
              <span className="page-row-main">
                <strong>{artifactName(a)}</strong>
                <small>{named(a.by)}</small>
              </span>
              <Icon name="next" />
            </button>
            <a className="page-row-link" href={a.url} target="_blank" rel="noreferrer noopener">
              Open {artifactName(a)}
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          </li>
        ))}
        {files.map((f) => (
          <li key={`${f.session}${f.path}`}>
            <button type="button" className="page-row" title={f.path} disabled={!live.has(f.session)} onClick={() => onOpen(f.session)}>
              <Icon name="file" />
              <span className="page-row-main">
                <strong>{baseName(f.path)}</strong>
                <small>{from([f.session], f.action, f.at)}</small>
              </span>
              <Icon name="next" />
            </button>
            <button type="button" className="link page-row-link" aria-label={`Preview ${baseName(f.path)}`} onClick={() => setPreview({ session: f.session, path: f.path })}>
              Preview
            </button>
          </li>
        ))}
      </ul>
      {preview ? (
        <FilePreview
          key={`${preview.session}${preview.path}`}
          file={preview}
          files={insights.get(preview.session)?.files ?? []}
          onClose={() => setPreview(null)}
          onDock={
            onDock && live.has(preview.session)
              ? (file) => {
                  setPreview(null)
                  onDock(file)
                }
              : undefined
          }
        />
      ) : null}
    </section>
  )
}
