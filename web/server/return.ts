import {
  actedAt,
  draftChecks,
  basisOf,
  briefOf,
  constraints,
  differences,
  digest,
  entriesOf,
  groupWork,
  leftOf,
  VISIT_GAP,
  questionPrompt,
  LOST,
  packetOf,
  PREVIEW_ID,
  workOf,
  type Work,
  leadAsk,
  replyGaps,
  newestFailure,
  pruned,
  latestOf,
  mayHaveLanded,
  newerThan,
  retryBlock,
  conversationOf,
  sentWith,
  shownAs,
  checkName,
} from '../src/shared/recover.js'
import type { DraftState, Inquiry, Lookalike, ProbeRecord, ProbeSession, Repair, ReturnResponse, ReturnSummary, WorkState } from '../src/shared/types.js'
import type { RunResult } from './exec.js'
import { emptyWork, type ReturnStore } from './return-store.js'
import { RemoteUnreachableError } from './sessions.js'

export interface ReturnDeps {
  host: string
  store: ReturnStore
  now: () => number
  probe: (args: Record<string, unknown>) => Promise<RunResult>
  prs: () => Promise<Record<string, string[]>>
  later?: (run: () => void, ms: number) => void
}

export interface Reply {
  status: number
  body: Record<string, unknown>
}

const KINDS = new Set<ProbeRecord['kind']>(['decision', 'agent', 'failure', 'shell', 'devbox'])
const SEPARATIONS = 'separations'
const LIVE = new Set<Repair['state']>(['sending', 'delivered', 'working', 'replied'])
const HELD_ON_RETRY = new Set(['typed', 'busy', 'waiting', 'no_registry', 'no_prompt'])
const READ = Symbol('read')
const OPEN = new Set<Repair['state']>(['sending', 'delivered', 'working', 'held', 'unknown'])
const REQUEST_RE = /^r-[A-Za-z0-9-]{1,40}$/
const INQUIRY_RE = /^q-[A-Za-z0-9-]{1,40}$/
const DELIVERY_WAIT = 30
const ANSWER_WAIT = 180
const FOLLOW_MS = 15_000
const ANSWER_GIVE_UP = 900
const ASK_BUDGET_USD = 3
const QUESTION_MAX = 4000
const ASKING = new Set<Inquiry['state']>(['sending', 'running', 'unknown'])

const workKey = (session: string) => `session:${session}`
const isStr = (v: unknown): v is string => typeof v === 'string'
type Seen = { preview: string; version: string }
const isSeen = (v: { preview?: unknown; version?: unknown }): v is Seen => isStr(v.preview) && isStr(v.version)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function record(raw: unknown): ProbeRecord | null {
  const r = (raw ?? {}) as Record<string, unknown>
  if (!isStr(r.id) || !isStr(r.text) || !KINDS.has(r.kind as ProbeRecord['kind'])) return null
  return {
    id: r.id,
    kind: r.kind as ProbeRecord['kind'],
    at: isNum(r.at) ? r.at : 0,
    text: r.text,
    ...(isNum(r.turn) ? { turn: r.turn } : {}),
    ...(typeof r.final === 'boolean' ? { final: r.final } : {}),
  }
}

