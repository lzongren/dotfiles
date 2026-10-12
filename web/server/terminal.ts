import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { hostAllowed, originAllowed, tokenMatches } from './auth.js'
import { clampInt, SESSION_NAME_RE } from '../src/shared/validate.js'
import type { SessionsResponse } from '../src/shared/types.js'

export interface PtyLike {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  pause(): void
  resume(): void
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void
}

export interface TerminalDeps {
  token: string
  port: () => number
  sessions: () => Promise<SessionsResponse>
  ptyFactory: (name: string, cols: number, rows: number) => PtyLike
  maxPtys?: number
  maxClients?: number
  highWater?: number
  lowWater?: number
}

interface Entry {
  pty: PtyLike
  ws: WebSocket
  exited: boolean
  wsClosedAt: number | null
}

const FRAME_MAX = 64 * 1024
const CONTROL_MAX = 4096

export function attachTerminalServer(server: HttpServer, deps: TerminalDeps) {
  const maxPtys = deps.maxPtys ?? 8
  const maxClients = deps.maxClients ?? 16
  const highWater = deps.highWater ?? 1024 * 1024
  const lowWater = deps.lowWater ?? 256 * 1024
  const registry = new Set<Entry>()
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${deps.port()}`)
    if (url.pathname !== '/ws/terminal') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void admit(ws, req, url)
    })
  })

  async function admit(ws: WebSocket, req: IncomingMessage, url: URL): Promise<void> {
    if (!hostAllowed(req.headers.host, deps.port())) return ws.close(4403, 'bad host')
    if (!originAllowed(req.headers.origin, deps.port())) return ws.close(4403, 'bad origin')
    if (!tokenMatches(deps.token, url.searchParams.get('token') ?? undefined)) {
      return ws.close(4401, 'bad token')
    }
    const name = url.searchParams.get('session') ?? ''
    if (!SESSION_NAME_RE.test(name)) return ws.close(4404, 'invalid session name')
    let snapshot: SessionsResponse
    try {
      snapshot = await deps.sessions()
    } catch {
      return ws.close(4404, 'session list unavailable')
    }
    const row = snapshot.sessions.find((s) => s.name === name)
    if (!row || !row.attachable) return ws.close(4404, 'unknown session')
    if (registry.size >= maxPtys) return ws.close(1013, 'terminal limit reached')
    if (wss.clients.size > maxClients) return ws.close(1013, 'client limit reached')

    const cols = clampInt(url.searchParams.get('cols'), 2, 500, 80)
    const rows = clampInt(url.searchParams.get('rows'), 1, 300, 24)
    let pty: PtyLike
    try {
      pty = deps.ptyFactory(name, cols, rows)
    } catch {
      ws.send(JSON.stringify({ t: 'error', code: 'spawn_failed', msg: 'could not start ssh' }))
      return ws.close(1011, 'spawn failed')
    }
    const entry: Entry = { pty, ws, exited: false, wsClosedAt: null }
    registry.add(entry)

    let paused = false
    let drain: ReturnType<typeof setInterval> | null = null
    pty.onData((data) => {
      if (ws.readyState !== ws.OPEN) return
      ws.send(Buffer.from(data, 'utf8'), { binary: true })
      if (!paused && ws.bufferedAmount > highWater) {
        paused = true
        pty.pause()
        drain = setInterval(() => {
          if (ws.bufferedAmount < lowWater || ws.readyState !== ws.OPEN) {
            if (drain) clearInterval(drain)
            drain = null
            paused = false
            pty.resume()
          }
        }, 50)
      }
    })
    pty.onExit(({ exitCode, signal }) => {
      entry.exited = true
      registry.delete(entry)
      if (drain) clearInterval(drain)
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ t: 'exit', code: exitCode, signal: signal ?? null }))
        ws.close(1000, 'session ended')
      }
    })

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
        if (buf.length > FRAME_MAX) return ws.close(1009, 'frame too large')
        pty.write(buf.toString('utf8'))
        return
      }
      const text = data.toString()
      if (text.length > CONTROL_MAX) return ws.close(1009, 'control frame too large')
      let msg: { t?: string; cols?: unknown; rows?: unknown }
      try {
        msg = JSON.parse(text) as typeof msg
      } catch {
        return
      }
      if (msg.t === 'resize') {
        const c = clampInt(String(msg.cols), 2, 500, cols)
        const r = clampInt(String(msg.rows), 1, 300, rows)
        pty.resize(c, r)
      }
    })

    let alive = true
    ws.on('pong', () => {
      alive = true
    })
    const ping = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return
      if (!alive) {
        ws.terminate()
        return
      }
      alive = false
      ws.ping()
    }, 30000)

    ws.on('close', () => {
      clearInterval(ping)
      if (drain) clearInterval(drain)
      entry.wsClosedAt = Date.now()
      if (!entry.exited) pty.kill('SIGHUP')
    })

    ws.send(JSON.stringify({ t: 'ready' }))
  }

  const sweep = setInterval(() => {
    for (const entry of registry) {
      if (entry.exited) {
        registry.delete(entry)
        continue
      }
      if (entry.wsClosedAt !== null && Date.now() - entry.wsClosedAt > 5000) {
        entry.pty.kill('SIGKILL')
        registry.delete(entry)
      }
    }
  }, 10000)

  return {
    count(): number {
      return registry.size
    },
    closeAll(): void {
      clearInterval(sweep)
      for (const client of wss.clients) client.close(1001, 'server shutting down')
      for (const entry of registry) {
        if (!entry.exited) entry.pty.kill('SIGHUP')
      }
      registry.clear()
    },
  }
}
