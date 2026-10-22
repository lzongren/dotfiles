import { type Ref, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { explain, getReturn, postReturn, putReturnDraft } from '../api'
import {
  actedAt,
  amountKey,
  draftChecks,
  pruned,
  latestOf,
  lostAt,
  mayHaveLanded,
  newerThan,
  retryBlock,
  conversationOf,
  sentWith,
  shownAs,
  basisOf,
  briefOf,
  changeIssue,
  checkedRule,
  checkName,
  clause,
  clauseRest,
  constraints,
  DEFAULT_BRANCHES,
  differences,
  digest,
  draftFor,
  unmentioned,
  askedLines,
  attachedGaps,
  nearestFor,
  leadAsk,
  partly,
  contextOf,
  replyGaps,
  REPORT_BACK,
  askedParts,
  flagNote,
  askedIn,
  sentencesOf,
  entriesOf,
  limitText,
  LOST,
  lower,
  keptOthers,
  measured,
  headRules,
  uniqueRules,
  notesOf,
  holdingOf,
  namedRule,
  othersSince,
  QUESTION_START,
  QUESTION_AFTER_REPLY,
  QUESTION_CATCH_UP,
  QUESTION_WAITING,
  questionPrompt,
  quotedRules,
  reasonNote,
  packetOf,
  PREVIEW_ID,
  ruleKey,
  asideOf,
  exceptionKey,
  sinceLeft,
  sinceVisit,
  spoken,
  stamp,
  undoCorrection,
  wentOut,
  type Brief,
  type Constraints,
  type Correction,
  type Difference,
  type Entry,
  type Held,
  type Issue,
  type Rule,
  type Work,
} from '../shared/recover'
import type { AgentInsight, DraftState, Inquiry, Repair, ReturnResponse } from '../shared/types'
import { ledger } from '../insights'
import { FileList, FilePreview, type FileRef } from './FilePreview'
import { NewSession, type Place } from './NewSession'
import { ArtifactList } from './Overview'
import { ago } from '../time'
import { AgentIcon, Icon, type AgentKind } from './Icon'
import { PickUpRail, workLabel } from './PickUp'
import { TerminalPane } from './Terminal'
import { returnNote, type HomeItem } from './work'

const FAST_MS = 4000
const SLOW_MS = 15000
const SAVE_MS = 500
const FAST_WINDOW_MS = 30000
const PENDING_REPAIR = new Set<Repair['state']>(['sending', 'delivered', 'working'])
const NO_CHANGE = /\b(?:no (?:code |file )?changes?|nothing (?:was )?changed|did(?:n't| not) change anything)\b/i
const PENDING_QUESTION = new Set<Inquiry['state']>(['sending', 'running'])
const STOP_WORDS = new Set(['why', 'the', 'and', 'for', 'this', 'that', 'what', 'with', 'how', 'are', 'was', 'does', 'did', 'is', 'can', 'should', 'would', 'about', 'from', 'when', 'which', 'there', 'still'])

const REASONS: Record<string, string> = {
  busy: 'the agent was working',
  preview_changed: 'what would be sent changed since you looked, in the records or another tab',
  draft_moved: 'the draft changed in another tab',
  bad_seen: 'this page is out of date, so reload it',
  waiting: 'the agent was waiting on you, for a question or a permission prompt',
  typed: "the session's prompt already had text in it",
  no_prompt: "the session's prompt wasn't visible",
  not_agent: "Claude Code isn't in front in that pane",
  other_conversation: 'a different conversation is now running in that pane',
  changed_after_paste: 'the pane changed right after Devbox pasted',
  enter_failed: "tmux couldn't press Enter after pasting, so the request is waiting in the session's prompt",
  not_visible: "Devbox can't see that conversation in the session right now",
  in_prompt: "the request may still be in the session's prompt",
  other_session: 'the original pane is gone',
  gone: 'the original pane is gone',
  bad_target: 'the original pane is gone',
  no_registry: "Claude Code reported no conversation in this session, or Devbox can't read its transcript",
  prompt_changed: "the session's prompt changed while Devbox pasted, so the request is waiting in that prompt",
  agent_changed: "the agent started working while Devbox pasted, so the request is waiting in the session's prompt",
  load_failed: "tmux couldn't paste",
  paste_failed: "tmux couldn't paste",
  no_folder: "the session's folder is gone",
  no_claude: "Claude Code wasn't found on the host",
  not_read_only: "Devbox couldn't make the copy read-only, so it stopped it",
  timeout: 'the copy ran out of time',
  stopped: 'the copy stopped without an answer',
  ssh: "the host didn't answer",
  no_answer: "the host didn't answer",
  evidence_changed: 'the evidence changed since you checked this draft',
  draft_changed: 'the draft changed, so send it as a new request',
  draft_issues: 'a line in the draft differs from what holds now. Change or keep it first',
  conflict: 'decide which value holds for this work first',
  rule_conflicts: 'a line in the draft goes against one of your rules. Edit it or set the rule aside first',
  unchecked_amounts: "a line in the draft has an amount Devbox can't check. Rewrite or confirm it first",
  limit_pushes: 'a line in the draft asks to go past a limit that holds now. Edit it first',
  out_of_scope: 'a line in the draft asks for a merge, push or deploy, or to ignore your limits, rules or checks. Remove it first',
  empty_draft: 'the draft is empty',
  already_sent: 'this draft was already sent',
  lost: "Devbox can't tell whether it arrived, so edit the draft to send it again",
  superseded: 'a newer repair went out after this one, so this one is not sent again',
  basis_changed: 'what holds now changed after this was first sent, so edit the draft to send it as a new request',
  no_target: 'choose which conversation should get this draft first',
}

const KIND_LABEL: Record<Entry['kind'], string> = { decision: 'you', agent: 'agent', failure: 'failed check', shell: 'shell', devbox: 'sent from Devbox' }

const QUIET = new Set(['ssh', 'no_answer'])
const LIST = new Intl.ListFormat('en')
const listed = (lines: number[]) => LIST.format(lines.map((i) => String(i + 1)))
const DRAFT_SIDE = new Set(['other_conversation', 'no_target', 'no_registry'])
const STOPPED: Record<string, string> = {
  basis_changed: 'What holds changed after it went out',
  other_conversation: 'A different conversation runs in {session} now',
  draft_changed: 'The draft changed after it',
  already_sent: 'This text went out again after it',
}
const AFTER_RETRY: Record<string, string> = { held: ' The request may still be waiting in the prompt.', unknown: " Devbox can't tell whether the earlier attempt arrived." }
const followable = (r: Repair, sessionId?: string) => r.target.sessionId === sessionId
const following = (r: Repair, sessionId?: string) => PENDING_REPAIR.has(r.state) && (r.state === 'sending' || followable(r, sessionId))
const unknownText = (reason?: string, replaced = false) =>
  reason && REASONS[reason] && !QUIET.has(reason)
    ? `${REASONS[reason]}, so Devbox can't tell whether it arrived.${LOST.has(reason) && !replaced ? ' Edit the draft to send it again.' : ''}`
    : 'there is no record of it in the conversation yet.'

function changeText(d: Difference): string {
  if (d.change === 'value' && d.before?.value !== undefined && d.after) return `${limitText(d.key, d.before.value)} → ${lower(d.after.shown)}`
  if (d.change === 'new' && d.after) return `new: ${lower(d.after.shown)}`
  if (d.change === 'undecided') return `${d.subject}: now has two values, undecided`
  if (d.change === 'removed') return `${d.subject}: no longer found`
  return 'saved before Devbox checked evidence'
}

const newId = (prefix: 'r' | 'q') => `${prefix}-${Math.random().toString(36).slice(2, 10)}`
const reasonOf = (code?: string) => (code ? (REASONS[code] ?? code) : 'no reason given')

interface LocalDraft {
  text: string
  basis: DraftState['basis']
  corrections: Correction[]
  earlier: string[]
  target: DraftState['target']
  quote?: Record<string, boolean>
  others?: string[]
  setAside?: string[]
  read?: string[]
  follows?: number
}

const afresh = (d: LocalDraft): LocalDraft => ({ ...d, corrections: [], earlier: [], setAside: [], read: [] })

function When({ at, now }: { at: number; now: number }) {
  return (
    <span className="when" title={stamp(at)}>
      {ago(now, at)} ago
    </span>
  )
}

const lowerOf = (shown?: string) => (shown ? lower(shown) : undefined)
const Name = ({ of }: { of: string }) => <code className="session-chip">{of}</code>

function Source({ entry, now, replacedBy, above = false }: { entry: Entry; now: number; replacedBy?: string; above?: boolean }) {
  return (
    <li className="return-record" data-kind={entry.kind}>
      <p className="record-meta">
        <span className="record-kind">{entry.kind === 'shell' ? `shell ${entry.session}` : entry.kind === 'devbox' ? KIND_LABEL[entry.kind] : `${KIND_LABEL[entry.kind]} in ${entry.session}`}</span>
        {' · '}
        <When at={entry.at} now={now} />
        {replacedBy ? <strong> · replaced by {replacedBy}</strong> : null}
      </p>
      <p className="record-text">{above ? `${firstLines(entry.text, 1)} · in full above` : entry.text}</p>
    </li>
  )
}

type Step = 'changes' | 'result' | 'draft'
const PENDING_TITLE: Partial<Record<Repair['state'], string>> = { sending: 'Sending to', delivered: 'Repair delivered to', working: 'Repair delivered to' }
const STATE_TITLE: Record<Repair['state'], string> = {
  sending: 'Sending',
  delivered: 'Delivered · waiting on the agent',
  working: 'Delivered · no reply yet',
  replied: 'Replied · review it',
  held: 'In the prompt, not submitted',
  failed: 'Not sent · the draft is kept',
  unknown: 'Delivery unknown',
}
const clip = (text: string, n = 220) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)
const firstLines = (text: string, n = 2) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, n)
    .join('\n')

function Undecided({ c, you, onDecide, onCheck }: { c: Constraints; you: (x: { session: string }) => string; onDecide: (key: string, limitId: string | null) => void; onCheck: (text: string) => void }) {
  return (
    <>
      {c.conflicts.map((x) => (
        <section key={x.key} className="brief-alert hold conflict" aria-label={`Undecided ${x.subject}`}>
          {x.decided ? (
            <p>
              <span className="hold-value">{lower(x.decided.shown)}</span> · decided for this work by you{' '}
              <button type="button" className="link" onClick={() => onDecide(x.key, null)}>
                Change
              </button>
            </p>
          ) : (
            <p className="conflict-note">
              <strong>
                {x.limits.length} values for {x.subject}, and neither says it replaces the other.
              </strong>{' '}
              Decide for this work:
            </p>
          )}
          {x.limits.map((l) => (
            <div key={l.id} className="conflict-option">
              <blockquote>
                {l.sentence} <span className="when">· {you(l)}, {day(l.at)}</span>
              </blockquote>
              {!x.decided ? (
                <button type="button" onClick={() => onDecide(x.key, l.id)}>
                  Use {lower(l.shown)} for this work
                </button>
              ) : null}
            </div>
          ))}
          {!x.decided ? (
            <button type="button" className="link" onClick={() => onCheck(`Using only these records, check which ${x.subject} value applies to this work, and say it is unknown if they don't say. Don't change code or run tests.`)}>
              Ask which applies (read-only)
            </button>
          ) : null}
        </section>
      ))}
    </>
  )
}

function Sourced({ h, you }: { h: Held; you: (x: { session: string }) => string }) {
  return (
    <li className="hold">
      <p>
        <span className="hold-value">{lower(h.limit.shown)}</span>
        <span className="when">
          {' '}
          · {you(h.limit)}, {day(h.limit.at)}
        </span>
      </p>
      <blockquote>{h.limit.sentence}</blockquote>
      <p className="hold-reason">{reasonNote(h)}.</p>
      {h.replaced.map((old) => (
        <p key={old.id} className="replaced">
          Replaces the earlier “{old.sentence}” · {you(old)}, {day(old.at)}
        </p>
      ))}
    </li>
  )
}

const counted = (limits: number, rules: number) => [limits ? `${limits} limit${limits === 1 ? '' : 's'}` : '', rules ? `${rules} rule${rules === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')


const day = (at: number) => new Date(at * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const tally = (es: Entry[]) => {
  const agent = es.filter((e) => e.kind === 'agent').length
  const yours = es.filter((e) => e.author === 'you').length
  const failed = es.filter((e) => e.kind === 'failure').length
  const shell = es.filter((e) => e.kind === 'shell').length
  return [agent ? plural(agent, 'agent message') : '', yours ? `${yours} of yours` : '', failed ? plural(failed, 'failed check') : '', shell ? plural(shell, 'shell line') : ''].filter(Boolean).join(', ')
}

function RecoveryBrief({ brief, c, session, now, onOpen, after = [], compact = false, stated = false, asked, lastSaid, lastFailure, repairs = [] }: { brief: Brief; c: Constraints; session: string; now: number; onOpen: (name: string) => void; after?: Entry[]; compact?: boolean; stated?: boolean; asked?: string; lastSaid?: Entry; lastFailure?: Entry; repairs?: Repair[] }) {
  const checked = checkedRule((brief.failing ?? lastFailure)?.text, c.rules)
  const by = (x: { session: string; at: number }) => `${x.session === session ? 'you' : `you in ${x.session}`}, ${day(x.at)}`
  const recent = sinceLeft(brief)
  const named = new Map(recent.map((x) => [x.id, namedRule(x, c.rules)]))
  const marked = [checked, ...[...named.values()].map((p) => p?.rule)].filter((r): r is Rule => r !== undefined)
  const { unique, head } = headRules(c.rules, session, marked)
  const isChecked = (r: Rule) => checked !== undefined && r.sentence === checked.sentence
  const isNamed = (r: Rule) => recent.some((x) => named.get(x.id)?.rule.sentence === r.sentence)
  const quoted = new Set([...c.holds.flatMap((h) => [h.limit, ...h.replaced]), ...head].map((x) => x.sentence))
  const unquoted = !lastSaid ? '' : lastSaid.kind === 'devbox' ? (leadAsk(lastSaid.text, repairs.find((r) => lastSaid.text.startsWith(`[devbox repair ${r.id}]`))?.check) ?? '') : sentencesOf(lastSaid.text).filter((s) => !quoted.has(s)).join(' ')
  const open = stated ? recent.filter((x) => !named.get(x.id)) : recent
  const ofRow = (e: Entry) => open.filter((x) => x.recordId === e.id)
  const statedAbove = (e: Entry) => recent.some((x) => x.recordId === e.id && named.get(x.id)) && !spoken(e.text, brief) && !ofRow(e).length
  const said = after.filter((e) => e.kind === 'agent' && (spoken(e.text, brief) || ofRow(e).length)).slice(-3)
  const loose = open.filter((x) => !said.some((e) => e.id === x.recordId))
  const hidden = after.filter((e) => !said.includes(e) && e.id !== brief.failing?.id && !(unquoted && e.id === lastSaid?.id) && !loose.some((x) => x.recordId === e.id) && !(stated && statedAbove(e)))
  const unshown = tally(hidden)
  const [showHidden, setShowHidden] = useState(false)
  const [allRules, setAllRules] = useState(false)
  const count = tally(after.filter((e) => !(stated && statedAbove(e))))
  const suggested = (x: Brief['suggestions'][number]) => {
    const p = named.get(x.id)
    return `suggested “${x.shown}” · ${p ? `your rule: “${p.clause}”` : 'not set by you'}`
  }
  const you = (x: { session: string }) => (x.session === session ? 'you' : `you in ${x.session}`)
  const live = c.holds.filter((h) => !h.decided)
  const rules = allRules ? unique : head
  const why = brief.why
  const whyShown = why && (head.some((r) => r.sentence === why.sentence && r.reason === why.reason) || live.some((h) => h.replaced.length > 0 && h.limit.reason !== undefined && h.limit.reason === why.reason))
  const notes = [...notesOf(c, session), ...uniqueRules((c.references ?? []).filter((r) => r.session !== session), session)]
  const holds = (
    <>
            {live.length === 0 && c.conflicts.length === 0 && rules.length === 0 ? <p className="lane-empty">{c.rules.length ? 'No limits found.' : 'No limits automatically interpreted. This does not mean there are no constraints.'}</p> : null}
            {notes.length ? <details className="return-preview" open={live.length === 0 && notes.some((r) => r.session === session) || undefined}>
              <summary>{notes.length} source note{notes.length === 1 ? '' : 's'} outside automatic checks</summary>
              <p>Original messages, not a resolved set of current constraints. Related-session notes are reference only and stay out of the repair. Notes from this conversation are included verbatim; their scope and replacement order have not been interpreted.</p>
              {notes.map((r, i) => <blockquote key={`${r.recordId}:${i}`}><p>{r.sentence}</p><small>{by(r)}</small><button type="button" className="link" onClick={() => onOpen(r.session)}>Open source conversation</button></blockquote>)}
            </details> : null}
            <ul className="holds-list">
              {live.map((h) => (
                <li key={h.key} data-changed={h.replaced.length > 0 || undefined}>
                  {lower(h.limit.shown)}
                  {h.replaced.length ? (
                    <>
                      {' '}
                      <span className="hold-tag">
                        changed <When at={h.limit.at} now={now} />
                      </span>
                      <small>
                        was {limitText(h.key, h.replaced[h.replaced.length - 1].value)}
                        {h.limit.session === session ? null : (
                          <>
                            {' · in '}
                            <Name of={h.limit.session} />
                          </>
                        )}
                        {' · '}
                        {reasonNote(h)}
                      </small>
                    </>
                  ) : (
                    <small>
                      {by(h.limit)} · {reasonNote(h)}
                    </small>
                  )}
                </li>
              ))}
              {rules.map((r) => (
                <li key={ruleKey(r)}>
                  {clause(r.sentence)}
                  {isChecked(r) && (brief.failing || lastFailure) ? (
                    <>
                      {' '}
                      <span className="hold-tag failing">{brief.failing ? 'failing check' : 'failed before the repair'}</span>
                    </>
                  ) : null}
                  {isNamed(r) ? (
                    <>
                      {' '}
                      <span className="hold-tag">named in an agent suggestion</span>
                    </>
                  ) : null}
                  <small>
                    {clauseRest(r.sentence) || (r.reason ? `Reason: ${r.reason}` : 'no reason recorded')} · {by(r)}
                  </small>
                </li>
              ))}
            </ul>
            {allRules || head.length < unique.length ? (
              <button type="button" className="link when" aria-expanded={allRules} onClick={() => setAllRules((v) => !v)}>
                {allRules ? 'Show fewer rules' : head.length ? plural(unique.length - head.length, 'more rule') : `Show ${plural(unique.length, 'rule')}`}
              </button>
            ) : null}
            {live.length || rules.length || brief.suggestions.length ? (
              <details className="quiet">
                <summary>Where these come from</summary>
                <ul className="return-list">
                  {live.map((h) => (
                    <Sourced key={h.key} h={h} you={you} />
                  ))}
                  {rules.map((r) => (
                    <li key={ruleKey(r)} className="hold rule">
                      <blockquote>{r.sentence}</blockquote>
                      <p className="when">
                        rule · {you(r)}, {day(r.at)}
                        {r.reason ? ` · Reason: ${r.reason}` : ''}
                      </p>
                    </li>
                  ))}
                  {brief.suggestions.map((s) => (
                    <li key={s.id} className="hold suggestion">
                      <blockquote>{s.sentence}</blockquote>
                      <p className="when">agent's suggestion, {day(s.at)}</p>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
    </>
  )
  return (
    <section className={compact ? 'return-brief compact' : 'return-brief'} aria-labelledby="return-brief">
      <div className="brief-head">
        <h3 id="return-brief">{brief.leftAt !== undefined ? 'Where you left off' : 'Where this work stands'}</h3>
        {brief.leftAt !== undefined ? (
          <span className="when">
            <Icon name="clock" size={14} /> your last visit ended {day(brief.leftAt)} · now {day(Math.floor(now / 1000))}
          </span>
        ) : null}
      </div>
      <div className="brief-cols">
        <dl className="brief-facts">
          {asked ? (
            <>
              <dt>Asked for</dt>
              <dd>{clip(asked)}</dd>
            </>
          ) : null}
          {lastSaid && unquoted ? (
            <>
              <dt>{lastSaid.kind === 'devbox' ? 'You sent' : 'You last said'}</dt>
              <dd>
                <span>
                  “{clip(unquoted)}” <When at={lastSaid.at} now={now} />
                  {brief.leftAt !== undefined && lastSaid.at > brief.leftAt ? ' · after your last visit here' : null}
                </span>
              </dd>
            </>
          ) : null}
          {whyShown ? null : (
            <>
              <dt>Reason before you left</dt>
              <dd>
                {why ? why.reason ?? why.sentence : <span className="lane-empty">No explicit reason recovered from the available messages.</span>}
                {why ? (
                  <details className="quiet">
                    <summary>
                      {you(why)}, <When at={why.at} now={now} /> · the decision as written
                    </summary>
                    {why.reason ? <blockquote>{why.sentence}</blockquote> : null}
                    <button type="button" className="link" onClick={() => onOpen(why.session)}>
                      Show it in the session
                    </button>
                  </details>
                ) : null}
              </dd>
            </>
          )}
          {brief.stopped ? (
            <>
              <dt>Stopped at</dt>
              <dd>{clip(brief.stopped.text)}</dd>
            </>
          ) : null}
          {said.length || loose.length || count ? (
            <>
              <dt>{brief.leftAt !== undefined ? 'Since you left' : 'Latest'}</dt>
              <dd>
                {loose.map((x) => (
                  <span key={x.id} className="brief-suggestion" title={x.sentence}>
                    The agent {suggested(x)} <When at={x.at} now={now} />
                  </span>
                ))}
                {said.map((e) => (
                  <span key={e.id}>
                    {spoken(e.text, brief) ? `“${clip(spoken(e.text, brief), 160)}” ` : null}
                    {ofRow(e).map((x) => (
                      <span key={x.id} className="brief-suggestion" title={x.sentence}>
                        {spoken(e.text, brief) ? 'Then ' : 'The agent '}
                        {suggested(x)}{' '}
                      </span>
                    ))}
                    <small className="when">
                      <Name of={e.session} /> · <When at={e.at} now={now} />
                    </small>
                  </span>
                ))}
                {said.length ? (
                  unshown ? (
                    <>
                      <button type="button" className="link when" aria-expanded={showHidden} onClick={() => setShowHidden((v) => !v)}>
                        {showHidden ? `Shown below: ${unshown} · hide` : `Not shown: ${unshown}`}
                      </button>
                      {showHidden
                        ? hidden.map((e) => (
                            <span key={e.id}>
                              <b>{KIND_LABEL[e.kind]}</b> “{clip(e.text, 200)}”{' '}
                              <small className="when">
                                <Name of={e.session} /> · <When at={e.at} now={now} />
                              </small>
                            </span>
                          ))
                        : null}
                    </>
                  ) : null
                ) : count ? (
                  <small className="when">{count}</small>
                ) : null}
              </dd>
            </>
          ) : null}
        </dl>
        <div className="brief-holds">
          <h4 id="return-holds">What holds now</h4>
          {compact ? (
            <details className="quiet">
              <summary>{counted(live.length, unique.length) || 'none found in your messages'}</summary>
              {holds}
            </details>
          ) : (
            holds
          )}
        </div>
      </div>
      {brief.unexplained.length && !compact ? (
        <details className="brief-missing quiet">
          <summary>
            {brief.unexplained.length === 1
              ? `One reason isn't recorded: why ${lower(brief.unexplained[0].limit.shown)}`
              : `${brief.unexplained.length} reasons aren't recorded: ${brief.unexplained.map((h) => lower(h.limit.shown)).join(', ')}`}
          </summary>
          <p>The records give the value without a reason. Ask the agent only if it matters for this repair. An unknown reason doesn't become a new limit.</p>
        </details>
      ) : null}
    </section>
  )
}

