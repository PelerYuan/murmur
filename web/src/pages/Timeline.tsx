import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowDown, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Layers, MessageSquareText, Scissors, Search, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { addDaysKey, formatClock } from '../lib/time'
import { flattenPages } from '../lib/pagination'
import { dominantLang, flattenBlocks, groupConversations, type ConversationBlock } from '../lib/conversation'
import type { Page as PageT, Utterance } from '../lib/types'
import { useEvent } from '../lib/events'
import { useFmt, useRooms, useSpeakerLookup } from '../hooks/useData'
import { useTimelineFeed } from '../hooks/useTimelineFeed'
import { useMainVirtualizer } from '../hooks/useVirtual'
import { usePageKeys } from '../hooks/useShortcuts'
import { usePageTitle } from '../hooks/usePageTitle'
import { Button, IconButton } from '../components/ui/Button'
import { Banner, EmptyState, ErrorBar, Skeleton, Spinner } from '../components/ui/Misc'
import { Input, Select, Switch } from '../components/ui/Form'
import { Popover } from '../components/ui/Popover'
import { useToast } from '../components/ui/Toast'
import { SpeakerDot } from '../components/SpeakerChip'
import { DayPicker } from '../components/DayPicker'
import { ContextDrawer } from '../components/ContextDrawer'
import { SpeakerMiniCard } from '../components/speakers/SpeakerMiniCard'
import { useUtteranceOps } from '../components/speakers/UtteranceOps'
import { UtteranceRow } from '../components/timeline/UtteranceRow'
import { useT } from '../i18n'

const numParam = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : null)
const isKey = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v)

