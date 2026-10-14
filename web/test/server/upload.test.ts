import { spawn, spawnSync } from 'node:child_process'
import { createServer, request } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '../../server/index.js'
import { BodyError, readBody } from '../../server/body.js'
import { parseUpload, UPLOAD_COMMAND, uploadInput } from '../../server/upload.js'
import { isUploadName, UPLOAD_MAX } from '../../src/shared/validate.js'

const stubsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../stubs')

describe('remote upload writer', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'devbox-upload.'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const run = (input: Buffer | Buffer[]) => {
    const out = spawnSync('sh', ['-c', UPLOAD_COMMAND.join(' ')], { input: Buffer.concat([input].flat()) })
    expect(out.status).toBe(0)
    return parseUpload(out.stdout.toString())
  }

  it('writes the bytes exactly and never overwrites, picking the next free name instead', () => {
    const data = Buffer.from([0, 10, 13, 255, 0x7b, 10, 10])
    expect(run(uploadInput(dir, 'shot.png', data))).toEqual({ path: path.join(dir, 'shot.png') })
    expect(run(uploadInput(dir, 'shot.png', Buffer.from('two')))).toEqual({ path: path.join(dir, 'shot (1).png') })
    symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'shot (2).png'))
    expect(run(uploadInput(dir, 'shot.png', Buffer.from('three')))).toEqual({ path: path.join(dir, 'shot (3).png') })
    expect(readFileSync(path.join(dir, 'shot.png'))).toEqual(data)
    expect(statSync(path.join(dir, 'shot.png')).mode & 0o777).toBe(0o600)
    expect(readFileSync(path.join(dir, 'shot (1).png'), 'utf8')).toBe('two')
    expect(existsSync(path.join(dir, 'nowhere'))).toBe(false)
    expect(run(uploadInput(dir, 'notes', Buffer.alloc(0)))).toEqual({ path: path.join(dir, 'notes') })
    const long = `${'é'.repeat(125)}x.txt`
    expect(run(uploadInput(dir, long, Buffer.from('1')))).toEqual({ path: path.join(dir, long) })
    expect(run(uploadInput(dir, long, Buffer.from('2')))).toEqual({ path: path.join(dir, `${'é'.repeat(123)} (1).txt`) })
    const ext = `a.${'x'.repeat(252)}`
    run(uploadInput(dir, ext, Buffer.from('1')))
    expect(run(uploadInput(dir, ext, Buffer.from('2')))).toEqual({ path: path.join(dir, `a (1).${'x'.repeat(249)}`) })
    expect(parseUpload('Welcome to the host\n{"path": "/w/a.txt"}\n')).toEqual({ path: '/w/a.txt' })
    expect(parseUpload('Loading env...{"path": "/w/b.txt"}')).toEqual({ path: '/w/b.txt' })
    expect(parseUpload('null')).toEqual({ error: 'unexpected writer output' })
  })

  it('removes a file that arrived short, and reports a missing folder', () => {
    const input = Buffer.concat(uploadInput(dir, 'cut.bin', Buffer.alloc(100_000, 7)))
    expect(run(input.subarray(0, input.length - 10))).toEqual({ error: 'upload cut short' })
    expect(readdirSync(dir)).not.toContain('cut.bin')
    expect(run(uploadInput(path.join(dir, 'gone'), 'a.txt', Buffer.from('x')))).toEqual({ error: 'No such file or directory' })
  })

  it('gives up on an upload that stops arriving and removes what it wrote', async () => {
    const child = spawn('sh', ['-c', UPLOAD_COMMAND.join(' ')])
    const exited = new Promise((ok) => child.on('exit', ok))
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    try {
      const [head, data] = uploadInput(dir, 'stalled.bin', Buffer.alloc(200_000, 1), 1)
      child.stdin.write(head)
      child.stdin.write(data.subarray(0, 70_000))
      await expect.poll(() => stdout, { timeout: 5000 }).toContain('upload stalled')
      expect(readdirSync(dir)).not.toContain('stalled.bin')
    } finally {
      child.kill()
      await exited
    }
  })

  it('keeps a slow upload going as long as bytes keep arriving', async () => {
    const child = spawn('sh', ['-c', UPLOAD_COMMAND.join(' ')])
    const exited = new Promise((ok) => child.on('exit', ok))
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    try {
      child.stdin.on('error', () => undefined)
      const [head, data] = uploadInput(dir, 'slow.bin', Buffer.alloc(5000, 2), 1.5)
      child.stdin.write(head)
      for (let at = 0; at < data.length; at += 1000) {
        child.stdin.write(data.subarray(at, at + 1000))
        await new Promise((ok) => setTimeout(ok, 600))
      }
      child.stdin.end()
      await exited
      expect(parseUpload(stdout)).toEqual({ path: path.join(dir, 'slow.bin') })
      expect(readFileSync(path.join(dir, 'slow.bin'))).toEqual(data)
    } finally {
      child.kill()
    }
  })

  it('accepts ordinary file names and refuses paths and control characters', () => {
    for (const name of ['shot.png', 'my notes (final).md', '.env', 'résumé ✓.pdf']) expect(isUploadName(name)).toBe(true)
    for (const name of ['', '.', '..', 'a/b', '../x', 'a\nb', 'tab\there', 'x'.repeat(256), 'é'.repeat(128)]) expect(isUploadName(name)).toBe(false)
  })
})

