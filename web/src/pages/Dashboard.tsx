import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, ArrowRight, Check, Mic, RefreshCw, Sparkles } from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { qk } from '../lib/queryClient'
import { formatClock } from '../lib/time'
import type { Todo } from '../lib/types'
import { useDashboard, useFmt, usePipeline, useRecorders, useSettings, useSpeakerLookup } from '../hooks/useData'
import { onboardingFlags, useOnboarding } from '../hooks/useOnboarding'
import { useGenerateSummary } from '../hooks/useSummaryActions'
import { Page } from '../components/Page'
import { Button } from '../components/ui/Button'
import { Badge, EmptyState, ErrorBar, ProgressBar, Skeleton, StatusDot } from '../components/ui/Misc'
import { ConfirmDialog } from '../components/ui/Confirm'
import { Checkbox } from '../components/ui/Form'
import { useToast } from '../components/ui/Toast'
import { SpeakerDot } from '../components/SpeakerChip'
import { Markdown } from '../components/Markdown'
import { openQueue } from '../components/shell/PipelineDrawer'
import { recorderTone } from '../lib/status'
import { useT } from '../i18n'

function Card({ title, aside, children, className }: { title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('card flex flex-col p-4 sm:p-5', className)}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

export default function Dashboard() {
  const t = useT()
  const fmt = useFmt()
  const nav = useNavigate()
  const dash = useDashboard()
  const settings = useSettings(false)
  const pipeline = usePipeline(15_000)
  const recorders = useRecorders(30_000)
  const onboarding = useOnboarding()
  const d = dash.data
  const stale = dash.isError && !!d

  const noRecorder = !recorders.isLoading && (recorders.data?.length ?? 0) === 0
  const anyOnline = (recorders.data ?? []).some((r) => r.online)
  const showOnboarding = !onboarding.loading && !onboarding.dismissed && onboarding.requiredMissing

  return (
    <Page title={t('dash.title')} subtitle={d ? t('dash.today', { date: fmt.day(d.date, true) }) : undefined}>
      {dash.isError && (
        <ErrorBar className="mb-4" message={<>{t('dash.load_failed')}{(dash.error as Error)?.message ? ` · ${(dash.error as Error).message}` : ''}</>} onRetry={() => void dash.refetch()} retryLabel={t('common.retry')} />
      )}
      {showOnboarding && (
        <section className="mb-5 flex flex-wrap items-center gap-4 rounded-xl border border-accent/30 bg-accent-soft/50 p-4 sm:p-5" aria-label={t('dash.onboarding_title', { done: onboarding.doneCount, total: 7 })}>
          <div className="min-w-0 flex-1 basis-64">
            <p className="font-semibold">{t('dash.onboarding_title', { done: onboarding.doneCount, total: 7 })}</p>
            <p className="mt-0.5 text-[13px] text-muted">{t('dash.onboarding_body')}</p>
            <ProgressBar className="mt-3 max-w-xs" value={onboarding.doneCount} max={7} label={t('dash.onboarding_title', { done: onboarding.doneCount, total: 7 })} />
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onboardingFlags.setDismissed(true)}>{t('dash.onboarding_dismiss')}</Button>
            <Button variant="primary" icon={<ArrowRight className="h-4 w-4" />} onClick={() => nav('/welcome')}>{t('dash.onboarding_continue')}</Button>
          </div>
        </section>
      )}

      <div className={cn('grid gap-4 lg:grid-cols-2', stale && 'opacity-60')} aria-busy={dash.isLoading}>
        <div className="space-y-4">
          <TodayCard loading={dash.isLoading} noRecorder={noRecorder} anyOnline={anyOnline} />
          <RecordersCard />
        </div>
        <div className="space-y-4">
          <SummaryCard llm={!!pipeline.data?.llm_configured} dailyTime={settings.data?.schedule.daily.enabled ? settings.data.schedule.daily.time : null} />
          <TodosCard />
          <Card title={t('dash.queue')} aside={<Button size="sm" variant="ghost" onClick={openQueue}>{t('dash.queue_open')}</Button>}>
            <button type="button" onClick={openQueue} className="flex w-full items-center gap-3 rounded-lg text-left" aria-label={t('dash.queue_open')}>
              <Activity className="h-5 w-5 text-muted" aria-hidden />
              {pipeline.isLoading ? <Skeleton className="h-5 w-40" /> : (() => {
                const pending = (pipeline.data?.counts.pending ?? 0) + (pipeline.data?.counts.processing ?? 0)
                const failed = pipeline.data?.counts.failed ?? 0
                return pending === 0 && failed === 0
                  ? <span className="text-sm text-muted">{t('dash.queue_ok')}</span>
                  : <span className="flex flex-wrap gap-x-3 text-sm"><span>{t('dash.queue_pending', { n: pending })}</span>{failed > 0 && <span className="font-medium text-danger">{t('dash.queue_failed', { n: failed })}</span>}</span>
              })()}
            </button>
          </Card>
        </div>
      </div>
    </Page>
  )
}

