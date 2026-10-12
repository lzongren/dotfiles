export interface Session {
  name: string
  attached: boolean
  clients: number
  activityEpoch: number
  bell: boolean
  cmd: string
  path: string
  attachable: boolean
}

export interface SessionsResponse {
  host: string
  fetchedAt: number
  sessions: Session[]
}

export interface Workspace {
  root: string
  name: string
  mtime: number
}

export interface WorkspacesResponse {
  roots: Array<{ name: string; localPath: string }>
  workspaces: Workspace[]
}

export type AgentChoice = 'cc' | 'codex' | 'shell'

export interface CreateSessionRequest {
  name: string
  root: string
  agent: AgentChoice
}

export interface CreateSessionResponse {
  name: string
  created: boolean
}

export interface ApiError {
  error: string
  message: string
}
