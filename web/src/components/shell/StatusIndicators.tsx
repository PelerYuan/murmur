import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Hourglass, Mic } from 'lucide-react'
import { api } from '../../lib/api'
import { qk } from '../../lib/queryClient'
import { asrTone, llmTone, queueTone, recorderTone, type Tone } from '../../lib/status'
import type { SummaryJob } from '../../lib/types'
import { useFmt, usePipeline, useRecorders } from '../../hooks/useData'
import { useNow } from '../../hooks/useNow'
import { Popover } from '../ui/Popover'
import { StatusDot } from '../ui/Misc'
import { cn } from '../../lib/cn'
import { useT } from '../../i18n'

interface PillProps { tone: Tone; label: string; children: React.ReactNode; onClick?: () => void; popover?: React.ReactNode; hideTextOnMobile?: boolean; text: string }

function Pill({ tone, label, children, popover, text, hideTextOnMobile, onClick }: PillProps) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        aria-label={`${label}: ${text}`}
        aria-expanded={popover ? open : undefined}
        onClick={() => (onClick ? onClick() : setOpen((o) => !o))}
        className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-xs font-medium text-muted transition-colors hover:bg-hover hover:text-fg max-sm:h-8"
      >
        <StatusDot tone={tone} pulse={tone === 'danger'} />
        <span className={cn('tabular', hideTextOnMobile && 'max-sm:hidden')}>{children}</span>
      </button>
      {popover && (
        <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-end" className="w-[min(320px,calc(100vw-16px))] p-3.5">
          {popover}
        </Popover>
      )}
    </>
  )
}

export function StatusIndicators({ onOpenQueue }: { onOpenQueue: () => void }) {
  const t = useT()
  const fmt = useFmt()
  const now = useNow(30_000)
  const recorders = useRecorders()
  const pipeline = usePipeline(15_000)
  const failedJobs = useQuery({
    queryKey: qk.jobs('failed'),
    queryFn: () => api.get<SummaryJob[]>('/summary-jobs', { status: 'failed' }),
    refetchInterval: 60_000,
    enabled: !!pipeline.data?.llm_configured,
  })
  const p = pipeline.data
  const recs = recorders.data
  const online = recs?.filter((r) => r.online).length ?? 0
  const rTone = recorderTone(recs)
  const qTone = queueTone(p, now)
  const aTone = asrTone(p)
  const jobs = failedJobs.data
  const lastJob = useMemo(() => (jobs && jobs.length ? [...jobs].sort((a, b) => b.id - a.id)[0] : undefined), [jobs])
  const lTone = llmTone(p, !!lastJob)
  const backlog = (p?.counts.pending ?? 0) + (p?.counts.processing ?? 0)

  const stateLabel = (s?: string) => (s ? t(`status.recorder_state_${s}` as 'status.recorder_state_recording') : '')

  return (
    <div className="flex items-center gap-1.5">
      <Pill
        tone={rTone}
        label={t('status.recorders')}
        text={recs?.length ? t('status.recorders_n', { on: online, total: recs.length }) : t('status.recorders_none')}
        popover={
          <div className="space-y-2.5">
            <p className="text-[13px] font-semibold">{t('status.recorders')}</p>
            {!recs?.length && <p className="text-[13px] text-muted">{t('status.recorders_none')}</p>}
            {recs?.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-[13px]">
                <StatusDot tone={!r.online || r.status?.state === 'error' ? 'danger' : r.status?.state === 'recording' ? 'ok' : 'warn'} />
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                <span className="text-xs text-muted">{r.online ? stateLabel(r.status?.state) : t('status.recorder_offline')}</span>
              </div>
            ))}
            <Link to="/recorders" className="block pt-1 text-[13px] font-medium text-accent hover:underline">{t('status.open_recorders')}</Link>
          </div>
        }
      >
        <Mic className="mr-1 inline h-3 w-3 sm:hidden" aria-hidden />
        <span className="max-sm:hidden">{recs?.length ? t('status.recorders_n', { on: online, total: recs.length }) : t('status.recorders_none')}</span>
        <span className="sm:hidden">{recs?.length ? `${online}/${recs.length}` : '–'}</span>
      </Pill>
      <Pill tone={qTone} label={t('status.queue')} text={t('status.queue_pending', { n: backlog })} onClick={onOpenQueue}>
        <Hourglass className="mr-1 inline h-3 w-3" aria-hidden />
        {backlog}
        {(p?.counts.failed ?? 0) > 0 && <span className="ml-1 text-danger">!{p?.counts.failed}</span>}
      </Pill>
      <Pill
        tone={aTone}
        label={t('status.asr')}
        text={p?.asr_ok == null ? t('status.asr_unknown') : p.asr_ok ? t('status.asr_ok') : t('status.asr_down')}
        popover={<StatusPopover title={p?.asr_ok === false ? t('status.asr_down') : p?.asr_ok ? t('status.asr_ok') : t('status.asr_unknown')} />}
        hideTextOnMobile
      >
        ASR
      </Pill>
      <Pill
        tone={lTone}
        label={t('status.llm')}
        text={!p?.llm_configured ? t('status.llm_none') : lastJob ? t('status.llm_failed') : t('status.llm_ok')}
        popover={
          <StatusPopover
            title={!p?.llm_configured ? t('status.llm_none') : lastJob ? t('status.llm_failed') : t('status.llm_ok')}
            detail={lastJob?.error ?? undefined}
            section="llm"
            when={lastJob ? fmt.dateTime(lastJob.range_end) : undefined}
          />
        }
        hideTextOnMobile
      >
        LLM
      </Pill>
    </div>
  )
}

function StatusPopover({ title, detail, section = 'asr', when }: { title: string; detail?: string; section?: string; when?: string }) {
  const t = useT()
  return (
    <div className="space-y-1.5 text-[13px]">
      <p className="font-semibold">{title}</p>
      {when && <p className="text-xs text-muted">{when}</p>}
      {detail && <p className="break-words rounded-md bg-subtle p-2 font-mono text-xs text-muted">{detail}</p>}
      <Link to={`/settings/${section}`} className="inline-block pt-1 font-medium text-accent hover:underline">{t('status.go_settings')}</Link>
    </div>
  )
}
