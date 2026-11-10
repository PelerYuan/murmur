import { describe, expect, it } from 'vitest'
import { addDaysKey, dateKey, dayDiff, dayRange, formatClock, formatDateTime, formatFull, friendlyDue, fromLocalInput, nextDailyRun, relativeTime, safeTz, toLocalInput, zonedToUtcMs } from './time'

const ISO = '2026-11-11T06:02:11Z'

describe('time formatting uses the given zone, never the browser one', () => {
  it('formats the clock and full timestamp in Asia/Shanghai', () => {
    expect(formatClock(ISO, 'Asia/Shanghai')).toBe('14:02')
    expect(formatClock(ISO, 'Asia/Shanghai', true)).toBe('14:02:11')
    expect(formatFull(ISO, 'Asia/Shanghai')).toBe('2026-11-11 14:02:11 (Asia/Shanghai)')
  })
  it('the same instant is a different wall-clock in another zone', () => {
    expect(formatClock(ISO, 'America/New_York')).toBe('01:02')
  })
  it('same-day times show only the clock, other days add the date', () => {
    expect(formatDateTime(ISO, 'Asia/Shanghai', 'zh', Date.parse('2026-11-11T08:00:00Z'))).toBe('14:02')
    expect(formatDateTime(ISO, 'Asia/Shanghai', 'en', Date.parse('2026-11-20T08:00:00Z'))).toBe('Nov 11 14:02')
  })
  it('relative time in both languages', () => {
    const now = Date.parse(ISO)
    expect(relativeTime('2026-11-11T05:00:00Z', now, 'zh')).toBe('1小时前')
    expect(relativeTime('2026-11-11T05:00:00Z', now, 'en')).toBe('1 hour ago')
  })
  it('friendly due says tomorrow for the next local day', () => {
    expect(friendlyDue('2026-11-12T02:00:00Z', 'Asia/Shanghai', 'zh', Date.parse(ISO))).toBe('明天 10:00')
  })
  it('falls back to UTC for a bogus zone', () => {
    expect(safeTz('Mars/Base')).toBe('UTC')
    expect(safeTz(undefined)).toBe('UTC')
  })
})

describe('day boundaries', () => {
  it('a normal day is 24 hours in the server zone', () => {
    const r = dayRange('2026-11-11', 'Asia/Shanghai')
    expect(r.from).toBe('2026-11-10T16:00:00.000Z')
    expect(r.to).toBe('2026-11-11T16:00:00.000Z')
    expect(r.toMs - r.fromMs).toBe(24 * 3600_000)
  })
  it('DST end gives a 25 hour day', () => {
    const r = dayRange('2026-11-01', 'America/New_York')
    expect(r.from).toBe('2026-11-01T04:00:00.000Z')
    expect((r.toMs - r.fromMs) / 3600_000).toBe(25)
  })
  it('DST start gives a 23 hour day', () => {
    const r = dayRange('2026-03-08', 'America/New_York')
    expect((r.toMs - r.fromMs) / 3600_000).toBe(23)
  })
  it('dateKey follows the zone across midnight', () => {
    expect(dateKey('2026-11-11T17:00:00Z', 'Asia/Shanghai')).toBe('2026-11-12')
    expect(dateKey('2026-11-11T17:00:00Z', 'UTC')).toBe('2026-11-11')
  })
  it('addDaysKey crosses month and year ends, dayDiff inverts it', () => {
    expect(addDaysKey('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysKey('2026-03-01', -1)).toBe('2026-02-28')
    expect(dayDiff('2026-11-01', '2026-11-11')).toBe(10)
  })
  it('zonedToUtcMs resolves a wall-clock time', () => {
    expect(new Date(zonedToUtcMs({ year: 2026, month: 11, day: 11, hour: 14, minute: 2, second: 11 }, 'Asia/Shanghai')).toISOString()).toBe(ISO.replace('Z', '.000Z'))
  })
})

describe('schedule and local inputs', () => {
  it('nextDailyRun is today when still ahead, tomorrow when passed', () => {
    const now = Date.parse(ISO)
    expect(new Date(nextDailyRun(now, 'Asia/Shanghai', '23:30')).toISOString()).toBe('2026-11-11T15:30:00.000Z')
    expect(new Date(nextDailyRun(now, 'Asia/Shanghai', '10:00')).toISOString()).toBe('2026-11-12T02:00:00.000Z')
  })
  it('datetime-local round trip in the server zone', () => {
    expect(toLocalInput(ISO, 'Asia/Shanghai')).toBe('2026-11-11T14:02')
    expect(fromLocalInput('2026-11-11T14:02', 'Asia/Shanghai')).toBe('2026-11-11T06:02:00.000Z')
    expect(fromLocalInput('', 'Asia/Shanghai')).toBeNull()
  })
})
