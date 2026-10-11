import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadToken() {
  return await import('../../src/token')
}

beforeEach(() => {
  vi.resetModules()
  sessionStorage.clear()
  history.replaceState(null, '', '/')
})

describe('initToken', () => {
  it('moves the fragment token into sessionStorage and strips the hash', async () => {
    window.location.hash = '#t=deadbeef01'
    const { initToken, getToken } = await loadToken()
    initToken()
    expect(sessionStorage.getItem('devbox-web-token')).toBe('deadbeef01')
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain('#')
    expect(getToken()).toBe('deadbeef01')
  })

  it('keeps the token in memory after sessionStorage is cleared', async () => {
    window.location.hash = '#t=deadbeef01'
    const { initToken, getToken } = await loadToken()
    initToken()
    sessionStorage.clear()
    expect(getToken()).toBe('deadbeef01')
  })

  it('ignores an absent fragment', async () => {
    const { initToken, getToken } = await loadToken()
    initToken()
    expect(getToken()).toBeNull()
    expect(sessionStorage.getItem('devbox-web-token')).toBeNull()
  })

  it('ignores an empty fragment token', async () => {
    window.location.hash = '#t='
    const { initToken, getToken } = await loadToken()
    initToken()
    expect(getToken()).toBeNull()
  })
})

describe('getToken', () => {
  it('falls back to sessionStorage when nothing was parsed this load', async () => {
    sessionStorage.setItem('devbox-web-token', 'cafe42')
    const { getToken } = await loadToken()
    expect(getToken()).toBe('cafe42')
  })
})
