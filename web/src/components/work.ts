import type { BriefResponse } from '../api'
import type { Tone } from './Icon'
import { isFresh, laneOf } from '../insights'
import type { AgentInsight, ReturnSummary, Session } from '../shared/types'

export type Attention = 'needs' | 'new' | 'waiting' | 'unsent' | 'accepted' | 'later'

export interface HomeItem {
  session: Session
  insight: AgentInsight
  attention: Attention
  tone: Tone
  status: string
  action: string
  also?: string[]
  sent?: string
  missed?: string[]
  looked?: number
  brief?: BriefResponse
  reading?: boolean
}

export const ATTENTION: Array<{ kind: Attention; title: string; count: (n: number) => string }> = [
  { kind: 'needs', title: 'Needs you', count: (n) => `${n} need${n === 1 ? 's' : ''} you` },
  { kind: 'new', title: 'New since you looked', count: (n) => `${n} new since you looked` },
  { kind: 'waiting', title: 'Waiting on the agent', count: (n) => `${n} waiting on the agent` },
  { kind: 'unsent', title: 'Not sent yet', count: (n) => `${n} not sent yet` },
  { kind: 'accepted', title: 'Accepted · merging is yours', count: (n) => `${n} accepted` },
  { kind: 'later', title: 'Later · on this browser', count: (n) => `${n} for later` },
]

const PENDING = new Set(['sending', 'delivered', 'working'])
const FOR_YOU = new Set(['unknown', 'held'])

const STEPS: Array<[(s: ReturnSummary) => boolean, string | ((s: ReturnSummary) => string), string | null]> = [
  [(s) => s.repair === 'replied', 'Repair replied, review it', 'Review the reply'],
  [(s) => s.repair === 'unknown', 'Delivery unknown', 'See the handoff receipt'],
  [(s) => s.repair === 'held', 'Repair waiting in the prompt', 'See the handoff receipt'],
  [(s) => s.answered > 0, 'Question answered', 'Read the answer'],
  [(s) => PENDING.has(s.repair ?? ''), 'Waiting on the agent', 'See the handoff receipt'],
  [(s) => s.asking > 0, 'Question running', 'See the question'],
  [(s) => s.draft, 'Draft not sent', 'Continue the unsent draft'],
  [(s) => Boolean(s.question), 'Question not sent', 'Finish the unsent question'],
  [(s) => Boolean(s.accepted), 'Result accepted · merge is still yours', 'See the accepted result'],
]
const stepOf = (s?: ReturnSummary) => (s ? STEPS.find(([when]) => when(s)) : undefined)

const noteOf = (step: (typeof STEPS)[number], s: ReturnSummary) => (typeof step[1] === 'function' ? step[1](s) : step[1])

export const returnNotes = (s?: ReturnSummary) => (s ? STEPS.filter(([when]) => when(s)).map((step) => noteOf(step, s)) : [])

export function returnNote(s?: ReturnSummary): string | null {
  const step = stepOf(s)
  return s && step ? noteOf(step, s) : null
}

const YOURS_FIRST = 3

function stateOf(insight: AgentInsight, summary: ReturnSummary | undefined, failed: boolean): Pick<HomeItem, 'status' | 'action' | 'also'> {
  const steps = summary ? STEPS.filter(([when]) => when(summary)) : []
  const waiting = insight.state === 'waiting' ? (insight.waitingFor ? insight.waitingFor[0].toUpperCase() + insight.waitingFor.slice(1) : 'Waiting on you') : null
  const ahead = steps.length > 0 && (STEPS.indexOf(steps[0]) < YOURS_FIRST || (!waiting && !failed))
  const notes = summary ? steps.map((step) => noteOf(step, summary)) : []
  const status = ahead ? notes[0] : (waiting ?? (insight.state === 'error' ? 'Error' : failed ? 'Check failed' : 'New turn'))
  const action = ahead ? (steps[0][2] ?? (failed ? 'Review the failed check' : 'See what changed')) : waiting ? 'Answer the question' : failed ? 'Review the failed check' : 'See what changed'
  const also = [...(waiting && status !== waiting ? [waiting] : []), ...notes.filter((n) => n !== status), ...(failed && status !== 'Check failed' ? ['Check failed'] : [])]
  return { status, action, also }
}

const insightStamp = (insight: AgentInsight) => [insight.turnAt, insight.summaryAt, insight.state, insight.waitingFor]

export const attentionStamp = (insight: AgentInsight, summary?: ReturnSummary) => JSON.stringify([...insightStamp(insight), summary?.activity, summary?.repair, Boolean(summary?.draft)])

export function homeItems(
  sessions: Session[],
  insights: Map<string, AgentInsight>,
  seenAt: (name: string) => number,
  now: number,
  returns: Record<string, ReturnSummary>,
  briefs: Record<string, BriefResponse>,
  deferred: Record<string, string> = {},
  summariesRead = true,
): HomeItem[] {
  const found: HomeItem[] = []
  const own = new Set<string>()
  for (const session of sessions) {
    const insight = insights.get(session.name)
    if (insight?.agent !== 'claude' || !session.attachable) continue
    const summary = returns[session.name]
    const seen = seenAt(session.name)
    const lane = laneOf(session, insight, seen, now)
    const fresh = isFresh(session, insight, seen)
    const brief = briefs[session.name]
    const mine = lane === 'blocked' || FOR_YOU.has(summary?.repair ?? '')
    const failing = brief?.brief.failing
    const failed = lane !== 'working' && !PENDING.has(summary?.repair ?? '') && Boolean(failing) && (brief?.brief.leftAt === undefined || (failing?.at ?? 0) > brief.brief.leftAt)
    const stamp = deferred[session.name]
    const attention: Attention | null = stamp !== undefined && (summariesRead ? stamp === attentionStamp(insight, summary) : stamp.startsWith(`${JSON.stringify(insightStamp(insight)).slice(0, -1)},`))
      ? 'later'
      : mine || failed
        ? 'needs'
        : summary?.answered || summary?.repair === 'replied'
          ? 'new'
          : PENDING.has(summary?.repair ?? '') || summary?.asking
            ? 'waiting'
            : fresh
              ? 'new'
            : summary?.draft || summary?.question
              ? 'unsent'
              : summary?.accepted
                ? 'accepted'
                : null
    if (!attention) continue
    if (lane === 'blocked' || attention === 'later') own.add(session.name)
    const state = stateOf(insight, summary, failed)
    const tone: Tone = attention === 'later' ? 'idle' : state.status === 'Check failed' || insight.state === 'error' ? 'error' : insight.state === 'waiting' ? 'waiting' : attention === 'needs' ? 'bell' : attention === 'waiting' ? 'working' : attention === 'accepted' ? 'idle' : 'fresh'
    found.push({ session, insight, attention, tone, ...state, ...(summary?.sent ? { sent: summary.sent } : {}), ...(summary?.missed ? { missed: summary.missed } : {}), ...(summary?.looked !== undefined ? { looked: summary.looked } : {}), ...(brief ? { brief } : {}) })
  }
  const order = (a: HomeItem, b: HomeItem) =>
    ATTENTION.findIndex((x) => x.kind === a.attention) - ATTENTION.findIndex((x) => x.kind === b.attention) || b.session.activityEpoch - a.session.activityEpoch
  const covered = new Set<string>()
  return found.sort(order).filter((item) => {
    if (covered.has(item.session.name) && !own.has(item.session.name) && !returnNote(returns[item.session.name])) return false
    for (const m of item.brief?.work.members ?? []) covered.add(m.name)
    return true
  })
}
