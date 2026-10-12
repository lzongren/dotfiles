import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn as ptySpawn } from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { attachTerminalServer, type PtyLike } from '../../server/terminal.js'
import type { SessionsResponse } from '../../src/shared/types.js'

const stub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../stubs/fake-remote.sh')

const SNAPSHOT: SessionsResponse = {
  host: 'stub-host',
  fetchedAt: 0,
  sessions: [
    { name: 'api', attached: false, clients: 0, activityEpoch: 0, bell: false, cmd: 'zsh', path: '/home/me', attachable: true },
  ],
}

const TOKEN = 'tok-real-pty'

interface Harness {
  port: number
  server: Server
  pids: number[]
  close(): Promise<void>
}

let harness: Harness | null = null

async function boot(): Promise<Harness> {
  const server = createServer((_req, res) => res.end('x'))
  const pids: number[] = []
  const h = {} as Harness
  const terminals = attachTerminalServer(server, {
    token: TOKEN,
    port: () => h.port,
    sessions: async () => SNAPSHOT,
    ptyFactory: (_name, cols, rows): PtyLike => {
      const pty = ptySpawn('/bin/bash', [stub], { name: 'xterm-256color', cols, rows })
      pids.push(pty.pid)
      return pty
    },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  h.port = typeof addr === 'object' && addr ? addr.port : 0
  h.server = server
  h.pids = pids
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

function connect(h: Harness, cols = 80, rows = 24): WebSocket {
  return new WebSocket(
    `ws://127.0.0.1:${h.port}/ws/terminal?token=${TOKEN}&session=api&cols=${cols}&rows=${rows}`,
  )
}

function collector(ws: WebSocket) {
  let text = ''
  const controls: Array<Record<string, unknown>> = []
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      text += (data as Buffer).toString()
    } else {
      controls.push(JSON.parse((data as Buffer).toString()) as Record<string, unknown>)
    }
  })
  return {
    output: () => text,
    controls,
  }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('real pty bridge', () => {
  it('echoes bytes through a real pty and resizes the pty window', async () => {
    const h = await boot()
    const ws = connect(h)
    const seen = collector(ws)
    await waitFor(() => seen.controls.some((c) => c.t === 'ready'))
    await waitFor(() => seen.output().includes('READY'))

    ws.send(Buffer.from('hello\r'), { binary: true })
    await waitFor(() => seen.output().includes('echo:hello'))

    ws.send(JSON.stringify({ t: 'resize', cols: 123, rows: 41 }))
    ws.send(Buffer.from('size\r'), { binary: true })
    await waitFor(() => seen.output().includes('SIZE 41 123'))

    const exited = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
    ws.send(Buffer.from('exit\r'), { binary: true })
    await waitFor(() => seen.controls.some((c) => c.t === 'exit' && c.code === 3))
    expect(await exited).toBe(1000)
  })

  it('survives a burst larger than the flow-control window without losing bytes', async () => {
    const h = await boot()
    const ws = connect(h)
    const seen = collector(ws)
    await waitFor(() => seen.output().includes('READY'))
    ws.send(Buffer.from('burst\r'), { binary: true })
    await waitFor(() => seen.output().includes('BURST_DONE'), 15000)
    const xs = seen.output().match(/x/g)?.length ?? 0
    expect(xs).toBeGreaterThanOrEqual(2 * 1024 * 1024)
    ws.close()
  })

  it('reaps the child process when the socket goes away', async () => {
    const h = await boot()
    const ws = connect(h)
    const seen = collector(ws)
    await waitFor(() => seen.output().includes('READY'))
    const pid = h.pids[0]
    expect(alive(pid)).toBe(true)
    ws.close()
    await waitFor(() => !alive(pid))
  })
})
