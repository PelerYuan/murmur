import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Ban, ChevronLeft, Copy, GitMerge, Layers, MessageSquareQuote, MoreHorizontal, Pencil, RotateCcw, Scissors, Search, Trash2, UserRoundX, X, ListChecks } from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { qk } from '../lib/queryClient'
import { flattenPages } from '../lib/pagination'
import type { Page, Speaker, Utterance } from '../lib/types'
import { useFmt, useSpeakerLookup } from '../hooks/useData'
import { useMainVirtualizer } from '../hooks/useVirtual'
import { usePageTitle } from '../hooks/usePageTitle'
import { Page as PageShell } from '../components/Page'
import { Button } from '../components/ui/Button'
import { Badge, EmptyState, ErrorBar, Skeleton, Spinner } from '../components/ui/Misc'
import { Checkbox, Input } from '../components/ui/Form'
import { Menu } from '../components/ui/Popover'
import { useToast } from '../components/ui/Toast'
import { SpeakerDot } from '../components/SpeakerChip'
import { SampleList } from '../components/AudioPlayer'
import { Highlight } from '../components/Highlight'
import { ContextDrawer } from '../components/ContextDrawer'
import { SpeakerNameInput } from '../components/speakers/SpeakerNameInput'
import { useSpeakerActions } from '../components/speakers/SpeakerActions'
import { useUtteranceOps } from '../components/speakers/UtteranceOps'
import { useT } from '../i18n'

const MAX_SPLIT = 500
const PAGE = 50

