import type { AgentInsight, AgentState, Artifact, InsightsResponse } from '../src/shared/types.js'
import type { RunResult } from './exec.js'
import { RemoteUnreachableError } from './sessions.js'

export interface ArtifactPattern {
  label: string
  pattern: string
  link?: string
}

const STATES: AgentState[] = ['working', 'waiting', 'ready', 'error', 'unknown']
const SSH_FAILED = 255

function str(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function artifact(raw: unknown): Artifact | null {
  const a = (raw ?? {}) as Record<string, unknown>
  const url = str(a.url, 500)
  const label = str(a.label, 24)
  if (!url || !label || !/^https?:\/\//.test(url)) return null
  const action = str(a.action, 24)
  const at = num(a.at) ?? 0
  return { label, url, at, first: num(a.first) ?? at, hits: num(a.hits) ?? 1, said: a.said === true, ...(action ? { action } : {}) }
}

function insight(raw: unknown): AgentInsight | null {
  const r = (raw ?? {}) as Record<string, unknown>
  const session = str(r.session, 128)
  if (!session || (r.agent !== 'claude' && r.agent !== 'codex')) return null
  const out: AgentInsight = {
    session,
    agent: r.agent,
    state: STATES.includes(r.state as AgentState) ? (r.state as AgentState) : 'unknown',
    artifacts: Array.isArray(r.artifacts) ? r.artifacts.map(artifact).filter((a): a is Artifact => a !== null) : [],
    commits: num(r.commits) ?? 0,
  }
  const texts: Array<[keyof AgentInsight, number]> = [
    ['waitingFor', 80],
    ['title', 160],
    ['ask', 800],
    ['firstAsk', 800],
    ['summary', 1600],
    ['model', 80],
    ['branch', 200],
    ['error', 160],
  ]
  for (const [key, max] of texts) {
    const value = str(r[key], max)
    if (value) Object.assign(out, { [key]: value })
  }
  for (const key of ['since', 'askAt', 'summaryAt', 'turnAt'] as const) {
    const value = num(r[key])
    if (value !== undefined) out[key] = value
  }
  const t = (r.tasks ?? null) as Record<string, unknown> | null
  const done = num(t?.done)
  const total = num(t?.total)
  if (done !== undefined && total !== undefined) {
    const current = str(t?.current, 160)
    out.tasks = { done, total, ...(current ? { current } : {}) }
  }
  return out
}

export function parseInsights(stdout: string): AgentInsight[] {
  const doc = JSON.parse(stdout) as { agents?: unknown }
  if (!Array.isArray(doc.agents)) throw new Error('probe output has no agents')
  return doc.agents.map(insight).filter((a): a is AgentInsight => a !== null)
}

export function probeScript(source: string, artifacts: ArtifactPattern[]): string {
  return `ARGS = __import__("json").loads(${JSON.stringify(JSON.stringify({ artifacts }))})\n${source}`
}

export function createInsightsSource(runner: () => Promise<RunResult>, ttlMs = 10000): () => Promise<InsightsResponse> {
  let cached: InsightsResponse | null = null
  let inflight: Promise<InsightsResponse> | null = null
  return () => {
    if (cached && Date.now() - cached.fetchedAt < ttlMs) return Promise.resolve(cached)
    inflight ??= runner()
      .then((res) => {
        const reason = res.stderr.trim().split('\n').pop() ?? ''
        if (res.exitCode === SSH_FAILED) throw new RemoteUnreachableError(reason || 'remote unreachable')
        if (res.exitCode === 127) throw new Error('python3 is not installed on the remote host')
        if (res.exitCode !== 0) throw new Error(`agent probe failed: ${reason || `exit ${res.exitCode}`}`)
        cached = { fetchedAt: Date.now(), agents: parseInsights(res.stdout) }
        return cached
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
}
