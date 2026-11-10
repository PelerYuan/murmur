import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCw } from 'lucide-react'
import { api, ApiError } from '../../lib/api'
import { qk } from '../../lib/queryClient'
import type { Chunk, Page } from '../../lib/types'
import { useFmt, usePipeline, useRecorders } from '../../hooks/useData'
import { Drawer } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { Banner, Skeleton } from '../ui/Misc'
import { useToast } from '../ui/Toast'
import { useT } from '../../i18n'

/** Lets any page open the queue drawer that the shell hosts. */
export function openQueue() { window.dispatchEvent(new Event('murmur:open-queue')) }

export function PipelineDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const fmt = useFmt()
  const qc = useQueryClient()
  const toast = useToast()
  const pipeline = usePipeline(open ? 5000 : false)
  const recorders = useRecorders()
  const failed = useQuery({
    queryKey: qk.failedChunks,
    queryFn: () => api.get<Page<Chunk>>('/chunks', { status: 'failed', limit: 100 }),
    enabled: open,
    refetchInterval: open ? 10_000 : false,
  })
  const [gone, setGone] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState<Set<number>>(new Set())
  const [bulk, setBulk] = useState(false)

  const refresh = () => { void qc.invalidateQueries({ queryKey: qk.failedChunks }); void qc.invalidateQueries({ queryKey: qk.pipeline }) }
  const retryOne = useMutation({
    mutationFn: (id: number) => api.post(`/chunks/${id}/retry`),
  })

  const doRetry = async (id: number): Promise<'ok' | 'gone'> => {
    setBusy((b) => new Set(b).add(id))
    try {
      await retryOne.mutateAsync(id)
      return 'ok'
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { setGone((g) => new Set(g).add(id)); return 'gone' }
      throw e
    } finally {
      setBusy((b) => { const n = new Set(b); n.delete(id); return n })
    }
  }
  const retry = async (id: number) => {
    try { if ((await doRetry(id)) === 'ok') toast.success(t('pipeline.queued')) } catch (e) { toast.error(e) }
    refresh()
  }
  const retryAll = async () => {
    setBulk(true)
    let ok = 0, skipped = 0
    for (const c of failed.data?.items ?? []) {
      if (gone.has(c.id) || c.audio_deleted) { skipped++; continue }
      try { (await doRetry(c.id)) === 'ok' ? ok++ : skipped++ } catch (e) { toast.error(e); break }
    }
    setBulk(false)
    toast.success(t('pipeline.retry_all_done', { ok, skipped }))
    refresh()
  }

  const p = pipeline.data
  const counts: [keyof NonNullable<typeof p>['counts'], string][] = [
    ['pending', t('pipeline.pending')], ['processing', t('pipeline.processing')], ['done', t('pipeline.done')], ['failed', t('pipeline.failed')], ['skipped', t('pipeline.skipped')],
  ]
  const recName = (id: number) => recorders.data?.find((r) => r.id === id)?.name ?? `#${id}`
  const rows = failed.data?.items ?? []

  return (
    <Drawer open={open} onClose={onClose} title={t('pipeline.title')} size="lg">
      <div className="space-y-5">
        {!p ? <Skeleton className="h-20" /> : (
          <>
            <div className="grid grid-cols-5 gap-2">
              {counts.map(([k, label]) => (
                <div key={k} className="rounded-lg border border-line px-2 py-2 text-center">
                  <p className={`tabular text-lg font-semibold ${k === 'failed' && p.counts.failed ? 'text-danger' : ''}`}>{p.counts[k]}</p>
                  <p className="text-[11px] text-muted">{label}</p>
                </div>
              ))}
            </div>
            <dl className="grid grid-cols-2 gap-3 text-[13px]">
              <div><dt className="text-muted">{t('pipeline.oldest_pending')}</dt><dd className="mt-0.5 font-medium">{p.oldest_pending_at ? fmt.relative(p.oldest_pending_at) : t('pipeline.never')}</dd></div>
              <div><dt className="text-muted">{t('pipeline.last_done')}</dt><dd className="mt-0.5 font-medium">{p.last_done_at ? fmt.relative(p.last_done_at) : t('pipeline.never')}</dd></div>
            </dl>
            <p className="text-xs text-muted">{t('pipeline.skipped_hint')}</p>
            {p.errors.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="text-[13px] font-semibold">{t('pipeline.recent_errors')}</h3>
                {p.errors.map((e, i) => (
                  <div key={i} className="rounded-md bg-danger-soft px-2.5 py-1.5 text-xs">
                    <span className="text-muted">{fmt.dateTime(e.at)} · #{e.chunk_id} · </span>
                    <span className="break-words font-mono">{e.error}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-semibold">{t('pipeline.failed_chunks')}</h3>
            {rows.length > 1 && <Button size="sm" onClick={() => void retryAll()} loading={bulk} icon={<RotateCw className="h-3.5 w-3.5" />}>{t('pipeline.retry_all')}</Button>}
          </div>
          {failed.isLoading ? <Skeleton className="h-16" /> : rows.length === 0 ? (
            <Banner tone="ok">{t('pipeline.no_failed')}</Banner>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {rows.map((c) => {
                const dead = gone.has(c.id) || c.audio_deleted
                return (
                  <li key={c.id} className="flex items-start gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1 text-[13px]">
                      <p className="font-medium">{fmt.dateTime(c.started_at)} · {recName(c.recorder_id)} <span className="font-normal text-muted">· {t('pipeline.attempts', { n: c.attempts })}</span></p>
                      <p className="mt-0.5 break-words font-mono text-xs text-muted">{c.error}</p>
                      {dead && <p className="mt-1 text-xs text-warn">{t('pipeline.audio_deleted')}</p>}
                    </div>
                    <Button size="sm" disabled={dead} loading={busy.has(c.id)} onClick={() => void retry(c.id)} title={dead ? t('pipeline.audio_deleted') : undefined}>
                      {t('common.retry')}
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </Drawer>
  )
}
