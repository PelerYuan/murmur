import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { Ban, ChevronDown, ChevronRight, GitMerge, MoreHorizontal, RotateCcw, Search, Trash2, UserRound, Users, X } from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import type { Speaker } from '../lib/types'
import { useFmt, useSettings, useSpeakerLookup, useSpeakers } from '../hooks/useData'
import { usePageKeys } from '../hooks/useShortcuts'
import { Page } from '../components/Page'
import { Button } from '../components/ui/Button'
import { Badge, Banner, EmptyState, ErrorBar, Skeleton, Tabs } from '../components/ui/Misc'
import { Checkbox, Input, Select } from '../components/ui/Form'
import { Menu } from '../components/ui/Popover'
import { Dialog } from '../components/ui/Overlay'
import { ProgressBar } from '../components/ui/Misc'
import { SpeakerDot } from '../components/SpeakerChip'
import { SampleList } from '../components/AudioPlayer'
import { SpeakerNameInput } from '../components/speakers/SpeakerNameInput'
import { useSpeakerActions } from '../components/speakers/SpeakerActions'
import { useToast } from '../components/ui/Toast'
import { useT } from '../i18n'
import { sortSpeakers, type SpeakerSort as Sort } from '../lib/speakerSort'

type Tab = 'all' | 'named' | 'unnamed' | 'ignored'
const SCATTERED_MAX = 5

