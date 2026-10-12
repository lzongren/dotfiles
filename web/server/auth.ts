import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ServerResponse } from 'node:http'

export function mintToken(): string {
  return randomBytes(32).toString('hex')
}

export function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (!presented) return false
  const a = createHash('sha256').update(expected).digest()
  const b = createHash('sha256').update(presented).digest()
  return timingSafeEqual(a, b)
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header || !header.startsWith('Bearer ')) return undefined
  return header.slice('Bearer '.length)
}

export function hostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(hostHeader)
}

export function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)
}

export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
  )
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
}
