import { useId } from 'react'
import { displayTitle, plain } from '../insights'
import { checkedRule, checkName, holdingOf, limitText, lower, measured, namedRule, sinceLeft, spoken } from '../shared/recover'
import { ago } from '../time'
import { Icon, StateIcon } from './Icon'
import { headline } from './SessionList'
import { ATTENTION, type HomeItem } from './work'

const clip = (text: string, n = 180) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

export const titleOf = (item: HomeItem) => displayTitle(headline(item.session), item.insight) || item.session.name

export const breakable = (text: string) => text.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[_/.-])(?=\w)/).flatMap((part, i) => (i ? [<wbr key={i} />, part] : [part]))

export function workLabel(key: string): string {
  if (key.startsWith('pr:')) return `PR #${/\/pull\/(\d+)/.exec(key)?.[1] ?? key.slice(3)}`
  if (key.startsWith('branch:')) return `branch ${key.slice(key.lastIndexOf('@') + 1)}`
  return ''
}

const said = (text: string, reply: boolean) => (text ? `${reply ? 'The reply says, not checked: ' : ''}“${text}”` : '')

const Tone = ({ item }: { item: HomeItem }) =>
  item.attention === 'waiting' ? (
    <Icon name="clock" size={14} />
  ) : item.attention === 'accepted' ? (
    <Icon name="check" size={14} />
  ) : (
    <StateIcon tone={item.tone} />
  )

