import { useState } from 'react'
import { Volume2 } from 'lucide-react'
import { Banner } from '../../ui/Misc'
import { Button } from '../../ui/Button'
import { NumberField, Section, SaveBar, SliderField, ToggleRow } from '../Fields'
import { WhoAmIDialog } from '../../shell/Dialogs'
import { useReminders } from '../../reminders/ReminderCenter'
import { useGroupForm } from '../../../hooks/useGroupForm'
import { useMe, useSpeakerLookup } from '../../../hooks/useData'
import { playChime } from '../../../lib/sound'
import { lsGet, lsSet } from '../../../lib/storage'
import { useT } from '../../../i18n'
import { useFormMessages, useReportDirty, type GroupProps } from './shared'

/** Browser-local items: they take effect immediately and never touch the server. */
function LocalItems() {
  const t = useT()
  const r = useReminders()
  const [me] = useMe()
  const { label } = useSpeakerLookup()
  const [who, setWho] = useState(false)
  const secure = window.isSecureContext && 'Notification' in window
  const [notify, setNotify] = useState(() => lsGet('murmur.reminder.notify') === '1')
  const [perm, setPerm] = useState<NotificationPermission | null>(() => (secure ? Notification.permission : null))
  const toggleNotify = async (v: boolean) => {
    if (!v) { lsSet('murmur.reminder.notify', null); setNotify(false); return }
    let p = Notification.permission
    if (p === 'default') p = await Notification.requestPermission()
    setPerm(p)
    if (p === 'granted') { lsSet('murmur.reminder.notify', '1'); setNotify(true) }
  }
  return (
    <Section title={t('set.local_title')} hint={t('set.local_hint')} className="mt-4">
      <ToggleRow label={t('set.local_sound')} hint={r.soundUnlocked ? t('set.local_sound_hint') : t('set.local_sound_locked')} checked={!r.muted} onChange={(v) => r.setMuted(!v)} />
      <div>
        <Button size="sm" icon={<Volume2 className="h-3.5 w-3.5" />} onClick={() => playChime()} disabled={!r.soundUnlocked}>{t('set.local_sound_test')}</Button>
      </div>
      {secure ? (
        <>
          <ToggleRow label={t('set.local_notify')} hint={t('set.local_notify_hint')} checked={notify && perm === 'granted'} onChange={(v) => void toggleNotify(v)} />
          {perm === 'denied' && <Banner tone="warn">{t('set.local_notify_denied')}</Banner>}
        </>
      ) : (
        <div>
          <p className="text-sm font-medium">{t('set.local_notify')}</p>
          <p className="mt-0.5 text-xs leading-5 text-muted">{t('set.local_notify_insecure')}</p>
        </div>
      )}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('set.local_me')}</p>
          <p className="mt-0.5 text-xs leading-5 text-muted">{me != null ? label(me) : t('set.local_me_none')} · {t('set.local_me_hint')}</p>
        </div>
        <Button onClick={() => setWho(true)}>{t('set.local_me_change')}</Button>
      </div>
      <WhoAmIDialog open={who} onClose={() => setWho(false)} />
    </Section>
  )
}

export default function TodosGroup({ onDirty }: GroupProps) {
  const t = useT()
  const form = useGroupForm('todos', useFormMessages())
  useReportDirty(form.dirty, onDirty)
  const { draft: d, set, errors } = form
  return (
    <>
      <Section>
        <ToggleRow label={t('set.t_enabled')} hint={t('set.t_enabled_hint')} checked={d.enabled} onChange={(v) => set('enabled', v)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label={t('set.t_every')} hint={t('set.t_every_hint')} suffix={t('set.unit_min')} value={d.every_minutes} onChange={(v) => set('every_minutes', v)} error={errors.every_minutes} min={1} />
          <NumberField label={t('set.t_remind_before')} hint={t('set.t_remind_before_hint')} suffix={t('set.unit_min')} value={d.default_remind_before_minutes} onChange={(v) => set('default_remind_before_minutes', v)} error={errors.default_remind_before_minutes} min={0} />
        </div>
        <SliderField label={t('set.t_conf')} hint={t('set.t_conf_hint')} min={0} max={1} step={0.05} value={d.min_confidence} onChange={(v) => set('min_confidence', v)} error={errors.min_confidence} />
      </Section>
      <LocalItems />
      <SaveBar dirty={form.dirty} saving={form.saving} onSave={() => void form.save()} onDiscard={form.discard} error={errors._} />
    </>
  )
}
