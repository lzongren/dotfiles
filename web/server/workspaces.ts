import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { SESSION_NAME_RE } from '../src/shared/validate.js'
import type { Workspace, WorkspacesResponse } from '../src/shared/types.js'
import type { SyncEntry } from './config.js'

const LIMIT = 500

function ignored(name: string, ignores: string[]): boolean {
  return ignores.includes(`${name}/`) || ignores.includes(`/${name}`)
}

async function listRoot(sync: SyncEntry, ignores: string[]): Promise<Workspace[]> {
  let entries
  try {
    entries = await readdir(sync.localPath, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = entries.filter((e) => e.isDirectory() && SESSION_NAME_RE.test(e.name) && !ignored(e.name, ignores))
  const stamped = await Promise.all(
    dirs.map(async (e) => {
      try {
        const info = await stat(path.join(sync.localPath, e.name))
        return { root: sync.name, name: e.name, mtime: Math.floor(info.mtimeMs / 1000) }
      } catch {
        return null
      }
    }),
  )
  return stamped.filter((w): w is Workspace => w !== null)
}

export async function listWorkspaces(syncs: SyncEntry[], ignores: string[] = []): Promise<WorkspacesResponse> {
  const perRoot = await Promise.all(syncs.map((sync) => listRoot(sync, ignores)))
  const workspaces = perRoot.flat()
  workspaces.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
  return {
    roots: syncs.map((s) => ({ name: s.name, localPath: s.localPath })),
    workspaces: workspaces.slice(0, LIMIT),
  }
}
