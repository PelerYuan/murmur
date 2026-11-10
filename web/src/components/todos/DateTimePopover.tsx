import { useEffect, useState } from 'react'
import { Popover } from '../ui/Popover'
import { Button } from '../ui/Button'
import { Input } from '../ui/Form'
import { fromLocalInput, toLocalInput } from '../../lib/time'
import { useFmt } from '../../hooks/useData'
import { useT } from '../../i18n'

/** Small date-time chooser (server timezone) with a "clear" action. */
export function DateTimePopover({ open, anchor, onClose, value, onSave, label }: {
  open: boolean; anchor: HTMLElement | null; onClose: () => void; value: string | null; onSave: (iso: string | null) => void; label: string
}) {
  const t = useT()
  const fmt = useFmt()
  const [v, setV] = useState('')
  useEffect(() => { if (open) setV(toLocalInput(value, fmt.tz)) }, [open, value, fmt.tz])
  const save = () => { const iso = v ? fromLocalInput(v, fmt.tz) : null; if (v && !iso) return; onSave(iso); onClose() }
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} label={label} className="border border-line">
      <form className="w-[260px] space-y-3 p-3" onSubmit={(e) => { e.preventDefault(); save() }}>
        <label className="block text-[13px] font-medium">
          {label}
          <Input type="datetime-local" className="mt-1.5" value={v} onChange={(e) => setV(e.target.value)} autoFocus />
        </label>
        <p className="text-xs text-muted">{t('todos.f_tz_hint', { tz: fmt.tz })}</p>
        <div className="flex justify-between gap-2">
          <Button size="sm" variant="ghost" onClick={() => { onSave(null); onClose() }} disabled={!value}>{t('common.clear')}</Button>
          <div className="flex gap-2">
            <Button size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="sm" variant="primary" type="submit">{t('common.save')}</Button>
          </div>
        </div>
      </form>
    </Popover>
  )
}
