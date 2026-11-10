import { describe, expect, it } from 'vitest'
import { dominantLang, flattenBlocks, groupConversations } from './conversation'
import type { Utterance } from './types'

let n = 0
function u(startSec: number, lenSec: number, o: Partial<Utterance> = {}): Utterance {
  const base = Date.parse('2026-11-11T02:00:00Z')
  return {
    id: ++n, chunk_id: null, room_id: 1, started_at: new Date(base + startSec * 1000).toISOString(), ended_at: new Date(base + (startSec + lenSec) * 1000).toISOString(),
    text: 'x', lang: 'zh', speaker_id: 1, speaker_name: null, confidence: 0.9, text_edited: false, ...o,
  }
}

describe('groupConversations', () => {
  it('returns nothing for nothing', () => expect(groupConversations([])).toEqual([]))
  it('keeps neighbours within the gap in one block', () => {
    const b = groupConversations([u(0, 5), u(60, 5), u(200, 5)])
    expect(b).toHaveLength(1)
    expect(b[0].items).toHaveLength(3)
  })
  it('splits when silence exceeds five minutes', () => {
    const b = groupConversations([u(0, 5), u(5 + 301, 5)])
    expect(b).toHaveLength(2)
  })
  it('exactly five minutes of silence does not split', () => {
    expect(groupConversations([u(0, 5), u(5 + 300, 5)])).toHaveLength(1)
  })
  it('splits on room change even without a gap', () => {
    const b = groupConversations([u(0, 5, { room_id: 1 }), u(6, 5, { room_id: 2 })])
    expect(b.map((x) => x.roomId)).toEqual([1, 2])
  })
  it('measures the gap from the latest end, not the previous start', () => {
    // a long utterance covers the later short one, so the third is still close enough
    expect(groupConversations([u(0, 600), u(10, 2), u(600 + 120, 3)])).toHaveLength(1)
  })
  it('collects distinct speakers in order and extends the block end', () => {
    const [b] = groupConversations([u(0, 5, { speaker_id: 2 }), u(10, 5, { speaker_id: null }), u(20, 5, { speaker_id: 2 })])
    expect(b.speakerIds).toEqual([2, null])
    expect(b.end).toBe(b.items[2].ended_at)
  })
  it('honours a custom gap', () => {
    expect(groupConversations([u(0, 5), u(40, 5)], 30_000)).toHaveLength(2)
  })
})

describe('flattenBlocks', () => {
  it('emits a header per block and hides rows of collapsed blocks', () => {
    const blocks = groupConversations([u(0, 5), u(10, 5), u(2000, 5)])
    const all = flattenBlocks(blocks, new Set())
    expect(all.map((i) => i.kind)).toEqual(['header', 'row', 'row', 'header', 'row'])
    const collapsed = flattenBlocks(blocks, new Set([blocks[0].id]))
    expect(collapsed.map((i) => i.kind)).toEqual(['header', 'header', 'row'])
    expect(collapsed[0].kind === 'header' && collapsed[0].collapsed).toBe(true)
  })
})

describe('dominantLang', () => {
  it('picks the most common language and ignores nulls', () => {
    expect(dominantLang([u(0, 1, { lang: 'en' }), u(1, 1, { lang: 'zh' }), u(2, 1, { lang: 'zh' }), u(3, 1, { lang: null })])).toBe('zh')
    expect(dominantLang([])).toBeNull()
  })
})
