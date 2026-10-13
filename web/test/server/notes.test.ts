import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '../../server/index.js'

const stubsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../stubs')

describe('notes API', () => {
  let app: App
  let root: string
  let notesDir: string

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'devbox-web-notes.'))
    mkdirSync(path.join(root, 'dist'))
    writeFileSync(path.join(root, 'dist/index.html'), '<html></html>')
    notesDir = path.join(root, 'notes')
    app = await createApp({ port: 0, bin: stubsDir, stateDir: path.join(root, 'state'), distRoot: path.join(root, 'dist'), version: '0', notesDir })
  })

  afterAll(async () => {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  })

  const call = (route: string, init: { method?: string; body?: unknown; origin?: string } = {}) =>
    fetch(`${app.url.split('#')[0]}api/notes${route}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${app.token}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init.origin ? { Origin: init.origin } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })

  it('saves a day as a private markdown file and reads it back', async () => {
    const put = await call('/2026-10-13', { method: 'PUT', body: { text: '- [ ] ship notes\n', base: '' } })
    expect(put.status).toBe(200)
    const { version } = (await put.json()) as { version: string }
    expect(await (await call('/2026-10-13')).json()).toEqual({ day: '2026-10-13', text: '- [ ] ship notes\n', version })
    const file = path.join(notesDir, '2026-10-13.md')
    expect(readFileSync(file, 'utf8')).toBe('- [ ] ship notes\n')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(notesDir).mode & 0o777).toBe(0o700)
  })

  it('lists the days that have notes, newest first, and forgets a day you clear', async () => {
    const older = await call('/2026-10-11', { method: 'PUT', body: { text: 'older', base: '' } })
    expect(await (await call('')).json()).toEqual({ days: ['2026-10-13', '2026-10-11'] })
    const { version } = (await older.json()) as { version: string }
    await call('/2026-10-11', { method: 'PUT', body: { text: '  \n', base: version } })
    expect(existsSync(path.join(notesDir, '2026-10-11.md'))).toBe(false)
    expect(await (await call('')).json()).toEqual({ days: ['2026-10-13'] })
    expect(await (await call('/2026-01-01')).json()).toEqual({ day: '2026-01-01', text: '', version: '' })
  })

  it('refuses a write based on an older version and hands back what is there now', async () => {
    const res = await call('/2026-10-13', { method: 'PUT', body: { text: 'from a stale tab', base: 'not-the-version' } })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'conflict', text: '- [ ] ship notes\n' })
    expect(readFileSync(path.join(notesDir, '2026-10-13.md'), 'utf8')).toBe('- [ ] ship notes\n')
  })

  it('reports a note it cannot read instead of passing it off as empty', async () => {
    mkdirSync(path.join(notesDir, '2026-10-20.md'), { recursive: true })
    expect((await call('/2026-10-20')).status).toBe(500)
  })

  it('refuses days that are not dates, bodies without text, and writes from another origin', async () => {
    expect((await call('/today')).status).toBe(400)
    expect((await call('/2026-10-13', { method: 'PUT', body: { text: 5, base: '' } })).status).toBe(400)
    expect((await call('/2026-10-13', { method: 'PUT', body: { text: 'x' } })).status).toBe(400)
    expect((await call('/2026-10-13', { method: 'PUT', body: { text: 'x', base: '' }, origin: 'https://evil.example' })).status).toBe(403)
    expect(readFileSync(path.join(notesDir, '2026-10-13.md'), 'utf8')).toBe('- [ ] ship notes\n')
  })
})