export default function Speakers() {
  const t = useT()
  const fmt = useFmt()
  const { data, isLoading, error, refetch } = useSpeakers()
  const settings = useSettings(false)
  const { label } = useSpeakerLookup()
  const actions = useSpeakerActions()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'all'
  const [sort, setSort] = useState<Sort>('default')
  const [q, setQ] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<number[]>([])
  const [showScattered, setShowScattered] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)

  const setTab = (v: Tab) => { const p = new URLSearchParams(params); if (v === 'all') p.delete('tab'); else p.set('tab', v); setParams(p, { replace: true }) }

  usePageKeys((e) => { if (e.key === '/') { e.preventDefault(); document.getElementById('speaker-search')?.focus() } }, [])

  const all = data ?? []
  const counts = useMemo(() => ({
    all: all.filter((s) => s.state !== 'ignored').length,
    named: all.filter((s) => s.state === 'named').length,
    unnamed: all.filter((s) => s.state === 'unnamed').length,
    ignored: all.filter((s) => s.state === 'ignored').length,
  }), [all])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return all.filter((s) => (!needle || label(s.id).toLowerCase().includes(needle)))
  }, [all, q, label])

  const sections = useMemo(() => {
    const sorted = (l: Speaker[]) => sortSpeakers(l, sort, label)
    const unnamedAll = filtered.filter((s) => s.state === 'unnamed')
    return {
      unnamed: sorted(unnamedAll.filter((s) => s.utterance_count >= SCATTERED_MAX)),
      scattered: sorted(unnamedAll.filter((s) => s.utterance_count < SCATTERED_MAX)),
      named: sorted(filtered.filter((s) => s.state === 'named')),
      ignored: sorted(filtered.filter((s) => s.state === 'ignored')),
    }
  }, [filtered, sort, label])

  // Drop selections for speakers that vanished (merged/deleted elsewhere).
  useEffect(() => { setSelected((sel) => sel.filter((id) => all.some((s) => s.id === id))) }, [all])

  const toggle = (id: number) => setSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : sel.length >= 2 ? [sel[1], id] : [...sel, id]))
  const exitSelect = () => { setSelecting(false); setSelected([]) }
  const selSpeakers = selected.map((id) => all.find((s) => s.id === id)).filter(Boolean) as Speaker[]

  const isNew = (s: Speaker) => s.state === 'unnamed' && !!s.first_seen && Date.now() - Date.parse(s.first_seen) < 24 * 3600_000

  const card = (s: Speaker) => (
    <SpeakerCard key={s.id} sp={s} isNew={isNew(s)} selecting={selecting} selected={selected.includes(s.id)} onToggle={() => toggle(s.id)} fmt={fmt} />
  )

  let body: React.ReactNode
  if (isLoading) {
    body = <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-44" />)}</div>
  } else if (error) {
    body = <ErrorBar message={(error as Error).message || t('common.error_load')} onRetry={() => void refetch()} retryLabel={t('common.retry')} />
  } else if (all.length === 0) {
    body = settings.data?.asr.mode === 'openai'
      ? <EmptyState icon={<Users />} title={t('speakers.empty_openai')} />
      : <EmptyState icon={<Users />} title={t('speakers.empty')} />
  } else if (tab === 'all') {
    const any = sections.unnamed.length + sections.named.length + sections.scattered.length + sections.ignored.length
    body = any === 0 ? <EmptyState compact title={t('speakers.empty_filtered')} /> : (
      <div className="space-y-7">
        {sections.unnamed.length > 0 && (
          <Section title={t('speakers.section_unnamed', { n: sections.unnamed.length })} hint={t('speakers.section_unnamed_hint')}>
            {sections.unnamed.map(card)}
          </Section>
        )}
        {sections.named.length > 0 && (
          <Section title={t('speakers.section_named', { n: sections.named.length })}>{sections.named.map(card)}</Section>
        )}
        {sections.scattered.length > 0 && (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setShowScattered((v) => !v)}
                aria-expanded={showScattered}
                className="flex items-center gap-1.5 text-[13px] font-semibold text-muted hover:text-fg"
              >
                {showScattered ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                {t('speakers.section_scattered', { n: sections.scattered.length })}
              </button>
              {showScattered && <Button size="sm" variant="secondary" onClick={() => setBulkOpen(true)}>{t('speakers.bulk')}</Button>}
            </div>
            {showScattered && (
              <>
                <p className="mt-1 text-xs text-muted">{t('speakers.section_scattered_hint')}</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{sections.scattered.map(card)}</div>
              </>
            )}
          </div>
        )}
        {sections.ignored.length > 0 && (
          <Section title={t('speakers.section_ignored', { n: sections.ignored.length })}>{sections.ignored.map(card)}</Section>
        )}
      </div>
    )
  } else {
    const list = tab === 'named' ? sections.named : tab === 'ignored' ? sections.ignored : [...sections.unnamed, ...sections.scattered]
    body = list.length === 0
      ? <EmptyState compact title={q ? t('speakers.empty_filtered') : t(tab === 'ignored' ? 'speakers.empty_filtered' : 'speakers.empty_filtered')} />
      : <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{list.map(card)}</div>
  }

  return (
    <Page
      title={t('speakers.title')}
      subtitle={t('speakers.subtitle')}
      actions={all.length > 1 && (
        selecting
          ? <Button onClick={exitSelect} icon={<X className="h-4 w-4" />}>{t('common.cancel')}</Button>
          : <Button onClick={() => setSelecting(true)} icon={<GitMerge className="h-4 w-4" />}>{t('speakers.select')}</Button>
      )}
    >
      {settings.data?.asr.mode === 'openai' && all.length > 0 && <Banner tone="info" className="mb-4">{t('speakers.empty_openai')}</Banner>}
      <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Tabs
          label={t('speakers.title')}
          value={tab}
          onChange={setTab}
          items={[
            { value: 'all', label: t('speakers.tab_all'), count: counts.all },
            { value: 'named', label: t('speakers.tab_named'), count: counts.named },
            { value: 'unnamed', label: t('speakers.tab_unnamed'), count: counts.unnamed },
            { value: 'ignored', label: t('speakers.tab_ignored'), count: counts.ignored },
          ]}
        />
        <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
          <Input id="speaker-search" className="min-w-0 flex-1 sm:w-52" leading={<Search className="h-4 w-4" />} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('speakers.search')} aria-label={t('speakers.search')} />
          <Select className="w-32 shrink-0" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t('speakers.sort')}>
            <option value="default">{t('speakers.sort_default')}</option>
            <option value="recent">{t('speakers.sort_recent')}</option>
            <option value="count">{t('speakers.sort_count')}</option>
            <option value="seconds">{t('speakers.sort_seconds')}</option>
            <option value="name">{t('speakers.sort_name')}</option>
          </Select>
        </div>
      </div>
      {body}

      {selecting && (
        <div className="sticky bottom-0 z-20 -mx-4 mt-6 border-t border-line bg-surface/95 px-4 py-2.5 shadow-pop backdrop-blur sm:-mx-6 sm:px-6" role="region" aria-label={t('speakers.merge_selected')}>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted" aria-live="polite">{t('speakers.selected_n', { n: selected.length })}</span>
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" onClick={() => setSelected([])} disabled={selected.length === 0}>{t('speakers.clear_selection')}</Button>
              <Button
                variant="primary"
                icon={<GitMerge className="h-4 w-4" />}
                disabled={selected.length !== 2}
                onClick={() => { actions.merge(selSpeakers[0], selSpeakers[1]); exitSelect() }}
              >{t('speakers.merge_selected')}</Button>
            </div>
          </div>
        </div>
      )}
      <BulkDialog open={bulkOpen} onClose={() => setBulkOpen(false)} speakers={sections.scattered} />
    </Page>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[13px] font-semibold text-muted">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-faint">{hint}</p>}
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
    </section>
  )
}

