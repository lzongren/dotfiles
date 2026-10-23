import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RETURN_CAPS } from '../../server/return.js'

const probe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../probe/agent-probe.py')
const at = (minute: number) => `2026-10-16T10:${String(minute).padStart(2, '0')}:00.000Z`
const secs = (minute: number) => Date.parse(at(minute)) / 1000
const line = (rec: object) => `${JSON.stringify(rec)}\n`
const PR = 'https://github.com/acme/api/pull/184'

let home: string
let transcript: string

function write(rel: string, content: string) {
  const file = path.join(home, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

interface Out {
  lookalikes?: Array<Record<string, unknown>>
  sessions: Array<{
    name: string
    pane: string
    agent: string
    repo?: string
    branch?: string
    registry?: { sessionId: string; status: string }
    transcript?: { ino: number; size: number; last: string; sid: string }
    records: Array<{ id: string; kind: string; at: number; text: string; turn?: number; final?: boolean }>
    dropped?: Record<string, number>
    partial?: boolean
    closes?: boolean
    turnEnds?: number[]
  }>
}

function run(args: object): Out {
  const script = `ARGS = __import__("json").loads(${JSON.stringify(JSON.stringify({ mode: 'return', ...args }))})\n${readFileSync(probe, 'utf8')}`
  const out = execFileSync('python3', ['-I', '-'], { input: script, env: { HOME: home, PATH: `${path.join(home, 'bin')}:${process.env.PATH}` } })
  return JSON.parse(out.toString()) as Out
}

const byName = (out: Out, name: string) => out.sessions.find((s) => s.name === name)

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'return-probe-'))
  const panes = [
    ['%1', 'fix', '1', '1', 'claude', '1', '/work/fix'],
    ['%2', 'review', '1', '1', 'claude', '1', '/work/review'],
    ['%3', 'tests', '1', '1', 'zsh', '1', '/work/fix-tests'],
    ['%4', 'other', '1', '1', 'zsh', '1', '/work/other'],
    ['%5', 'docs', '1', '1', 'claude', '1', '/work/docs'],
    ['%6', 'other-copy', '1', '1', 'zsh', '1', '/x/other'],
    ['%7', 'home', '1', '1', 'zsh', '1', home],
    ['%8', 'home-copy', '1', '1', 'zsh', '1', `/x/${path.basename(home)}`],
    ['%9', 'fix', '1', '0', 'claude', '1', '/work/fix'],
    ['%10', 'fix', '1', '0', 'claude', '1', '/work/fix'],
  ]
  write(
    'bin/tmux',
    [
      '#!/bin/sh',
      'case "$1" in',
      `  list-panes) printf '%s\\n' ${panes.map((p) => `'${p.join('\t')}'`).join(' ')} ;;`,
      '  capture-pane) printf \'%s\\n\' "$ npm test" "FAIL retry.test.ts" "  expected 1 attempt, got 2" "" ;;',
      `  display) echo ${secs(40)} ;;`,
      'esac',
    ].join('\n'),
  )
  write(
    'bin/git',
    [
      '#!/bin/sh',
      'case "$2" in',
      '  /work/fix|/work/fix-tests) printf "/work/api\\nfix/retry\\n" ;;',
      '  /work/review) printf "/work/review-repo\\nfix/retry\\n" ;;',
      '  /work/other|/x/other) printf "/work/other\\nmain\\n" ;;',
      '  *) exit 128 ;;',
      'esac',
    ].join('\n'),
  )
  chmodSync(path.join(home, 'bin/tmux'), 0o755)
  chmodSync(path.join(home, 'bin/git'), 0o755)
  write('.claude/sessions/1.json', JSON.stringify({ pid: process.pid, sessionId: 's1', cwd: '/work/fix', status: 'idle', tmux: 'fix:@1.%1' }))
  write('.claude/sessions/2.json', JSON.stringify({ pid: process.pid, sessionId: 's2', cwd: '/work/review', status: 'busy', tmux: 'review:@2.%2' }))
  write('.claude/sessions/9.json', JSON.stringify({ pid: process.pid, sessionId: 's9', cwd: '/work/fix', status: 'idle', tmux: 'fix:@1.%9' }))
  write('.claude/sessions/10.json', JSON.stringify({ pid: process.pid, sessionId: 's9', cwd: '/work/fix', status: 'idle', tmux: 'fix:@1.%10' }))
  write('.claude/projects/-work-review/s2.jsonl', line({ type: 'user', uuid: 'r1', timestamp: at(1), message: { content: 'Review PR 184' } }))
  transcript = write(
    '.claude/projects/-work-fix/s1.jsonl',
    [
      line({ type: 'user', uuid: 'u1', timestamp: at(0), message: { content: 'Fix retries.\nAt most 2 attempts, because upstream is rate limiting.' } }),
      line({ type: 'assistant', uuid: 'a0', timestamp: at(1), message: { content: [{ type: 'text', text: 'Looking.' }] } }),
      line({ type: 'assistant', uuid: 'a1', timestamp: at(2), message: { content: [{ type: 'text', text: 'Budget handling is done.\nCI still fails.' }] } }),
      line({ type: 'system', subtype: 'turn_duration', timestamp: at(3) }),
      line({ type: 'user', uuid: 'm1', isMeta: true, timestamp: at(4), message: { content: 'meta' } }),
      line({ type: 'user', uuid: 'sc', isSidechain: true, timestamp: at(4), message: { content: 'subagent prompt' } }),
      line({ type: 'user', uuid: 'u2', timestamp: at(5), message: { content: 'At most 1 attempt instead of 2.' } }),
      line({ type: 'assistant', uuid: 'a2', timestamp: at(6), message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
      line({
        type: 'user',
        uuid: 'f1',
        timestamp: at(7),
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'FAIL retry.test.ts\nexpected 1 attempt' }] },
      }),
      line({ type: 'assistant', uuid: 'a3', timestamp: at(8), message: { content: [{ type: 'text', text: 'One test still fails.' }] } }),
      line({ type: 'system', subtype: 'turn_duration', timestamp: at(9) }),
    ].join(''),
  )
})

afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('return probe', { timeout: 20000 }, () => {
  it('returns the target and the sessions that share its pull request or branch, never by folder', () => {
    const out = run({ target: 'fix', prs: { fix: [PR], review: [PR] } })
    expect(out.sessions.map((s) => s.name).sort()).toEqual(['fix', 'review', 'tests'])
    expect(byName(out, 'tests')).toMatchObject({ agent: 'shell', repo: '/work/api', branch: 'fix/retry' })
    expect(run({ target: 'fix', prs: {} }).sessions.map((s) => s.name).sort()).toEqual(['fix', 'tests'])
  })

  it('names sessions that only look related: same branch name in another repository, or the same folder name', () => {
    expect(run({ target: 'fix', prs: {} }).lookalikes).toEqual([{ name: 'review', path: '/work/review', repo: '/work/review-repo', branch: 'fix/retry', why: 'branch' }])
    expect(run({ target: 'fix', prs: { fix: [PR], review: [PR] } }).lookalikes).toEqual([])
  })

  it('reads the pane running the conversation a repair went to, when the session has another one in front', () => {
    expect(byName(run({ target: 'fix', prs: {} }), 'fix')?.pane).toBe('%1')
    expect(byName(run({ target: 'fix', prs: {}, prefer: 's9' }), 'fix')?.pane).toBe('%9')
    expect(byName(run({ target: 'fix', prs: {}, prefer: 's9', preferPane: '%10' }), 'fix')?.pane).toBe('%10')
    expect(byName(run({ target: 'fix', prs: {}, prefer: 's9', preferPane: '%1' }), 'fix')?.pane).toBe('%9')
    expect(byName(run({ target: 'fix', prs: {}, prefer: 's-gone' }), 'fix')?.pane).toBe('%1')
  })

  it('does not call a session a lookalike for sharing the default branch of the same repository, or the home folder', () => {
    expect(run({ target: 'other', prs: {} }).lookalikes).toEqual([])
    expect(run({ target: 'home', prs: {} }).lookalikes).toEqual([])
  })

  it('reports the pane, the registry entry and a resumable transcript version', () => {
    const fix = byName(run({ target: 'fix', prs: {} }), 'fix')
    expect(fix).toMatchObject({ pane: '%1', agent: 'claude', repo: '/work/api', branch: 'fix/retry', registry: { sessionId: 's1', status: 'idle' } })
    expect(fix?.transcript).toEqual({ ino: statSync(transcript).ino, size: statSync(transcript).size, last: 'a3', sid: 's1' })
  })

  it('reads decisions, the last agent text of each turn and failed tool results, keeping line breaks', () => {
    const fix = byName(run({ target: 'fix', prs: {} }), 'fix')
    expect(fix?.records.map((r) => [r.id, r.kind, r.turn])).toEqual([
      ['u1', 'decision', 1],
      ['a1', 'agent', 1],
      ['u2', 'decision', 2],
      ['f1', 'failure', 2],
      ['a3', 'agent', 2],
    ])
    expect(fix?.records[0]).toMatchObject({ at: secs(0), text: 'Fix retries.\nAt most 2 attempts, because upstream is rate limiting.' })
    expect(fix?.records[1]).toMatchObject({ text: 'Budget handling is done.\nCI still fails.', final: true })
    expect(fix?.records[3].text).toBe('FAIL retry.test.ts\nexpected 1 attempt')
    expect(fix?.turnEnds).toEqual([secs(3), secs(9)])
  })

  it('takes the recent output of a shell session as one record', () => {
    const tests = byName(run({ target: 'fix', prs: {} }), 'tests')
    expect(tests?.records).toEqual([
      expect.objectContaining({ kind: 'shell', at: secs(40), text: '$ npm test\nFAIL retry.test.ts\n  expected 1 attempt, got 2', id: expect.stringMatching(/^shell:%3:/) }),
    ])
  })

  it('reads only what was appended since a version, and starts over when the file was replaced', () => {
    const first = byName(run({ target: 'fix', prs: {} }), 'fix')!
    appendFileSync(
      transcript,
      line({ type: 'user', uuid: 'u3', timestamp: at(20), message: { content: '[devbox repair r-1]\nPurpose: repair.' } }) +
        line({ type: 'assistant', uuid: 'a4', timestamp: at(21), message: { content: [{ type: 'text', text: '[devbox result r-1] Changed retry.ts' }] } }),
    )
    const next = byName(run({ target: 'fix', prs: {}, from: { fix: first.transcript } }), 'fix')!
    expect(next.partial).toBe(true)
    expect(next.records.map((r) => [r.id, r.kind])).toEqual([
      ['u3', 'devbox'],
      ['a4', 'agent'],
    ])
    expect(next.records[1].final).toBe(false)
    const restarted = byName(run({ target: 'fix', prs: {}, from: { fix: { ...first.transcript, ino: 1 } } }), 'fix')!
    expect(restarted.partial).toBe(false)
    expect(restarted.records[0].id).toBe('u1')
    const other = byName(run({ target: 'fix', prs: {}, from: { fix: { ...first.transcript, sid: 's-old' } } }), 'fix')!
    expect(other.partial).toBe(false)
  })

  it('keeps the newest records within its caps and says how many it left out', () => {
    write(
      '.claude/sessions/5.json',
      JSON.stringify({ pid: process.pid, sessionId: 's5', cwd: '/work/docs', status: 'idle', tmux: 'docs:@5.%5' }),
    )
    write(
      '.claude/projects/-work-docs/s5.jsonl',
      Array.from({ length: 250 }, (_, i) => line({ type: 'user', uuid: `d${i}`, timestamp: at(0), message: { content: `note ${i}` } })).join(''),
    )
    const docs = byName(run({ target: 'docs', prs: {}, caps: RETURN_CAPS }), 'docs')!
    expect(docs.records).toHaveLength(200)
    expect(docs.records[0].id).toBe('d50')
    expect(docs.dropped).toEqual({ decision: 50 })
  })

  it('answers for a session with no agent transcript without failing', () => {
    rmSync(path.join(home, '.claude/sessions/5.json'))
    rmSync(path.join(home, '.claude/projects/-work-docs'), { recursive: true })
    const docs = byName(run({ target: 'docs', prs: {} }), 'docs')!
    expect(docs).toMatchObject({ agent: 'claude', records: [] })
    expect(docs.transcript).toBeUndefined()
  })
})

