import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '../../lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost' | 'soft'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent/90 disabled:bg-accent/40',
  secondary: 'border border-line-strong bg-surface text-fg hover:bg-subtle disabled:text-faint',
  soft: 'bg-accent-soft text-accent hover:bg-accent/15 disabled:opacity-50',
  ghost: 'text-muted hover:bg-hover hover:text-fg disabled:text-faint disabled:hover:bg-transparent',
  danger: 'bg-danger text-white hover:bg-danger/90 disabled:bg-danger/40 dark:text-bg',
  'danger-ghost': 'text-danger hover:bg-danger-soft disabled:text-faint disabled:hover:bg-transparent',
}
const sizes: Record<Size, string> = {
  sm: 'h-8 gap-1.5 px-2.5 text-[13px]',
  md: 'h-9 gap-2 px-3.5 text-sm max-sm:h-10',
  lg: 'h-11 gap-2 px-5 text-[15px]',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  )
})

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  'aria-label': string
  size?: 'sm' | 'md'
  variant?: 'ghost' | 'secondary' | 'soft'
  active?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { size = 'md', variant = 'ghost', active, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      title={rest['aria-label']}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-40',
        size === 'sm' ? 'h-8 w-8 max-sm:h-10 max-sm:w-10' : 'h-9 w-9 max-sm:h-11 max-sm:w-11',
        variant === 'ghost' && 'text-muted hover:bg-hover hover:text-fg',
        variant === 'secondary' && 'border border-line-strong bg-surface text-muted hover:bg-subtle hover:text-fg',
        variant === 'soft' && 'bg-accent-soft text-accent hover:bg-accent/15',
        active && 'bg-hover text-fg',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})
