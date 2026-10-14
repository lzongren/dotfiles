import { probeScript } from './insights.js'

export const UPLOAD_COMMAND = ['python3', '-I', '-c', `'import sys,json;exec(json.loads(sys.stdin.buffer.readline()))'`]

const WRITER = `import json, os, sys, tempfile


def numbered(stem, ext, i):
    suffix = " (%d)" % i
    while stem and len((stem + suffix + ext).encode()) > 255:
        stem = stem[:-1]
    return stem + suffix + ext


def place():
    fd, temp = tempfile.mkstemp(prefix=".upload-", suffix=".part", dir=ARGS["dir"])
    try:
        left = ARGS["size"]
        with os.fdopen(fd, "wb") as out:
            while left > 0:
                chunk = sys.stdin.buffer.read(min(left, 65536))
                if not chunk:
                    break
                out.write(chunk)
                left -= len(chunk)
        if left:
            return {"error": "upload cut short"}
        stem, ext = os.path.splitext(ARGS["name"])
        for i in range(100):
            target = os.path.join(ARGS["dir"], numbered(stem, ext, i) if i else ARGS["name"])
            try:
                os.link(temp, target)
                return {"path": target}
            except FileExistsError:
                continue
        return {"error": "too many files with that name"}
    finally:
        os.unlink(temp)


try:
    print(json.dumps(place()))
except OSError as err:
    print(json.dumps({"error": err.strerror or str(err)}))
`

export function uploadInput(dir: string, name: string, data: Buffer): Buffer[] {
  const script = probeScript(WRITER, { dir, name, size: data.length })
  return [Buffer.from(`${JSON.stringify(script)}\n`), data]
}

export function parseUpload(stdout: string): { path: string } | { error: string } {
  const doc = JSON.parse(stdout.trim().split('\n').pop() ?? '') as { path?: unknown; error?: unknown }
  if (typeof doc.path === 'string') return { path: doc.path }
  return { error: typeof doc.error === 'string' ? doc.error : 'unexpected writer output' }
}
