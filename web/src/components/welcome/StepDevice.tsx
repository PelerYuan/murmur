import { useEffect, useState } from 'react'
import { Field, Select } from '../ui/Form'
import { Banner } from '../ui/Misc'
import { RecorderConfigForm } from '../recorders/RecorderConfigForm'
import { VolumeBar } from '../recorders/VolumeBar'
import { StepFooter, type StepProps } from './StepFooter'
import { useRecorders } from '../../hooks/useData'
import { useT } from '../../i18n'

export default function StepDevice({ go }: StepProps) {
  const t = useT()
  const recs = useRecorders(3000)
  const list = recs.data ?? []
  const [id, setId] = useState<number | null>(null)
  useEffect(() => { if (id == null && list.length) setId((list.find((r) => r.online) ?? list[0]).id) }, [list, id])
  const r = list.find((x) => x.id === id) ?? list[0]
  if (!r) return <div><p className="text-sm text-muted">{t('rec.empty')}</p><StepFooter step={4} go={go} canNext={false} onNext={() => go(5)} /></div>
  const state = !r.online ? t('status.recorder_offline') : !r.config.enabled ? t('rec.paused_manual') : r.status.state === 'error' ? t('status.recorder_state_error') : t('rec.recording_on')
  return (
    <div className="space-y-5">
      {list.length > 1 && (
        <Field label={t('onb.dev_which')}>
          <Select value={r.id} onChange={(e) => setId(Number(e.target.value))}>{list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        </Field>
      )}
      {!r.online && <Banner tone="warn">{t('onb.dev_offline')}</Banner>}
      {r.online && r.devices.length === 0 && <Banner tone="danger">{t('onb.dev_none')}</Banner>}
      {r.status.state === 'error' && r.status.error && <Banner tone="danger">{t('rec.state_error', { e: r.status.error })}</Banner>}
      <RecorderConfigForm recorder={r} idPrefix="onb" minimal />
      <div>
        <div className="mb-1.5 flex items-center justify-between text-[13px]">
          <span className="font-medium">{t('rec.volume')}</span>
          <span className="text-muted">{state}</span>
        </div>
        <VolumeBar db={r.status.level_db} offline={!r.online} />
        <p className="mt-1 text-[11px] text-faint">{t('rec.volume_refresh')}</p>
        <p className="mt-2 text-[13px] text-muted">{t('onb.dev_tip')}</p>
      </div>
      <StepFooter step={4} go={go} canNext={r.online || !!r.last_seen} onNext={() => go(5)} />
    </div>
  )
}
