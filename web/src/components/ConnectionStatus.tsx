import type { ReactNode } from 'react'
import { ago } from '../time'

export type Cause = 'remote' | 'local' | 'probe' | 'auth'

export interface Failure {
  cause: Cause
  message: string
  since: number
}

export interface Feed {
  okAt: number | null
  failure: Failure | null
  pendingSince: number | null
  nextAt: number | null
}

export const SLOW_MS = 3000
export const WAIT_MS = 10_000
export const RECOVERED_MS = 6000
export const INSIGHTS_STALE_MS = 60_000

const HINTS: Record<Cause, ReactNode> = {
  remote: (
    <>
      Often a VPN or proxy blip that clears by itself. If it lasts, check your VPN or proxy sign-in, then run <code>devbox doctor</code> in a
      terminal.
    </>
  ),
  local: (
    <>
      Run <code>devbox web</code> in a terminal to start it again; it opens a fresh tab.
    </>
  ),
  probe: (
    <>
      Run <code>devbox status</code> in a terminal to see the whole error.
    </>
  ),
  auth: (
    <>
      The dashboard server restarted with a new link. Run <code>devbox web</code> for a fresh tab, or paste the link from{' '}
      <code>devbox web url</code> into this one.
    </>
  ),
}

function titleOf(cause: Cause, host: string): string {
  if (cause === 'remote') return `Can't reach ${host || 'your dev host'}`
  if (cause === 'local') return "The dashboard server isn't answering"
  if (cause === 'probe') return "Couldn't read the session list"
  return "This tab's link has expired"
}

const age = (now: number, at: number) => ago(now, Math.floor(at / 1000))
const secs = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`

function nextTry(feed: Feed, now: number): string {
  if (feed.pendingSince !== null) {
    const waited = now - feed.pendingSince
    return waited >= SLOW_MS ? `Trying again, no answer for ${secs(waited)}…` : 'Trying again…'
  }
  if (feed.nextAt === null) return 'Not retrying on its own.'
  const left = feed.nextAt - now
  return left > 500 ? `Retrying in ${Math.ceil(left / 1000)}s.` : 'Trying again…'
}

interface Notice {
  tone: 'warn' | 'info' | 'ok'
  title: string
  state?: string
  next?: string
  hint?: ReactNode
  detail?: string
  retry?: string
  live: string
}

function noticeOf(sessions: Feed, insights: Feed, agentStates: boolean, host: string, now: number, recoveredAt: number | null): Notice | null {
  const failure = sessions.failure
  if (failure) {
    const title = titleOf(failure.cause, host)
    const failingFor = now - failure.since >= 10_000 ? ` Failing for ${age(now, failure.since)}.` : ''
    return {
      tone: 'warn',
      title,
      state: sessions.okAt === null ? 'No sessions loaded yet.' : `Showing sessions as of ${age(now, sessions.okAt)} ago.`,
      next: `${nextTry(sessions, now)}${failingFor}`,
      hint: HINTS[failure.cause],
      detail: failure.cause === 'remote' || failure.cause === 'probe' ? failure.message : undefined,
      retry: sessions.pendingSince !== null ? undefined : failure.cause === 'auth' ? 'Check again' : 'Retry now',
      live: `${title}.`,
    }
  }
  const waited = sessions.pendingSince === null ? 0 : now - sessions.pendingSince
  if (sessions.okAt === null && waited >= SLOW_MS) {
    return {
      tone: 'info',
      title: `Waiting on ${host || 'your dev host'}`,
      state: `No answer yet (${secs(waited)}). ssh through a VPN or proxy can be slow; the dashboard keeps trying.`,
      live: '',
    }
  }
  if (sessions.okAt !== null && waited >= WAIT_MS) {
    return {
      tone: 'info',
      title: `Waiting on ${host || 'your dev host'}`,
      state: `Showing sessions as of ${age(now, sessions.okAt)} ago; the refresh has had no answer for ${secs(waited)}.`,
      live: '',
    }
  }
  if (sessions.okAt === null) return { tone: 'info', title: 'Loading sessions…', live: '' }
  if (insights.failure) {
    const shown = agentStates && insights.okAt !== null
    const title = shown ? `Agent details as of ${age(now, insights.okAt ?? now)} ago` : 'Agent details unavailable'
    return {
      tone: 'warn',
      title,
      state: shown ? 'The last update failed.' : 'Tiles show sessions without agent states, so Needs you and Working may be missing some.',
      next: nextTry(insights, now),
      hint: insights.failure.cause === 'remote' ? 'If it lasts, check your VPN or proxy sign-in.' : undefined,
      detail: insights.failure.message,
      retry: insights.pendingSince !== null ? undefined : 'Retry now',
      live: shown ? 'Agent details are out of date.' : 'Agent details unavailable.',
    }
  }
  if (insights.okAt === null && insights.pendingSince !== null && now - insights.pendingSince >= SLOW_MS) {
    return { tone: 'info', title: 'Loading agent details…', state: 'Tiles show sessions only until they arrive.', live: '' }
  }
  if (recoveredAt !== null && now - recoveredAt < RECOVERED_MS) {
    const title = `Back in touch with ${host || 'your dev host'}.`
    return { tone: 'ok', title, state: 'Everything shown is current.', live: title }
  }
  return null
}

export function ConnectionStatus({
  sessions,
  insights,
  agentStates,
  host,
  now,
  recoveredAt,
  page = false,
  onRetry,
}: {
  sessions: Feed
  insights: Feed
  agentStates: boolean
  host: string
  now: number
  recoveredAt: number | null
  page?: boolean
  onRetry: () => void
}) {
  const notice = noticeOf(sessions, insights, agentStates, host, now, recoveredAt)
  const Title = page ? 'h2' : 'strong'
  return (
    <div className={page ? 'conn-slot conn-slot-page' : 'conn-slot'}>
      {notice ? (
        <section className={`conn conn-${notice.tone}`} aria-label="connection status" tabIndex={0}>
          <div className="conn-main">
            <Title className="conn-title">{notice.title}</Title>
            {notice.state ? <span className="conn-state">{notice.state}</span> : null}
            {notice.next ? <span className="conn-next">{notice.next}</span> : null}
            {notice.retry ? (
              <button type="button" className="conn-retry" onClick={onRetry}>
                {notice.retry}
              </button>
            ) : null}
          </div>
          {notice.hint || notice.detail ? (
            <p className="conn-hint">
              {notice.hint}
              {notice.detail ? <span className="conn-detail"> Last error: {notice.detail}</span> : null}
            </p>
          ) : null}
        </section>
      ) : null}
      <p className="visually-hidden" role="status">
        {notice?.live ?? ''}
      </p>
    </div>
  )
}
