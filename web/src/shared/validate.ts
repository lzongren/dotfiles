export const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9@.:_-]*$/

export function isValidSessionName(name: string): boolean {
  return SESSION_NAME_RE.test(name)
}

export function isValidHost(host: string): boolean {
  return HOST_RE.test(host)
}

export function clampInt(value: string | null, min: number, max: number, fallback: number): number {
  if (value === null || !/^[0-9]+$/.test(value)) return fallback
  return Math.min(max, Math.max(min, Number(value)))
}

