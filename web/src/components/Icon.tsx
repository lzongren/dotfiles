import type { ReactNode } from 'react'
import type { AgentInsight, Session } from '../shared/types'

export type Tone = 'waiting' | 'error' | 'working' | 'fresh' | 'idle'

export function toneOf(session: Session, insight: AgentInsight | undefined, fresh: boolean): Tone {
  if (insight?.state === 'waiting') return 'waiting'
  if (insight?.state === 'error') return 'error'
  if (insight?.state === 'working') return 'working'
  if (insight?.state === 'ready') return fresh ? 'fresh' : 'idle'
  return session.bell ? 'waiting' : 'idle'
}

const GLYPHS: Record<Tone, ReactNode> = {
  waiting: <path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" fill="currentColor" />,
  error: <path d="M8 2.5 14 13H2Z" fill="currentColor" />,
  working: (
    <>
      <circle cx="8" cy="8" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 3.25a4.75 4.75 0 0 1 0 9.5Z" fill="currentColor" />
    </>
  ),
  fresh: <circle cx="8" cy="8" r="4.5" fill="currentColor" />,
  idle: <circle cx="8" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />,
}

export function StateIcon({ tone }: { tone: Tone }) {
  return (
    <svg className="state-icon" data-tone={tone} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      {GLYPHS[tone]}
    </svg>
  )
}

const PATHS = {
  search: ['M16.5 10.5a6 6 0 1 1-12 0 6 6 0 0 1 12 0z', 'M15 15l5 5'],
  terminal: ['M5.5 4.5h13A2.5 2.5 0 0 1 21 7v10a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17V7a2.5 2.5 0 0 1 2.5-2.5z', 'M7.5 9.5 10.5 12l-3 2.5', 'M13 15h3.5'],
  eye: ['M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z', 'M14.5 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z'],
  overview: ['M4 5.5A1.5 1.5 0 0 1 5.5 4h3A1.5 1.5 0 0 1 10 5.5v3A1.5 1.5 0 0 1 8.5 10h-3A1.5 1.5 0 0 1 4 8.5z', 'M14 5.5A1.5 1.5 0 0 1 15.5 4h3A1.5 1.5 0 0 1 20 5.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 14 8.5z', 'M4 15.5A1.5 1.5 0 0 1 5.5 14h3a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 8.5 20h-3A1.5 1.5 0 0 1 4 18.5z', 'M14 15.5a1.5 1.5 0 0 1 1.5-1.5h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3a1.5 1.5 0 0 1-1.5-1.5z'],
  x: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  next: ['M9.5 6l6 6-6 6'],
  previous: ['M14.5 6l-6 6 6 6'],
  theme: ['M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0z', 'M12 3.5v17', 'M12 8h5', 'M12 12h8', 'M12 16h5'],
  file: ['M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z', 'M13.5 3.5v5h5'],
  folder: ['M3.5 7A1.5 1.5 0 0 1 5 5.5h4.4l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z'],
  plus: ['M12 5v14', 'M5 12h14'],
  bell: ['M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14z', 'M10.5 21h3'],
  pr: ['M6 8.5v7', 'M8.5 6a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z', 'M8.5 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z', 'M20.5 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z', 'M18 15.5V9a3 3 0 0 0-3-3h-3.5', 'M13.5 4l-2 2 2 2'],
} as const

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS; size?: 14 | 16 }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
