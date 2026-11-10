import { useEffect, useState } from 'react'
import { Dialog } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { Field, Input, Select } from '../ui/Form'
import { Banner } from '../ui/Misc'
import { ConfirmDialog } from '../ui/Confirm'
import { useToast } from '../ui/Toast'
import { TokenPanel } from './TokenPanel'
import { useCreateRecorder, useDeleteRecorder, usePatchRecorder, useRotateToken } from '../../hooks/useRecorderActions'
import { useRooms } from '../../hooks/useData'
import type { Recorder } from '../../lib/types'
import { useT } from '../../i18n'

/** Add a recorder: name + room, then the one-time token. Not dismissable until the token is acknowledged. */
export function AddRecorderDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (r: Recorder) => void }) {
  const t = useT()
  const toast = useToast()
  const rooms = useRooms()
  const create = useCreateRecorder()
  const [roomId, setRoomId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [created, setCreated] = useState<Recorder | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!open) return
    setCreated(null); setSaved(false); setErr(null); setTouched(false)
    const first = rooms.data?.[0]
    setRoomId(first?.id ?? null)
    setName(first ? t('rec.name_default', { room: first.name }) : t('rec.name_default_plain'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const pickRoom = (id: number | null) => {
    setRoomId(id)
    if (!touched) {
      const r = rooms.data?.find((x) => x.id === id)
      setName(r ? t('rec.name_default', { room: r.name }) : t('rec.name_default_plain'))
    }
  }

  const submit = async () => {
    if (!name.trim()) { setErr(t('rec.name_required')); return }
    try {
      const r = await create.mutateAsync({ name: name.trim(), room_id: roomId })
      setCreated(r)
      onCreated?.(r)
    } catch (e) { toast.error(e) }
  }

  if (created) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title={t('rec.created_title')}
        size="lg"
        dismissable={saved}
        footer={<Button variant="primary" onClick={onClose} disabled={!saved}>{t('rec.done')}</Button>}
      >
        <TokenPanel token={created.token ?? ''} saved={saved} onSaved={setSaved} />
      </Dialog>
    )
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('rec.add_title')}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={create.isPending} onClick={() => void submit()}>{t('rec.create')}</Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <Field label={t('rec.room')}>
          <Select value={roomId ?? ''} onChange={(e) => pickRoom(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">{t('rec.room_none')}</option>
            {rooms.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
        <Field label={t('rec.name')} error={err ?? undefined}>
          <Input value={name} onChange={(e) => { setName(e.target.value); setTouched(true); setErr(null) }} maxLength={60} autoFocus invalid={!!err} />
        </Field>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  )
}

export function RenameRecorderDialog({ recorder, onClose }: { recorder: Recorder | null; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const patch = usePatchRecorder()
  const [name, setName] = useState('')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { if (recorder) { setName(recorder.name); setErr(null) } }, [recorder])
  const submit = async () => {
    if (!recorder) return
    if (!name.trim()) { setErr(t('rec.name_required')); return }
    if (name.trim() === recorder.name) { onClose(); return }
    try { await patch.mutateAsync({ id: recorder.id, body: { name: name.trim() } }); onClose() } catch (e) { toast.error(e) }
  }
  return (
    <Dialog
      open={!!recorder}
      onClose={onClose}
      title={t('rec.rename_title')}
      size="sm"
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={patch.isPending} onClick={() => void submit()}>{t('common.save')}</Button></>}
    >
      <form onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <Field label={t('rec.name')} error={err ?? undefined}>
          <Input value={name} onChange={(e) => { setName(e.target.value); setErr(null) }} maxLength={60} autoFocus invalid={!!err} />
        </Field>
      </form>
    </Dialog>
  )
}

/** Rotate flow: confirm, then show the new token once. */
export function RotateTokenDialogs({ recorder, onClose }: { recorder: Recorder | null; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const rotate = useRotateToken()
  const [token, setToken] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => { if (recorder) { setToken(null); setSaved(false) } }, [recorder])
  if (!recorder) return null
  if (token) {
    return (
      <Dialog open onClose={onClose} title={t('rec.rotated_title')} size="lg" dismissable={saved} footer={<Button variant="primary" onClick={onClose} disabled={!saved}>{t('rec.done')}</Button>}>
        <TokenPanel token={token} saved={saved} onSaved={setSaved} />
      </Dialog>
    )
  }
  return (
    <ConfirmDialog
      open
      danger
      title={t('rec.rotate_title')}
      body={<Banner tone="warn">{t('rec.rotate_body')}</Banner>}
      confirmLabel={t('rec.rotate_confirm')}
      busy={rotate.isPending}
      onClose={onClose}
      onConfirm={async () => {
        try { const r = await rotate.mutateAsync(recorder.id); setToken(r.token) } catch (e) { toast.error(e) }
      }}
    />
  )
}

export function DeleteRecorderDialog({ recorder, onClose }: { recorder: Recorder | null; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const del = useDeleteRecorder()
  return (
    <ConfirmDialog
      open={!!recorder}
      danger
      title={t('rec.delete_title', { name: recorder?.name ?? '' })}
      body={t('rec.delete_body')}
      typeToConfirm={recorder?.name}
      confirmLabel={t('common.delete')}
      busy={del.isPending}
      onClose={onClose}
      onConfirm={async () => {
        if (!recorder) return
        try { await del.mutateAsync(recorder.id); toast.success(t('rec.deleted')); onClose() } catch (e) { toast.error(e) }
      }}
    />
  )
}
