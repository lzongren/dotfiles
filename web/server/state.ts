import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

export function removeState(dir: string): void {
  rmSync(path.join(dir, 'state.json'), { force: true })
}
