import { useMemo, useState, type ReactNode } from 'react'
import { Check, Play, Search, UserRound } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Input } from '../ui/Form'
import { SpeakerDot } from '../SpeakerChip'
import { useAudio } from '../AudioPlayer'
import { sampleAudioUrl } from '../../lib/api'
import type { Speaker } from '../../lib/types'
import { useSpeakerLookup } from '../../hooks/useData'
import { useT } from '../../i18n'

/** Searchable speaker list: used by merge target, reassign, to-do assignee and "who am I". */
export function SpeakerPickerList({ selectedId, onSelect, exclude, top, noneLabel, onNone, namedOnly, includeIgnored, className, maxHeight = 'max-h-[320px]' }: {
  selectedId?: number | null
  onSelect: (s: Speaker) => void
  exclude?: number[]
  top?: ReactNode
  noneLabel?: string
  onNone?: () => void
  namedOnly?: boolean
  includeIgnored?: boolean
  className?: string
  maxHeight?: string
}) {
  const t = useT()
  const { list, label } = useSpeakerLookup()
  const audio = useAudio()
  const [q, setQ] = useState('')
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return list
      .filter((s) => !exclude?.includes(s.id))
      .filter((s) => (namedOnly ? s.state === 'named' : includeIgnored ? true : s.state !== 'ignored'))
      .filter((s) => !needle || label(s.id).toLowerCase().includes(needle))
      .sort((a, b) => (a.state === 'ignored' ? 1 : 0) - (b.state === 'ignored' ? 1 : 0) || b.utterance_count - a.utterance_count)
  }, [list, q, exclude, namedOnly, includeIgnored, label])

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Input leading={<Search className="h-4 w-4" />} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('picker.search')} aria-label={t('picker.search')} />
      <div className={cn('overflow-y-auto rounded-lg border border-line', maxHeight)} role="listbox" aria-label={t('picker.list')}>
        {top}
        {onNone && (
          <button type="button" role="option" aria-selected={selectedId == null} onClick={onNone} className="flex w-full items-center gap-2.5 border-b border-line px-3 py-2.5 text-left text-sm hover:bg-hover">
            <UserRound className="h-4 w-4 text-faint" />
            <span className="flex-1 text-muted">{noneLabel ?? t('common.none')}</span>
            {selectedId == null && <Check className="h-4 w-4 text-accent" />}
          </button>
        )}
        {rows.length === 0 && <p className="px-3 py-6 text-center text-[13px] text-muted">{t('picker.empty')}</p>}
        {rows.map((s) => {
          const first = s.samples[0]
          return (
            <div key={s.id} className="flex items-center border-b border-line last:border-b-0">
              <button
                type="button"
                role="option"
                aria-selected={selectedId === s.id}
                onClick={() => onSelect(s)}
                className="flex min-h-[44px] flex-1 items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-hover"
              >
                <SpeakerDot color={s.color} dashed={s.state === 'unnamed'} />
                <span className={cn('min-w-0 flex-1 truncate', s.state === 'unnamed' && 'italic')}>{label(s.id)}</span>
                {s.state === 'ignored' && <span className="text-[11px] text-faint">{t('speakers.state_ignored')}</span>}
                <span className="tabular text-xs text-muted">{t('common.sentences', { n: s.utterance_count })}</span>
                {selectedId === s.id && <Check className="h-4 w-4 text-accent" />}
              </button>
              {first && (
                <button
                  type="button"
                  aria-label={t('speakers.play_sample')}
                  className="mr-1.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-accent-soft hover:text-accent max-sm:h-10 max-sm:w-10"
                  onClick={() => audio.toggle(`${s.id}:${first.id}`, sampleAudioUrl(s.id, first.id))}
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
