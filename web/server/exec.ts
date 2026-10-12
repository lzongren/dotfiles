import { execFile } from 'node:child_process'
import path from 'node:path'

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      path.join(bin, 'devbox'),
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, exitCode: 0 })
        const failure = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
        if (typeof failure.code === 'number') return resolve({ stdout, stderr, exitCode: failure.code })
        if (failure.killed || failure.signal) {
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
