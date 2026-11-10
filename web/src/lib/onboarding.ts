import type { PipelineStatus } from './types'

export type Diagnosis = 'failed' | 'asr_stuck' | 'no_chunks' | 'skipped' | 'unknown'

/** Why no utterance has appeared after ~90 s (PRODUCT §3.2 step 7). Order matters: the first match wins. */
export function diagnoseNoUtterances(p: Pick<PipelineStatus, 'counts' | 'errors'> | undefined): Diagnosis {
  if (!p) return 'unknown'
  const c = p.counts
  const total = c.pending + c.processing + c.done + c.failed + c.skipped
  if (c.failed > 0) return 'failed'
  if (total === 0) return 'no_chunks'
  if (c.pending + c.processing > 0 && c.done === 0 && c.skipped === 0) return 'asr_stuck'
  if (c.skipped > 0) return 'skipped'
  return 'unknown'
}

/** Three-stage progress for the first-transcript wait: recording -> uploaded -> processed by ASR. */
export function pipelineStages(recorderRecording: boolean, p: Pick<PipelineStatus, 'counts'> | undefined): [boolean, boolean, boolean] {
  const c = p?.counts
  const total = c ? c.pending + c.processing + c.done + c.failed + c.skipped : 0
  return [recorderRecording, total > 0, !!c && c.done + c.processing + c.skipped > 0]
}

/** Seconds spent waiting, clamped at 0 (clock skew safe). */
export function waitedSeconds(startMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - startMs) / 1000))
}
