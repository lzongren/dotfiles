import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ServerResponse } from 'node:http'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.json': 'application/json',
  '.txt': 'text/plain',
}

export function serveStatic(root: string, urlPath: string, res: ServerResponse): void {
  const absRoot = path.resolve(root)
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const resolved = path.resolve(absRoot, rel)
  const inside = resolved === absRoot || resolved.startsWith(absRoot + path.sep)
  if (!inside || !existsSync(resolved) || !statSync(resolved).isFile()) {
    res.statusCode = 404
    res.setHeader('Content-Type', 'text/plain')
    res.end('not found')
    return
  }
  const ext = path.extname(resolved)
  res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream')
  if (ext === '.html') res.setHeader('Cache-Control', 'no-store')
  createReadStream(resolved).pipe(res)
}