export function parseReturn(stdout: string): { sessions: ProbeSession[]; lookalikes: Lookalike[] } {
  const doc = JSON.parse(stdout) as { sessions?: unknown; lookalikes?: unknown }
  if (!Array.isArray(doc.sessions)) throw new Error('return probe gave no sessions')
  const sessions = doc.sessions.flatMap((raw): ProbeSession[] => {
    const s = (raw ?? {}) as Record<string, unknown>
    if (!isStr(s.name) || !isStr(s.pane) || !Array.isArray(s.records)) return []
    const reg = s.registry as Record<string, unknown> | undefined
    const tr = s.transcript as Record<string, unknown> | undefined
    return [
      {
        name: s.name,
        pane: s.pane,
        cmd: isStr(s.cmd) ? s.cmd : '',
        agent: s.agent === 'claude' || s.agent === 'codex' ? s.agent : 'shell',
        path: isStr(s.path) ? s.path : '',
        ...(isStr(s.repo) ? { repo: s.repo } : {}),
        ...(isStr(s.branch) ? { branch: s.branch } : {}),
        ...(reg && isStr(reg.sessionId)
          ? { registry: { sessionId: reg.sessionId, status: isStr(reg.status) ? reg.status : 'unknown', ...(isStr(reg.waitingFor) ? { waitingFor: reg.waitingFor } : {}), ...(isNum(reg.since) ? { since: reg.since } : {}) } }
          : {}),
        ...(tr && isNum(tr.ino) && isNum(tr.size) ? { transcript: { ino: tr.ino, size: tr.size, last: isStr(tr.last) ? tr.last : '', ...(isStr(tr.sid) ? { sid: tr.sid } : {}) } } : {}),
        records: s.records.map(record).filter((r): r is ProbeRecord => r !== null),
        ...(Array.isArray(s.turnEnds) ? { turnEnds: s.turnEnds.filter(isNum) } : {}),
        partial: s.partial === true,
        ...(s.closes === true ? { closes: true } : {}),
      },
    ]
  })
  const lookalikes = (Array.isArray(doc.lookalikes) ? doc.lookalikes : []).flatMap((raw): Lookalike[] => {
    const x = (raw ?? {}) as Record<string, unknown>
    if (!isStr(x.name) || !isStr(x.path) || (x.why !== 'branch' && x.why !== 'folder')) return []
    return [{ name: x.name, path: x.path, ...(isStr(x.repo) ? { repo: x.repo } : {}), ...(isStr(x.branch) ? { branch: x.branch } : {}), why: x.why }]
  })
  return { sessions, lookalikes }
}

export const RETURN_CAPS: Record<string, number> = { decision: 200, agent: 60, failure: 30, devbox: 40 }

function capped(records: ProbeRecord[], dropped: Record<string, number> = {}): { records: ProbeRecord[]; dropped: Record<string, number> } {
  const counts: Record<string, number> = {}
  const out = { ...dropped }
  const kept = records
    .reduceRight<ProbeRecord[]>((acc, r) => {
      counts[r.kind] = (counts[r.kind] ?? 0) + 1
      if (counts[r.kind] > (RETURN_CAPS[r.kind] ?? 100)) out[r.kind] = (out[r.kind] ?? 0) + 1
      else acc.push(r)
      return acc
    }, [])
    .reverse()
  return { records: kept, dropped: out }
}

export function mergeSession(before: ProbeSession | undefined, next: ProbeSession): ProbeSession {
  if (!before || !next.partial) return next
  const lastTurn = Math.max(0, ...before.records.map((r) => r.turn ?? 0))
  const added = next.records.map((r) => (r.turn === undefined ? r : { ...r, turn: r.turn + lastTurn }))
  const superseded = new Set(added.filter((r) => r.kind === 'agent').map((r) => r.turn))
  const open = next.closes ? before.records.findLast((r) => r.kind === 'agent' && r.turn === lastTurn) : undefined
  const kept = before.records
    .filter((r) => !(r.kind === 'agent' && !r.final && superseded.has(r.turn)))
    .map((r) => (r === open ? { ...r, final: true } : r))
  const merged = capped([...kept, ...added], { ...before.dropped, ...Object.fromEntries(Object.entries(next.dropped ?? {}).map(([k, n]) => [k, n + (before.dropped?.[k] ?? 0)])) })
  return {
    ...next,
    records: merged.records,
    ...(Object.keys(merged.dropped).length ? { dropped: merged.dropped } : {}),
    turnEnds: [...(before.turnEnds ?? []), ...(next.turnEnds ?? [])].slice(-200),
    partial: false,
    closes: undefined,
  }
}