function SpeakerCard({ sp, isNew, selecting, selected, onToggle, fmt }: {
  sp: Speaker; isNew: boolean; selecting: boolean; selected: boolean; onToggle: () => void; fmt: ReturnType<typeof useFmt>
}) {
  const t = useT()
  const actions = useSpeakerActions()
  const { label } = useSpeakerLookup()
  const navigate = useNavigate()
  const ignored = sp.state === 'ignored'
  const name = label(sp.id)
  return (
    <article
      className={cn('card flex flex-col gap-3 p-4 transition-shadow', selected && 'ring-2 ring-accent', ignored && 'opacity-70')}
      onClick={selecting ? onToggle : undefined}
      aria-label={name}
    >
      <div className="flex items-start gap-2.5">
        {selecting && <Checkbox className="mt-0.5" checked={selected} onChange={onToggle} hideLabel={name} round />}
        <SpeakerDot color={sp.color} dashed={sp.state === 'unnamed'} className="mt-[7px] h-3 w-3" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <Link to={`/speakers/${sp.id}`} className={cn('truncate text-[15px] font-semibold hover:text-accent', sp.state === 'unnamed' && 'italic')} onClick={(e) => selecting && e.preventDefault()}>
              {name}
            </Link>
            {isNew && <Badge tone="accent">{t('speakers.new_badge')}</Badge>}
            {ignored && <Badge>{t('speakers.state_ignored')}</Badge>}
          </div>
          <p className="tabular mt-0.5 text-xs text-muted">
            {sp.utterance_count === 0 ? t('speakers.never_seen') : t('speakers.stats', {
              n: sp.utterance_count,
              d: fmt.duration(sp.total_seconds),
              t: sp.last_seen ? fmt.relative(sp.last_seen) : '—',
            })}
          </p>
        </div>
        {!selecting && (
          <Menu
            label={t('speakers.details')}
            items={[
              { label: t('speakers.details'), icon: <UserRound />, onSelect: () => navigate(`/speakers/${sp.id}`) },
              { label: t('speakers.merge_to'), icon: <GitMerge />, onSelect: () => actions.merge(sp) },
              ignored
                ? { label: t('speakers.restore'), icon: <RotateCcw />, onSelect: () => actions.restore(sp) }
                : { label: t('speakers.ignore'), icon: <Ban />, onSelect: () => actions.ignore(sp), divider: true },
              { label: t('common.delete'), icon: <Trash2 />, danger: true, onSelect: () => actions.remove(sp) },
            ]}
            trigger={<button type="button" className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg max-sm:h-10 max-sm:w-10" aria-label={`${name} …`}><MoreHorizontal className="h-4 w-4" /></button>}
          />
        )}
      </div>
      {ignored ? (
        <p className="text-xs text-muted">{t('speakers.kept_utterances', { n: sp.utterance_count })}</p>
      ) : (
        <>
          <SampleList speakerId={sp.id} samples={sp.samples} />
          {sp.samples.length === 0 && sp.state === 'unnamed' && <p className="-mt-1 text-xs text-faint">{t('speakers.no_samples_new')}</p>}
        </>
      )}
      {sp.state === 'unnamed' && !selecting && <SpeakerNameInput speaker={sp} />}
      {sp.state === 'named' && !selecting && (
        <div className="-mb-1 mt-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => actions.merge(sp)} icon={<GitMerge className="h-3.5 w-3.5" />}>{t('speakers.merge_to')}</Button>
        </div>
      )}
    </article>
  )
}

function BulkDialog({ open, onClose, speakers }: { open: boolean; onClose: () => void; speakers: Speaker[] }) {
  const t = useT()
  const toast = useToast()
  const actions = useSpeakerActions()
  const [mode, setMode] = useState<'ignore' | 'delete'>('ignore')
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null)
  const run = useMutation({
    mutationFn: async () => {
      const total = speakers.length
      setProg({ done: 0, total })
      let done = 0
      for (const s of speakers) {
        if (mode === 'ignore') await api.patch(`/speakers/${s.id}`, { state: 'ignored' })
        else await api.del(`/speakers/${s.id}`, { delete_utterances: true })
        done++
        setProg({ done, total })
      }
      return total
    },
    onSuccess: (n) => { toast.success(t('speakers.bulk_done', { n })); actions.invalidate(); setProg(null); onClose() },
    onError: (e) => { toast.error(e); actions.invalidate(); setProg(null) },
  })
  return (
    <Dialog
      open={open}
      onClose={() => !run.isPending && onClose()}
      title={t('speakers.bulk_title', { n: speakers.length })}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={run.isPending}>{t('common.cancel')}</Button>
          <Button variant={mode === 'delete' ? 'danger' : 'primary'} loading={run.isPending} onClick={() => run.mutate()}>
            {mode === 'delete' ? t('speakers.bulk_confirm_delete', { n: speakers.length }) : t('speakers.bulk_confirm_ignore', { n: speakers.length })}
          </Button>
        </>
      }
    >
      <div className="space-y-2.5" role="radiogroup" aria-label={t('speakers.bulk')}>
        {(['ignore', 'delete'] as const).map((m) => (
          <label key={m} className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm', mode === m ? 'border-accent bg-accent-soft/40' : 'border-line')}>
            <input type="radio" name="bulk" className="mt-1 accent-[rgb(var(--accent))]" checked={mode === m} onChange={() => setMode(m)} />
            <span>{m === 'ignore' ? t('speakers.bulk_ignore') : t('speakers.bulk_delete')}</span>
          </label>
        ))}
      </div>
      {prog && (
        <div className="mt-4 space-y-1.5" aria-live="polite">
          <p className="text-xs text-muted">{t('speakers.bulk_progress', prog)}</p>
          <ProgressBar value={prog.done} max={prog.total} label={t('speakers.bulk')} />
        </div>
      )}
    </Dialog>
  )
}
