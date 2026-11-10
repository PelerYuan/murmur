import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { Page, Utterance } from '../lib/types'
import { mergeUtterances, latestStart, trimOldest } from '../lib/pagination'
import { subscribeUtterances, applyChange } from '../lib/utteranceBus'

export interface FeedParams {
  from: string
  to: string
  roomId?: number | null
  speakerId?: number | null
  includeIgnored: boolean
  /** Make sure this utterance is part of the loaded rows (context jump). */
  aroundId?: number | null
  enabled: boolean
}

const PAGE = 200
const MAX_ROWS = 5000

/**
 * Chronological (old → new) feed for a time range. The API is newest-first with cursors, so the first
 * page is the newest 200 rows and "load older" walks the cursor backwards. Live tail fetches `order=asc&from=latest`.
 */
export function useTimelineFeed(p: FeedParams, speakerName: (id: number | null) => string | null) {
  const [rows, setRows] = useState<Utterance[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [prepended, setPrepended] = useState(0)
  const [trimmed, setTrimmed] = useState(false)
  const key = useMemo(() => JSON.stringify([p.from, p.to, p.roomId, p.speakerId, p.includeIgnored, p.aroundId]), [p.from, p.to, p.roomId, p.speakerId, p.includeIgnored, p.aroundId])
  const keyRef = useRef(key)
  keyRef.current = key
  const nameRef = useRef(speakerName)
  nameRef.current = speakerName

  const base = useMemo(() => ({
    from: p.from, to: p.to, room_id: p.roomId ?? undefined, speaker_id: p.speakerId ?? undefined, exclude_ignored: !p.includeIgnored,
  }), [p.from, p.to, p.roomId, p.speakerId, p.includeIgnored])

  const load = useCallback(async () => {
    const k = keyRef.current
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<Page<Utterance>>('/utterances', { ...base, limit: PAGE })
      let list = [...res.items].reverse()
      const next = res.next_cursor
      if (p.aroundId && !list.some((u) => u.id === p.aroundId)) {
        const ctx = await api.get<Page<Utterance> | Utterance[]>('/utterances', { around: p.aroundId, window: 1800, exclude_ignored: !p.includeIgnored, limit: 500 })
        list = mergeUtterances(list, Array.isArray(ctx) ? ctx : ctx.items)
        // Keep the newest-page cursor: loading older walks back and eventually fills any gap before the context window.
      }
      if (keyRef.current !== k) return
      setRows(list)
      setCursor(next)
      setPrepended(0)
      setTrimmed(false)
    } catch (e) {
      if (keyRef.current === k) setError(e as Error)
    } finally {
      if (keyRef.current === k) setLoading(false)
    }
  }, [base, p.aroundId, p.includeIgnored])

  useEffect(() => {
    setRows([]); setCursor(null)
    if (p.enabled) void load()
  }, [key, p.enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadOlder = useCallback(async () => {
    if (!cursor || loadingOlder) return
    const k = keyRef.current
    setLoadingOlder(true)
    try {
      const res = await api.get<Page<Utterance>>('/utterances', { ...base, limit: PAGE, cursor })
      if (keyRef.current !== k) return
      setRows((cur) => {
        const merged = mergeUtterances(cur, res.items)
        setPrepended(merged.length - cur.length)
        return merged
      })
      setCursor(res.next_cursor)
    } catch (e) {
      if (keyRef.current === k) setError(e as Error)
    } finally {
      setLoadingOlder(false)
    }
  }, [cursor, loadingOlder, base])

  /** Fetch everything newer than what we have (called on SSE utterances.new). Returns how many rows were new. */
  const refreshTail = useCallback(async (): Promise<number> => {
    const k = keyRef.current
    try {
      const from = latestStart(rows) ?? p.from
      const res = await api.get<Page<Utterance>>('/utterances', { ...base, from, order: 'asc', limit: 500 })
      if (keyRef.current !== k) return 0
      let added = 0
      setRows((cur) => {
        const known = new Set(cur.map((u) => u.id))
        added = res.items.filter((u) => !known.has(u.id)).length
        if (added === 0) return cur
        const { list, trimmed: tr } = trimOldest(mergeUtterances(cur, res.items), MAX_ROWS)
        if (tr) { setTrimmed(true) }
        return list
      })
      return added
    } catch { return 0 }
  }, [rows, base, p.from])

  // Edits/deletes/reassignments made anywhere in the app patch the local rows without a refetch.
  useEffect(() => subscribeUtterances((c) => setRows((cur) => applyChange(cur, c, (id) => nameRef.current(id)))), [])

  return { rows, setRows, loading, loadingOlder, error, hasOlder: !!cursor, loadOlder, refreshTail, reload: load, prepended, trimmed }
}
