const KEY = 'devbox-web-token'

let memoryToken: string | null = null

export function initToken(): void {
  const match = /^#t=(.+)$/.exec(window.location.hash)
  if (match) {
    memoryToken = match[1]
    sessionStorage.setItem(KEY, memoryToken)
    history.replaceState(null, '', window.location.pathname + window.location.search)
  }
}

export function getToken(): string | null {
  return memoryToken ?? sessionStorage.getItem(KEY)
}
