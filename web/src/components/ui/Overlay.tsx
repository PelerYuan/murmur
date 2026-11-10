import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { IconButton } from './Button'
import { useT } from '../../i18n'

// Shared machinery for Dialog (centred card / bottom sheet) and Drawer (right panel / bottom sheet).

const stack: symbol[] = []
let scrollLocks = 0

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

export interface OverlayProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  variant?: 'dialog' | 'drawer'
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** Phone: take the whole screen instead of a bottom sheet. */
  fullOnMobile?: boolean
  /** Block closing via Esc / backdrop (e.g. when a token must be saved first). */
  dismissable?: boolean
  initialFocus?: React.RefObject<HTMLElement>
  className?: string
}

const widths = { sm: 'sm:max-w-[400px]', md: 'sm:max-w-[500px]', lg: 'sm:max-w-[680px]', xl: 'sm:max-w-[900px]' }

export function Overlay({
  open, onClose, title, description, children, footer, variant = 'dialog', size = 'md', fullOnMobile, dismissable = true, initialFocus, className,
}: OverlayProps) {
  const t = useT()
  const panel = useRef<HTMLDivElement>(null)
  const idRef = useRef(Symbol('overlay'))
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const dismissRef = useRef(dismissable)
  dismissRef.current = dismissable
  const titleId = useRef(`ov-${Math.random().toString(36).slice(2)}`).current

  useEffect(() => {
    if (!open) return
    const id = idRef.current
    stack.push(id)
    const prev = document.activeElement as HTMLElement | null
    if (scrollLocks++ === 0) document.body.style.overflow = 'hidden'
    const raf = requestAnimationFrame(() => {
      const el = initialFocus?.current ?? panel.current?.querySelector<HTMLElement>('[data-autofocus],input:not([type=hidden]),textarea,select') ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE)
      ;(el ?? panel.current)?.focus()
    })
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return
      if (e.key === 'Escape') {
        if (dismissRef.current) {
          e.stopPropagation()
          closeRef.current()
        }
      } else if (e.key === 'Tab' && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement)
        if (items.length === 0) { e.preventDefault(); return }
        const first = items[0], last = items[items.length - 1]
        const active = document.activeElement
        if (e.shiftKey && (active === first || !panel.current.contains(active))) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && (active === last || !panel.current.contains(active))) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey, true)
      const i = stack.indexOf(id)
      if (i >= 0) stack.splice(i, 1)
      if (--scrollLocks === 0) document.body.style.overflow = ''
      if (prev && document.contains(prev)) prev.focus()
    }
  }, [open, initialFocus])

  if (!open) return null
  const drawer = variant === 'drawer'
  return createPortal(
    <div className="fixed inset-0 z-[70]" role="presentation">
      <div className="absolute inset-0 animate-fade-in bg-black/40 backdrop-blur-[1px]" onMouseDown={() => dismissable && onClose()} aria-hidden />
      <div
        className={cn(
          'pointer-events-none absolute inset-0 flex',
          drawer ? 'items-end justify-end sm:items-stretch' : 'items-end justify-center sm:items-center sm:p-6',
        )}
      >
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          tabIndex={-1}
          className={cn(
            'pointer-events-auto relative flex w-full flex-col overflow-hidden bg-surface shadow-pop outline-none',
            fullOnMobile ? 'h-[100dvh] max-sm:rounded-none' : 'max-h-[92dvh] rounded-t-2xl animate-sheet-in',
            drawer
              ? 'sm:h-full sm:max-h-none sm:max-w-[520px] sm:animate-drawer-in sm:rounded-none sm:border-l sm:border-line'
              : cn('sm:animate-pop-in sm:rounded-xl sm:max-h-[88vh]', widths[size]),
            className,
          )}
        >
          {(title || description) && (
            <div className="flex shrink-0 items-start gap-3 border-b border-line px-5 pb-3.5 pt-4 max-sm:pt-[max(1rem,env(safe-area-inset-top))]">
              <div className="min-w-0 flex-1">
                {title && <h2 id={titleId} className="text-[16px] font-semibold leading-6">{title}</h2>}
                {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
              </div>
              {dismissable && (
                <IconButton aria-label={t('common.close')} size="sm" onClick={onClose} className="-mr-1.5 -mt-0.5">
                  <X className="h-4 w-4" />
                </IconButton>
              )}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-5 py-3 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function Dialog(props: Omit<OverlayProps, 'variant'>) {
  return <Overlay {...props} variant="dialog" />
}
export function Drawer(props: Omit<OverlayProps, 'variant'>) {
  return <Overlay {...props} variant="drawer" />
}
