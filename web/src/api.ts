import type {
  ApiError,
  CreateSessionRequest,
  CreateSessionResponse,
  DraftState,
  FileView,
  InsightsResponse,
  NoteDaysResponse,
  NoteResponse,
  ReturnResponse,
  ReturnSummary,
  SessionsResponse,
  ThemeResponse,
  WorkspacesResponse,
} from './shared/types'
import { getToken } from './token'
import type { Brief, Work } from './shared/recover'

export type ApiResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'unauthorized' }
  | { kind: 'unreachable'; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'error'; message: string; status?: number; body?: unknown }

export async function fetchJson<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  let res: Response
  const headers: Record<string, string> = { Authorization: `Bearer ${getToken() ?? ''}` }
  const raw = init.body instanceof Blob
  if (init.body !== undefined) headers['Content-Type'] = raw ? 'application/octet-stream' : 'application/json'
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: raw ? (init.body as Blob) : JSON.stringify(init.body) }),
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

export const EXPIRED = "this tab's link expired — run devbox web for a fresh one"
export const SERVER_DOWN = "the dashboard server isn't answering — run devbox web"

export function explain(result: ApiResult<unknown>): string {
  if (result.kind === 'ok') return ''
  if (result.kind === 'unauthorized') return EXPIRED
  if (result.kind === 'network') return SERVER_DOWN
  return result.message
}

export function retriable(result: ApiResult<unknown>): boolean {
  return result.kind === 'network' || result.kind === 'unreachable' || (result.kind === 'error' && (result.status ?? 500) >= 500)
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

export async function uploadFile(session: string, file: File): Promise<ApiResult<{ path: string }>> {
  const result = await fetchJson<{ path?: unknown }>(`/api/upload?${new URLSearchParams({ session, name: file.name }).toString()}`, { method: 'POST', body: file })
  if (result.kind !== 'ok') return result
  const { path } = result.data
  return typeof path === 'string' && path.startsWith('/') ? { kind: 'ok', data: { path } } : { kind: 'error', message: 'unexpected reply' }
}

export function getReturn(session: string): Promise<ApiResult<ReturnResponse>> {
  return fetchJson<ReturnResponse>(`/api/return?${new URLSearchParams({ session }).toString()}`)
}

export function putReturnDraft(session: string, draft: DraftState, base: string): Promise<ApiResult<{ version: string }>> {
  return fetchJson<{ version: string }>('/api/return/draft', { method: 'PUT', body: { session, draft, base } })
}

export function postReturn<T = Record<string, unknown>>(route: 'repair' | 'accept' | 'ask' | 'seen' | 'decide' | 'separate', body: Record<string, unknown>): Promise<ApiResult<T>> {
  return fetchJson<T>(`/api/return/${route}`, { method: 'POST', body })
}

export interface BriefResponse {
  session: string
  work: Work
  agents: Record<string, 'claude' | 'codex' | 'shell'>
  brief: Brief
}

export async function getBrief(session: string, left?: number): Promise<ApiResult<BriefResponse>> {
  const q = new URLSearchParams({ session, ...(left === undefined ? {} : { left: String(Math.floor(left)) }) })
  const result = await fetchJson<BriefResponse>(`/api/return/brief?${q.toString()}`)
  if (result.kind !== 'ok') return result
  const { work, brief } = result.data
  return Array.isArray(work?.members) && Array.isArray(brief?.suggestions) ? result : { kind: 'error', message: 'unexpected reply' }
}

export function getReturnSummary(): Promise<ApiResult<{ sessions: Record<string, ReturnSummary> }>> {
  return fetchJson<{ sessions: Record<string, ReturnSummary> }>('/api/return/summary')
}
