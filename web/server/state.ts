import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface ServerState {
  pid: number
  port: number
  token: string
  version: string
}

export function writeState(dir: string, state: ServerState): void {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'state.json')
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
  renameSync(tmp, file)
}

export function removeState(dir: string, ownPid: number): void {
  const file = path.join(dir, 'state.json')
  let recordedPid: number | null = null
  try {
    recordedPid = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }).pid ?? null
  } catch {
    recordedPid = null
  }
  if (recordedPid === null || recordedPid === ownPid) rmSync(file, { force: true })
}
