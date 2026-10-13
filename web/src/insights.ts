import type { AgentInsight, Artifact, Session } from './shared/types'

export type Lane = 'needs' | 'working' | 'recent' | 'parked'

const KEY = 'devbox.seen'
const PARK_AFTER = 7 * 86400
const FIRST_VISIT_LOOKBACK = 12 * 3600

export function unread(insight: AgentInsight, seenAt: number): boolean {
  const changed = insight.summaryAt ?? insight.since
  return changed !== undefined && changed > seenAt
}

export function laneOf(session: Session, insight: AgentInsight | undefined, seenAt: number, nowMs: number): Lane {
  if (insight?.state === 'waiting' || insight?.state === 'error') return 'needs'
  if (insight?.state === 'working') return 'working'
  const idle = Math.floor(nowMs / 1000) - session.activityEpoch
  if (idle >= PARK_AFTER) return 'parked'
  if (session.bell || (insight?.state === 'ready' && unread(insight, seenAt))) return 'needs'
  return 'recent'
}

interface Stored {
  since: number
  sessions: Record<string, number>
}

function read(nowMs: number): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Stored | null
    if (raw && typeof raw.since === 'number' && raw.sessions && typeof raw.sessions === 'object') return raw
  } catch {
    void 0
  }
  const fresh = { since: Math.floor(nowMs / 1000) - FIRST_VISIT_LOOKBACK, sessions: {} }
  localStorage.setItem(KEY, JSON.stringify(fresh))
  return fresh
}

export function loadSeen(nowMs: number): { seenAt(name: string): number } {
  const stored = read(nowMs)
  return { seenAt: (name) => stored.sessions[name] ?? stored.since }
}

export function markSeen(name: string, nowMs: number): void {
  const stored = read(nowMs)
  stored.sessions[name] = Math.floor(nowMs / 1000)
  localStorage.setItem(KEY, JSON.stringify(stored))
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
  const ask = (insight?.firstAsk ?? insight?.ask ?? '').replace(/^\/[\w:-]+\s*/, '').trim()
  return ask.length > 80 ? `${ask.slice(0, 79)}…` : ask
}

export function modelName(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}
