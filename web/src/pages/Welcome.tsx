import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Check, Languages, Moon, Sun } from 'lucide-react'
import { IconButton, Button } from '../components/ui/Button'
import { Skeleton } from '../components/ui/Misc'
import { LiveSync } from '../components/shell/LiveSync'
import StepRooms from '../components/welcome/StepRooms'
import StepRecorder, { type TokenState } from '../components/welcome/StepRecorder'
import StepDevice from '../components/welcome/StepDevice'
import StepAsr from '../components/welcome/StepAsr'
import StepLlm from '../components/welcome/StepLlm'
import StepFirst from '../components/welcome/StepFirst'
import { onboardingFlags, useOnboarding } from '../hooks/useOnboarding'
import { usePageTitle } from '../hooks/usePageTitle'
import { ssSet } from '../lib/storage'
import { useTheme } from '../lib/theme'
import { cn } from '../lib/cn'
import { useI18n, type TKey } from '../i18n'

const STEP_LABEL: TKey[] = ['onb.s1', 'onb.s2', 'onb.s3', 'onb.s4', 'onb.s5', 'onb.s6', 'onb.s7']

export function ProgressSteps({ current, done, onPick }: { current: number; done: boolean[]; onPick: (n: number) => void }) {
  const { t } = useI18n()
  return (
    <ol className="flex items-start gap-1.5" aria-label={t('onb.progress', { n: current, total: 7 })}>
      {STEP_LABEL.map((k, i) => {
        const n = i + 1
        const isDone = !!done[i] && n !== current
        const reachable = n >= 2 && (n <= current || done[i])
        return (
          <li key={k} className="min-w-0 flex-1" aria-current={n === current ? 'step' : undefined}>
            <button
              type="button"
              disabled={!reachable || n === current}
              onClick={() => onPick(n)}
              className="group block w-full text-left disabled:cursor-default"
            >
              <span className={cn('block h-1.5 rounded-full transition-colors', n === current ? 'bg-accent' : isDone ? 'bg-ok' : 'bg-line-strong')} />
              <span className={cn('mt-1.5 hidden items-center gap-1 truncate text-[11px] sm:flex', n === current ? 'font-semibold text-fg' : 'text-muted')}>
                {isDone && <Check className="h-3 w-3 shrink-0 text-ok" />}
                <span className="truncate">{t(k)}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

export default function Welcome() {
  const { t, lang, setLang } = useI18n()
  const { resolved, setPref } = useTheme()
  const nav = useNavigate()
  const ob = useOnboarding()
  const [params, setParams] = useSearchParams()
  const [step, setStep] = useState<number | null>(null)
  const [tok, setTok] = useState<TokenState | null>(null)
  usePageTitle(t('onb.title'))

  // Land on ?step=, else on the first unfinished required step (7 when everything else is done).
  useEffect(() => {
    if (step !== null || ob.loading) return
    const q = parseInt(params.get('step') ?? '', 10)
    setStep(q >= 2 && q <= 7 ? q : ob.firstOpen ?? 7)
  }, [step, ob.loading, ob.firstOpen, params])

  const go = (n: number) => {
    setStep(n)
    setParams({ step: String(n) }, { replace: true })
    document.getElementById('main')?.scrollTo?.({ top: 0 })
    window.scrollTo({ top: 0 })
  }
  const later = () => { onboardingFlags.setDismissed(true); ssSet('murmur.gate', '1'); nav('/', { replace: true }) }

  const current = step ?? 2
  return (
    <div className="min-h-dvh bg-bg">
      <LiveSync />
      <div className="mx-auto flex w-full max-w-[680px] flex-col px-4 py-6 sm:py-10">
        <header className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <svg viewBox="0 0 32 32" className="h-9 w-9" aria-hidden>
              <rect width="32" height="32" rx="8" fill="rgb(var(--accent))" />
              <g fill="rgb(var(--accent-fg))"><rect x="6" y="13" width="3" height="6" rx="1.5" /><rect x="11" y="9" width="3" height="14" rx="1.5" /><rect x="16" y="6" width="3" height="20" rx="1.5" /><rect x="21" y="11" width="3" height="10" rx="1.5" /></g>
            </svg>
            <div>
              <h1 className="text-lg font-semibold leading-tight tracking-tight">{t('onb.title')}</h1>
              <p className="text-xs text-muted">{t('app.tagline')}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <IconButton aria-label={t('topbar.language')} onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}><Languages className="h-[18px] w-[18px]" /></IconButton>
            <IconButton aria-label={t('topbar.theme')} onClick={() => setPref(resolved === 'dark' ? 'light' : 'dark')}>
              {resolved === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
            </IconButton>
          </div>
        </header>

        <ProgressSteps current={current} done={ob.done} onPick={go} />

        <main id="main" className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-card sm:p-6">
          {step === null ? (
            <Skeleton className="h-64 rounded-lg" />
          ) : (
            <>
              <h2 className="mb-4 text-base font-semibold">{t(STEP_LABEL[step - 1])} <span className="ml-1 text-xs font-normal text-muted">{t('onb.progress', { n: step, total: 7 })}</span></h2>
              {step === 2 && <StepRooms go={go} />}
              {step === 3 && <StepRecorder go={go} tok={tok} setTok={setTok} />}
              {step === 4 && <StepDevice go={go} />}
              {step === 5 && <StepAsr go={go} />}
              {step === 6 && <StepLlm go={go} />}
              {step === 7 && <StepFirst go={go} />}
            </>
          )}
        </main>

        <footer className="mt-4 flex justify-center">
          <Button variant="ghost" onClick={later}>{t('onb.later')}</Button>
        </footer>
      </div>
    </div>
  )
}
