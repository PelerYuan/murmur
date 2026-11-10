import type { ReactNode } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react'
import { cn } from '../../lib/cn'

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info'

const badgeTone: Record<Tone, string> = {
  neutral: 'bg-subtle text-muted',
  accent: 'bg-accent-soft text-accent',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
}

export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11.5px] font-medium leading-4', badgeTone[tone], className)}>
      {children}
    </span>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden />
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin text-muted', className)} aria-hidden />
}

export function EmptyState({ icon, title, body, action, className, compact }: {
  icon?: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode; className?: string; compact?: boolean
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'px-4 py-8' : 'px-6 py-14', className)}>
      {icon && <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-subtle text-muted [&>svg]:h-5 [&>svg]:w-5">{icon}</div>}
      <p className="text-[15px] font-medium">{title}</p>
      {body && <p className="mt-1 max-w-md text-[13px] leading-6 text-muted">{body}</p>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  )
}

const bannerTone: Record<Exclude<Tone, 'neutral' | 'accent'>, { box: string; icon: ReactNode }> = {
  info: { box: 'border-info/25 bg-info-soft', icon: <Info className="h-4 w-4 text-info" /> },
  ok: { box: 'border-ok/25 bg-ok-soft', icon: <CheckCircle2 className="h-4 w-4 text-ok" /> },
  warn: { box: 'border-warn/30 bg-warn-soft', icon: <AlertTriangle className="h-4 w-4 text-warn" /> },
  danger: { box: 'border-danger/30 bg-danger-soft', icon: <AlertCircle className="h-4 w-4 text-danger" /> },
}

export function Banner({ tone = 'info', title, children, action, className, role }: {
  tone?: Exclude<Tone, 'neutral' | 'accent'>; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string; role?: string
}) {
  const b = bannerTone[tone]
  return (
    <div role={role ?? (tone === 'danger' ? 'alert' : undefined)} className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[13px] leading-5 max-sm:flex-wrap', b.box, className)}>
      <span className="mt-0.5 shrink-0">{b.icon}</span>
      <div className={cn("min-w-0 flex-1", action && "max-sm:basis-[calc(100%-26px)]")}>
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5', 'text-fg/80')}>{children}</div>}
      </div>
      {action && <div className="shrink-0 max-sm:w-full max-sm:pl-[26px]">{action}</div>}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex min-w-[20px] items-center justify-center rounded border border-line-strong bg-subtle px-1.5 py-0.5 text-[11px] leading-none text-muted">{children}</kbd>
}

export function Tabs<T extends string>({ value, onChange, items, label, className }: {
  value: T; onChange: (v: T) => void; label: string; className?: string
  items: { value: T; label: ReactNode; count?: number | null }[]
}) {
  return (
    <div role="tablist" aria-label={label} className={cn('no-scrollbar flex gap-1 overflow-x-auto', className)}>
      {items.map((it) => {
        const active = it.value === value
        return (
          <button
            key={it.value}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(it.value)}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors max-sm:h-10',
              active ? 'bg-fg text-bg' : 'text-muted hover:bg-hover hover:text-fg',
            )}
          >
            {it.label}
            {it.count != null && it.count > 0 && (
              <span className={cn('tabular rounded-full px-1.5 text-[11px] leading-[18px]', active ? 'bg-bg/20' : 'bg-subtle')}>{it.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function ProgressBar({ value, max = 100, tone = 'accent', className, label }: { value: number; max?: number; tone?: 'accent' | 'ok' | 'warn' | 'danger'; className?: string; label?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  const color = { accent: 'bg-accent', ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger' }[tone]
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.round(value)} className={cn('h-1.5 overflow-hidden rounded-full bg-subtle', className)}>
      <div className={cn('h-full rounded-full transition-[width] duration-300', color)} style={{ width: `${pct}%` }} />
    </div>
  )
}

export function StatusDot({ tone, pulse, className }: { tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info'; pulse?: boolean; className?: string }) {
  const c = { ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger', neutral: 'bg-faint', info: 'bg-info' }[tone]
  return <span aria-hidden className={cn('inline-block h-2 w-2 shrink-0 rounded-full', c, pulse && 'animate-pulse-dot', className)} />
}

export function SectionTitle({ children, aside, className }: { children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted">{children}</h2>
      {aside}
    </div>
  )
}

export function ErrorBar({ message, onRetry, retryLabel, className }: { message: ReactNode; onRetry?: () => void; retryLabel: string; className?: string }) {
  return (
    <Banner tone="danger" className={className} action={onRetry && <button onClick={onRetry} className="rounded-md px-2 py-1 text-[13px] font-medium text-danger hover:bg-danger/10">{retryLabel}</button>}>
      {message}
    </Banner>
  )
}
