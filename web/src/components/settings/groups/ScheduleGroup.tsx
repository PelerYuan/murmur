import { type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Banner } from '../../ui/Misc'
import { Switch, Input, Field } from '../../ui/Form'
import { NumberField, SaveBar } from '../Fields'
import { useGroupForm } from '../../../hooks/useGroupForm'
import { useFmt, useSettings } from '../../../hooks/useData'
import { useNow } from '../../../hooks/useNow'
import { isLlmConfigured, nextHourStart } from '../../../lib/settingsForm'
import { nextDailyRun } from '../../../lib/time'
import { useT } from '../../../i18n'
import { useFormMessages, useReportDirty, type GroupProps } from './shared'

function Card({ title, enabled, onToggle, hint, next, children }: { title: string; enabled: boolean; onToggle: (v: boolean) => void; hint: string; next?: string; children?: ReactNode }) {
  const t = useT()
  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-card sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        <Switch checked={enabled} onChange={onToggle} label={title} />
      </div>
      <p className="mt-1 text-[13px] leading-5 text-muted">{hint}</p>
      {enabled && children && <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>}
      {enabled && next && <p className="mt-3 text-xs text-muted">{t('set.s_next', { t: next })}</p>}
      {!enabled && <p className="mt-3 text-xs text-faint">{t('set.s_off')}</p>}
    </section>
  )
}

export default function ScheduleGroup({ onDirty }: GroupProps) {
  const t = useT()
  const fmt = useFmt()
  const now = useNow(60_000)
  const llm = useSettings().data?.llm
  const form = useGroupForm('schedule', useFormMessages())
  useReportDirty(form.dirty, onDirty)
  const { draft: d, set, errors } = form
  const at = (ms: number) => fmt.dateTime(new Date(ms).toISOString())
  return (
    <>
      {llm && !isLlmConfigured(llm) && (
        <Banner tone="info" className="mb-4" action={<Link to="/settings/llm" className="font-medium text-accent hover:underline">{t('set.s_go_llm')}</Link>}>
          {t('set.s_need_llm')}
        </Banner>
      )}
      <div className="space-y-4">
        <Card title={t('set.s_incremental')} hint={t('set.s_incremental_hint')} enabled={d.incremental.enabled} onToggle={(v) => set('incremental.enabled', v)}>
          <NumberField label={t('set.s_every')} suffix={t('set.unit_min')} value={d.incremental.every_minutes} onChange={(v) => set('incremental.every_minutes', v)} error={errors['incremental.every_minutes']} min={1} />
          <NumberField label={t('set.s_min_utt')} hint={t('set.s_min_utt_hint')} value={d.incremental.min_utterances} onChange={(v) => set('incremental.min_utterances', v)} error={errors['incremental.min_utterances']} min={1} />
        </Card>
        <Card title={t('set.s_hourly')} hint={t('set.s_hourly_hint')} enabled={d.hourly.enabled} onToggle={(v) => set('hourly.enabled', v)} next={at(nextHourStart(now, fmt.tz))} />
        <Card
          title={t('set.s_daily')}
          hint={t('set.s_daily_hint')}
          enabled={d.daily.enabled}
          onToggle={(v) => set('daily.enabled', v)}
          next={/^\d{2}:\d{2}$/.test(d.daily.time) ? at(nextDailyRun(now, fmt.tz, d.daily.time)) : undefined}
        >
          <Field label={t('set.s_daily_time')} hint={t('set.s_daily_time_hint', { tz: fmt.tz })} error={errors['daily.time']}>
            <Input type="time" value={d.daily.time} onChange={(e) => set('daily.time', e.target.value)} invalid={!!errors['daily.time']} />
          </Field>
        </Card>
        <Card title={t('set.s_idle')} hint={t('set.s_idle_hint')} enabled={d.idle.enabled} onToggle={(v) => set('idle.enabled', v)}>
          <NumberField label={t('set.s_idle_minutes')} suffix={t('set.unit_min')} value={d.idle.idle_minutes} onChange={(v) => set('idle.idle_minutes', v)} error={errors['idle.idle_minutes']} min={1} />
        </Card>
      </div>
      <SaveBar dirty={form.dirty} saving={form.saving} onSave={() => void form.save()} onDiscard={form.discard} error={errors._} />
    </>
  )
}
