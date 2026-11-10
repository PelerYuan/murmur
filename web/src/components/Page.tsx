import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import { usePageTitle } from '../hooks/usePageTitle'

export function Page({ title, subtitle, actions, children, className, wide, docTitle }: {
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; wide?: boolean; docTitle?: string
}) {
  usePageTitle(docTitle ?? (typeof title === 'string' ? title : ''))
  return (
    <div className={cn('mx-auto w-full px-4 py-5 sm:px-6 sm:py-6', wide ? 'max-w-[1400px]' : 'max-w-6xl', className)}>
      {(title || actions) && (
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="truncate text-xl font-semibold tracking-tight">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  )
}
