import { useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { qk } from '../../lib/queryClient'
import { Button } from '../ui/Button'
import { Textarea } from '../ui/Form'
import { Skeleton } from '../ui/Misc'
import { ToggleRow } from './Fields'
import type { Settings } from '../../lib/types'
import { useT, type TKey } from '../../i18n'

interface Defaults { prompts: Settings['llm']['prompts']; placeholders: string[] }
type PromptKey = keyof Settings['llm']['prompts']
const KEYS: { key: PromptKey; title: TKey; hint: TKey }[] = [
  { key: 'summary', title: 'set.prompt_summary', hint: 'set.prompt_summary_hint' },
  { key: 'daily', title: 'set.prompt_daily', hint: 'set.prompt_daily_hint' },
  { key: 'todos', title: 'set.prompt_todos', hint: 'set.prompt_todos_hint' },
]

function PromptRow({ k, title, hint, value, defaults, placeholders, onChange, error }: {
  k: PromptKey; title: string; hint: string; value: string; defaults: string | undefined; placeholders: string[]; onChange: (v: string) => void; error?: string
}) {
  const t = useT()
  const [on, setOn] = useState(value !== '')
  const area = useRef<HTMLTextAreaElement>(null)
  const custom = on || value !== ''
  const insert = (ph: string) => {
    const el = area.current
    if (!el) { onChange(value + ph); return }
    const a = el.selectionStart ?? value.length
    const b = el.selectionEnd ?? value.length
    onChange(value.slice(0, a) + ph + value.slice(b))
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + ph.length, a + ph.length) })
  }
  return (
    <div className="space-y-2.5 rounded-lg border border-line p-3.5">
      <ToggleRow
        label={t('set.prompt_use_custom', { name: title })}
        hint={custom ? hint : t('set.prompt_builtin_in_use')}
        checked={custom}
        disabled={defaults == null && !custom}
        onChange={(v) => {
          setOn(v)
          onChange(v ? (value || defaults || '') : '')
        }}
      />
      {custom && (
        <>
          <Textarea
            ref={area}
            id={`prompt-${k}`}
            aria-label={title}
            rows={12}
            className="font-mono text-[13px] leading-5"
            value={value}
            spellCheck={false}
            invalid={!!error}
            onChange={(e) => onChange(e.target.value)}
          />
          {error && <p className="text-xs text-danger" role="alert">{error}</p>}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted">{t('set.prompt_vars')}</span>
            {placeholders.map((ph) => (
              <button key={ph} type="button" onClick={() => insert(ph)} className="rounded border border-line bg-subtle px-1.5 py-0.5 font-mono text-xs hover:bg-hover">{ph}</button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} disabled={defaults == null || value === defaults} onClick={() => onChange(defaults ?? '')}>{t('set.prompt_reset')}</Button>
            <span className="text-xs text-muted">{t('set.prompt_empty_hint')}</span>
          </div>
        </>
      )}
    </div>
  )
}

/** Three prompt templates. Off = saved as "" (built-in template); on = editable text seeded from the built-in one. */
export function PromptsEditor({ prompts, onChange, errors }: { prompts: Settings['llm']['prompts']; onChange: (key: PromptKey, v: string) => void; errors: Record<string, string> }) {
  const t = useT()
  const defaults = useQuery({ queryKey: qk.defaults, queryFn: () => api.get<Defaults>('/settings/defaults'), staleTime: 300_000 })
  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-medium">{t('set.prompts')}</h4>
        <p className="text-xs text-muted">{t('set.prompts_hint')}</p>
      </div>
      {defaults.isLoading && <Skeleton className="h-24 rounded-lg" />}
      {defaults.isError && <p className="text-xs text-warn">{t('set.prompts_defaults_failed')}</p>}
      {KEYS.map((x) => (
        <PromptRow
          key={x.key}
          k={x.key}
          title={t(x.title)}
          hint={t(x.hint)}
          value={prompts[x.key]}
          defaults={defaults.data?.prompts[x.key]}
          placeholders={defaults.data?.placeholders ?? []}
          onChange={(v) => onChange(x.key, v)}
          error={errors[`prompts.${x.key}`]}
        />
      ))}
    </div>
  )
}
