import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowUpRight, Copy, FileText, RefreshCw, Sparkles, Trash2, X } from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { qk } from '../lib/queryClient'
import { flattenPages } from '../lib/pagination'
import { formatClock } from '../lib/time'
import type { Page as PageT, Summary, SummaryJob, SummaryLevel } from '../lib/types'
import { useEvent } from '../lib/events'
import { useFmt, usePipeline, useRooms, useSettings } from '../hooks/useData'
import { useIsMobile } from '../hooks/useMedia'
import { usePageKeys } from '../hooks/useShortcuts'
import { usePageTitle } from '../hooks/usePageTitle'
import { Button } from '../components/ui/Button'
import { Badge, Banner, EmptyState, ErrorBar, Skeleton, Spinner, Tabs } from '../components/ui/Misc'
import { Select } from '../components/ui/Form'
import { ConfirmDialog } from '../components/ui/Confirm'
import { useToast } from '../components/ui/Toast'
import { Markdown } from '../components/Markdown'
import { GenerateSummaryDialog, type GenerateInit } from '../components/summaries/GenerateDialog'
import { useT } from '../i18n'

type Tab = 'all' | SummaryLevel

const levelTone = { daily: 'accent', hourly: 'info', incremental: 'neutral', custom: 'warn' } as const

