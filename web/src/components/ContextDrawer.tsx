import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { api } from '../lib/api'
import type { Page, Utterance } from '../lib/types'
import { useFmt } from '../hooks/useData'
import { Drawer } from './ui/Overlay'
import { ErrorBar, Skeleton } from './ui/Misc'
import { SpeakerChip } from './SpeakerChip'
import { cn } from '../lib/cn'
import { useT } from '../i18n'

/** Shows the conversation around one utterance (±2 minutes). */
export function ContextDrawer({ utteranceId, onClose, hideTimelineLink }: { utteranceId: number | null; onClose: () => void; hideTimelineLink?: boolean }) {
  const t = useT()
  const fmt = useFmt()
  const open = utteranceId != null
  const q = useQuery({
    queryKey: ['utterances', 'around', utteranceId],
    queryFn: () => api.get<Page<Utterance> | Utterance[]>('/utterances', { around: utteranceId!, window: 120, exclude_ignored: false, limit: 100 }),
    enabled: open,
  })
  const items = Array.isArray(q.data) ? q.data : q.data?.items ?? []
  const hit = useRef<HTMLLIElement>(null)
  useEffect(() => { if (items.length) hit.current?.scrollIntoView({ block: 'center' }) }, [items.length, utteranceId])
  const target = items.find((u) => u.id === utteranceId)
  return (
    <Drawer open={open} onClose={onClose} title={t('speakers.context_title')} description={t('speakers.context_hint')} size="md">
      {q.isLoading && <div className="space-y-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>}
      {q.error && <ErrorBar message={(q.error as Error).message} onRetry={() => void q.refetch()} retryLabel={t('common.retry')} />}
      {items.length > 0 && (
        <ol className="space-y-1">
          {items.map((u) => (
            <li key={u.id} ref={u.id === utteranceId ? hit : undefined} className={cn('rounded-lg px-3 py-2', u.id === utteranceId && 'bg-accent-soft ring-1 ring-accent/30')}>
              <div className="flex items-center gap-2 text-xs text-muted">
                <SpeakerChip speakerId={u.speaker_id} fallbackName={u.speaker_name} size="sm" />
                <span className="tabular">{fmt.clock(u.started_at, true)}</span>
              </div>
              <p className="mt-1 text-sm leading-6">{u.text}</p>
            </li>
          ))}
        </ol>
      )}
      {!hideTimelineLink && target && (
        <Link to={`/timeline?around=${target.id}`} onClick={onClose} className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
          {t('utt.open_in_timeline')} <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      )}
    </Drawer>
  )
}
