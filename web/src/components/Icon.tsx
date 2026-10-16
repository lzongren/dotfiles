import { useId, type ReactNode } from 'react'
import type { AgentInsight, Session } from '../shared/types'
import { heardAt, QUIET_AFTER } from '../insights'

export type Tone = 'waiting' | 'bell' | 'error' | 'working' | 'quiet' | 'fresh' | 'idle'

export function toneOf(session: Session, insight: AgentInsight | undefined, fresh: boolean, nowMs: number): Tone {
  if (insight?.state === 'waiting') return 'waiting'
  if (insight?.state === 'error') return 'error'
  if (insight?.state === 'working') return Math.floor(nowMs / 1000) - heardAt(session, insight) >= QUIET_AFTER ? 'quiet' : 'working'
  if (insight?.state === 'ready') return fresh ? 'fresh' : 'idle'
  return session.bell && fresh ? 'bell' : 'idle'
}

const GLYPHS: Record<Tone, ReactNode> = {
  waiting: (
    <path
      fillRule="evenodd"
      d="M8 1a7 7 0 0 0 0 14A7 7 0 0 0 8 1ZM7.1 3.6h1.8v5.6H7.1ZM8 10.5a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z"
      fill="currentColor"
    />
  ),
  bell: (
    <>
      <path d="M3.5 11.25V7.5a4.5 4.5 0 0 1 9 0v3.75l1.25 1.5H2.25Z" fill="currentColor" />
      <path d="M6.5 14.5h3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  error: (
    <path
      fillRule="evenodd"
      d="M8 1a7 7 0 0 0 0 14A7 7 0 0 0 8 1ZM5.17 6.23l1.06-1.06L8 6.94l1.77-1.77 1.06 1.06L9.06 8l1.77 1.77-1.06 1.06L8 9.06l-1.77 1.77-1.06-1.06L6.94 8Z"
      fill="currentColor"
    />
  ),
  working: <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  quiet: (
    <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="0.01 3.45" strokeLinecap="round" />
  ),
  fresh: null,
  idle: null,
}

export function Gradient({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" style={{ stopColor: 'var(--grad-a)' }} />
        <stop offset="0.5" style={{ stopColor: 'var(--grad-b)' }} />
        <stop offset="1" style={{ stopColor: 'var(--grad-c)' }} />
      </linearGradient>
    </defs>
  )
}

export function StateIcon({ tone }: { tone: Tone }) {
  const grad = useId()
  return (
    <svg className="state-icon" data-tone={tone} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      {tone === 'fresh' ? (
        <>
          <Gradient id={grad} />
          <circle cx="8" cy="8" r="4" fill={`url(#${grad}) currentColor`} />
        </>
      ) : (
        GLYPHS[tone]
      )}
    </svg>
  )
}

const PATHS = {
  search: ['M16.5 10.5a6 6 0 1 1-12 0 6 6 0 0 1 12 0z', 'M15 15l5 5'],
  terminal: ['M5.5 4.5h13A2.5 2.5 0 0 1 21 7v10a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17V7a2.5 2.5 0 0 1 2.5-2.5z', 'M7.5 9.5 10.5 12l-3 2.5', 'M13 15h3.5'],
  eye: ['M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z', 'M14.5 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z'],
  overview: ['M4 5.5A1.5 1.5 0 0 1 5.5 4h3A1.5 1.5 0 0 1 10 5.5v3A1.5 1.5 0 0 1 8.5 10h-3A1.5 1.5 0 0 1 4 8.5z', 'M14 5.5A1.5 1.5 0 0 1 15.5 4h3A1.5 1.5 0 0 1 20 5.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 14 8.5z', 'M4 15.5A1.5 1.5 0 0 1 5.5 14h3a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 8.5 20h-3A1.5 1.5 0 0 1 4 18.5z', 'M14 15.5a1.5 1.5 0 0 1 1.5-1.5h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3a1.5 1.5 0 0 1-1.5-1.5z'],
  x: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  next: ['M9.5 6l6 6-6 6'],
  previous: ['M14.5 6l-6 6 6 6'],
  theme: ['M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0z', 'M12 3.5v17', 'M12 8h5', 'M12 12h8', 'M12 16h5'],
  file: ['M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z', 'M13.5 3.5v5h5'],
  folder: ['M3.5 7A1.5 1.5 0 0 1 5 5.5h4.4l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z'],
  plus: ['M12 5v14', 'M5 12h14'],
  bell: ['M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14z', 'M10.5 21h3'],
  back: ['M19.5 12h-14', 'M11 6.5 5.5 12l5.5 5.5'],
  copy: ['M9 9.5A1.5 1.5 0 0 1 10.5 8h8A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 18.5z', 'M15.5 5.5V5A1.5 1.5 0 0 0 14 3.5H5.5A1.5 1.5 0 0 0 4 5v8.5A1.5 1.5 0 0 0 5.5 15H6'],
  link: ['M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1', 'M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1'],
  quote: ['M5 5.5v13', 'M9.5 7.5h10', 'M9.5 12h10', 'M9.5 16.5h6'],
  download: ['M12 4v11', 'M7.5 10.5 12 15l4.5-4.5', 'M5 19.5h14'],
  open: ['M14 4.5h5.5V10', 'M19.5 4.5l-8 8', 'M17.5 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4'],
  side: ['M5.5 4.5h13A2.5 2.5 0 0 1 21 7v10a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17V7a2.5 2.5 0 0 1 2.5-2.5z', 'M14 4.5v15'],
  pr: ['M6 8.5v7', 'M8.5 6a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z', 'M8.5 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z', 'M20.5 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z', 'M18 15.5V9a3 3 0 0 0-3-3h-3.5', 'M13.5 4l-2 2 2 2'],
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16 }: { name: IconName; size?: 14 | 16 }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
