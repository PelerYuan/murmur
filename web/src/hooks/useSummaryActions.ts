import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { qk } from '../lib/queryClient'
import type { SummaryJob, SummaryLevel } from '../lib/types'
import { useFmt, usePipeline } from './useData'
import { useToast } from '../components/ui/Toast'
import { useT } from '../i18n'

export interface GenerateArgs { level: SummaryLevel; start: string; end: string; room_id?: number | null }

export function useGenerateSummary() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (a: GenerateArgs) => api.post<SummaryJob>('/summaries/generate', { level: a.level, start: a.start, end: a.end, ...(a.room_id ? { room_id: a.room_id } : {}) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['jobs'] }) },
  })
}

/** "Regenerate today's summary" — range is today 00:00 (server tz) → now, level custom. */
export function useRegenerateToday() {
  const fmt = useFmt()
  const t = useT()
  const toast = useToast()
  const gen = useGenerateSummary()
  const pipeline = usePipeline(false)
  const qc = useQueryClient()
  return {
    available: !!pipeline.data?.llm_configured,
    run: () => {
      const r = fmt.range(fmt.today())
      gen.mutate({ level: 'custom', start: r.from, end: new Date().toISOString() }, {
        onSuccess: () => { toast.success(t('summaries.regenerating')); void qc.invalidateQueries({ queryKey: qk.summaries }) },
        onError: (e) => toast.error(e),
      })
    },
  }
}
