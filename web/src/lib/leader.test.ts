import { describe, expect, it } from 'vitest'
import { pickLeader } from './leader'

describe('pickLeader (reminder sound tab election)', () => {
  const now = 100_000
  it('the only tab leads', () => expect(pickLeader('a', { focusedAt: 0, seenAt: now }, {}, now)).toBe('a'))
  it('the most recently focused tab wins', () => {
    const peers = { b: { focusedAt: 5000, seenAt: now } }
    expect(pickLeader('a', { focusedAt: 1000, seenAt: now }, peers, now)).toBe('b')
    expect(pickLeader('a', { focusedAt: 9000, seenAt: now }, peers, now)).toBe('a')
  })
  it('ignores peers that stopped announcing', () => {
    const peers = { b: { focusedAt: 9_000_000, seenAt: now - 20_000 } }
    expect(pickLeader('a', { focusedAt: 1, seenAt: now }, peers, now)).toBe('a')
  })
  it('ties resolve to the smaller id so every tab agrees', () => {
    const f = 4000
    expect(pickLeader('b', { focusedAt: f, seenAt: now }, { a: { focusedAt: f, seenAt: now } }, now)).toBe('a')
    expect(pickLeader('a', { focusedAt: f, seenAt: now }, { b: { focusedAt: f, seenAt: now } }, now)).toBe('a')
  })
  it('never elects a peer that is just stale versions of itself', () => {
    expect(pickLeader('a', { focusedAt: 1, seenAt: now }, { a: { focusedAt: 99, seenAt: now } }, now)).toBe('a')
  })
})
