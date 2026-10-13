import type {
  ApiError,
  CreateSessionRequest,
  CreateSessionResponse,
  FileView,
  InsightsResponse,
  NoteDaysResponse,
  NoteResponse,
  SessionsResponse,
  ThemeResponse,
  WorkspacesResponse,
} from './shared/types'
import { getToken } from './token'

export type ApiResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'unauthorized' }
  | { kind: 'unreachable'; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'error'; message: string; status?: number; body?: unknown }

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
  if (!res.ok) return { kind: 'error', message: body?.message ?? `request failed (${res.status})`, status: res.status, body }
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

export function getTheme(): Promise<ApiResult<ThemeResponse>> {
  return fetchJson<ThemeResponse>('/api/theme')
}

export function getNoteDays(): Promise<ApiResult<NoteDaysResponse>> {
  return fetchJson<NoteDaysResponse>('/api/notes')
}

export function getNote(day: string): Promise<ApiResult<NoteResponse>> {
  return fetchJson<NoteResponse>(`/api/notes/${day}`)
}

export function putNote(day: string, text: string, base: string): Promise<ApiResult<{ version: string }>> {
  return fetchJson<{ version: string }>(`/api/notes/${day}`, { method: 'PUT', body: { text, base } })
}

export function getFile(session: string, path: string): Promise<ApiResult<FileView>> {
  return fetchJson<FileView>(`/api/file?${new URLSearchParams({ session, path }).toString()}`)
}

export function openFile(session: string, path: string): Promise<ApiResult<{ opened: string; revealed: boolean }>> {
  return fetchJson<{ opened: string; revealed: boolean }>('/api/file/open', { method: 'POST', body: { session, path } })
}
