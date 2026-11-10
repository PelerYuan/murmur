import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftRight, ArrowRight } from 'lucide-react'
import { api } from '../../lib/api'
import { qk } from '../../lib/queryClient'
import type { Speaker } from '../../lib/types'
import { validateSpeakerName, findDuplicateName } from '../../lib/speakerName'
import { useSettings, useSpeakerLookup } from '../../hooks/useData'
import { useRegenerateToday } from '../../hooks/useSummaryActions'
import { useToast } from '../ui/Toast'
import { Dialog } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { Banner } from '../ui/Misc'
import { ConfirmDialog } from '../ui/Confirm'
import { Checkbox } from '../ui/Form'
import { SpeakerDot } from '../SpeakerChip'
import { SampleList } from '../AudioPlayer'
import { SpeakerPickerList } from './SpeakerPicker'
import { useT } from '../../i18n'

export interface SpeakerActions {
  /** Validate + save a name (handles empty → unname, same-name prompt). Returns true when saved. */
  name: (sp: Speaker, raw: string) => Promise<boolean>
  merge: (source: Speaker, target?: Speaker) => void
  ignore: (sp: Speaker) => void
  restore: (sp: Speaker) => void
  remove: (sp: Speaker, onDone?: () => void) => void
  invalidate: () => void
}
const Ctx = createContext<SpeakerActions | null>(null)
export function useSpeakerActions(): SpeakerActions {
  const c = useContext(Ctx)
  if (!c) throw new Error('SpeakerActionsProvider missing')
  return c
}

