import { useEffect, useMemo, useState } from 'react'
import { Dialog } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { Field, Input, Segmented, Select } from '../ui/Form'
import { Banner } from '../ui/Misc'
import { autoLevel, findOverwrite, presetRange, type RangePreset, type SummaryLike } from '../../lib/summaryRange'
import { fromLocalInput, toLocalInput } from '../../lib/time'
import type { SummaryLevel } from '../../lib/types'
import { useFmt, useRooms } from '../../hooks/useData'
import { useGenerateSummary } from '../../hooks/useSummaryActions'
import { useToast } from '../ui/Toast'
import { useT } from '../../i18n'

export interface GenerateInit { start?: string; end?: string; level?: SummaryLevel; room_id?: number | null }

export function GenerateSummaryDialog({ open, onClose, init, existing, onStarted }: {
  open: boolean; onClose: () => void; init?: GenerateInit; existing: SummaryLike[]; onStarted: (jobId: number) => void
}) {
  const t = useT()
  const fmt = useFmt()
  const toast = useToast()
  const rooms = useRooms()
  const gen = useGenerateSummary()
  const [preset, setPreset] = useState<RangePreset>('today')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [level, setLevel] = useState<'auto' | SummaryLevel>('auto')
  const [roomId, setRoomId] = useState<number | null>(null)

  useEffect(() => {
    if (!open) return
    if (init?.start && init.end) {
      setPreset('custom'); setStart(toLocalInput(init.start, fmt.tz)); setEnd(toLocalInput(init.end, fmt.tz))
      setLevel(init.level ?? 'auto'); setRoomId(init.room_id ?? null)
    } else {
      setPreset('today'); const r = presetRange('today', Date.now(), fmt.tz); setStart(toLocalInput(r.start, fmt.tz)); setEnd(toLocalInput(r.end, fmt.tz))
      setLevel('auto'); setRoomId(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const pick = (p: RangePreset) => {
    setPreset(p)
    if (p !== 'custom') { const r = presetRange(p, Date.now(), fmt.tz); setStart(toLocalInput(r.start, fmt.tz)); setEnd(toLocalInput(r.end, fmt.tz)) }
  }
  const s = fromLocalInput(start, fmt.tz), e = fromLocalInput(end, fmt.tz)
  const valid = !!s && !!e && Date.parse(e) > Date.parse(s)
  const auto = valid ? autoLevel(Date.parse(s!), Date.parse(e!)) : 'custom'
  const effLevel: SummaryLevel = level === 'auto' ? auto : level
  const overwrite = useMemo(() => (valid ? findOverwrite(existing, s!, e!, roomId) : undefined), [existing, valid, s, e, roomId])
  const levelName = (l: SummaryLevel) => t(`summaries.level_${l}` as 'summaries.level_daily')

  const submit = () => {
    if (!valid) return
    gen.mutate({ level: effLevel, start: s!, end: e!, room_id: roomId }, {
      onSuccess: (job) => { toast.success(t('summaries.gen_started')); onStarted(job.id); onClose() },
      onError: (err) => toast.error(err),
    })
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={init?.start ? t('summaries.gen_regen_title') : t('summaries.gen_title')}
      size="md"
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={!valid} loading={gen.isPending} onClick={submit}>{t('summaries.gen_submit')}</Button></>}
    >
      <div className="space-y-4">
        <Field label={t('summaries.gen_range')}>
          <Segmented
            value={preset}
            onChange={pick}
            label={t('summaries.gen_range')}
            options={(['today', 'yesterday', 'this_hour', 'last_hour', 'custom'] as RangePreset[]).map((p) => ({ value: p, label: t(`summaries.gen_preset_${p}` as 'summaries.gen_preset_today') }))}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('summaries.gen_start')}><Input type="datetime-local" value={start} onChange={(ev) => { setStart(ev.target.value); setPreset('custom') }} /></Field>
          <Field label={t('summaries.gen_end')} error={start && end && !valid ? t('summaries.gen_bad_range') : undefined}><Input type="datetime-local" value={end} onChange={(ev) => { setEnd(ev.target.value); setPreset('custom') }} /></Field>
        </div>
        <p className="-mt-2 text-xs text-muted">{t('summaries.gen_tz', { tz: fmt.tz })}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('summaries.gen_level')}>
            <Select value={level} onChange={(ev) => setLevel(ev.target.value as 'auto' | SummaryLevel)}>
              <option value="auto">{t('summaries.gen_level_auto', { level: levelName(auto) })}</option>
              {(['daily', 'hourly', 'custom'] as SummaryLevel[]).map((l) => <option key={l} value={l}>{levelName(l)}</option>)}
            </Select>
          </Field>
          <Field label={t('summaries.gen_room')}>
            <Select value={roomId ?? ''} onChange={(ev) => setRoomId(ev.target.value ? Number(ev.target.value) : null)}>
              <option value="">{t('summaries.all_rooms')}</option>
              {(rooms.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          </Field>
        </div>
        {overwrite && <Banner tone="danger" role="status">{t('summaries.gen_overwrite')}</Banner>}
      </div>
    </Dialog>
  )
}
