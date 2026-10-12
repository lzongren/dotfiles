import { createServer, type Server } from 'node:http'
import { connect as netConnect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { attachTerminalServer, type PtyLike, type TerminalDeps } from '../../server/terminal.js'
import type { SessionsResponse } from '../../src/shared/types.js'

class FakePty implements PtyLike {
  pid = 1
  writes: Array<string | Buffer> = []
  resizes: Array<[number, number]> = []
  killed: string[] = []
  pauseCount = 0
  resumeCount = 0
  private dataCb: ((data: string | Buffer) => void) | null = null
  private exitCb: ((event: { exitCode: number; signal?: number }) => void) | null = null

  write(data: string | Buffer): void {
    this.writes.push(data)
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }
  kill(signal?: string): void {
    this.killed.push(signal ?? 'SIGTERM')
    this.emitExit(0)
  }
  pause(): void {
    this.pauseCount += 1
  }
  resume(): void {
    this.resumeCount += 1
  }
  onData(listener: (data: string | Buffer) => void): void {
    this.dataCb = listener
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void {
    this.exitCb = listener
  }
  emitData(data: string | Buffer): void {
    this.dataCb?.(data)
  }
  emitExit(exitCode: number): void {
    const cb = this.exitCb
    this.exitCb = null
    cb?.({ exitCode })
  }
}

function session(name: string, attachable = true) {
  return { name, attached: false, clients: 0, activityEpoch: 0, bell: false, cmd: 'zsh', path: '/home/me', attachable }
}

const SNAPSHOT: SessionsResponse = {
  host: 'stub-host',
  fetchedAt: 0,
  sessions: [session('api'), session('api - ~/work/api', false)],
}

interface Harness {
  port: number
  server: Server
  terminals: ReturnType<typeof attachTerminalServer>
  ptys: FakePty[]
  close(): Promise<void>
}

const TOKEN = 'tok-terminal'
let harness: Harness | null = null

async function boot(overrides: Partial<TerminalDeps> = {}): Promise<Harness> {
  const server = createServer((_req, res) => res.end('x'))
  const ptys: FakePty[] = []
  const h = {} as Harness
  const terminals = attachTerminalServer(server, {
    token: TOKEN,
    port: () => h.port,
    sessions: async () => SNAPSHOT,
    ptyFactory: () => {
      const pty = new FakePty()
      ptys.push(pty)
      return pty
    },
    ...overrides,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  h.port = typeof addr === 'object' && addr ? addr.port : 0
  h.server = server
  h.terminals = terminals
  h.ptys = ptys
  h.close = () => {
    terminals.closeAll()
    return new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
  harness = h
  return h
}

afterEach(async () => {
  await harness?.close()
  harness = null
})

function wsUrl(h: Harness, params: Record<string, string>): string {
  const q = new URLSearchParams({ token: TOKEN, session: 'api', cols: '80', rows: '24', ...params })
  return `ws://127.0.0.1:${h.port}/ws/terminal?${q.toString()}`
}

function connect(h: Harness, params: Record<string, string> = {}, headers: Record<string, string> = {}): WebSocket {
  return new WebSocket(wsUrl(h, params), { headers })
}

function closedWith(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.on('close', (code) => resolve(code)))
}

function refusedWith(ws: WebSocket): Promise<number> {
  return new Promise((resolve) =>
    ws.on('unexpected-response', (req, res) => {
      req.destroy()
      resolve(res.statusCode ?? 0)
    }),
  )
}

function rawUpgrade(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(port, '127.0.0.1', () => {
      sock.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    let data = ''
    sock.on('data', (chunk: Buffer) => {
      data += chunk.toString()
    })
    sock.on('close', () => resolve(data))
    sock.on('error', reject)
  })
}

function nextMessage(ws: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve) =>
    ws.once('message', (data, isBinary) => resolve({ data: data as Buffer, isBinary })),
  )
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function ready(ws: WebSocket): Promise<void> {
  const msg = await nextMessage(ws)
  expect(JSON.parse(msg.data.toString())).toEqual({ t: 'ready' })
}

describe('terminal upgrade gate', () => {
  it('rejects a wrong token with 4401', async () => {
    const h = await boot()
    expect(await closedWith(connect(h, { token: 'wrong' }))).toBe(4401)
    expect(h.ptys).toHaveLength(0)
  })

  it('refuses a bad Host header before the handshake', async () => {
    const h = await boot()
    expect(await refusedWith(connect(h, {}, { Host: 'evil.example:1' }))).toBe(403)
  })

  it('refuses a bad Origin before the handshake', async () => {
    const h = await boot()
    expect(await refusedWith(connect(h, {}, { Origin: 'http://evil.example' }))).toBe(403)
  })

  it('answers a malformed upgrade target with 400 and keeps serving', async () => {
    const h = await boot()
    expect(await rawUpgrade(h.port, 'http://[')).toMatch(/^HTTP\/1\.1 400/)
    const ws = connect(h)
    await ready(ws)
    ws.close()
  })

  it('survives an invalid frame from a client without crashing', async () => {
    const h = await boot({
      sessions: () => new Promise((resolve) => setTimeout(() => resolve(SNAPSHOT), 100)),
    })
    const bad = connect(h)
    await new Promise<void>((resolve) => bad.on('open', () => resolve()))
    const socket = (bad as unknown as { _socket: { write(b: Buffer): void } })._socket
    socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]))
    await closedWith(bad)
    const ws = connect(h)
    await ready(ws)
    ws.close()
  })

  it('does not spawn a pty when the client leaves while the gate is still checking', async () => {
    const h = await boot({
      sessions: () => new Promise((resolve) => setTimeout(() => resolve(SNAPSHOT), 150)),
    })
    const ws = connect(h)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.close()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(h.ptys).toHaveLength(0)
    expect(h.terminals.count()).toBe(0)
  })

  it('asks the client to retry later when the session list is unavailable', async () => {
    const h = await boot({
      sessions: () => Promise.reject(new Error('remote down')),
    })
    expect(await closedWith(connect(h))).toBe(1013)
  })

  it('rejects invalid, unknown, and unattachable session names with 4404', async () => {
    const h = await boot()
    expect(await closedWith(connect(h, { session: 'a b' }))).toBe(4404)
    expect(await closedWith(connect(h, { session: 'ghost' }))).toBe(4404)
    expect(await closedWith(connect(h, { session: 'api - ~/work/api' }))).toBe(4404)
    expect(h.ptys).toHaveLength(0)
  })

  it('rejects connections over the pty budget with 1013', async () => {
    const h = await boot({ maxPtys: 1 })
    const first = connect(h)
    await ready(first)
    expect(await closedWith(connect(h))).toBe(1013)
    expect(h.ptys).toHaveLength(1)
    first.close()
  })

  it('reports a failed spawn and closes 1011', async () => {
    const h = await boot({
      ptyFactory: () => {
        throw new Error('boom')
      },
    })
    const ws = connect(h)
    const msg = await nextMessage(ws)
    expect(JSON.parse(msg.data.toString())).toMatchObject({ t: 'error', code: 'spawn_failed' })
    expect(await closedWith(ws)).toBe(1011)
  })
})

