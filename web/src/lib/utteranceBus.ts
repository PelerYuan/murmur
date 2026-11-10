import type { Utterance } from './types'

/** Tiny pub/sub so list views (timeline, speaker detail) can patch their local rows after an edit made elsewhere. */
export type UtteranceChange =
  | { type: 'patch'; utterance: Utterance }
  | { type: 'delete'; ids: number[] }
  | { type: 'reassign'; ids: number[]; speakerId: number | null }

type Fn = (c: UtteranceChange) => void
const subs = new Set<Fn>()

export function subscribeUtterances(fn: Fn): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}
export function emitUtteranceChange(c: UtteranceChange): void {
  subs.forEach((fn) => fn(c))
}

/** Apply a change to a list of rows (pure, used by both views and tests). */
export function applyChange(rows: Utterance[], c: UtteranceChange, speakerName?: (id: number | null) => string | null): Utterance[] {
  switch (c.type) {
    case 'patch': return rows.map((r) => (r.id === c.utterance.id ? c.utterance : r))
    case 'delete': { const s = new Set(c.ids); return rows.filter((r) => !s.has(r.id)) }
    case 'reassign': {
      const s = new Set(c.ids)
      return rows.map((r) => (s.has(r.id) ? { ...r, speaker_id: c.speakerId, speaker_name: speakerName ? speakerName(c.speakerId) : r.speaker_name } : r))
    }
  }
}
