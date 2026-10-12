import { execFile } from 'node:child_process'
import path from 'node:path'
import { spawn as ptySpawn, type IPty } from 'node-pty'
import type { AgentChoice } from '../src/shared/types.js'

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

function run(bin: string, args: string[], timeoutMs: number, cwd?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      path.join(bin, 'devbox'),
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        ...(cwd === undefined ? {} : { cwd, env: { ...process.env, PWD: cwd } }),
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, exitCode: 0 })
        const failure = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
        if (typeof failure.code === 'number') return resolve({ stdout, stderr, exitCode: failure.code })
        if (failure.killed) {
          return resolve({ stdout, stderr: stderr || 'devbox timed out', exitCode: 124 })
        }
        reject(err)
      },
    )
  })
}

export function statusRaw(bin: string, timeoutMs = 15000): Promise<RunResult> {
  return run(bin, ['status', '--raw'], timeoutMs)
}

export function printConfig(bin: string, timeoutMs = 15000): Promise<RunResult> {
  return run(bin, ['web', '--print-config'], timeoutMs)
}

export function detach(
  bin: string,
  agent: AgentChoice,
  name: string,
  cwd: string,
  timeoutMs = 30000,
): Promise<RunResult> {
  const args = agent === 'shell' ? ['--detach', name] : ['--detach', `--${agent}`, name]
  return run(bin, args, timeoutMs, cwd)
}

export function attachArgv(host: string, name: string): string[] {
  return [
    'ssh',
    '-t',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    '--',
    host,
    'env',
    'LANG=C.UTF-8',
    'tmux',
    'attach-session',
    '-t',
    `'=${name}'`,
  ]
}

export function spawnAttachPty(host: string, name: string, cols: number, rows: number): IPty {
  const [file, ...args] = attachArgv(host, name)
  const env: Record<string, string> = { TERM: 'xterm-256color' }
  for (const key of ['HOME', 'USER', 'PATH', 'SSH_AUTH_SOCK']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return ptySpawn(file, args, { name: 'xterm-256color', cols, rows, env })
}
