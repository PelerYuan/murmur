import { Field, Input, Select } from '../ui/Form'
import { NumberField, SecretField, SliderField } from './Fields'
import { cn } from '../../lib/cn'
import type { Settings } from '../../lib/types'
import { useT } from '../../i18n'

export interface FormLike<T> {
  draft: T
  set: (path: string, value: unknown) => void
  errors: Record<string, string>
}

export function AsrFields({ form, compact }: { form: FormLike<Settings['asr']>; compact?: boolean }) {
  const t = useT()
  const { draft: d, set, errors } = form
  const modes = [
    { value: 'murmur' as const, title: t('set.asr_mode_murmur'), body: t('set.asr_mode_murmur_hint') },
    { value: 'openai' as const, title: t('set.asr_mode_openai'), body: t('set.asr_mode_openai_hint') },
  ]
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-1.5 text-[13px] font-medium">{t('set.asr_mode')}</legend>
        <div role="radiogroup" aria-label={t('set.asr_mode')} className="grid gap-2 sm:grid-cols-2">
          {modes.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={d.mode === m.value}
              onClick={() => set('mode', m.value)}
              className={cn('rounded-lg border p-3 text-left transition-colors', d.mode === m.value ? 'border-accent bg-accent-soft' : 'border-line-strong hover:bg-hover')}
            >
              <span className="block text-sm font-medium">{m.title}</span>
              <span className="mt-0.5 block text-xs leading-5 text-muted">{m.body}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <Field label={t('set.asr_base_url')} hint={d.mode === 'murmur' ? t('set.asr_base_url_hint') : t('set.asr_base_url_hint_openai')} error={errors.base_url}>
        <Input value={d.base_url} onChange={(e) => set('base_url', e.target.value)} placeholder="http://localhost:8100" spellCheck={false} autoCapitalize="none" invalid={!!errors.base_url} />
      </Field>
      {d.mode === 'openai' && (
        <>
          <SecretField label={t('set.api_key')} value={d.api_key} onChange={(v) => set('api_key', v)} error={errors.api_key} />
          <Field label={t('set.model')} hint={t('set.asr_model_hint')} error={errors.model}>
            <Input value={d.model} onChange={(e) => set('model', e.target.value)} placeholder="whisper-1" spellCheck={false} autoCapitalize="none" invalid={!!errors.model} />
          </Field>
        </>
      )}
      <Field label={t('set.asr_language')} hint={t('set.asr_language_hint')} error={errors.language}>
        <Select value={d.language} onChange={(e) => set('language', e.target.value)}>
          <option value="auto">{t('set.lang_auto')}</option>
          <option value="zh">中文</option>
          <option value="en">English</option>
          <option value="ja">日本語</option>
          <option value="ko">한국어</option>
          <option value="yue">粤语</option>
        </Select>
      </Field>
      {!compact && (
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label={t('set.asr_timeout')} hint={t('set.asr_timeout_hint')} suffix="s" value={d.timeout_seconds} onChange={(v) => set('timeout_seconds', v)} error={errors.timeout_seconds} min={5} />
          <NumberField label={t('set.asr_concurrency')} hint={t('set.asr_concurrency_hint')} value={d.concurrency} onChange={(v) => set('concurrency', v)} error={errors.concurrency} min={1} />
        </div>
      )}
    </div>
  )
}

export function LlmFields({ form, compact }: { form: FormLike<Settings['llm']>; compact?: boolean }) {
  const t = useT()
  const { draft: d, set, errors } = form
  return (
    <div className="space-y-4">
      <Field label={t('set.llm_base_url')} hint={t('set.llm_base_url_hint')} error={errors.base_url}>
        <Input value={d.base_url} onChange={(e) => set('base_url', e.target.value)} placeholder="https://api.openai.com/v1" spellCheck={false} autoCapitalize="none" invalid={!!errors.base_url} />
      </Field>
      <SecretField label={t('set.api_key')} value={d.api_key} onChange={(v) => set('api_key', v)} error={errors.api_key} />
      <Field label={t('set.model')} hint={t('set.llm_model_hint')} error={errors.model}>
        <Input value={d.model} onChange={(e) => set('model', e.target.value)} placeholder="gpt-4o-mini" spellCheck={false} autoCapitalize="none" invalid={!!errors.model} />
      </Field>
      {!compact && (
        <>
          <SliderField label={t('set.llm_temperature')} hint={t('set.llm_temperature_hint')} min={0} max={2} step={0.1} value={d.temperature} onChange={(v) => set('temperature', v)} error={errors.temperature} />
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField label={t('set.llm_max_input')} hint={t('set.llm_max_input_hint')} value={d.max_input_chars} onChange={(v) => set('max_input_chars', v)} error={errors.max_input_chars} min={1000} step={1000} suffix={t('set.unit_chars')} />
            <NumberField label={t('set.asr_timeout')} hint={t('set.llm_timeout_hint')} suffix="s" value={d.timeout_seconds} onChange={(v) => set('timeout_seconds', v)} error={errors.timeout_seconds} min={5} />
          </div>
        </>
      )}
    </div>
  )
}
