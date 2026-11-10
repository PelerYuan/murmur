import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Circle, Loader2 } from 'lucide-react'
import { Banner } from '../ui/Misc'
import { Button } from '../ui/Button'
import { StepFooter, type StepProps } from './StepFooter'
import { openQueue } from '../shell/PipelineDrawer'
import { ssSet } from '../../lib/storage'
import { useRecorders, usePipeline, useSpeakerLookup } from '../../hooks/useData'
import { onboardingFlags } from '../../hooks/useOnboarding'
import { useNow } from '../../hooks/useNow'
import { useEvent } from '../../lib/events'
import { api } from '../../lib/api'
import { diagnoseNoUtterances, pipelineStages, waitedSeconds, type Diagnosis } from '../../lib/onboarding'
import type { Page, Utterance } from '../../lib/types'
import { cn } from '../../lib/cn'
import { useT, type TKey } from '../../i18n'

const DIAG_AFTER_S = 90
const DIAG_TEXT: Record<Diagnosis, TKey> = {
  failed: 'onb.diag_failed',
  asr_stuck: 'onb.diag_asr_stuck',
  no_chunks: 'onb.diag_no_chunks',
  skipped: 'onb.diag_skipped',
  unknown: 'onb.diag_unknown',
}

function Typewriter({ text }: { text: string }) {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const [n, setN] = useState(reduced ? text.length : 0)
  useEffect(() => {
    if (n >= text.length) return
    const id = setTimeout(() => setN((x) => Math.min(text.length, x + 1)), 40)
    return () => clearTimeout(id)
  }, [n, text])
  return <>{text.slice(0, n)}</>
}

export default function StepFirst({ go }: StepProps) {
  const t = useT()
  const nav = useNavigate()
  const qc = useQueryClient()
  const { label } = useSpeakerLookup()
  const pipe = usePipeline(3000)
  const recs = useRecorders(3000)
  const started = useRef(Date.now())
  const now = useNow(3000)
  const utts = useQuery({
    queryKey: ['utterances', 'welcome'],
    queryFn: () => api.get<Page<Utterance>>('/utterances', { limit: 5, order: 'desc', exclude_ignored: false }),
    refetchInterval: 5000,
  })
  useEvent('utterances.new', () => void qc.invalidateQueries({ queryKey: ['utterances', 'welcome'] }))

  const items = utts.data?.items ?? []
  const got = items.length > 0
  const recording = !!recs.data?.some((r) => r.online && r.config.enabled && r.status.state !== 'error')
  const stages = pipelineStages(recording, pipe.data)
  const waited = waitedSeconds(started.current, now)
  const diag = diagnoseNoUtterances(pipe.data)
  const stageLabels: TKey[] = ['onb.stage_recording', 'onb.stage_uploaded', 'onb.stage_asr']
  const finish = () => { onboardingFlags.setDismissed(false); ssSet('murmur.gate', '1'); nav('/', { replace: true }) }
  // The processing queue drawer lives in the app shell, so leave the wizard and open it there.
  const openQueueInShell = () => { ssSet('murmur.gate', '1'); nav('/'); setTimeout(openQueue, 600) }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-line bg-subtle/50 p-5 text-center">
        <p className="text-base font-semibold">{t('onb.first_title')}</p>
        <p className="mt-1 text-[13px] text-muted">{t('onb.first_wait')}</p>
        <div className="mx-auto mt-4 min-h-[88px] max-w-md space-y-2 text-left" aria-live="polite">
          {got ? items.map((u, i) => (
            <p key={u.id} className={cn('rounded-lg bg-surface px-3 py-2 text-sm shadow-card', i > 0 && 'opacity-70')}>
              <span className="mr-2 text-xs font-medium text-muted">{label(u.speaker_id, u.speaker_name)}</span>
              {i === 0 ? <Typewriter key={u.id} text={u.text} /> : u.text}
            </p>
          )) : (
            <p className="flex items-center justify-center gap-2 pt-6 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />{t('onb.first_listening')}</p>
          )}
        </div>
        {got && <p className="mt-3 flex items-center justify-center gap-1.5 text-sm font-medium text-ok"><CheckCircle2 className="h-4 w-4" />{t('onb.first_ok')}</p>}
      </div>

      {!got && (
        <ol className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]" aria-label={t('onb.stages')}>
          {stages.map((ok, i) => (
            <li key={i} className={cn('flex items-center gap-1.5', ok ? 'text-ok' : 'text-muted')}>
              {ok ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />}{t(stageLabels[i])}
            </li>
          ))}
        </ol>
      )}

      {!got && waited >= DIAG_AFTER_S && (
        <Banner tone="warn" title={t('onb.diag_title')} action={diag === 'failed' ? <Button size="sm" onClick={openQueueInShell}>{t('onb.diag_open_queue')}</Button> : undefined}>
          {diag === 'failed' && pipe.data?.errors[0] ? <p className="mb-1 break-words font-mono text-xs">{pipe.data.errors[0].error}</p> : null}
          {t(DIAG_TEXT[diag])}
        </Banner>
      )}
      <StepFooter step={7} go={go} canNext={got} nextLabel={t('onb.finish')} onNext={finish} />
    </div>
  )
}