describe('terminal data plane', () => {
  it('bridges bytes both ways and applies clamped resizes', async () => {
    const h = await boot()
    const ws = connect(h)
    await ready(ws)
    const pty = h.ptys[0]

    const incoming = nextMessage(ws)
    pty.emitData('hello from tmux')
    const got = await incoming
    expect(got.isBinary).toBe(true)
    expect(got.data.toString()).toBe('hello from tmux')

    ws.send(Buffer.from('ls -la\r'), { binary: true })
    await waitFor(() => pty.writes.length === 1)
    expect(Buffer.from(pty.writes[0]).toString()).toBe('ls -la\r')

    ws.send('not a control message')
    ws.send(JSON.stringify({ t: 'resize', cols: 100, rows: 30 }))
    await waitFor(() => pty.resizes.length === 1)
    expect(pty.writes).toHaveLength(1)
    pty.resizes.length = 0

    ws.send(JSON.stringify({ t: 'resize', cols: 9999, rows: 0 }))
    await waitFor(() => pty.resizes.length === 1)
    expect(pty.resizes[0]).toEqual([500, 1])
    ws.send(JSON.stringify({ t: 'resize', cols: 120, rows: 'junk' }))
    await waitFor(() => pty.resizes.length === 2)
    expect(pty.resizes[1]).toEqual([120, 24])
    ws.close()
  })

  it('kills the pty with SIGHUP when the socket closes', async () => {
    const h = await boot()
    const ws = connect(h)
    await ready(ws)
    ws.close()
    await waitFor(() => h.ptys[0].killed.includes('SIGHUP'))
    expect(h.terminals.count()).toBe(0)
  })

  it('sends exit and closes 1000 when the pty ends', async () => {
    const h = await boot()
    const ws = connect(h)
    await ready(ws)
    const incoming = nextMessage(ws)
    h.ptys[0].emitExit(3)
    const msg = await incoming
    expect(JSON.parse(msg.data.toString())).toEqual({ t: 'exit', code: 3, signal: null })
    expect(await closedWith(ws)).toBe(1000)
  })

  it('closes 1009 on an oversized input frame', async () => {
    const h = await boot()
    const ws = connect(h)
    await ready(ws)
    ws.send(Buffer.alloc(64 * 1024 + 1), { binary: true })
    expect(await closedWith(ws)).toBe(1009)
    expect(h.ptys[0].writes).toHaveLength(0)
  })

  it('forwards raw non-UTF-8 output bytes unchanged', async () => {
    const h = await boot()
    const ws = connect(h)
    await ready(ws)
    const incoming = nextMessage(ws)
    h.ptys[0].emitData(Buffer.from([0xff, 0xfe, 0x41]))
    const got = await incoming
    expect([...got.data]).toEqual([0xff, 0xfe, 0x41])
    ws.close()
  })

  it('pauses the pty above the high-water mark and resumes after the client drains', async () => {
    const h = await boot({ highWater: 8 * 1024, lowWater: 1024 })
    const ws = connect(h)
    await ready(ws)
    const pty = h.ptys[0]
    const socket = (ws as unknown as { _socket: { pause(): void; resume(): void } })._socket
    socket.pause()
    try {
      const chunk = 'x'.repeat(64 * 1024)
      for (let i = 0; i < 512 && pty.pauseCount === 0; i += 1) {
        pty.emitData(chunk)
        if (i % 8 === 7) await new Promise((resolve) => setTimeout(resolve, 1))
      }
      expect(pty.pauseCount).toBeGreaterThan(0)
      expect(pty.resumeCount).toBe(0)
    } finally {
      socket.resume()
    }
    await waitFor(() => pty.resumeCount > 0, 10000)
    ws.close()
  })

  it('closeAll ends every client with 1001 and hangs up the ptys', async () => {
    const h = await boot()
    const ws = connect(h)
    await ready(ws)
    const closed = closedWith(ws)
    h.terminals.closeAll()
    expect(await closed).toBe(1001)
    expect(h.ptys[0].killed).toContain('SIGHUP')
    expect(h.terminals.count()).toBe(0)
  })
})
