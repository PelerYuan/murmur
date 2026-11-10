import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, KeyRound, Loader2 } from 'lucide-react'
import { Button } from '../ui/Button'
import { Field, Input, Select } from '../ui/Form'
import { Banner } from '../ui/Misc'
import { TokenPanel } from '../recorders/TokenPanel'
import { StepFooter, type StepProps } from './StepFooter'
import { useCreateRecorder, useRotateToken } from '../../hooks/useRecorderActions'
import { useRecorders, useRooms } from '../../hooks/useData'
import { useNow } from '../../hooks/useNow'
import { useEvent } from '../../lib/events'
import { ApiError, NetworkError } from '../../lib/api'
import { waitedSeconds } from '../../lib/onboarding'
import { useT } from '../../i18n'

export interface TokenState { recorderId: number; token: string; saved: boolean }
const TROUBLE_AFTER_S = 120

/** Troubleshooting list shown when the recorder has not come online after two minutes. */
function Troubleshoot() {
  const t = useT()
  const origin = window.location.origin
  const port = window.location.port || '8000'
  return (
    <Banner tone="warn" title={t('onb.rec_trouble_title')}>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        <li>{t('onb.rec_trouble_addr', { url: `${origin}/healthz` })}</li>
        <li>{t('onb.rec_trouble_token')}</li>
        <li>{t('onb.rec_trouble_fw', { port })}</li>
        <li>{t('onb.rec_trouble_logs')} <code className="rounded bg-subtle px-1 font-mono text-xs">docker logs murmur-recorder</code></li>
      </ul>
    </Banner>
  )
}

export default function StepRecorder({ go, tok, setTok }: StepProps & { tok: TokenState | null; setTok: (t: TokenState | null) => void }) {
  const t = useT()
  const recs = useRecorders(3000)
  const rooms = useRooms()
  const create = useCreateRecorder()
  const rotate = useRotateToken()
  const list = recs.data ?? []
  const recorder = (tok && list.find((r) => r.id === tok.recorderId)) ?? list[0]
  const [roomId, setRoomId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const touched = useRef(false)
  const [err, setErr] = useState<string | null>(null)
  const [rotErr, setRotErr] = useState<string | null>(null)
  const startedAt = useRef(Date.now())
  const now = useNow(5000)
  const [, force] = useState(0)

  // SSE recorder.status is applied by LiveSync; polling above is the fallback.
  useEvent('recorder.status', () => force((n) => n + 1))

  // Default to the newest room and a "{room}麦克风" name until the user edits the name.
  useEffect(() => {
    const rs = rooms.data ?? []
    if (roomId == null && rs.length) setRoomId(rs[rs.length - 1].id)
  }, [rooms.data, roomId])
  useEffect(() => {
    if (touched.current) return
    const r = rooms.data?.find((x) => x.id === roomId)
    setName(r ? t('rec.name_default', { room: r.name }) : t('rec.name_default_plain'))
  }, [roomId, rooms.data, t])

  const submit = async () => {
    if (!name.trim()) { setErr(t('rec.name_required')); return }
    setErr(null)
    try {
      const r = await create.mutateAsync({ name: name.trim(), room_id: roomId })
      startedAt.current = Date.now()
      setTok({ recorderId: r.id, token: r.token ?? '', saved: false })
    } catch (e) {
      setErr(e instanceof NetworkError ? t('onb.core_unreachable') : e instanceof ApiError ? e.detail : String(e))
    }
  }
  const regenerate = async () => {
    if (!recorder) return
    setRotErr(null)
    try {
      const r = await rotate.mutateAsync(recorder.id)
      startedAt.current = Date.now()
      setTok({ recorderId: recorder.id, token: r.token, saved: false })
    } catch (e) {
      setRotErr(e instanceof ApiError ? e.detail : t('onb.core_unreachable'))
    }
  }

  const online = !!recorder?.online
  const seen = !!recorder?.last_seen
  const waited = waitedSeconds(startedAt.current, now)
  const canNext = !!recorder && (online || seen || !!tok?.saved)

  return (
    <div className="space-y-5">
      {!recorder && (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <p className="text-sm text-muted">{t('rec.empty_body')}</p>
          <Field label={t('rec.room')}>
            <Select value={roomId ?? ''} onChange={(e) => setRoomId(e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">{t('rec.room_none')}</option>
              {rooms.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          </Field>
          <Field label={t('rec.name')} error={err ?? undefined}>
            <Input value={name} onChange={(e) => { touched.current = true; setName(e.target.value); setErr(null) }} maxLength={60} invalid={!!err} />
          </Field>
          <Button type="submit" variant="primary" loading={create.isPending}>{t('rec.create')}</Button>
        </form>
      )}

      {recorder && tok && tok.recorderId === recorder.id && (
        <TokenPanel token={tok.token} saved={tok.saved} onSaved={(v) => setTok({ ...tok, saved: v })} />
      )}

      {recorder && !(tok && tok.recorderId === recorder.id) && (
        <div className="space-y-3 rounded-lg border border-line bg-subtle/50 p-4">
          <p className="text-sm"><span className="font-medium">{recorder.name}</span> · {t('onb.rec_exists')}</p>
          <p className="text-[13px] text-muted">{t('onb.rec_token_lost')}</p>
          {rotErr && <p role="alert" className="text-[13px] text-danger">{rotErr}</p>}
          <Button icon={<KeyRound className="h-4 w-4" />} loading={rotate.isPending} onClick={() => void regenerate()}>{t('onb.rec_regen')}</Button>
        </div>
      )}

      {recorder && (
        <div className="space-y-3" aria-live="polite">
          {online ? (
            <p className="flex items-center gap-2 text-sm font-medium text-ok"><CheckCircle2 className="h-4 w-4" />{t('onb.rec_online', { v: recorder.version ?? '?' })}</p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />{seen ? t('onb.rec_offline_seen') : t('onb.rec_waiting')}</p>
          )}
          {!online && waited >= TROUBLE_AFTER_S && <Troubleshoot />}
        </div>
      )}
      {recs.isError && !recorder && <p role="alert" className="text-[13px] text-danger">{t('onb.core_unreachable')}</p>}
      <StepFooter step={3} go={go} canNext={canNext} onNext={() => go(4)} />
    </div>
  )
}
