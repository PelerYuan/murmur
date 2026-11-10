import { cn } from '../../lib/cn'
import { levelFraction } from '../../lib/recorderConfig'
import { useT } from '../../i18n'

/** -60..0 dB level bar; greyed when the recorder is offline. */
export function VolumeBar({ db, offline, className }: { db: number | null | undefined; offline?: boolean; className?: string }) {
  const t = useT()
  const f = offline ? 0 : levelFraction(db)
  const tone = f > 0.92 ? 'bg-danger' : f > 0.75 ? 'bg-warn' : 'bg-ok'
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <div
        role="meter"
        aria-label={t('rec.volume')}
        aria-valuemin={-60}
        aria-valuemax={0}
        aria-valuenow={offline || db == null ? undefined : Math.round(db)}
        aria-valuetext={offline || db == null ? t('rec.volume_offline') : `${Math.round(db)} dB`}
        className={cn('relative h-2.5 min-w-[96px] flex-1 overflow-hidden rounded-full bg-subtle', offline && 'opacity-50')}
      >
        <div className={cn('h-full rounded-full transition-[width] duration-700', offline ? 'bg-faint' : tone)} style={{ width: `${f * 100}%` }} />
        {/* -50 dB (quiet) and -30 dB (speech) reference ticks */}
        <span className="absolute inset-y-0 w-px bg-fg/20" style={{ left: `${(10 / 60) * 100}%` }} aria-hidden />
        <span className="absolute inset-y-0 w-px bg-fg/20" style={{ left: `${(30 / 60) * 100}%` }} aria-hidden />
      </div>
      <span className="tabular w-14 shrink-0 text-right text-xs text-muted">{offline || db == null ? '—' : `${Math.round(db)} dB`}</span>
    </div>
  )
}
