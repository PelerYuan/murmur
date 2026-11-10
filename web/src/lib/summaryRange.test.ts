import { describe, expect, it } from 'vitest'
import { autoLevel, findOverwrite, presetRange } from './summaryRange'

const TZ = 'Asia/Shanghai'
const NOW = Date.parse('2026-11-11T06:30:00Z') // 14:30 local

describe('autoLevel', () => {
  const min = 60_000
  it('daily from 20 h, hourly from 50 min, otherwise custom', () => {
    expect(autoLevel(0, 20 * 60 * min)).toBe('daily')
    expect(autoLevel(0, 19 * 60 * min)).toBe('hourly')
    expect(autoLevel(0, 50 * min)).toBe('hourly')
    expect(autoLevel(0, 49 * min)).toBe('custom')
  })
})

describe('presetRange', () => {
  it('today runs from local midnight to now', () => {
    expect(presetRange('today', NOW, TZ)).toEqual({ start: '2026-11-10T16:00:00.000Z', end: '2026-11-11T06:30:00.000Z' })
  })
  it('yesterday is the previous full local day', () => {
    expect(presetRange('yesterday', NOW, TZ)).toEqual({ start: '2026-11-09T16:00:00.000Z', end: '2026-11-10T16:00:00.000Z' })
  })
  it('this hour and last hour use the zone hour boundary', () => {
    expect(presetRange('this_hour', NOW, TZ).start).toBe('2026-11-11T06:00:00.000Z')
    expect(presetRange('last_hour', NOW, TZ)).toEqual({ start: '2026-11-11T05:00:00.000Z', end: '2026-11-11T06:00:00.000Z' })
  })
  it('yesterday is right just after local midnight', () => {
    const justAfter = Date.parse('2026-11-10T16:05:00Z') // 00:05 on the 11th
    expect(presetRange('yesterday', justAfter, TZ).start).toBe('2026-11-09T16:00:00.000Z')
  })
})

describe('findOverwrite', () => {
  const list = [{ id: 1, range_start: '2026-11-10T16:00:00Z', range_end: '2026-11-11T16:00:00Z', room_id: null, level: 'daily' as const }]
  it('finds a same-range same-room summary', () => expect(findOverwrite(list, '2026-11-10T16:00:20Z', '2026-11-11T16:00:00Z', null)?.id).toBe(1))
  it('a different room or range is not an overwrite', () => {
    expect(findOverwrite(list, '2026-11-10T16:00:00Z', '2026-11-11T16:00:00Z', 2)).toBeUndefined()
    expect(findOverwrite(list, '2026-11-10T18:00:00Z', '2026-11-11T16:00:00Z', null)).toBeUndefined()
  })
})
