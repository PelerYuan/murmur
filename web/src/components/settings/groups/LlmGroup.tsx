import { Banner } from '../../ui/Misc'
import { Section, SaveBar } from '../Fields'
import { LlmFields } from '../AsrLlmFields'
import { PromptsEditor } from '../PromptsEditor'
import { TestButton, TestResultCard, useConnectionTest } from '../ConnectionTest'
import { useGroupForm } from '../../../hooks/useGroupForm'
import { isLlmConfigured } from '../../../lib/settingsForm'
import type { LlmTestResult } from '../../../lib/types'
import { useT } from '../../../i18n'
import { useFormMessages, useReportDirty, type GroupProps } from './shared'

export default function LlmGroup({ onDirty }: GroupProps) {
  const t = useT()
  const form = useGroupForm('llm', useFormMessages())
  useReportDirty(form.dirty, onDirty)
  const test = useConnectionTest<LlmTestResult>('llm')
  const run = async () => {
    if (form.dirty && !(await form.save())) return
    await test.run()
  }
  return (
    <>
      {!isLlmConfigured(form.saved) && <Banner tone="info" className="mb-4" title={t('set.llm_not_configured')}>{t('set.llm_not_configured_body')}</Banner>}
      <Section>
        <LlmFields form={form} />
        <div className="space-y-3 border-t border-line pt-4">
          <TestButton running={test.status === 'running'} dirty={form.dirty} onClick={() => void run()} />
          <TestResultCard kind="llm" state={test} />
        </div>
      </Section>
      <Section className="mt-4">
        <PromptsEditor prompts={form.draft.prompts} errors={form.errors} onChange={(k, v) => form.set(`prompts.${k}`, v)} />
      </Section>
      <SaveBar dirty={form.dirty} saving={form.saving} onSave={() => void form.save()} onDiscard={form.discard} error={form.errors._} />
    </>
  )
}
