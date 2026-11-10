import type { Utterance } from './types'

export const CONVERSATION_GAP_MS = 5 * 60_000

export interface ConversationBlock {
  /** Stable id derived from the first utterance. */
  id: string
  start: string
  end: string
  roomId: number | null
  items: Utterance[]
  /** Distinct speakers in order of first appearance (null = unknown). */
  speakerIds: (number | null)[]
}

/**
 * Split chronologically ordered utterances into conversation blocks.
 * A new block starts when the room changes or the silence between two neighbours exceeds `gapMs`.
 */
export function groupConversations(utts: Utterance[], gapMs: number = CONVERSATION_GAP_MS): ConversationBlock[] {
  const blocks: ConversationBlock[] = []
  let cur: ConversationBlock | null = null
  let lastEnd = 0
  for (const u of utts) {
    const s = Date.parse(u.started_at)
    const e = Math.max(Date.parse(u.ended_at) || s, s)
    if (!cur || cur.roomId !== u.room_id || s - lastEnd > gapMs) {
      cur = { id: `b${u.id}`, start: u.started_at, end: u.ended_at, roomId: u.room_id, items: [], speakerIds: [] }
      blocks.push(cur)
      lastEnd = 0
    }
    cur.items.push(u)
    if (!cur.speakerIds.includes(u.speaker_id)) cur.speakerIds.push(u.speaker_id)
    if (e > Date.parse(cur.end)) cur.end = u.ended_at
    lastEnd = Math.max(lastEnd, e)
  }
  return blocks
}

export type TimelineItem =
  | { kind: 'header'; key: string; block: ConversationBlock; collapsed: boolean }
  | { kind: 'row'; key: string; utterance: Utterance; block: ConversationBlock }

/** Flatten blocks into a single list for the virtualiser; collapsed blocks only keep their header. */
export function flattenBlocks(blocks: ConversationBlock[], collapsed: ReadonlySet<string>): TimelineItem[] {
  const out: TimelineItem[] = []
  for (const b of blocks) {
    const c = collapsed.has(b.id)
    out.push({ kind: 'header', key: `h${b.id}`, block: b, collapsed: c })
    if (!c) for (const u of b.items) out.push({ kind: 'row', key: `u${u.id}`, utterance: u, block: b })
  }
  return out
}

/** Dominant language of a set of utterances (to hide the language tag on the majority language). */
export function dominantLang(utts: Utterance[]): string | null {
  const counts = new Map<string, number>()
  for (const u of utts) if (u.lang) counts.set(u.lang, (counts.get(u.lang) ?? 0) + 1)
  let best: string | null = null
  let n = 0
  for (const [k, v] of counts) if (v > n) { best = k; n = v }
  return best
}
