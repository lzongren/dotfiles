import type { IncomingMessage } from 'node:http'

export class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const type = req.headers['content-type'] ?? ''
  if (!/^application\/json(\s*;|$)/i.test(type)) {
    return Promise.reject(new BodyError(415, 'expected application/json'))
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > limit) {
        tooLarge = true
        chunks.length = 0
        reject(new BodyError(413, 'request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new BodyError(400, 'invalid JSON'))
      }
    })
    req.on('error', () => reject(new BodyError(400, 'request aborted')))
  })
}
