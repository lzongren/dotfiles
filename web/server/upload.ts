import { probeScript } from './insights.js'

export const UPLOAD_COMMAND = ['python3', '-I', '-c', `'import sys,json;exec(json.loads(sys.stdin.buffer.readline()))'`]

const WRITER = `import json, os, sys


def place():
    stem, ext = os.path.splitext(ARGS["name"])
    for i in range(100):
        target = os.path.join(ARGS["dir"], ARGS["name"] if i == 0 else "%s (%d)%s" % (stem, i, ext))
        try:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            break
        except FileExistsError:
            continue
    else:
        return {"error": "too many files with that name"}
    left = ARGS["size"]
    try:
        with os.fdopen(fd, "wb") as out:
            while left > 0:
                chunk = sys.stdin.buffer.read(min(left, 65536))
                if not chunk:
                    break
                out.write(chunk)
                left -= len(chunk)
        if left:
            raise OSError(5, "upload cut short")
    except OSError as err:
        os.unlink(target)
        return {"error": err.strerror or str(err)}
    return {"path": target}


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
  const doc = JSON.parse(stdout) as { path?: unknown; error?: unknown }
  if (typeof doc.path === 'string') return { path: doc.path }
  return { error: typeof doc.error === 'string' ? doc.error : 'unexpected writer output' }
}
