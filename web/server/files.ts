import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { FileView } from '../src/shared/types.js'
import type { SyncEntry } from './config.js'

export const FILE_MAX = 1024 * 1024

const IMAGES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

export function allowed(target: string, cwd: string | undefined, touched: string[]): boolean {
  if (!target.startsWith('/') || target.includes('\0') || path.posix.normalize(target) !== target) return false
  if (touched.includes(target)) return true
  if (!cwd || !cwd.startsWith('/')) return false
  const root = path.posix.normalize(cwd).replace(/\/$/, '')
  return target.startsWith(`${root}/`)
}

export function localMirror(remote: string, home: string | undefined, syncs: SyncEntry[]): { file: string; root: string } | null {
  for (const sync of syncs) {
    const remoteRoot = sync.remotePath.startsWith('/') ? sync.remotePath : home ? path.posix.join(home, sync.remotePath) : null
    if (!remoteRoot || !remote.startsWith(`${remoteRoot.replace(/\/$/, '')}/`)) continue
    return { file: path.join(sync.localPath, remote.slice(remoteRoot.replace(/\/$/, '').length)), root: sync.localPath }
  }
  return null
}

export function describeFile(remote: string, bytes: Buffer, size: number, mtime: number, local?: string): FileView {
  const base = { path: remote, size, mtime, truncated: size > bytes.length, ...(local ? { local } : {}) }
  const mime = IMAGES[path.posix.extname(remote).toLowerCase()]
  if (mime && !base.truncated) return { ...base, kind: 'image', data: `data:${mime};base64,${bytes.toString('base64')}` }
  if (bytes.subarray(0, 8192).includes(0)) {
    return { ...base, kind: 'binary', ...(base.truncated ? {} : { data: `data:application/octet-stream;base64,${bytes.toString('base64')}` }) }
  }
  return { ...base, kind: 'text', text: bytes.toString('utf8') }
}

export async function readMirror(mirror: { file: string; root: string }, remote: string): Promise<FileView | null> {
  try {
    const [real, root] = await Promise.all([realpath(mirror.file), realpath(mirror.root)])
    if (!real.startsWith(`${root}${path.sep}`)) return null
    const info = await stat(real)
    if (!info.isFile()) return null
    const handle = await open(real, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(info.size, FILE_MAX))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return describeFile(remote, buffer.subarray(0, bytesRead), info.size, Math.floor(info.mtimeMs / 1000), real)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

export function remoteReadScript(file: string): string {
  return `ARGS = __import__("json").loads(${JSON.stringify(JSON.stringify({ path: file, limit: FILE_MAX }))})
import base64, json, os
try:
    info = os.stat(ARGS["path"])
    if not os.path.isfile(ARGS["path"]):
        raise IsADirectoryError(21, "not a regular file")
    with open(ARGS["path"], "rb") as fh:
        data = fh.read(ARGS["limit"])
    print(json.dumps({"size": info.st_size, "mtime": int(info.st_mtime), "b64": base64.b64encode(data).decode()}))
except OSError as err:
    print(json.dumps({"error": err.strerror or str(err)}))
`
}

export function parseRemoteRead(remote: string, stdout: string): FileView | { error: string } {
  const doc = JSON.parse(stdout) as { size?: unknown; mtime?: unknown; b64?: unknown; error?: unknown }
  if (typeof doc.error === 'string') return { error: doc.error }
  if (typeof doc.b64 !== 'string' || typeof doc.size !== 'number') throw new Error('unexpected reader output')
  return describeFile(remote, Buffer.from(doc.b64, 'base64'), doc.size, typeof doc.mtime === 'number' ? doc.mtime : 0)
}