describe('return probe reading a growing transcript', { timeout: 20000 }, () => {
  const docs = () => path.join(home, '.claude/projects/-work-docs/s6.jsonl')
  const read = (from?: object) => byName(run({ target: 'docs', prs: {}, ...(from ? { from: { docs: from } } : {}) }), 'docs')!

  beforeAll(() => {
    write('.claude/sessions/6.json', JSON.stringify({ pid: process.pid, sessionId: 's6', cwd: '/work/docs', status: 'idle', tmux: 'docs:@5.%5' }))
  })

  it('starts a full read from the newest part of a transcript over the scan limit', () => {
    const pad = 'x'.repeat(1000)
    const filler = line({ type: 'progress', pad })
    write('.claude/projects/-work-docs/s6.jsonl', filler.repeat(Math.ceil((33 * 1024 * 1024) / filler.length)))
    appendFileSync(docs(), line({ type: 'user', uuid: 'newest', timestamp: at(30), message: { content: 'The newest decision.' } }))
    expect(read().records.map((r) => r.id)).toEqual(['newest'])
  })

  it('counts only complete lines, so a record still being written is read whole next time', () => {
    write('.claude/projects/-work-docs/s6.jsonl', line({ type: 'user', uuid: 'd1', timestamp: at(0), message: { content: 'First.' } }))
    const whole = line({ type: 'user', uuid: 'd2', timestamp: at(1), message: { content: 'Second.' } })
    appendFileSync(docs(), whole.slice(0, 20))
    const first = read()
    expect(first.records.map((r) => r.id)).toEqual(['d1'])
    expect(first.transcript?.size).toBe(statSync(docs()).size - 20)
    appendFileSync(docs(), whole.slice(20))
    const next = read(first.transcript)
    expect(next.partial).toBe(true)
    expect(next.records.map((r) => r.id)).toEqual(['d2'])
  })

  it('passes non-ASCII text through unchanged', () => {
    write('.claude/projects/-work-docs/s6.jsonl', line({ type: 'user', uuid: 'd1', timestamp: at(0), message: { content: 'Keep “quotes” — at most 2 attempts, ünïcode.' } }))
    expect(read().records[0].text).toBe('Keep “quotes” — at most 2 attempts, ünïcode.')
  })

  it('says when a later read only closes the turn that was open', () => {
    write(
      '.claude/projects/-work-docs/s6.jsonl',
      line({ type: 'user', uuid: 'd1', timestamp: at(0), message: { content: 'Do it.' } }) +
        line({ type: 'assistant', uuid: 'a1', timestamp: at(1), message: { content: [{ type: 'text', text: 'Done.' }] } }),
    )
    const first = read()
    expect(first.records.at(-1)).toMatchObject({ id: 'a1', final: false })
    appendFileSync(docs(), line({ type: 'system', subtype: 'turn_duration', timestamp: at(2) }))
    const next = read(first.transcript)
    expect(next).toMatchObject({ partial: true, closes: true, records: [] })
  })

  it('still closes the open turn when a tool error came before the turn ended', () => {
    write(
      '.claude/projects/-work-docs/s6.jsonl',
      line({ type: 'user', uuid: 'd1', timestamp: at(0), message: { content: 'Do it.' } }) +
        line({ type: 'assistant', uuid: 'a1', timestamp: at(1), message: { content: [{ type: 'text', text: 'Done.' }] } }),
    )
    const first = read()
    appendFileSync(
      docs(),
      line({ type: 'user', uuid: 'f1', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'lint failed' }] } }) +
        line({ type: 'system', subtype: 'turn_duration', timestamp: at(3) }),
    )
    expect(read(first.transcript)).toMatchObject({ partial: true, closes: true, records: [{ id: 'f1', kind: 'failure' }] })
  })

  it('replaces a broken character instead of failing the whole read', () => {
    write('.claude/projects/-work-docs/s6.jsonl', line({ type: 'user', uuid: 'd1', timestamp: at(0), message: { content: 'Cut \ud83d here.' } }))
    expect(read().records[0].text).toBe('Cut ? here.')
  })
})
