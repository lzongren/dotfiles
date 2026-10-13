import { printConfig } from './exec.js'
import { isValidHost } from '../src/shared/validate.js'
import type { ArtifactPattern } from './insights.js'

export interface SyncEntry {
  name: string
  localPath: string
  remotePath: string
}

export interface WebConfig {
  host: string
  syncs: SyncEntry[]
  ignores: string[]
  artifacts: ArtifactPattern[]
}

export async function loadConfig(bin: string): Promise<WebConfig> {
  const { stdout, exitCode, stderr } = await printConfig(bin)
  if (exitCode !== 0) throw new Error(`devbox web --print-config failed: ${stderr.trim()}`)
  let host = ''
  const syncs: SyncEntry[] = []
  const ignores: string[] = []
  const artifacts: ArtifactPattern[] = []
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t')
    if (parts[0] === 'host' && parts[1]) {
      host = parts[1]
    } else if (parts[0] === 'sync' && parts.length >= 4) {
      syncs.push({ name: parts[1], localPath: parts[2], remotePath: parts[3] })
    } else if (parts[0] === 'ignore' && parts[1]) {
      ignores.push(parts[1])
    } else if (parts[0] === 'artifact' && parts[1] && parts[2]) {
      artifacts.push({ label: parts[1], pattern: parts[2], ...(parts[3] ? { link: parts[3] } : {}) })
    }
  }
  if (!isValidHost(host)) throw new Error(`invalid or missing host in devbox config: ${JSON.stringify(host)}`)
  return { host, syncs, ignores, artifacts }
}
