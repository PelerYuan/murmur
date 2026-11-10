import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, Languages, Moon, Sun } from 'lucide-react'
import { api, ApiError, NetworkError } from '../lib/api'
import { qk } from '../lib/queryClient'
import { ssGet, ssSet } from '../lib/storage'
import { useTheme } from '../lib/theme'
import { useAuthStatus } from '../hooks/useData'
import { useI18n } from '../i18n'
import { Button, IconButton } from '../components/ui/Button'
import { Banner } from '../components/ui/Misc'
import { Field, Input } from '../components/ui/Form'
import { usePageTitle } from '../hooks/usePageTitle'
import { cn } from '../lib/cn'
import { passwordStrength } from '../lib/password'

function Shell({ children }: { children: React.ReactNode }) {
  const { lang, setLang, t } = useI18n()
  const { resolved, setPref } = useTheme()
  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
      <div className="absolute right-3 top-3 flex gap-1">
        <IconButton aria-label={t('topbar.language')} onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}><Languages className="h-[18px] w-[18px]" /></IconButton>
        <IconButton aria-label={t('topbar.theme')} onClick={() => setPref(resolved === 'dark' ? 'light' : 'dark')}>
          {resolved === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </IconButton>
      </div>
      <div className="w-full max-w-[380px]">
        <div className="mb-7 flex flex-col items-center text-center">
          <svg viewBox="0 0 32 32" className="mb-4 h-12 w-12" aria-hidden>
            <rect width="32" height="32" rx="8" fill="rgb(var(--accent))" />
            <g fill="rgb(var(--accent-fg))"><rect x="6" y="13" width="3" height="6" rx="1.5" /><rect x="11" y="9" width="3" height="14" rx="1.5" /><rect x="16" y="6" width="3" height="20" rx="1.5" /><rect x="21" y="11" width="3" height="10" rx="1.5" /></g>
          </svg>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted">Murmur</p>
        </div>
        <div className="card p-6">{children}</div>
        <p className="mt-5 text-center text-xs text-faint">{t('app.tagline')}</p>
      </div>
    </div>
  )
}

