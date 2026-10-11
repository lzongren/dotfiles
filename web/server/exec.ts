import { execFile } from 'node:child_process'
import path from 'node:path'

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

function run(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      path.join(bin, 'devbox'),
      args,
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, exitCode: 0 })
        const code = (err as NodeJS.ErrnoException).code
        if (typeof code === 'number') return resolve({ stdout, stderr, exitCode: code })
        reject(err)
      },
    )
  })
}

export function statusRaw(bin: string): Promise<RunResult> {
  return run(bin, ['status', '--raw'])
}

export function printConfig(bin: string): Promise<RunResult> {
  return run(bin, ['web', '--print-config'])
}
