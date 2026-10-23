import type { Basis, Correction, Separation, Work } from './recover.js'

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
  files?: FileTouch[]
  error?: string
}

export interface FileTouch {
  path: string
  action: 'created' | 'edited' | 'deleted'
  at: number
  count: number
  gone: boolean
}

export interface InsightsResponse {
  fetchedAt: number
  home?: string
  agents: AgentInsight[]
}

export interface FileView {
  path: string
  size: number
  mtime: number
  kind: 'text' | 'image' | 'binary'
  text?: string
  data?: string
  truncated: boolean
  local?: string
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


export type CreateSessionRequest = { name: string; agent: AgentChoice; goal?: string } & ({ root: string } | { beside: string })

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

export interface ReturnTarget {
  session: string
  pane: string
  sessionId: string
}

export interface DraftState {
  text: string
  basis: Basis[] | null
  corrections: Correction[]
  earlier: string[]
  target: ReturnTarget | null
  quote?: Record<string, boolean>
  others?: string[]
  setAside?: string[]
  read?: string[]
  follows?: number
  savedAt?: number
}

export type RepairState = 'sending' | 'delivered' | 'working' | 'replied' | 'held' | 'failed' | 'unknown'

export interface Repair {
  id: string
  packet: string
  target: ReturnTarget
  basis: Basis[]
  version: string
  draftVersion: string
  sentAt: number
  state: RepairState
  reason?: string
  deliveredId?: string
  replyId?: string
  reply?: string
  repliedAt?: number
  accepted?: { at: number; replyId: string }
  check?: string
  checked?: { earlier: string[]; setAside?: string[]; read?: string[] }
}

export type InquiryState = 'sending' | 'running' | 'replied' | 'failed' | 'unknown'

export interface Inquiry {
  id: string
  question: string
  target: ReturnTarget
  version: string
  askedAt: number
  state: InquiryState
  answer?: string
  cost?: number
  tools?: string[]
  calls?: string[]
  reason?: string
  repliedAt?: number
}

export interface WorkState {
  key: string
  draft: DraftState | null
  draftVersion: string
  repairs: Repair[]
  inquiries: Inquiry[]
  decisions: Record<string, string>
  separations: Separation[]
  seenAt?: number
  lookedAt?: number
  goal?: string
}

export interface ProbeRecord {
  id: string
  kind: 'decision' | 'agent' | 'failure' | 'shell' | 'devbox'
  at: number
  text: string
  turn?: number
  final?: boolean
}

export interface ProbeSession {
  name: string
  pane: string
  cmd: string
  agent: 'claude' | 'codex' | 'shell'
  path: string
  repo?: string
  branch?: string
  registry?: { sessionId: string; status: string; waitingFor?: string; since?: number }
  transcript?: { ino: number; size: number; last: string; sid?: string }
  closes?: boolean
  records: ProbeRecord[]
  dropped?: Record<string, number>
  partial?: boolean
  turnEnds?: number[]
}

export interface ReturnResponse {
  questionBudgetUsd?: number
  session: string
  host: string
  fetchedAt: number
  work: Work
  sessions: ProbeSession[]
  state: WorkState
  separated: Separation[]
  lookalikes: Lookalike[]
  apart?: string
}

export interface Lookalike {
  name: string
  path: string
  repo?: string
  branch?: string
  why: 'branch' | 'folder'
}

export interface ReturnSummary {
  activity?: string
  draft: boolean
  repair?: RepairState
  sent?: string
  goal?: string
  accepted?: boolean
  missed?: string[]
  open?: number
  looked?: number
  question?: boolean
  asking: number
  answered: number
}
