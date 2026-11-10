import { describe, expect, it } from 'vitest'
import { applyChange, emitUtteranceChange, subscribeUtterances } from './utteranceBus'
import type { Utterance } from './types'

const u = (id: number, o: Partial<Utterance> = {}): Utterance => ({
  id, chunk_id: null, room_id: null, started_at: '2026-11-11T01:00:00Z', ended_at: '2026-11-11T01:00:01Z', text: `t${id}`, lang: null, speaker_id: 1, speaker_name: 'A', confidence: null, text_edited: false, ...o,
})

describe('applyChange', () => {
  const rows = [u(1), u(2), u(3)]
  it('patch replaces one row', () => expect(applyChange(rows, { type: 'patch', utterance: u(2, { text: 'new' }) })[1].text).toBe('new'))
  it('delete removes rows', () => expect(applyChange(rows, { type: 'delete', ids: [1, 3] }).map((r) => r.id)).toEqual([2]))
  it('reassign changes speaker id and name for the listed rows only', () => {
    const out = applyChange(rows, { type: 'reassign', ids: [2], speakerId: 9 }, (id) => (id === 9 ? 'Zed' : null))
    expect(out.map((r) => r.speaker_id)).toEqual([1, 9, 1])
    expect(out[1].speaker_name).toBe('Zed')
    expect(out[0].speaker_name).toBe('A')
  })
  it('does not mutate its input', () => {
    const before = JSON.stringify(rows)
    applyChange(rows, { type: 'delete', ids: [1] })
    expect(JSON.stringify(rows)).toBe(before)
  })
})

describe('bus', () => {
  it('delivers to subscribers until they unsubscribe', () => {
    const seen: number[] = []
    const off = subscribeUtterances((c) => { if (c.type === 'delete') seen.push(c.ids[0]) })
    emitUtteranceChange({ type: 'delete', ids: [1] })
    off()
    emitUtteranceChange({ type: 'delete', ids: [2] })
    expect(seen).toEqual([1])
  })
})
