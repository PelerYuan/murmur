import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { queryClient, qk } from './lib/queryClient'
import { onUnauthorized, rememberNext } from './lib/api'
import { I18nProvider, useT } from './i18n'
import { ThemeProvider } from './lib/theme'
import { EventsProvider } from './lib/events'
import { ToastProvider } from './components/ui/Toast'
import { AudioProvider } from './components/AudioPlayer'
import { ReminderProvider } from './components/reminders/ReminderCenter'
import { AppShell, ShellProviders } from './components/shell/AppShell'
import { useAuthStatus, useSettings } from './hooks/useData'
import { useOnboarding } from './hooks/useOnboarding'
import { Skeleton } from './components/ui/Misc'
import { Button } from './components/ui/Button'
import { ErrorBoundary, NotFound } from './components/ErrorBoundary'
import Login from './pages/Login'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const Timeline = lazy(() => import('./pages/Timeline'))
const Summaries = lazy(() => import('./pages/Summaries'))
const Todos = lazy(() => import('./pages/Todos'))
const Speakers = lazy(() => import('./pages/Speakers'))
const SpeakerDetail = lazy(() => import('./pages/SpeakerDetail'))
const Recorders = lazy(() => import('./pages/Recorders'))
const Settings = lazy(() => import('./pages/Settings'))
const Welcome = lazy(() => import('./pages/Welcome'))

function PageFallback() {
  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-6 sm:px-6" aria-busy>
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

function Splash() {
  return <div className="flex h-dvh items-center justify-center bg-bg"><Skeleton className="h-10 w-10 rounded-xl" /></div>
}

/** 401 anywhere → remember the current path and go to /login (no toast). */
function UnauthorizedHandler() {
  const nav = useNavigate()
  const loc = useLocation()
  const qc = useQueryClient()
  const here = useRef(loc)
  here.current = loc
  useEffect(() => onUnauthorized(() => {
    const l = here.current
    if (l.pathname.startsWith('/login')) return
    const path = l.pathname + l.search
    rememberNext(path)
    qc.setQueryData(qk.auth, { setup_required: false, authenticated: false })
    nav(`/login?next=${encodeURIComponent(path)}`, { replace: true })
  }), [nav, qc])
  return null
}

function RequireAuth({ children }: { children: ReactNode }) {
  const t = useT()
  const loc = useLocation()
  const status = useAuthStatus()
  const authed = !!status.data?.authenticated
  const settings = useSettings(authed)
  if (status.isLoading) return <Splash />
  if (status.isError) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg px-6 text-center">
        <p className="font-medium">{t('common.error_network')}</p>
        <Button onClick={() => void status.refetch()}>{t('common.retry')}</Button>
      </div>
    )
  }
  if (!authed) {
    const next = loc.pathname + loc.search
    return <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />
  }
  if (settings.isLoading) return <Splash />
  if (settings.isError) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg px-6 text-center">
        <p className="font-medium">{t('common.error_load')}</p>
        <Button onClick={() => void settings.refetch()}>{t('common.retry')}</Button>
      </div>
    )
  }
  return <>{children}</>
}

/** First landing on "/" in a session with unfinished required onboarding steps → /welcome. */
let firstVisitCache: boolean | null = null
/** Only the first visit of a browser session may be sent to the wizard; cached per page load so StrictMode double renders agree. */
function firstVisit(): boolean {
  if (firstVisitCache === null) {
    let f = true
    try { f = !sessionStorage.getItem('murmur.gate'); sessionStorage.setItem('murmur.gate', '1') } catch { /* ignore */ }
    firstVisitCache = f
  }
  return firstVisitCache
}

function HomeGate({ children }: { children: ReactNode }) {
  const ob = useOnboarding()
  const first = firstVisit()
  const [go, setGo] = useState<boolean | null>(null)
  useEffect(() => {
    if (go !== null || ob.loading) return
    setGo(first && !ob.dismissed && ob.requiredMissing)
  }, [go, ob.loading, ob.dismissed, ob.requiredMissing])
  if (go === null) return <Splash />
  if (go) return <Navigate to="/welcome" replace />
  return <>{children}</>
}

function AuthedProviders({ children }: { children: ReactNode }) {
  return (
    <EventsProvider>
      <ReminderProvider>
        <ShellProviders>{children}</ShellProviders>
      </ReminderProvider>
    </EventsProvider>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider>
          <ToastProvider>
            <AudioProvider>
              <BrowserRouter>
                <UnauthorizedHandler />
                <ErrorBoundary>
                  <Suspense fallback={<Splash />}>
                    <Routes>
                      <Route path="/login" element={<Login />} />
                      <Route
                        element={
                          <RequireAuth>
                            <AuthedProviders>
                              <Outlet />
                            </AuthedProviders>
                          </RequireAuth>
                        }
                      >
                        <Route path="/welcome" element={<Welcome />} />
                        <Route element={<AppShell />}>
                          <Route index element={<HomeGate><Suspense fallback={<PageFallback />}><Dashboard /></Suspense></HomeGate>} />
                          <Route path="timeline" element={<Suspense fallback={<PageFallback />}><Timeline /></Suspense>} />
                          <Route path="summaries" element={<Suspense fallback={<PageFallback />}><Summaries /></Suspense>} />
                          <Route path="todos" element={<Suspense fallback={<PageFallback />}><Todos /></Suspense>} />
                          <Route path="speakers" element={<Suspense fallback={<PageFallback />}><Speakers /></Suspense>} />
                          <Route path="speakers/:id" element={<Suspense fallback={<PageFallback />}><SpeakerDetail /></Suspense>} />
                          <Route path="recorders" element={<Suspense fallback={<PageFallback />}><Recorders /></Suspense>} />
                          <Route path="settings" element={<Suspense fallback={<PageFallback />}><Settings /></Suspense>} />
                          <Route path="settings/:section" element={<Suspense fallback={<PageFallback />}><Settings /></Suspense>} />
                          <Route path="*" element={<NotFound />} />
                        </Route>
                      </Route>
                    </Routes>
                  </Suspense>
                </ErrorBoundary>
              </BrowserRouter>
            </AudioProvider>
          </ToastProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
