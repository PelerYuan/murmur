import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/cn'
import { useIsMobile } from '../../hooks/useMedia'
import { Overlay } from './Overlay'

type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

export function Popover({ open, onClose, anchor, placement = 'bottom-start', children, className, matchWidth, role = 'dialog', label }: {
  open: boolean; onClose: () => void; anchor: HTMLElement | null; placement?: Placement; children: ReactNode; className?: string
  matchWidth?: boolean; role?: string; label?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; minWidth?: number } | null>(null)

  const place = useCallback(() => {
    if (!anchor || !ref.current) return
    const a = anchor.getBoundingClientRect()
    const p = ref.current.getBoundingClientRect()
    const vw = window.innerWidth, vh = window.innerHeight
    const wantTop = placement.startsWith('top')
    const spaceBelow = vh - a.bottom, spaceAbove = a.top
    const top = (wantTop ? spaceAbove > p.height + 8 || spaceAbove > spaceBelow : !(spaceBelow > p.height + 8 || spaceBelow >= spaceAbove))
      ? Math.max(8, a.top - p.height - 6)
      : Math.min(vh - p.height - 8, a.bottom + 6)
    let left = placement.endsWith('end') ? a.right - p.width : a.left
    left = Math.max(8, Math.min(left, vw - p.width - 8))
    setPos({ top, left, minWidth: matchWidth ? a.width : undefined })
  }, [anchor, placement, matchWidth])

  useLayoutEffect(() => { if (open) place() }, [open, place, children])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node
      if (ref.current?.contains(n) || anchor?.contains(n)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchor, onClose, place])

  if (!open) return null
  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, minWidth: pos?.minWidth, visibility: pos ? 'visible' : 'hidden' }}
      className={cn('z-[75] max-h-[70vh] overflow-auto rounded-xl bg-surface shadow-pop animate-pop-in', className)}
    >
      {children}
    </div>,
    document.body,
  )
}

export interface MenuItem {
  label: ReactNode
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** Draw a divider above this item. */
  divider?: boolean
  hidden?: boolean
}

/** Dropdown menu on desktop, bottom action sheet on phones. */
export function Menu({ trigger, items, label, placement = 'bottom-end', className, title }: {
  trigger: ReactElement; items: MenuItem[]; label: string; placement?: Placement; className?: string; title?: string
}) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const mobile = useIsMobile()
  const list = items.filter((i) => !i.hidden)
  const close = useCallback(() => setOpen(false), [])
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open && !mobile) requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[role=menuitem]:not([disabled])')?.focus())
  }, [open, mobile])

  const onKey = (e: React.KeyboardEvent) => {
    const els = [...(listRef.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled])') ?? [])]
    const i = els.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); els[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); els[els.length - 1]?.focus() }
    else if (e.key === 'Tab') close()
  }

  const content = list.map((it, idx) => (
    <div key={idx}>
      {it.divider && idx > 0 && <div className="my-1 h-px bg-line" role="separator" />}
      <button
        role="menuitem"
        type="button"
        disabled={it.disabled}
        onClick={() => { close(); it.onSelect() }}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13.5px] transition-colors focus:outline-none disabled:opacity-40 max-sm:py-3 max-sm:text-[15px]',
          it.danger ? 'text-danger hover:bg-danger-soft focus:bg-danger-soft' : 'hover:bg-hover focus:bg-hover',
        )}
      >
        {it.icon && <span className="shrink-0 text-muted [&>svg]:h-4 [&>svg]:w-4">{it.icon}</span>}
        <span className="min-w-0 flex-1">{it.label}</span>
      </button>
    </div>
  ))

  return (
    <>
      <span
        ref={setAnchor}
        className={cn('inline-flex', className)}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
      >
        {trigger}
      </span>
      {mobile ? (
        <Overlay open={open} onClose={close} title={label} size="sm" className="[&>div:nth-child(2)]:px-3">
          <div role="menu" aria-label={label} className="-mx-1">{content}</div>
        </Overlay>
      ) : (
        <Popover open={open} onClose={close} anchor={anchor} placement={placement} role="presentation" className="min-w-[180px] p-1">
          <div ref={listRef} role="menu" aria-label={label} onKeyDown={onKey}>{content}</div>
        </Popover>
      )}
    </>
  )
}

export function Tooltip({ text, children, side = 'top' }: { text: ReactNode; children: ReactElement; side?: 'top' | 'bottom' }) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const show = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), 350) }
  const hide = () => { clearTimeout(timer.current); setOpen(false) }
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <>
      <span ref={setAnchor} className="inline-flex" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
        {children}
      </span>
      {open && anchor && (
        <TipBubble anchor={anchor} side={side}>{text}</TipBubble>
      )}
    </>
  )
}

function TipBubble({ anchor, side, children }: { anchor: HTMLElement; side: 'top' | 'bottom'; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect()
    const p = ref.current!.getBoundingClientRect()
    let top = side === 'top' ? a.top - p.height - 6 : a.bottom + 6
    if (top < 4) top = a.bottom + 6
    const left = Math.max(6, Math.min(a.left + a.width / 2 - p.width / 2, window.innerWidth - p.width - 6))
    setPos({ top, left })
  }, [anchor, side, children])
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      className="pointer-events-none z-[90] max-w-[260px] rounded-md bg-fg px-2 py-1 text-xs leading-4 text-bg shadow-pop"
    >
      {children}
    </div>,
    document.body,
  )
}
