import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const probe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../probe/agent-probe.py')
const PROMPT = '[devbox question q-1]\nRead-only investigation.\n\nQuestion: why $(touch /tmp/x)?'

let home: string
let cwd: string

function write(rel: string, content: string) {
  const file = path.join(home, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

function fakeClaude(init: object, extra = '') {
  const lines = [
    { type: 'system', subtype: 'init', ...init },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x' } }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Facts: at most 2 attempts.', total_cost_usd: 1.02 },
  ]
  write(
    'bin/claude',
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" > "$HOME/claude-argv.txt"',
      'pwd > "$HOME/claude-cwd.txt"',
      'cat > "$HOME/claude-stdin.txt"',
      `printf '%s\\n' '${JSON.stringify(lines[0])}'`,
      'sleep 0.2',
      extra,
      `printf '%s\\n' '${JSON.stringify(lines[1])}'`,
      'echo ran-after-init > "$HOME/after-init.txt"',
      `printf '%s\\n' '${JSON.stringify(lines[2])}'`,
    ].join('\n'),
  )
  chmodSync(path.join(home, 'bin/claude'), 0o755)
}

function call(args: Record<string, unknown>, PATH = `${path.join(home, 'bin')}:${process.env.PATH}`) {
  const script = `ARGS = __import__("json").loads(${JSON.stringify(JSON.stringify(args))})\n${readFileSync(probe, 'utf8')}`
  const out = execFileSync('python3', ['-I', '-'], { input: script, env: { HOME: home, PATH } })
  return JSON.parse(out.toString()) as Record<string, unknown>
}

const ask = (args: Record<string, unknown> = {}) =>
  call({ mode: 'ask', session: 'fix', pane: '%1', sessionId: 's1', inquiryId: 'q-1', prompt: PROMPT, budget: 3, ...args })

async function settled(id = 'q-1') {
  for (let i = 0; i < 100; i++) {
    const polled = call({ mode: 'askpoll', ids: [id] }) as Record<string, { state: string }>
    if (polled[id]?.state !== 'running') return polled[id] as Record<string, unknown>
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('inquiry never settled')
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'return-ask-'))
  cwd = mkdtempSync(path.join(os.tmpdir(), 'return-ask-cwd-'))
  write('bin/tmux', `#!/bin/sh\ncase "$1" in display) [ "$4" = "%1" ] && printf 'fix\\tclaude\\n' || exit 1 ;; esac\n`)
  chmodSync(path.join(home, 'bin/tmux'), 0o755)
  write('.claude/sessions/1.json', JSON.stringify({ pid: process.pid, sessionId: 's1', cwd, status: 'busy', tmux: 'fix:@1.%1' }))
  write(
    '.claude/settings.json',
    JSON.stringify({
      permissions: { allow: ['Bash(python3 *)'], defaultMode: 'auto' },
      hooks: { Stop: [] },
      enabledPlugins: { x: true },
      statusLine: { command: 'x' },
      awsAuthRefresh: 'refresh-cmd',
      awsCredentialExport: 'export-cmd',
      model: 'opus',
      modelOverrides: { a: 'b' },
      env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-west-2', ANTHROPIC_DEFAULT_SONNET_MODEL: 'm', CLAUDE_CODE_PLUGIN_DIRS: '/p', SECRET_TOKEN: 's' },
    }),
  )
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