export default function Timeline() {
  const t = useT()
  const fmt = useFmt()
  const toast = useToast()
  const ops = useUtteranceOps()
  const rooms = useRooms()
  const { list: speakers, label } = useSpeakerLookup()
  const [params, setParams] = useSearchParams()
  usePageTitle(t('timeline.title'))

  const today = fmt.today()
  const dayParam = params.get('day')
  const day = isKey(dayParam) ? dayParam : today
  const fromP = params.get('from'), toP = params.get('to')
  const rangeMode = !!fromP && !!toP
  const roomId = numParam(params.get('room_id'))
  const speakerId = numParam(params.get('speaker_id'))
  const aroundId = numParam(params.get('around'))
  const [showIgnored, setShowIgnored] = useState(false)
  const [qRaw, setQRaw] = useState(params.get('q') ?? '')
  const [q, setQ] = useState(qRaw.trim().length >= 3 ? qRaw.trim() : '')
  const searching = q.length >= 3
  useEffect(() => { const h = setTimeout(() => setQ(qRaw.trim().length >= 3 ? qRaw.trim() : ''), 300); return () => clearTimeout(h) }, [qRaw])

  const patchParams = useCallback((patch: Record<string, string | null>, replace = false) => {
    setParams((cur) => {
      const p = new URLSearchParams(cur)
      for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') p.delete(k); else p.set(k, v) }
      return p
    }, { replace })
  }, [setParams])

  // `around=<utterance id>` (to-do source, search context, summary jump): resolve its day first.
  const aroundQ = useQuery({
    queryKey: ['utterance', aroundId],
    queryFn: () => api.get<Utterance>(`/utterances/${aroundId}`),
    enabled: aroundId != null,
    retry: false,
    staleTime: 60_000,
  })
  useEffect(() => {
    if (aroundId == null) return
    if (aroundQ.data) {
      const k = fmt.dateKey(aroundQ.data.started_at)
      if (k !== dayParam || rangeMode) patchParams({ day: k, from: null, to: null }, true)
      if (searching) { setQRaw(''); setQ('') }
    } else if (aroundQ.isError) {
      toast.error(new Error(t('timeline.around_missing')))
      patchParams({ around: null }, true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aroundQ.data, aroundQ.isError, aroundId])

  const range = useMemo(() => (rangeMode ? { from: fromP!, to: toP! } : fmt.range(day)), [rangeMode, fromP, toP, fmt, day])
  const isToday = !rangeMode && day === today

  const feed = useTimelineFeed({
    from: range.from, to: range.to, roomId, speakerId, includeIgnored: showIgnored,
    aroundId: aroundId != null && aroundQ.data ? aroundId : null,
    enabled: !searching && (aroundId == null || !!aroundQ.data),
  }, (id) => (id == null ? null : label(id)))

  // ---- search mode ----
  const search = useInfiniteQuery({
    queryKey: ['utterances', 'search', q, roomId, speakerId, showIgnored, rangeMode ? range.from : '', rangeMode ? range.to : ''],
    queryFn: ({ pageParam }) => api.get<PageT<Utterance>>('/utterances', {
      q, room_id: roomId ?? undefined, speaker_id: speakerId ?? undefined, exclude_ignored: !showIgnored, limit: 50, cursor: pageParam,
      from: rangeMode ? range.from : undefined, to: rangeMode ? range.to : undefined,
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_cursor ?? undefined,
    enabled: searching,
  })
  const searchRows = useMemo(() => flattenPages(search.data?.pages), [search.data])

  // ---- rows to show ----
  const blocks = useMemo(() => (searching ? [] : groupConversations(feed.rows)), [feed.rows, searching])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const flat = useMemo(() => (searching ? [] : flattenBlocks(blocks, collapsed)), [blocks, collapsed, searching])
  const multiRoom = (rooms.data?.length ?? 0) > 1
  const mainLang = useMemo(() => dominantLang(feed.rows), [feed.rows])
  const itemCount = searching ? searchRows.length : flat.length

  // ---- selection ----
  const [selectMode, setSelectMode] = useState(false)
  const [sel, setSel] = useState<Set<number>>(new Set())
  const lastClicked = useRef<number | null>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [flashId, setFlashId] = useState<number | null>(null)
  const exitSelect = useCallback(() => { setSelectMode(false); setSel(new Set()); lastClicked.current = null }, [])
  const orderedRows: Utterance[] = searching ? searchRows : feed.rows
  const toggleSel = (u: Utterance, shift: boolean) => {
    setSelectMode(true)
    setSel((cur) => {
      const next = new Set(cur)
      if (shift && lastClicked.current != null) {
        const a = orderedRows.findIndex((r) => r.id === lastClicked.current)
        const b = orderedRows.findIndex((r) => r.id === u.id)
        const [lo, hi] = a < b ? [a, b] : [b, a]
        for (let i = lo; i <= hi; i++) next.add(orderedRows[i].id)
      } else if (next.has(u.id)) next.delete(u.id)
      else next.add(u.id)
      return next
    })
    lastClicked.current = u.id
  }
  useEffect(() => { exitSelect() }, [day, searching, roomId, speakerId, exitSelect])
  const chosen = orderedRows.filter((r) => sel.has(r.id))
  const sameSpeaker = chosen.length > 0 && chosen.every((r) => r.speaker_id != null && r.speaker_id === chosen[0].speaker_id)

  // ---- popovers / drawers ----
  const [mini, setMini] = useState<{ id: number | null; anchor: HTMLElement } | null>(null)
  const [ctxId, setCtxId] = useState<number | null>(null)
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)
  const [barH, setBarH] = useState(56)
  useLayoutEffect(() => {
    const el = barRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBarH(el.offsetHeight))
    ro.observe(el)
    setBarH(el.offsetHeight)
    return () => ro.disconnect()
  }, [])

  // ---- virtualisation ----
  const container = useRef<HTMLDivElement>(null)
  const { virt, margin, scroller } = useMainVirtualizer({
    count: itemCount,
    estimate: (i) => (!searching && flat[i]?.kind === 'header' ? 40 : 56),
    container,
    getKey: (i) => (searching ? `s${searchRows[i]?.id ?? i}` : flat[i]?.key ?? i),
  })
  const vItems = virt.getVirtualItems()

  // Follow-latest + new pill
  const [following, setFollowing] = useState(true)
  const followRef = useRef(true)
  const [pending, setPending] = useState(0)
  useEffect(() => {
    if (!scroller) return
    const onScroll = () => {
      const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140
      followRef.current = near
      setFollowing(near)
      if (near) setPending(0)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [scroller])

  const scrollToEnd = useCallback((smooth = false) => {
    if (!scroller) return
    const go = () => scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    requestAnimationFrame(() => { go(); requestAnimationFrame(go) })
  }, [scroller])

  // After a (re)load: jump to the bottom (newest) or to the requested utterance.
  const loadedKey = useRef('')
  useEffect(() => {
    if (searching || feed.loading || feed.rows.length === 0) return
    const k = `${range.from}|${range.to}|${roomId}|${speakerId}|${showIgnored}|${aroundId}`
    if (loadedKey.current === k) return
    loadedKey.current = k
    setPending(0)
    if (aroundId != null) {
      const idx = flat.findIndex((it) => it.kind === 'row' && it.utterance.id === aroundId)
      if (idx >= 0) {
        virt.scrollToIndex(idx, { align: 'center' })
        setFlashId(aroundId)
        const h = setTimeout(() => { setFlashId(null) }, 2200)
        patchParams({ around: null }, true)
        return () => clearTimeout(h)
      }
    }
    followRef.current = true
    scrollToEnd()
  }, [feed.loading, feed.rows.length, searching]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (feed.loading) loadedKey.current = '' }, [feed.loading])

  // Live tail
  useEvent('utterances.new', async () => {
    if (!isToday || searching || feed.loading) return
    const added = await feed.refreshTail()
    if (added > 0) { if (followRef.current) scrollToEnd(); else setPending((n) => n + added) }
  })
  useEvent('open', () => { if (isToday && !searching && !feed.loading && feed.rows.length) void feed.refreshTail() })

  // Keep the viewport still when older rows are prepended.
  const anchor = useRef<{ key: string | number; offset: number } | null>(null)
  const loadOlder = useCallback(() => {
    if (!scroller || feed.loadingOlder || !feed.hasOlder) return
    const first = virt.getVirtualItems().find((v) => v.start - scroller.scrollTop >= -1) ?? virt.getVirtualItems()[0]
    if (first) anchor.current = { key: first.key as string | number, offset: first.start - scroller.scrollTop }
    void feed.loadOlder()
  }, [scroller, feed, virt])
  useLayoutEffect(() => {
    const a = anchor.current
    if (!a || !scroller || feed.prepended === 0) return
    const idx = flat.findIndex((it) => it.key === a.key)
    if (idx >= 0) {
      virt.getTotalSize()
      const m = virt.measurementsCache[idx]
      if (m) scroller.scrollTop = m.start - a.offset
    }
    anchor.current = null
  }, [feed.prepended, feed.rows.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load older when the top comes into view; load more search results near the end.
  const firstIdx = vItems.length ? vItems[0].index : 0
  const lastIdx = vItems.length ? vItems[vItems.length - 1].index : -1
  useEffect(() => {
    if (searching) {
      if (lastIdx >= searchRows.length - 8 && search.hasNextPage && !search.isFetchingNextPage && !search.isError) void search.fetchNextPage()
    } else if (firstIdx <= 3 && feed.hasOlder && !feed.loadingOlder && !feed.loading && !feed.error && loadedKey.current) loadOlder()
  }, [firstIdx, lastIdx, searching, feed.hasOlder, feed.loadingOlder, feed.loading, search.hasNextPage, search.isFetchingNextPage, searchRows.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Which block header is "current" (rendered sticky while its rows scroll by).
  const stickyBlock: ConversationBlock | null = useMemo(() => {
    if (searching || flat.length === 0) return null
    const first = vItems[0]
    if (!first) return null
    const it = flat[first.index]
    if (!it) return null
    // Header scrolled out of view above, its rows still visible.
    if (it.kind === 'row') return it.block
    const nextRow = flat[first.index + 1]
    return nextRow?.kind === 'row' && first.start < (scroller?.scrollTop ?? 0) ? it.block : null
  }, [vItems, flat, searching, scroller])

  // ---- keyboard ----
  const stepDay = (n: number) => { if (!rangeMode) { const k = addDaysKey(day, n); if (k <= today) patchParams({ day: k === today ? null : k, around: null }) } }
  usePageKeys((e) => {
    if (e.key === '[') stepDay(-1)
    else if (e.key === ']') stepDay(1)
    else if (e.key === '/') { e.preventDefault(); document.getElementById('timeline-search')?.focus() }
    else if (e.key === 'x') { e.preventDefault(); setSelectMode((v) => !v) }
    else if (e.key === 'Escape' && selectMode) exitSelect()
  }, [day, rangeMode, today, selectMode])

  const filterCount = (roomId ? 1 : 0) + (speakerId ? 1 : 0) + (showIgnored ? 1 : 0)
  const clearFilters = () => { patchParams({ room_id: null, speaker_id: null }); setShowIgnored(false) }

  const dayLabel = rangeMode
    ? t('timeline.range', { from: fmt.dateTime(range.from), to: fmt.dateTime(range.to) })
    : fmt.day(day, day.slice(0, 4) !== today.slice(0, 4))

  const filterControls = (
    <>
      <Select className="min-w-0 sm:w-36" value={roomId ?? ''} onChange={(e) => patchParams({ room_id: e.target.value || null })} aria-label={t('timeline.room')}>
        <option value="">{t('timeline.all_rooms')}</option>
        {(rooms.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </Select>
      <Select className="min-w-0 sm:w-40" value={speakerId ?? ''} onChange={(e) => patchParams({ speaker_id: e.target.value || null })} aria-label={t('timeline.speaker')}>
        <option value="">{t('timeline.all_speakers')}</option>
        {speakers.filter((s) => s.state !== 'ignored' || showIgnored).map((s) => <option key={s.id} value={s.id}>{label(s.id)}</option>)}
      </Select>
      <label className="flex items-center gap-2 whitespace-nowrap text-[13px] text-muted">
        <Switch checked={showIgnored} onChange={setShowIgnored} label={t('timeline.show_ignored')} />
        {t('timeline.show_ignored')}
      </label>
    </>
  )

  const renderRow = (u: Utterance, showDate: boolean) => (
    <UtteranceRow
      u={u}
      q={searching ? q : undefined}
      showDate={showDate}
      dominantLang={mainLang}
      selectMode={selectMode}
      selected={sel.has(u.id)}
      active={activeId === u.id}
      flash={flashId === u.id}
      onSelectToggle={(shift) => toggleSel(u, shift)}
      onActivate={() => setActiveId(u.id)}
      onChipClick={(anchorEl) => setMini({ id: u.speaker_id, anchor: anchorEl })}
      onContext={searching ? () => { setQRaw(''); setQ(''); patchParams({ around: String(u.id) }) } : undefined}
    />
  )

  const empty = searching
    ? !search.isLoading && !search.isError && searchRows.length === 0
    : !feed.loading && !feed.error && feed.rows.length === 0
  const initialLoading = searching ? search.isLoading : feed.loading && feed.rows.length === 0
  const loadError = (searching ? (search.isError ? search.error : null) : feed.error) as Error | null

  return (
    <div className="mx-auto w-full max-w-5xl px-0 sm:px-6" style={{ '--tl-bar': `${barH}px` } as React.CSSProperties}>
      {/* Filter bar */}
      <div ref={barRef} className="sticky top-0 z-20 border-b border-line bg-bg/95 px-3 py-2.5 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-2 gap-y-2">
          <div className="flex items-center gap-1">
            <IconButton size="sm" aria-label={t('timeline.prev_day')} onClick={() => stepDay(-1)} disabled={rangeMode}><ChevronLeft className="h-4 w-4" /></IconButton>
            <button
              ref={setPickerAnchor}
              type="button"
              onClick={() => setPickerOpen((o) => !o)}
              aria-haspopup="dialog"
              aria-expanded={pickerOpen}
              aria-label={`${t('timeline.pick_day')}: ${dayLabel}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold hover:bg-hover max-sm:h-10"
            >
              <CalendarDays className="h-4 w-4 text-muted" aria-hidden />
              <span className="tabular">{dayLabel}</span>
            </button>
            <IconButton size="sm" aria-label={t('timeline.next_day')} onClick={() => stepDay(1)} disabled={rangeMode || day >= today}><ChevronRight className="h-4 w-4" /></IconButton>
            {rangeMode
              ? <Button size="sm" variant="soft" onClick={() => patchParams({ from: null, to: null })}>{t('timeline.range_clear')}</Button>
              : <Button size="sm" variant="ghost" disabled={day === today} onClick={() => patchParams({ day: null })}>{t('timeline.today')}</Button>}
          </div>
          <Popover open={pickerOpen} onClose={() => setPickerOpen(false)} anchor={pickerAnchor} className="border border-line">
            <DayPicker value={day} max={today} onPick={(k) => { setPickerOpen(false); patchParams({ day: k === today ? null : k, from: null, to: null, around: null }) }} />
          </Popover>
          <div className="order-last flex w-full items-center gap-2 sm:order-none sm:ml-auto sm:w-auto">
            <Input
              id="timeline-search"
              className="min-w-0 flex-1 sm:w-64 sm:flex-none"
              leading={<Search className="h-4 w-4" />}
              value={qRaw}
              onChange={(e) => setQRaw(e.target.value)}
              placeholder={t('timeline.search')}
              aria-label={t('timeline.search')}
              suffix={qRaw ? undefined : undefined}
            />
            {qRaw && <IconButton size="sm" aria-label={t('common.clear')} onClick={() => { setQRaw(''); setQ('') }}><X className="h-4 w-4" /></IconButton>}
            <IconButton size="sm" variant={filterCount ? 'soft' : 'secondary'} aria-label={t('timeline.filters')} aria-expanded={filtersOpen} className="sm:hidden" onClick={() => setFiltersOpen((o) => !o)}>
              <SlidersHorizontal className="h-4 w-4" />
            </IconButton>
          </div>
          <div className={cn('w-full flex-wrap items-center gap-2 sm:order-none sm:flex sm:w-auto', filtersOpen ? 'flex' : 'hidden')}>{filterControls}</div>
        </div>
        {qRaw.trim().length > 0 && qRaw.trim().length < 3 && <p className="mx-auto mt-1.5 max-w-5xl text-xs text-muted">{t('timeline.search_hint', { n: 3 - qRaw.trim().length })}</p>}
        {searching && !search.isLoading && <p className="mx-auto mt-1.5 max-w-5xl text-xs text-muted">{t('timeline.search_results', { n: `${searchRows.length}${search.hasNextPage ? '+' : ''}` })}</p>}
      </div>

      <div className="px-0 py-3">
        {loadError && (
          <div className="px-3 pb-3 sm:px-0">
            <ErrorBar message={`${t('timeline.load_failed')} · ${loadError.message}`} onRetry={() => (searching ? void search.refetch() : void feed.reload())} retryLabel={t('common.retry')} />
          </div>
        )}
        {initialLoading ? (
          <div className="space-y-2 px-3 sm:px-0">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : empty ? (
          <EmptyState
            icon={<MessageSquareText />}
            title={searching ? t('timeline.empty_search', { q }) : filterCount || roomId || speakerId ? t('timeline.empty_filter') : isToday ? t('timeline.empty_today') : t('timeline.empty_day')}
            action={!searching && (filterCount > 0) ? <Button onClick={clearFilters}>{t('timeline.clear_filters')}</Button> : undefined}
          />
        ) : (
          <>
            {!searching && !feed.hasOlder && !feed.loading && feed.rows.length > 0 && !feed.trimmed && (
              <p className="pb-2 text-center text-xs text-faint">{t('timeline.day_start')}</p>
            )}
            {!searching && feed.loadingOlder && <div className="flex justify-center pb-2"><Spinner /></div>}
            {!searching && feed.hasOlder && !feed.loadingOlder && (
              <div className="flex justify-center pb-2"><Button size="sm" variant="ghost" onClick={loadOlder}>{t('timeline.load_older')}</Button></div>
            )}
            {/* Sticky header of the conversation currently in view */}
            {stickyBlock && (
              <div className="pointer-events-none sticky top-[var(--tl-bar,0px)] z-10 h-0">
                <div className="pointer-events-auto">
                  <BlockHeader block={stickyBlock} collapsed={false} multiRoom={multiRoom} onToggle={() => setCollapsed((c) => new Set(c).add(stickyBlock.id))} floating />
                </div>
              </div>
            )}
            <div ref={container} className="relative" style={{ height: virt.getTotalSize() }} role="list" aria-label={t('timeline.title')}>
              {vItems.map((vi) => {
                const style = { transform: `translateY(${vi.start - margin}px)` }
                if (searching) {
                  const u = searchRows[vi.index]
                  return u && <div key={vi.key} ref={virt.measureElement} data-index={vi.index} role="listitem" className="absolute left-0 top-0 w-full" style={style}>{renderRow(u, true)}</div>
                }
                const it = flat[vi.index]
                if (!it) return null
                return (
                  <div key={vi.key} ref={virt.measureElement} data-index={vi.index} role="listitem" className="absolute left-0 top-0 w-full" style={style}>
                    {it.kind === 'header'
                      ? <BlockHeader block={it.block} collapsed={it.collapsed} multiRoom={multiRoom} onToggle={() => setCollapsed((c) => { const n = new Set(c); if (n.has(it.block.id)) n.delete(it.block.id); else n.add(it.block.id); return n })} />
                      : renderRow(it.utterance, false)}
                  </div>
                )
              })}
            </div>
            {searching && (
              <div className="py-4 text-center text-xs text-faint">
                {search.isFetchingNextPage ? <Spinner className="mx-auto" /> : search.hasNextPage ? <Button size="sm" variant="ghost" onClick={() => void search.fetchNextPage()}>{t('common.view_all')}</Button> : searchRows.length > 0 ? t('timeline.search_end') : null}
              </div>
            )}
          </>
        )}
        {feed.trimmed && !searching && <Banner tone="info" className="mx-3 mt-3 sm:mx-0">{t('timeline.load_older')}</Banner>}
      </div>

      {/* "↓ N new" pill / jump to latest */}
      {!searching && isToday && !selectMode && (pending > 0 || !following) && feed.rows.length > 0 && (
        <div className="pointer-events-none sticky bottom-4 z-20 flex justify-center">
          <button
            type="button"
            onClick={() => { setPending(0); followRef.current = true; scrollToEnd(true) }}
            className="pointer-events-auto inline-flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-medium text-accent-fg shadow-pop"
          >
            <ArrowDown className="h-4 w-4" aria-hidden />
            {pending > 0 ? t('timeline.new_n', { n: pending }) : t('timeline.jump_latest')}
          </button>
        </div>
      )}

      {selectMode && (
        <div className="sticky bottom-0 z-20 border-t border-line bg-surface/95 px-4 py-2.5 shadow-pop backdrop-blur" role="region" aria-label={t('timeline.select_mode')}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto text-sm text-muted" aria-live="polite">{t('timeline.selected_n', { n: sel.size })}</span>
            <Button size="sm" icon={<Layers className="h-4 w-4" />} disabled={sel.size === 0} onClick={() => ops.reassign(chosen, exitSelect)}>{t('timeline.reassign')}</Button>
            <Button size="sm" icon={<Scissors className="h-4 w-4" />} disabled={!sameSpeaker} title={sameSpeaker ? undefined : t('timeline.split_disabled')} onClick={() => ops.split(chosen, exitSelect)}>{t('timeline.split_new')}</Button>
            <Button size="sm" variant="danger-ghost" icon={<Trash2 className="h-4 w-4" />} disabled={sel.size === 0} onClick={() => ops.remove(chosen, exitSelect)}>{t('common.delete')}</Button>
            <Button size="sm" variant="ghost" onClick={exitSelect}>{t('timeline.cancel')}</Button>
          </div>
        </div>
      )}

      <SpeakerMiniCard speakerId={mini?.id ?? null} anchor={mini?.anchor ?? null} onClose={() => setMini(null)} />
      <ContextDrawer utteranceId={ctxId} onClose={() => setCtxId(null)} hideTimelineLink />
    </div>
  )
}

function BlockHeader({ block, collapsed, onToggle, multiRoom, floating }: { block: ConversationBlock; collapsed: boolean; onToggle: () => void; multiRoom: boolean; floating?: boolean }) {
  const t = useT()
  const fmt = useFmt()
  const { map, label } = useSpeakerLookup()
  const rooms = useRooms()
  const room = multiRoom ? rooms.data?.find((r) => r.id === block.roomId)?.name : null
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={collapsed ? t('timeline.block_expand') : t('timeline.block_collapse')}
      className={cn(
        'flex w-full items-center gap-2 border-b border-line bg-subtle px-3 py-2 text-left text-[12.5px] text-muted hover:bg-hover sm:px-4',
        floating && 'shadow-sm',
      )}
    >
      <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', collapsed && '-rotate-90')} aria-hidden />
      <span className="tabular shrink-0 font-medium text-fg">{formatClock(block.start, fmt.tz)}–{formatClock(block.end, fmt.tz)}</span>
      {room && <span className="shrink-0">· {room}</span>}
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
        {block.speakerIds.slice(0, 4).map((id) => (
          <span key={id ?? 'u'} className="inline-flex shrink-0 items-center gap-1">
            {id != null && <SpeakerDot color={map.get(id)?.color} className="h-2 w-2" dashed={map.get(id)?.state === 'unnamed'} />}
            <span className="max-w-[6rem] truncate">{label(id)}</span>
          </span>
        ))}
        {block.speakerIds.length > 4 && <span>+{block.speakerIds.length - 4}</span>}
      </span>
      <span className="tabular shrink-0">{t('timeline.block_count', { n: block.items.length })}</span>
    </button>
  )
}