export function advanceRepair(r: Repair, s: ProbeSession | undefined, now: number): Repair {
  if (r.state === 'replied' || !s) return r
  const marker = `[devbox repair ${r.id}]`
  const delivered = s.records.find((x) => (x.kind === 'devbox' || x.kind === 'decision') && x.text.includes(marker))
  if (!delivered) {
    if (r.state !== 'sending' || now - r.sentAt <= DELIVERY_WAIT) return r
    return { ...r, state: 'unknown', ...(s.registry?.sessionId === r.target.sessionId ? {} : { reason: 'not_visible' }) }
  }
  const after = s.records.filter((x) => x.kind === 'agent' && x.turn === delivered.turn && x.at >= delivered.at)
  const reply = after.find((x) => x.final)
  if (reply) return { ...r, checked: undefined, state: 'replied', deliveredId: delivered.id, replyId: reply.id, reply: reply.text, repliedAt: reply.at }
  const working = (s.registry?.sessionId === r.target.sessionId && s.registry.status === 'busy') || after.length > 0
  return { ...r, checked: undefined, state: working ? 'working' : 'delivered', deliveredId: delivered.id }
}

export function createReturnService(deps: ReturnDeps) {
  const cache = new Map<string, ProbeSession>()
  const queues = new Map<string | symbol, Promise<unknown>>()

  function serial<T>(key: string | symbol, run: () => Promise<T>): Promise<T> {
    const next = (queues.get(key) ?? Promise.resolve()).then(run, run)
    const tail = next.then(
      () => undefined,
      () => undefined,
    )
    queues.set(key, tail)
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key)
    })
    return next
  }

  async function fetch(target: string): Promise<{ sessions: ProbeSession[]; work: Work; lookalikes: Lookalike[] } | { error: string }> {
    const prs = await deps.prs().catch(() => ({}) as Record<string, string[]>)
    const mine = await deps.store.read(workKey(target))
    const open = latestOf(mine.repairs, (r) => r.draftVersion === mine.draftVersion && OPEN.has(r.state))
    const want = open?.target ?? mine.draft?.target
    const { merged, lookalikes } = await serial(READ, async () => {
      const from = Object.fromEntries([...cache].flatMap(([name, s]) => (s.transcript ? [[name, s.transcript]] : [])))
      const res = await deps.probe({ mode: 'return', target, prs, from, caps: RETURN_CAPS, ...(want ? { prefer: want.sessionId, preferPane: want.pane } : {}) })
      if (res.exitCode === 255) throw new RemoteUnreachableError(res.stderr.trim().split('\n').pop() || 'remote unreachable')
      if (res.exitCode !== 0) throw new Error(res.stderr.trim() || 'return probe failed')
      const parsed = parseReturn(res.stdout)
      const sessions = parsed.sessions.map((s) => {
        const m = mergeSession(cache.get(s.name), s)
        cache.set(s.name, m)
        return m
      })
      return { merged: sessions, lookalikes: parsed.lookalikes }
    })
    if (!merged.some((s) => s.name === target)) return { error: 'unknown_session' }
    const { separations } = await deps.store.read(SEPARATIONS)
    const works = groupWork(
      merged.map((s) => ({ name: s.name, agent: s.agent, path: s.path, prs: prs[s.name] ?? [], ...(s.repo ? { repo: s.repo } : {}), ...(s.branch ? { branch: s.branch } : {}) })),
      separations,
    )
    const work = workOf(target, works) ?? { key: workKey(target), members: [{ name: target, reason: 'only session in this work' }] }
    return { work, sessions: merged.filter((s) => work.members.some((m) => m.name === s.name)), lookalikes }
  }

  async function advance(session: string, sessions: ProbeSession[]): Promise<WorkState> {
    const state = await deps.store.read(workKey(session))
    const target = sessions.find((s) => s.name === session)
    const repairs = state.repairs.map((r) => advanceRepair(r, target, deps.now()))
    if (repairs.every((r, i) => r === state.repairs[i])) return state
    return deps.store.update(workKey(session), (w) => ({ ...w, repairs: w.repairs.map((r) => advanceRepair(r, target, deps.now())) }))
  }

  async function poll(session: string, state: WorkState): Promise<WorkState> {
    const asking = state.inquiries.filter((q) => ASKING.has(q.state))
    if (asking.length === 0) return state
    const res = await deps.probe({ mode: 'askpoll', ids: asking.map((q) => q.id) })
    let found: Record<string, Record<string, unknown>> = {}
    try {
      found = res.exitCode === 0 ? (JSON.parse(res.stdout) as typeof found) : {}
    } catch {
      found = {}
    }
    const now = deps.now()
    const next = (q: Inquiry): Inquiry => {
      if (!ASKING.has(q.state)) return q
      const f = found[q.id] ?? {}
      if (f.state === 'replied') {
        return {
          ...q,
          state: 'replied',
          answer: typeof f.answer === 'string' ? f.answer : '',
          ...(typeof f.cost === 'number' ? { cost: f.cost } : {}),
          tools: Array.isArray(f.tools) ? f.tools.filter((t): t is string => typeof t === 'string') : [],
          calls: Array.isArray(f.calls) ? f.calls.filter((t): t is string => typeof t === 'string') : [],
          repliedAt: now,
        }
      }
      if (f.state === 'failed') return { ...q, state: 'failed', reason: typeof f.reason === 'string' ? f.reason : 'failed' }
      if (f.state === 'unknown' && now - q.askedAt > ANSWER_GIVE_UP) return { ...q, state: 'failed', reason: 'no_answer' }
      return now - q.askedAt > ANSWER_WAIT && q.state !== 'unknown' ? { ...q, state: 'unknown' } : q
    }
    if (state.inquiries.every((q) => next(q) === q)) return state
    return deps.store.update(workKey(session), (w) => ({ ...w, inquiries: w.inquiries.map(next) }))
  }

  const following = new Set<string>()
  const later = deps.later ?? ((run: () => void, ms: number) => void setTimeout(run, ms).unref())
  function follow(session: string) {
    if (following.has(session)) return
    following.add(session)
    later(() => {
      void serial(session, () => deps.store.read(workKey(session)).then((w) => poll(session, w)))
        .catch(() => undefined)
        .finally(() => following.delete(session))
    }, FOLLOW_MS)
  }

  async function load(session: string): Promise<ReturnResponse | { error: string }> {
    const fetched = await fetch(session)
    if ('error' in fetched) return fetched
    const state = await poll(session, await advance(session, fetched.sessions))
    const { separations } = await deps.store.read(SEPARATIONS)
    const separated = separations.filter((x) => x.work === fetched.work.key)
    const from = separations.find((x) => x.session === session && x.work !== fetched.work.key)
    const members = await Promise.all(fetched.work.members.map(async (m) => ({ ...m, ...(m.name === session ? (state.goal ? { goal: state.goal } : {}) : await deps.store.read(workKey(m.name)).then((w) => (w.goal ? { goal: w.goal } : {}))) })))
    return { session, host: deps.host, fetchedAt: Date.now(), work: { ...fetched.work, members }, sessions: fetched.sessions, state: { ...state, seenAt: leftOf(state, deps.now()) }, separated, lookalikes: fetched.lookalikes, ...(from ? { apart: from.work } : {}) }
  }

  async function brief(session: string, left?: number): Promise<Reply> {
    const fetched = await fetch(session)
    if ('error' in fetched) return { status: 404, body: { error: fetched.error } }
    const state = await advance(session, fetched.sessions)
    const entries = entriesOf(fetched.sessions, session)
    return {
      status: 200,
      body: {
        session,
        work: fetched.work,
        agents: Object.fromEntries(fetched.sessions.map((s) => [s.name, s.agent])),
        brief: briefOf(entries, constraints(entries, state.decisions), session, leftOf(state, deps.now()) ?? left, actedAt(state.repairs)),
      },
    }
  }

  const gapsMemo = new Map<string, string[]>()
  const gapsOf = (id: string, packet: string, reply: string) => {
    if (gapsMemo.size > 500) gapsMemo.clear()
    if (!gapsMemo.has(id)) gapsMemo.set(id, replyGaps(packet, reply))
    return gapsMemo.get(id) ?? []
  }

  async function summaries(): Promise<Record<string, ReturnSummary>> {
    const out: Record<string, ReturnSummary> = {}
    for (const [key, w] of Object.entries(await deps.store.all())) {
      if (!key.startsWith('session:')) continue
      const newest = latestOf(w.repairs)
      const draft = Boolean(w.draft?.text.trim()) && !shownAs(w.draft, w.draftVersion, w.repairs)
      const latest = newest?.accepted ? undefined : newest
      const asking = w.inquiries.filter((q) => ASKING.has(q.state)).length
      if (asking) follow(key.slice('session:'.length))
      const answered = w.inquiries.filter((q) => q.state === 'replied' && (q.repliedAt ?? 0) > (w.lookedAt ?? w.seenAt ?? 0)).length
      const accepted = Boolean(newest?.accepted)
      const gaps = (accepted || newest?.state === 'replied') && newest?.reply ? gapsOf(newest.id, newest.packet, newest.reply) : []
      const open = gaps.length
      const looked = w.lookedAt !== undefined && deps.now() - w.lookedAt <= VISIT_GAP ? w.lookedAt : undefined
      if (!draft && !latest && !accepted && looked === undefined && asking === 0 && answered === 0 && !w.goal) continue
      const sent = latest && LIVE.has(latest.state) && latest.state !== 'replied' ? leadAsk(latest.packet, latest.check) : undefined
      out[key.slice('session:'.length)] = { draft, ...(latest ? { repair: latest.state } : {}), ...(sent ? { sent } : {}), ...(w.goal ? { goal: w.goal } : {}), ...(accepted ? { accepted } : {}), ...(open ? { open } : {}), ...(accepted && open ? { missed: gaps } : {}), ...(looked === undefined ? {} : { looked }), asking, answered }
    }
    return out
  }

  async function sendRepair(session: string, requestId: string, seen?: Seen): Promise<Reply> {
    const fetched = await fetch(session)
    if ('error' in fetched) return { status: 404, body: { error: fetched.error } }
    const state = await advance(session, fetched.sessions)
    const existing = state.repairs.find((r) => r.id === requestId)
    if (existing && LIVE.has(existing.state)) return { status: 202, body: { repair: existing } }
    const prior = existing && mayHaveLanded(existing) ? existing : undefined
    const put = (r: Repair) => deps.store.update(workKey(session), (w) => ({ ...w, repairs: [...w.repairs.filter((x) => x.id !== r.id), r] }))
    const refuse = async (code: string, sent?: Repair): Promise<Reply> => {
      if (prior) {
        const next: Repair | null = HELD_ON_RETRY.has(code)
          ? { ...prior, state: 'held', reason: prior.state === 'held' ? prior.reason : 'in_prompt' }
          : LOST.has(code)
            ? { ...prior, state: 'unknown', reason: code }
            : null
        if (next || sent) await put(next ?? prior)
        return { status: 409, body: { error: 'refused', code, ...(next ? { repair: next } : {}) } }
      }
      if (!sent) return { status: 409, body: { error: 'refused', code } }
      const failed: Repair = { ...sent, checked: undefined, state: 'failed', reason: code }
      await put(failed)
      return { status: 409, body: { error: 'refused', code, repair: failed } }
    }
    const s = fetched.sessions.find((x) => x.name === session)
    if (!s) return { status: 404, body: { error: 'unknown_session' } }
    const entries = entriesOf(fetched.sessions, session)
    const c = constraints(entries, state.decisions)
    const block = existing && retryBlock(existing, { version: state.draftVersion, repairs: state.repairs, c, conversation: conversationOf(s), target: state.draft?.target?.sessionId })
    if (existing && block === 'superseded') return { status: 409, body: { error: block, requestId: newerThan(existing, state.repairs)?.id } }
    if (block === 'lost' || block === 'draft_changed') return { status: 409, body: { error: block } }
    if (!prior && seen && seen.version !== state.draftVersion) return { status: 409, body: { error: 'draft_moved' } }
    const sent = sentWith(state.draftVersion, state.repairs, requestId)
    if (sent) return { status: 409, body: { error: 'already_sent', requestId: sent.id } }
    const draft = state.draft
    if (!draft || !draft.text.trim()) return { status: 400, body: { error: 'empty_draft' } }
    const changed = differences(draft.basis, c)
    if (changed.length) return { status: 409, body: { error: 'evidence_changed', differences: changed } }
    if (block === 'basis_changed') return refuse(block)
    const checked = prior?.checked ?? { earlier: draft.earlier, ...(draft.setAside ? { setAside: draft.setAside } : {}), ...(draft.read ? { read: draft.read } : {}) }
    const { issues, blockers, hits, scope, pushes, unread } = draftChecks({ text: draft.text, ...checked }, entries, c)
    if (issues.length) return { status: 409, body: { error: 'draft_issues', issues } }
    if (blockers.length) return { status: 409, body: { error: 'conflict', conflicts: blockers } }
    if (hits.length) return { status: 409, body: { error: 'rule_conflicts', hits: hits.map((h) => ({ line: h.line, rule: h.rule.sentence })) } }
    if (scope.length) return { status: 409, body: { error: 'out_of_scope', lines: [...new Set(scope.map((h) => h.line))] } }
    if (pushes.length) return { status: 409, body: { error: 'limit_pushes', lines: [...new Set(pushes.map((u) => u.line))] } }
    if (unread.length) return { status: 409, body: { error: 'unchecked_amounts', lines: [...new Set(unread.map((u) => u.line))] } }
    if (s.agent !== 'claude') return refuse('not_agent')
    if (!s.transcript || !s.registry) return { status: 409, body: { error: 'refused', code: 'no_registry' } }
    if (!prior && seen && digest(packetOf(PREVIEW_ID, s.path, session, draft, entries, c)) !== seen.preview) return { status: 409, body: { error: 'preview_changed' } }
    const chosen = (prior?.target ?? draft.target)?.sessionId
    if (!chosen) return { status: 409, body: { error: 'no_target' } }
    const target = { session, pane: s.pane, sessionId: chosen }
    if (target.sessionId !== s.registry.sessionId) return refuse('other_conversation')
    const packet = prior?.packet ?? packetOf(requestId, s.path, session, draft, entries, c)
    const failure = newestFailure(entries)
    const check = prior ? prior.check : failure && checkName(failure.text)
    const frozen: Repair = {
      ...(check ? { check } : {}),
      checked,
      id: requestId,
      packet,
      target,
      basis: basisOf(c),
      version: s.transcript.last,
      draftVersion: state.draftVersion,
      sentAt: deps.now(),
      state: 'sending',
    }
    await put(frozen)
    const res = await deps.probe({ mode: 'send', session, pane: target.pane, sessionId: target.sessionId, requestId, packet })
    let outcome: { result?: string; code?: string } = {}
    try {
      outcome = res.exitCode === 0 ? (JSON.parse(res.stdout) as typeof outcome) : {}
    } catch {
      outcome = {}
    }
    if (outcome.result === 'pasted') return { status: 202, body: { repair: frozen } }
    if (outcome.result === 'already') {
      const r = { ...frozen, checked: undefined, state: 'delivered' as const }
      await put(r)
      return { status: 202, body: { repair: r } }
    }
    if (outcome.result === 'held' || (outcome.result === 'unknown' && outcome.code === 'enter_failed')) {
      const r = { ...frozen, state: 'held' as const, reason: outcome.code ?? 'held' }
      await put(r)
      return { status: 409, body: { error: 'held', code: r.reason, repair: r } }
    }
    if (outcome.result === 'refused') return refuse(outcome.code ?? 'refused', frozen)
    if (outcome.result === 'failed') {
      const r = prior?.state === 'unknown' ? prior : { ...frozen, checked: undefined, state: 'failed' as const, reason: outcome.code ?? 'failed' }
      await put(r)
      return { status: 500, body: { error: 'send_failed', code: outcome.code ?? 'failed', repair: r } }
    }
    const r = { ...frozen, state: 'unknown' as const, reason: outcome.code ?? (res.exitCode === 255 ? 'ssh' : 'no_answer') }
    await put(r)
    return { status: 202, body: { repair: r } }
  }

  async function accept(session: string, requestId: string): Promise<Reply> {
    const fetched = await fetch(session)
    if ('error' in fetched) return { status: 404, body: { error: fetched.error } }
    const state = await advance(session, fetched.sessions)
    const r = state.repairs.find((x) => x.id === requestId)
    if (!r) return { status: 404, body: { error: 'unknown_request' } }
    if (r.state !== 'replied' || !r.replyId) return { status: 409, body: { error: 'no_reply' } }
    const changed = differences(r.basis, constraints(entriesOf(fetched.sessions, session), state.decisions))
    if (changed.length) return { status: 409, body: { error: 'evidence_changed', differences: changed } }
    const accepted = { at: deps.now(), replyId: r.replyId }
    await deps.store.update(workKey(session), (w) => ({ ...w, repairs: w.repairs.map((x) => (x.id === requestId ? { ...x, accepted } : x)) }))
    return { status: 200, body: { accepted } }
  }

  async function ask(session: string, inquiryId: string, question: string): Promise<Reply> {
    const fetched = await fetch(session)
    if ('error' in fetched) return { status: 404, body: { error: fetched.error } }
    const state = await deps.store.read(workKey(session))
    const existing = state.inquiries.find((q) => q.id === inquiryId)
    if (existing && existing.state !== 'failed') return { status: 202, body: { inquiry: existing } }
    const s = fetched.sessions.find((x) => x.name === session)
    if (!s?.registry || !s.transcript) return { status: 409, body: { error: 'refused', code: 'no_registry' } }
    const inquiry: Inquiry = {
      id: inquiryId,
      question,
      target: { session, pane: s.pane, sessionId: s.registry.sessionId },
      version: s.transcript.last,
      askedAt: deps.now(),
      state: 'sending',
    }
    const put = (q: Inquiry) => deps.store.update(workKey(session), (w) => ({ ...w, inquiries: [...w.inquiries.filter((x) => x.id !== q.id), q] }))
    await put(inquiry)
    const res = await deps.probe({
      mode: 'ask',
      session,
      pane: s.pane,
      sessionId: s.registry.sessionId,
      inquiryId,
      prompt: questionPrompt({ id: inquiryId, cwd: s.path, question }),
      budget: ASK_BUDGET_USD,
    })
    let outcome: { result?: string; code?: string } = {}
    try {
      outcome = res.exitCode === 0 ? (JSON.parse(res.stdout) as typeof outcome) : {}
    } catch {
      outcome = {}
    }
    if (outcome.result === 'started') {
      const q = { ...inquiry, state: 'running' as const }
      await put(q)
      return { status: 202, body: { inquiry: q } }
    }
    if (outcome.result === 'refused') {
      const q = { ...inquiry, state: 'failed' as const, reason: outcome.code ?? 'refused' }
      await put(q)
      return { status: 409, body: { error: 'refused', code: q.reason, inquiry: q } }
    }
    const q = { ...inquiry, state: 'unknown' as const, reason: res.exitCode === 255 ? 'ssh' : 'no_answer' }
    await put(q)
    return { status: 202, body: { inquiry: q } }
  }

  return {
    load: (session: string) => serial(session, () => load(session)),
    summaries,
    brief,
    ask: (session: string, inquiryId: string, question: string): Promise<Reply> =>
      !INQUIRY_RE.test(inquiryId) || !question.trim() || question.length > QUESTION_MAX
        ? Promise.resolve({ status: 400, body: { error: 'bad_question' } })
        : serial(session, () => ask(session, inquiryId, question.trim())),
    saveDraft: (session: string, draft: DraftState, base: string) => deps.store.saveDraft(workKey(session), pruned(draft), base),
    started: async (session: string, goal: string) => {
      await deps.store.update(SEPARATIONS, (w) => ({ ...w, separations: w.separations.filter((s) => s.session !== session) }))
      return deps.store.update(workKey(session), () => ({ ...emptyWork(workKey(session)), ...(goal ? { goal } : {}) }))
    },
    seen: (session: string) => deps.store.update(workKey(session), (w) => ({ ...w, seenAt: leftOf(w, deps.now()), lookedAt: deps.now() })),
    decide: (session: string, key: string, limitId: string | null) =>
      deps.store.update(workKey(session), (w) => {
        const decisions = { ...w.decisions }
        if (limitId === null) delete decisions[key]
        else decisions[key] = limitId
        return { ...w, decisions }
      }),
    separate: (_session: string, work: string, member: string, undo: boolean) =>
      deps.store.update(SEPARATIONS, (w) => ({
        ...w,
        separations: undo
          ? w.separations.filter((s) => !(s.work === work && s.session === member))
          : [...w.separations.filter((s) => !(s.work === work && s.session === member)), { work, session: member }],
      })),
    repair: (session: string, requestId: string, seen?: { preview?: unknown; version?: unknown }): Promise<Reply> =>
      !REQUEST_RE.test(requestId)
        ? Promise.resolve({ status: 400, body: { error: 'bad_request_id' } })
        : seen && !isSeen(seen)
          ? Promise.resolve({ status: 400, body: { error: 'bad_seen' } })
          : serial(session, () => sendRepair(session, requestId, seen)),
    accept: (session: string, requestId: string) => serial(session, () => accept(session, requestId)),
  }
}

