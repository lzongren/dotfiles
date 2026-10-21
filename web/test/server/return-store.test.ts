import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createReturnStore, emptyWork } from '../../server/return-store.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'return-store-'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const draft = (text: string) => ({ text, basis: null, corrections: [], earlier: [], target: null })

describe('return store', () => {
  it('starts every work empty', async () => {
    const store = createReturnStore(dir, 'dev-host')
    expect(await store.read('pr:x')).toEqual(emptyWork('pr:x'))
  })

  it('saves a draft privately and atomically, and keeps it across a restart', async () => {
    const store = createReturnStore(dir, 'dev-host')
    const saved = await store.saveDraft('pr:x', draft('Fix retries'), '')
    expect(saved).toEqual({ saved: true, version: expect.any(String) })
    const file = path.join(dir, 'dev-host.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    const again = createReturnStore(dir, 'dev-host')
    expect((await again.read('pr:x')).draft?.text).toBe('Fix retries')
  })

  it('refuses a draft saved over a newer one and returns the newer one', async () => {
    const store = createReturnStore(dir, 'dev-host')
    const first = await store.saveDraft('pr:x', draft('one'), '')
    if (!first.saved) throw new Error('first save failed')
    await store.saveDraft('pr:x', draft('two'), first.version)
    const stale = await store.saveDraft('pr:x', draft('three'), first.version)
    expect(stale).toMatchObject({ saved: false, draft: expect.objectContaining({ text: 'two' }) })
  })

  it('applies concurrent changes one after another', async () => {
    const store = createReturnStore(dir, 'dev-host')
    await Promise.all([
      store.update('pr:x', (w) => ({ ...w, separations: [...w.separations, { work: 'pr:x', session: 'a' }] })),
      store.update('pr:x', (w) => ({ ...w, separations: [...w.separations, { work: 'pr:x', session: 'b' }] })),
    ])
    expect((await store.read('pr:x')).separations.map((s) => s.session).sort()).toEqual(['a', 'b'])
  })

  it('keeps works apart and keeps hosts in separate files', async () => {
    const a = createReturnStore(dir, 'host-a')
    await a.update('pr:x', (w) => ({ ...w, seenAt: 5 }))
    await a.update('pr:y', (w) => ({ ...w, seenAt: 9 }))
    expect((await a.read('pr:x')).seenAt).toBe(5)
    expect((await createReturnStore(dir, 'host-b').read('pr:x')).seenAt).toBeUndefined()
  })

  it('moves a damaged file aside instead of overwriting it', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'dev-host.json'), '{not json')
    const store = createReturnStore(dir, 'dev-host')
    await store.update('pr:x', (w) => ({ ...w, seenAt: 1 }))
    const aside = readdirSync(dir).find((f) => f.startsWith('dev-host.json.damaged-'))
    expect(aside).toBeDefined()
    expect(readFileSync(path.join(dir, aside!), 'utf8')).toBe('{not json')
    expect((await store.read('pr:x')).seenAt).toBe(1)
  })

  it('names the file safely whatever the host is called', async () => {
    await createReturnStore(dir, '../evil host').update('k', (w) => ({ ...w, seenAt: 1 }))
    expect(readdirSync(dir)).toEqual(['.._evil_host.json'])
  })
})
