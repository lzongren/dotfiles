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

export interface Health {
  ok: true
  version: string
  host: string
}

export interface ApiError {
  error: string
  message: string
}
