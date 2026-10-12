export function ago(nowMs: number, epochSeconds: number): string {
  const d = Math.max(0, Math.floor(nowMs / 1000) - epochSeconds)
  if (d < 60) return `${d}s`
  if (d < 3600) return `${Math.floor(d / 60)}m`
  if (d < 86400) return `${Math.floor(d / 3600)}h`
  return `${Math.floor(d / 86400)}d`
}
