import { request } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type App } from '../../server/index.js'

const stubsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../stubs')

interface Reply {
  status: number
  body: Record<string, unknown>
}

let app: App
let root: string
let stateDir: string
let distRoot: string
let log: string

function call(method: string, pathname: string, opts: { body?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: app.port,
        method,
        path: pathname,
        headers: {
          Host: `127.0.0.1:${app.port}`,
          Authorization: `Bearer ${app.token}`,
          ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...opts.headers,
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString()
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? (JSON.parse(data) as Record<string, unknown>) : {} }))
      },
    )
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  call('POST', '/api/sessions', { body: JSON.stringify(body), headers })

const logLines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean)

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'devbox-spawn-root.'))
  mkdirSync(path.join(root, 'existing-proj'))
  writeFileSync(path.join(root, 'notes.txt'), '')
  stateDir = mkdtempSync(path.join(tmpdir(), 'devbox-spawn-state.'))
  distRoot = mkdtempSync(path.join(tmpdir(), 'devbox-spawn-dist.'))
  log = path.join(stateDir, 'stub.log')
  process.env.DEVBOX_STUB_ROOT = root
  process.env.STUB_LOG = log
  app = await createApp({ port: 0, bin: stubsDir, stateDir, distRoot, version: '0' })
})

afterAll(async () => {
  await app.close()
  delete process.env.DEVBOX_STUB_ROOT
  delete process.env.STUB_LOG
  delete process.env.DEVBOX_STUB_DETACH
  for (const dir of [root, stateDir, distRoot]) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  writeFileSync(log, '')
  delete process.env.DEVBOX_STUB_DETACH
})

describe('GET /api/workspaces', () => {
  it('lists the folders under the configured sync roots', async () => {
    const res = await call('GET', '/api/workspaces')
    expect(res.status).toBe(200)
    expect(res.body.workspaces).toEqual([expect.objectContaining({ root: 'dotfiles', name: 'existing-proj' })])
  })
})

describe('POST /api/sessions', () => {
  it('starts a Claude Code session in the chosen root with the logical cwd', async () => {
    const res = await post({ name: 'proj', root: 'dotfiles', agent: 'cc' })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ name: 'proj', created: true })
    expect(logLines()).toContain('--detach --cc proj')
    expect(logLines()).toContain(`PWD=${root}`)
  })

  it('reports an already running session with 200', async () => {
    process.env.DEVBOX_STUB_DETACH = 'exists'
    const res = await post({ name: 'proj', root: 'dotfiles', agent: 'codex' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ name: 'proj', created: false })
    expect(logLines()).toContain('--detach --codex proj')
  })

  it('starts a plain shell session without an agent flag', async () => {
    const res = await post({ name: 'proj', root: 'dotfiles', agent: 'shell' })
    expect(res.status).toBe(201)
    expect(logLines()).toContain('--detach proj')
  })

  it('maps a devbox failure to 502 with its message', async () => {
    process.env.DEVBOX_STUB_DETACH = 'fail'
    const res = await post({ name: 'proj', root: 'dotfiles', agent: 'cc' })
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ error: 'remote_unreachable' })
    expect(String(res.body.message)).toContain('could not start proj')
  })

  it.each([
    [{ name: 'a b', root: 'dotfiles', agent: 'cc' }, 'bad_name'],
    [{ name: '-x', root: 'dotfiles', agent: 'cc' }, 'bad_name'],
    [{ name: 'proj', root: 'nope', agent: 'cc' }, 'bad_root'],
    [{ name: 'proj', root: 'dotfiles', agent: 'rm -rf' }, 'bad_agent'],
  ])('rejects %j with 400', async (body, code) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe(code)
    expect(logLines().some((l) => l.startsWith('--detach'))).toBe(false)
  })

  it('requires a JSON content type, a bounded body, the token, and a local origin', async () => {
    expect((await call('POST', '/api/sessions', { body: 'name=proj', headers: { 'Content-Type': 'text/plain' } })).status).toBe(415)
    expect((await call('POST', '/api/sessions', { body: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }) })).status).toBe(413)
    expect((await post({ name: 'proj', root: 'dotfiles' }, { Authorization: 'Bearer nope' })).status).toBe(401)
    expect((await post({ name: 'proj', root: 'dotfiles' }, { Origin: 'http://evil.example' })).status).toBe(403)
    expect(logLines().some((l) => l.startsWith('--detach'))).toBe(false)
  })

  it('refreshes the session list after creating a session', async () => {
    await call('GET', '/api/sessions')
    await call('GET', '/api/sessions')
    const probesBefore = logLines().filter((l) => l === 'status --raw').length
    await post({ name: 'proj', root: 'dotfiles', agent: 'cc' })
    await call('GET', '/api/sessions')
    const probesAfter = logLines().filter((l) => l === 'status --raw').length
    expect(probesAfter).toBe(probesBefore + 1)
  })
})
