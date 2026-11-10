import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { qk } from '../../lib/queryClient'
import { useEvent } from '../../lib/events'
import type { Recorder } from '../../lib/types'

/** Turns SSE events into cache invalidations (debounced) so every page stays fresh without polling hard. */
export function LiveSync() {
  const qc = useQueryClient()
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const later = (key: string, ms: number, fn: () => void) => {
    clearTimeout(timers.current.get(key))
    timers.current.set(key, setTimeout(fn, ms))
  }
  useEffect(() => () => timers.current.forEach(clearTimeout), [])
  const inv = (key: readonly unknown[]) => void qc.invalidateQueries({ queryKey: key })

  useEvent('utterances.new', () => {
    inv(qk.pipeline)
    later('dash', 2000, () => inv(qk.dashboard))
    later('speakers', 5000, () => inv(qk.speakers))
  })
  useEvent('summary.created', () => { inv(qk.summaries); inv(['jobs']); later('dash', 500, () => inv(qk.dashboard)) })
  useEvent(['todo.created', 'todo.updated'], () => { inv(qk.todos); later('dash', 1500, () => inv(qk.dashboard)) })
  useEvent('recorder.status', (d: { id: number; online: boolean; state: string }) => {
    qc.setQueryData<Recorder[]>(qk.recorders, (old) =>
      old?.map((r) => (r.id === d.id ? { ...r, online: d.online, status: { ...r.status, state: d.state as Recorder['status']['state'] } } : r)))
    inv(qk.recorders)
    later('dash', 2000, () => inv(qk.dashboard))
  })
  // After a reconnect everything may have changed while we were away.
  useEvent('open', () => {
    for (const k of [qk.pipeline, qk.dashboard, qk.recorders, qk.speakers, qk.todos, qk.summaries]) inv(k)
  })
  return null
}
