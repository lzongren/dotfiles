import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const probe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../probe/agent-probe.py')
const PROMPT_EMPTY = '╭────╮\n│ ❯  │\n╰────╯\n  ⏵⏵ auto mode on\n'
const PACKET = '[devbox repair r-1]\nPurpose: repair.\n\nRetry at most 1 attempt.'

let home: string

function write(rel: string, content: string) {
  const file = path.join(home, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

function panes(rows: Array<[string, string, string]>) {
  write('panes.txt', rows.map((r) => r.join('\t')).join('\n') + '\n')
}

function registry(rec: Record<string, unknown>) {
  write('.claude/sessions/1.json', JSON.stringify({ pid: process.pid, sessionId: 's1', cwd: '/work/fix', status: 'idle', tmux: 'fix:@1.%1', ...rec }))
}

function send(args: Record<string, unknown> = {}) {
  const all = { mode: 'send', session: 'fix', pane: '%1', sessionId: 's1', requestId: 'r-1', packet: PACKET, ...args }
  const script = `ARGS = __import__("json").loads(${JSON.stringify(JSON.stringify(all))})\n${readFileSync(probe, 'utf8')}`
  const out = execFileSync('python3', ['-I', '-'], { input: script, env: { HOME: home, PATH: `${path.join(home, 'bin')}:${process.env.PATH}` } })
  return JSON.parse(out.toString()) as { result: string; code?: string }
}

const calls = () => (existsSync(path.join(home, 'tmux.log')) ? readFileSync(path.join(home, 'tmux.log'), 'utf8').trim().split('\n') : [])
const writes = () => calls().filter((c) => /^(load-buffer|paste-buffer|send-keys|set-buffer)/.test(c))

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'return-send-'))
  write(
    'bin/tmux',
    [
      '#!/bin/sh',
      'echo "$*" >> "$HOME/tmux.log"',
      'case "$1" in',
      '  display)',
      '    row=$(grep "^$4	" "$HOME/panes.txt") || exit 1',
      '    printf "%s\\n" "$row" | cut -f2,3 ;;',
      '  capture-pane) cat "$HOME/screen.txt" ;;',
      '  load-buffer) cat > "$HOME/buffer-$3" ;;',
      '  paste-buffer) cat "$HOME/after-paste.txt" > "$HOME/screen.txt" 2>/dev/null || printf "│ ❯ [Pasted text #1 +3 lines] │\\n" > "$HOME/screen.txt"; [ ! -f "$HOME/busy-after-paste" ] || sed -i.bak s/idle/busy/ "$HOME/.claude/sessions/1.json" ;;',
      'esac',
    ].join('\n'),
  )
  chmodSync(path.join(home, 'bin/tmux'), 0o755)
  panes([
    ['%1', 'fix', 'claude'],
    ['%2', 'other', 'claude'],
    ['%3', 'fix', 'zsh'],
  ])
  write('screen.txt', PROMPT_EMPTY)
  registry({})
  write('.claude/projects/-work-fix/s1.jsonl', `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'hi' } })}\n`)
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('sending a repair on the host', () => {
  it('pastes the packet as one bracketed paste into the exact pane, then presses Enter', () => {
    expect(send()).toEqual({ result: 'pasted' })
    expect(writes()).toEqual(['load-buffer -b devbox-r-1 -', 'paste-buffer -p -d -b devbox-r-1 -t %1', 'send-keys -t %1 Enter'])
    expect(readFileSync(path.join(home, 'buffer-devbox-r-1'), 'utf8')).toBe(PACKET)
  })

  it.each([
    ['an empty target', { pane: '' }, 'bad_target'],
    ['a session name instead of a pane id', { pane: 'fix' }, 'bad_target'],
    ['a pane id with extra text', { pane: '%1 ; rm' }, 'bad_target'],
    ['a pane that no longer exists', { pane: '%9' }, 'gone'],
    ['a pane of another session', { pane: '%2' }, 'other_session'],
    ['a pane where the agent is not in front', { pane: '%3' }, 'not_agent'],
    ['a different conversation in the pane', { sessionId: 's-new' }, 'other_conversation'],
  ])('refuses %s without writing to tmux', (_label, args, code) => {
    expect(send(args)).toEqual({ result: 'refused', code })
    expect(writes()).toEqual([])
  })

  it('refuses while the agent is working or waiting on you', () => {
    registry({ status: 'busy' })
    expect(send()).toEqual({ result: 'refused', code: 'busy' })
    registry({ status: 'waiting', waitingFor: 'permission prompt' })
    expect(send()).toEqual({ result: 'refused', code: 'waiting' })
    rmSync(path.join(home, '.claude/sessions/1.json'))
    expect(send()).toEqual({ result: 'refused', code: 'no_registry' })
    expect(writes()).toEqual([])
  })

  it('refuses when your prompt already holds text, or the prompt is not visible', () => {
    write('screen.txt', '│ ❯ half a thought │\n')
    expect(send()).toEqual({ result: 'refused', code: 'typed' })
    write('screen.txt', ' Quick safety check: trust this folder?\n')
    expect(send()).toEqual({ result: 'refused', code: 'no_prompt' })
    expect(writes()).toEqual([])
  })

  it('reports an already delivered request instead of pasting it again, even while the agent works on it', () => {
    appendFileSync(
      path.join(home, '.claude/projects/-work-fix/s1.jsonl'),
      `${JSON.stringify({ type: 'user', uuid: 'u2', message: { content: PACKET } })}\n`,
    )
    registry({ status: 'busy' })
    expect(send()).toEqual({ result: 'already' })
    expect(writes()).toEqual([])
  })

  it('pastes but does not submit when your prompt changed during the paste', () => {
    write('after-paste.txt', '│ ❯ rm -rf build[Pasted text #1 +3 lines] │\n')
    expect(send()).toEqual({ result: 'held', code: 'prompt_changed' })
    expect(writes()).toEqual(['load-buffer -b devbox-r-1 -', 'paste-buffer -p -d -b devbox-r-1 -t %1'])
  })

  it('pastes but does not submit when the agent started working during the paste', () => {
    write('busy-after-paste', '')
    expect(send()).toEqual({ result: 'held', code: 'agent_changed' })
    expect(writes().at(-1)).toBe('paste-buffer -p -d -b devbox-r-1 -t %1')
  })

  it('makes a safe buffer name from any request id', () => {
    expect(send({ requestId: 'r-1; kill' })).toEqual({ result: 'pasted' })
    expect(writes()[0]).toBe('load-buffer -b devbox-r-1kill -')
  })
})
