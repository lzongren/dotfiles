import { get as httpGet } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '../../server/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const stubsDir = path.resolve(here, '../stubs')

interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function rawGet(port: number, pathname: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString()
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
  })
}

describe('http server', () => {
  let app: App
  let stateDir: string
  let distRoot: string

  beforeAll(async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'devbox-web-state.'))
    distRoot = mkdtempSync(path.join(tmpdir(), 'devbox-web-dist.'))
    writeFileSync(path.join(distRoot, 'index.html'), '<html><body>devbox</body></html>')
    mkdirSync(path.join(distRoot, 'assets'))
    writeFileSync(path.join(distRoot, 'assets', 'app.js'), 'console.log(1)')
    app = await createApp({ port: 0, bin: stubsDir, stateDir, distRoot, version: '1.2.3' })
  })

  afterAll(async () => {
    await app.close()
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(distRoot, { recursive: true, force: true })
  })

  const auth = () => ({ Authorization: `Bearer ${app.token}` })
  const host = () => ({ Host: `127.0.0.1:${app.port}` })

  it('serves health with version and host from the stubbed config', async () => {
    const res = await rawGet(app.port, '/api/health', { ...auth(), ...host() })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, version: '1.2.3', host: 'stub-host' })
  })

  it('serves the golden sessions payload from the fixture', async () => {
    const res = await rawGet(app.port, '/api/sessions', { ...auth(), ...host() })
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { host: string; fetchedAt: number; sessions: unknown[] }
    expect(body.host).toBe('stub-host')
    expect(body.sessions).toHaveLength(4)
    expect(body.sessions[1]).toMatchObject({ name: 'cc-atx', clients: 2, attached: true, bell: true })
    expect(body.sessions[2]).toMatchObject({ name: 'api - ~/work/api', attachable: false })
  })

  it('rejects a missing or wrong token with 401', async () => {
    const missing = await rawGet(app.port, '/api/sessions', { ...host() })
    expect(missing.status).toBe(401)
    const wrong = await rawGet(app.port, '/api/sessions', {
      ...host(),
      Authorization: `Bearer ${'f'.repeat(64)}`,
    })
    expect(wrong.status).toBe(401)
  })

  it('rejects an unexpected Host header with 403 on api and static', async () => {
    const api = await rawGet(app.port, '/api/health', { ...auth(), Host: 'evil.example:7733' })
    expect(api.status).toBe(403)
    const stat = await rawGet(app.port, '/', { Host: 'evil.example:7733' })
    expect(stat.status).toBe(403)
  })

  it('serves the static shell without a token but with security headers', async () => {
    const res = await rawGet(app.port, '/', host())
    expect(res.status).toBe(200)
    expect(res.body).toContain('devbox')
    expect(res.headers['content-security-policy']).toContain("default-src 'self'")
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('keeps security headers on error responses', async () => {
    const res = await rawGet(app.port, '/api/sessions', { ...host() })
    expect(res.headers['content-security-policy']).toContain("default-src 'self'")
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('answers a malformed absolute-form request target with 400 and keeps serving', async () => {
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = connect(app.port, '127.0.0.1', () => {
        sock.write(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\nConnection: close\r\n\r\n`)
      })
      let data = ''
      sock.on('data', (chunk: Buffer) => {
        data += chunk.toString()
      })
      sock.on('end', () => resolve(data))
      sock.on('error', reject)
    })
    expect(reply).toMatch(/^HTTP\/1\.1 400/)
    const health = await rawGet(app.port, '/api/health', { ...auth(), ...host() })
    expect(health.status).toBe(200)
  })

  it('blocks path traversal out of the dist root', async () => {
    const res = await rawGet(app.port, '/assets/../../../../etc/passwd', host())
    expect(res.status).toBe(404)
    expect(res.body).not.toContain('root:')
  })

  it('maps the unreachable stub mode to 502 with last-good semantics left to the client', async () => {
    process.env.DEVBOX_STUB_MODE = 'unreachable'
    try {
      const fresh = await createApp({
        port: 0,
        bin: stubsDir,
        stateDir: mkdtempSync(path.join(tmpdir(), 'devbox-web-state2.')),
        distRoot,
        version: '1.2.3',
      })
      const res = await rawGet(fresh.port, '/api/sessions', {
        Authorization: `Bearer ${fresh.token}`,
        Host: `127.0.0.1:${fresh.port}`,
      })
      expect(res.status).toBe(502)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'remote_unreachable' })
      await fresh.close()
    } finally {
      delete process.env.DEVBOX_STUB_MODE
    }
  })

  it('leaves a newer instance\'s state file alone when an old instance exits', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'devbox-web-state4.'))
    const { writeState, removeState } = await import('../../server/state.js')
    writeState(dir, { pid: process.pid + 1, port: 1, token: 'newer', version: '0' })
    removeState(dir, process.pid)
    expect(existsSync(path.join(dir, 'state.json'))).toBe(true)
    removeState(dir, process.pid + 1)
    expect(existsSync(path.join(dir, 'state.json'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a 0600 state file on start and removes it on close', async () => {
    const file = path.join(stateDir, 'state.json')
    const mode = statSync(file).mode & 0o777
    expect(mode).toBe(0o600)
    const state = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; port: number; token: string }
    expect(state.port).toBe(app.port)
    expect(state.token).toBe(app.token)
    const extraState = mkdtempSync(path.join(tmpdir(), 'devbox-web-state3.'))
    const fresh = await createApp({ port: 0, bin: stubsDir, stateDir: extraState, distRoot, version: '0' })
    expect(existsSync(path.join(extraState, 'state.json'))).toBe(true)
    await fresh.close()
    expect(existsSync(path.join(extraState, 'state.json'))).toBe(false)
  })
})
