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
    if (parts.length < 6) continue
    const clients = Number.parseInt(parts[1], 10) || 0
    sessions.push({
      name: parts[0],
      attached: clients > 0,
      clients,
      activityEpoch: Number.parseInt(parts[2], 10) || 0,
      bell: parts[3] === '1',
      cmd: parts[4],
      path: parts.slice(5).join('|'),
      attachable: SESSION_NAME_RE.test(parts[0]),
    })
  }
  return sessions
}

type Runner = () => Promise<RunResult>

export function createSessionSource(
  host: string,
  runner: Runner,
  ttlMs = 3000,
): () => Promise<SessionsResponse> {
  let cached: SessionsResponse | null = null
  let inflight: Promise<SessionsResponse> | null = null
  return async function get(): Promise<SessionsResponse> {
    if (cached && Date.now() - cached.fetchedAt < ttlMs) return cached
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const res = await runner()
        if (res.exitCode !== 0) {
          throw new RemoteUnreachableError(res.stderr.trim() || 'remote unreachable')
        }
        cached = { host, fetchedAt: Date.now(), sessions: parseStatusRaw(res.stdout) }
        return cached
      } finally {
        inflight = null
      }
    })()
    return inflight
  }
}
