import { describe, expect, it } from 'vitest'
import { mostSerious } from '../../src/components/Icon'

describe('mostSerious', () => {
  it('marks a count by a failure first, then a wait on you, else the bell', () => {
    expect(mostSerious(['bell', 'waiting', 'error'])).toBe('error')
    expect(mostSerious(['fresh', 'waiting'])).toBe('waiting')
    expect(mostSerious(['idle'])).toBe('bell')
    expect(mostSerious([])).toBe('bell')
  })
})
