import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { SESSION_NAME_RE } from '../src/shared/validate.js'
import type { WorkspacesResponse } from '../src/shared/types.js'
import type { SyncEntry } from './config.js'

const LIMIT = 500

export function listWorkspaces(syncs: SyncEntry[]): WorkspacesResponse {
  const workspaces: WorkspacesResponse['workspaces'] = []
  for (const sync of syncs) {
    let entries
    try {
      entries = readdirSync(sync.localPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_NAME_RE.test(entry.name)) continue
      let mtime = 0
      try {
        mtime = Math.floor(statSync(path.join(sync.localPath, entry.name)).mtimeMs / 1000)
      } catch {
        continue
      }
      workspaces.push({ root: sync.name, name: entry.name, mtime })
    }
  }
  workspaces.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
  return {
    roots: syncs.map((s) => ({ name: s.name, localPath: s.localPath })),
    workspaces: workspaces.slice(0, LIMIT),
  }
}
