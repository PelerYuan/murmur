import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Banner } from '../../ui/Misc'
import { ConfirmDialog } from '../../ui/Confirm'
import { NumberField, Section, SaveBar, ToggleRow } from '../Fields'
import { useGroupForm } from '../../../hooks/useGroupForm'
import { useSystemInfo } from '../../../hooks/useData'
import { formatBytes } from '../../../lib/status'
import { useT } from '../../../i18n'
import { useFormMessages, useReportDirty, type GroupProps } from './shared'

export default function RetentionGroup({ onDirty }: GroupProps) {
  const t = useT()
  const form = useGroupForm('retention', useFormMessages())
  useReportDirty(form.dirty, onDirty)
  const sys = useSystemInfo()
  const [confirmKeep, setConfirmKeep] = useState(false)
  const { draft: d, set, errors } = form
  return (
    <>
      <Section>
        <ToggleRow
          label={t('set.r_delete_audio')}
          hint={t('set.r_delete_audio_hint')}
          checked={d.delete_audio_after_transcribe}
          onChange={(v) => (v ? set('delete_audio_after_transcribe', true) : setConfirmKeep(true))}
        />
        {!d.delete_audio_after_transcribe && <Banner tone="warn">{t('set.r_keep_warn')}</Banner>}
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label={t('set.r_failed_days')} hint={t('set.r_failed_days_hint')} suffix={t('set.unit_days')} value={d.failed_audio_days} onChange={(v) => set('failed_audio_days', v)} error={errors.failed_audio_days} min={0} />
          <NumberField label={t('set.r_embed_days')} hint={t('set.r_embed_days_hint')} suffix={t('set.unit_days')} value={d.utterance_embedding_days} onChange={(v) => set('utterance_embedding_days', v)} error={errors.utterance_embedding_days} min={0} />
        </div>
      </Section>
      <aside className="mt-4 flex gap-3 rounded-xl border border-line bg-subtle/60 p-4 text-[13px] leading-6 text-muted">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
        <div>
          <p className="font-medium text-fg">{t('set.privacy_title')}</p>
          <p>{t('set.privacy_body')}</p>
        </div>
      </aside>
      <SaveBar dirty={form.dirty} saving={form.saving} onSave={() => void form.save()} onDiscard={form.discard} error={errors._} />
      <ConfirmDialog
        open={confirmKeep}
        danger
        title={t('set.r_keep_title')}
        body={t('set.r_keep_body')}
        extra={sys.data ? <Banner tone="info">{t('set.r_keep_disk', { free: formatBytes(sys.data.disk_free_bytes) })}</Banner> : undefined}
        confirmLabel={t('set.r_keep_confirm')}
        onClose={() => setConfirmKeep(false)}
        onConfirm={() => { set('delete_audio_after_transcribe', false); setConfirmKeep(false) }}
      />
    </>
  )
}
