import type { SummaryLevel } from './types'
import { dayRange, localParts, todayKey, zonedToUtcMs } from './time'

export type RangePreset = 'today' | 'yesterday' | 'this_hour' | 'last_hour' | 'custom'

/** daily for ≥ 20 h, hourly for ≥ 50 min, otherwise custom (PRODUCT §6). */
export function autoLevel(startMs: number, endMs: number): SummaryLevel {
  const mins = (endMs - startMs) / 60000
  if (mins >= 20 * 60) return 'daily'
  if (mins >= 50) return 'hourly'
  return 'custom'
}

export function presetRange(preset: Exclude<RangePreset, 'custom'>, nowMs: number, tz: string): { start: string; end: string } {
  const today = todayKey(nowMs, tz)
  if (preset === 'today') return { start: dayRange(today, tz).from, end: new Date(nowMs).toISOString() }
  if (preset === 'yesterday') {
    const y = new Date(nowMs - 86_400_000)
    const k = todayKey(y.getTime(), tz)
    const r = dayRange(k, tz)
    return { start: r.from, end: r.to }
  }
  const p = localParts(nowMs, tz)
  const hourStart = zonedToUtcMs({ ...p, minute: 0, second: 0 }, tz)
  if (preset === 'this_hour') return { start: new Date(hourStart).toISOString(), end: new Date(nowMs).toISOString() }
  return { start: new Date(hourStart - 3_600_000).toISOString(), end: new Date(hourStart).toISOString() }
}

export interface SummaryLike { id: number; range_start: string; range_end: string; room_id: number | null; level: SummaryLevel }

/** An existing summary with the same range (and room) would be overwritten by generate. */
export function findOverwrite<T extends SummaryLike>(list: T[], start: string, end: string, roomId: number | null): T | undefined {
  const s = Date.parse(start), e = Date.parse(end)
  return list.find((x) => Math.abs(Date.parse(x.range_start) - s) < 60_000 && Math.abs(Date.parse(x.range_end) - e) < 60_000 && (x.room_id ?? null) === (roomId ?? null))
}
