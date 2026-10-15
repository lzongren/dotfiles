import { describe, expect, it } from 'vitest'
import { mmr, sharedRarest, similarity, topicsOf, words } from '../../src/topics'

describe('words', () => {
  it('splits camel case and acronyms, dropping numbers, short words and stopwords', () => {
    expect(words('0912_BillingService_Retry_Logic for the APIGateway')).toEqual(new Set(['billing', 'service', 'retry', 'logic', 'api', 'gateway']))
    expect(words('iOSPush GraphQLSchema IPv6Setup ui-fix to-do')).toEqual(new Set(['os', 'push', 'graph', 'ql', 'schema', 'ipv6', 'setup', 'ui', 'fix']))
    expect(words('ParseJSONId DBTest')).toEqual(new Set(['parse', 'json', 'id', 'db', 'test']))
    expect(words('APIs_cleanup FixPRs URLsParser')).toEqual(new Set(['api', 'cleanup', 'fix', 'pr', 'url', 'parser']))
  })
})

describe('sharedRarest', () => {
  it('scores two sessions by the rarest word they share', () => {
    const corpus = [new Set(['root', 'billing']), new Set(['root', 'billing']), new Set(['root', 'search']), new Set(['root'])]
    const kin = sharedRarest(corpus)
    expect(kin(corpus[0], corpus[1])).toBe(0.5)
    expect(kin(corpus[0], corpus[2])).toBe(0)
    expect(kin(new Set(['search']), new Set(['notes']))).toBe(0)
  })
})

describe('topicsOf', () => {
  const doc = (name: string) => ({ name, tokens: new Set(name.split('-')) })
  const tokens = (d: { tokens: Set<string> }) => d.tokens

  it('shelves sessions by shared words, freshest shelf first, singletons under Other', () => {
    const docs = ['paper-review', 'work-search', 'search-doc', 'work-misc', 'search-integtest', 'paper-draft'].map(doc)
    const corpus = [...docs.map(tokens), new Set(['work', 'x']), new Set(['work', 'y']), new Set(['work', 'z'])]
    expect(topicsOf(docs, tokens, corpus).map((t) => [t.label, t.items.map((d) => d.name)])).toEqual([
      ['paper', ['paper-review', 'paper-draft']],
      ['search', ['work-search', 'search-doc', 'search-integtest']],
      ['Other', ['work-misc']],
    ])
  })

  it('still shelves a pair in a small set of sessions', () => {
    const docs = ['billing-retry', 'billing-invoices', 'search', 'notes', 'deploy'].map(doc)
    expect(topicsOf(docs, tokens, docs.map(tokens)).map((t) => t.label)).toEqual(['billing', 'Other'])
  })

  it('never shelves by a word most sessions share', () => {
    const docs = ['work-alpha', 'work-beta', 'work-gamma'].map(doc)
    expect(topicsOf(docs, tokens, docs.map(tokens)).map((t) => t.label)).toEqual(['Other'])
  })
})

describe('mmr', () => {
  it('keeps relevance order when everything differs, and demotes near-duplicates', () => {
    const items = [
      { id: 'a1', rel: 1.0, tokens: new Set(['search', 'eval']) },
      { id: 'a2', rel: 0.9, tokens: new Set(['search', 'eval']) },
      { id: 'b', rel: 0.8, tokens: new Set(['docs', 'site']) },
    ]
    const order = mmr(items, (i) => i.rel, (x, y) => similarity(x.tokens, y.tokens)).map((i) => i.id)
    expect(order).toEqual(['a1', 'b', 'a2'])
    expect(mmr([items[0], items[2]], (i) => i.rel, () => 0).map((i) => i.id)).toEqual(['a1', 'b'])
  })
})
