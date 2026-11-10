import type { Utterance } from './types'

/** Chronological comparator (started_at, then id). */
export function byTime(a: Utterance, b: Utterance): number {
  const d = Date.parse(a.started_at) - Date.parse(b.started_at)
  return d !== 0 ? d : a.id - b.id
}

/**
 * Merge freshly fetched utterances into a chronologically sorted list, de-duplicating by id.
 * Late-arriving rows (offline recorder back-fill) are inserted at their time position, not appended.
 * Newer data wins for rows that exist in both (e.g. after an edit).
 */
export function mergeUtterances(existing: Utterance[], incoming: Utterance[]): Utterance[] {
  if (incoming.length === 0) return existing
  const map = new Map<number, Utterance>()
  for (const u of existing) map.set(u.id, u)
  for (const u of incoming) map.set(u.id, u)
  return [...map.values()].sort(byTime)
}

/** Keep at most `max` rows, dropping the oldest. Returns the trimmed list and whether anything was dropped. */
export function trimOldest(list: Utterance[], max: number): { list: Utterance[]; trimmed: boolean } {
  if (list.length <= max) return { list, trimmed: false }
  return { list: list.slice(list.length - max), trimmed: true }
}

/** Latest started_at in a list (ISO), used as the `from` of an incremental fetch. */
export function latestStart(list: Utterance[]): string | null {
  return list.length ? list[list.length - 1].started_at : null
}

/** Append pages from useInfiniteQuery-style results into one flat list, skipping duplicates. */
export function flattenPages<T extends { id: number }>(pages: { items: T[] }[] | undefined): T[] {
  const seen = new Set<number>()
  const out: T[] = []
  for (const p of pages ?? []) for (const it of p.items) if (!seen.has(it.id)) { seen.add(it.id); out.push(it) }
  return out
}

/** Escape a user query for highlighting inside text. */
export function highlightParts(text: string, q: string): { text: string; hit: boolean }[] {
  const term = q.trim()
  if (!term) return [{ text, hit: false }]
  const out: { text: string; hit: boolean }[] = []
  const lower = text.toLowerCase()
  const lt = term.toLowerCase()
  let i = 0
  while (i < text.length) {
    const j = lower.indexOf(lt, i)
    if (j < 0) { out.push({ text: text.slice(i), hit: false }); break }
    if (j > i) out.push({ text: text.slice(i, j), hit: false })
    out.push({ text: text.slice(j, j + lt.length), hit: true })
    i = j + lt.length
  }
  return out
}
