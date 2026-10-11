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
import { statusRaw } from './exec.js'
import { createSessionSource, RemoteUnreachableError } from './sessions.js'
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
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`)
    if (url.pathname.startsWith('/api/')) {
      if (!tokenMatches(token, bearerToken(req.headers.authorization))) {
        return sendJson(res, 401, { error: 'unauthorized', message: 'missing or invalid token' })
      }
      if (url.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, version: opts.version, host: config.host })
      }
      if (url.pathname === '/api/sessions') {
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
    close() {
      removeState(opts.stateDir)
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
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
  const port = Number.parseInt(process.env.DEVBOX_WEB_PORT ?? '', 10) || 7733
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