export function SpeakerActionsProvider({ children }: { children: ReactNode }) {
  const t = useT()
  const qc = useQueryClient()
  const toast = useToast()
  const { list, label } = useSpeakerLookup()
  const regen = useRegenerateToday()
  const [mergeState, setMergeState] = useState<{ source: Speaker; target?: Speaker; onDone?: () => void } | null>(null)
  const [dup, setDup] = useState<{ sp: Speaker; name: string; other: Speaker } | null>(null)
  const [unname, setUnname] = useState<Speaker | null>(null)
  const [ignoring, setIgnoring] = useState<Speaker | null>(null)
  const [removing, setRemoving] = useState<{ sp: Speaker; onDone?: () => void } | null>(null)

  const invalidate = useCallback(() => {
    for (const key of [qk.speakers, ['speaker'], ['utterances'], qk.dashboard, qk.todos, ['feed']]) void qc.invalidateQueries({ queryKey: key })
  }, [qc])

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: { name?: string; state?: string } }) => api.patch<Speaker>(`/speakers/${id}`, body),
    onSuccess: invalidate,
  })

  const regenLink = (
    regen.available ? (
      <button className="ml-2 font-medium text-accent underline underline-offset-2" onClick={regen.run}>{t('speakers.regen_today')}</button>
    ) : null
  )

  const save = useCallback(async (sp: Speaker, name: string): Promise<boolean> => {
    try {
      await patch.mutateAsync({ id: sp.id, body: { name } })
      toast.success(<>{t('speakers.named_ok', { name })}{regenLink}</>, 7000)
      return true
    } catch (e) {
      toast.error(e)
      return false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patch, toast, t, regen.available])

  const actions = useMemo<SpeakerActions>(() => ({
    name: async (sp, raw) => {
      const v = validateSpeakerName(raw)
      if (!v.ok) {
        if (v.reason === 'empty') {
          if (sp.name) setUnname(sp)
          return false
        }
        toast.error(new Error(t(v.reason === 'too_long' ? 'speakers.name_too_long' : 'speakers.name_numeric')))
        return false
      }
      if (v.name === sp.name) return true
      const other = findDuplicateName(list, v.name, sp.id)
      if (other) { setDup({ sp, name: v.name, other }); return false }
      return save(sp, v.name)
    },
    merge: (source, target) => setMergeState({ source, target }),
    ignore: (sp) => setIgnoring(sp),
    restore: (sp) => patch.mutate({ id: sp.id, body: { state: sp.name ? 'named' : 'unnamed' } }, { onError: (e) => toast.error(e) }),
    remove: (sp, onDone) => setRemoving({ sp, onDone }),
    invalidate,
  }), [list, save, patch, toast, t, invalidate])

  return (
    <Ctx.Provider value={actions}>
      {children}
      <MergeDialog
        state={mergeState}
        onClose={() => setMergeState(null)}
        onMerged={(n, targetName) => {
          toast.success(<>{t('speakers.merged_ok', { n, name: targetName })}{regenLink}</>, 7000)
        }}
        invalidate={invalidate}
      />
      <Dialog
        open={!!dup}
        onClose={() => setDup(null)}
        title={t('speakers.dup_title', { name: dup?.name ?? '' })}
        size="sm"
        footer={dup && (
          <>
            <Button onClick={() => { const d = dup; setDup(null); void save(d.sp, d.name) }}>{t('speakers.dup_keep')}</Button>
            <Button variant="primary" onClick={() => { const d = dup; setDup(null); setMergeState({ source: d.sp, target: d.other }) }}>
              {t('speakers.dup_merge', { name: dup.other.name ?? dup.name })}
            </Button>
          </>
        )}
      >
        {dup && (
          <div className="space-y-3 text-sm">
            <p>{t('speakers.dup_body', { name: dup.other.name ?? dup.name, n: dup.other.utterance_count })}</p>
            <Banner tone="info">{t('speakers.dup_hint')}</Banner>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!unname}
        title={t('speakers.unname_title')}
        body={t('speakers.unname_body', { name: unname?.name ?? '' })}
        confirmLabel={t('speakers.unname_confirm')}
        busy={patch.isPending}
        onClose={() => setUnname(null)}
        onConfirm={async () => { const s = unname!; try { await patch.mutateAsync({ id: s.id, body: { name: '' } }); setUnname(null) } catch (e) { toast.error(e) } }}
      />
      <ConfirmDialog
        open={!!ignoring}
        title={t('speakers.ignore_title', { name: ignoring ? label(ignoring.id) : '' })}
        body={
          <div className="space-y-2">
            <p>{t('speakers.ignore_body', { n: ignoring?.utterance_count ?? 0 })}</p>
            {ignoring?.state === 'named' && <Banner tone="warn">{t('speakers.ignore_named_warn')}</Banner>}
          </div>
        }
        confirmLabel={t('speakers.ignore')}
        busy={patch.isPending}
        onClose={() => setIgnoring(null)}
        onConfirm={async () => { const s = ignoring!; try { await patch.mutateAsync({ id: s.id, body: { state: 'ignored' } }); setIgnoring(null) } catch (e) { toast.error(e) } }}
      />
      <DeleteDialog state={removing} onClose={() => setRemoving(null)} invalidate={invalidate} />
    </Ctx.Provider>
  )
}

function DeleteDialog({ state, onClose, invalidate }: { state: { sp: Speaker; onDone?: () => void } | null; onClose: () => void; invalidate: () => void }) {
  const t = useT()
  const toast = useToast()
  const { label } = useSpeakerLookup()
  const [withUtts, setWithUtts] = useState(false)
  const del = useMutation({
    mutationFn: ({ id, withUtts }: { id: number; withUtts: boolean }) => api.del(`/speakers/${id}`, withUtts ? { delete_utterances: true } : undefined),
  })
  const sp = state?.sp
  const name = sp ? label(sp.id) : ''
  return (
    <ConfirmDialog
      key={sp?.id ?? 'none'}
      open={!!state}
      danger
      title={t('speakers.delete_title', { name })}
      typeToConfirm={name}
      confirmLabel={t('common.delete')}
      busy={del.isPending}
      onClose={() => { onClose(); setWithUtts(false) }}
      body={<p>{t('speakers.delete_body', { n: sp?.utterance_count ?? 0 })}</p>}
      extra={<Checkbox checked={withUtts} onChange={setWithUtts} label={t('speakers.delete_with_utterances', { n: sp?.utterance_count ?? 0 })} />}
      onConfirm={async () => {
        try {
          await del.mutateAsync({ id: sp!.id, withUtts })
          invalidate()
          toast.success(t('speakers.deleted_ok'))
          state?.onDone?.()
          onClose()
          setWithUtts(false)
        } catch (e) { toast.error(e) }
      }}
    />
  )
}

function SpeakerSummaryCard({ sp, heading, tone }: { sp: Speaker; heading: string; tone: 'src' | 'dst' }) {
  const t = useT()
  const { label } = useSpeakerLookup()
  return (
    <div className={`rounded-xl border p-3.5 ${tone === 'dst' ? 'border-accent/40 bg-accent-soft/40' : 'border-line bg-subtle/60'}`}>
      <p className="text-[11.5px] font-medium uppercase tracking-wide text-muted">{heading}</p>
      <div className="mt-1.5 flex items-center gap-2">
        <SpeakerDot color={sp.color} dashed={sp.state === 'unnamed'} className="h-3 w-3" />
        <span className={`truncate text-[15px] font-semibold ${sp.state === 'unnamed' ? 'italic' : ''}`}>{label(sp.id)}</span>
      </div>
      <p className="tabular mt-0.5 text-xs text-muted">
        {t('common.sentences', { n: sp.utterance_count })} · {t('speakers.minutes', { n: Math.max(1, Math.round(sp.total_seconds / 60)) })}
        {sp.state === 'ignored' && ` · ${t('speakers.state_ignored')}`}
      </p>
      <div className="mt-2.5"><SampleList speakerId={sp.id} samples={sp.samples} compact max={5} /></div>
    </div>
  )
}

function MergeDialog({ state, onClose, onMerged, invalidate }: {
  state: { source: Speaker; target?: Speaker } | null
  onClose: () => void
  onMerged: (n: number, targetName: string) => void
  invalidate: () => void
}) {
  const t = useT()
  const toast = useToast()
  const { label, map } = useSpeakerLookup()
  const settings = useSettings(false)
  const [override, setOverride] = useState<{ key: number; source: Speaker; target: Speaker } | null>(null)
  const [picking, setPicking] = useState(false)

  // Resolve source/target for the current request (fresh data from the cache when available).
  const open = !!state
  const base = useMemo(() => {
    if (!state) return null
    const fresh = (s: Speaker) => map.get(s.id) ?? s
    const src = fresh(state.source)
    if (state.target) return { source: src, target: fresh(state.target) }
    return null
  }, [state, map])
  const resolved = override && state && (override.source.id === state.source.id) ? override : base ? { ...base } : state ? { ...defaultFor(state.source, map) } : null
  const source = resolved?.source, target = resolved?.target

  const merge = useMutation({
    mutationFn: () => api.post<Speaker>(`/speakers/${source!.id}/merge`, { into_id: target!.id }),
  })

  const close = () => { setOverride(null); setPicking(false); onClose() }
  if (!open || !source || !target) return null

  const swap = () => setOverride({ key: Date.now(), source: target, target: source })
  const bothNamed = source.state === 'named' && target.state === 'named' && source.name !== target.name
  const inherits = target.state === 'unnamed' && source.state === 'named'
  const ignoredInvolved = source.state === 'ignored' || target.state === 'ignored'
  const keep = settings.data?.speakers.sample_count ?? 5
  const n = source.utterance_count

  return (
    <Dialog
      open
      onClose={close}
      title={t('speakers.merge_title')}
      size="lg"
      fullOnMobile
      footer={
        <>
          <Button onClick={close} disabled={merge.isPending}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={merge.isPending}
            onClick={async () => {
              try {
                const res = await merge.mutateAsync()
                invalidate()
                onMerged(n, label(res.id, res.name))
                close()
              } catch (e) {
                toast.error(e)
                if ((e as { status?: number }).status === 404) { invalidate(); close() }
              }
            }}
          >
            {t('speakers.merge_confirm', { n })}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid items-stretch gap-3 sm:grid-cols-[1fr_auto_1fr]">
          <SpeakerSummaryCard sp={source} heading={t('speakers.merge_source')} tone="src" />
          <div className="flex items-center justify-center">
            <button
              type="button"
              onClick={swap}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-xs font-medium text-muted hover:text-fg max-sm:h-11"
            >
              <ArrowLeftRight className="h-3.5 w-3.5 max-sm:hidden" /> <ArrowRight className="hidden h-3.5 w-3.5 max-sm:block max-sm:rotate-90" />
              {t('speakers.merge_swap')}
            </button>
          </div>
          <div>
            <SpeakerSummaryCard sp={target} heading={t('speakers.merge_target')} tone="dst" />
            <button type="button" onClick={() => setPicking((p) => !p)} className="mt-1.5 text-xs font-medium text-accent hover:underline">
              {picking ? t('speakers.merge_pick_close') : t('speakers.merge_pick')}
            </button>
          </div>
        </div>
        {picking && (
          <SpeakerPickerList
            selectedId={target.id}
            exclude={[source.id]}
            includeIgnored
            onSelect={(s) => { setOverride({ key: Date.now(), source, target: s }); setPicking(false) }}
          />
        )}
        {bothNamed && <Banner tone="danger" role="alert">{t('speakers.merge_both_named')}</Banner>}
        {ignoredInvolved && <Banner tone="warn">{t('speakers.merge_ignored_warn')}</Banner>}
        <div className="rounded-lg bg-subtle px-3.5 py-3 text-[13px] leading-6">
          <p className="font-medium">{t('speakers.merge_result_title')}</p>
          <p className="text-muted">
            {inherits ? t('speakers.merge_result_inherit', { name: label(source.id), n, keep }) : t('speakers.merge_result', { name: label(target.id), n, keep })}
          </p>
        </div>
        <p className="text-xs text-muted">{t('speakers.merge_irreversible')}</p>
      </div>
    </Dialog>
  )
}

function defaultFor(source: Speaker, map: Map<number, Speaker>): { source: Speaker; target: Speaker } | null {
  // Without a chosen target, pick the most sensible one automatically: the best other speaker.
  const others = [...map.values()].filter((s) => s.id !== source.id && s.state !== 'ignored')
  if (others.length === 0) return null
  const named = others.filter((s) => s.state === 'named').sort((a, b) => b.utterance_count - a.utterance_count)
  const target = named[0] ?? others.sort((a, b) => b.utterance_count - a.utterance_count)[0]
  return { source, target }
}