export default function Login() {
  const { t } = useI18n()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const status = useAuthStatus()
  const setup = status.data?.setup_required
  usePageTitle(setup ? t('login.setup_title') : t('login.title'))

  const next = useMemo(() => {
    const n = params.get('next') || ssGet('murmur.next') || '/'
    return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/login') ? n : '/'
  }, [params])

  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [fails, setFails] = useState(0)
  const [until, setUntil] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [flash] = useState(() => { const f = ssGet('murmur.flash'); if (f) ssSet('murmur.flash', null); return f })
  const left = Math.max(0, Math.ceil((until - now) / 1000))

  useEffect(() => {
    if (!until) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [until])
  useEffect(() => { if (until && now >= until) { setUntil(0); setFails(0); setError(null) } }, [now, until])

  if (status.isLoading) return <Shell><div className="h-40" aria-busy /></Shell>
  if (status.data?.authenticated) return <Navigate to={setup ? '/welcome' : next} replace />

  const finish = async (toWelcome: boolean) => {
    ssSet('murmur.next', null)
    await qc.invalidateQueries({ queryKey: qk.auth })
    nav(toWelcome ? '/welcome' : next, { replace: true })
  }
  const cooldown = (secs: number) => { setNow(Date.now()); setUntil(Date.now() + secs * 1000) }

  const submitLogin = async () => {
    setBusy(true); setError(null)
    try {
      await api.post('/auth/login', { password: pw }, { quiet401: true })
      await finish(false)
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) cooldown(e.retryAfter ?? 60)
      else if (e instanceof ApiError && e.status === 401) {
        const n = fails + 1
        setFails(n)
        setError(t('login.wrong'))
        if (n >= 5) cooldown(60)
      } else if (e instanceof ApiError && e.code === 'setup_required') { await qc.invalidateQueries({ queryKey: qk.auth }) }
      else setError(e instanceof NetworkError ? t('common.error_network') : (e as Error).message)
    } finally { setBusy(false) }
  }

  const strength = passwordStrength(pw)
  const submitSetup = async () => {
    if (pw.length < 6) return setError(t('login.too_short'))
    if (pw !== pw2) return setError(t('login.mismatch'))
    setBusy(true); setError(null)
    try {
      await api.post('/auth/setup', { password: pw }, { quiet401: true })
      await finish(true)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'already_setup') {
        await qc.invalidateQueries({ queryKey: qk.auth })
        setError(t('login.already_setup'))
      } else setError(e instanceof NetworkError ? t('common.error_network') : (e as Error).message)
    } finally { setBusy(false) }
  }

  const eye = (
    <button type="button" aria-label={show ? t('login.hide') : t('login.show')} onClick={() => setShow((s) => !s)} className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-2 text-muted hover:text-fg">
      {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  )

  if (setup) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">{t('login.setup_title')}</h1>
        <p className="mt-1.5 text-[13px] leading-6 text-muted">{t('login.setup_sub')}</p>
        <form className="mt-5 space-y-4" onSubmit={(e) => { e.preventDefault(); void submitSetup() }}>
          <Field label={t('login.password')} hint={pw.length >= 6 && pw.length < 10 ? t('login.suggest_long') : undefined}>
            <div className="relative">
              <Input type={show ? 'text' : 'password'} autoFocus autoComplete="new-password" value={pw} onChange={(e) => { setPw(e.target.value); setError(null) }} inputClassName="pr-10" />
              {eye}
            </div>
          </Field>
          {pw && (
            <div className="-mt-2 flex items-center gap-2" aria-live="polite">
              <div className="flex flex-1 gap-1">
                {[1, 2, 3].map((i) => <span key={i} className={cn('h-1 flex-1 rounded-full bg-subtle', strength >= i && (strength === 1 ? '!bg-danger' : strength === 2 ? '!bg-warn' : '!bg-ok'))} />)}
              </div>
              <span className="text-xs text-muted">{strength === 0 ? t('login.too_short') : strength === 1 ? t('login.strength_weak') : strength === 2 ? t('login.strength_ok') : t('login.strength_strong')}</span>
            </div>
          )}
          <Field label={t('login.confirm')} error={error}>
            <Input type={show ? 'text' : 'password'} autoComplete="new-password" value={pw2} onChange={(e) => { setPw2(e.target.value); setError(null) }} />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!pw || !pw2}>{t('login.setup_submit')}</Button>
        </form>
      </Shell>
    )
  }

  return (
    <Shell>
      <h1 className="text-lg font-semibold">{t('login.title')}</h1>
      <p className="mt-1 text-[13px] text-muted">{t('login.subtitle')}</p>
      {flash === 'pw_changed' && <Banner tone="ok" className="mt-4">{t('login.pw_changed')}</Banner>}
      <form className="mt-5 space-y-4" onSubmit={(e) => { e.preventDefault(); if (!left) void submitLogin() }}>
        <Field label={t('login.password')} error={left ? t('login.rate_limited', { s: left }) : error}>
          <div className="relative">
            <Input type={show ? 'text' : 'password'} autoFocus autoComplete="current-password" value={pw} onChange={(e) => { setPw(e.target.value); setError(null) }} inputClassName="pr-10" disabled={left > 0} />
            {eye}
          </div>
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!pw || left > 0}>
          {left ? t('login.rate_limited', { s: left }) : t('login.submit')}
        </Button>
      </form>
      <p className="mt-5 text-xs leading-5 text-faint">
        {t('login.forgot', { cmd: '' }).replace(/\s*$/, '')} <code className="rounded bg-subtle px-1 py-0.5 text-[11.5px]">{t('login.reset_cmd')}</code>
      </p>
    </Shell>
  )
}
