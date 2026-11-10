import { Section, SaveBar } from '../Fields'
import { AsrFields } from '../AsrLlmFields'
import { TestButton, TestResultCard, useConnectionTest } from '../ConnectionTest'
import { useGroupForm } from '../../../hooks/useGroupForm'
import type { AsrTestResult } from '../../../lib/types'
import { useT } from '../../../i18n'
import { useFormMessages, useReportDirty, type GroupProps } from './shared'

export default function AsrGroup({ onDirty }: GroupProps) {
  const t = useT()
  const form = useGroupForm('asr', useFormMessages())
  useReportDirty(form.dirty, onDirty)
  const test = useConnectionTest<AsrTestResult>('asr')
  // The endpoint tests the SAVED settings: save pending edits first.
  const run = async () => {
    if (form.dirty && !(await form.save())) return
    await test.run()
  }
  return (
    <>
      <Section>
        <AsrFields form={form} />
        <div className="space-y-3 border-t border-line pt-4">
          <TestButton running={test.status === 'running'} dirty={form.dirty} onClick={() => void run()} />
          <TestResultCard kind="asr" state={test} asrMode={form.saved.mode} />
        </div>
      </Section>
      <SaveBar dirty={form.dirty} saving={form.saving} onSave={() => void form.save()} onDiscard={form.discard} error={form.errors._} />
      <p className="sr-only">{t('set.asr')}</p>
    </>
  )
}
