import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listWorkspaces } from '../../server/workspaces.js'

let root: string
let other: string

function folder(base: string, name: string, epoch: number) {
  const dir = path.join(base, name)
  mkdirSync(dir)
  utimesSync(dir, epoch, epoch)
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'devbox-ws-root.'))
  other = mkdtempSync(path.join(tmpdir(), 'devbox-ws-other.'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(other, { recursive: true, force: true })
})

describe('listWorkspaces', () => {
  it('hides folders the sync ignores, which devbox would refuse as workspaces', async () => {
    folder(root, 'build', 1000)
    folder(root, 'node_modules', 1000)
    folder(root, 'real', 1000)
    const res = await listWorkspaces([{ name: 'work', localPath: root, remotePath: 'work' }], ['build/', 'node_modules/', '/env'])
    expect(res.workspaces.map((w) => w.name)).toEqual(['real'])
  })

  it('lists folders under every sync root, newest first', async () => {
    folder(root, 'old-proj', 1000)
    folder(root, 'new-proj', 3000)
    folder(other, 'mid-proj', 2000)
    const res = await listWorkspaces([
      { name: 'work', localPath: root, remotePath: 'work' },
      { name: 'lab', localPath: other, remotePath: 'lab' },
    ])
    expect(res.workspaces).toEqual([
      { root: 'work', name: 'new-proj', mtime: 3000 },
      { root: 'lab', name: 'mid-proj', mtime: 2000 },
      { root: 'work', name: 'old-proj', mtime: 1000 },
    ])
    expect(res.roots).toEqual([
      { name: 'work', localPath: root },
      { name: 'lab', localPath: other },
    ])
  })

  it('skips files and names devbox would refuse', async () => {
    folder(root, 'ok_1', 1000)
    folder(root, '.hidden', 1000)
    folder(root, 'has space', 1000)
    folder(root, 'a.b', 1000)
    writeFileSync(path.join(root, 'Makefile'), '')
    const names = (await listWorkspaces([{ name: 'work', localPath: root, remotePath: 'work' }])).workspaces.map((w) => w.name)
    expect(names).toEqual(['ok_1'])
  })

  it('tolerates a missing sync root', async () => {
    folder(root, 'proj', 1000)
    const res = await listWorkspaces([
      { name: 'gone', localPath: path.join(root, 'nope'), remotePath: 'gone' },
      { name: 'work', localPath: root, remotePath: 'work' },
    ])
    expect(res.workspaces.map((w) => w.name)).toEqual(['proj'])
  })
})
