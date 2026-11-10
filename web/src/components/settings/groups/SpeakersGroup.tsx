import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Banner } from '../../ui/Misc'
import { NumberField, Section, SaveBar, SliderField } from '../Fields'
import { useGroupForm } from '../../../hooks/useGroupForm'
import { cn } from '../../../lib/cn'
import { useT } from '../../../i18n'
import { useFormMessages, useReportDirty, type GroupProps } from './shared'

export default function SpeakersGroup({ onDirty }: GroupProps) {
  const t = useT()
  const form = useGroupForm('speakers', useFormMessages())
  useReportDirty(form.dirty, onDirty)
  const [open, setOpen] = useState(false)
  const { draft: d, set, errors } = form
  return (
    <>
      <Section>
        <p className="text-[13px] leading-5 text-muted">{t('set.speakers_intro')}</p>
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-lg border border-line px-3.5 py-2.5 text-left text-sm font-medium hover:bg-hover"
          aria-expanded={open}
          aria-controls="speakers-adv"
          onClick={() => setOpen((o) => !o)}
        >
          {t('set.advanced')}
          <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
        </button>
        {(open || form.dirty) && (
          <div id="speakers-adv" className="space-y-4">
            <Banner tone="warn">{t('set.speakers_warn')}</Banner>
            <SliderField label={t('set.sp_match')} hint={t('set.sp_match_hint')} min={0} max={1} step={0.01} value={d.match_threshold} onChange={(v) => set('match_threshold', v)} error={errors.match_threshold} />
            <SliderField label={t('set.sp_cluster')} hint={t('set.sp_cluster_hint')} min={0} max={1} step={0.01} value={d.cluster_threshold} onChange={(v) => set('cluster_threshold', v)} error={errors.cluster_threshold} />
            <p className="text-xs text-muted">{t('set.sp_threshold_note')}</p>
            <div className="grid gap-4 sm:grid-cols-3">
              <NumberField label={t('set.sp_sample_count')} hint={t('set.sp_sample_count_hint')} value={d.sample_count} onChange={(v) => set('sample_count', v)} error={errors.sample_count} min={1} />
              <NumberField label={t('set.sp_sample_seconds')} hint={t('set.sp_sample_seconds_hint')} suffix="s" value={d.sample_seconds} onChange={(v) => set('sample_seconds', v)} error={errors.sample_seconds} min={1} step={0.5} />
              <NumberField label={t('set.sp_min_utt')} hint={t('set.sp_min_utt_hint')} suffix="s" value={d.min_utterance_seconds} onChange={(v) => set('min_utterance_seconds', v)} error={errors.min_utterance_seconds} min={0} step={0.1} />
            </div>
          </div>
        )}
      </Section>
      <SaveBar dirty={form.dirty} saving={form.saving} onSave={() => void form.save()} onDiscard={form.discard} error={errors._} />
    </>
  )
}
