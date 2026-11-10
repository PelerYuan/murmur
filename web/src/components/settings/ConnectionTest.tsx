import { useCallback, useState } from 'react'
import { CheckCircle2, CircleAlert, Loader2, XCircle } from 'lucide-react'
import { Button } from '../ui/Button'
import { Banner } from '../ui/Misc'
import { api, ApiError, NetworkError } from '../../lib/api'
import { classifyTestFailure } from '../../lib/settingsForm'
import type { AsrTestResult, LlmTestResult } from '../../lib/types'
import { useT } from '../../i18n'

export type TestKind = 'asr' | 'llm'
export interface TestState<R> { status: 'idle' | 'running' | 'done'; result: R | null; error: string | null }

/**
 * POST /settings/test/{asr|llm}. The endpoint tests the SAVED settings, so callers save first.
 * A transport error is reported as a failed test, never thrown.
 */
export function useConnectionTest<R extends AsrTestResult | LlmTestResult>(kind: TestKind) {
  const [state, setState] = useState<TestState<R>>({ status: 'idle', result: null, error: null })
  const run = useCallback(async (): Promise<R | null> => {
    setState({ status: 'running', result: null, error: null })
    try {
      const r = await api.post<R>(`/settings/test/${kind}`)
      setState({ status: 'done', result: r, error: null })
      return r
    } catch (e) {
      const msg = e instanceof NetworkError ? 'network' : e instanceof ApiError ? e.detail : String(e)
      setState({ status: 'done', result: null, error: msg })
      return null
    }
  }, [kind])
  const reset = useCallback(() => setState({ status: 'idle', result: null, error: null }), [])
  return { ...state, run, reset }
}

export function TestButton({ running, onClick, dirty, label }: { running: boolean; onClick: () => void; dirty?: boolean; label?: string }) {
  const t = useT()
  return (
    <Button onClick={onClick} loading={running} disabled={running}>
      {label ?? (dirty ? t('set.test_save_first') : t('set.test'))}
    </Button>
  )
}

function suggestionKey(kind: TestKind, detail: string) {
  if (kind === 'llm' && /required/i.test(detail)) return 'set.test_llm_required' as const
  switch (classifyTestFailure(detail)) {
    case 'auth': return 'set.test_hint_auth' as const
    case 'not_found': return kind === 'llm' ? ('set.test_hint_v1' as const) : ('set.test_hint_404' as const)
    case 'timeout': return kind === 'asr' ? ('set.test_hint_timeout_asr' as const) : ('set.test_hint_timeout' as const)
    case 'refused': return 'set.test_hint_refused' as const
    case 'dns': return 'set.test_hint_dns' as const
    default: return null
  }
}

/** Result card for an ASR / LLM connection test (running, success, failure with a fixed suggestion). */
export function TestResultCard({ kind, state, asrMode }: { kind: TestKind; state: TestState<AsrTestResult | LlmTestResult>; asrMode?: 'murmur' | 'openai' }) {
  const t = useT()
  if (state.status === 'idle') return null
  if (state.status === 'running') {
    return (
      <div role="status" className="flex items-center gap-2 rounded-lg border border-line bg-subtle px-3 py-2.5 text-[13px] text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />{t('set.test_running')}
      </div>
    )
  }
  const r = state.result
  if (r?.ok) {
    const parts: string[] = [t('set.test_ok'), r.latency_ms != null ? t('set.test_latency', { ms: r.latency_ms }) : '']
    let speakerWarn = false
    if (kind === 'asr') {
      const info = (r as AsrTestResult).info
      if (info?.asr_model) parts.push(t('set.test_model', { m: info.asr_model }))
      if (info?.embedding_dim) parts.push(t('set.test_dim', { n: info.embedding_dim }))
      const canSpeak = info?.features?.speaker_embedding !== false && asrMode !== 'openai'
      if (canSpeak) parts.push(t('set.test_speakers_ok'))
      speakerWarn = !canSpeak
    }
    return (
      <div className="space-y-2" role="status">
        <div className="flex items-start gap-2 rounded-lg border border-ok/30 bg-ok/10 px-3 py-2.5 text-[13px]">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
          <span>{parts.filter(Boolean).join(' · ')}</span>
        </div>
        {speakerWarn && <Banner tone="warn">{t('set.asr_no_speakers')}</Banner>}
      </div>
    )
  }
  const detail = r?.detail ?? state.error ?? ''
  const net = state.error === 'network'
  const sk = net ? null : suggestionKey(kind, detail)
  return (
    <div className="space-y-1.5 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px]" role="alert">
      <p className="flex items-start gap-2 font-medium text-danger">
        <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="break-words">{net ? t('set.test_network') : kind === 'asr' ? t('set.test_asr_fail', { detail }) : t('set.test_llm_fail', { detail })}</span>
      </p>
      {sk && <p className="flex items-start gap-2 text-fg/80"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" /><span>{t(sk)}</span></p>}
    </div>
  )
}
