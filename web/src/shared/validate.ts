export const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export const UPLOAD_MAX = 50 * 1024 * 1024

export function isUploadName(name: string): boolean {
  return name !== '.' && name !== '..' && new TextEncoder().encode(name).length <= 255 && /^[^/\u0000-\u001f\u007f]+$/.test(name)
}

export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9@.:_-]*$/

export const AGENT_CHOICES = ['cc', 'codex', 'shell'] as const

export function isAgentChoice(value: unknown): value is (typeof AGENT_CHOICES)[number] {
  return typeof value === 'string' && (AGENT_CHOICES as readonly string[]).includes(value)
}

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

