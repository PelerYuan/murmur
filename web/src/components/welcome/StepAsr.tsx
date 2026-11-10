import { useState } from 'react'
import { Banner } from '../ui/Misc'
import { AsrFields } from '../settings/AsrLlmFields'
import { TestButton, TestResultCard, useConnectionTest } from '../settings/ConnectionTest'
import { StepFooter, type StepProps } from './StepFooter'
import { useGroupForm } from '../../hooks/useGroupForm'
import { usePipeline } from '../../hooks/useData'
import type { AsrTestResult } from '../../lib/types'
import { useT } from '../../i18n'
import { useFormMessages } from '../settings/groups/shared'

export default function StepAsr({ go }: StepProps) {
  const t = useT()
  const form = useGroupForm('asr', useFormMessages())
  const test = useConnectionTest<AsrTestResult>('asr')
  const pipe = usePipeline(false)
  const [busy, setBusy] = useState(false)
  const verified = test.result?.ok === true || (test.status === 'idle' && pipe.data?.asr_ok === true)
  const failed = test.status === 'done' && !test.result?.ok

  const saveThen = async (after: () => void | Promise<void>) => {
    setBusy(true)
    try { if (!form.dirty || (await form.save())) await after() } finally { setBusy(false) }
  }
  return (
    <div className="space-y-5">
      <AsrFields form={form} compact />
      {form.errors._ && <p role="alert" className="text-[13px] text-danger">{form.errors._}</p>}
      <div className="space-y-3 border-t border-line pt-4">
        <TestButton running={test.status === 'running'} dirty={form.dirty} onClick={() => void saveThen(() => test.run().then(() => undefined))} />
        <TestResultCard kind="asr" state={test} asrMode={form.saved.mode} />
        {failed && <Banner tone="warn">{t('onb.asr_unverified')}</Banner>}
        {verified && <p className="text-xs text-ok">{t('onb.asr_verified')}</p>}
      </div>
      <StepFooter step={5} go={go} canNext busy={busy} onNext={() => saveThen(() => go(6))} />
    </div>
  )
}
