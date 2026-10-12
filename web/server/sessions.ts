import type { RunResult } from './exec.js'
import { SESSION_NAME_RE } from '../src/shared/validate.js'
import type { Session, SessionsResponse } from '../src/shared/types.js'

export class RemoteUnreachableError extends Error {}

export function parseStatusRaw(stdout: string): Session[] {
  const trimmed = stdout.trim()
  if (trimmed === '' || trimmed === 'No sessions.') return []
  const sessions: Session[] = []
  for (const line of trimmed.split('\n')) {
    const parts = line.split('|')
    if (parts.length < 7) continue
    const clients = Number.parseInt(parts[1], 10) || 0
    sessions.push({
      name: parts[0],
      attached: clients > 0,
      clients,
      activityEpoch: Number.parseInt(parts[2], 10) || 0,
      bell: parts[3] === '1',
      cmd: parts[4],
      title: parts[5],
      path: parts.slice(6).join('|'),
      attachable: SESSION_NAME_RE.test(parts[0]),
    })
  }
  return sessions
}

type Runner = () => Promise<RunResult>

export interface SessionSource {
  (): Promise<SessionsResponse>
  invalidate(): void
}

export function createSessionSource(host: string, runner: Runner, ttlMs = 3000): SessionSource {
  let cached: SessionsResponse | null = null
  let inflight: Promise<SessionsResponse> | null = null
  let generation = 0
  const get = async function get(): Promise<SessionsResponse> {
    if (cached && Date.now() - cached.fetchedAt < ttlMs) return cached
    if (inflight) return inflight
    const startedAt = generation
    const probe: Promise<SessionsResponse> = runner()
      .then((res) => {
        if (res.exitCode !== 0) {
          throw new RemoteUnreachableError(res.stderr.trim() || 'remote unreachable')
        }
        const fresh = { host, fetchedAt: Date.now(), sessions: parseStatusRaw(res.stdout) }
        if (startedAt === generation) cached = fresh
        return fresh
      })
      .finally(() => {
        if (inflight === probe) inflight = null
      })
    inflight = probe
    return probe
  } as SessionSource
  get.invalidate = () => {
    cached = null
    inflight = null
    generation += 1
  }
  return get
}
