import type { PipelineStatus, Recorder } from './types'

export type Tone = 'ok' | 'warn' | 'danger' | 'neutral'

export function recorderTone(recs: Pick<Recorder, 'online' | 'status'>[] | undefined): Tone {
  if (!recs || recs.length === 0) return 'neutral'
  if (recs.some((r) => !r.online || r.status?.state === 'error')) return 'danger'
  if (recs.some((r) => r.status?.state === 'paused' || r.status?.state === 'starting' || (r.status?.buffered_chunks ?? 0) > 0)) return 'warn'
  return 'ok'
}

export function queueTone(p: PipelineStatus | undefined, nowMs: number): Tone {
  if (!p) return 'neutral'
  const backlog = p.counts.pending + p.counts.processing
  const oldestMin = p.oldest_pending_at ? (nowMs - Date.parse(p.oldest_pending_at)) / 60000 : 0
  if (p.counts.failed > 0 || oldestMin > 30) return 'danger'
  if (backlog > 5 || oldestMin > 10) return 'warn'
  return 'ok'
}

export function asrTone(p: PipelineStatus | undefined): Tone {
  if (!p || p.asr_ok == null) return 'neutral'
  return p.asr_ok ? 'ok' : 'danger'
}

export function llmTone(p: PipelineStatus | undefined, lastJobFailed: boolean): Tone {
  if (!p || !p.llm_configured) return 'neutral'
  return lastJobFailed ? 'danger' : 'ok'
}

export function diskTone(freeBytes: number | undefined): Tone {
  if (freeBytes == null) return 'neutral'
  if (freeBytes < 1e9) return 'danger'
  if (freeBytes < 5e9) return 'warn'
  return 'ok'
}

export function formatBytes(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`
  return `${Math.round(n / 1e3)} KB`
}

/** Reminder still due? (open, pending/fired, remind time reached) */
export function isReminderDue(t: { status: string; reminder_state: string; remind_at: string | null }, nowMs: number, slackMs = 5000): boolean {
  return t.status === 'open' && (t.reminder_state === 'pending' || t.reminder_state === 'fired') && !!t.remind_at && Date.parse(t.remind_at) <= nowMs + slackMs
}
