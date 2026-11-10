import { useState } from 'react'
import { Field, Select } from '../ui/Form'
import { Button } from '../ui/Button'
import { LlmFields } from '../settings/AsrLlmFields'
import { TestButton, TestResultCard, useConnectionTest } from '../settings/ConnectionTest'
import { StepFooter, type StepProps } from './StepFooter'
import { useGroupForm } from '../../hooks/useGroupForm'
import { onboardingFlags } from '../../hooks/useOnboarding'
import { isLlmConfigured } from '../../lib/settingsForm'
import type { LlmTestResult } from '../../lib/types'
import { useT } from '../../i18n'
import { useFormMessages } from '../settings/groups/shared'

export default function StepLlm({ go }: StepProps) {
  const t = useT()
  const msgs = useFormMessages()
  const form = useGroupForm('llm', msgs)
  const general = useGroupForm('general', msgs)
  const test = useConnectionTest<LlmTestResult>('llm')
  const [busy, setBusy] = useState(false)
  const dirty = form.dirty || general.dirty

  const saveAll = async (): Promise<boolean> => {
    if (form.dirty && !(await form.save())) return false
    if (general.dirty && !(await general.save())) return false
    return true
  }
  const saveThen = async (after: () => void | Promise<void>) => {
    setBusy(true)
    try { if (await saveAll()) await after() } finally { setBusy(false) }
  }
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">{t('onb.llm_intro')}</p>
      <LlmFields form={form} compact />
      <Field label={t('set.output_language')} hint={t('set.output_language_hint')}>
        <Select value={general.draft.output_language} onChange={(e) => general.set('output_language', e.target.value)}>
          {!['zh', 'en', 'ja'].includes(general.draft.output_language) && <option value={general.draft.output_language}>{general.draft.output_language}</option>}
          <option value="zh">中文</option>
          <option value="en">English</option>
          <option value="ja">日本語</option>
        </Select>
      </Field>
      {form.errors._ && <p role="alert" className="text-[13px] text-danger">{form.errors._}</p>}
      <div className="space-y-3 border-t border-line pt-4">
        <TestButton running={test.status === 'running'} dirty={dirty} onClick={() => void saveThen(() => test.run().then(() => undefined))} />
        <TestResultCard kind="llm" state={test} />
      </div>
      <StepFooter
        step={6}
        go={go}
        canNext={isLlmConfigured(form.draft)}
        busy={busy}
        nextLabel={t('onb.llm_save_next')}
        onNext={() => saveThen(() => { onboardingFlags.setLlmSkipped(false); go(7) })}
        extra={<Button variant="ghost" onClick={() => { onboardingFlags.setLlmSkipped(true); go(7) }}>{t('onb.llm_skip')}</Button>}
      />
    </div>
  )
}
