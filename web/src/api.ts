import type {
  ApiError,
  CreateSessionRequest,
  CreateSessionResponse,
  InsightsResponse,
  SessionsResponse,
  WorkspacesResponse,
} from './shared/types'
import { getToken } from './token'

export type ApiResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'unauthorized' }
  | { kind: 'unreachable'; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'error'; message: string }

export async function fetchJson<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  let res: Response
  const headers: Record<string, string> = { Authorization: `Bearer ${getToken() ?? ''}` }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
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

export function getInsights(): Promise<ApiResult<InsightsResponse>> {
  return fetchJson<InsightsResponse>('/api/insights')
}

export function getWorkspaces(): Promise<ApiResult<WorkspacesResponse>> {
  return fetchJson<WorkspacesResponse>('/api/workspaces')
}

export function createSession(body: CreateSessionRequest): Promise<ApiResult<CreateSessionResponse>> {
  return fetchJson<CreateSessionResponse>('/api/sessions', { method: 'POST', body })
}
