import {
  createContext, forwardRef, useContext, useId,
  type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/cn'

interface FieldCtx { id: string; describedBy?: string; invalid?: boolean }
const FieldContext = createContext<FieldCtx | null>(null)

export function Field({ label, hint, error, children, className, optional }: {
  label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string; optional?: string
}) {
  const id = useId()
  const hintId = `${id}-d`
  return (
    <FieldContext.Provider value={{ id, describedBy: hint || error ? hintId : undefined, invalid: !!error }}>
      <div className={cn('space-y-1.5', className)}>
        {label && (
          <label htmlFor={id} className="flex items-baseline gap-1.5 text-[13px] font-medium text-fg">
            {label}
            {optional && <span className="text-xs font-normal text-faint">{optional}</span>}
          </label>
        )}
        {children}
        {(error || hint) && (
          <p id={hintId} className={cn('text-xs leading-5', error ? 'text-danger' : 'text-muted')} role={error ? 'alert' : undefined}>
            {error || hint}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  )
}

const control =
  'w-full rounded-lg border bg-surface px-3 text-sm text-fg placeholder:text-faint transition-colors disabled:cursor-not-allowed disabled:bg-subtle disabled:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean
  suffix?: ReactNode
  leading?: ReactNode
  inputClassName?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ invalid, className, suffix, leading, inputClassName, id, ...rest }, ref) {
  const f = useContext(FieldContext)
  const bad = invalid ?? f?.invalid
  return (
    <div className={cn('relative', className)}>
      {leading && <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-faint">{leading}</span>}
      <input
        ref={ref}
        id={id ?? f?.id}
        aria-describedby={f?.describedBy}
        aria-invalid={bad || undefined}
        className={cn(control, 'h-9 max-sm:h-11 max-sm:text-base', bad ? 'border-danger' : 'border-line-strong', leading && 'pl-9', suffix && 'pr-12', inputClassName)}
        {...rest}
      />
      {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted">{suffix}</span>}
    </div>
  )
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea(
  { invalid, className, id, ...rest }, ref,
) {
  const f = useContext(FieldContext)
  const bad = invalid ?? f?.invalid
  return (
    <textarea
      ref={ref}
      id={id ?? f?.id}
      aria-describedby={f?.describedBy}
      aria-invalid={bad || undefined}
      className={cn(control, 'min-h-[84px] py-2 leading-6 max-sm:text-base', bad ? 'border-danger' : 'border-line-strong', className)}
      {...rest}
    />
  )
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(function Select(
  { invalid, className, id, children, ...rest }, ref,
) {
  const f = useContext(FieldContext)
  const bad = invalid ?? f?.invalid
  return (
    <div className={cn('relative', className)}>
      <select
        ref={ref}
        id={id ?? f?.id}
        aria-describedby={f?.describedBy}
        aria-invalid={bad || undefined}
        className={cn(control, 'h-9 appearance-none pr-8 max-sm:h-11 max-sm:text-base', bad ? 'border-danger' : 'border-line-strong')}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
    </div>
  )
})

export function Switch({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  const f = useContext(FieldContext)
  return (
    <button
      type="button"
      role="switch"
      id={id ?? f?.id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-line-strong',
      )}
    >
      <span className={cn('inline-block h-[18px] w-[18px] rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-[2px]')} />
    </button>
  )
}

export function Checkbox({ checked, onChange, label, disabled, className, hideLabel, round }: {
  checked: boolean; onChange: (v: boolean, e?: React.MouseEvent) => void; label?: ReactNode; disabled?: boolean; className?: string; hideLabel?: string; round?: boolean
}) {
  return (
    <label className={cn('inline-flex cursor-pointer items-start gap-2.5 text-sm', disabled && 'cursor-not-allowed opacity-60', className)}>
      <span className="relative mt-[3px] inline-flex h-[18px] w-[18px] shrink-0 max-sm:mt-[2px]">
        <input
          type="checkbox"
          className="peer absolute inset-0 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
          checked={checked}
          disabled={disabled}
          aria-label={hideLabel}
          onChange={() => undefined}
          onClick={(e) => onChange(!checked, e as unknown as React.MouseEvent)}
        />
        <span className={cn(
          'pointer-events-none flex h-full w-full items-center justify-center border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface',
          round ? 'rounded-full' : 'rounded-[5px]',
          checked ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong bg-surface',
        )}>
          {checked && <Check className="h-3 w-3" strokeWidth={3} aria-hidden />}
        </span>
      </span>
      {label && <span className="leading-6">{label}</span>}
    </label>
  )
}

export function Segmented<T extends string | number>({ value, onChange, options, label, size = 'md', className }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; title?: string }[]; label: string; size?: 'sm' | 'md'; className?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-lg border border-line-strong bg-subtle p-0.5', className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md px-3 font-medium transition-colors',
            size === 'sm' ? 'h-7 text-xs' : 'h-8 text-[13px] max-sm:h-10',
            o.value === value ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Slider({ value, onChange, min, max, step = 1, label, className }: {
  value: number; onChange: (v: number) => void; min: number; max: number; step?: number; label: string; className?: string
}) {
  return (
    <input
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className={cn('h-6 w-full cursor-pointer', className)}
    />
  )
}
