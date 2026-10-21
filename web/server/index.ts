import { createServer, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
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
import { BodyError, readBody, readJson } from './body.js'
import { detach, openLocal, runAgentProbe, runUpload, spawnAttachPty, statusRaw } from './exec.js'
import { allowed, localMirror, mirrorFolder, openable, parseRemoteRead, readMirror, readOutputMax, readTimeout, remoteReadScript, resolveMirror } from './files.js'
import { readGhostty } from './ghostty.js'
import type { InsightsResponse } from '../src/shared/types.js'
import { DAY_RE, listDays, readNote, writeNote } from './notes.js'
import { createInsightsSource, probeScript } from './insights.js'
import { isAgentChoice, isUploadName, SESSION_NAME_RE, UPLOAD_MAX, UPLOAD_TOO_LARGE } from '../src/shared/validate.js'
import { parseUpload, uploadInput } from './upload.js'
import { listWorkspaces } from './workspaces.js'
import { createSessionSource, RemoteUnreachableError } from './sessions.js'
import { attachTerminalServer } from './terminal.js'
import { serveStatic } from './static.js'
import { removeState, writeState } from './state.js'
import { createReturnService, parseDraft, type Reply } from './return.js'
import { createReturnStore } from './return-store.js'

export interface AppOptions {
  port: number
  bin: string
  stateDir: string
  distRoot: string
  version: string
  notesDir?: string
  returnDir?: string
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
  const probePath = path.resolve(opts.distRoot, '../probe/agent-probe.py')
  const getInsights = createInsightsSource(async () =>
    runAgentProbe(config.host, probeScript(await readFile(probePath, 'utf8'), { artifacts: config.artifacts })),
  )
  const distRoot = path.resolve(opts.distRoot)
  let lastInsights: InsightsResponse | null = null
  const fetchInsights = () => getInsights().then((body) => (lastInsights = body))
  const fileAccess = async (sessionName: string, target: string) => {
    const insights = lastInsights ?? (await fetchInsights())
    const touched = insights.agents.find((a) => a.session === sessionName)?.files?.map((f) => f.path) ?? []
    return allowed(target, touched) ? { mirror: localMirror(target, insights.home, config.syncs) } : null
  }
  const notesDir =
    opts.notesDir ??
    process.env.DEVBOX_NOTES_DIR ??
    path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'devbox', 'notes')

  const returnDir =
    opts.returnDir ??
    process.env.DEVBOX_RETURN_DIR ??
    path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'devbox', 'return')
  const returns = createReturnService({
    host: config.host,
    store: createReturnStore(returnDir, config.host),
    now: () => Math.floor(Date.now() / 1000),
    probe: async (args) => {
      const ret = args.mode === 'return'
      return runAgentProbe(config.host, probeScript(await readFile(probePath, 'utf8'), args), ret ? 30000 : 20000, ret ? 16 * 1024 * 1024 : undefined)
    },
    prs: async () => {
      const insights = lastInsights ?? (await fetchInsights())
      return Object.fromEntries(insights.agents.map((a) => [a.session, a.artifacts.filter((x) => /\/pull\/\d+/.test(x.url)).map((x) => x.url)]))
    },
  })
  const returnBody = (req: Parameters<typeof readJson>[0], res: ServerResponse, handle: (body: Record<string, unknown>, session: string) => Promise<Reply | null> | Reply | null, limit = 128 * 1024) => {
    readJson(req, limit)
      .then(async (raw) => {
        const body = (raw ?? {}) as Record<string, unknown>
        const session = typeof body.session === 'string' && SESSION_NAME_RE.test(body.session) ? body.session : ''
        const reply = session ? await handle(body, session) : null
        if (!reply) return sendJson(res, 400, { error: 'bad_request', message: 'invalid request body' })
        return sendJson(res, reply.status, reply.body)
      })
      .catch((err: unknown) => {
        if (err instanceof BodyError) sendJson(res, err.status, { error: 'bad_request', message: err.message })
        else if (err instanceof RemoteUnreachableError) sendJson(res, 502, { error: 'remote_unreachable', message: err.message })
        else sendJson(res, 500, { error: 'internal', message: 'the request failed' })
      })
  }
  const ok = (body: Record<string, unknown> = { ok: true }): Reply => ({ status: 200, body })

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
        listWorkspaces(config.syncs, config.ignores)
          .then((body) => sendJson(res, 200, body))
          .catch(() => sendJson(res, 500, { error: 'internal', message: 'could not list workspaces' }))
        return
      }
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        readJson(req)
          .then(async (raw) => {
            const body = (raw ?? {}) as { name?: unknown; root?: unknown; agent?: unknown; beside?: unknown; goal?: unknown }
            const name = typeof body.name === 'string' ? body.name : ''
            const agent = body.agent ?? 'cc'
            if (!SESSION_NAME_RE.test(name)) {
              return sendJson(res, 400, { error: 'bad_name', message: 'invalid session name' })
            }
            if (!isAgentChoice(agent)) {
              return sendJson(res, 400, { error: 'bad_agent', message: 'agent must be cc, codex, or shell' })
            }
            if (body.goal !== undefined && (typeof body.goal !== 'string' || body.goal.length > 2000)) {
              return sendJson(res, 400, { error: 'bad_goal', message: 'goal must be text' })
            }
            const goal = typeof body.goal === 'string' ? body.goal.trim() : ''
            let cwd = config.syncs.find((s) => s.name === body.root)?.localPath
            if (body.beside !== undefined) {
              const beside = (await getSessions()).sessions.find((s) => s.name === body.beside)
              if (!beside) return sendJson(res, 400, { error: 'bad_beside', message: 'no such session' })
              const home = config.syncs.every((s) => s.remotePath.startsWith('/')) ? undefined : (lastInsights ?? (await fetchInsights().catch(() => null)))?.home
              const mirror = localMirror(beside.path, home, config.syncs)
              const folder = mirror ? await mirrorFolder(mirror) : null
              if (!folder) return sendJson(res, 400, { error: 'no_folder', message: `${beside.name} doesn't run in a folder under a synced root` })
              cwd = folder
            }
            if (!cwd) return sendJson(res, 400, { error: 'bad_root', message: 'unknown sync root' })
            const result = await detach(opts.bin, agent, name, cwd, body.beside !== undefined)
            const verdict = result.stdout.trim().split('\n').pop() ?? ''
            if (result.exitCode !== 0 || !/^(created|exists) /.test(verdict)) {
              return sendJson(res, 502, {
                error: 'remote_unreachable',
                message: result.stderr.trim() || 'could not start the session',
              })
            }
            getSessions.invalidate()
            const created = verdict.startsWith('created ')
            if (created) await returns.started(name, goal)
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
      if (url.pathname === '/api/file' && req.method === 'GET') {
        const sessionName = url.searchParams.get('session') ?? ''
        const target = url.searchParams.get('path') ?? ''
        fileAccess(sessionName, target)
          .then(async (access) => {
            if (!access) return sendJson(res, 403, { error: 'forbidden', message: 'not a file this session wrote' })
            const local = access.mirror ? await readMirror(access.mirror, target) : null
            if (local) return sendJson(res, 200, local)
            const result = await runAgentProbe(config.host, remoteReadScript(target), readTimeout(target), readOutputMax(target))
            if (result.exitCode === 255) return sendJson(res, 502, { error: 'remote_unreachable', message: 'host unreachable' })
            if (result.exitCode !== 0) return sendJson(res, 500, { error: 'read_failed', message: 'could not read the file' })
            const view = parseRemoteRead(target, result.stdout)
            if ('error' in view) return sendJson(res, 404, { error: 'not_found', message: view.error })
            return sendJson(res, 200, view)
          })
          .catch((err: unknown) => {
            if (err instanceof RemoteUnreachableError) sendJson(res, 502, { error: 'remote_unreachable', message: err.message })
            else sendJson(res, 500, { error: 'read_failed', message: 'could not read the file' })
          })
        return
      }
      if (url.pathname === '/api/file/open' && req.method === 'POST') {
        readJson(req)
          .then(async (raw) => {
            const { session, path: target } = (raw ?? {}) as { session?: unknown; path?: unknown }
            if (typeof session !== 'string' || typeof target !== 'string') {
              return sendJson(res, 400, { error: 'bad_request', message: 'session and path must be strings' })
            }
            const access = await fileAccess(session, target)
            if (!access) return sendJson(res, 403, { error: 'forbidden', message: 'not a file this session wrote' })
            const local = access.mirror ? await resolveMirror(access.mirror) : null
            if (!local) return sendJson(res, 404, { error: 'not_synced', message: 'no synced copy on this laptop' })
            const revealed = !openable(local)
            openLocal(local, revealed)
            return sendJson(res, 200, { opened: local, revealed })
          })
          .catch((err: unknown) => {
            if (err instanceof BodyError) sendJson(res, err.status, { error: 'bad_request', message: err.message })
            else if (err instanceof RemoteUnreachableError) sendJson(res, 502, { error: 'remote_unreachable', message: err.message })
            else sendJson(res, 500, { error: 'internal', message: 'could not open the file' })
          })
        return
      }
      if (url.pathname === '/api/upload' && req.method === 'POST') {
        const sessionName = url.searchParams.get('session') ?? ''
        const name = url.searchParams.get('name') ?? ''
        const refuse = (status: number, error: string, message: string) => {
          if (status === 413) res.setHeader('Connection', 'close')
          sendJson(res, status, { error, message })
        }
        if (!isUploadName(name)) return refuse(400, 'bad_name', 'not a usable file name')
        if (Number(req.headers['content-length']) > UPLOAD_MAX) return refuse(413, 'bad_request', UPLOAD_TOO_LARGE)
        getSessions()
          .then(async (snapshot) => {
            const row = snapshot.sessions.find((s) => s.name === sessionName && s.attachable)
            if (!row) return refuse(404, 'unknown_session', 'no such session')
            if (!row.path.startsWith('/')) return refuse(409, 'no_folder', 'the session has no folder yet')
            const data = await readBody(req, UPLOAD_MAX)
            const result = await runUpload(config.host, uploadInput(row.path, name, data), 120000 + data.length / 50)
            if (result.exitCode === 255) return sendJson(res, 502, { error: 'remote_unreachable', message: 'host unreachable' })
            if (result.exitCode === 124 && result.stderr === 'upload timed out') return sendJson(res, 504, { error: 'timeout', message: 'the upload timed out' })
            if (result.exitCode === 127) return sendJson(res, 500, { error: 'write_failed', message: 'python3 is not installed on the host' })
            if (result.exitCode !== 0) return sendJson(res, 500, { error: 'write_failed', message: 'could not write the file' })
            const placed = parseUpload(result.stdout)
            if ('error' in placed) return sendJson(res, 409, { error: 'write_failed', message: placed.error })
            return sendJson(res, 201, placed)
          })
          .catch((err: unknown) => {
            if (err instanceof BodyError) refuse(err.status, 'bad_request', err.status === 413 ? UPLOAD_TOO_LARGE : err.message)
            else if (err instanceof RemoteUnreachableError) sendJson(res, 502, { error: 'remote_unreachable', message: err.message })
            else sendJson(res, 500, { error: 'write_failed', message: 'could not write the file' })
          })
        return
      }
      if (url.pathname === '/api/notes' && req.method === 'GET') {
        listDays(notesDir)
          .then((days) => sendJson(res, 200, { days }))
          .catch(() => sendJson(res, 500, { error: 'internal', message: 'could not list notes' }))
        return
      }
      const noteDay = /^\/api\/notes\/([^/]+)$/.exec(url.pathname)?.[1]
      if (noteDay !== undefined) {
        if (!DAY_RE.test(noteDay)) return sendJson(res, 400, { error: 'bad_day', message: 'day must be YYYY-MM-DD' })
        if (req.method === 'GET') {
          readNote(notesDir, noteDay)
            .then((note) => sendJson(res, 200, { day: noteDay, ...note }))
            .catch(() => sendJson(res, 500, { error: 'internal', message: 'could not read the note' }))
          return
        }
        if (req.method === 'PUT') {
          readJson(req, 256 * 1024)
            .then(async (raw) => {
              const { text, base } = (raw ?? {}) as { text?: unknown; base?: unknown }
              if (typeof text !== 'string' || typeof base !== 'string') {
                return sendJson(res, 400, { error: 'bad_request', message: 'text and base must be strings' })
              }
              const result = await writeNote(notesDir, noteDay, text, base)
              if (!result.saved) {
                return sendJson(res, 409, { error: 'conflict', message: 'the note changed elsewhere', text: result.text, version: result.version })
              }
              return sendJson(res, 200, { day: noteDay, version: result.version })
            })
            .catch((err: unknown) => {
              if (err instanceof BodyError) {
                if (err.status === 413) res.setHeader('Connection', 'close')
                sendJson(res, err.status, { error: 'bad_request', message: err.message })
              } else {
                sendJson(res, 500, { error: 'internal', message: 'could not save the note' })
              }
            })
          return
        }
      }
      if (url.pathname === '/api/return/summary' && req.method === 'GET') {
        returns
          .summaries()
          .then((body) => sendJson(res, 200, { sessions: body }))
          .catch(() => sendJson(res, 500, { error: 'internal', message: 'could not read Return state' }))
        return
      }
      if (url.pathname === '/api/return/brief' && req.method === 'GET') {
        const session = url.searchParams.get('session') ?? ''
        const left = url.searchParams.get('left')
        if (!SESSION_NAME_RE.test(session) || (left !== null && !/^\d{1,12}$/.test(left))) return sendJson(res, 400, { error: 'bad_request', message: 'session is required' })
        returns
          .brief(session, left === null ? undefined : Number(left))
          .then((reply) => sendJson(res, reply.status, reply.body))
          .catch((err: unknown) => {
            if (err instanceof RemoteUnreachableError) sendJson(res, 502, { error: 'remote_unreachable', message: err.message })
            else sendJson(res, 500, { error: 'return_failed', message: err instanceof Error ? err.message : 'could not read the work' })
          })
        return
      }
      if (url.pathname === '/api/return' && req.method === 'GET') {
        const session = url.searchParams.get('session') ?? ''
        if (!SESSION_NAME_RE.test(session)) return sendJson(res, 400, { error: 'bad_request', message: 'session is required' })
        returns
          .load(session)
          .then((body) => ('error' in body ? sendJson(res, 404, body) : sendJson(res, 200, body)))
          .catch((err: unknown) => {
            if (err instanceof RemoteUnreachableError) sendJson(res, 502, { error: 'remote_unreachable', message: err.message })
            else sendJson(res, 500, { error: 'return_failed', message: err instanceof Error ? err.message : 'could not load the work' })
          })
        return
      }
      if (url.pathname === '/api/return/draft' && req.method === 'PUT') {
        return returnBody(req, res, async (body, session) => {
          const draft = parseDraft(body.draft)
          if (!draft || typeof body.base !== 'string') return null
          const saved = await returns.saveDraft(session, draft, body.base)
          return saved.saved ? ok({ version: saved.version }) : { status: 409, body: { error: 'conflict', draft: saved.draft, version: saved.version } }
        }, 1024 * 1024)
      }
      if (url.pathname === '/api/return/repair' && req.method === 'POST') {
        return returnBody(req, res, (body, session) => (typeof body.requestId === 'string' ? returns.repair(session, body.requestId, { preview: body.preview, version: body.version }) : null))
      }
      if (url.pathname === '/api/return/accept' && req.method === 'POST') {
        return returnBody(req, res, (body, session) => (typeof body.requestId === 'string' ? returns.accept(session, body.requestId) : null))
      }
      if (url.pathname === '/api/return/ask' && req.method === 'POST') {
        return returnBody(req, res, (body, session) =>
          typeof body.inquiryId === 'string' && typeof body.question === 'string' ? returns.ask(session, body.inquiryId, body.question) : null,
        )
      }
      if (url.pathname === '/api/return/seen' && req.method === 'POST') {
        return returnBody(req, res, async (_body, session) => ok({ seenAt: (await returns.seen(session)).seenAt }))
      }
      if (url.pathname === '/api/return/decide' && req.method === 'POST') {
        return returnBody(req, res, async (body, session) => {
          if (typeof body.key !== 'string' || (body.limitId !== null && typeof body.limitId !== 'string')) return null
          return ok({ decisions: (await returns.decide(session, body.key, body.limitId as string | null)).decisions })
        })
      }
      if (url.pathname === '/api/return/separate' && req.method === 'POST') {
        return returnBody(req, res, async (body, session) => {
          if (typeof body.work !== 'string' || typeof body.member !== 'string' || typeof body.undo !== 'boolean') return null
          await returns.separate(session, body.work, body.member, body.undo)
          return ok()
        })
      }
      if (url.pathname === '/api/theme' && req.method === 'GET') {
        readGhostty()
          .then((ghostty) => sendJson(res, 200, { ghostty }))
          .catch(() => sendJson(res, 200, { ghostty: null }))
        return
      }
      if (url.pathname === '/api/insights' && req.method === 'GET') {
        fetchInsights()
          .then((body) => sendJson(res, 200, body))
          .catch((err: unknown) => {
            if (err instanceof RemoteUnreachableError) {
              sendJson(res, 502, { error: 'remote_unreachable', message: err.message })
            } else {
              sendJson(res, 500, { error: 'insights_failed', message: err instanceof Error ? err.message : 'agent probe failed' })
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
