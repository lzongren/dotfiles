import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '../../server/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const stubsDir = path.resolve(here, '../stubs')

describe('GET /api/insights', () => {
  let app: App
  let root: string
  const savedPath = process.env.PATH

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'devbox-web-insights.'))
    mkdirSync(path.join(root, 'dist'))
    mkdirSync(path.join(root, 'probe'))
    writeFileSync(path.join(root, 'dist/index.html'), '<html></html>')
    writeFileSync(path.join(root, 'probe/agent-probe.py'), 'print("probe body")\n')
    process.env.PATH = `${path.join(stubsDir, 'ssh-bin')}:${savedPath}`
    process.env.SSH_STUB_LOG = path.join(root, 'ssh.log')
    app = await createApp({ port: 0, bin: stubsDir, stateDir: path.join(root, 'state'), distRoot: path.join(root, 'dist'), version: '0' })
  })

  afterAll(async () => {
    await app.close()
    process.env.PATH = savedPath
    delete process.env.SSH_STUB_LOG
    rmSync(root, { recursive: true, force: true })
  })

  const get = () => fetch(`${app.url.split('#')[0]}api/insights`, { headers: { Authorization: `Bearer ${app.token}` } })

  it('streams the probe to python3 on the configured host and returns the sanitized agents', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { agents: Array<{ session: string }> }
    expect(body.agents.map((a) => a.session)).toEqual(['cc-demo', 'logs'])
    const [argv, firstLine] = readFileSync(process.env.SSH_STUB_LOG!, 'utf8').split('\n')
    expect(argv).toBe('-T -o BatchMode=yes -o ConnectTimeout=10 -- stub-host python3 -I -')
    expect(firstLine).toMatch(/^ARGS = __import__\("json"\)\.loads\(/)
    expect(firstLine).toContain('CR')
  })

  it('needs the token like every other endpoint', async () => {
    const res = await fetch(`${app.url.split('#')[0]}api/insights`)
    expect(res.status).toBe(401)
  })
})
