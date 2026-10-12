import { createServer, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applySecurityHeaders,
  bearerToken,
  hostAllowed,
  mintToken,
  originAllowed,
  tokenMatches,
} from './auth.js'
import { loadConfig } from './config.js'
import { BodyError, readJson } from './body.js'
import { detach, spawnAttachPty, statusRaw, type Agent } from './exec.js'
import { SESSION_NAME_RE } from '../src/shared/validate.js'
import { listWorkspaces } from './workspaces.js'
import { createSessionSource, RemoteUnreachableError } from './sessions.js'
import { attachTerminalServer } from './terminal.js'
import { serveStatic } from './static.js'
import { removeState, writeState } from './state.js'

export interface AppOptions {
  port: number
  bin: string
  stateDir: string
  distRoot: string
  version: string
}

export interface App {
  port: number
  token: string
  url: string
  close(): Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

export async function createApp(opts: AppOptions): Promise<App> {
  const config = await loadConfig(opts.bin)
  const token = mintToken()
  const getSessions = createSessionSource(config.host, () => statusRaw(opts.bin))
  const distRoot = path.resolve(opts.distRoot)

  let boundPort = opts.port
  const server = createServer((req, res) => {
    applySecurityHeaders(res)
    if (!hostAllowed(req.headers.host, boundPort)) {
      return sendJson(res, 403, { error: 'bad_host', message: 'unexpected Host header' })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req.headers.origin, boundPort)) {
      return sendJson(res, 403, { error: 'bad_origin', message: 'unexpected Origin header' })
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`)
    } catch {
      return sendJson(res, 400, { error: 'bad_request', message: 'malformed request target' })
    }
    if (url.pathname.startsWith('/api/')) {
      if (!tokenMatches(token, bearerToken(req.headers.authorization))) {
        return sendJson(res, 401, { error: 'unauthorized', message: 'missing or invalid token' })
      }
      if (url.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, version: opts.version, host: config.host })
      }
      if (url.pathname === '/api/workspaces' && req.method === 'GET') {
        return sendJson(res, 200, listWorkspaces(config.syncs))
      }
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        readJson(req)
          .then(async (raw) => {
            const body = (raw ?? {}) as { name?: unknown; root?: unknown; agent?: unknown }
            const name = typeof body.name === 'string' ? body.name : ''
            const agent = body.agent ?? 'cc'
            if (!SESSION_NAME_RE.test(name)) {
              return sendJson(res, 400, { error: 'bad_name', message: 'invalid session name' })
            }
            if (agent !== 'cc' && agent !== 'codex' && agent !== 'shell') {
              return sendJson(res, 400, { error: 'bad_agent', message: 'agent must be cc, codex, or shell' })
            }
            const root = config.syncs.find((s) => s.name === body.root)
            if (!root) return sendJson(res, 400, { error: 'bad_root', message: 'unknown sync root' })
            const result = await detach(opts.bin, agent as Agent, name, root.localPath)
            const verdict = result.stdout.trim().split('\n').pop() ?? ''
            if (result.exitCode !== 0 || !/^(created|exists) /.test(verdict)) {
              return sendJson(res, 502, {
                error: 'remote_unreachable',
                message: result.stderr.trim() || 'could not start the session',
              })
            }
            getSessions.invalidate()
            const created = verdict.startsWith('created ')
            return sendJson(res, created ? 201 : 200, { name, created })
          })
          .catch((err: unknown) => {
            if (err instanceof BodyError) {
              if (err.status === 413) res.setHeader('Connection', 'close')
              sendJson(res, err.status, { error: 'bad_request', message: err.message })
            } else {
              sendJson(res, 500, { error: 'internal', message: 'could not start the session' })
            }
          })
        return
      }
      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        getSessions()
          .then((body) => sendJson(res, 200, body))
          .catch((err: unknown) => {
            if (err instanceof RemoteUnreachableError) {
              sendJson(res, 502, { error: 'remote_unreachable', message: err.message })
            } else {
              sendJson(res, 500, { error: 'internal', message: 'session probe failed' })
            }
          })
        return
      }
      return sendJson(res, 404, { error: 'not_found', message: 'no such endpoint' })
    }
    serveStatic(distRoot, url.pathname, res)
  })

  const terminals = attachTerminalServer(server, {
    token,
    port: () => boundPort,
    sessions: getSessions,
    ptyFactory: (name, cols, rows) => spawnAttachPty(config.host, name, cols, rows),
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (addr && typeof addr === 'object') boundPort = addr.port
  writeState(opts.stateDir, { pid: process.pid, port: boundPort, token, version: opts.version })

  return {
    port: boundPort,
    token,
    url: `http://127.0.0.1:${boundPort}/#t=${token}`,
    async close() {
      removeState(opts.stateDir, process.pid)
      await terminals.closeAll()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const bin = process.env.DEVBOX_BIN
  const stateDir = process.env.DEVBOX_WEB_STATE
  if (!bin || !stateDir) {
    console.error('devbox-web: DEVBOX_BIN and DEVBOX_WEB_STATE are required')
    process.exit(1)
  }
  const rawPort = process.env.DEVBOX_WEB_PORT
  let port = 7733
  if (rawPort !== undefined && rawPort !== '') {
    const parsed = Number(rawPort)
    if (!/^[0-9]+$/.test(rawPort) || parsed < 1 || parsed > 65535) {
      console.error(`devbox-web: invalid DEVBOX_WEB_PORT: ${rawPort}`)
      process.exit(1)
    }
    port = parsed
  }
  const here = path.dirname(fileURLToPath(import.meta.url))
  let version = '0.0.0'
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(here, '../../package.json'), 'utf8')) as { version?: string }
    version = pkg.version ?? '0.0.0'
  } catch {
    version = '0.0.0'
  }
  createApp({ port, bin, stateDir, distRoot: path.resolve(here, '../../dist'), version })
    .then((app) => {
      console.log(`devbox-web listening on 127.0.0.1:${app.port}`)
      const shutdown = () => {
        void app.close().then(() => process.exit(0))
      }
      process.on('SIGTERM', shutdown)
      process.on('SIGINT', shutdown)
    })
    .catch((err: unknown) => {
      console.error(`devbox-web: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })
}
