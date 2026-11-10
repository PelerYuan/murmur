import { Banner } from '../../ui/Misc'
import { NumberField, Section, SaveBar, SliderField, ToggleRow } from '../Fields'
import { useGroupForm } from '../../../hooks/useGroupForm'
import { useT } from '../../../i18n'
import { useFormMessages, useReportDirty, type GroupProps } from './shared'

export default function FiltersGroup({ onDirty }: GroupProps) {
  const t = useT()
  const form = useGroupForm('filters', useFormMessages())
  useReportDirty(form.dirty, onDirty)
  const { draft: d, set, errors } = form
  return (
    <>
      <Section>
        <p className="text-[13px] leading-5 text-muted">{t('set.filters_intro')}</p>
        <ToggleRow label={t('set.f_non_speech')} hint={t('set.f_non_speech_hint')} checked={d.drop_non_speech} onChange={(v) => set('drop_non_speech', v)} />
        {!d.drop_non_speech && <Banner tone="warn">{t('set.f_non_speech_warn')}</Banner>}
        <ToggleRow label={t('set.f_halluc')} hint={t('set.f_halluc_hint')} checked={d.drop_hallucinations} onChange={(v) => set('drop_hallucinations', v)} />
        <SliderField label={t('set.f_conf')} hint={t('set.f_conf_hint')} min={0} max={1} step={0.05} value={d.min_confidence} onChange={(v) => set('min_confidence', v)} error={errors.min_confidence} />
        <NumberField className="max-w-xs" label={t('set.f_chars')} hint={t('set.f_chars_hint')} value={d.min_text_chars} onChange={(v) => set('min_text_chars', v)} error={errors.min_text_chars} min={0} suffix={t('set.unit_chars')} />
      </Section>
      <SaveBar dirty={form.dirty} saving={form.saving} onSave={() => void form.save()} onDiscard={form.discard} error={errors._} />
    </>
  )
}