export default function SpeakerDetail() {
  const t = useT()
  const fmt = useFmt()
  const { id: idParam } = useParams()
  const id = Number(idParam)
  const navigate = useNavigate()
  const actions = useSpeakerActions()
  const ops = useUtteranceOps()
  const toast = useToast()
  const { label, map } = useSpeakerLookup()

  const sq = useQuery({
    queryKey: qk.speaker(id),
    queryFn: () => api.get<Speaker>(`/speakers/${id}`),
    enabled: Number.isFinite(id),
    retry: false,
  })
  const sp = sq.data ?? map.get(id)
  const name = sp ? label(sp.id) : ''
  usePageTitle(sp ? t('speakers.page_title_detail', { name }) : t('speakers.title'))

  const [qRaw, setQRaw] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => { const h = setTimeout(() => setQ(qRaw.trim().length >= 3 ? qRaw.trim() : ''), 300); return () => clearTimeout(h) }, [qRaw])

  const list = useInfiniteQuery({
    queryKey: ['utterances', 'speaker', id, q],
    queryFn: ({ pageParam }) => api.get<Page<Utterance>>('/utterances', { speaker_id: id, q: q || undefined, limit: PAGE, cursor: pageParam, exclude_ignored: false }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_cursor ?? undefined,
    enabled: Number.isFinite(id) && !!sp,
  })
  const rows = useMemo(() => flattenPages(list.data?.pages), [list.data])

  // ---- split / multi-select mode ----
  const [splitting, setSplitting] = useState(false)
  const [sel, setSel] = useState<Set<number>>(new Set())
  const lastClicked = useRef<number | null>(null)
  const exitSplit = useCallback(() => { setSplitting(false); setSel(new Set()); lastClicked.current = null }, [])
  useEffect(() => { exitSplit() }, [id, exitSplit])
  useEffect(() => {
    if (!splitting) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[role=dialog][aria-modal=true]')) exitSplit() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [splitting, exitSplit])

  const toggleRow = (u: Utterance, idx: number, shift: boolean) => {
    setSel((cur) => {
      const next = new Set(cur)
      if (shift && lastClicked.current != null) {
        const a = rows.findIndex((r) => r.id === lastClicked.current)
        const [lo, hi] = a < idx ? [a, idx] : [idx, a]
        for (let i = lo; i <= hi && next.size < MAX_SPLIT; i++) next.add(rows[i].id)
      } else if (next.has(u.id)) next.delete(u.id)
      else if (next.size >= MAX_SPLIT) { toast.error(new Error(t('speakers.split_limit', { n: MAX_SPLIT }))); return cur }
      else next.add(u.id)
      return next
    })
    lastClicked.current = u.id
  }
  const selectAllLoaded = () => setSel(new Set(rows.slice(0, MAX_SPLIT).map((r) => r.id)))
  const chosen = rows.filter((r) => sel.has(r.id))

  const [ctx, setCtx] = useState<number | null>(null)

  // ---- virtual list ----
  const container = useRef<HTMLDivElement>(null)
  const { virt, margin } = useMainVirtualizer({ count: rows.length, estimate: 68, container, getKey: (i) => rows[i]?.id ?? i })
  const items = virt.getVirtualItems()
  const lastIdx = items.length ? items[items.length - 1].index : -1
  useEffect(() => {
    if (lastIdx >= rows.length - 6 && list.hasNextPage && !list.isFetchingNextPage && !list.isError) void list.fetchNextPage()
  }, [lastIdx, rows.length, list])

  if (!Number.isFinite(id) || (sq.isError && !sp)) {
    return (
      <PageShell>
        <BackLink />
        <EmptyState icon={<UserRoundX />} title={t('speakers.detail_not_found')} action={<Button onClick={() => navigate('/speakers')}>{t('speakers.title')}</Button>} />
      </PageShell>
    )
  }
  if (!sp) {
    return <PageShell><BackLink /><Skeleton className="h-32" /></PageShell>
  }

  const ignored = sp.state === 'ignored'
  const copyRow = (u: Utterance) => {
    const text = `[${fmt.clock(u.started_at)} ${label(u.speaker_id, u.speaker_name)}] ${u.text}`
    navigator.clipboard?.writeText(text).then(() => toast.success(t('common.copied')), () => toast.error(new Error(t('common.copy_failed'))))
  }

  return (
    <PageShell>
      <BackLink />
      <header className="card p-4 sm:p-5">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
            <SpeakerDot color={sp.color} dashed={sp.state === 'unnamed'} className="mt-[11px] h-3.5 w-3.5" />
            <div className="min-w-0 flex-1">
              <RenameTitle sp={sp} name={name} />
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
                <Badge tone={sp.state === 'named' ? 'ok' : sp.state === 'ignored' ? 'neutral' : 'warn'}>
                  {sp.state === 'named' ? t('speakers.state_named') : sp.state === 'ignored' ? t('speakers.state_ignored') : t('speakers.state_unnamed')}
                </Badge>
                <span className="tabular">{t('common.sentences', { n: sp.utterance_count })} · {fmt.duration(sp.total_seconds)}</span>
                {sp.first_seen && <span>{t('speakers.detail_first_seen', { t: fmt.dateTime(sp.first_seen) })}</span>}
                {sp.last_seen && <span>{t('speakers.stats_seen', { t: fmt.relative(sp.last_seen) })}</span>}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon={<GitMerge className="h-4 w-4" />} onClick={() => actions.merge(sp)}>{t('speakers.merge_to')}</Button>
            {ignored
              ? <Button size="sm" icon={<RotateCcw className="h-4 w-4" />} onClick={() => actions.restore(sp)}>{t('speakers.restore')}</Button>
              : <Button size="sm" icon={<Ban className="h-4 w-4" />} onClick={() => actions.ignore(sp)}>{t('speakers.mark_ignored')}</Button>}
            <Button size="sm" variant="danger-ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => actions.remove(sp, () => navigate('/speakers', { replace: true }))}>{t('common.delete')}</Button>
          </div>
        </div>
        {sp.state === 'unnamed' && <SpeakerNameInput speaker={sp} className="mt-4 max-w-md" />}
        {!ignored && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-muted">{t('speakers.detail_samples')}</p>
            <SampleList speakerId={sp.id} samples={sp.samples} />
            {sp.samples.length === 0 && <p className="mt-1 text-xs text-faint">{t('speakers.no_samples_new')}</p>}
          </div>
        )}
        {ignored && <p className="mt-3 text-[13px] text-muted">{t('speakers.kept_utterances', { n: sp.utterance_count })}</p>}
      </header>

      <div className="mb-3 mt-6 flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-[13px] font-semibold uppercase tracking-wide text-muted">{t('speakers.detail_utterances')}</h3>
        <Input className="w-full sm:w-64" leading={<Search className="h-4 w-4" />} value={qRaw} onChange={(e) => setQRaw(e.target.value)} placeholder={t('speakers.search_utterances')} aria-label={t('speakers.search_utterances')} />
        {splitting
          ? <Button onClick={exitSplit} icon={<X className="h-4 w-4" />}>{t('speakers.split_cancel')}</Button>
          : <Button onClick={() => setSplitting(true)} disabled={rows.length === 0} icon={<Scissors className="h-4 w-4" />}>{t('speakers.split')}</Button>}
      </div>
      {splitting && (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-info-soft px-3 py-2 text-[13px]">
          <span className="flex-1">{t('speakers.split_hint')}</span>
          <button className="font-medium text-accent hover:underline" onClick={selectAllLoaded}>{t('speakers.split_select_all')}</button>
        </div>
      )}
      {splitting && <p className="mb-3 text-xs text-muted">{t('speakers.split_note')}</p>}

      {list.isLoading ? (
        <div className="space-y-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : list.isError && rows.length === 0 ? (
        <ErrorBar message={(list.error as Error).message} onRetry={() => void list.refetch()} retryLabel={t('common.retry')} />
      ) : rows.length === 0 ? (
        <EmptyState compact icon={<MessageSquareQuote />} title={q ? t('speakers.no_match') : t('speakers.no_utterances')} />
      ) : (
        <>
          {list.isError && <ErrorBar message={(list.error as Error).message} onRetry={() => void list.fetchNextPage()} retryLabel={t('common.retry')} />}
          <div ref={container} className="card relative overflow-hidden" style={{ height: virt.getTotalSize() }} role="list" aria-label={t('speakers.detail_utterances')}>
            {items.map((vi) => {
              const u = rows[vi.index]
              if (!u) return null
              const checked = sel.has(u.id)
              return (
                <div
                  key={vi.key}
                  ref={virt.measureElement}
                  data-index={vi.index}
                  role="listitem"
                  className={cn('absolute left-0 top-0 w-full border-b border-line px-3 py-2.5 sm:px-4', checked && 'bg-accent-soft/60')}
                  style={{ transform: `translateY(${vi.start - margin}px)` }}
                  onClick={splitting ? (e) => toggleRow(u, vi.index, e.shiftKey) : undefined}
                >
                  <div className="flex items-start gap-3">
                    {splitting && <Checkbox className="mt-0.5" checked={checked} onChange={(_v, e) => toggleRow(u, vi.index, !!(e as unknown as MouseEvent)?.shiftKey)} hideLabel={u.text} />}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <span className="tabular">{fmt.dateTime(u.started_at)}</span>
                        {u.lang && u.lang !== 'zh' && <span className="rounded bg-subtle px-1 text-[10.5px] uppercase">{u.lang}</span>}
                        {u.text_edited && <Pencil className="h-3 w-3" aria-label={t('utt.edited')} />}
                      </div>
                      <p className={cn('mt-0.5 break-words text-sm leading-6', (u.confidence ?? 1) < 0.5 && 'text-muted')}><Highlight text={u.text} q={q} /></p>
                    </div>
                    {!splitting && (
                      <Menu
                        label={t('utt.menu')}
                        items={[
                          { label: t('utt.change_speaker'), icon: <Layers />, onSelect: () => ops.reassign([u]) },
                          { label: t('utt.edit_text'), icon: <Pencil />, onSelect: () => ops.editText(u) },
                          { label: t('common.copy'), icon: <Copy />, onSelect: () => copyRow(u) },
                          { label: t('utt.create_todo'), icon: <ListChecks />, onSelect: () => ops.createTodo(u) },
                          { label: t('utt.view_context'), icon: <MessageSquareQuote />, onSelect: () => setCtx(u.id) },
                          { label: t('common.delete'), icon: <Trash2 />, danger: true, divider: true, onSelect: () => ops.remove([u]) },
                        ]}
                        trigger={<button type="button" aria-label={t('utt.menu')} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg max-sm:h-10 max-sm:w-10"><MoreHorizontal className="h-4 w-4" /></button>}
                      />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="py-4 text-center text-xs text-faint">
            {list.isFetchingNextPage ? <Spinner className="mx-auto" /> : list.hasNextPage ? (
              <Button size="sm" variant="ghost" onClick={() => void list.fetchNextPage()}>{t('common.view_all')}</Button>
            ) : t('speakers.end_of_list')}
          </div>
        </>
      )}

      {splitting && (
        <div className="sticky bottom-0 z-20 -mx-4 mt-2 border-t border-line bg-surface/95 px-4 py-2.5 shadow-pop backdrop-blur sm:-mx-6 sm:px-6" role="region" aria-label={t('speakers.split')}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto text-sm text-muted" aria-live="polite">{t('speakers.split_selected', { n: sel.size })}</span>
            <Button onClick={() => ops.reassign(chosen, exitSplit)} disabled={sel.size === 0}>{t('speakers.split_reassign')}</Button>
            <Button variant="primary" disabled={sel.size === 0} icon={<Scissors className="h-4 w-4" />} onClick={() => ops.split(chosen, exitSplit)}>{t('speakers.split_new')}</Button>
          </div>
        </div>
      )}
      <ContextDrawer utteranceId={ctx} onClose={() => setCtx(null)} />
    </PageShell>
  )
}

function BackLink() {
  const t = useT()
  return (
    <Link to="/speakers" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
      <ChevronLeft className="h-4 w-4" /> {t('speakers.detail_back')}
    </Link>
  )
}

function RenameTitle({ sp, name }: { sp: Speaker; name: string }) {
  const t = useT()
  const actions = useSpeakerActions()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (editing) inputRef.current?.select() }, [editing])
  const commit = async () => {
    const v = value.trim()
    if (v === (sp.name ?? '')) { setEditing(false); return }
    const ok = await actions.name(sp, v)
    if (ok || !v) setEditing(false)
  }
  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        value={value}
        maxLength={60}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void commit() }
          if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) }
        }}
        aria-label={t('speakers.detail_rename')}
        className="h-10 w-full max-w-sm rounded-lg border border-accent bg-surface px-2.5 text-xl font-semibold focus:outline-none focus:ring-2 focus:ring-accent/25"
      />
    )
  }
  return (
    <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
      <button
        type="button"
        onClick={() => { setValue(sp.name ?? ''); setEditing(true) }}
        className={cn('group -mx-1.5 inline-flex min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-left hover:bg-hover', sp.state === 'unnamed' && 'italic')}
        title={t('speakers.detail_rename')}
      >
        <span className="truncate">{name}</span>
        <Pencil className="h-3.5 w-3.5 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 max-sm:opacity-100" aria-hidden />
      </button>
    </h2>
  )
}
