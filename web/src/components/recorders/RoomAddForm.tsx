import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '../ui/Button'
import { Input } from '../ui/Form'
import { useToast } from '../ui/Toast'
import { useRoomActions } from '../../hooks/useRecorderActions'
import { ApiError } from '../../lib/api'
import type { Room } from '../../lib/types'
import { useT } from '../../i18n'

export function RoomAddForm({ rooms, autoFocus }: { rooms: Room[]; autoFocus?: boolean }) {
  const t = useT()
  const toast = useToast()
  const actions = useRoomActions()
  const [name, setName] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const add = async (raw: string) => {
    const v = raw.trim()
    if (!v) { setErr(t('rec.room_required')); return }
    if (rooms.some((x) => x.name === v)) { setErr(t('rec.room_dup')); return }
    try { await actions.create.mutateAsync(v); setName(''); setErr(null) } catch (e) {
      if (e instanceof ApiError && e.status === 409) setErr(t('rec.room_dup')); else toast.error(e)
    }
  }
  const quick = [t('rec.room_quick_living'), t('rec.room_quick_studio'), t('rec.room_quick_bedroom')].filter((q) => !rooms.some((x) => x.name === q))
  return (
    <div>
      <form className="flex items-start gap-2" onSubmit={(e) => { e.preventDefault(); void add(name) }}>
        <div className="min-w-0 flex-1">
          <Input aria-label={t('rec.room_add')} placeholder={t('rec.room_add_placeholder')} value={name} invalid={!!err} maxLength={40} autoFocus={autoFocus} onChange={(e) => { setName(e.target.value); setErr(null) }} />
          {err && <p className="mt-1 text-xs text-danger" role="alert">{err}</p>}
        </div>
        <Button type="submit" icon={<Plus className="h-4 w-4" />} loading={actions.create.isPending}>{t('rec.room_add')}</Button>
      </form>
      {quick.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>{t('rec.room_quick')}</span>
          {quick.map((q) => (
            <button key={q} type="button" className="rounded-full border border-line px-2.5 py-1 text-[13px] text-fg hover:bg-hover max-sm:py-1.5" onClick={() => void add(q)}>{q}</button>
          ))}
        </div>
      )}
    </div>
  )
}
