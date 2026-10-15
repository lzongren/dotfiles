const STOP = new Set(
  'an as at be by do go if in is it me my no of on or so to up we the and for with from into this that about using make add other'.split(' '),
)

export function words(text: string): Set<string> {
  const split = text
    .replace(/([A-Z]{2,})s(?![a-z0-9])/g, '$1 ')
    .replace(/([A-Z]+)([A-Z][a-z])(?!\d)/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
  return new Set(split.filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !STOP.has(w)))
}

function frequency(corpus: Array<Set<string>>): Map<string, number> {
  const df = new Map<string, number>()
  for (const tokens of corpus) for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1)
  return df
}

function frequent(df: Map<string, number>, size: number): Set<string> {
  const limit = Math.max(2, size / 2)
  return new Set([...df].filter(([, n]) => n > limit).map(([t]) => t))
}

export function sharedRarest(corpus: Array<Set<string>>): (a: Set<string>, b: Set<string>) => number {
  const df = frequency(corpus)
  return (a, b) => {
    let best = 0
    for (const t of a) if (b.has(t)) best = Math.max(best, 1 - (df.get(t) ?? 0) / corpus.length)
    return best
  }
}

function idfOf(df: Map<string, number>, size: number): (token: string) => number {
  return (t) => Math.log(1 + size / (df.get(t) ?? 1))
}

export function rarity(corpus: Array<Set<string>>): (token: string) => number {
  return idfOf(frequency(corpus), corpus.length)
}

export function similarity(a: Set<string>, b: Set<string>, weight: (token: string) => number = () => 1): number {
  let both = 0
  let union = 0
  for (const t of a) {
    union += weight(t)
    if (b.has(t)) both += weight(t)
  }
  for (const t of b) if (!a.has(t)) union += weight(t)
  return union === 0 ? 0 : both / union
}

export interface Topic<T> {
  key: string
  label: string
  items: T[]
}

export function topicsOf<T>(items: T[], tokensOf: (item: T) => Set<string>, corpus: Array<Set<string>>, other = 'Other'): Array<Topic<T>> {
  const df = frequency(corpus)
  const common = frequent(df, corpus.length)
  const idf = idfOf(df, corpus.length)
  let rest = items.map((item) => ({ item, tokens: tokensOf(item) }))
  const topics: Array<Topic<T>> = []
  for (;;) {
    const members = new Map<string, typeof rest>()
    for (const r of rest)
      for (const t of r.tokens) {
        if (common.has(t)) continue
        const list = members.get(t)
        if (list) list.push(r)
        else members.set(t, [r])
      }
    let keyword = ''
    let weight = 0
    for (const [t, group] of members) {
      const w = group.length > 1 ? group.length * idf(t) : 0
      if (w > weight || (w === weight && w > 0 && t < keyword)) [keyword, weight] = [t, w]
    }
    const group = members.get(keyword)
    if (!group || weight === 0) break
    const shared = [...group[0].tokens].filter((t) => !common.has(t) && group.every((g) => g.tokens.has(t)))
    const named = shared.filter((t) => idf(t) >= idf(keyword) * 0.8)
    const label = (named.indexOf(keyword) < 3 ? named : [keyword, ...named.filter((t) => t !== keyword)]).slice(0, 3).join(' ')
    topics.push({ key: keyword, label, items: group.map((g) => g.item) })
    const taken = new Set(group)
    rest = rest.filter((r) => !taken.has(r))
  }
  topics.sort((a, b) => items.indexOf(a.items[0]) - items.indexOf(b.items[0]))
  return rest.length > 0 ? [...topics, { key: '', label: other, items: rest.map((r) => r.item) }] : topics
}

export function mmr<T>(items: T[], relevance: (item: T, index: number) => number, sim: (a: T, b: T) => number, lambda = 0.5): T[] {
  const rest = items.map((item, i) => ({ item, relevance: relevance(item, i), nearest: 0 }))
  const score = (r: (typeof rest)[number]) => lambda * r.relevance - (1 - lambda) * r.nearest
  const out: T[] = []
  while (rest.length > 0) {
    let best = 0
    for (let i = 1; i < rest.length; i += 1) if (score(rest[i]) > score(rest[best])) best = i
    const [pick] = rest.splice(best, 1)
    out.push(pick.item)
    for (const r of rest) r.nearest = Math.max(r.nearest, sim(r.item, pick.item))
  }
  return out
}
