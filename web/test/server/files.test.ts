import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { allowed, describeFile, localMirror } from '../../server/files.js'
import { createApp, type App } from '../../server/index.js'

const stubsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../stubs')

describe('file access rules', () => {
  it('allows files the agent touched or that sit under its folder, nothing else', () => {
    expect(allowed('/home/me/work/demo/src/a.ts', '/home/me/work/demo', [])).toBe(true)
    expect(allowed('/tmp/report.html', '/home/me/work/demo', ['/tmp/report.html'])).toBe(true)
    expect(allowed('/home/me/.ssh/id_ed25519', '/home/me/work/demo', [])).toBe(false)
    expect(allowed('/home/me/work/demo/../../.ssh/id_ed25519', '/home/me/work/demo', [])).toBe(false)
    expect(allowed('/home/me/work/demo-other/a', '/home/me/work/demo', [])).toBe(false)
    expect(allowed('src/a.ts', '/home/me/work/demo', ['src/a.ts'])).toBe(false)
    expect(allowed('/home/me/work/demo/a\0b', '/home/me/work/demo', [])).toBe(false)
  })

  it('maps a host path to its synced laptop copy, relative roots resolved against the host home', () => {
    const syncs = [
      { name: 'a', localPath: '/Users/me/api', remotePath: 'work/api' },
      { name: 'b', localPath: '/Users/me/dots', remotePath: '/srv/dots/' },
    ]
    expect(localMirror('/home/me/work/api/src/x.ts', '/home/me', syncs)).toEqual({ file: '/Users/me/api/src/x.ts', root: '/Users/me/api' })
    expect(localMirror('/srv/dots/zshrc', undefined, syncs)).toEqual({ file: '/Users/me/dots/zshrc', root: '/Users/me/dots' })
    expect(localMirror('/home/me/work/api-old/x', '/home/me', syncs)).toBeNull()
    expect(localMirror('/home/me/work/api/x', undefined, syncs)).toBeNull()
  })

  it('previews text, inlines small images, and offers binaries as a download', () => {
    expect(describeFile('/a.md', Buffer.from('# hi'), 4, 1)).toMatchObject({ kind: 'text', text: '# hi', truncated: false })
    expect(describeFile('/a.png', Buffer.from([1, 2]), 2, 1)).toMatchObject({ kind: 'image', data: 'data:image/png;base64,AQI=' })
    expect(describeFile('/a.png', Buffer.from([0, 2]), 9, 1)).toEqual(expect.objectContaining({ kind: 'binary', truncated: true }))
    expect(describeFile('/a.png', Buffer.from([0, 2]), 9, 1).data).toBeUndefined()
    expect(describeFile('/a.bin', Buffer.from([0, 1]), 2, 1)).toMatchObject({ kind: 'binary', data: 'data:application/octet-stream;base64,AAE=' })
  })
})

describe('file routes', () => {
  let app: App
  let root: string
  let outside: string
  const savedPath = process.env.PATH

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'devbox-files-root.'))
    outside = mkdtempSync(path.join(tmpdir(), 'devbox-files-out.'))
    mkdirSync(path.join(root, 'notes'))
    writeFileSync(path.join(root, 'notes/plan.md'), '# the plan\n')
    writeFileSync(path.join(outside, 'secret'), 'nope')
    mkdirSync(path.join(outside, 'dist'))
    mkdirSync(path.join(outside, 'probe'))
    writeFileSync(path.join(outside, 'probe/agent-probe.py'), 'print("probe body")\n')
    symlinkSync(path.join(outside, 'secret'), path.join(root, 'notes/escape.md'))
    process.env.PATH = `${path.join(stubsDir, 'ssh-bin')}:${savedPath}`
    process.env.DEVBOX_STUB_ROOT = root
    process.env.OPEN_STUB_LOG = path.join(outside, 'open.log')
    app = await createApp({ port: 0, bin: stubsDir, stateDir: path.join(outside, 'state'), distRoot: path.join(outside, 'dist'), version: '0' })
  })

  afterAll(async () => {
    await app.close()
    process.env.PATH = savedPath
    delete process.env.DEVBOX_STUB_ROOT
    delete process.env.OPEN_STUB_LOG
    for (const dir of [root, outside]) rmSync(dir, { recursive: true, force: true })
  })

  const base = () => app.url.split('#')[0]
  const get = async (session: string, file: string) => {
    const res = await fetch(`${base()}api/file?${new URLSearchParams({ session, path: file }).toString()}`, {
      headers: { Authorization: `Bearer ${app.token}` },
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  const open = async (body: unknown) => {
    const res = await fetch(`${base()}api/file/open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  it('reads a touched file from its synced laptop copy', async () => {
    const res = await get('cc-demo', '/home/me/dotfiles/notes/plan.md')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ kind: 'text', text: '# the plan\n', size: 11, local: path.join(realpathSync(root), 'notes/plan.md') })
  })

  it('reads over ssh when there is no laptop copy, or when the copy links outside its sync root', async () => {
    expect((await get('cc-demo', '/home/me/work/demo/src/retry.ts')).body).toMatchObject({ kind: 'text', text: 'hello world', size: 11 })
    const escaped = await get('main', '/home/me/dotfiles/notes/escape.md')
    expect(escaped.body).toMatchObject({ text: 'hello world' })
    expect(escaped.body.local).toBeUndefined()
  })

  it('refuses files the session neither touched nor holds, and unknown sessions', async () => {
    expect((await get('cc-demo', '/home/me/.ssh/id_ed25519')).status).toBe(403)
    expect((await get('nope', '/home/me/work/demo/src/retry.ts')).status).toBe(403)
    expect((await get('cc-demo', '/home/me/work/demo/../../.ssh/id')).status).toBe(403)
  })

  it('opens only synced copies on the laptop', async () => {
    expect((await open({ session: 'cc-demo', path: '/home/me/dotfiles/notes/plan.md' })).status).toBe(200)
    await vi.waitFor(() => expect(readFileSync(process.env.OPEN_STUB_LOG!, 'utf8').trim()).toBe(path.join(realpathSync(root), 'notes/plan.md')))
    expect((await open({ session: 'cc-demo', path: '/home/me/work/demo/src/retry.ts' })).body.error).toBe('not_synced')
    expect((await open({ session: 'cc-demo', path: '/etc/passwd' })).status).toBe(403)
    expect((await open({ session: 1, path: '/etc/passwd' })).status).toBe(400)
  })
})
