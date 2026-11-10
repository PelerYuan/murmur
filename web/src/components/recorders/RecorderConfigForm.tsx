import { useEffect, useMemo, useState } from 'react'
import { Check, Loader2, WifiOff } from 'lucide-react'
import { Button } from '../ui/Button'
import { Field, Input, Segmented, Select, Slider } from '../ui/Form'
import { useToast } from '../ui/Toast'
import { ADV, GAIN, advError, applyStatus, configInvalid, diffConfig, type AdvKey } from '../../lib/recorderConfig'
import { usePatchRecorder } from '../../hooks/useRecorderActions'
import type { Recorder, RecorderConfig } from '../../lib/types'
import { cn } from '../../lib/cn'
import { useT, type TKey } from '../../i18n'

const ADV_LABEL: Record<AdvKey, TKey> = {
  min_speech_ms: 'rec.adv_min_speech',
  end_silence_ms: 'rec.adv_end_silence',
  max_chunk_seconds: 'rec.adv_max_chunk',
  pre_roll_ms: 'rec.adv_pre_roll',
}

/** Shown after saving: waiting for the next heartbeat, applied, or offline. */
export function ApplyStatusLine({ status }: { status: 'idle' | 'waiting' | 'applied' | 'offline' }) {
  const t = useT()
  if (status === 'idle') return null
  const map = {
    waiting: { icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />, text: t('rec.apply_waiting'), cls: 'text-muted' },
    applied: { icon: <Check className="h-3.5 w-3.5" />, text: t('rec.apply_done'), cls: 'text-ok' },
    offline: { icon: <WifiOff className="h-3.5 w-3.5" />, text: t('rec.apply_offline'), cls: 'text-warn' },
  }[status]
  return (
    <p role="status" className={cn('flex items-center gap-1.5 text-[13px]', map.cls)}>
      {map.icon}
      {map.text}
    </p>
  )
}

/**
 * Device / gain / VAD / advanced settings of one recorder. Sends only the changed keys; confirmation
 * comes from the recorder's own next heartbeat (last_seen newer than the one in the PATCH response).
 */
