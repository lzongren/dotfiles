import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export async function listDays(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names
    .filter((n) => n.endsWith('.md') && DAY_RE.test(n.slice(0, -3)))
    .map((n) => n.slice(0, -3))
    .sort()
    .reverse()
}

export function readNote(dir: string, day: string): Promise<string> {
  return readFile(path.join(dir, `${day}.md`), 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return ''
    throw err
  })
}

export async function writeNote(dir: string, day: string, text: string): Promise<void> {
  const file = path.join(dir, `${day}.md`)
  if (text.trim() === '') {
    await rm(file, { force: true })
    return
  }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, text, { mode: 0o600 })
  await rename(tmp, file)
}
