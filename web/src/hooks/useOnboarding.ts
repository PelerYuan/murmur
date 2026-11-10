import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { lsGet, lsSet } from '../lib/storage'
import type { Page, Utterance } from '../lib/types'
import { usePipeline, useRecorders, useRooms } from './useData'
import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((f) => f())
const sub = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }

export const onboardingFlags = {
  get dismissed() { return lsGet('murmur.onboarding.skipped') === 'true' },
  setDismissed(v: boolean) { lsSet('murmur.onboarding.skipped', v ? 'true' : 'false'); notify() },
  get llmSkipped() { return lsGet('murmur.onboarding.skip_llm') === 'true' },
  setLlmSkipped(v: boolean) { lsSet('murmur.onboarding.skip_llm', v ? 'true' : null); notify() },
}

export interface OnboardingState {
  loading: boolean
  /** done flags for the 7 steps (index 0 = step 1). */
  done: boolean[]
  doneCount: number
  /** First step (1-based) that is not complete among the required ones. */
  firstOpen: number | null
  requiredMissing: boolean
  dismissed: boolean
}

/** Onboarding has no server state: progress is derived from existing data (see PRODUCT §3.1). */
export function useOnboarding(): OnboardingState {
  const rooms = useRooms()
  const recorders = useRecorders()
  const pipeline = usePipeline(false)
  const first = useQuery({ queryKey: ['utterances', 'first'], queryFn: () => api.get<Page<Utterance>>('/utterances', { limit: 1, exclude_ignored: false }), staleTime: 30_000 })
  const dismissed = useSyncExternalStore(sub, () => onboardingFlags.dismissed)
  const llmSkipped = useSyncExternalStore(sub, () => onboardingFlags.llmSkipped)

  const loading = rooms.isLoading || recorders.isLoading || pipeline.isLoading || first.isLoading
  const recs = recorders.data ?? []
  const done = [
    true,
    (rooms.data?.length ?? 0) > 0,
    recs.length > 0,
    recs.some((r) => !!r.last_seen),
    pipeline.data?.asr_ok === true,
    !!pipeline.data?.llm_configured || llmSkipped,
    (first.data?.items.length ?? 0) > 0,
  ]
  const required = [0, 1, 2, 3, 4, 6]
  const firstOpen = required.find((i) => !done[i])
  return {
    loading,
    done,
    doneCount: done.filter(Boolean).length,
    firstOpen: firstOpen == null ? null : firstOpen + 1,
    requiredMissing: firstOpen != null,
    dismissed,
  }
}
