import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { FileView } from '../src/shared/types.js'
import type { SyncEntry } from './config.js'
import { probeScript } from './insights.js'

export const FILE_MAX = 1024 * 1024

const IMAGES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

const OPENABLE = new Set(['.md', '.markdown', '.txt', '.log', '.csv', '.tsv', '.json', '.yaml', '.yml', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp'])

export function allowed(target: string, touched: string[]): boolean {
  return target.startsWith('/') && !target.includes('\0') && path.posix.normalize(target) === target && touched.includes(target)
}

export function openable(file: string): boolean {
  return OPENABLE.has(path.extname(file).toLowerCase())
}

export function localMirror(remote: string, home: string | undefined, syncs: SyncEntry[]): { file: string; root: string } | null {
  const roots = syncs
    .map((sync) => ({ sync, root: (sync.remotePath.startsWith('/') ? sync.remotePath : home ? path.posix.join(home, sync.remotePath) : '').replace(/\/$/, '') }))
    .filter(({ root }) => root !== '' && remote.startsWith(`${root}/`))
    .sort((a, b) => b.root.length - a.root.length)
  const best = roots[0]
  return best ? { file: path.join(best.sync.localPath, remote.slice(best.root.length)), root: best.sync.localPath } : null
}

export function describeFile(remote: string, bytes: Buffer, size: number, mtime: number, local?: string): FileView {
  const truncated = size > bytes.length
  const mime = IMAGES[path.posix.extname(remote).toLowerCase()]
  const data = (type: string) => (truncated ? {} : { data: `data:${type};base64,${bytes.toString('base64')}` })
  const base = { path: remote, size, mtime, truncated, ...(local ? { local } : {}) }
  if (mime && !truncated) return { ...base, kind: 'image', ...data(mime) }
  if (bytes.subarray(0, 8192).includes(0)) return { ...base, kind: 'binary', ...data('application/octet-stream') }
  return { ...base, kind: 'text', text: bytes.toString('utf8'), ...data('application/octet-stream') }
}

export async function resolveMirror(mirror: { file: string; root: string }): Promise<string | null> {
  try {
    const [real, root] = await Promise.all([realpath(mirror.file), realpath(mirror.root)])
    return real.startsWith(`${root}${path.sep}`) && (await stat(real)).isFile() ? real : null
  } catch {
    return null
  }
}

export async function readMirror(mirror: { file: string; root: string }, remote: string): Promise<FileView | null> {
  const real = await resolveMirror(mirror)
  if (!real) return null
  try {
    const info = await stat(real)
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

const READER = `import base64, json, os
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

export function remoteReadScript(file: string): string {
  return probeScript(READER, { path: file, limit: FILE_MAX })
}

export function parseRemoteRead(remote: string, stdout: string): FileView | { error: string } {
  const doc = JSON.parse(stdout) as { size?: unknown; mtime?: unknown; b64?: unknown; error?: unknown }
  if (typeof doc.error === 'string') return { error: doc.error }
  if (typeof doc.b64 !== 'string' || typeof doc.size !== 'number') throw new Error('unexpected reader output')
  return describeFile(remote, Buffer.from(doc.b64, 'base64'), doc.size, typeof doc.mtime === 'number' ? doc.mtime : 0)
}
