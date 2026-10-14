import { probeScript } from './insights.js'

export const UPLOAD_COMMAND = ['python3', '-I', '-c', `'import sys,json;exec(json.loads(sys.stdin.buffer.readline()))'`]

const WRITER = `import json, os, signal, sys


def stalled(*_):
    raise OSError(110, "upload stalled")


def numbered(stem, ext, i):
    suffix = " (%d)" % i
    while len((stem + suffix + ext).encode()) > 255:
        if len(stem) > 1:
            stem = stem[:-1]
        else:
            ext = ext[:-1]
    return stem + suffix + ext


def receive(size):
    signal.alarm(ARGS["stall"])
    try:
        return sys.stdin.buffer.read1(size)
    finally:
        signal.alarm(0)


def place():
    signal.signal(signal.SIGALRM, stalled)
    stem, ext = os.path.splitext(ARGS["name"])
    for i in range(100):
        target = os.path.join(ARGS["dir"], numbered(stem, ext, i) if i else ARGS["name"])
        try:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            break
        except FileExistsError:
            continue
    else:
        return {"error": "too many files with that name"}
    claimed = None
    try:
        claimed = os.fstat(fd)
        left = ARGS["size"]
        with os.fdopen(fd, "wb") as out:
            while left > 0:
                chunk = receive(min(left, 65536))
                if not chunk:
                    raise OSError(5, "upload cut short")
                out.write(chunk)
                left -= len(chunk)
    except BaseException:
        try:
            if claimed is None or os.path.samestat(claimed, os.lstat(target)):
                os.unlink(target)
        except OSError:
            pass
        raise
    return {"path": target}


try:
    print(json.dumps(place()))
except OSError as err:
    print(json.dumps({"error": err.strerror or str(err)}))
`

export function uploadInput(dir: string, name: string, data: Buffer, stall = 60): Buffer[] {
  const script = probeScript(WRITER, { dir, name, size: data.length, stall })
  return [Buffer.from(`${JSON.stringify(script)}\n`), data]
}

export function parseUpload(stdout: string): { path: string } | { error: string } {
  const line = stdout.trimEnd().split('\n').pop()!
  const doc = JSON.parse(line.slice(Math.max(0, line.lastIndexOf('{"path": '), line.lastIndexOf('{"error": ')))) as { path?: unknown; error?: unknown } | null
  if (typeof doc?.path === 'string') return { path: doc.path }
  return { error: typeof doc?.error === 'string' ? doc.error : 'unexpected writer output' }
}
