import { describe, expect, it } from 'vitest'
import { byTime, flattenPages, highlightParts, latestStart, mergeUtterances, trimOldest } from './pagination'
import type { Utterance } from './types'

const mk = (id: number, started: string, text = 't'): Utterance => ({
  id, chunk_id: null, room_id: null, started_at: started, ended_at: started, text, lang: null, speaker_id: null, speaker_name: null, confidence: null, text_edited: false,
})

describe('mergeUtterances', () => {
  it('inserts late back-filled rows at their time position', () => {
    const existing = [mk(1, '2026-11-11T01:00:00Z'), mk(3, '2026-11-11T03:00:00Z')]
    const merged = mergeUtterances(existing, [mk(2, '2026-11-11T02:00:00Z')])
    expect(merged.map((x) => x.id)).toEqual([1, 2, 3])
  })
  it('de-duplicates by id and lets newer data win', () => {
    const merged = mergeUtterances([mk(1, '2026-11-11T01:00:00Z', 'old')], [mk(1, '2026-11-11T01:00:00Z', 'edited')])
    expect(merged).toHaveLength(1)
    expect(merged[0].text).toBe('edited')
  })
  it('returns the same array when nothing arrived', () => {
    const a = [mk(1, '2026-11-11T01:00:00Z')]
    expect(mergeUtterances(a, [])).toBe(a)
  })
  it('breaks start-time ties by id', () => {
    const t = '2026-11-11T01:00:00Z'
    expect([mk(5, t), mk(2, t)].sort(byTime).map((x) => x.id)).toEqual([2, 5])
  })
})

describe('trimOldest / latestStart / flattenPages', () => {
  it('drops from the front and says so', () => {
    const list = [1, 2, 3, 4].map((i) => mk(i, `2026-11-11T0${i}:00:00Z`))
    const r = trimOldest(list, 3)
    expect(r.list.map((x) => x.id)).toEqual([2, 3, 4])
    expect(r.trimmed).toBe(true)
    expect(trimOldest(list, 10)).toEqual({ list, trimmed: false })
  })
  it('latestStart is the last row start', () => {
    expect(latestStart([])).toBeNull()
    expect(latestStart([mk(1, '2026-11-11T01:00:00Z'), mk(2, '2026-11-11T02:00:00Z')])).toBe('2026-11-11T02:00:00Z')
  })
  it('flattenPages skips rows seen on an earlier page', () => {
    expect(flattenPages([{ items: [{ id: 1 }, { id: 2 }] }, { items: [{ id: 2 }, { id: 3 }] }]).map((x) => x.id)).toEqual([1, 2, 3])
    expect(flattenPages(undefined)).toEqual([])
  })
})

describe('highlightParts', () => {
  it('splits around case-insensitive hits', () => {
    expect(highlightParts('Hello hello', 'HELLO')).toEqual([{ text: 'Hello', hit: true }, { text: ' ', hit: false }, { text: 'hello', hit: true }])
  })
  it('returns the whole text when the query is blank or absent', () => {
    expect(highlightParts('abc', '  ')).toEqual([{ text: 'abc', hit: false }])
    expect(highlightParts('abc', 'z')).toEqual([{ text: 'abc', hit: false }])
  })
  it('treats regex characters literally', () => {
    expect(highlightParts('a.b', '.')).toEqual([{ text: 'a', hit: false }, { text: '.', hit: true }, { text: 'b', hit: false }])
  })
})