describe('asking a read-only copy on the host', () => {
  it('starts a forked, restricted, non-persistent run in the session folder with the prompt on stdin', async () => {
    fakeClaude({ tools: ['Glob', 'Grep', 'Read'], mcp_servers: [] })
    expect(ask()).toEqual({ result: 'started' })
    await settled()
    const argv = readFileSync(path.join(home, 'claude-argv.txt'), 'utf8').trim().split('\n')
    const settings = argv[argv.indexOf('--settings') + 1]
    expect(argv).toEqual([
      '-p',
      '--resume',
      's1',
      '--fork-session',
      '--no-session-persistence',
      '--safe-mode',
      '--restricted',
      '--tools',
      'Read,Grep,Glob',
      '--strict-mcp-config',
      '--settings',
      settings,
      '--permission-mode',
      'dontAsk',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-budget-usd',
      '3',
    ])
    expect(readFileSync(path.join(home, 'claude-stdin.txt'), 'utf8')).toBe(PROMPT)
    expect(path.basename(readFileSync(path.join(home, 'claude-cwd.txt'), 'utf8').trim())).toBe(path.basename(cwd))
  })

  it("runs a claude found outside the host's PATH with its folder first on PATH, so its interpreter resolves", async () => {
    fakeClaude({ tools: ['Glob', 'Grep', 'Read'], mcp_servers: [] }, 'printf "%s" "$PATH" > "$HOME/claude-path.txt"')
    mkdirSync(path.join(home, '.local/bin'), { recursive: true })
    renameSync(path.join(home, 'bin/claude'), path.join(home, '.local/bin/claude'))
    expect(call({ mode: 'ask', session: 'fix', pane: '%1', sessionId: 's1', inquiryId: 'q-1', prompt: PROMPT, budget: 3 }, `${path.join(home, 'bin')}:/usr/bin:/bin`)).toEqual({ result: 'started' })
    await settled()
    expect(readFileSync(path.join(home, 'claude-path.txt'), 'utf8').split(':')[0]).toBe(path.join(home, '.local/bin'))
  })

  it('passes only sign-in and model settings, privately, and removes them and the job afterwards', async () => {
    fakeClaude({ tools: ['Glob', 'Grep', 'Read'], mcp_servers: [] }, 'cp "${12}" "$HOME/settings-copy.json"; ls -l "${12}" > "$HOME/settings-mode.txt"')
    ask()
    await settled()
    const argv = readFileSync(path.join(home, 'claude-argv.txt'), 'utf8').trim().split('\n')
    const file = argv[argv.indexOf('--settings') + 1]
    expect(readFileSync(path.join(home, 'settings-mode.txt'), 'utf8')).toMatch(/^-rw-------/)
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(path.join(home, '.cache/devbox/inquiries')).filter((f) => /job|settings|prompt/.test(f))).toEqual([])
    expect(JSON.parse(readFileSync(path.join(home, 'settings-copy.json'), 'utf8'))).toEqual({
      awsAuthRefresh: 'refresh-cmd',
      awsCredentialExport: 'export-cmd',
      model: 'opus',
      modelOverrides: { a: 'b' },
      env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-west-2', ANTHROPIC_DEFAULT_SONNET_MODEL: 'm' },
    })
  })

  it('reports the answer, its cost, the tools it had and the tools it used', async () => {
    fakeClaude({ tools: ['Glob', 'Grep', 'Read'], mcp_servers: [] })
    ask()
    expect(await settled()).toEqual({ state: 'replied', answer: 'Facts: at most 2 attempts.', cost: 1.02, tools: ['Glob', 'Grep', 'Read'], calls: ['Read'] })
  })

  it.each([
    ['a command tool', { tools: ['Bash', 'Read'], mcp_servers: [] }],
    ['an MCP server', { tools: ['Read'], mcp_servers: [{ name: 'x', status: 'connected' }] }],
  ])('stops a copy that reports %s before it can act', async (_label, init) => {
    fakeClaude(init)
    ask()
    expect(await settled()).toMatchObject({ state: 'failed', reason: 'not_read_only' })
    expect(existsSync(path.join(home, 'after-init.txt'))).toBe(false)
  })

  it.each([
    ['a pane of another session', { pane: '%2' }, 'gone'],
    ['a different conversation', { sessionId: 's-new' }, 'other_conversation'],
    ['an unsafe question id', { inquiryId: 'q-1/../../x' }, 'bad_id'],
  ])('refuses %s without starting anything', (_label, args, code) => {
    fakeClaude({ tools: ['Read'], mcp_servers: [] })
    expect(ask(args)).toEqual({ result: 'refused', code })
    expect(existsSync(path.join(home, 'claude-argv.txt'))).toBe(false)
  })

  it('removes question files older than a week when it starts a new one', async () => {
    fakeClaude({ tools: ['Glob', 'Grep', 'Read'], mcp_servers: [] })
    const old = path.join(home, '.cache/devbox/inquiries/q-old.jsonl')
    mkdirSync(path.dirname(old), { recursive: true })
    writeFileSync(old, '{}\n')
    const weekAgo = Date.now() / 1000 - 8 * 86400
    utimesSync(old, weekAgo, weekAgo)
    ask()
    await settled()
    expect(existsSync(old)).toBe(false)
  })

  it('keeps each question apart, and says when it knows nothing of one', async () => {
    fakeClaude({ tools: ['Glob', 'Grep', 'Read'], mcp_servers: [] })
    ask({ inquiryId: 'q-2' })
    await settled('q-2')
    expect(call({ mode: 'askpoll', ids: ['q-2', 'q-9'] })).toEqual({
      'q-2': expect.objectContaining({ state: 'replied' }),
      'q-9': { state: 'unknown' },
    })
  })
})
