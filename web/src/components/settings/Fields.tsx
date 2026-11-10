import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { Button } from '../ui/Button'
import { Field, Input, Slider, Switch } from '../ui/Form'
import { Popover } from '../ui/Popover'
import { Banner } from '../ui/Misc'
import { allTimezones, browserTz } from '../../lib/time'
import { cn } from '../../lib/cn'
import { useT } from '../../i18n'

export function NumberField({ label, hint, value, onChange, error, suffix, min, max, step = 1, className }: {
  label: ReactNode; hint?: ReactNode; value: number; onChange: (v: number) => void; error?: string; suffix?: string; min?: number; max?: number; step?: number; className?: string
}) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      <Input
        type="number"
        inputMode="decimal"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        suffix={suffix}
        invalid={!!error}
        onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
      />
    </Field>
  )
}

export function SliderField({ label, hint, value, onChange, error, min, max, step, className }: {
  label: string; hint?: ReactNode; value: number; onChange: (v: number) => void; error?: string; min: number; max: number; step: number; className?: string
}) {
  const shown = Number.isFinite(value) ? value : ''
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      <div className="flex items-center gap-3">
        <Slider value={Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min} min={min} max={max} step={step} label={label} onChange={onChange} className="flex-1" />
        <Input
          type="number"
          inputMode="decimal"
          className="w-24 shrink-0"
          aria-label={label}
          value={shown}
          min={min}
          max={max}
          step={step}
          invalid={!!error}
          onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
        />
      </div>
    </Field>
  )
}

export function ToggleRow({ label, hint, checked, onChange, disabled }: { label: ReactNode; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const text = typeof label === 'string' ? label : ''
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-5 text-muted">{hint}</p>}
      </div>
      <Switch checked={checked} onChange={onChange} label={text} disabled={disabled} />
    </div>
  )
}

/**
 * API keys come back from the server as "***" when set. Show "set" + Replace; only a typed value replaces it,
 * an empty replacement keeps the key ("***" is sent), and Clear removes it.
 */
export function SecretField({ label, hint, value, onChange, error, placeholder }: {
  label: string; hint?: ReactNode; value: string; onChange: (v: string) => void; error?: string; placeholder?: string
}) {
  const t = useT()
  const isSet = value === '***'
  const [replacing, setReplacing] = useState(false)
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (replacing) inputRef.current?.focus() }, [replacing])
  // The saved value changed under us (save succeeded): leave replace mode.
  useEffect(() => { if (value === '***') { setReplacing(false); setText('') } }, [value])

  if (isSet && !replacing) {
    return (
      <Field label={label} hint={hint} error={error}>
        <div className="flex items-center gap-2">
          <span className="inline-flex h-9 flex-1 items-center rounded-lg border border-line bg-subtle px-3 text-sm text-muted max-sm:h-11">
            <span aria-hidden className="mr-2 tracking-widest">●●●●●●</span>{t('set.secret_set')}
          </span>
          <Button onClick={() => setReplacing(true)}>{t('set.secret_replace')}</Button>
          <Button variant="ghost" onClick={() => onChange('')}>{t('set.secret_clear')}</Button>
        </div>
      </Field>
    )
  }
  const showing = replacing ? text : value
  return (
    <Field label={label} hint={hint} error={error}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            ref={inputRef}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={showing}
            placeholder={placeholder ?? t('set.secret_placeholder')}
            invalid={!!error}
            onChange={(e) => {
              if (replacing) { setText(e.target.value); onChange(e.target.value === '' ? '***' : e.target.value) } else onChange(e.target.value)
            }}
          />
        </div>
        {replacing && <Button variant="ghost" onClick={() => { setReplacing(false); setText(''); onChange('***') }}>{t('set.secret_cancel')}</Button>}
      </div>
    </Field>
  )
}

export function Section({ title, hint, children, className }: { title?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl border border-line bg-surface p-4 shadow-card sm:p-5', className)}>
      {title && <h3 className="text-[15px] font-semibold">{title}</h3>}
      {hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}
      <div className={cn('space-y-4', title && 'mt-4')}>{children}</div>
    </section>
  )
}

export function SaveBar({ dirty, saving, onSave, onDiscard, error, disabled }: {
  dirty: boolean; saving: boolean; onSave: () => void; onDiscard: () => void; error?: string; disabled?: boolean
}) {
  const t = useT()
  if (!dirty && !error) return null
  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-6 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 max-sm:pb-[calc(0.75rem+env(safe-area-inset-bottom))]" role="region" aria-label={t('set.save_bar')}>
      {error && <p role="alert" className="mb-2 text-[13px] text-danger">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={onSave} loading={saving} disabled={!dirty || disabled}>{t('common.save')}</Button>
        <Button variant="ghost" onClick={onDiscard} disabled={saving || !dirty}>{t('set.discard')}</Button>
        {dirty && <span className="text-[13px] text-muted">{t('set.unsaved')}</span>}
      </div>
    </div>
  )
}

export function TimezonePicker({ value, onChange, error }: { value: string; onChange: (tz: string) => void; error?: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const all = useMemo(() => allTimezones(), [])
  const list = useMemo(() => {
    const n = q.trim().toLowerCase().replace(/\s+/g, '_')
    return (n ? all.filter((z) => z.toLowerCase().includes(n)) : all).slice(0, 300)
  }, [all, q])
  useEffect(() => { setActive(0) }, [q, open])
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => { listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active])
  const pick = (z: string) => { onChange(z); setOpen(false); setQ('') }
  const known = all.includes(value)
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        id="tz-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn('flex h-9 w-full items-center justify-between rounded-lg border bg-surface px-3 text-left text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 max-sm:h-11', error ? 'border-danger' : 'border-line-strong')}
      >
        <span className="truncate">{value || t('set.tz_pick')}{!known && value ? ` · ${t('set.tz_unknown')}` : ''}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} matchWidth className="p-2" label={t('set.tz')}>
        <div className="mb-2">
          <Input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls="tz-list"
            aria-label={t('set.tz_search')}
            placeholder={t('set.tz_search')}
            leading={<Search className="h-4 w-4" />}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(list.length - 1, a + 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
              else if (e.key === 'Enter' && list[active]) { e.preventDefault(); pick(list[active]) }
            }}
          />
        </div>
        <ul ref={listRef} id="tz-list" role="listbox" aria-label={t('set.tz')} className="max-h-64 overflow-y-auto">
          {list.length === 0 && <li className="px-2 py-3 text-center text-[13px] text-muted">{t('set.tz_none')}</li>}
          {list.map((z, i) => (
            <li
              key={z}
              role="option"
              aria-selected={z === value}
              data-active={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(z)}
              className={cn('flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-sm max-sm:py-2.5', i === active && 'bg-hover')}
            >
              <span className="truncate">{z}</span>
              {z === value && <Check className="h-4 w-4 text-accent" />}
            </li>
          ))}
        </ul>
      </Popover>
    </>
  )
}

export function TimezoneMismatch({ selected, onUseBrowser }: { selected: string; onUseBrowser: () => void }) {
  const t = useT()
  const b = browserTz()
  if (!selected || b === selected) return null
  return (
    <Banner tone="info" className="mt-2" action={<Button size="sm" onClick={onUseBrowser}>{t('set.tz_use_browser')}</Button>}>
      {t('set.tz_mismatch', { browser: b, server: selected })}
    </Banner>
  )
}
