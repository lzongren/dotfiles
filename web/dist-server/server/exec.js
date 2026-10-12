import { execFile } from 'node:child_process';
import path from 'node:path';
import { spawn as ptySpawn } from 'node-pty';
function run(bin, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        execFile(path.join(bin, 'devbox'), args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (!err)
                return resolve({ stdout, stderr, exitCode: 0 });
            const failure = err;
            if (typeof failure.code === 'number')
                return resolve({ stdout, stderr, exitCode: failure.code });
            if (failure.killed) {
                return resolve({ stdout, stderr: stderr || 'devbox timed out', exitCode: 124 });
            }
            reject(err);
        });
    });
}
export function statusRaw(bin, timeoutMs = 15000) {
    return run(bin, ['status', '--raw'], timeoutMs);
}
export function printConfig(bin, timeoutMs = 15000) {
    return run(bin, ['web', '--print-config'], timeoutMs);
}
export function attachArgv(host, name) {
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
    ];
}
export function spawnAttachPty(host, name, cols, rows) {
    const [file, ...args] = attachArgv(host, name);
    const env = { TERM: 'xterm-256color' };
    for (const key of ['HOME', 'USER', 'PATH', 'SSH_AUTH_SOCK']) {
        const value = process.env[key];
        if (value !== undefined)
            env[key] = value;
    }
    return ptySpawn(file, args, { name: 'xterm-256color', cols, rows, env });
}
