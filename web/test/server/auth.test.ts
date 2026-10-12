import { describe, expect, it } from 'vitest'
import {
  applySecurityHeaders,
  bearerToken,
  hostAllowed,
  mintToken,
  originAllowed,
  tokenMatches,
} from '../../server/auth.js'

describe('token', () => {
  it('mints 64-char hex tokens that differ per call', () => {
    const a = mintToken()
    const b = mintToken()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })

  it('accepts only the exact token, including equal-length wrong tokens', () => {
    const token = mintToken()
    expect(tokenMatches(token, token)).toBe(true)
    expect(tokenMatches(token, undefined)).toBe(false)
    expect(tokenMatches(token, '')).toBe(false)
    expect(tokenMatches(token, 'f'.repeat(64))).toBe(false)
    expect(tokenMatches(token, token.slice(0, 63))).toBe(false)
  })

  it('extracts bearer tokens strictly', () => {
    expect(bearerToken('Bearer abc')).toBe('abc')
    expect(bearerToken('bearer abc')).toBeUndefined()
    expect(bearerToken('abc')).toBeUndefined()
    expect(bearerToken(undefined)).toBeUndefined()
  })
})

describe('host allowlist', () => {
  it.each(['127.0.0.1:7733', 'localhost:7733', '[::1]:7733'])('allows %s', (host) => {
    expect(hostAllowed(host, 7733)).toBe(true)
  })

  it.each([undefined, '', 'evil.example:7733', '127.0.0.1:9999', '127.0.0.1', 'localhost'])(
    'rejects %j',
    (host) => {
      expect(hostAllowed(host, 7733)).toBe(false)
    },
  )
})

describe('origin check', () => {
  it('allows absent origins and the local origins only', () => {
    expect(originAllowed(undefined, 7733)).toBe(true)
    expect(originAllowed('http://127.0.0.1:7733', 7733)).toBe(true)
    expect(originAllowed('http://localhost:7733', 7733)).toBe(true)
    expect(originAllowed('http://evil.example', 7733)).toBe(false)
    expect(originAllowed('http://127.0.0.1:9999', 7733)).toBe(false)
  })
})

describe('security headers', () => {
  it('sets CSP, nosniff, and no-referrer', () => {
    const headers = new Map<string, string>()
    const res = { setHeader: (k: string, v: string) => headers.set(k, v) }
    applySecurityHeaders(res as never)
    expect(headers.get('Content-Security-Policy')).toContain("default-src 'self'")
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(headers.get('Referrer-Policy')).toBe('no-referrer')
  })
})
