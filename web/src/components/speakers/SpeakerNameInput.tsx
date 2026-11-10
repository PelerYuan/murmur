import { forwardRef, useId, useMemo, useState } from 'react'
import { Check, GitMerge } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { Speaker } from '../../lib/types'
import { useSpeakerLookup } from '../../hooks/useData'
import { validateSpeakerName } from '../../lib/speakerName'
import { useSpeakerActions } from './SpeakerActions'
import { SpeakerDot } from '../SpeakerChip'
import { useT } from '../../i18n'

/**
 * "Who is this?" input. Enter saves (validation + same-name prompt live in SpeakerActions);
 * typing the prefix of an existing name offers "merge into X".
 */
export const SpeakerNameInput = forwardRef<HTMLInputElement, {
  speaker: Speaker; className?: string; autoFocus?: boolean; onSaved?: () => void; placeholder?: string
}>(function SpeakerNameInput({ speaker, className, autoFocus, onSaved, placeholder }, ref) {
  const t = useT()
  const actions = useSpeakerActions()
  const { list, label } = useSpeakerLookup()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const hintId = useId()
  const v = validateSpeakerName(value)
  const err = value.trim() && !v.ok ? (v.reason === 'too_long' ? t('speakers.name_too_long') : v.reason === 'numeric' ? t('speakers.name_numeric') : null) : null

  const suggestions = useMemo(() => {
    const q = value.trim().toLowerCase()
    if (!q) return []
    return list
      .filter((s) => s.id !== speaker.id && s.state === 'named' && s.name && s.name.toLowerCase().startsWith(q))
      .slice(0, 3)
  }, [list, value, speaker.id])

  const submit = async () => {
    if (!value.trim() || busy) return
    setBusy(true)
    const ok = await actions.name(speaker, value)
    setBusy(false)
    if (ok) { setValue(''); onSaved?.() }
  }

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="relative">
        <input
          ref={ref}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void submit() } }}
          placeholder={placeholder ?? t('speakers.name_placeholder')}
          aria-label={t('speakers.name_aria', { label: label(speaker.id) })}
          aria-describedby={hintId}
          aria-invalid={!!err || undefined}
          maxLength={60}
          enterKeyHint="done"
          className={cn(
            'h-9 w-full rounded-lg border bg-surface pl-3 pr-10 text-sm placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 max-sm:h-11 max-sm:text-base',
            err ? 'border-danger' : 'border-line-strong',
          )}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!value.trim() || busy}
          aria-label={t('common.save')}
          className="absolute right-1 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-accent transition-opacity hover:bg-accent-soft disabled:opacity-0 max-sm:h-9 max-sm:w-9"
        >
          <Check className="h-4 w-4" />
        </button>
      </div>
      <p id={hintId} className={cn('text-xs', err ? 'text-danger' : 'sr-only')} role={err ? 'alert' : undefined}>
        {err ?? t('speakers.name_hint')}
      </p>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => actions.merge(speaker, s)}
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-2.5 text-xs text-muted hover:border-accent/60 hover:text-fg max-sm:h-9"
            >
              <GitMerge className="h-3 w-3" aria-hidden />
              <SpeakerDot color={s.color} className="h-2 w-2" />
              {t('speakers.suggest_merge', { name: s.name ?? '' })}
            </button>
          ))}
        </div>
      )}
    </div>
  )
})
