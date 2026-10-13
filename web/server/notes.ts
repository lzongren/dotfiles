import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

const locks = new Map<string, Promise<unknown>>()

function locked<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(run, run)
  const settled = next.then(
    () => undefined,
    () => undefined,
  )
  locks.set(key, settled)
  void settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key)
  })
  return next
}

export function noteVersion(text: string): string {
  return text === '' ? '' : createHash('sha1').update(text).digest('hex').slice(0, 16)
}

export async function listDays(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names
    .filter((n) => n.endsWith('.md') && DAY_RE.test(n.slice(0, -3)))
    .map((n) => n.slice(0, -3))
    .sort()
    .reverse()
}

export async function readNote(dir: string, day: string): Promise<{ text: string; version: string }> {
  const text = await readFile(path.join(dir, `${day}.md`), 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return ''
    throw err
  })
  return { text, version: noteVersion(text) }
}

export function writeNote(
  dir: string,
  day: string,
  text: string,
  base: string,
): Promise<{ saved: true; version: string } | { saved: false; text: string; version: string }> {
  const file = path.join(dir, `${day}.md`)
  return locked(file, async () => {
    const current = await readNote(dir, day)
    if (current.version !== base) return { saved: false, ...current }
    if (text.trim() === '') {
      await rm(file, { force: true })
      return { saved: true, version: '' }
    }
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.${randomUUID()}.tmp`
    await writeFile(tmp, text, { mode: 0o600 })
    await rename(tmp, file)
    return { saved: true, version: noteVersion(text) }
  })
}
