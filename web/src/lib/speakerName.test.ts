import { describe, expect, it } from 'vitest'
import { defaultMergeTarget, findDuplicateName, validateSpeakerName } from './speakerName'

describe('validateSpeakerName', () => {
  it('trims and collapses whitespace', () => expect(validateSpeakerName('  Mia   Wong ')).toEqual({ ok: true, name: 'Mia Wong' }))
  it('rejects empty, purely numeric and over-long names', () => {
    expect(validateSpeakerName('   ')).toEqual({ ok: false, reason: 'empty' })
    expect(validateSpeakerName('12345')).toEqual({ ok: false, reason: 'numeric' })
    expect(validateSpeakerName('x'.repeat(31))).toEqual({ ok: false, reason: 'too_long' })
  })
  it('counts characters, not UTF-16 units', () => {
    expect(validateSpeakerName('你'.repeat(30)).ok).toBe(true)
    expect(validateSpeakerName('😀'.repeat(30)).ok).toBe(true)
    expect(validateSpeakerName('😀'.repeat(31)).ok).toBe(false)
  })
})

describe('findDuplicateName', () => {
  const list = [
    { id: 1, name: 'Mia', state: 'named' },
    { id: 2, name: null, state: 'unnamed' },
    { id: 3, name: 'Tom', state: 'ignored' },
  ]
  it('matches case-insensitively and ignores the speaker itself', () => {
    expect(findDuplicateName(list, ' mia ', 9)?.id).toBe(1)
    expect(findDuplicateName(list, 'Mia', 1)).toBeUndefined()
  })
  it('ignores unnamed speakers but not ignored ones', () => {
    expect(findDuplicateName(list, 'Tom', 9)?.id).toBe(3)
    expect(findDuplicateName(list, 'Speaker 2', 9)).toBeUndefined()
  })
})

describe('defaultMergeTarget', () => {
  const named = { id: 1, state: 'named', utterance_count: 5 }
  const unnamed = { id: 2, state: 'unnamed', utterance_count: 500 }
  it('keeps the named speaker even with fewer utterances', () => {
    expect(defaultMergeTarget(named, unnamed)).toEqual({ source: unnamed, target: named })
    expect(defaultMergeTarget(unnamed, named)).toEqual({ source: unnamed, target: named })
  })
  it('between equals, keeps the one with more utterances', () => {
    const a = { id: 3, state: 'unnamed', utterance_count: 10 }
    const b = { id: 4, state: 'unnamed', utterance_count: 20 }
    expect(defaultMergeTarget(a, b).target.id).toBe(4)
  })
  it('ranks ignored below unnamed', () => {
    const ign = { id: 5, state: 'ignored', utterance_count: 900 }
    expect(defaultMergeTarget(ign, unnamed).target.id).toBe(2)
  })
})