export default function Summaries() {
  const t = useT()
  const fmt = useFmt()
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const mobile = useIsMobile()
  const [params, setParams] = useSearchParams()
  usePageTitle(t('summaries.title'))
  const selectedId = params.get('id') ? Number(params.get('id')) : null
  const [tab, setTab] = useState<Tab>('all')
  const [roomId, setRoomId] = useState<number | null>(null)
  const rooms = useRooms()
  const pipeline = usePipeline(false)
  const settings = useSettings(false)
  const llm = !!pipeline.data?.llm_configured
  const [genOpen, setGenOpen] = useState<GenerateInit | true | null>(null)
  const [watching, setWatching] = useState<number[]>([])
  const [failed, setFailed] = useState<SummaryJob[]>([])
  const [deleting, setDeleting] = useState<Summary | null>(null)

  const select = useCallback((id: number | null, replace = false) => {
    setParams((cur) => { const p = new URLSearchParams(cur); if (id == null) p.delete('id'); else p.set('id', String(id)); return p }, { replace })
  }, [setParams])

  const list = useInfiniteQuery({
    queryKey: [...qk.summaries, 'list', tab, roomId],
    queryFn: ({ pageParam }) => api.get<PageT<Summary>>('/summaries', { level: tab === 'all' ? undefined : tab, room_id: roomId ?? undefined, limit: 40, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_cursor ?? undefined,
  })
  const rows = useMemo(() => flattenPages(list.data?.pages), [list.data])

  // Day groups (server tz): the daily summary first, then the rest by time descending.
  const groups = useMemo(() => {
    const m = new Map<string, Summary[]>()
    for (const s of rows) { const k = fmt.dateKey(s.range_start); m.set(k, [...(m.get(k) ?? []), s]) }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([k, items]) => ({
      key: k,
      items: items.sort((a, b) => (a.level === 'daily' ? -1 : 0) - (b.level === 'daily' ? -1 : 0) || Date.parse(b.range_start) - Date.parse(a.range_start)),
    }))
  }, [rows, fmt])
  const flatOrder = useMemo(() => groups.flatMap((g) => g.items), [groups])

  // Jobs: poll every 2 s while anything is queued/running.
  const jobs = useQuery({
    queryKey: qk.jobs('active'),
    queryFn: () => api.get<SummaryJob[] | PageT<SummaryJob>>('/summary-jobs').then((r) => (Array.isArray(r) ? r : r.items)),
    refetchInterval: (q) => ((q.state.data ?? []).some((j) => j.status === 'queued' || j.status === 'running') || watching.length > 0 ? 2000 : false),
  })
  const active = (jobs.data ?? []).filter((j) => j.status === 'queued' || j.status === 'running')
  useEvent('summary.created', () => { void qc.invalidateQueries({ queryKey: qk.summaries }); void jobs.refetch() })

  // Watch the jobs we started: select the result, surface failures.
  useEffect(() => {
    if (!watching.length || !jobs.data) return
    const fin = jobs.data.filter((j) => watching.includes(j.id) && (j.status === 'done' || j.status === 'failed'))
    if (!fin.length) return
    setWatching((w) => w.filter((id) => !fin.some((j) => j.id === id)))
    void qc.invalidateQueries({ queryKey: qk.summaries })
    for (const j of fin) {
      if (j.status === 'failed') setFailed((f) => [...f.filter((x) => x.id !== j.id), j])
      else if (j.summary_id) { toast.success(t('summaries.job_done')); select(j.summary_id) }
      else if (j.error === 'no_utterances') toast.error(new Error(t('summaries.job_no_utterances')))
    }
  }, [jobs.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const detail = useQuery({
    queryKey: [...qk.summaries, 'one', selectedId],
    queryFn: () => api.get<Summary>(`/summaries/${selectedId}`),
    enabled: selectedId != null,
    retry: false,
  })
  const sel = detail.data ?? rows.find((r) => r.id === selectedId)

  // Desktop: auto-select the newest summary.
  useEffect(() => { if (!mobile && selectedId == null && flatOrder.length) select(flatOrder[0].id, true) }, [mobile, selectedId, flatOrder, select])

  const del = useMutation({
    mutationFn: (id: number) => api.del(`/summaries/${id}`),
    onSuccess: (_d, id) => { toast.success(t('summaries.deleted')); void qc.invalidateQueries({ queryKey: qk.summaries }); void qc.invalidateQueries({ queryKey: qk.dashboard }); if (selectedId === id) select(null, true) },
    onError: (e) => toast.error(e),
  })

  usePageKeys((e) => {
    if (e.key !== 'j' && e.key !== 'k') return
    const i = flatOrder.findIndex((s) => s.id === selectedId)
    const n = flatOrder[e.key === 'j' ? i + 1 : i - 1]
    if (n) select(n.id)
  }, [flatOrder, selectedId])

  const retry = (j: SummaryJob) => {
    setFailed((f) => f.filter((x) => x.id !== j.id))
    api.post<SummaryJob>('/summaries/generate', { level: j.level, start: j.range_start, end: j.range_end, ...(j.room_id ? { room_id: j.room_id } : {}) })
      .then((nj) => { setWatching((w) => [...w, nj.id]); void jobs.refetch() })
      .catch((e) => toast.error(e))
  }

  const copy = (s: Summary) => navigator.clipboard?.writeText(s.content).then(() => toast.success(t('summaries.copied')), () => toast.error(new Error(t('common.copy_failed'))))

  const levelLabel = (l: SummaryLevel) => t(`summaries.level_${l}` as 'summaries.level_daily')
  const showList = !mobile || selectedId == null
  const showDetail = !mobile || selectedId != null

  const noData = !list.isLoading && !list.isError && rows.length === 0

  const listPane = (
    <div className="flex min-h-0 flex-col">
      <div className="space-y-2.5 border-b border-line p-3">
        <div className="flex items-center gap-2">
          <Tabs
            label={t('summaries.title')}
            value={tab}
            onChange={setTab}
            className="flex-1"
            items={[
              { value: 'all', label: t('summaries.tab_all') },
              { value: 'daily', label: t('summaries.tab_daily') },
              { value: 'hourly', label: t('summaries.tab_hourly') },
              { value: 'incremental', label: t('summaries.tab_incremental') },
              { value: 'custom', label: t('summaries.tab_custom') },
            ]}
          />
        </div>
        <div className="flex items-center gap-2">
          {(rooms.data?.length ?? 0) > 1 && (
            <Select className="min-w-0 flex-1" value={roomId ?? ''} onChange={(e) => setRoomId(e.target.value ? Number(e.target.value) : null)} aria-label={t('summaries.room')}>
              <option value="">{t('summaries.all_rooms')}</option>
              {(rooms.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          )}
          <Button variant="primary" className="ml-auto" disabled={!llm} title={llm ? undefined : t('summaries.generate_disabled_llm')} icon={<Sparkles className="h-4 w-4" />} onClick={() => setGenOpen(true)}>
            {t('summaries.generate')}
          </Button>
        </div>
      </div>
      {(active.length > 0 || failed.length > 0) && (
        <div className="space-y-2 border-b border-line p-3">
          {active.length > 0 && (
            <Banner tone="info" role="status">
              <span className="flex items-center gap-2"><Spinner />{t('summaries.jobs_running', { n: active.length })}</span>
            </Banner>
          )}
          {failed.map((j) => (
            <Banner key={j.id} tone="danger" title={t('summaries.job_failed')}
              action={<span className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => retry(j)}>{t('summaries.job_retry')}</Button><button aria-label={t('common.dismiss')} onClick={() => setFailed((f) => f.filter((x) => x.id !== j.id))} className="rounded-md p-1 text-muted hover:bg-hover"><X className="h-4 w-4" /></button></span>}>
              <span className="break-words">{j.error}</span>
            </Banner>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isLoading ? (
          <div className="space-y-2 p-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : list.isError ? (
          <div className="p-3"><ErrorBar message={`${t('summaries.load_failed')} · ${(list.error as Error).message}`} onRetry={() => void list.refetch()} retryLabel={t('common.retry')} /></div>
        ) : noData ? (
          <EmptyState
            compact
            icon={<FileText />}
            title={tab !== 'all' || roomId ? t('summaries.empty_filtered') : llm ? t('summaries.empty') : t('summaries.empty_no_llm')}
            body={tab !== 'all' || roomId ? undefined : llm ? <>{t('summaries.empty_body')}{settings.data?.schedule.daily.enabled && <><br />{t('summaries.empty_schedule', { time: settings.data.schedule.daily.time })}</>}</> : t('summaries.empty_no_llm_body')}
            action={tab !== 'all' || roomId ? undefined : llm
              ? <Button variant="primary" icon={<Sparkles className="h-4 w-4" />} onClick={() => setGenOpen(true)}>{t('summaries.generate_today')}</Button>
              : <Button variant="primary" onClick={() => navigate('/settings/llm')}>{t('summaries.go_llm')}</Button>}
          />
        ) : (
          <div role="listbox" aria-label={t('summaries.title')}>
            {groups.map((g) => (
              <section key={g.key}>
                <h3 className="sticky top-0 z-[1] bg-bg/95 px-4 py-1.5 text-xs font-semibold text-muted backdrop-blur">{fmt.day(g.key, true)}</h3>
                {g.items.map((s) => {
                  const compact = s.level === 'incremental'
                  const on = s.id === selectedId
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="option"
                      aria-selected={on}
                      onClick={() => select(s.id)}
                      className={cn('flex w-full items-start gap-2.5 border-l-2 px-4 text-left transition-colors hover:bg-hover', compact ? 'py-1.5' : 'py-2.5', on ? 'border-accent bg-accent-soft/50' : 'border-transparent')}
                    >
                      <Badge tone={levelTone[s.level]} className="mt-0.5 shrink-0">{levelLabel(s.level)}</Badge>
                      <span className="min-w-0 flex-1">
                        <span className={cn('block truncate text-sm', compact ? 'text-muted' : 'font-medium')}>{s.title}</span>
                        {!compact && <span className="tabular block text-xs text-muted">{rangeLabel(s, fmt.tz, t('summaries.all_day'))} · {t('summaries.n_lines', { n: s.utterance_count })}</span>}
                      </span>
                      {compact && <span className="tabular shrink-0 text-xs text-faint">{formatClock(s.range_end, fmt.tz)}</span>}
                    </button>
                  )
                })}
              </section>
            ))}
            {list.hasNextPage && (
              <div className="p-3 text-center"><Button size="sm" variant="ghost" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{t('common.view_all')}</Button></div>
            )}
          </div>
        )}
      </div>
    </div>
  )

  const detailPane = (
    <div className="min-w-0 flex-1 overflow-y-auto" aria-live="polite">
      {selectedId == null ? (
        <EmptyState icon={<FileText />} title={t('summaries.pick')} />
      ) : !sel && detail.isLoading ? (
        <div className="space-y-3 p-5"><Skeleton className="h-7 w-2/3" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-40" /></div>
      ) : !sel ? (
        <EmptyState icon={<FileText />} title={t('summaries.not_found')} action={<Button onClick={() => select(null, true)}>{t('summaries.back')}</Button>} />
      ) : (
        <article className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
          {mobile && <button type="button" onClick={() => select(null)} className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg"><ArrowLeft className="h-4 w-4" />{t('summaries.back')}</button>}
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={levelTone[sel.level]}>{levelLabel(sel.level)}</Badge>
            <h2 className="min-w-0 flex-1 text-xl font-semibold tracking-tight">{sel.title}</h2>
          </div>
          <p className="tabular mt-1.5 text-[13px] text-muted">
            {rangeLabel(sel, fmt.tz, t('summaries.all_day'), true)}
            {sel.room_id != null && rooms.data?.find((r) => r.id === sel.room_id) && ` · ${rooms.data.find((r) => r.id === sel.room_id)!.name}`}
            {` · ${t('summaries.n_lines', { n: sel.utterance_count })}`}
            {sel.model && ` · ${t('summaries.model', { m: sel.model })}`}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} disabled={!llm} onClick={() => setGenOpen({ start: sel.range_start, end: sel.range_end, level: sel.level, room_id: sel.room_id })}>{t('summaries.regenerate')}</Button>
            <Button size="sm" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copy(sel)}>{t('summaries.copy_md')}</Button>
            <Button size="sm" variant="danger-ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setDeleting(sel)}>{t('summaries.delete')}</Button>
          </div>
          <hr className="my-5 border-line" />
          <Markdown className="text-[15px]">{sel.content}</Markdown>
          <hr className="my-5 border-line" />
          <p className="text-xs text-muted">{t('summaries.footer_names')}</p>
          <Link
            to={`/timeline?from=${encodeURIComponent(sel.range_start)}&to=${encodeURIComponent(sel.range_end)}${sel.room_id ? `&room_id=${sel.room_id}` : ''}`}
            className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
          >
            {t('summaries.view_timeline')} <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </article>
      )}
    </div>
  )

  // Fill the shell: lists scroll independently on desktop.
  const wrap = useRef<HTMLDivElement>(null)
  return (
    <div ref={wrap} className="flex h-full min-h-0 flex-col lg:flex-row">
      {showList && <div className={cn('flex min-h-0 flex-col border-line max-lg:flex-1 lg:w-[360px] lg:shrink-0 lg:border-r', mobile && 'w-full')}>{listPane}</div>}
      {showDetail && detailPane}
      <GenerateSummaryDialog
        open={genOpen !== null}
        onClose={() => setGenOpen(null)}
        init={genOpen && genOpen !== true ? genOpen : undefined}
        existing={rows}
        onStarted={(id) => { setWatching((w) => [...w, id]); void jobs.refetch() }}
      />
      <ConfirmDialog
        open={!!deleting}
        danger
        title={t('summaries.delete_title')}
        body={deleting ? <><p className="font-medium">{deleting.title}</p><p className="mt-1">{t('summaries.delete_body')}</p></> : null}
        confirmLabel={t('summaries.delete')}
        onClose={() => setDeleting(null)}
        onConfirm={async () => { if (deleting) await del.mutateAsync(deleting.id); setDeleting(null) }}
      />
    </div>
  )
}

function rangeLabel(s: Summary, tz: string, allDay: string, withDate = false): string {
  const a = formatClock(s.range_start, tz), b = formatClock(s.range_end, tz)
  const durH = (Date.parse(s.range_end) - Date.parse(s.range_start)) / 3_600_000
  if (s.level === 'daily' && durH >= 20 && a === '00:00') return withDate ? `${allDay}` : allDay
  return `${a}–${b}`
}