describe('upload route', () => {
  let app: App
  let scratch: string
  const savedPath = process.env.PATH

  beforeAll(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'devbox-upload-route.'))
    mkdirSync(path.join(scratch, 'dist'))
    mkdirSync(path.join(scratch, 'probe'))
    process.env.PATH = `${path.join(stubsDir, 'ssh-bin')}:${savedPath}`
    process.env.SSH_STUB_UPLOAD = path.join(scratch, 'stdin')
    app = await createApp({ port: 0, bin: stubsDir, stateDir: path.join(scratch, 'state'), distRoot: path.join(scratch, 'dist'), version: '0' })
  })

  afterAll(async () => {
    await app.close()
    process.env.PATH = savedPath
    for (const key of ['SSH_STUB_UPLOAD', 'SSH_STUB_UPLOAD_REPLY', 'SSH_STUB_UPLOAD_EXIT']) delete process.env[key]
    rmSync(scratch, { recursive: true, force: true })
  })

  const post = async (session: string, name: string, body: Buffer) => {
    const res = await fetch(`${app.url.split('#')[0]}api/upload?${new URLSearchParams({ session, name }).toString()}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(body),
    }).catch(() => null)
    return res && { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  it('sends the bytes to the session folder over ssh and returns where they landed', async () => {
    const data = Buffer.from([1, 10, 2, 0, 3])
    expect(await post('cc-demo', 'shot.png', data)).toEqual({ status: 201, body: { path: '/home/me/work/demo/shot.png' } })
    const stdin = readFileSync(path.join(scratch, 'stdin'))
    const newline = stdin.indexOf(10)
    const script = JSON.parse(stdin.subarray(0, newline).toString()) as string
    expect(JSON.parse(JSON.parse(script.split('\n')[0].match(/loads\((.*)\)$/)![1]) as string)).toEqual({ dir: '/home/me/work/demo', name: 'shot.png', size: 5, stall: 60 })
    expect(stdin.subarray(newline + 1)).toEqual(data)
  })

  it('refuses bad names, unknown sessions and oversized files before touching the host', async () => {
    rmSync(path.join(scratch, 'stdin'), { force: true })
    expect((await post('cc-demo', '../x', Buffer.from('x')))?.status).toBe(400)
    expect((await post('nope', 'a.txt', Buffer.alloc(UPLOAD_MAX)))?.status).toBe(404)
    expect(existsSync(path.join(scratch, 'stdin'))).toBe(false)
    const declared = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const req = request(`${app.url.split('#')[0]}api/upload?session=cc-demo&name=big.bin`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${app.token}`, 'Content-Length': String(UPLOAD_MAX + 1) },
      })
      req.on('response', (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => (body += chunk.toString()))
        res.on('end', () => resolve({ status: res.statusCode, body }))
      })
      req.on('error', reject)
      req.flushHeaders()
    })
    expect(declared).toMatchObject({ status: 413, body: expect.stringContaining('larger than 50 MB') })
  })

  it('passes the host error back, and says when the host is unreachable', async () => {
    process.env.SSH_STUB_UPLOAD_REPLY = '{"error": "Permission denied"}'
    expect(await post('cc-demo', 'a.txt', Buffer.from('x'))).toMatchObject({ status: 409, body: { message: 'Permission denied' } })
    delete process.env.SSH_STUB_UPLOAD_REPLY
    process.env.SSH_STUB_UPLOAD_EXIT = '255'
    expect((await post('cc-demo', 'a.txt', Buffer.from('x')))?.status).toBe(502)
    delete process.env.SSH_STUB_UPLOAD_EXIT
  })
})

describe('reading an upload body', () => {
  it('gives up on a request the client abandons, even if it is read late', async () => {
    const outcomes: unknown[] = []
    let arrived = () => undefined as void
    const received = new Promise<void>((ok) => (arrived = ok))
    const server = createServer((req) => {
      arrived()
      setTimeout(() => {
        readBody(req, UPLOAD_MAX).then(
          () => outcomes.push('read'),
          (err: unknown) => outcomes.push(err instanceof BodyError ? err.message : err),
        )
      }, 100)
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    try {
      const { port } = server.address() as { port: number }
      const req = request({ port, host: '127.0.0.1', method: 'POST', headers: { 'Content-Length': '1000' } })
      req.on('error', () => undefined)
      req.write('partial')
      await received
      req.destroy()
      await expect.poll(() => outcomes, { timeout: 2000 }).toEqual(['request aborted'])
    } finally {
      server.closeAllConnections()
      await new Promise((ok) => server.close(ok))
    }
  })
})
