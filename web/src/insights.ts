import type { AgentInsight, Artifact, Session } from './shared/types'

export type Lane = 'blocked' | 'ready' | 'working' | 'recent' | 'parked'

const KEY = 'devbox.seen'
const PARK_AFTER = 7 * 86400
const FIRST_VISIT_LOOKBACK = 12 * 3600

export function changeMark(session: Session, insight: AgentInsight | undefined): number {
  if (!insight) return session.activityEpoch
  return insight.turnAt ?? insight.since ?? session.activityEpoch
}

export function isFresh(session: Session, insight: AgentInsight | undefined, seenAt: number): boolean {
  if (insight && insight.state !== 'unknown')
    return (insight.state === 'ready' || insight.state === 'error') && changeMark(session, insight) > seenAt
  return session.bell && session.activityEpoch > seenAt
}

export function laneOf(session: Session, insight: AgentInsight | undefined, seenAt: number, nowMs: number): Lane {
  if (insight?.state === 'waiting') return 'blocked'
  if (insight?.state === 'working') return 'working'
  if (Math.floor(nowMs / 1000) - session.activityEpoch >= PARK_AFTER) return 'parked'
  if (!isFresh(session, insight, seenAt)) return 'recent'
  return insight?.state === 'error' ? 'blocked' : 'ready'
}

interface Stored {
  since: number
  sessions: Record<string, number>
}

let memory: Stored | null = null

function read(nowMs: number): Stored {
  if (memory) return memory
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Stored | null
    if (raw && typeof raw.since === 'number' && raw.sessions && typeof raw.sessions === 'object') return raw
  } catch {
    void 0
  }
  const fresh = { since: Math.floor(nowMs / 1000) - FIRST_VISIT_LOOKBACK, sessions: {} }
  write(fresh)
  return fresh
}

function write(stored: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(stored))
    memory = null
  } catch {
    memory = stored
  }
}

export function loadSeen(nowMs: number): { seenAt(name: string): number } {
  const stored = read(nowMs)
  return { seenAt: (name) => stored.sessions[name] ?? stored.since }
}

export function markSeen(names: string[], mark: (name: string) => number, nowMs: number): void {
  const stored = read(nowMs)
  for (const name of names) stored.sessions[name] = Math.max(stored.sessions[name] ?? 0, mark(name))
  write(stored)
}

export function projectOf(path: string): string {
  const home = /^(?:\/local)?\/home\/[^/]+|^\/Users\/[^/]+/.exec(path)
  if (!home) return `/${path.split('/').filter(Boolean)[0] ?? ''}`
  return path.slice(home[0].length).split('/').filter(Boolean)[0] ?? '~'
}

export function artifactName(artifact: Pick<Artifact, 'label' | 'url'>): string {
  const pull = /\/pull\/(\d+)/.exec(artifact.url)
  if (pull) return `PR #${pull[1]}`
  const last = artifact.url.split(/[/?#]/).filter(Boolean).pop() ?? artifact.label
  return /^\d+$/.test(last) ? `${artifact.label} ${last}` : last
}

function named(summary: string, artifact: Artifact): boolean {
  const pull = /\/pull\/(\d+)/.exec(artifact.url)
  if (pull) return new RegExp(`(?:PR\\s*#?|#)${pull[1]}\\b`).test(summary)
  return summary.includes(artifactName(artifact)) || summary.includes(artifact.url)
}

export function rankArtifacts(artifacts: Artifact[], summary = ''): Array<Artifact & { key: boolean }> {
  return artifacts
    .map((a) => ({ ...a, key: named(summary, a) }))
    .sort((a, b) => Number(b.key) - Number(a.key) || Number(b.said) - Number(a.said) || b.hits - a.hits || b.at - a.at)
}

export function displayTitle(paneHeadline: string, insight: AgentInsight | undefined): string {
  if (insight?.title) return insight.title
  if (paneHeadline) return paneHeadline
  const ask = [insight?.firstAsk, insight?.ask]
    .map((text) => (text ?? '').replace(/^\/[\w:-]+\s*/, '').trim())
    .find((text) => text !== '') ?? ''
  return ask.length > 80 ? `${ask.slice(0, 79)}…` : ask
}

export function ledger(
  rows: Array<{ name: string; artifacts: Artifact[] }>,
  limit = 12,
  perSession = 3,
): Array<Artifact & { session: string }> {
  return rows
    .flatMap((r) =>
      r.artifacts
        .filter((a) => a.said)
        .sort((a, b) => b.first - a.first)
        .slice(0, perSession)
        .map((a) => ({ ...a, session: r.name })),
    )
    .sort((a, b) => b.first - a.first)
    .slice(0, limit)
}

export function modelName(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}
