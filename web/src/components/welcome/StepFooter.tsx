import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { Button } from '../ui/Button'
import { useT } from '../../i18n'

export interface StepProps { go: (n: number) => void }

/** Back / Next row at the bottom of each step. Errors belong above it, inline, never in a toast. */
export function StepFooter({ step, go, canNext, onNext, nextLabel, busy, extra }: {
  step: number; go: (n: number) => void; canNext: boolean; onNext: () => void | Promise<void>; nextLabel?: string; busy?: boolean; extra?: ReactNode
}) {
  const t = useT()
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
      <div>{step > 2 && <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => go(step - 1)}>{t('onb.back')}</Button>}</div>
      <div className="flex flex-wrap items-center gap-2">
        {extra}
        <Button variant="primary" disabled={!canNext} loading={busy} onClick={() => void onNext()}>
          {nextLabel ?? t('onb.next')}
          <ArrowRight className="ml-1.5 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
