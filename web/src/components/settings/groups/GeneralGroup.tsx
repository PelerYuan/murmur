import { Field, Segmented, Select } from '../../ui/Form'
import { Section, SaveBar, TimezonePicker, TimezoneMismatch } from '../Fields'
import { useGroupForm } from '../../../hooks/useGroupForm'
import { browserTz } from '../../../lib/time'
import { useT } from '../../../i18n'
import { useFormMessages, useReportDirty, type GroupProps } from './shared'

export default function GeneralGroup({ onDirty }: GroupProps) {
  const t = useT()
  const form = useGroupForm('general', useFormMessages())
  useReportDirty(form.dirty, onDirty)
  const { draft: d, set, errors } = form
  const langs = ['zh', 'en', 'ja']
  return (
    <>
      <Section>
        <div>
          <label htmlFor="tz-trigger" className="mb-1.5 block text-[13px] font-medium">{t('set.tz')}</label>
          <TimezonePicker value={d.timezone} onChange={(z) => set('timezone', z)} error={errors.timezone} />
          <p className="mt-1.5 text-xs leading-5 text-muted">{errors.timezone ? <span className="text-danger" role="alert">{errors.timezone}</span> : t('set.tz_hint')}</p>
          <TimezoneMismatch selected={d.timezone} onUseBrowser={() => set('timezone', browserTz())} />
        </div>
        <Field label={t('set.ui_language')} hint={t('set.ui_language_hint')} error={errors.ui_language}>
          <Segmented label={t('set.ui_language')} value={d.ui_language} onChange={(v) => set('ui_language', v)} options={[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]} />
        </Field>
        <Field label={t('set.output_language')} hint={t('set.output_language_hint')} error={errors.output_language}>
          <Select value={d.output_language} onChange={(e) => set('output_language', e.target.value)}>
            {!langs.includes(d.output_language) && <option value={d.output_language}>{d.output_language}</option>}
            <option value="zh">中文</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
          </Select>
        </Field>
      </Section>
      <SaveBar dirty={form.dirty} saving={form.saving} onSave={() => void form.save()} onDiscard={form.discard} error={errors._} />
    </>
  )
}