const DRAFT_MAX = 64 * 1024

export function parseDraft(raw: unknown): DraftState | null {
  const d = (raw ?? {}) as Record<string, unknown>
  if (!isStr(d.text) || d.text.length > DRAFT_MAX) return null
  if (!Array.isArray(d.corrections) || !Array.isArray(d.earlier) || (d.basis !== null && !Array.isArray(d.basis))) return null
  const corrections = d.corrections.filter(
    (c): c is { id: string; before: string; after: string } => isStr((c as Record<string, unknown>)?.id) && isStr((c as Record<string, unknown>)?.before) && isStr((c as Record<string, unknown>)?.after),
  )
  const earlier = d.earlier.filter(isStr)
  const basis =
    d.basis === null
      ? null
      : (d.basis as unknown[]).flatMap((b) => {
          const x = (b ?? {}) as Record<string, unknown>
          if (!isStr(x.key)) return []
          return [{ key: x.key, ...(isNum(x.value) ? { value: x.value } : {}), ...(isStr(x.recordId) ? { recordId: x.recordId } : {}), ...(x.undecided === true ? { undecided: true } : {}) }]
        })
  if (corrections.length !== d.corrections.length || earlier.length !== d.earlier.length) return null
  const t = d.target as Record<string, unknown> | null | undefined
  const target = t && isStr(t.session) && isStr(t.pane) && isStr(t.sessionId) ? { session: t.session, pane: t.pane, sessionId: t.sessionId } : null
  if (t && !target) return null
  const q = d.quote as Record<string, unknown> | undefined
  if (q !== undefined && (typeof q !== 'object' || q === null || Array.isArray(q) || Object.keys(q).length > 200 || Object.values(q).some((v) => typeof v !== 'boolean'))) return null
  const o = d.others
  if (o !== undefined && (!Array.isArray(o) || o.length > 20 || !o.every(isStr))) return null
  const a = d.setAside
  if (a !== undefined && (!Array.isArray(a) || !a.every(isStr))) return null
  const r = d.read
  if (r !== undefined && (!Array.isArray(r) || !r.every(isStr))) return null
  const f = d.follows
  if (f !== undefined && !isNum(f)) return null
  return { text: d.text, basis, corrections, earlier, target, ...(q ? { quote: q as Record<string, boolean> } : {}), ...(o ? { others: o as string[] } : {}), ...(a ? { setAside: a as string[] } : {}), ...(r ? { read: r as string[] } : {}), ...(isNum(f) ? { follows: f } : {}) }
}
