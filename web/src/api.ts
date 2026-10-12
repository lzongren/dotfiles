import type { ApiError, SessionsResponse } from './shared/types'
import { getToken } from './token'

export type ApiResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'unauthorized' }
  | { kind: 'unreachable'; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'error'; message: string }

export async function fetchJson<T>(path: string): Promise<ApiResult<T>> {
  let res: Response
  try {
    res = await fetch(path, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
  } catch {
    return { kind: 'network', message: 'devbox web server not reachable' }
  }
  if (res.status === 401) return { kind: 'unauthorized' }
  const body = (await res.json().catch(() => null)) as (T & ApiError) | null
  if (res.status === 502) return { kind: 'unreachable', message: body?.message ?? 'remote unreachable' }
  if (!res.ok) return { kind: 'error', message: body?.message ?? `request failed (${res.status})` }
  if (body === null) return { kind: 'error', message: 'invalid response' }
  return { kind: 'ok', data: body }
}

export function getSessions(): Promise<ApiResult<SessionsResponse>> {
  return fetchJson<SessionsResponse>('/api/sessions')
}
