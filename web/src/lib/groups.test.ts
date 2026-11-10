import { describe, expect, it } from 'vitest'
import { groupTodos } from './todoGroups'
import { sortSpeakers } from './speakerSort'
import { passwordStrength } from './password'
import type { Speaker, Todo } from './types'

const todo = (id: number, due: string | null) => ({ id, due_at: due }) as unknown as Todo
describe('groupTodos', () => {
  const now = Date.parse('2026-11-11T06:00:00Z')
  const endOfDay = Date.parse('2026-11-11T16:00:00Z')
  it('splits into overdue, today, later and no-due, each ordered by due time', () => {
    const g = groupTodos([todo(1, '2026-11-12T01:00:00Z'), todo(2, null), todo(3, '2026-11-11T10:00:00Z'), todo(4, '2026-11-11T01:00:00Z'), todo(5, '2026-11-10T01:00:00Z')], now, endOfDay)
    expect(g.overdue.map((t) => t.id)).toEqual([5, 4])
    expect(g.today.map((t) => t.id)).toEqual([3])
    expect(g.later.map((t) => t.id)).toEqual([1])
    expect(g.nodue.map((t) => t.id)).toEqual([2])
  })
})

const sp = (id: number, count: number, secs: number, seen: string | null) => ({ id, utterance_count: count, total_seconds: secs, last_seen: seen }) as unknown as Speaker
describe('sortSpeakers', () => {
  const list = [sp(1, 10, 500, '2026-11-10T00:00:00Z'), sp(2, 30, 100, '2026-11-09T00:00:00Z'), sp(3, 30, 900, '2026-11-11T00:00:00Z'), sp(4, 5, 50, null)]
  const label = (id: number) => ['', 'Zed', 'amy', 'Bob', 'Cat'][id]
  it('default: more utterances first, ties by recency', () => expect(sortSpeakers(list, 'default', label).map((s) => s.id)).toEqual([3, 2, 1, 4]))
  it('recent puts never-seen last', () => expect(sortSpeakers(list, 'recent', label).map((s) => s.id)).toEqual([3, 1, 2, 4]))
  it('seconds and count', () => {
    expect(sortSpeakers(list, 'seconds', label)[0].id).toBe(3)
    expect(sortSpeakers(list, 'count', label)[3].id).toBe(4)
  })
  it('name sorts by label and does not mutate the input', () => {
    const copy = [...list]
    expect(sortSpeakers(list, 'name', label).map((s) => s.id)).toEqual([2, 3, 4, 1])
    expect(list).toEqual(copy)
  })
})

describe('passwordStrength', () => {
  it('too short is 0, then rises with length and variety', () => {
    expect(passwordStrength('abc')).toBe(0)
    expect(passwordStrength('abcdef')).toBe(1)
    expect(passwordStrength('abcdefgh1')).toBeGreaterThanOrEqual(2)
    expect(passwordStrength('Abcdefghij1!')).toBe(3)
  })
})
