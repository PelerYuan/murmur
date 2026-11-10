export type NameCheck =
  | { ok: true; name: string }
  | { ok: false; reason: 'empty' | 'too_long' | 'numeric' }

/** 1–30 chars after trimming; not purely digits (would be confused with "Speaker N"). Empty means "remove the name". */
export function validateSpeakerName(raw: string): NameCheck {
  const name = raw.trim().replace(/\s+/g, ' ')
  if (!name) return { ok: false, reason: 'empty' }
  if ([...name].length > 30) return { ok: false, reason: 'too_long' }
  if (/^\d+$/.test(name)) return { ok: false, reason: 'numeric' }
  return { ok: true, name }
}

export interface NamedLike { id: number; name: string | null; state: string; utterance_count?: number }

/** Another speaker that already carries exactly this name (case-insensitive). */
export function findDuplicateName<T extends NamedLike>(speakers: T[], name: string, selfId: number): T | undefined {
  const n = name.trim().toLowerCase()
  return speakers.find((s) => s.id !== selfId && s.name && s.name.trim().toLowerCase() === n && s.state !== 'unnamed')
}

/** Default merge direction: keep the named speaker; if equal, keep the one with more utterances. */
export function defaultMergeTarget<T extends { id: number; state: string; utterance_count: number }>(a: T, b: T): { source: T; target: T } {
  const rank = (s: T) => (s.state === 'named' ? 2 : s.state === 'unnamed' ? 1 : 0)
  if (rank(a) !== rank(b)) return rank(a) > rank(b) ? { source: b, target: a } : { source: a, target: b }
  return a.utterance_count >= b.utterance_count ? { source: b, target: a } : { source: a, target: b }
}