function TodayCard({ loading, noRecorder, anyOnline }: { loading: boolean; noRecorder: boolean; anyOnline: boolean }) {
  const t = useT()
  const fmt = useFmt()
  const nav = useNavigate()
  const { data: d } = useDashboard()
  const { map } = useSpeakerLookup()

  const bars = useMemo(() => {
    if (!d) return []
    const named: { key: string; name: string; color: string | null; seconds: number; id: number | null; unnamed?: boolean }[] = []
    let unnamedSec = 0, unnamedN = 0
    for (const s of d.today.by_speaker) {
      const sp = s.speaker_id != null ? map.get(s.speaker_id) : undefined
      if (sp?.state === 'unnamed' && s.speaker_id != null) { unnamedSec += s.seconds; unnamedN++ }
      else named.push({ key: String(s.speaker_id ?? 'u'), name: s.speaker_id == null ? t('dash.unknown') : s.display_name, color: s.color, seconds: s.seconds, id: s.speaker_id })
    }
    if (unnamedN > 0) named.push({ key: 'unnamed', name: t('dash.unnamed_merged', { n: unnamedN }), color: null, seconds: unnamedSec, id: null, unnamed: true })
    return named.sort((a, b) => b.seconds - a.seconds)
  }, [d, map, t])
  const max = Math.max(1, ...bars.map((b) => b.seconds))

  if (loading && !d) return <Card title={t('dash.today', { date: '' })}><Skeleton className="h-32" /></Card>
  if (noRecorder) {
    return (
      <Card title={t('dash.recorders')}>
        <EmptyState compact icon={<Mic />} title={t('dash.no_recorder_title')} body={t('dash.no_recorder_body')} action={<Button variant="primary" onClick={() => nav('/welcome')}>{t('dash.no_recorder_cta')}</Button>} />
      </Card>
    )
  }
  return (
    <Card title={d ? t('dash.today', { date: fmt.day(d.date) }) : t('dash.today', { date: '' })}>
      {d && d.today.utterance_count === 0 ? (
        <div className="py-4">
          <p className="text-[15px] font-medium">{t('dash.today_empty')}</p>
          <p className={cn('mt-1 flex items-center gap-1.5 text-[13px]', anyOnline ? 'text-muted' : 'font-medium text-danger')}>
            <StatusDot tone={anyOnline ? 'ok' : 'danger'} pulse={anyOnline} />
            {anyOnline ? t('dash.today_empty_online') : t('dash.today_empty_offline')}
          </p>
        </div>
      ) : d && (
        <>
          <p className="tabular text-2xl font-semibold tracking-tight">{t('dash.today_stats', { n: d.today.utterance_count, d: fmt.duration(d.today.speech_seconds) })}</p>
          <ul className="mt-4 space-y-1.5" aria-label={t('dash.speakers_bar')}>
            {bars.map((b) => (
              <li key={b.key}>
                <button
                  type="button"
                  onClick={() => nav(b.unnamed ? '/speakers?tab=unnamed' : b.id != null ? `/timeline?speaker_id=${b.id}` : '/timeline')}
                  className="group flex w-full items-center gap-3 rounded-md px-1.5 py-1 text-left hover:bg-hover"
                >
                  <span className="flex w-28 shrink-0 items-center gap-2 truncate text-sm">
                    <SpeakerDot color={b.color} dashed={b.unnamed} />
                    <span className={cn('truncate', b.unnamed && 'italic')}>{b.name}</span>
                  </span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-subtle">
                    <span className="block h-full rounded-full" style={{ width: `${(b.seconds / max) * 100}%`, backgroundColor: b.color || 'rgb(var(--faint))' }} />
                  </span>
                  <span className="tabular w-14 shrink-0 text-right text-xs text-muted">{fmt.duration(b.seconds)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  )
}

function RecordersCard() {
  const t = useT()
  const fmt = useFmt()
  const { data, isLoading } = useRecorders(30_000)
  const rooms = useQuery({ queryKey: qk.rooms, queryFn: () => api.get<{ id: number; name: string }[]>('/rooms'), staleTime: 60_000 })
  if (!isLoading && (data?.length ?? 0) === 0) return null
  return (
    <Card title={t('dash.recorders')} aside={<Link to="/recorders" className="text-xs font-medium text-accent hover:underline">{t('common.view_all')}</Link>}>
      {isLoading ? <Skeleton className="h-10" /> : (
        <ul className="divide-y divide-line">
          {(data ?? []).map((r) => {
            const tone = recorderTone([r])
            const state = r.status.state
            return (
              <li key={r.id}>
                <Link to="/recorders" className="flex items-center gap-3 py-2.5 text-sm hover:text-accent">
                  <StatusDot tone={tone} pulse={r.online && state === 'recording'} />
                  <span className="min-w-0 flex-1 truncate font-medium">{r.name}{r.room_id != null && <span className="ml-2 font-normal text-muted">{rooms.data?.find((x) => x.id === r.room_id)?.name}</span>}</span>
                  <span className="text-xs text-muted">
                    {r.online
                      ? <>{state ? t(`status.recorder_state_${state}` as 'status.recorder_state_recording') : ''}{r.status.level_db != null && state === 'recording' && <span className="tabular"> · {Math.round(r.status.level_db)} dB</span>}</>
                      : r.last_seen ? t('dash.recorder_offline_since', { t: fmt.relative(r.last_seen) }) : t('status.recorder_never_seen')}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

function SummaryCard({ llm, dailyTime }: { llm: boolean; dailyTime: string | null }) {
  const t = useT()
  const fmt = useFmt()
  const { data: d, isLoading } = useDashboard()
  const gen = useGenerateSummary()
  const toast = useToast()
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const s = d?.latest_summary

  const run = (kind: 'today' | 'again') => {
    let args
    if (kind === 'again' && s) args = { level: s.level, start: s.range_start, end: s.range_end, room_id: s.room_id }
    else { const r = fmt.range(fmt.today()); args = { level: 'custom' as const, start: r.from, end: new Date().toISOString() } }
    setBusy(true)
    gen.mutate(args, {
      onSuccess: () => { toast.success(t('dash.summary_generating')); void qc.invalidateQueries({ queryKey: qk.summaries }) },
      onError: (e) => { toast.error(e); setBusy(false) },
      onSettled: () => setTimeout(() => setBusy(false), 4000),
    })
  }

  return (
    <Card
      title={t('dash.latest_summary')}
      aside={llm ? <Button size="sm" variant="ghost" icon={<Sparkles className="h-3.5 w-3.5" />} loading={busy && !s} onClick={() => run('today')}>{t('dash.summary_generate_today')}</Button> : undefined}
    >
      {isLoading && !d ? <Skeleton className="h-28" /> : s ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">{t(`dash.level_${s.level}` as 'dash.level_daily')}</Badge>
            <h4 className="min-w-0 flex-1 truncate font-semibold">{s.title}</h4>
          </div>
          <p className="mt-1 text-xs text-muted">
            {t('dash.summary_meta', { range: `${fmt.dateTime(s.range_start)} – ${formatClock(s.range_end, fmt.tz)}`, n: s.utterance_count })}{s.model ? ` · ${s.model}` : ''}
          </p>
          <div className="relative mt-3 max-h-40 overflow-hidden">
            <Markdown className="text-sm">{s.content}</Markdown>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent" />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link to={`/summaries?id=${s.id}`} className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg hover:bg-accent/90 max-sm:h-10">{t('dash.summary_view')}</Link>
            {llm && <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={busy} onClick={() => setConfirm(true)}>{t('dash.summary_regen')}</Button>}
          </div>
          <ConfirmDialog open={confirm} title={t('dash.summary_regen_confirm_title')} body={t('dash.summary_regen_confirm_body')} confirmLabel={t('dash.summary_regen')} onClose={() => setConfirm(false)} onConfirm={() => { setConfirm(false); run('again') }} />
        </>
      ) : llm ? (
        <EmptyState compact title={t('dash.summary_empty')} body={<>{t('dash.summary_empty_body')}{dailyTime && <><br />{t('dash.summary_schedule', { time: dailyTime })}</>}</>}
          action={<Button variant="primary" loading={busy} onClick={() => run('today')} icon={<Sparkles className="h-4 w-4" />}>{t('dash.summary_generate_today')}</Button>} />
      ) : (
        <EmptyState compact title={t('dash.summary_no_llm')} body={t('dash.summary_no_llm_body')} action={<Link to="/settings/llm" className="inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-fg hover:bg-accent/90">{t('dash.summary_go_llm')}</Link>} />
      )}
    </Card>
  )
}

function TodosCard() {
  const t = useT()
  const fmt = useFmt()
  const qc = useQueryClient()
  const toast = useToast()
  const { data: d } = useDashboard()
  const list = useQuery({ queryKey: [...qk.todos, 'open', null, ''], queryFn: () => api.get<Todo[]>('/todos', { status: 'open' }) })
  const done = useMutation({
    mutationFn: ({ id, status }: { id: number; status: 'done' | 'open' }) => api.patch<Todo>(`/todos/${id}`, { status }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: qk.todos }); void qc.invalidateQueries({ queryKey: qk.dashboard }) },
    onError: (e) => toast.error(e),
  })
  const items = (list.data ?? []).slice(0, 5)
  const now = Date.now()
  return (
    <Card title={t('dash.todos')} aside={<span className="flex items-center gap-3"><span className="text-xs text-muted">{t('dash.todos_open', { n: d?.open_todos ?? list.data?.length ?? 0 })}</span><Link to="/todos" className="text-xs font-medium text-accent hover:underline">{t('dash.todos_all')}</Link></span>}>
      {list.isLoading ? <Skeleton className="h-24" /> : items.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted"><Check className="mx-auto mb-1.5 h-5 w-5 text-ok" aria-hidden />{t('dash.todos_empty')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((td) => {
            const overdue = !!td.due_at && Date.parse(td.due_at) < now
            return (
              <li key={td.id} className="flex items-start gap-3 py-2">
                <Checkbox
                  round
                  checked={false}
                  className="mt-0.5"
                  hideLabel={t('todos.complete_aria', { text: td.text })}
                  onChange={() => {
                    qc.setQueryData<Todo[]>([...qk.todos, 'open', null, ''], (o) => o?.filter((x) => x.id !== td.id))
                    done.mutate({ id: td.id, status: 'done' }, { onSuccess: () => toast.undo(t('todos.done_toast'), () => done.mutate({ id: td.id, status: 'open' })) })
                  }}
                />
                <Link to={`/todos?focus=${td.id}`} className="min-w-0 flex-1">
                  <span className="block break-words text-sm leading-6 hover:text-accent">{td.text}</span>
                  {td.due_at && <span className={cn('text-xs', overdue ? 'font-medium text-danger' : 'text-muted')}>{fmt.due(td.due_at)}</span>}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

