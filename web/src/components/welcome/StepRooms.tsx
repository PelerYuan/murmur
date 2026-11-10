import { Check } from 'lucide-react'
import { RoomAddForm } from '../recorders/RoomAddForm'
import { ErrorBar } from '../ui/Misc'
import { StepFooter, type StepProps } from './StepFooter'
import { useRooms } from '../../hooks/useData'
import { NetworkError } from '../../lib/api'
import { useT } from '../../i18n'

export default function StepRooms({ go }: StepProps) {
  const t = useT()
  const rooms = useRooms()
  const list = rooms.data ?? []
  return (
    <div>
      <p className="mb-4 text-sm text-muted">{t('rec.rooms_empty_body')}</p>
      {rooms.isError && (
        <ErrorBar className="mb-3" message={rooms.error instanceof NetworkError ? t('onb.core_unreachable') : t('onb.rooms_failed')} onRetry={() => void rooms.refetch()} retryLabel={t('common.retry')} />
      )}
      <RoomAddForm rooms={list} autoFocus={list.length === 0} />
      {list.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2" aria-label={t('rec.section_rooms')}>
          {list.map((r) => (
            <li key={r.id} className="inline-flex items-center gap-1.5 rounded-full border border-ok/30 bg-ok/10 px-3 py-1 text-sm">
              <Check className="h-3.5 w-3.5 text-ok" />{r.name}
            </li>
          ))}
        </ul>
      )}
      {list.length > 0 && <p className="mt-3 text-xs text-muted">{t('onb.rooms_more')}</p>}
      <StepFooter step={2} go={go} canNext={list.length > 0} onNext={() => go(3)} />
    </div>
  )
}
