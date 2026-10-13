export interface Session {
  name: string
  attached: boolean
  clients: number
  activityEpoch: number
  bell: boolean
  cmd: string
  title: string
  path: string
  attachable: boolean
}

export interface SessionsResponse {
  host: string
  fetchedAt: number
  sessions: Session[]
}

export type AgentState = 'working' | 'waiting' | 'ready' | 'error' | 'unknown'

export interface Artifact {
  label: string
  url: string
  at: number
  first: number
  hits: number
  said: boolean
  action?: string
}

export interface AgentInsight {
  session: string
  agent: 'claude' | 'codex'
  state: AgentState
  waitingFor?: string
  since?: number
  title?: string
  ask?: string
  askAt?: number
  firstAsk?: string
  summary?: string
  summaryAt?: number
  turnAt?: number
  model?: string
  branch?: string
  tasks?: { done: number; total: number; current?: string }
  artifacts: Artifact[]
  commits: number
  error?: string
}

export interface InsightsResponse {
  fetchedAt: number
  agents: AgentInsight[]
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

export interface Palette {
  background: string
  foreground: string
  cursor?: string
  cursorText?: string
  selectionBackground?: string
  selectionForeground?: string
  ansi: string[]
}

export interface GhosttyLook {
  dark: { name: string; palette: Palette }
  light?: { name: string; palette: Palette }
  fontFamily?: string[]
  fontSize?: number
  cursorStyle?: 'block' | 'bar' | 'underline'
  cursorBlink?: boolean
  minimumContrast: number
  boldIsBright: boolean
  fontThicken: boolean
  cellHeight?: { value: number; unit: 'px' | '%' }
  padding: [number, number, number, number]
}

export interface NoteDaysResponse {
  days: string[]
}

export interface NoteResponse {
  day: string
  text: string
  version: string
}

export interface ThemeResponse {
  ghostty: GhosttyLook | null
}
