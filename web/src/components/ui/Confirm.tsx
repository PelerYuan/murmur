import { useState, useEffect, type ReactNode } from 'react'
import { Dialog } from './Overlay'
import { Button } from './Button'
import { Input, Checkbox } from './Form'
import { useT } from '../../i18n'

interface Props {
  open: boolean
  title: ReactNode
  body?: ReactNode
  confirmLabel: string
  danger?: boolean
  /** Level-3 destructive actions: require typing this text … */
  typeToConfirm?: string
  /** … or ticking "I understand". */
  requireAck?: boolean
  busy?: boolean
  onConfirm: () => void | Promise<void>
  onClose: () => void
  extra?: ReactNode
}

export function ConfirmDialog({ open, title, body, confirmLabel, danger, typeToConfirm, requireAck, busy, onConfirm, onClose, extra }: Props) {
  const t = useT()
  const [typed, setTyped] = useState('')
  const [ack, setAck] = useState(false)
  useEffect(() => { if (open) { setTyped(''); setAck(false) } }, [open])
  const ok = (!typeToConfirm || typed.trim() === typeToConfirm) && (!requireAck || ack)
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={() => void onConfirm()} disabled={!ok} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted">
        {body && <div>{body}</div>}
        {extra}
        {typeToConfirm && (
          <div className="space-y-1.5">
            <label className="text-[13px] text-fg" htmlFor="confirm-type">{t('common.type_to_confirm', { name: typeToConfirm })}</label>
            <Input id="confirm-type" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" onKeyDown={(e) => { if (e.key === 'Enter' && ok) void onConfirm() }} />
          </div>
        )}
        {requireAck && <Checkbox checked={ack} onChange={setAck} label={t('common.i_understand')} />}
      </div>
    </Dialog>
  )
}