function Row({ item, now, primary, onContinue, onOpen, onLater }: { item: HomeItem; now: number; primary: boolean; onContinue: (name: string) => void; onOpen: (name: string) => void; onLater?: (name: string) => void }) {
  const b = item.brief?.brief
  const result = b?.failing && item.insight.state !== 'waiting' ? measured(b.failing.text) : undefined
  const replyish = /^(?:Repair replied|Result accepted|Accepted · )/.test(item.status)
  const since =
    item.attention === 'waiting'
      ? item.status === 'Question running'
        ? 'Waiting for the answer to your read-only question. It comes back under New since you looked, so you can leave.'
        : 'Waiting for the reply to the repair you sent. It comes back under New since you looked, so you can leave.'
      : result && b?.failing
        ? `Check “${checkName(b.failing.text)}” failed ${ago(now, b.failing.at)} ago · ${result} · it may have passed since; only failures are recorded`
        : b?.since
          ? said(spoken(b.since.text, b), replyish || /^\s*\[devbox result /.test(b.since.text))
          : item.insight.summary
            ? said(plain(item.insight.summary), replyish)
            : ''
  const prs = item.insight.artifacts.filter((a) => /\/pull\/\d+/.test(a.url))
  const members = item.brief?.work.members ?? [{ name: item.session.name, reason: '' }]
  const group = item.brief ? workLabel(item.brief.work.key) : ''
  const workPr = prs.find((a) => `pr:${a.url}` === item.brief?.work.key)
  const name = item.session.name
  const rule = b ? checkedRule(b.failing?.text, b.rules) : undefined
  const recent = b ? sinceLeft(b) : []
  const named = new Map(recent.map((x) => [x.id, namedRule(x, b?.rules ?? [])]))
  const quoted = new Set([...named.values()].flatMap((p) => p?.rule.sentence ?? []))
  const mine = [...new Set([result ? undefined : rule?.sentence, b?.why && !b.why.reason ? b.why.sentence : undefined].filter((x): x is string => Boolean(x) && !quoted.has(x as string)))]
  const held = b ? holdingOf(b, name) : undefined
  const limits = b && held ? [...b.holds.map((h) => lower(h.limit.shown)), ...held.rules.map((r) => r.sentence), ...(held.more ? [held.more] : [])] : []
  return (
    <li className="pickup-row" data-tone={item.tone}>
      <span className="pickup-icon" data-tone={item.tone}>
        <Tone item={item} />
      </span>
      <div className="pickup-copy">
        <p className="pickup-heading">
          <button type="button" className="pickup-title" onClick={() => onContinue(name)}>
            {breakable(titleOf(item))}
          </button>
          <span className="pickup-badge" data-tone={item.tone}>
            {item.status}
          </span>
          {item.also?.length ? <span className="pickup-also">also: {item.also.join(' · ')}</span> : null}
        </p>
        {since || recent.length ? (
          <p className="pickup-since">
            <span className="pickup-label">{item.attention === 'waiting' ? 'Now' : item.insight.state === 'waiting' && since ? 'Last message' : b && (b.leftAt === undefined || (result && b.failing && b.failing.at <= b.leftAt)) ? 'Latest' : 'Since you left'}</span>{' '}
            <span className="pickup-lines">
              {since ? <span>{clip(since)}</span> : null}
              {recent.map((x) => {
                const p = named.get(x.id)
                return (
                  <span key={x.id}>
                    The agent suggested “{x.shown}” · {p ? `your rule: “${p.clause}”` : 'not set by you'}
                  </span>
                )
              })}
            </span>
          </p>
        ) : null}
        {b ? (
          <>
            {item.attention === 'waiting' && item.sent ? (
              <p className="pickup-why">
                <span className="pickup-label">You sent</span> “{clip(item.sent)}”
              </p>
            ) : item.missed?.length ? (
              <p className="pickup-why">
                <span className="pickup-label">May have missed</span>{' '}
                <span className="pickup-lines">
                  {item.missed.map((x) => (
                    <span key={x}>“{clip(x)}”</span>
                  ))}
                </span>
              </p>
            ) : mine.length ? (
              <p className="pickup-why">
                <span className="pickup-label">{mine.length > 1 ? 'Your rules' : mine[0] === rule?.sentence ? 'Your rule' : 'You decided'}</span>{' '}
                <span className="pickup-lines">
                  {mine.map((x) => (
                    <span key={x}>{x}</span>
                  ))}
                </span>
              </p>
            ) : null}
            {b.why?.reason ? (
              <p className="pickup-why">
                <span className="pickup-label">Your reason</span> {b.why.reason}
              </p>
            ) : null}
            {b.updated ? (
              <p className="pickup-updated">
                <span className="pickup-label">You changed</span>{' '}
                <span>
                  {limitText(b.updated.key, b.updated.from.value)} → {lower(b.updated.to.shown)} · you wrote it in <code className="session-chip">{b.updated.to.session}</code> {ago(now, b.updated.at)} ago
                </span>
              </p>
            ) : null}
          </>
        ) : item.reading ? (
          <p className="pickup-loading">Reading its records…</p>
        ) : null}
        <p className="pickup-facts">
          <span>
            {[item.looked !== undefined ? `you looked ${ago(now, item.looked)} ago` : '', b?.leftAt !== undefined ? `${item.looked !== undefined ? 'visit before ended' : 'last visit'} ${ago(now, b.leftAt)} ago` : '', item.status === 'Question running' ? 'a read-only copy is answering' : item.insight.state === 'working' ? 'agent working' : `${item.insight.state === 'waiting' ? 'waiting on you' : 'agent idle'} for ${ago(now, item.insight.since ?? item.session.activityEpoch)}`, prs.length ? '' : (item.insight.branch ?? '')].filter(Boolean).join(' · ')}
            {' · '}
            {members.length} session{members.length === 1 ? '' : 's'}
            {group ? (
              <>
                {' in '}
                {workPr ? (
                  <a href={workPr.url} target="_blank" rel="noreferrer">
                    <Icon name="pr" size={14} />
                    {group}
                  </a>
                ) : (
                  group
                )}
                {workPr && members.some((m) => m.reason.startsWith('same branch')) ? ' or its branch' : ''}
              </>
            ) : null}
            : {members.map((m) => m.name).join(', ')}
          </span>
          {prs.filter((a) => a !== workPr).slice(0, 2).map((a) => (
            <a key={a.url} href={a.url} target="_blank" rel="noreferrer">
              <Icon name="pr" size={14} />
              {a.label}
            </a>
          ))}
        </p>
        <details className="pickup-more quiet">
          <summary>Goal and earlier decisions</summary>
          {item.insight.firstAsk || item.insight.ask ? (
            <p>
              <b>Asked for</b> {clip(item.insight.firstAsk ?? item.insight.ask ?? '', 400)}
            </p>
          ) : null}
          {b ? (
            <p>
              <b>Set limits</b> {limits.length ? limits.map((l) => l.replace(/[.!]$/, '')).join('; ') : 'none found in your messages'}
            </p>
          ) : null}
          {b?.why?.reason ? (
            <p>
              <b>Why then</b> {b.why.sentence}
            </p>
          ) : null}
          <button type="button" className="link" onClick={() => onOpen(name)}>
            Open {name}'s terminal
          </button>
        </details>
      </div>
      <div className="pickup-actions">
        <button type="button" className={primary ? 'primary pickup-go' : 'pickup-go'} onClick={() => onContinue(name)}>
          {item.action}
          <Icon name="next" />
        </button>
        {onLater ? <button type="button" className="link" onClick={() => onLater(name)}>{item.attention === 'later' ? 'Bring back' : 'Later'}</button> : null}
      </div>
    </li>
  )
}

export function PickUpList({ items, now, elsewhere = 0, onContinue, onOpen, onLater }: { items: HomeItem[]; now: number; elsewhere?: number; onContinue: (name: string) => void; onOpen: (name: string) => void; onLater?: (name: string) => void }) {
  const id = useId()
  const groups = ATTENTION.map((a) => ({ ...a, items: items.filter((i) => i.attention === a.kind) })).filter((g) => g.items.length)
  return (
    <section className="pickup" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="pickup-head">
        Pick up where you left off
      </h2>
      {groups.length ? <p className="pickup-sub">{groups.map((g) => g.count(g.items.length)).join(' · ')}</p> : null}
      {groups.some((g) => g.kind === 'needs' || g.kind === 'new') ? null : (
        <p className="pickup-done">
          {elsewhere ? 'Nothing listed here needs you, but other sessions do.' : 'You can leave now: nothing needs you and nothing is new.'}
          {groups.some((g) => g.kind === 'unsent') ? " What you haven't sent is saved." : ''}
          {groups.some((g) => g.kind === 'accepted') ? ' Merging what you accepted is still yours.' : ''}
        </p>
      )}
      {groups.map((g, gi) => (
        <details open={g.kind !== 'later'} key={g.kind} className="pickup-group">
          <summary>
            <h3 id={`${id}-${g.kind}`}>{g.title} <span className="lane-count">{g.items.length}</span></h3>
          </summary>
          {g.kind === 'later' ? <p className="lane-empty">Saved here until a new agent update or handoff change. Opening a conversation does not bring it back. No reminder is scheduled.</p> : null}
          <ul className="pickup-rows">
            {g.items.map((item, i) => (
              <Row key={item.session.name} item={item} now={now} primary={gi === 0 && i === 0} onContinue={onContinue} onOpen={onOpen} onLater={onLater} />
            ))}
          </ul>
        </details>
      ))}
    </section>
  )
}

export function PickUpRail({
  items,
  current,
  others = 0,
  open,
  onSwitch,
  onAll,
}: {
  items: HomeItem[]
  current: string
  others?: number
  open?: { title: string; members: number; status: string }
  onSwitch: (name: string) => void
  onAll?: () => void
}) {
  const listed = items.some((i) => i.session.name === current)
  const isHere = (item: HomeItem) => item.session.name === current || (!listed && item.brief?.work.members.some((m) => m.name === current))
  return (
    <nav className="pickup-rail" aria-label="Work">
      <h2>Work you came back to</h2>
      <p className="rail-sub">Grouped by shared pull request or branch</p>
      {open && !items.some(isHere) ? (
        <section>
          <h3>Open now</h3>
          <p className="rail-item" aria-current="page">
            <span>
              <strong>{open.title}</strong>
              <small>
                {open.members} session{open.members === 1 ? '' : 's'} · {open.status}
              </small>
            </span>
          </p>
        </section>
      ) : null}
      {ATTENTION.map((a) => {
        const mine = items.filter((i) => i.attention === a.kind)
        return mine.length ? (
          <section key={a.kind}>
            <h3>
              {a.title} <span className="lane-count">{mine.length}</span>
            </h3>
            {mine.map((item) => {
              const here = isHere(item)
              const n = item.brief?.work.members.length
              return (
                <button key={item.session.name} type="button" className="rail-item" aria-current={here ? 'page' : undefined} onClick={() => onSwitch(item.session.name)}>
                  <Tone item={item} />
                  <span>
                    <strong>{breakable(titleOf(item))}</strong>
                    <small>
                      {n ? `${n} session${n === 1 ? '' : 's'} · ` : ''}
                      {here && open ? open.status : item.status}
                    </small>
                  </span>
                  <Icon name="next" size={14} />
                </button>
              )
            })}
          </section>
        ) : null
      })}
      {onAll ? (
        <div className="rail-foot">
          <p>{others ? `${others} other session${others === 1 ? '' : 's'}` : 'No other sessions'}</p>
          <button type="button" className="rail-all" onClick={onAll}>
            View all
            <Icon name="next" size={14} />
          </button>
        </div>
      ) : null}
    </nav>
  )
}