export function RecorderConfigForm({ recorder, idPrefix = 'rc', minimal }: { recorder: Recorder; idPrefix?: string; minimal?: boolean }) {
  const t = useT()
  const toast = useToast()
  const patch = usePatchRecorder()
  const saved = recorder.config
  const [edits, setEdits] = useState<Partial<RecorderConfig>>({})
  const [showAdv, setShowAdv] = useState(false)
  const [sent, setSent] = useState<{ lastSeen: string | null; device: string | null; deviceChanged: boolean } | null>(null)
  const draft = useMemo<RecorderConfig>(() => ({ ...saved, ...edits }), [saved, edits])
  const changed = useMemo(() => diffConfig(saved, draft), [saved, draft])
  const dirty = Object.keys(changed).length > 0
  const invalid = configInvalid(draft)
  const status = applyStatus(sent, recorder)

  // Applied confirmations fade after a while; other states persist until the next edit.
  useEffect(() => {
    if (status !== 'applied') return
    const id = setTimeout(() => setSent(null), 8000)
    return () => clearTimeout(id)
  }, [status])

  const set = <K extends keyof RecorderConfig>(k: K, v: RecorderConfig[K]) => {
    setEdits((e) => {
      const n = { ...e, [k]: v }
      if (n[k] === saved[k]) delete n[k]
      return n
    })
    setSent(null)
  }

  const save = async () => {
    try {
      const r = await patch.mutateAsync({ id: recorder.id, body: { config: changed } })
      setEdits({})
      setSent({ lastSeen: r.last_seen, device: 'device' in changed ? (changed.device ?? null) : null, deviceChanged: 'device' in changed })
      toast.success(t('rec.saved_toast'))
    } catch (e) {
      toast.error(e)
    }
  }

  const devices = recorder.devices ?? []
  const deviceKnown = draft.device == null || devices.some((d) => d.id === draft.device)
  const defaultDev = devices.find((d) => d.is_default)
  const vadHint = t(`rec.vad_${draft.vad_aggressiveness}_hint` as TKey)
  const advDefault = (Object.keys(ADV) as AdvKey[]).every((k) => draft[k] === ADV[k].def)

  return (
    <div className="space-y-4">
      <Field label={t('rec.f_device')}>
        <Select value={draft.device ?? ''} onChange={(e) => set('device', e.target.value === '' ? null : e.target.value)}>
          <option value="">
            {t('rec.device_default')}
            {defaultDev ? ` (${defaultDev.name})` : ''}
          </option>
          {!deviceKnown && <option value={draft.device ?? ''}>{draft.device}</option>}
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.is_default ? ` · ${t('rec.device_default_badge')}` : ''}
            </option>
          ))}
        </Select>
      </Field>

      <Field label={t('rec.f_gain')} hint={t('rec.f_gain_hint')}>
        <div className="flex items-center gap-3">
          <Slider value={draft.gain_db} min={GAIN.min} max={GAIN.max} step={1} label={t('rec.f_gain')} onChange={(v) => set('gain_db', v)} className="flex-1" />
          <Input
            type="number"
            inputMode="numeric"
            className="w-24 shrink-0"
            aria-label={t('rec.f_gain')}
            value={Number.isFinite(draft.gain_db) ? draft.gain_db : ''}
            min={GAIN.min}
            max={GAIN.max}
            step={1}
            suffix="dB"
            invalid={draft.gain_db < GAIN.min || draft.gain_db > GAIN.max}
            onChange={(e) => set('gain_db', e.target.value === '' ? NaN : Number(e.target.value))}
          />
        </div>
      </Field>

      {!minimal && <Field label={t('rec.f_vad')} hint={vadHint}>
        <div className="max-w-full overflow-x-auto">
          <Segmented
            label={t('rec.f_vad')}
            value={draft.vad_aggressiveness}
            onChange={(v) => set('vad_aggressiveness', v)}
            options={[0, 1, 2, 3].map((n) => ({ value: n, label: t(`rec.vad_${n}` as TKey) }))}
          />
        </div>
      </Field>}

      {!minimal && <div>
        <button
          type="button"
          className="text-[13px] font-medium text-accent hover:underline"
          aria-expanded={showAdv}
          aria-controls={`${idPrefix}-adv-${recorder.id}`}
          onClick={() => setShowAdv((v) => !v)}
        >
          {t('rec.advanced')} {showAdv ? '▾' : '▸'}
        </button>
        {showAdv && (
          <div id={`${idPrefix}-adv-${recorder.id}`} className="mt-3 grid gap-3 rounded-lg border border-line bg-subtle/50 p-3 sm:grid-cols-2">
            {(Object.keys(ADV) as AdvKey[]).map((k) => {
              const r = ADV[k]
              const bad = advError(k, draft[k])
              return (
                <Field
                  key={k}
                  label={t(ADV_LABEL[k])}
                  hint={bad ? undefined : t('rec.adv_range', { min: r.min, max: r.max, def: r.def })}
                  error={bad ? t('rec.adv_out_of_range', { min: r.min, max: r.max }) : undefined}
                >
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={Number.isFinite(draft[k]) ? draft[k] : ''}
                    min={r.min}
                    max={r.max}
                    suffix={r.unit}
                    invalid={bad}
                    onChange={(e) => set(k, e.target.value === '' ? NaN : Number(e.target.value))}
                  />
                </Field>
              )
            })}
            <div className="sm:col-span-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={advDefault}
                onClick={() => { for (const k of Object.keys(ADV) as AdvKey[]) set(k, ADV[k].def) }}
              >
                {t('rec.adv_reset')}
              </Button>
            </div>
          </div>
        )}
      </div>}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={() => void save()} disabled={!dirty || invalid} loading={patch.isPending}>
          {t('rec.save')}
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setEdits({})} disabled={patch.isPending}>
            {t('rec.discard')}
          </Button>
        )}
        <ApplyStatusLine status={status} />
      </div>
    </div>
  )
}