const STATE_WORD: Record<string, string> = { waiting: 'waiting on you', working: 'working', error: 'error', ready: 'idle' }

export function ReturnView({
  session,
  title,
  left,
  works = [],
  active = true,
  onClose,
  back = 'Now',
  onOpenTerminal,
  onSwitch,
  onSessionsChanged,
  elsewhere,
  onAll,
  switchTo,
  focus,
  homeAt,
  insights,
  onStateChanged,
}: {
  session: string
  title?: string
  left?: number
  works?: HomeItem[]
  active?: boolean
  onClose: (members: string[]) => void
  back?: string
  onOpenTerminal: (name: string) => void
  onSwitch?: (name: string, members: string[], here?: boolean) => void
  onSessionsChanged?: () => void
  elsewhere?: number
  onAll?: () => void
  switchTo?: { name: string; at: number } | null
  focus?: { name: string; at: number; terminal?: boolean } | null
  homeAt?: number
  insights?: Map<string, AgentInsight>
  onStateChanged?: (regrouped?: boolean, work?: Work, brief?: Brief) => void
}) {
  const [data, setData] = useState<ReturnResponse | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [draft, setDraft] = useState<LocalDraft | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [apart, setApart] = useState<{ name: string; back: boolean } | null>(null)
  const [undoNote, setUndoNote] = useState<string | null>(null)
  const askKey = `devbox-ask:${session}`
  const [question, setQuestionState] = useState(() => {
    try {
      return sessionStorage.getItem(askKey) ?? ''
    } catch {
      return ''
    }
  })
  const setQuestion = (text: string) => {
    setQuestionState(text)
    try {
      if (text && text !== prefilled.current) sessionStorage.setItem(askKey, text)
      else sessionStorage.removeItem(askKey)
    } catch {
      void 0
    }
  }
  const [lookup, setLookup] = useState<{ found: Entry[]; words: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<Step>('changes')
  const stepWas = useRef(step)
  useEffect(() => {
    if (stepWas.current === step) return
    stepWas.current = step
    const nav = document.querySelector('.return-steps')
    if (nav && nav.getBoundingClientRect().top < 0) nav.scrollIntoView?.({ block: 'start' })
  }, [step])
  const [asking, setAsking] = useState(() => question.trim() !== '')
  const [discarding, setDiscarding] = useState(false)
  const prefilled = useRef('')
  const land = useRef<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [more, setMore] = useState<'evidence' | 'linked' | 'run'>('evidence')
  const [whyOpen, setWhyOpen] = useState(false)
  const whyRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (whyOpen) whyRef.current?.focus({ preventScroll: true })
  }, [whyOpen])
  const [peek, setPeek] = useState<FileRef | null>(null)
  const [tab, setTab] = useState('changes')
  useEffect(() => setApart(null), [tab])
  const [opened, setOpened] = useState<string[]>([])
  const [created, setCreated] = useState<Array<{ name: string; kind: AgentKind }>>([])
  const version = useRef('')
  const edits = useRef(0)
  const [saved, setSaved] = useState('')
  const setVersion = useCallback((v: string) => {
    version.current = v
    setSaved(v)
  }, [])
  const loaded = useRef(false)
  const saveTimer = useRef<number | null>(null)
  const listedOthers = useRef(new Set<string>())
  const pollTimer = useRef<number | null>(null)
  const unsaved = useRef<LocalDraft | null>(null)
  const [dirty, setDirty] = useState(false)
  const saving = useRef<Promise<'ok' | 'conflict' | 'error'> | null>(null)
  const leaving = useRef<string | null>(null)
  const exiting = useRef(false)
  const fastUntil = useRef(0)
  const justSent = useRef<string | null>(null)
  const live = useRef(true)
  const reload = useRef<() => Promise<unknown>>(async () => undefined)
  const shown = useRef(active)
  const leftRef = useRef(left)
  leftRef.current = left
  const now = Date.now()

  const entries = useMemo(() => (data ? entriesOf(data.sessions, session) : []), [data, session])
  const c = useMemo(() => constraints(entries, data?.state.decisions ?? {}, session), [entries, data])
  const target = data?.sessions.find((s) => s.name === session)
  const running = conversationOf(target)
  const current = target && running ? { session, pane: target.pane, sessionId: running } : null

  const schedule = useCallback((pending: boolean) => {
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current)
    pollTimer.current = null
    if (!shown.current) return
    pollTimer.current = window.setTimeout(() => void reload.current(), pending || Date.now() < fastUntil.current ? FAST_MS : SLOW_MS)
  }, [])

  const load = useCallback(async (adopt = false) => {
    const at = edits.current
    const idle = !unsaved.current && !saving.current
    const result = await getReturn(session)
    if (!live.current) return false
    if (result.kind !== 'ok') {
      setFailure(result.kind === 'error' && result.status === 404 ? 'This session is gone from the host.' : explain(result))
      schedule(false)
      return false
    }
    setFailure(null)
    setData(result.data)
    const s = result.data.state
    const read = entriesOf(result.data.sessions, session)
    onStateChanged?.(false, result.data.work, briefOf(read, constraints(read, s.decisions, session), session, s.seenAt ?? leftRef.current, actedAt(s.repairs)))
    const adopted = !loaded.current || (adopt && idle && at === edits.current && !unsaved.current && !saving.current)
    if (adopted) {
      setVersion(s.draftVersion)
      setDraft(s.draft ? { text: s.draft.text, basis: s.draft.basis, corrections: s.draft.corrections, earlier: s.draft.earlier, target: s.draft.target, quote: s.draft.quote, others: s.draft.others, setAside: s.draft.setAside, read: s.draft.read, follows: s.draft.follows } : null)
    }
    if (!loaded.current) {
      loaded.current = true
      const newest = latestOf(s.repairs)
      const open = newest && !newest.accepted
      const unsent = Boolean(s.draft?.text.trim()) && !shownAs(s.draft, s.draftVersion, s.repairs)
      setStep((open && newest.state === 'replied') || (newest?.accepted && !unsent) ? 'result' : open || unsent ? 'draft' : 'changes')
      const answered = s.inquiries.filter((q) => q.state === 'replied' && (q.repliedAt ?? 0) > (s.seenAt ?? 0)).sort((a, b) => b.askedAt - a.askedAt)[0]
      land.current = open && newest.state === 'replied' ? 'return-result' : answered ? `answer-${answered.id}` : null
    }
    const sid = conversationOf(result.data.sessions.find((x) => x.name === session))
    const pending = s.repairs.some((r) => following(r, sid)) || s.inquiries.some((q) => PENDING_QUESTION.has(q.state))
    schedule(pending)
    return adopted
  }, [session, schedule, setVersion])
  reload.current = load

  useEffect(() => {
    if (!land.current || !data) return
    const el = document.getElementById(land.current)
    land.current = null
    el?.scrollIntoView?.({ block: 'start' })
  }, [data])

  useEffect(() => {
    shown.current = active
    if (active && loaded.current) void load()
  }, [active, load])

  useEffect(() => {
    live.current = true
    void load()
    return () => {
      live.current = false
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current)
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    }
  }, [load])

  const switchFrom = useRef(switchTo)
  useEffect(() => {
    if (switchTo && switchTo !== switchFrom.current && switchTo.name !== session) void leave(() => onSwitch?.(switchTo.name, inWork()), `switch:${switchTo.name}`, 'Open it again')
  }, [switchTo])

  const save = useCallback(async (strict = false) => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    saveTimer.current = null
    while (saving.current) {
      const prior = await saving.current
      if (prior === 'conflict' || (strict && prior === 'error')) return false
    }
    const next = unsaved.current
    if (!next) return true
    unsaved.current = null
    const put = async (base: string): Promise<'ok' | 'conflict' | 'error'> => {
      const result = await putReturnDraft(session, next, base)
      if (result.kind === 'ok') {
        setVersion(result.data.version)
        leaving.current = null
        return 'ok'
      }
      const body = result.kind === 'error' ? (result.body as { draft?: DraftState | null; version?: string } | undefined) : undefined
      if (result.kind === 'error' && result.status === 409 && body) {
        if (!body.draft && base !== (body.version ?? '')) return put(body.version ?? '')
        setVersion(body.version ?? '')
        unsaved.current = null
        setDraft(body.draft ? { ...body.draft } : null)
        setNotice('This draft changed in another tab, so that version is shown.')
        return 'conflict'
      }
      unsaved.current ??= next
      setNotice(`Not saved yet: ${explain(result)}`)
      return 'error'
    }
    const run = put(version.current)
    saving.current = run
    const outcome = await run
    saving.current = null
    setDirty(unsaved.current !== null)
    return outcome === 'ok'
  }, [session, setVersion])

  useEffect(
    () => () => {
      if (unsaved.current) void save()
    },
    [save],
  )

  const update = useCallback(
    (draft: LocalDraft) => {
      const next = pruned(draft)
      setDraft(next)
      edits.current += 1
      unsaved.current = next
      setDirty(true)
      leaving.current = null
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => void save(), SAVE_MS)
    },
    [save],
  )

  const startDraft = (text: string): LocalDraft => ({
    text,
    basis: basisOf(c),
    corrections: [],
    earlier: [],
    target: current,
    ...(draft?.follows === undefined ? {} : { follows: draft.follows }),
  })

  const edit = (text: string) => {
    setUndoNote(null)
    update(draft ? { ...draft, text } : startDraft(text))
  }

  const refresh = () => void load()

  const leave = async (then: () => void, key = 'back', again = 'Go back again') => {
    if (exiting.current) return
    exiting.current = true
    if (!(await save()) && leaving.current !== key) {
      exiting.current = false
      leaving.current = key
      if (unsaved.current) setNotice(`Your last edit isn't saved yet. ${again} to leave without it.`)
      return
    }
    await postReturn('seen', { session })
    then()
  }
  const inWork = () => data?.work.members.map((m) => m.name) ?? []
  const close = () => leave(() => onClose(inWork()))
  const homeFrom = useRef(homeAt)
  useEffect(() => {
    if (homeAt !== homeFrom.current) void close()
  }, [homeAt])

  useEffect(() => {
    if (!focus || !data) return
    if (focus.name === session && !focus.terminal) setTab('changes')
    else if (data.work.members.some((m) => m.name === focus.name)) {
      setOpened((prev) => [...prev.filter((n) => n !== focus.name), focus.name].slice(-3))
      setTab(focus.name)
    }
  }, [focus, data === null])

  if (!data) {
    return (
      <section className="return" aria-label={`Pick up ${session}`}>
        <div className="return-main">
          <button type="button" className="link return-back" onClick={() => onClose([])}>
            <Icon name="back" />
            Back to {back}
          </button>
          <p className="lane-empty" role="status">
            {failure ?? 'Reading the conversation from the host…'}
          </p>
        </div>
      </section>
    )
  }

  const leftAt = data.state.seenAt ?? left
  const brief = briefOf(entries, c, session, leftAt, actedAt(data.state.repairs))
  const mine = entries.filter((e) => e.session === session)
  const before = (e: Entry) => leftAt === undefined || e.at <= leftAt
  const lastYou = [...mine].reverse().find((e) => e.kind === 'decision' && before(e))
  const lastAgent = [...mine].reverse().find((e) => e.kind === 'agent' && before(e))
  const since = sinceVisit(entries, leftAt)
  const others = othersSince(since, session)
  const quotedFrom = keptOthers(entries, session, draft?.others)
  const lostOthers = (draft?.others ?? []).filter((id) => !quotedFrom.some((e) => e.id === id)).length
  listedOthers.current = new Set([...listedOthers.current, ...others.map((e) => e.id), ...quotedFrom.map((e) => e.id)])
  const offered = keptOthers(entries, session, [...listedOthers.current])
  const canAct = running !== undefined
  const you = (x: { session: string }) => (x.session === session ? 'you' : `you in ${x.session}`)

  const repairs = [...data.state.repairs].sort((a, b) => b.sentAt - a.sentAt)
  const sentThis = sentWith(saved, repairs)
  const sessionNamed = (name: string) => data.sessions.find((x) => x.name === name)
  const blocks = new Map(repairs.map((r) => [r.id, retryBlock(r, { version: saved, repairs, c, conversation: conversationOf(sessionNamed(r.target.session)), target: draft?.target?.sessionId })]))
  const text = draft?.text ?? ''
  const earlier = draft?.earlier ?? []
  const setAside = draft?.setAside
  const read = draft?.read ?? []
  const { issues, kept, blockers, hits, scope, pushes, confirmed, unread } = draftChecks({ text, earlier, setAside, read }, entries, c)
  const aside = asideOf(c, setAside, text)
  const changed = draft ? differences(draft.basis, c) : []
  const findings = issues.length + hits.length + scope.length + pushes.length
  const keptCount = kept.reduce((n, k) => n + k.lines.length, 0)
  const lines = text.split('\n')
  const cards = [...new Set([...issues, ...hits, ...scope, ...pushes, ...unread].map((x) => x.line))].sort((a, b) => a - b)
  const attempt = sentThis ?? repairs.find((r) => r.draftVersion === saved)
  const newest = repairs[0]
  const replied = repairs.find((r) => r.state === 'replied')
  const previous = repairs.find((r) => r.state === 'replied' && r !== replied)
  const asked = replied ? askedIn(replied.packet) : ''
  const reply = replied?.reply ?? ''
  const askedFor = asked ? askedLines(asked) : []
  const context = replied ? contextOf(replied.packet) : new Set<string>()
  const unsaid = new Set(replied ? unmentioned(asked, reply, context) : [])
  const nearest = nearestFor(askedFor, reply, context)
  const loose = partly(askedFor, reply, context)
  const attached = replied ? attachedGaps(replied.packet, reply) : []
  const missing = replied ? replyGaps(replied.packet, reply) : []
  const status = target?.registry?.status
  const waitingFor = target?.registry?.waitingFor
  const retarget = Boolean(draft?.text.trim() && current && !sentThis && draft.target?.sessionId !== current.sessionId)
  const reasons: Array<[boolean, string]> = [
    [!canAct, `Only a Claude Code conversation the host reports in ${session}, with its transcript, can take a repair.`],
    [retarget, 'Choose which conversation should get this draft.'],
    [!text.trim(), 'Write what the agent should do.'],
    [changed.length > 0, 'Check the changes listed above first.'],
    [issues.length > 0, 'Change or keep each flagged line.'],
    [hits.length > 0, 'Edit each line that goes against one of your rules, or set that rule aside for this repair.'],
    [pushes.length > 0, 'Edit each line that asks to go past a limit that holds now.'],
    [scope.length > 0, 'Remove each line that asks for a merge, push or deploy, or to ignore your limits, rules or checks.'],
    [unread.length > 0, "Rewrite or confirm each amount Devbox can't check."],
    [blockers.length > 0, `Decide which value of ${blockers.map((b) => b.subject).join(', ')} holds for this work.`],
    [sentThis?.state === 'held', `This draft was already sent and is held in ${session}'s prompt; its receipt says what to do.`],
    [Boolean(sentThis), 'This draft was already sent. Edit it to send a follow-up.'],
    [status === 'busy', `${session} is working. You can send when it's idle.`],
    [status === 'waiting', `${session} is waiting for you in its terminal${waitingFor ? ` (${waitingFor})` : ''}. You can send when it's idle.`],
  ]
  const why = reasons.find(([when]) => when)?.[1] ?? null
  const out = Boolean(shownAs(draft, saved, repairs))
  const here = text.trim() && !out ? 'Draft not sent' : newest?.accepted ? 'Result accepted · merge is still yours' : newest ? returnNote({ draft: false, repair: newest.state, asking: 0, answered: 0 }) : null
  const label = workLabel(data.work.key)
  const members = data.work.members.length

  const send = async (retry?: string) => {
    setBusy(true)
    setNotice(null)
    if (!(await save(true))) {
      setBusy(false)
      return
    }
    const last = repairs.find((r) => r.draftVersion === version.current)
    const requestId = retry ?? (last && !wentOut(last) ? last.id : newId('r'))
    const result = await postReturn<{ error?: string; code?: string }>('repair', { session, requestId, preview: digest(preview), version: version.current })
    if (result.kind === 'ok') {
      fastUntil.current = Date.now() + FAST_WINDOW_MS
      justSent.current = requestId
      await load()
      setBusy(false)
      return
    }
    const body = result.kind === 'error' ? (result.body as { error?: string; code?: string; repair?: Repair } | undefined) : undefined
    const retried = repairs.some((r) => r.id === requestId && mayHaveLanded(r))
    const lead = !retried ? 'Not sent' : body?.error === 'send_failed' ? 'Tried again, not sent' : body?.error === 'held' ? 'Tried again, not submitted' : 'Not tried again'
    const code = body?.code ?? (body?.error && REASONS[body.error] ? body.error : undefined)
    const after = retried && body?.error === 'refused' && body.repair ? (AFTER_RETRY[body.repair.state] ?? '') : ''
    const say = (shown: string) =>
      setNotice(
        !retried && body?.repair?.state === 'held'
          ? `Not submitted: ${reasonOf(body.repair.reason)}.`
          : `${lead}: ${code ? reasonOf(code) : explain(result).replace(/\.$/, '')}${shown}.${after}`,
      )
    say('')
    if (body?.error === 'preview_changed' || body?.error === 'draft_moved' || body?.error === 'draft_changed') {
      const shown = version.current
      if ((await load(true)) && version.current !== shown && body.error !== 'draft_changed') say(', so the saved version is shown')
    } else void load()
    setBusy(false)
  }

  const ask = async () => {
    const id = newId('q')
    const asked = question.trim()
    setBusy(true)
    const result = await postReturn<{ code?: string }>('ask', { session, inquiryId: id, question: asked })
    if (result.kind === 'ok') {
      setQuestion('')
      setLookup(null)
      setAsking(false)
      fastUntil.current = Date.now() + FAST_WINDOW_MS
      await load()
      setBusy(false)
      return
    }
    setBusy(false)
    const body = result.kind === 'error' ? (result.body as { code?: string } | undefined) : undefined
    setNotice(`Question not sent: ${body?.code ? reasonOf(body.code) : explain(result)}.`)
    refresh()
  }

  const openAsk = (prefill = replied ? QUESTION_AFTER_REPLY : (brief.failing ?? priorFailure) ? QUESTION_START : status === 'waiting' ? QUESTION_WAITING : QUESTION_CATCH_UP) => {
    setAsking(true)
    if (!question.trim() || question === prefilled.current) {
      prefilled.current = prefill
      setQuestion(prefill)
    }
    requestAnimationFrame(() => {
      const panel = document.getElementById('return-ask')
      const box = panel?.getBoundingClientRect()
      if (box && (box.top < 0 || box.bottom > window.innerHeight)) panel?.scrollIntoView?.({ block: box.height > window.innerHeight ? 'start' : 'nearest' })
    })
  }

  const followUpOn = (missed: string[]) => {
    const text = [`The reply to ${replied?.id} doesn't seem to cover these. Do each, or say why not:`, ...missed.filter((m) => !/^report back:/i.test(m)).map((m) => `- ${m.replace(/^- /, '')}`), REPORT_BACK].join('\n')
    if (out && sentThis) followUpSent(sentThis, text)
    else if (!draft?.text.trim()) update(startDraft(text))
    else {
      const add = draft.text.includes(REPORT_BACK) ? text.replace(`\n${REPORT_BACK}`, '') : text
      if (!draft.text.includes(add)) edit(draft.text.includes(REPORT_BACK) ? draft.text.replace(REPORT_BACK, () => `${add}\n${REPORT_BACK}`) : `${draft.text.trimEnd()}\n\n${add}`)
    }
    setStep('draft')
  }

  const followUpSent = (sent: Repair, text?: string) => {
    setUndoNote(null)
    const base = draft ?? startDraft('')
    const same = base.follows === sent.sentAt
    if (!same || text !== undefined) update({ ...(same ? base : afresh(base)), follows: sent.sentAt, ...(text === undefined ? {} : { text }) })
  }

  const handBack = () => {
    if (out && sentThis) followUpSent(sentThis)
    else if (!draft?.text.trim()) update({ ...startDraft(draftFor(brief)), ...(draft?.quote ? { quote: draft.quote } : {}), ...(draft?.others ? { others: draft.others } : {}) })
    setStep('draft')
  }

  const showRecords = () => {
    const words = (question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP_WORDS.has(w))
    setLookup({ found: entries.filter((e) => words.some((w) => e.text.toLowerCase().includes(w))).slice(-12), words })
  }

  const change = (issue: Issue) => {
    if (!draft) return
    const next = changeIssue(draft.text, issue, newId('r'))
    setUndoNote(null)
    update({ ...draft, text: next.text, corrections: [...draft.corrections, next.correction] })
  }

  const undo = (correction: Correction) => {
    if (!draft) return
    const result = undoCorrection(draft.text, correction)
    if (result.refused) {
      setUndoNote(result.refused)
      return
    }
    setUndoNote(null)
    update({ ...draft, text: result.text, corrections: draft.corrections.filter((x) => x.id !== correction.id) })
  }

  const decide = async (key: string, limitId: string | null) => {
    setData((d) => {
      if (!d) return d
      const decisions = { ...d.state.decisions }
      if (limitId === null) delete decisions[key]
      else decisions[key] = limitId
      return { ...d, state: { ...d.state, decisions } }
    })
    await postReturn('decide', { session, key, limitId })
    refresh()
  }

  const separate = async (member: string, undoIt: boolean, work = data.work.key) => {
    setBusy(true)
    await postReturn('separate', { session, work, member, undo: undoIt })
    setApart({ name: member, back: undoIt })
    await load()
    onStateChanged?.(true)
    setBusy(false)
  }

  const accept = async (r: Repair) => {
    setBusy(true)
    const result = await postReturn<{ accepted?: Repair['accepted']; error?: string }>('accept', { session, requestId: r.id })
    setBusy(false)
    const accepted = result.kind === 'ok' ? result.data.accepted : undefined
    if (accepted) {
      setData((d) => (d ? { ...d, state: { ...d.state, repairs: d.state.repairs.map((x) => (x.id === r.id ? { ...x, accepted } : x)) } } : d))
      onStateChanged?.()
      return
    }
    const body = result.kind === 'error' ? (result.body as { error?: string } | undefined) : undefined
    setNotice(body?.error === 'evidence_changed' ? 'Not accepted: what holds changed after this repair was sent.' : `Not accepted: ${explain(result)}`)
    refresh()
  }

  const preview = draft && target?.transcript ? packetOf(PREVIEW_ID, target.path, session, { text, earlier, quote: draft.quote, others: draft.others, setAside: draft.setAside }, entries, c) : ''
  const quoted = new Set(quotedRules(c, draft?.quote, session))

  const rule = (r: Rule) => (
    <li key={ruleKey(r)}>
      <label>
        <input type="checkbox" checked={quoted.has(r)} aria-label={`Quote “${r.sentence}” in the repair`} onChange={(e) => toggleQuote(r, e.target.checked)} />
        {r.sentence}
        <small>
          {' '}
          · {you(r)}, <When at={r.at} now={now} />
        </small>
      </label>
    </li>
  )

  const toggleQuote = (r: Rule, on: boolean) => {
    const base = draft ?? startDraft('')
    update({ ...base, quote: { ...base.quote, [ruleKey(r)]: on } })
  }

  const failing = brief.failing
  const blank = entries.length === 0 && repairs.length === 0 && data.state.inquiries.length === 0 && !text.trim()
  const goal = data.work.members.find((m) => m.name === session)?.goal
  const settled = Boolean(newest?.accepted) && !failing && status !== 'waiting' && !(text.trim() && !out)
  const lastWord = brief.since ?? brief.stopped
  const said = lastWord ? spoken(lastWord.text, brief) : ''
  const headline = blank
    ? 'Nothing recorded yet'
    : failing
    ? `Check “${checkName(failing.text)}” failed ${ago(now, failing.at)} ago`
    : status === 'waiting'
      ? `${session} is waiting on you${waitingFor ? `: ${waitingFor}` : ''}`
      : replied && !replied.accepted
        ? 'The repair came back. Review it'
        : settled
          ? 'You accepted the result · merge is still yours'
          : status === 'busy'
          ? `${session} is still working`
          : 'The agent finished its turn'
  const lead = blank
    ? `${goal ? `Your goal: “${goal}”. ` : ''}${session} has no records Devbox can read yet. Type in its terminal to start; this page fills in as it records.`
    : failing
    ? (measured(failing.text) ?? clip(firstLines(failing.text).split('\n')[1] ?? '', 200))
    : said
      ? /^\s*\[devbox result /.test(lastWord?.text ?? '')
        ? `The reply says, not checked: “${clip(said, 300)}”`
        : clip(said, 320)
      : 'No agent message recorded yet.'
  const pending = newest && following(newest, running) ? newest : undefined
  const lastCheck = entries.filter((e) => e.kind === 'failure').sort((a, b) => b.at - a.at)[0]
  const sentLast = replied ?? (newest && wentOut(newest) ? newest : undefined)
  const priorFailure = !brief.failing && sentLast && lastCheck && lastCheck.at <= sentLast.sentAt ? lastCheck : undefined
  const failureNote =
    lastCheck && sentLast ? (
      lastCheck.at > sentLast.sentAt ? (
        <p className="return-notice" role="note">
          A check failed after this repair was sent: “{checkName(lastCheck.text)}”, <When at={lastCheck.at} now={now} />.
        </p>
      ) : (
        <p className="lane-empty" role="note">
          The last recorded failure is “{checkName(lastCheck.text)}”, <When at={lastCheck.at} now={now} />, before this repair. Devbox records only failures, so whether the checks pass now is the reply's word, not a check.
        </p>
      )
    ) : null
  const held = holdingOf(brief, session, brief.failing ?? priorFailure, 'in What holds now')
  const holding = [...brief.holds.map((h) => lower(h.limit.shown)), ...held.rules.map((r) => clause(r.sentence)), ...(held.more ? [held.more] : [])]
  const tabs = [
    ...data.work.members.map((m) => ({ name: m.name, kind: data.sessions.find((x) => x.name === m.name)?.agent ?? 'shell' })),
    ...created.filter((c) => !data.work.members.some((m) => m.name === c.name)),
  ]
  const openTab = (name: string) => {
    setOpened((prev) => [...prev.filter((n) => n !== name), name].slice(-3))
    setTab(name)
  }
  const stepTab = (to: Step, name: string) => (
    <button type="button" aria-current={step === to ? 'page' : undefined} onClick={() => setStep(to)}>
      {name}
    </button>
  )

  const receipt = (r: Repair, named = false, ref?: Ref<HTMLDivElement>) => {
    const stale = differences(r.basis, c)
    const later = r.state === 'replied' && replied && replied.id !== r.id ? replied : undefined
    const block = blocks.get(r.id)
    const newer = block === 'superseded' ? newerThan(r, repairs) : undefined
    const s = sessionNamed(r.target.session)
    const there = mayHaveLanded(r) && !lostAt(r) && s?.pane === r.target.pane && conversationOf(s) === r.target.sessionId
    const stopped = newer ? `${newer.id} went out after it` : block && (mayHaveLanded(r) || !DRAFT_SIDE.has(block)) ? STOPPED[block]?.replace('{session}', r.target.session) : undefined
    return (
      <div className="handoff-status" data-state={r.state} role="status" ref={ref}>
        {r.state === 'replied' ? <Icon name="check" /> : r.state === 'failed' || r.state === 'unknown' || r.state === 'held' ? <Icon name="bell" /> : <Icon name="clock" />}
        <div>
          <p>
            <strong className="receipt-state" data-state={r.state}>
              {r.accepted ? `Replied · you accepted it ${ago(now, r.accepted.at)} ago` : later ? `Replied · ${later.id} followed it` : STATE_TITLE[r.state]}
            </strong>
            <span className="when">
              {' '}
              · sent {ago(now, r.sentAt)} ago
              {named ? null : (
                <>
                  {' to '}
                  <Name of={r.target.session} />
                </>
              )}
            </span>
          </p>
          {r.state === 'sending' ? <p>Pasting into {r.target.session}'s prompt. Waiting for the conversation to show it.</p> : null}
          {(r.state === 'delivered' || r.state === 'working') && followable(r, running) ? (
            <p>It's in the conversation and comes back under Needs you when the agent replies, so you can leave now. Handing it over isn't the same as done, and Devbox merges nothing.</p>
          ) : null}
          {(r.state === 'delivered' || r.state === 'working') && !followable(r, running) ? (
            <p>Devbox can't see its conversation in {r.target.session} now, so it can't follow the reply.</p>
          ) : null}
          {wentOut(r) ? (
            <p className="lane-empty">
              Asked for edits in {data.sessions.find((x) => x.name === r.target.session)?.path ?? 'its folder'} and the tests needed to check them · no merge, push or deploy. Requested in the message, not enforced by Devbox.
            </p>
          ) : null}
          {r.state === 'failed' ? <p>Not sent: {reasonOf(r.reason)}.{r === attempt && !dirty && !why ? ' Sending this draft tries it again.' : ''}</p> : null}
          {r.state === 'held' ? <p>Not submitted: {reasonOf(r.reason)}.</p> : null}
          {r.state === 'unknown' ? <p>Delivery unknown: {unknownText(r.reason, Boolean(newer))}</p> : null}
          {later ? (
            <details className="quiet">
              <summary>Show its reply</summary>
              <blockquote className="record-text">{r.reply}</blockquote>
            </details>
          ) : r.state === 'replied' ? (
            <p>
              {r.accepted ? `You accepted this result ${ago(now, r.accepted.at)} ago.` : stale.length ? 'It was made before what holds changed.' : 'The reply is under Result & acceptance.'}{' '}
              <button type="button" className="link" onClick={() => setStep('result')}>
                Review the reply
              </button>
            </p>
          ) : null}
          {r.state === 'held' && !block ? <p>Open {r.target.session}'s terminal to send it, or clear the prompt and try again.</p> : null}
          {block === 'no_registry' && mayHaveLanded(r) ? <p>Devbox can't see the conversation in {r.target.session} right now, so it can't try this again yet.</p> : null}
          {stopped ? (
            <p>
              {stopped}, so Devbox won't try this one again.{there ? ` If it is still in ${r.target.session}'s prompt, clear it there.` : ''}{block === 'basis_changed' || (block === 'other_conversation' && mayHaveLanded(r)) ? ' Edit the draft to send it again.' : ''}
            </p>
          ) : null}
          {!block && !dirty && mayHaveLanded(r) ? (
            <button type="button" disabled={busy} onClick={() => void send(r.id)}>
              Try again
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  const gapsOf = (q: Inquiry) => unmentioned(askedParts(q.question).join('\n'), q.answer ?? '').filter((p) => p.split(/\s+/).length > 1)
  const offTopic = (q: Inquiry) => {
    const main = askedParts(q.question)[0]
    return main !== undefined && gapsOf(q).includes(main)
  }
  const answered = (q: Inquiry) => {
    const gaps = gapsOf(q)
    const twin = data.state.inquiries.find((o) => o.id !== q.id && o.state === 'replied' && o.answer?.trim() === q.answer?.trim())
    return (
      <>
        <p className="answer-label">
          <strong>An answer, not verified</strong> · a read-only copy of this conversation wrote it (Read, Grep, Glob), and nothing was run to check it. The original session didn't see this question.
          {q.cost !== undefined ? ` Cost $${q.cost.toFixed(2)}.` : ''}
        </p>
        <p className="record-text">{q.answer}</p>
        {gaps.length ? (
          <p className="lane-empty">
            {offTopic(q) ? 'The answer may not address your question; it shares too few of its words.' : `The answer doesn't seem to cover ${gaps.map((l) => `“${l}”`).join(', ')}.`}{' '}
            <button type="button" className="link" onClick={() => openAsk(`${gaps.join('? ')}?`)}>
              Ask about that part
            </button>
          </p>
        ) : null}
        {twin && (gaps.length > 0 || gapsOf(twin).length === 0) ? <p className="return-notice">It's word for word the answer to “{twin.question}”, so it may not answer this question.</p> : null}
      </>
    )
  }

  const askPanel =
    asking || data.state.inquiries.length ? (
      <section id="return-ask" className="return-ask" aria-labelledby="return-ask-title">
        <div className="ask-head">
          <h3 id="return-ask-title">Ask (read-only)</h3>
          {asking ? (
            <button type="button" className="link" onClick={() => setAsking(false)}>
              Close
            </button>
          ) : (
            <button type="button" className="link" onClick={() => openAsk()}>
              Ask another question
            </button>
          )}
        </div>
        {asking ? (
          <>
            <p className="authorization-summary">
              Not sent yet · {data.questionBudgetUsd === undefined ? 'budget unavailable' : `requested spending limit $${data.questionBudgetUsd}`}
              <small>Passed to the question runner; actual usage is reported with the answer.</small>
              <small>
                {'A read-only copy of the conversation answers here, reading files only. Session '}
                <Name of={session} />
                {` never sees the question${text.trim() ? ', and your draft stays out of it' : ''}.`}
              </small>
            </p>
            <label className="field">
              Your question
              <textarea rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} />
            </label>
            <details className="return-preview">
              <summary>See what will be sent</summary>
              <pre>{questionPrompt({ id: 'q-(new)', cwd: target?.path ?? '', question: question.trim() })}</pre>
            </details>
            <div className="flow-actions">
              <button type="button" className="primary" disabled={!canAct || !question.trim() || busy || data.questionBudgetUsd === undefined} onClick={() => void ask()}>
                Send only the question
              </button>
              <button type="button" className="link" disabled={!question.trim()} onClick={showRecords}>
                Or search saved records (free)
              </button>
            </div>
            {lookup ? (
              <div className="return-lookup">
                <p className="return-notice">
                  {(() => {
                    const has = (w: string) => entries.some((e) => e.text.toLowerCase().includes(w))
                    const quote = (ws: string[]) => ws.map((w) => `“${w}”`).join(', ')
                    const found = lookup.words.filter(has)
                    const none = lookup.words.filter((w) => !has(w))
                    return `${found.length ? `Records that mention ${quote(found)}. ` : ''}${none.length ? `No saved record mentions ${quote(none)}. ` : ''}The question isn't answered or verified.`
                  })()}
                </p>
                <ul className="return-list">
                  {lookup.found.map((e) => (
                    <Source key={`lookup:${e.session}:${e.id}`} entry={{ ...e, text: clip(e.text, 400) }} now={now} replacedBy={lowerOf(c.holds.find((h) => h.replaced.some((l) => l.recordId === e.id))?.limit.shown)} />
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
        <ul className="return-list">
          {[...data.state.inquiries]
            .sort((a, b) => b.askedAt - a.askedAt)
            .map((q, i) => (
              <li key={q.id} id={`answer-${q.id}`} className="inquiry" data-state={q.state}>
                <p className="inquiry-question">{q.question}</p>
                <p className="when">
                  {q.state === 'replied'
                    ? offTopic(q)
                      ? 'answered · may not address your question'
                      : gapsOf(q).length
                        ? 'answered · may miss part of your question'
                        : 'answered'
                    : q.state === 'failed'
                      ? `failed: ${reasonOf(q.reason)}`
                      : q.state === 'unknown'
                        ? 'no answer yet, still checking'
                        : `running in a read-only copy of ${q.target.session}…`}{' '}
                  · asked {ago(now, q.askedAt)} ago
                </p>
                {q.state === 'replied' && i > 0 ? (
                  <details className="quiet">
                    <summary>Show the answer · not verified</summary>
                    {answered(q)}
                  </details>
                ) : null}
                {q.state === 'replied' && i === 0 ? answered(q) : null}
              </li>
            ))}
        </ul>
      </section>
    ) : null

  const linked = (at: string) => (
    <>
      <section className="return-area" aria-labelledby={`${at}-work`}>
        <h4 id={`${at}-work`}>In this work</h4>
        <ul className="return-members">
          {data.work.members.map((m) => (
            <li key={m.name}>
              <span className="member-name">{m.name}</span>
              <span className="when"> · {m.name === session ? "the work's main session; repairs and questions go here" : m.reason}</span>
              {m.goal ? <small className="member-goal">Your goal when you started it: “{m.goal}”</small> : null}
              {m.name !== session ? (
                <button type="button" className="link" disabled={busy} onClick={() => void separate(m.name, false)}>
                  Show {m.name} separately
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      {(data.lookalikes ?? []).length || data.separated.length ? (
        <section className="return-area" aria-labelledby={`${at}-kept`}>
          <h4 id={`${at}-kept`}>Kept separate</h4>
          <ul className="return-members">
            {data.separated.map((x) => (
              <li key={x.session}>
                <span className="member-name">{x.session}</span>
                <span className="when"> · you showed it separately </span>
                <button type="button" className="link" disabled={busy} aria-label={`Undo: show ${x.session} in this work again`} onClick={() => void separate(x.session, true)}>
                  Undo
                </button>
              </li>
            ))}
            {data.lookalikes.map((l) => (
              <li key={l.name}>
                <span className="member-name">{l.name}</span>
                <span className="when">
                  {' '}
                  · not in this work:{' '}
                  {l.why === 'branch'
                    ? `also on branch ${l.branch ?? ''}, but in a different repository (${l.repo ?? l.path})`
                    : `same folder name, but not the same branch in the same repository (${l.path})`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
  const evidence = ledger(
    data.work.members.map((m) => ({ name: m.name, artifacts: insights?.get(m.name)?.artifacts ?? [] })),
    20,
    10,
  ).filter((a, i, all) => all.findIndex((o) => o.url === a.url) === i)
  const files = data.work.members.flatMap((m) => {
    const cwd = data.sessions.find((x) => x.name === m.name)?.path ?? ''
    return (insights?.get(m.name)?.files ?? []).filter((f) => !f.gone).map((f) => ({ ...f, session: m.name, cwd, label: m.name }))
  })
  const records = (
    <>
      <nav className="more-tabs" aria-label="Records">
        {(
          [
            ['evidence', `Results & evidence`, evidence.length + files.length + (lastCheck ? 1 : 0)],
            ['linked', 'Linked sessions', data.work.members.length],
            ['run', 'History', 0],
          ] as const
        ).map(([key, name, n]) => (
          <button key={key} type="button" aria-current={more === key ? 'page' : undefined} onClick={() => setMore(key)}>
            {name}
            {n ? <span className="lane-count">{n}</span> : null}
          </button>
        ))}
      </nav>
      {more === 'evidence' ? (
        <section className="return-area" aria-label="Results and evidence">
          <p className="lane-empty">What the agents named and wrote in this work, newest first, each with the session that named it. Devbox doesn't verify any of them.</p>
          {lastCheck ? (
            <ul className="return-list">
              <Source entry={lastCheck} now={now} />
            </ul>
          ) : null}
          {evidence.length ? <ArtifactList artifacts={evidence} now={now} /> : null}
          {files.length ? <FileList files={files} now={now} onPick={setPeek} /> : null}
          {evidence.length || files.length || lastCheck ? null : <p className="lane-empty">No pull requests, reviews, checks or files in this work's records yet.</p>}
        </section>
      ) : null}
      {more === 'linked' ? linked('more') : null}
      {more === 'run' ? (
        <>
          <section className="return-area" aria-labelledby="return-stopped">
            <h4 id="return-stopped">Where you stopped</h4>
            <ul className="return-list">
              {lastYou ? <Source entry={lastYou} now={now} replacedBy={lowerOf(c.holds.find((h) => h.replaced.some((l) => l.recordId === lastYou.id))?.limit.shown)} /> : null}
              {lastAgent ? <Source entry={lastAgent} now={now} /> : null}
            </ul>
            {!lastYou && !lastAgent ? <p className="lane-empty">No messages recorded before your last visit.</p> : null}
            {target?.dropped ? <p className="lane-empty">Older messages weren't loaded: {Object.entries(target.dropped).map(([k, n]) => `${n} ${k}`).join(', ')}.</p> : null}
          </section>
          <section className="return-area" aria-labelledby="return-since">
            <h4 id="return-since">
              Since you left <span className="lane-count">{since.length}</span>
            </h4>
            {leftAt === undefined ? <p className="lane-empty">First visit: everything recorded so far is under Where you stopped.</p> : null}
            {leftAt !== undefined && since.length === 0 ? <p className="lane-empty">Nothing new since your last visit.</p> : null}
            <ul className="return-list">
              {since.map((e) => (
                <Source key={`${e.session}:${e.id}`} entry={e} now={now} replacedBy={lowerOf(c.holds.find((h) => h.replaced.some((l) => l.recordId === e.id))?.limit.shown)} />
              ))}
            </ul>
            {since.some((e) => e.kind === 'failure') ? <p className="lane-empty">Only tool errors are listed, not the tool calls that worked, so a later attempt may have succeeded.</p> : null}
          </section>
          <details className="return-rules">
            <summary>How Devbox reads constraints</summary>
            <p>
              Devbox quotes limits written as a bound, a number and a unit, such as “at most 2 attempts” or “no more than 10 seconds”, and sentences with never, do not, only,
              must, always, or “on the same” and the like. A newer message takes the place of an older value only when it says so, with words like “instead of”. Nothing is inferred or summarized by a
              model. Constraints worded differently might be missing.
            </p>
          </details>
        </>
      ) : null}
    </>
  )
  const inWorkSessions = data.sessions.filter((x) => data.work.members.some((m) => m.name === x.name))
  const places: Place[] = inWorkSessions
    .filter((x, i) => inWorkSessions.findIndex((o) => o.path === x.path) === i)
    .sort((x, y) => Number(y.name === session) - Number(x.name === session))
    .map((x) => {
      const joins = Boolean(x.repo && x.branch && !DEFAULT_BRANCHES.has(x.branch))
      return {
        key: x.name,
        label: `${x.path} · where ${x.name} runs`,
        stem: x.name,
        join: joins ? (title ?? session) : null,
        why: joins
          ? `same branch ${x.branch} in ${x.repo?.split('/').filter(Boolean).pop() ?? x.repo}`
          : `${x.name}'s folder is ${x.branch ? `on ${x.branch}` : 'on no branch Devbox can read'}, so it won't group by itself`,
        caveat: (flag) => `It starts a new conversation in ${x.name}'s folder; repairs still go to ${x.name}. One catch: if ${x.name} is ever restarted with devbox --${flag}, it reopens the newest conversation in that folder, which may be this new one. Pick a separate folder to avoid that.`,
        at: { beside: x.name },
      }
    })
  const sources = (
    <details className="return-more" open={moreOpen} onToggle={(e) => setMoreOpen(e.currentTarget.open)}>
      <summary id="return-more">Full results, history and linked sessions · when you need them</summary>
      {records}
    </details>
  )
  const whyPop = whyOpen ? (
    <div className="why-pop" role="dialog" aria-label="Why these sessions are together" tabIndex={-1} ref={whyRef} onKeyDown={(e) => e.key === 'Escape' && setWhyOpen(false)} onBlur={(e) => e.currentTarget.contains(e.relatedTarget as Node | null) || (e.relatedTarget as Element | null)?.closest('[data-why]') || setWhyOpen(false)}>
      <div className="why-head">
        <h3>{data.work.members.length === 1 ? 'Why it’s on its own' : 'Why these are together'}</h3>
        <button type="button" className="icon-button" aria-label="Close" onClick={() => setWhyOpen(false)}>
          <Icon name="x" />
        </button>
      </div>
      <p>
        Devbox groups sessions that share a pull request, or the same repository on the same branch that isn't the default one. The same folder name alone doesn't make one work.
        {data.work.members.length === 1 ? ` No other session shares one with ${session}.` : ''}
      </p>
      {linked('why')}
      <p className="lane-empty">Showing a session separately doesn't change the session. Devbox remembers it here, and you can undo it.</p>
    </div>
  ) : null
  return (
    <section className="return" aria-label={`Pick up ${session}`}>
      {onSwitch ? <PickUpRail items={works.map((w) => (w.session.name === session && w.brief ? { ...w, brief: { ...w.brief, work: data.work } } : w))} current={session} others={elsewhere} open={{ title: title ?? session, members, status: here ?? (brief.failing ? 'Check failed' : status === 'waiting' ? 'Waiting on you' : 'Viewed · not accepted') }} onAll={onAll} onSwitch={(name) => void (name === session ? undefined : leave(() => onSwitch(name, inWork(), true), `rail:${name}`, 'Choose it again'))} /> : null}
      <div className="return-main" data-tab={tab === 'changes' ? undefined : tab === 'new' ? 'new' : 'terminal'}>
        <div className="return-top">
          <button type="button" className="link return-back" onClick={() => void close()}>
            <Icon name="back" />
            Back to {back}
          </button>
        </div>
        <h2 className="return-name">{tab === 'new' ? `Add a session to ${title ?? session}` : (title ?? session)}</h2>
        <p className="return-sub">
          {tab === 'new' ? `${session} keeps running while you add a session.` : [label, members === 1 ? '1 session' : `${members} sessions grouped automatically`, data.separated.length ? `${data.separated.length} you showed separately` : ''].filter(Boolean).join(' · ')}{' '}
          <button
            type="button"
            className="icon-button"
            aria-label="Why these sessions are together"
            aria-expanded={whyOpen}
            data-why
            onClick={() => setWhyOpen(!whyOpen)}
          >
            <Icon name="info" size={14} />
          </button>
        </p>
        {whyPop}
        {apart?.back ? (
          <p className="return-notice" role="status">
            {apart.name} is back in this work.
          </p>
        ) : apart ? (
          <p className="return-notice" role="status">
            {apart.name} is shown separately now. It keeps running and its records don't change.{' '}
            <button type="button" className="link" disabled={busy} onClick={() => void separate(apart.name, true)}>
              Undo
            </button>
          </p>
        ) : data.apart ? (
          <p className="return-notice" role="status">
            You showed {session} separately from the work on {workLabel(data.apart)}.{' '}
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() =>
                void separate(session, true, data.apart).then(() => {
                  const main = works.find((w) => w.brief?.work.key === data.apart)?.session.name
                  if (main && main !== session && onSwitch) void leave(() => onSwitch(main, inWork(), true), `rail:${main}`, 'Choose it again')
                })
              }
            >
              Undo
            </button>
          </p>
        ) : null}
        <p className="lane-empty return-busy" role="status">
          {busy ? 'Updating from the host…' : ''}
        </p>
        {failure ? (
          <p className="return-notice" role="status">
            Showing what was read {ago(now, Math.floor(data.fetchedAt / 1000))} ago: {failure}
          </p>
        ) : null}
        {tab !== 'changes' && notice ? (
          <p className="return-notice" role="status">
            {notice}
          </p>
        ) : null}
        <nav className="work-tabs" aria-label="In this work">
          <button type="button" aria-current={tab === 'changes' ? 'page' : undefined} onClick={() => setTab('changes')}>
            Changes & decisions
          </button>
          {tabs.map((t) => (
            <button key={t.name} type="button" aria-current={tab === t.name ? 'page' : undefined} onClick={() => openTab(t.name)}>
              <AgentIcon agent={t.kind} />
              <span className="work-tab-name" title={t.name}>
                {t.name}
              </span>
            </button>
          ))}
          <button type="button" aria-current={tab === 'new' ? 'page' : undefined} onClick={() => setTab('new')}>
            <Icon name="plus" size={14} />
            New session
          </button>
        </nav>
        <div className="work-split">
        {opened.map((name) => {
          const goal = data.work.members.find((m) => m.name === name)?.goal
          const asks = insights?.get(name)?.state === 'waiting' ? insights.get(name) : undefined
          return (
            <section key={name} className="work-terminal" hidden={tab !== name} aria-label={`${name} terminal`}>
              {asks ? (
                <p className="return-notice" role="status">
                  {name} is waiting for you{asks.waitingFor ? ` (${asks.waitingFor})` : ''}
                  {asks.summary ? `: “${clip(asks.summary)}”` : ''}. Type your answer at its prompt below; Devbox doesn't type into a waiting prompt.
                </p>
              ) : null}
              <div className="hold-bar" role="note">
                <strong>Keeps holding while you continue</strong>
                <p>{holding.length ? holding.join(' · ') : 'No limit or rule recorded yet.'}</p>
                {goal ? <p className="member-goal">Your goal when you started {name}: “{goal}”</p> : null}
                <small>
                  What you type here goes straight to {name} and isn't checked against these{canAct || name !== session ? '. A repair from the draft is checked' : ''}.{' '}
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      setOpened((prev) => prev.filter((n) => n !== name))
                      setTab('changes')
                      onOpenTerminal(name)
                    }}
                  >
                    Open the full-screen terminal
                  </button>
                </small>
              </div>
              <TerminalPane
                name={name}
                active={active && tab === name}
                lead={
                  <>
                    {name}
                    <span className="terminal-lead">
                      {' · '}
                      {STATE_WORD[insights?.get(name)?.state ?? ''] ?? 'idle'} · {data.host} · {data.sessions.find((x) => x.name === name)?.path ?? ''}
                    </span>
                  </>
                }
              />
            </section>
          )
        })}
        {tab !== 'changes' && tab !== 'new' ? (
          <aside className="work-records" aria-label="This work's records">
            {records}
          </aside>
        ) : null}
        </div>
        {tab === 'new' ? (
          <NewSession
            places={places}
            taken={[...data.sessions.map((x) => x.name), ...created.map((c) => c.name)]}
            host={data.host}
            label="New session in this work"
            join="Joins"
            done="Nothing is typed into it; it opens in its own tab here."
            context={(place) => (
              <>
                <div className="context-card">
                  <Icon name="pr" />
                  <span>
                    <strong>{title ?? session}</strong>
                    <small>{label || `${members} session${members === 1 ? '' : 's'}`}</small>
                  </span>
                </div>
                <p className="context-live">
                  <span className="dot" aria-hidden="true" /> {place?.stem ?? session} keeps running
                </p>
              </>
            )}
            onCreated={(name, kind) => {
              setCreated((prev) => [...prev, { name, kind }])
              openTab(name)
              onSessionsChanged?.()
              refresh()
            }}
            onCancel={() => setTab('changes')}
          />
        ) : null}
        {tab === 'changes' ? (
          <>
            {pending && step !== 'draft' ? (
              <div className="return-banner" role="status">
                <Icon name="quote" />
                <div>
                  <strong>
                    {PENDING_TITLE[pending.state]} {pending.target.session}
                  </strong>
                  <p>The decision and its evidence went to {pending.target.session}'s conversation. Devbox follows its reply; you don't need to do anything now.</p>
                </div>
              </div>
            ) : null}
            <p className="return-baseline">
              <span>
                {leftAt !== undefined && !blank ? (
                  <span title={stamp(leftAt)}>
                    {data.state.lookedAt !== undefined && data.state.lookedAt > leftAt ? `You looked here ${ago(now, data.state.lookedAt)} ago, this visit · the visit before ended ${day(leftAt)}, ${ago(now, leftAt)} ago` : `Your last visit here ended · ${day(leftAt)}, ${ago(now, leftAt)} ago`}
                  </span>
                ) : (
                  'First visit'
                )}
              </span>
              <span>
                Repairs go to session <Name of={session} />
              </span>
            </p>
            <nav className="return-steps" aria-label="Steps">
              {stepTab('changes', 'Changes & next step')}
              {stepTab('result', 'Result & acceptance')}
              {text.trim() || repairs.length ? stepTab('draft', out ? 'Handoff receipt' : 'Handoff draft') : null}
            </nav>
            {notice ? (
              <p className="return-notice" role="status">
                {notice}
              </p>
            ) : null}
            {step === 'changes' ? (
              <>
                <Undecided c={c} you={you} onDecide={(key, id) => void decide(key, id)} onCheck={openAsk} />
                {blank ? null : <RecoveryBrief brief={brief} c={c} session={session} now={now} onOpen={onOpenTerminal} after={since} compact={asking} stated lastFailure={priorFailure} asked={insights?.get(session)?.firstAsk ?? insights?.get(session)?.ask} lastSaid={entries.filter((e) => (e.kind === 'decision' || e.kind === 'devbox') && e.session === session).sort((a, b) => a.at - b.at).at(-1)} repairs={repairs} />}
                <section className="return-next" aria-labelledby="return-next">
                  <div className="next-row">
                    <div className="next-main">
                      <h3 id="return-next">{headline}</h3>
                      {lead ? <p className="next-lead">{lead}</p> : null}
                      {sinceLeft(brief).map((x) => {
                        const p = namedRule(x, c.rules)
                        return p ? (
                          <p key={x.id} className="next-suggestion" title={x.sentence}>
                            The agent suggested “{x.shown}” <When at={x.at} now={now} /> · your rule: “{p.clause}”
                          </p>
                        ) : null
                      })}
                    </div>
                    {replied && !replied.accepted && !pending ? (
                      <button type="button" className="primary" onClick={() => setStep('result')}>
                        Review the reply
                        <Icon name="next" />
                      </button>
                    ) : blank ? (
                      <button type="button" className="primary" onClick={() => openTab(session)}>
                        Open {session}'s terminal
                        <Icon name="next" />
                      </button>
                    ) : pending || (out && !settled) ? (
                      <button type="button" className="primary" onClick={() => setStep('draft')}>
                        See the handoff receipt
                        <Icon name="next" />
                      </button>
                    ) : (
                      <div className="next-cta">
                        {status === 'waiting' ? (
                          <>
                            <button type="button" className={asking ? undefined : 'primary'} onClick={() => openTab(session)}>
                              Answer in {session}'s terminal
                              <Icon name="next" />
                            </button>
                            <small>
                              {session} is waiting for you in its terminal{waitingFor ? ` (${waitingFor})` : ''}. Devbox doesn't type into a waiting prompt.
                            </small>
                          </>
                        ) : null}
                        {settled ? (
                          <button type="button" className={asking ? undefined : 'primary'} onClick={() => void close()}>
                            Back to Now
                            <Icon name="next" />
                          </button>
                        ) : null}
                        <button type="button" className={asking || status === 'waiting' || settled ? undefined : 'primary'} disabled={!canAct} onClick={handBack}>
                          {text.trim() && !out ? 'Continue the unsent draft' : status === 'waiting' ? 'Draft the next step for after you answer' : settled ? 'Hand back another repair' : 'Hand back to the agent to repair'}
                          <Icon name="next" />
                        </button>
                        <small>Opens an editable draft. Nothing is sent yet.</small>
                        <div className="flow-actions">
                          {asking ? null : (
                            <button type="button" className="link" onClick={() => openAsk()}>
                              Ask first (read-only)
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  {failing ? (
                    <article className="next-evidence" aria-label="The failed check">
                      <p className="evidence-head">
                        <Icon name="file" size={14} />
                        <strong>failed check</strong> · <Name of={failing.session} /> · <When at={failing.at} now={now} />
                      </p>
                      <pre>{firstLines(failing.text, 3)}</pre>
                      {failing.text.split('\n').filter((l) => l.trim()).length > 3 ? (
                        <details className="quiet">
                          <summary>Show the whole check as recorded</summary>
                          <pre>{failing.text}</pre>
                        </details>
                      ) : null}
                      <p className="lane-empty">
                        Only tool errors are recorded, not the calls that worked, so it may have passed since.{' '}
                        <button type="button" className="link" onClick={() => (data.work.members.some((m) => m.name === failing.session) ? openTab(failing.session) : onOpenTerminal(failing.session))}>
                          Show it in {failing.session}
                        </button>
                      </p>
                    </article>
                  ) : (
                    failureNote
                  )}
                </section>
                {askPanel}
                <details className="return-log">
                  <summary>This work's change log</summary>
                  <ul className="return-list">
                    {(leftAt === undefined ? entries : since).slice(-12).map((e) => (
                      <Source key={`log:${e.session}:${e.id}`} entry={e} now={now} above={e.id === failing?.id} />
                    ))}
                  </ul>
                </details>
              </>
            ) : null}
            {step === 'result' ? (
              <section className="return-result" aria-labelledby="return-result">
                <details className="return-recap">
                  <summary>
                    <span className="recap-basis">What this is based on</span> show the reasons and sources
                  </summary>
                  <RecoveryBrief brief={brief} c={c} session={session} now={now} onOpen={onOpenTerminal} lastFailure={priorFailure} />
                </details>
                <h3 id="return-result">{replied?.accepted ? 'You accepted this result · merge is still yours' : replied ? 'Check the reply, and decide whether this round is done' : 'The current result and what you asked'}</h3>
                <p className="next-lead">
                  {replied?.accepted
                    ? `You accepted it ${ago(now, replied.accepted.at)} ago. That records that you read the reply; it doesn't merge, push or close anything.`
                    : replied
                      ? "This is the agent’s report, not verified test evidence. Check the reply and its sources; unchanged limits and optional wording hints are folded below."
                      : 'No repair has come back yet. You can hand back a repair or ask first; only accepting needs a full check.'}
                </p>
                {replied ? (
                  <article id="return-reply" className="return-evidence" data-kind="reply" aria-label="The reply">
                    <p className="evidence-head">
                      <Icon name="quote" />
                      <strong>reply</strong> · {replied.target.session} · <When at={replied.repliedAt ?? replied.sentAt} now={now} />
                    </p>
                    <blockquote className="record-text">{replied.reply}</blockquote>
                    {replied.reply?.includes(`[devbox result ${replied.id}]`) ? null : (
                      <p className="return-notice">It doesn't start with “[devbox result {replied.id}]” as the repair asked, so it may answer something else. Read it in the session before you accept.</p>
                    )}
                    {previous && previous.reply?.trim() === replied.reply?.trim() ? (
                      <p className="return-notice">
                        It's word for word the reply to the previous repair, sent {ago(now, previous.sentAt)} ago. It may not be about this one.
                      </p>
                    ) : null}
                    <button type="button" className="secondary" onClick={() => onOpenTerminal(replied.target.session)}>
                      Show it in the session
                    </button>
                  </article>
                ) : null}
                {replied && asked ? (
                  <article className="return-evidence" data-kind="asked" aria-label="What you asked">
                    <details className="return-preview">
                      <summary>Compare with the request · optional wording hints</summary>
                    <p className="evidence-head">
                      <Icon name="quote" />
                      <strong>what you asked</strong> · sent <When at={replied.sentAt} now={now} /> · Devbox doesn't check that the reply did these; it flags what the reply doesn't seem to mention
                    </p>
                    <ul className="asked-lines">
                      {askedFor.map((line, i) => {
                        const near = nearest[i]
                        return (
                          <li key={i}>
                            <span>{line}</span>
                            {unsaid.has(line) ? (
                              <small className="asked-none">{flagNote(line, reply, context, loose[i])}</small>
                            ) : near ? (
                              <small>Not checked · nearest in the reply: “{near}”</small>
                            ) : (
                              <small>Not checked · read the reply for this.</small>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                    {NO_CHANGE.test(replied.reply ?? '') ? <p className="return-notice">The reply says nothing was changed.</p> : null}
                    {missing.length ? (
                      <button type="button" className="link" onClick={() => followUpOn(missing)}>
                        Draft a follow-up for what it may have missed
                      </button>
                    ) : null}
                    </details>
                  </article>
                ) : null}
                {replied && attached.length ? (
                  <article className="return-evidence" data-kind="asked" aria-label="Evidence you attached">
                    <p className="evidence-head">
                      <Icon name="quote" />
                      <strong>evidence you attached</strong> · other sessions' messages, quoted as written
                    </p>
                    <ul className="asked-lines">
                      {attached.map((a, i) => (
                        <li key={i}>
                          <span>
                            {a.from}: “{a.text}”
                          </span>
                          {a.missed.length ? (
                            <small className="asked-none">
                              The reply doesn't seem to mention {a.missed.map((x) => `“${x}”`).join(', ')}.
                              {a.flagged.length ? ` It doesn't seem to mention ${a.flagged.map((x) => `“${x}”`).join(' or ')} either; ${a.flagged.length > 1 ? "they're" : "it's"} flagged above, in what you asked.` : ''}
                            </small>
                          ) : a.flagged.length ? (
                            <small className="asked-none">
                              The reply doesn't seem to mention {a.flagged.map((x) => `“${x}”`).join(' or ')} either; {a.flagged.length > 1 ? "they're" : "it's"} flagged above, in what you asked.
                            </small>
                          ) : (
                            <small>Not checked · read the reply for it.</small>
                          )}
                        </li>
                      ))}
                    </ul>
                  </article>
                ) : null}
                {replied && differences(replied.basis, c).length ? <p className="return-notice">Changed since this request: {differences(replied.basis, c).map(changeText).join('; ')}.</p> : null}
                <details className="return-preview">
                  <summary>{replied && !differences(replied.basis, c).length ? 'Recorded limits unchanged · inspect basis and verification limits' : 'Inspect recorded basis and verification limits'}</summary>
                <ul className="acceptance-list">
                  {c.holds
                    .filter((h) => !h.decided)
                    .map((h) => {
                      const moved = replied ? differences(replied.basis, c).some((d) => d.key === h.key) : false
                      return (
                        <li key={h.key}>
                          <span>{lower(h.limit.shown)}</span>
                          <b data-state={!replied ? 'none' : moved ? 'changed' : 'same'}>{!replied ? 'not checked by Devbox' : moved ? 'changed after it was sent' : 'same as when it was sent'}</b>
                        </li>
                      )
                    })}
                  {c.rules.map((r) => {
                    const tag = r !== checkedRule((failing ?? priorFailure)?.text, c.rules) ? '' : failing && !replied ? 'failing check · ' : priorFailure || failing ? 'failed before the repair · ' : ''
                    return (
                      <li key={ruleKey(r)}>
                        <span>{r.sentence}</span>
                        <b data-state={tag ? 'changed' : 'none'}>
                          {tag}not checked by Devbox
                        </b>
                      </li>
                    )
                  })}
                  <li>
                    <span>Merging, pushing or deploying</span>
                    <b data-state="none">{replied ? "not done by Devbox; the repair told the agent not to, and Devbox can't see whether it did" : 'Devbox never does it'}</b>
                  </li>
                </ul>
                </details>
                {replied ? failureNote : null}
                {replied && (evidence.length || files.length) ? <details className="return-preview">
                  <summary>Open referenced files and artifacts · {evidence.length + files.length}</summary>
                  <p className="lane-empty">Current files and links from this work, not a snapshot of this reply or proof that its checks passed.</p>
                  {evidence.length ? <ArtifactList artifacts={evidence} now={now} /> : null}
                  {files.length ? <FileList files={files} now={now} onPick={setPeek} /> : null}
                </details> : null}
                {replied && !replied.accepted
                  ? (() => {
                      const stale = differences(replied.basis, c)
                      const moved = stale.find((d) => d.change === 'value')
                      return (
                        <div className="accept-inline">
                          {moved?.before?.value !== undefined && moved.after ? (
                            <p className="lane-empty">
                              This result was made under {limitText(moved.key, moved.before.value)}; {lower(moved.after.shown)} holds now.
                            </p>
                          ) : stale.length ? (
                            <p className="lane-empty">This result was made before these changes: {stale.map(changeText).join('; ')}.</p>
                          ) : (
                            <p className="lane-empty">Accepting records that you read the reply and accept this round. It doesn't merge, push or close anything.</p>
                          )}
                          <button type="button" className="secondary" disabled={stale.length > 0 || busy} onClick={() => void accept(replied)}>
                            Accept this result
                          </button>
                          {missing.length ? <small className="lane-empty">Accept only if the evidence is enough for you. Wording hints stay in the history and do not decide completion.</small> : null}
                        </div>
                      )
                    })()
                  : null}
                {replied?.accepted ? <p className="lane-empty">You accepted this result {ago(now, replied.accepted.at)} ago.</p> : null}
                {askPanel}
                <div className="next-decision">
                  <strong>What next</strong>
                  <div className="flow-actions">
                    <button type="button" className={replied && !replied.accepted ? undefined : 'primary'} disabled={!canAct} onClick={handBack}>
                      {text.trim() && !out ? 'Continue the unsent draft' : 'Hand back to the agent to repair'}
                      <Icon name="next" />
                    </button>
                    <button type="button" onClick={() => openAsk()}>
                      Ask first (read-only)
                    </button>
                  </div>
                </div>
              </section>
            ) : null}
            {step === 'draft' ? (
              <section className="return-draft" aria-labelledby="return-draft">
                {askPanel}
                <h3 id="return-draft">
                  {out && attempt ? (
                    attempt.state === 'replied' || attempt.state === 'working' || attempt.state === 'delivered' ? (
                      <>
                        Handed back to session <Name of={attempt.target.session} />
                      </>
                    ) : (
                      'Handing it over to the original agent'
                    )
                  ) : (
                    'Repair draft · not sent'
                  )}
                </h3>
                {!out ? (
                  <section className="draft-review" aria-label="Checked against what holds now">
                    {retarget && current && draft ? (
                      <section className="return-changed">
                        <p>
                          {draft.target ? `This draft was written for an earlier conversation in ${session}. A different conversation runs there now.` : `This draft doesn't name a conversation in ${session} yet.`}
                        </p>
                        <button type="button" onClick={() => update({ ...draft, target: current })}>
                          Use the conversation running now
                        </button>
                      </section>
                    ) : null}
                    <div className="delta-title">
                      <h4>
                        {cards.length
                          ? `${cards.length} line${cards.length === 1 ? '' : 's'} flagged${findings > 0 && findings + unread.length > cards.length ? ` · ${findings + unread.length} findings` : ''}${unread.length ? ` · ${unread.length} amount${unread.length === 1 ? '' : 's'} Devbox can't check` : ''}`
                          : changed.length
                            ? 'What holds changed · your text is kept'
                            : keptCount
                              ? `Nothing flagged in the limits Devbox checks, but for ${keptCount} line${keptCount === 1 ? '' : 's'} kept as an earlier comparison`
                              : 'Nothing flagged in the limits Devbox checks'}
                        {aside.length ? ` · ${aside.length} exception${aside.length === 1 ? '' : 's'} to your rules` : ''}
                        {confirmed.length ? ` · ${confirmed.length} amount${confirmed.length === 1 ? '' : 's'} you confirmed unchecked` : ''}
                        <span className="when"> · it checks limits like “at most 2 attempts”, amounts your rules name and “never” rules; read your other rules yourself</span>
                      </h4>
                    </div>
                    <Undecided c={c} you={you} onDecide={(key, id) => void decide(key, id)} onCheck={openAsk} />
                    {changed.length ? (
                      <section className="return-changed">
                        <h4>Changed since you saved this draft</h4>
                        <ul>
                          {changed.map((d) => (
                            <li key={d.key}>{changeText(d)}</li>
                          ))}
                        </ul>
                        <button type="button" onClick={() => draft && update({ ...draft, basis: basisOf(c) })}>
                          I've checked these
                        </button>
                      </section>
                    ) : null}
                    {cards.length ? (
                      <ul className="return-issues">
                        {cards.map((n) => (
                          <li key={n}>
                            <blockquote>{lines[n]}</blockquote>
                            {issues
                              .filter((issue) => issue.line === n)
                              .map((issue) => (
                                <div key={issue.key} className="issue-finding">
                                  <p>
                                    Line {issue.line + 1} says {lower(issue.found.shown)}; {lower(issue.holds.limit.shown)} holds now.
                                  </p>
                                  <button type="button" aria-label={`Change line ${issue.line + 1} to ${lower(issue.holds.limit.shown)}`} onClick={() => change(issue)}>
                                    Change only this to {lower(issue.holds.limit.shown)}
                                  </button>
                                </div>
                              ))}
                            {hits
                              .filter((h) => h.line === n)
                              .map((h) => {
                                const out = scope.some((x) => x.line === h.line)
                                return (
                                  <div key={`${h.key}|${h.shown}`} className="issue-finding">
                                    <p>
                                      Line {h.line + 1} says {lower(h.shown)} · your rule: “{h.clause}”. {out ? 'Edit the line.' : 'Edit the line, or make an exception for this line only.'}
                                    </p>
                                    {out ? null : (
                                      <button type="button" aria-label={`Set aside “${h.clause}” for line ${h.line + 1} only`} onClick={() => draft && update({ ...draft, setAside: [...(draft.setAside ?? []), exceptionKey(h)] })}>
                                        Make an exception for this line only
                                      </button>
                                    )}
                                  </div>
                                )
                              })}
                            {scope
                              .filter((h) => h.line === n)
                              .map((h, k) => (
                                <p key={`scope|${k}`}>
                                  {h.kind === 'ship'
                                    ? `Line ${h.line + 1} asks for “${h.shown}”. A repair never merges, pushes or deploys: the message tells the agent not to. Remove it; that step stays yours.`
                                    : `Line ${h.line + 1} says “${h.shown}”. A repair can't set aside your limits, rules or checks this way. Remove it, or change the limit or rule itself.`}
                                </p>
                              ))}
                            {pushes
                              .filter((p) => p.line === n)
                              .map((p, k) => (
                                <p key={`push|${k}`}>
                                  Line {p.line + 1} asks to {lower(p.shown)}; {lower(p.holds.limit.shown)} holds now. Edit the line. To go past the limit, change the limit itself first.
                                </p>
                              ))}
                            {unread
                              .filter((u) => u.line === n)
                              .map((u, k) => {
                                const timed = /(?<![a-z])(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|ms|s|h)$/i.test(u.shown)
                                const like = c.holds.find((h) => !h.decided && (h.subject === 'attempts') !== timed)?.limit.shown ?? (timed ? 'at most 10 seconds' : 'at most 2 attempts')
                                const now = u.was ? c.holds.find((h) => h.replaced.some((l) => lower(l.shown) === u.was))?.limit.shown : undefined
                                return (
                                  <p key={`${u.shown}|${k}`} className="return-notice">
                                    Line {u.line + 1} says “{u.shown}”{u.count !== undefined ? `, which may mean ${u.count} or ${u.count + 1} attempts` : ''}
                                    {u.was && now ? `, the old limit: ${u.was} was replaced by ${lower(now)}` : ''}. Devbox can't check it. Write it like “{lower(like)}” to have it checked, or confirm the line as written.{' '}
                                    <button type="button" className="link" aria-label={`Confirm line ${u.line + 1} as written`} onClick={() => draft && update({ ...draft, read: [...(draft.read ?? []), amountKey(lines[u.line], u.shown)] })}>
                                      Confirm as written
                                    </button>
                                  </p>
                                )
                              })}
                            {issues.some((issue) => issue.line === n) ? (
                              <div className="issue-finding">
                                <button type="button" className="link" aria-label={`Keep line ${n + 1} as an earlier comparison`} onClick={() => draft && update({ ...draft, earlier: [...draft.earlier, lines[n].trim()] })}>
                                  Keep this line as an earlier comparison
                                </button>
                                <small>The whole line, and any line the same, then goes out marked as not a requirement, and the result doesn't check the reply against it.</small>
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {confirmed.map((u, k) => (
                      <p key={`confirmed|${u.line}|${u.shown}|${k}`} className="return-undo">
                        Confirmed as written: line {u.line + 1}, “{u.shown}”.{' '}
                        <button type="button" className="link" aria-label={`Undo confirming line ${u.line + 1}`} onClick={() => draft && update({ ...draft, read: (draft.read ?? []).filter((x) => x !== amountKey(lines[u.line], u.shown)) })}>
                          Undo
                        </button>
                      </p>
                    ))}
                    {aside.map((x) => (
                      <p key={x.key} className="return-undo">
                        {x.line === undefined ? 'Set aside for this repair' : `You kept line ${lines.indexOf(x.line) + 1} against this rule. For this repair, that line wins over it; the rule still holds for the rest of the message and after it`}, and the message says so: “{clause(x.rule.sentence)}”{' '}
                        <button type="button" className="link" aria-label={`Undo setting aside “${clause(x.rule.sentence)}”`} onClick={() => draft && update({ ...draft, setAside: (draft.setAside ?? []).filter((k) => k !== x.key) })}>
                          Undo
                        </button>
                      </p>
                    ))}
                    {(draft?.corrections ?? []).map((x) => {
                      const lines = text.split('\n')
                      const at = lines.indexOf(x.after)
                      return lines.filter((l) => l === x.after).length === 1 ? (
                        <p key={x.id} className="return-undo">
                          Changed “{x.before.replace(/[.!]$/, '')}”{' '}
                          <button type="button" className="link" aria-label={`Undo the change to line ${at + 1}`} onClick={() => undo(x)}>
                            Undo
                          </button>
                        </p>
                      ) : null
                    })}
                    {undoNote ? <p className="return-notice">{undoNote}</p> : null}
                    {kept.map((k) => (
                      <p key={k.line} className="return-undo">
                        Kept as an earlier comparison, and the message says it isn't a requirement: “{k.line.replace(/[.!]$/, '')}”{k.lines.length > 1 ? ` · lines ${listed(k.lines)}` : ''}{' '}
                        <button type="button" className="link" aria-label={`Undo keeping line${k.lines.length > 1 ? 's' : ''} ${listed(k.lines)} as an earlier comparison`} onClick={() => draft && update({ ...draft, earlier: draft.earlier.filter((x) => x !== k.line) })}>
                          Undo
                        </button>
                      </p>
                    ))}
                  </section>
                ) : null}
                {attempt
                  ? receipt(attempt, out, (el) => {
                      if (el && attempt.id === justSent.current) {
                        justSent.current = null
                        el.scrollIntoView?.({ block: 'nearest' })
                      }
                    })
                  : null}
                {out && sentThis ? (
                  <>
                    <details className="return-preview">
                      <summary>See exactly what was sent</summary>
                      <pre>{sentThis.packet}</pre>
                    </details>
                    <div className="flow-actions">
                      <button type="button" className="primary" onClick={() => void close()}>
                        Done for now
                      </button>
                      <button type="button" className="link" onClick={() => followUpSent(sentThis)}>
                        Write a follow-up
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <label className="field">
                      <span>
                        Repair for Claude Code session <code>{session}</code>
                        <span className="when"> · {[target?.path, target?.branch].filter(Boolean).join(' · ')}</span>
                      </span>
                      <textarea
                        aria-label="Repair draft"
                        value={text}
                        rows={8}
                        placeholder="What should the agent change? Devbox checks each line against what holds now."
                        onChange={(e) => edit(e.target.value)}
                      />
                    </label>
                    <section className="draft-quoted" aria-labelledby="draft-quoted">
                      <h4 id="draft-quoted">What holds · added to the message</h4>
                      <dl>
                        <dt>{c.holds.length === 1 ? 'Limit' : 'Limits'}</dt>
                        <dd>{c.holds.length ? c.holds.map((h) => lower(h.limit.shown)).join(' · ') : 'none found in your messages'}</dd>
                        <dt>Rules</dt>
                        <dd>
                          {quoted.size ? (
                            <ul>
                              {c.rules
                                .filter((r) => quoted.has(r))
                                .map((r) => (
                                  <li key={ruleKey(r)}>
                                    {clause(r.sentence)}
                                    {aside.some((x) => x.rule === r) ? <small>{aside.some((x) => x.rule === r && x.line === undefined) ? ' · set aside for this repair' : ' · excepted for one line'}</small> : null}
                                  </li>
                                ))}
                            </ul>
                          ) : (
                            c.rules.length ? 'none ticked' : 'none found in your messages'
                          )}
                          {c.rules.length ? (
                            <details className="quiet">
                              <summary>Change which rules go with it</summary>
                              <p className="lane-empty">This session's rules are ticked; another session's only if you tick them. Limits that hold always go.</p>
                              <ul>{c.rules.map(rule)}</ul>
                            </details>
                          ) : null}
                        </dd>
                        {offered.length || lostOthers ? (
                          <>
                            <dt>Other sessions</dt>
                            <dd>
                              {offered.length ? (
                              <ul>
                                {offered.map((e) => (
                                  <li key={e.id}>
                                    <label>
                                      <input
                                        type="checkbox"
                                        checked={quotedFrom.includes(e)}
                                        aria-label={`Add what ${e.session} said to the repair`}
                                        disabled={!quotedFrom.includes(e) && (draft?.others?.length ?? 0) >= 20}
                                        onChange={(x) => {
                                          const ids = (draft?.others ?? []).filter((id) => id !== e.id)
                                          update({ ...(draft ?? startDraft('')), others: x.target.checked ? [...ids, e.id] : ids })
                                        }}
                                      />
                                      <span>
                                        “{clip(e.text, 200)}”{' '}
                                        <small className="when">
                                          <Name of={e.session} /> · <When at={e.at} now={now} />
                                        </small>
                                      </span>
                                    </label>
                                  </li>
                                ))}
                              </ul>
                              ) : null}
                              <small>
                                {[offered.length ? 'Tick one to attach it · quoted as written and not checked' : '', lostOthers ? `${plural(lostOthers, 'ticked message')} no longer in the records, not sent` : ''].filter(Boolean).join(' · ')}
                                {lostOthers && draft ? (
                                  <>
                                    {' · '}
                                    <button type="button" className="link" onClick={() => update({ ...draft, others: quotedFrom.map((q) => q.id) })}>
                                      {lostOthers === 1 ? 'Forget it' : 'Forget them'}
                                    </button>
                                  </>
                                ) : null}
                              </small>
                            </dd>
                          </>
                        ) : null}
                        <dt>Asks for</dt>
                        <dd>
                          edits in {target?.path ?? 'its folder'} and the tests needed to check them · no merge, push or deploy
                          <small>The message asks for this; Devbox can't enforce it, the session's own permissions decide.</small>
                        </dd>
                      </dl>
                    </section>
                    {preview ? (
                      <details className="return-preview">
                        <summary>The full message, as the agent gets it (times in UTC)</summary>
                        <pre>{preview}</pre>
                      </details>
                    ) : null}
                    <div className={asking ? 'flow-actions' : 'flow-actions action-bar'}>
                      <button type="button" className={asking ? undefined : 'primary'} disabled={Boolean(why) || busy} onClick={() => void send()}>
                        Send repair to session <code className="session-chip">{session}</code>
                      </button>
                      {why && text.trim() ? <small className="send-why">{why}</small> : null}
                      <button type="button" className="link" onClick={() => openAsk()}>
                        Ask first (read-only)
                      </button>
                      <button type="button" className="link" onClick={() => setStep('changes')}>
                        <Icon name="back" />
                        Back (keeps the draft)
                      </button>
                      {text.trim() && !discarding ? (
                        <button type="button" className="link" onClick={() => setDiscarding(true)}>
                          Discard this draft
                        </button>
                      ) : null}
                    </div>
                    {discarding ? (
                      <p className="return-notice" role="alert" ref={(el) => el?.scrollIntoView?.({ block: 'nearest' })}>
                        Discard the draft? Its text can't be brought back.{' '}
                        <button
                          type="button"
                          className="link"
                          onClick={() => {
                            setDiscarding(false)
                            setUndoNote(null)
                            update({ ...startDraft(''), ...(draft?.quote ? { quote: draft.quote } : {}) })
                            setStep('changes')
                          }}
                        >
                          Discard it
                        </button>{' '}
                        <button type="button" className="link" onClick={() => setDiscarding(false)}>
                          Keep it
                        </button>
                      </p>
                    ) : null}
                  </>
                )}
                {repairs.filter((r) => r !== attempt).length ? (
                  <details className="return-history">
                    <summary>Earlier handoffs · {repairs.filter((r) => r !== attempt).length}</summary>
                    <ul className="return-receipts">
                      {repairs
                        .filter((r) => r !== attempt)
                        .map((r) => (
                          <li key={r.id}>{receipt(r)}</li>
                        ))}
                    </ul>
                  </details>
                ) : null}
              </section>
            ) : null}
            {sources}
          </>
        ) : null}
      </div>
      {peek ? <FilePreview key={`${peek.session}${peek.path}`} file={peek} files={insights?.get(peek.session)?.files ?? []} onClose={() => setPeek(null)} /> : null}
    </section>
  )
}
