import { useEffect, useRef, useState } from 'react'
import { Copy, HelpCircle, Layers, ListChecks, MessageSquareQuote, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { Utterance } from '../../lib/types'
import { useFmt, useSpeakerLookup } from '../../hooks/useData'
import { SpeakerChip } from '../SpeakerChip'
import { Highlight } from '../Highlight'
import { Checkbox } from '../ui/Form'
import { Menu } from '../ui/Popover'
import { Tooltip } from '../ui/Popover'
import { useToast } from '../ui/Toast'
import { useUtteranceOps } from '../speakers/UtteranceOps'
import { api } from '../../lib/api'
import { emitUtteranceChange } from '../../lib/utteranceBus'
import { useT } from '../../i18n'

export interface RowProps {
  u: Utterance
  q?: string
  showDate?: boolean
  dominantLang?: string | null
  selectMode: boolean
  selected: boolean
  active: boolean
  flash: boolean
  onSelectToggle: (shift: boolean) => void
  onActivate: () => void
  onChipClick: (anchor: HTMLElement) => void
  onContext?: () => void
}

export function UtteranceRow({ u, q, showDate, dominantLang, selectMode, selected, active, flash, onSelectToggle, onActivate, onChipClick, onContext }: RowProps) {
  const t = useT()
  const fmt = useFmt()
  const toast = useToast()
  const ops = useUtteranceOps()
  const { label } = useSpeakerLookup()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(u.text)
  const [err, setErr] = useState<string | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const low = (u.confidence ?? 1) < 0.5
  const showLang = !!u.lang && !!dominantLang && u.lang !== dominantLang

  useEffect(() => { if (editing) { ta.current?.focus(); ta.current?.setSelectionRange(draft.length, draft.length) } }, [editing]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    const text = draft.trim()
    if (!text) { setErr(t('utt.edit_empty')); return }
    if (text === u.text) { setEditing(false); return }
    try {
      const res = await api.patch<Utterance>(`/utterances/${u.id}`, { text })
      emitUtteranceChange({ type: 'patch', utterance: res })
      setEditing(false)
    } catch (e) { toast.error(e) }
  }
  const copy = () => {
    const line = `[${fmt.clock(u.started_at)} ${label(u.speaker_id, u.speaker_name)}] ${u.text}`
    navigator.clipboard?.writeText(line).then(() => toast.success(t('common.copied')), () => toast.error(new Error(t('common.copy_failed'))))
  }

  return (
    <div
      className={cn(
        'group flex items-start gap-2 border-b border-line/60 px-3 py-2 sm:gap-3 sm:px-4',
        active && 'bg-hover',
        selected && 'bg-accent-soft/60',
        flash && 'animate-flash',
      )}
      onClick={() => (selectMode ? onSelectToggle(false) : onActivate())}
      data-utterance-id={u.id}
    >
      {selectMode && (
        <div className="flex w-5 shrink-0 justify-center pt-[3px]">
          <Checkbox checked={selected} onChange={(_v, e) => onSelectToggle(!!(e as unknown as MouseEvent)?.shiftKey)} hideLabel={u.text} />
        </div>
      )}
      <div className="min-w-0 flex-1 sm:flex sm:items-start sm:gap-3">
        <div className="flex items-center gap-2 sm:contents">
          <time dateTime={u.started_at} className="tabular shrink-0 pt-[3px] text-xs text-muted sm:w-[4.25rem] sm:text-[12.5px]" title={fmt.full(u.started_at)}>
            {showDate ? <span className="sm:block">{fmt.dateTime(u.started_at)}</span> : fmt.clock(u.started_at, true)}
          </time>
          <span className="shrink-0 sm:w-[9.5rem]">
            <SpeakerChip speakerId={u.speaker_id} fallbackName={u.speaker_name} muted={low} onClick={(e) => { e.stopPropagation(); onChipClick(e.currentTarget) }} />
          </span>
        </div>
        <div className="mt-1 min-w-0 flex-1 sm:mt-0">
          {editing ? (
            <div onClick={(e) => e.stopPropagation()}>
              <textarea
                ref={ta}
                value={draft}
                onChange={(e) => { setDraft(e.target.value); setErr(null) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void save() }
                  if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); setDraft(u.text) }
                }}
                rows={Math.min(6, Math.max(2, Math.ceil(draft.length / 40)))}
                aria-label={t('utt.edit_text')}
                aria-invalid={!!err || undefined}
                className="w-full resize-y rounded-lg border border-accent bg-surface px-2.5 py-1.5 text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-accent/25 max-sm:text-base"
              />
              <p className={cn('mt-1 text-xs', err ? 'text-danger' : 'text-faint')}>{err ?? t('utt.edit_keys')}</p>
            </div>
          ) : (
            <p className={cn('break-words text-sm leading-6', low && 'italic text-muted')}>
              <Highlight text={u.text} q={q} />
              {showLang && <span className="ml-1.5 rounded bg-subtle px-1 align-[1px] text-[10.5px] font-medium uppercase text-muted">{u.lang}</span>}
              {low && (
                <Tooltip text={t('utt.low_conf')}>
                  <span className="ml-1 inline-flex align-[-2px] text-faint" tabIndex={0} aria-label={t('utt.low_conf')}><HelpCircle className="h-3.5 w-3.5" /></span>
                </Tooltip>
              )}
              {u.text_edited && <Pencil className="ml-1.5 inline h-3 w-3 text-faint" aria-label={t('utt.edited')} />}
            </p>
          )}
        </div>
      </div>
      {!selectMode && !editing && (
        <Menu
          label={t('utt.menu')}
          className="shrink-0 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:focus-within:opacity-100"
          items={[
            { label: t('utt.change_speaker'), icon: <Layers />, onSelect: () => ops.reassign([u]) },
            { label: t('utt.edit_text'), icon: <Pencil />, onSelect: () => { setDraft(u.text); setErr(null); setEditing(true) } },
            { label: t('common.copy'), icon: <Copy />, onSelect: copy },
            { label: t('utt.create_todo'), icon: <ListChecks />, onSelect: () => ops.createTodo(u) },
            { label: t('utt.view_context'), icon: <MessageSquareQuote />, onSelect: () => onContext?.(), hidden: !onContext },
            { label: t('common.delete'), icon: <Trash2 />, danger: true, divider: true, onSelect: () => ops.remove([u]) },
          ]}
          trigger={<button type="button" aria-label={t('utt.menu')} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-fg max-sm:h-10 max-sm:w-8"><MoreHorizontal className="h-4 w-4" /></button>}
        />
      )}
    </div>
  )
}
