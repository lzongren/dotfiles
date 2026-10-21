import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DraftState, WorkState } from '../src/shared/types.js'

interface StoreFile {
  v: 1
  works: Record<string, WorkState>
}

export function emptyWork(key: string): WorkState {
  return { key, draft: null, draftVersion: '', repairs: [], inquiries: [], decisions: {}, separations: [] }
}

function draftVersion(draft: DraftState | null): string {
  return draft === null ? '' : createHash('sha1').update(draft.text.trim()).digest('hex').slice(0, 16)
}

export interface ReturnStore {
  read(key: string): Promise<WorkState>
  all(): Promise<Record<string, WorkState>>
  update(key: string, change: (work: WorkState) => WorkState): Promise<WorkState>
  saveDraft(
    key: string,
    draft: DraftState,
    base: string,
  ): Promise<{ saved: true; version: string } | { saved: false; draft: DraftState | null; version: string }>
}

export function createReturnStore(dir: string, host: string): ReturnStore {
  const file = path.join(dir, `${host.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  let queue: Promise<unknown> = Promise.resolve()

  async function load(): Promise<StoreFile> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, works: {} }
      throw err
    }
    try {
      const doc = JSON.parse(raw) as StoreFile
      if (doc && doc.v === 1 && typeof doc.works === 'object' && doc.works !== null) return doc
    } catch {
      raw = ''
    }
    await rename(file, `${file}.damaged-${Date.now()}`)
    return { v: 1, works: {} }
  }

  async function save(doc: StoreFile): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(doc), { mode: 0o600 })
    await rename(tmp, file)
  }

  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run)
    queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  const current = (doc: StoreFile, key: string) => ({ ...emptyWork(key), ...doc.works[key] })

  return {
    read: (key) => serial(async () => current(await load(), key)),
    all: () => serial(async () => (await load()).works),
    update: (key, change) =>
      serial(async () => {
        const doc = await load()
        const next = change(current(doc, key))
        doc.works[key] = next
        await save(doc)
        return next
      }),
    saveDraft: (key, draft, base) =>
      serial(async () => {
        const doc = await load()
        const work = current(doc, key)
        if (work.draftVersion !== base) return { saved: false as const, draft: work.draft, version: work.draftVersion }
        const stored = { ...draft, savedAt: Date.now() }
        const version = draftVersion(stored)
        doc.works[key] = { ...work, draft: stored, draftVersion: version }
        await save(doc)
        return { saved: true as const, version }
      }),
  }
}
