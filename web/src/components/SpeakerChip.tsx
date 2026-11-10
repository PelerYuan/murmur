import { cn } from '../lib/cn'
import type { Speaker } from '../lib/types'
import { useSpeakerLookup } from '../hooks/useData'

/** Colour comes from the API; it is used for the dot and a 12% tint only, text stays foreground colour. */
export function SpeakerDot({ color, className, dashed }: { color?: string | null; className?: string; dashed?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', dashed && 'ring-1 ring-inset ring-fg/25', className)}
      style={{ backgroundColor: color || 'rgb(var(--faint))', opacity: dashed ? 0.55 : 1 }}
    />
  )
}

export function tint(color?: string | null): string | undefined {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return undefined
  return `${color}1f` // ~12% alpha
}

export function SpeakerChip({ speakerId, fallbackName, onClick, className, size = 'md', muted }: {
  speakerId: number | null
  fallbackName?: string | null
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
  className?: string
  size?: 'sm' | 'md'
  muted?: boolean
}) {
  const { map, label } = useSpeakerLookup()
  const sp: Speaker | undefined = speakerId != null ? map.get(speakerId) : undefined
  const unknown = speakerId == null
  const unnamed = !unknown && (!sp || sp.state === 'unnamed' || !sp.name)
  const cls = cn(
    'inline-flex max-w-[11rem] items-center gap-1.5 rounded-full border px-2 align-middle transition-colors',
    size === 'sm' ? 'h-5 text-[11.5px]' : 'h-6 text-[12.5px]',
    unknown ? 'border-transparent bg-subtle text-muted' : unnamed ? 'border-dashed border-line-strong bg-transparent italic' : 'border-transparent',
    onClick && 'cursor-pointer hover:brightness-95 dark:hover:brightness-125',
    muted && 'opacity-60',
    className,
  )
  const inner = (
    <>
      {!unknown && <SpeakerDot color={sp?.color} dashed={unnamed} />}
      <span className="truncate">{label(speakerId, fallbackName)}</span>
    </>
  )
  const style = !unknown && !unnamed ? { backgroundColor: tint(sp?.color) } : undefined
  return onClick ? (
    <button type="button" onClick={onClick} className={cls} style={style}>{inner}</button>
  ) : (
    <span className={cls} style={style}>{inner}</span>
  )
}
