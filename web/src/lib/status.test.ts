import { describe, expect, it } from 'vitest'
import { asrTone, diskTone, formatBytes, isReminderDue, queueTone, recorderTone } from './status'
import type { PipelineStatus } from './types'

const pipe = (counts: Partial<PipelineStatus['counts']>, oldest: string | null = null, asr: boolean | null = true): PipelineStatus => ({
  counts: { pending: 0, processing: 0, done: 0, failed: 0, skipped: 0, ...counts }, oldest_pending_at: oldest, last_done_at: null, asr_ok: asr, llm_configured: true, errors: [],
})

describe('status tones', () => {
  it('recorders: offline is red, paused or buffering is amber', () => {
    expect(recorderTone(undefined)).toBe('neutral')
    expect(recorderTone([{ online: true, status: { state: 'recording' } }])).toBe('ok')
    expect(recorderTone([{ online: false, status: {} }])).toBe('danger')
    expect(recorderTone([{ online: true, status: { state: 'paused' } }])).toBe('warn')
    expect(recorderTone([{ online: true, status: { state: 'recording', buffered_chunks: 3 } }])).toBe('warn')
  })
  it('queue: failures or a stale backlog are red', () => {
    const now = Date.parse('2026-11-11T12:00:00Z')
    expect(queueTone(pipe({}), now)).toBe('ok')
    expect(queueTone(pipe({ failed: 1 }), now)).toBe('danger')
    expect(queueTone(pipe({ pending: 6 }, '2026-11-11T11:58:00Z'), now)).toBe('warn')
    expect(queueTone(pipe({ pending: 1 }, '2026-11-11T11:20:00Z'), now)).toBe('danger')
  })
  it('asr follows asr_ok, unknown is neutral', () => {
    expect(asrTone(pipe({}, null, null))).toBe('neutral')
    expect(asrTone(pipe({}, null, false))).toBe('danger')
  })
  it('disk: under 5 GB amber, under 1 GB red', () => {
    expect(diskTone(undefined)).toBe('neutral')
    expect(diskTone(10e9)).toBe('ok')
    expect(diskTone(4e9)).toBe('warn')
    expect(diskTone(0.5e9)).toBe('danger')
  })
})

describe('formatBytes', () => {
  it('picks a sensible unit', () => {
    expect(formatBytes(10_477_031_424)).toBe('10.5 GB')
    expect(formatBytes(250_000_000)).toBe('250 MB')
    expect(formatBytes(2_000)).toBe('2 KB')
  })
})

describe('isReminderDue', () => {
  const now = Date.parse('2026-11-11T12:00:00Z')
  const t = (o: Partial<{ status: string; reminder_state: string; remind_at: string | null }>) => ({ status: 'open', reminder_state: 'pending', remind_at: '2026-11-11T11:59:00Z', ...o })
  it('due once the remind time is reached', () => expect(isReminderDue(t({}), now)).toBe(true))
  it('not due for done todos, acked reminders or the future', () => {
    expect(isReminderDue(t({ status: 'done' }), now)).toBe(false)
    expect(isReminderDue(t({ reminder_state: 'acked' }), now)).toBe(false)
    expect(isReminderDue(t({ remind_at: '2026-11-11T12:10:00Z' }), now)).toBe(false)
    expect(isReminderDue(t({ remind_at: null }), now)).toBe(false)
  })
  it('allows a few seconds of slack', () => expect(isReminderDue(t({ remind_at: '2026-11-11T12:00:03Z' }), now)).toBe(true))
})
