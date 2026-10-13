import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  openSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const probe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../probe/agent-probe.py')
const at = (minute: number) => `2026-10-12T10:${String(minute).padStart(2, '0')}:00.000Z`
const line = (rec: object) => `${JSON.stringify(rec)}\n`
const PLACEHOLDER = 'z'.repeat('https://github.com/o/r/pull/99'.length)

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
    ['%1', 'fix-retry', '1', '1', 'claude', '1', '/work/fix'],
    ['%5', 'fix-retry', '0', '1', 'claude', '1', '/work/other'],
    ['%2', 'eval', '1', '1', 'claude', '1', '/work/eval'],
    ['%3', 'notes', '1', '1', 'zsh', '1', '/work/notes'],
    ['%4', 'cdx', '1', '1', 'codex', '1', '/work/cdx'],
    ['%6', 'broken', '1', '1', 'claude', '1', '/work/broken'],
    ['%7', 'longrun', '1', '1', 'claude', '1', '/work/long'],
    ['%8', 'messy', '1', '1', 'claude', '1', '/work/messy'],
    ['%9', 'busyerr', '1', '1', 'claude', '1', '/work/busyerr'],
    ['%10', 'stopped', '1', '1', 'claude', '1', '/work/stopped'],
  ]
  write('work/fix/plan.md', '# plan\n')
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
  write('.claude/sessions/333.json', JSON.stringify({ pid: process.pid, sessionId: 'b1', cwd: '/work/busyerr', status: 'busy', tmux: 'busyerr:@9.%9' }))
  write('.claude/sessions/444.json', JSON.stringify({ pid: process.pid, kind: 'print', status: 'busy', tmux: 'stopped:@10.%10' }))
  write(
    '.claude/projects/-work-busyerr/b1.jsonl',
    [
      line({ type: 'user', timestamp: at(50), message: { content: 'Keep going' } }),
      line({ type: 'assistant', timestamp: at(51), isApiErrorMessage: true, error: 'overloaded', message: { model: '<synthetic>', content: [] } }),
    ].join(''),
  )
  write(
    '.claude/projects/-work-stopped/st.jsonl',
    [
      line({ type: 'user', timestamp: at(52), message: { content: 'Refactor the parser' } }),
      line({ type: 'assistant', timestamp: at(53), message: { model: 'claude-x', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
      line({ type: 'user', timestamp: at(54), message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
    ].join(''),
  )
  write(
    '.claude/projects/-work-messy/m.jsonl',
    [
      '[]\n',
      '"just a string"\n',
      line({ type: 'user', message: 'not an object', timestamp: at(55) }),
      '{"type": "assistant", "timestamp": 1e999, "message": {"content": "flat"}}\n',
      line({ type: 'user', timestamp: at(56), message: { content: 'Tidy the logs' } }),
      line({
        type: 'user',
        timestamp: at(57),
        message: { content: [{ type: 'tool_result' }] },
        toolUseResult: { stdout: 'opened https://git.example.com/g/-/merge_requests/1\nand https://git.example.com/g/-/merge_requests/2' },
      }),
      line({ type: 'assistant', timestamp: at(58), message: { model: 'claude-x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } }),
      line({ type: 'system', subtype: 'turn_duration', timestamp: at(58) }),
    ].join(''),
  )

  write(
    '.claude/projects/-work-fix/s1.jsonl',
    [
      line({ type: 'user', timestamp: at(0), message: { role: 'user', content: '<command-name>/effort</command-name>' } }),
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
      line({ type: 'user', timestamp: at(3), message: { content: [{ type: 'tool_result' }] }, toolUseResult: { filePath: '/work/fix/src/retry.ts', oldString: 'a', newString: 'b' } }),
      line({ type: 'user', timestamp: at(4), message: { content: [{ type: 'tool_result' }] }, toolUseResult: { type: 'create', filePath: path.join(home, 'work/fix/plan.md') } }),
      line({ type: 'user', timestamp: at(4), message: { content: [{ type: 'tool_result' }] }, toolUseResult: { type: 'update', filePath: path.join(home, 'work/fix/plan.md') } }),
      line({ type: 'user', timestamp: at(4), message: { content: [{ type: 'tool_result' }] }, toolUseResult: { type: 'create', filePath: path.join(home, '.claude/plans/p.md') } }),
      line({ type: 'user', timestamp: at(4), message: { content: [{ type: 'tool_result' }] }, toolUseResult: { type: 'create', filePath: 'relative.txt' } }),
      line({ type: 'user', timestamp: at(4), message: { content: [{ type: 'tool_result' }] }, toolUseResult: { stdout: PLACEHOLDER } }),
      line({ type: 'user', timestamp: at(5), message: { role: 'user', content: 'merge it once CI is green' } }),
      line({ type: 'user', timestamp: at(5), isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation.' } }),
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
      line({ type: 'turn_context', timestamp: at(30), payload: { model: 'gpt-codex-x', cwd: '/work/cdx/crate' } }),
      line({ type: 'event_msg', timestamp: at(31), payload: { type: 'user_message', message: 'Port the parser' } }),
      line({ type: 'event_msg', timestamp: at(31), payload: { type: 'task_started' } }),
      line({
        type: 'response_item',
        timestamp: at(32),
        payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'Read', status: 'completed' }, { step: 'Write', status: 'in_progress' }] }) },
      }),
      line({
        type: 'response_item',
        timestamp: at(32),
        payload: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** Add File: /work/cdx/src/lib.rs\n+fn main() {}\n*** Update File: src/parser.rs\n@@\n-a\n+b\n*** Delete File: /work/cdx/old.py\n*** End Patch',
        },
      }),
      line({
        type: 'response_item',
        timestamp: at(33),
        payload: { type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch\n*** Update File: /work/cdx/a.rs\n*** Move to: /work/cdx/b.rs\n@@\n*** End Patch' }) },
      }),
      line({
        type: 'response_item',
        timestamp: at(34),
        payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['apply_patch', '*** Begin Patch\n*** Add File: notes.md\n+x\n*** End Patch'] }) },
      }),
      line({
        type: 'response_item',
        timestamp: at(35),
        payload: {
          type: 'function_call',
          name: 'shell',
          arguments: JSON.stringify({ command: ['bash', '-lc', "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: doc.md\n+x\n*** End Patch\nEOF"], workdir: 'docs' }),
        },
      }),
      line({ type: 'response_item', timestamp: at(36), payload: { type: 'function_call', name: 'shell', arguments: { command: ['apply_patch'] } } }),
    ].join(''),
  )
  write('.codex/session_index.jsonl', line({ id: uuid, thread_name: 'Port the parser to Rust' }))
  const decoys = [
    { source: 'exec', thread_source: 'user', message: 'a one-off exec run' },
    { source: { subagent: { parent: uuid } }, message: 'a subagent' },
  ]
  decoys.forEach(({ message, ...meta }, i) => {
    const file = write(
      `.codex/sessions/2026/10/12/rollout-2026-10-12T11-0${i}-00-0199ffff-0000-0000-0000-00000000000${i}.jsonl`,
      [
        line({ type: 'session_meta', timestamp: at(33), payload: { cwd: '/work/cdx', ...meta } }),
        line({ type: 'event_msg', timestamp: at(33), payload: { type: 'user_message', message } }),
      ].join(''),
    )
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
  })
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
      summaryAt: Date.parse(at(7)) / 1000,
      turnAt: Date.parse(at(6)) / 1000,
      model: 'claude-opus-4-x',
      branch: 'fix-retry',
      commits: 1,
      tasks: { done: 1, total: 2, current: 'Fix the backoff' },
    })
    expect(fix.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'PR',
          url: 'https://github.com/o/r/pull/31',
          action: 'created',
          said: true,
          hits: 2,
          first: Date.parse(at(4)) / 1000,
        }),
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
    expect(Object.keys(agents).sort()).toEqual(['broken', 'busyerr', 'cdx', 'eval', 'fix-retry', 'longrun', 'messy', 'stopped'])
  })

  it('lists the files each agent wrote, newest first, resolving codex paths against the turn folder', () => {
    const agents = run()
    expect(agents['fix-retry'].files).toEqual([
      { path: path.join(home, 'work/fix/plan.md'), action: 'created', at: Date.parse(at(4)) / 1000, count: 2, gone: false },
      { path: '/work/fix/src/retry.ts', action: 'edited', at: Date.parse(at(3)) / 1000, count: 1, gone: true },
    ])
    expect((agents.cdx.files as Array<{ path: string; action: string }>).map((f) => [f.path, f.action])).toEqual([
      ['/work/cdx/crate/docs/doc.md', 'created'],
      ['/work/cdx/crate/notes.md', 'created'],
      ['/work/cdx/a.rs', 'deleted'],
      ['/work/cdx/b.rs', 'created'],
      ['/work/cdx/src/lib.rs', 'created'],
      ['/work/cdx/crate/src/parser.rs', 'edited'],
      ['/work/cdx/old.py', 'deleted'],
    ])
  })

  it('keeps a title written long before the tail it reads, and sees a finished turn without a registry', () => {
    expect(run().longrun).toMatchObject({ title: 'Migrate the billing jobs', state: 'ready' })
  })

  it('survives records of the wrong shape and keeps reporting', () => {
    expect(run().messy).toMatchObject({ state: 'ready', ask: 'Tidy the logs' })
  })

  it('matches artifact patterns against decoded text, so escaped newlines never join two links', () => {
    const urls = (run({ artifacts: [{ label: 'MR', pattern: 'https://git\\.example\\.com/[^ ]+/merge_requests/[0-9]+' }] }).messy
      .artifacts as Array<{ url: string }>).map((a) => a.url)
    expect(urls.sort()).toEqual(['https://git.example.com/g/-/merge_requests/1', 'https://git.example.com/g/-/merge_requests/2'])
  })

  it('trusts a busy registry over an API error the agent is retrying past', () => {
    expect(run().busyerr).toMatchObject({ state: 'working' })
  })

  it('treats an interrupted turn as finished and ignores registry entries that are not interactive sessions', () => {
    expect(run().stopped).toMatchObject({ state: 'ready', ask: 'Refactor the parser' })
  })

  it('takes codex state from the interactive rollout, not newer exec or subagent runs in the same folder', () => {
    expect(run().cdx).toMatchObject({ ask: 'Port the parser', state: 'working' })
  })

  it('keeps its cache private to the user', () => {
    run()
    const dir = path.join(home, '.cache/devbox')
    const files = readdirSync(dir).filter((f) => f.startsWith('agent-probe-'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(statSync(path.join(dir, f)).mode & 0o777).toBe(0o600)
  })

  it.runIf(existsSync('/proc/self/stat'))('ignores a registry entry whose pid now belongs to another process', () => {
    write('.claude/sessions/555.json', JSON.stringify({ pid: process.pid, procStart: '1', status: 'waiting', tmux: 'eval:@2.%2' }))
    try {
      expect(run().eval.state).toBe('working')
    } finally {
      rmSync(path.join(home, '.claude/sessions/555.json'))
    }
  })

  it('turns a bare id into a link when the pattern has a link template', () => {
    const agents = run({ artifacts: [{ label: 'CR', pattern: 'CR-\\d+', link: 'https://code.example.com/reviews/{0}' }] })
    expect(agents.longrun.artifacts).toEqual([expect.objectContaining({ label: 'CR', url: 'https://code.example.com/reviews/CR-77' })])
  })

  it('gives two agents in one folder different transcripts and forgets the ones no session uses', () => {
    const tmux = path.join(home, 'bin/tmux')
    const panes = readFileSync(tmux, 'utf8')
    writeFileSync(tmux, `#!/bin/sh\nprintf '%s\\n' '%21\ttwin-a\t1\t1\tclaude\t1\t/work/eval' '%22\ttwin-b\t1\t1\tclaude\t1\t/work/eval'\n`)
    try {
      const agents = run()
      expect([agents['twin-a'].ask, agents['twin-b'].ask].sort()).toEqual(['Build the latency dashboard', 'an older task'])
      const dir = path.join(home, '.cache/devbox')
      const files = readdirSync(dir)
        .filter((f) => f.startsWith('agent-probe-'))
        .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as { key: string; files: Record<string, unknown> })
        .find((c) => c.key.includes('reviews/CR') && !c.key.includes('{0}'))!.files
      expect(Object.keys(files).map((f) => path.basename(f)).sort()).toEqual(['new.jsonl', 'old.jsonl'])
    } finally {
      writeFileSync(tmux, panes)
    }
  })

  it('scans only new transcript bytes on the next run and still finds new artifacts', () => {
    run()
    const transcript = path.join(home, '.claude/projects/-work-fix/s1.jsonl')
    const dir = path.join(home, '.cache/devbox')
    const cache = () =>
      readdirSync(dir)
        .filter((f) => f.startsWith('agent-probe-'))
        .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as { key: string; files: Record<string, { off: number }> })
        .find((c) => c.key.includes('reviews/CR') && !c.key.includes('{0}'))!
    expect(cache().files[transcript].off).toBe(statSync(transcript).size)
    const fd = openSync(transcript, 'r+')
    writeSync(fd, 'https://github.com/o/r/pull/99', readFileSync(transcript, 'utf8').indexOf(PLACEHOLDER))
    closeSync(fd)
    appendFileSync(
      transcript,
      line({ type: 'user', timestamp: at(8), message: { content: [{ type: 'tool_result' }] }, toolUseResult: { stdout: 'https://github.com/o/r/pull/32' } }),
    )
    const artifacts = run()['fix-retry'].artifacts as Array<{ url: string; hits: number }>
    expect(artifacts.map((a) => a.url)).toEqual(expect.arrayContaining(['https://github.com/o/r/pull/31', 'https://github.com/o/r/pull/32']))
    expect(artifacts.find((a) => a.url.endsWith('/31'))?.hits).toBe(2)
    expect(artifacts.map((a) => a.url)).not.toContain('https://github.com/o/r/pull/99')
    expect(cache().files[transcript].off).toBe(statSync(transcript).size)
  })
})
