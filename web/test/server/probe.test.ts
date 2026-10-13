import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const probe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../probe/agent-probe.py')
const at = (minute: number) => `2026-10-12T10:${String(minute).padStart(2, '0')}:00.000Z`
const line = (rec: object) => `${JSON.stringify(rec)}\n`

let home: string

function write(rel: string, content: string) {
  const file = path.join(home, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

function run(args: object = { artifacts: [{ label: 'CR', pattern: 'https://code\\.example\\.com/reviews/CR-\\d+' }] }) {
  const script = `ARGS = __import__("json").loads(${JSON.stringify(JSON.stringify(args))})\n${readFileSync(probe, 'utf8')}`
  const out = execFileSync('python3', ['-I', '-'], {
    input: script,
    env: { HOME: home, PATH: `${path.join(home, 'bin')}:${process.env.PATH}` },
  })
  const doc = JSON.parse(out.toString()) as { v: number; agents: Array<Record<string, unknown>> }
  return Object.fromEntries(doc.agents.map((a) => [a.session as string, a]))
}

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'probe-'))
  const panes = [
    ['%1', 'fix-retry', '1', '1', 'claude', '/work/fix'],
    ['%5', 'fix-retry', '0', '1', 'claude', '/work/other'],
    ['%2', 'eval', '1', '1', 'claude', '/work/eval'],
    ['%3', 'notes', '1', '1', 'zsh', '/work/notes'],
    ['%4', 'cdx', '1', '1', 'codex', '/work/cdx'],
    ['%6', 'broken', '1', '1', 'claude', '/work/broken'],
    ['%7', 'longrun', '1', '1', 'claude', '/work/long'],
  ]
  write('bin/tmux', `#!/bin/sh\nprintf '%s\\n' ${panes.map((p) => `'${p.join('\t')}'`).join(' ')}\n`)
  chmodSync(path.join(home, 'bin/tmux'), 0o755)

  write(
    '.claude/sessions/111.json',
    JSON.stringify({
      pid: process.pid,
      sessionId: 's1',
      cwd: '/work/fix',
      status: 'waiting',
      waitingFor: 'permission prompt',
      statusUpdatedAt: 1791700000000,
      tmux: 'fix-retry:@1.%1',
    }),
  )
  write('.claude/sessions/222.json', JSON.stringify({ pid: 99999999, sessionId: 'gone', status: 'busy', tmux: 'eval:@2.%2' }))

  write(
    '.claude/projects/-work-fix/s1.jsonl',
    [
      line({
        type: 'user',
        timestamp: at(0),
        message: {
          role: 'user',
          content: '<command-message>goal</command-message>\n<command-name>/goal</command-name>\n<command-args>Fix the flaky retry test</command-args>',
        },
      }),
      line({ type: 'assistant', timestamp: at(1), message: { content: [{ type: 'tool_use', name: 'TaskCreate', input: { subject: 'Reproduce the flake' } }] } }),
      line({ type: 'user', timestamp: at(1), toolUseResult: { task: { id: '1', subject: 'Reproduce the flake' } }, message: { content: [{ type: 'tool_result' }] } }),
      line({ type: 'user', timestamp: at(2), toolUseResult: { task: { id: '2', subject: 'Fix the backoff' } }, message: { content: [{ type: 'tool_result' }] } }),
      line({
        type: 'assistant',
        timestamp: at(3),
        message: {
          content: [
            { type: 'tool_use', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
            { type: 'tool_use', name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' } },
          ],
        },
      }),
      line({
        type: 'user',
        timestamp: at(4),
        message: { content: [{ type: 'tool_result' }] },
        toolUseResult: {
          stdout: 'review posted: https://code.example.com/reviews/CR-42',
          gitOperation: { commit: { sha: 'abc', kind: 'committed' }, pr: { number: 31, url: 'https://github.com/o/r/pull/31', action: 'created' } },
        },
      }),
      line({ type: 'pr-link', prUrl: 'https://github.com/o/r/pull/31', prNumber: 31, timestamp: at(4) }),
      line({ type: 'user', timestamp: at(5), message: { role: 'user', content: 'merge it once CI is green' } }),
      line({
        type: 'assistant',
        timestamp: at(6),
        gitBranch: 'fix-retry',
        message: { model: 'claude-opus-4-x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Pushed the fix; CI is running.' }] },
      }),
      line({ type: 'system', subtype: 'turn_duration', timestamp: at(6) }),
      line({ type: 'system', subtype: 'away_summary', content: 'Fix is up as PR 31; waiting on CI before merging.', timestamp: at(7) }),
      line({ type: 'ai-title', aiTitle: 'Fix flaky retry test' }),
      line({ type: 'last-prompt', lastPrompt: 'merge it once CI is green' }),
    ].join(''),
  )

  const old = write('.claude/projects/-work-eval/old.jsonl', line({ type: 'user', timestamp: at(0), message: { content: 'an older task' } }))
  utimesSync(old, new Date('2026-01-01'), new Date('2026-01-01'))
  write(
    '.claude/projects/-work-eval/new.jsonl',
    [
      line({ type: 'user', timestamp: at(10), message: { content: 'Build the latency dashboard' } }),
      line({ type: 'assistant', timestamp: at(11), message: { model: 'claude-sonnet-x', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
    ].join(''),
  )

  write(
    '.claude/projects/-work-broken/b.jsonl',
    [
      line({ type: 'user', timestamp: at(20), message: { content: 'Summarize the logs' } }),
      line({ type: 'assistant', timestamp: at(21), isApiErrorMessage: true, error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] } }),
    ].join(''),
  )

  write(
    '.claude/projects/-work-long/l.jsonl',
    [
      line({ type: 'ai-title', aiTitle: 'Migrate the billing jobs' }),
      line({ type: 'user', timestamp: at(40), message: { content: 'Migrate the billing jobs; track it in CR-77' } }),
      line({ type: 'user', timestamp: at(41), message: { content: [{ type: 'tool_result' }] }, toolUseResult: { stdout: 'x'.repeat(300 * 1024) } }),
      line({ type: 'assistant', timestamp: at(42), message: { model: 'claude-x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } }),
    ].join(''),
  )

  const uuid = '0199aaaa-bbbb-cccc-dddd-eeeeffff0000'
  write(
    `.codex/sessions/2026/10/12/rollout-2026-10-12T10-00-00-${uuid}.jsonl`,
    [
      line({ type: 'session_meta', timestamp: at(30), payload: { cwd: '/work/cdx', thread_source: 'user', source: 'cli' } }),
      line({ type: 'turn_context', timestamp: at(30), payload: { model: 'gpt-codex-x' } }),
      line({ type: 'event_msg', timestamp: at(31), payload: { type: 'user_message', message: 'Port the parser' } }),
      line({ type: 'event_msg', timestamp: at(31), payload: { type: 'task_started' } }),
      line({
        type: 'response_item',
        timestamp: at(32),
        payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'Read', status: 'completed' }, { step: 'Write', status: 'in_progress' }] }) },
      }),
    ].join(''),
  )
  write('.codex/session_index.jsonl', line({ id: uuid, thread_name: 'Port the parser to Rust' }))
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('agent probe', () => {
  it('stays within Python 3.7 syntax, the oldest remote it supports', () => {
    const check = `import ast,sys\nif sys.version_info >= (3, 8): ast.parse(open(${JSON.stringify(probe)}).read(), feature_version=(3, 7))`
    execFileSync('python3', ['-I', '-c', check])
  })

  it('takes state from the live registry and the story from the transcript', () => {
    const fix = run()['fix-retry']
    expect(fix).toMatchObject({
      agent: 'claude',
      state: 'waiting',
      waitingFor: 'permission prompt',
      since: 1791700000,
      title: 'Fix flaky retry test',
      firstAsk: '/goal Fix the flaky retry test',
      ask: 'merge it once CI is green',
      summary: 'Fix is up as PR 31; waiting on CI before merging.',
      model: 'claude-opus-4-x',
      branch: 'fix-retry',
      commits: 1,
      tasks: { done: 1, total: 2, current: 'Fix the backoff' },
    })
    expect(fix.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'PR', url: 'https://github.com/o/r/pull/31', action: 'created', said: true, hits: 2 }),
        expect.objectContaining({ label: 'CR', url: 'https://code.example.com/reviews/CR-42', said: false, hits: 1 }),
      ]),
    )
  })

  it('infers state from the newest transcript when the registry has no live entry', () => {
    const agents = run()
    expect(agents.eval).toMatchObject({ agent: 'claude', state: 'working', ask: 'Build the latency dashboard', model: 'claude-sonnet-x' })
    expect(agents.broken).toMatchObject({ state: 'error', error: 'rate_limit' })
  })

  it('reads codex state, plan, and title from its rollout', () => {
    expect(run().cdx).toMatchObject({
      agent: 'codex',
      state: 'working',
      ask: 'Port the parser',
      model: 'gpt-codex-x',
      title: 'Port the parser to Rust',
      tasks: { done: 1, total: 2, current: 'Write' },
    })
  })

  it('skips shells and keeps the active pane when a session has several agents', () => {
    const agents = run()
    expect(agents.notes).toBeUndefined()
    expect(Object.keys(agents).sort()).toEqual(['broken', 'cdx', 'eval', 'fix-retry', 'longrun'])
  })

  it('keeps a title written long before the tail it reads', () => {
    expect(run().longrun.title).toBe('Migrate the billing jobs')
  })

  it('turns a bare id into a link when the pattern has a link template', () => {
    const agents = run({ artifacts: [{ label: 'CR', pattern: 'CR-\\d+', link: 'https://code.example.com/reviews/{0}' }] })
    expect(agents.longrun.artifacts).toEqual([expect.objectContaining({ label: 'CR', url: 'https://code.example.com/reviews/CR-77' })])
  })

  it('scans only new transcript bytes on the next run and still finds new artifacts', () => {
    run()
    const transcript = path.join(home, '.claude/projects/-work-fix/s1.jsonl')
    const cache = () => JSON.parse(readFileSync(path.join(home, '.cache/devbox/agent-probe.json'), 'utf8'))
    expect(cache().files[transcript].off).toBe(statSync(transcript).size)
    appendFileSync(
      transcript,
      line({ type: 'user', timestamp: at(8), message: { content: [{ type: 'tool_result' }] }, toolUseResult: { stdout: 'https://github.com/o/r/pull/32' } }),
    )
    const urls = (run()['fix-retry'].artifacts as Array<{ url: string }>).map((a) => a.url)
    expect(urls).toEqual(expect.arrayContaining(['https://github.com/o/r/pull/31', 'https://github.com/o/r/pull/32']))
    expect(cache().files[transcript].off).toBe(statSync(transcript).size)
  })
})
