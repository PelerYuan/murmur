import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Check, FileText, Keyboard, LayoutDashboard, ListChecks, LogOut, MessagesSquare, Mic, Monitor, Moon, MoreHorizontal,
  Settings as SettingsIcon, Sun, UserRound, Users, Volume2, VolumeX, Lock, WifiOff, HardDrive, Languages,
} from 'lucide-react'
import { api, onNetworkState } from '../../lib/api'
import { queryClient } from '../../lib/queryClient'
import { qk } from '../../lib/queryClient'
import { diskTone } from '../../lib/status'
import { useTheme, type ThemePref } from '../../lib/theme'
import { useSseConnected } from '../../lib/events'
import type { SystemInfo } from '../../lib/types'
import { useMe, useSaveSettings, useSettings, useSpeakers, useSpeakerLookup } from '../../hooks/useData'
import { useGlobalShortcuts } from '../../hooks/useShortcuts'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import { Menu } from '../ui/Popover'
import { IconButton } from '../ui/Button'
import { Banner } from '../ui/Misc'
import { useToast } from '../ui/Toast'
import { ReminderBanner, useReminders } from '../reminders/ReminderCenter'
import { UtteranceOpsProvider } from '../speakers/UtteranceOps'
import { SpeakerActionsProvider } from '../speakers/SpeakerActions'
import { LiveSync } from './LiveSync'
import { StatusIndicators } from './StatusIndicators'
import { PipelineDrawer } from './PipelineDrawer'
import { ChangePasswordDialog, ShortcutsDialog, WhoAmIDialog } from './Dialogs'

interface NavItem { to: string; key: 'nav.dashboard' | 'nav.timeline' | 'nav.summaries' | 'nav.todos' | 'nav.speakers' | 'nav.recorders' | 'nav.settings'; icon: ReactNode; end?: boolean }
const icon = 'h-[18px] w-[18px]'
const NAV: NavItem[] = [
  { to: '/', key: 'nav.dashboard', icon: <LayoutDashboard className={icon} />, end: true },
  { to: '/timeline', key: 'nav.timeline', icon: <MessagesSquare className={icon} /> },
  { to: '/summaries', key: 'nav.summaries', icon: <FileText className={icon} /> },
  { to: '/todos', key: 'nav.todos', icon: <ListChecks className={icon} /> },
  { to: '/speakers', key: 'nav.speakers', icon: <Users className={icon} /> },
  { to: '/recorders', key: 'nav.recorders', icon: <Mic className={icon} /> },
  { to: '/settings', key: 'nav.settings', icon: <SettingsIcon className={icon} /> },
]

function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" fill="rgb(var(--accent))" />
      <g fill="rgb(var(--accent-fg))">
        <rect x="6" y="13" width="3" height="6" rx="1.5" /><rect x="11" y="9" width="3" height="14" rx="1.5" />
        <rect x="16" y="6" width="3" height="20" rx="1.5" /><rect x="21" y="11" width="3" height="10" rx="1.5" />
      </g>
    </svg>
  )
}

function useBadges() {
  const reminders = useReminders()
  const speakers = useSpeakers()
  return useMemo(() => ({
    '/todos': { n: reminders.items.length, tone: 'danger' as const },
    '/speakers': { n: (speakers.data ?? []).filter((s) => s.state === 'unnamed' && s.utterance_count >= 5).length, tone: 'neutral' as const },
  }), [reminders.items.length, speakers.data]) as Record<string, { n: number; tone: 'danger' | 'neutral' }>
}

function Badge({ n, tone }: { n: number; tone: 'danger' | 'neutral' }) {
  if (!n) return null
  return (
    <span className={cn('tabular ml-auto inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold leading-[18px]', tone === 'danger' ? 'bg-danger text-white dark:text-bg' : 'bg-subtle text-muted')}>
      {n}
    </span>
  )
}

function Sidebar() {
  const { t } = useI18n()
  const badges = useBadges()
  return (
    <aside className="relative z-30 hidden w-14 shrink-0 sm:block lg:w-56" aria-label={t('nav.main')}>
      <nav className="group/nav absolute inset-y-0 left-0 flex w-14 flex-col overflow-hidden border-r border-line bg-surface transition-[width,box-shadow] duration-150 hover:w-56 hover:shadow-pop focus-within:w-56 lg:w-56 lg:shadow-none lg:hover:shadow-none">
        <div className="flex h-14 shrink-0 items-center gap-2.5 px-[14px]">
          <Logo className="h-7 w-7 shrink-0" />
          <span className="whitespace-nowrap text-[15px] font-semibold tracking-tight">Murmur</span>
        </div>
        <ul className="flex flex-1 flex-col gap-0.5 px-2 py-1">
          {NAV.map((it) => {
            const b = badges[it.to]
            return (
              <li key={it.to}>
                <NavLink
                  to={it.to}
                  end={it.end}
                  title={t(it.key)}
                  className={({ isActive }) => cn(
                    'flex h-9 items-center gap-3 whitespace-nowrap rounded-lg px-[10px] text-[13.5px] font-medium transition-colors',
                    isActive ? 'bg-hover text-fg' : 'text-muted hover:bg-hover hover:text-fg',
                  )}
                >
                  <span className="relative shrink-0">
                    {it.icon}
                    {b?.n ? <span className={cn('absolute -right-1 -top-1 h-2 w-2 rounded-full lg:hidden', b.tone === 'danger' ? 'bg-danger' : 'bg-faint')} /> : null}
                  </span>
                  <span>{t(it.key)}</span>
                  {b && <Badge {...b} />}
                </NavLink>
              </li>
            )
          })}
        </ul>
        <p className="whitespace-nowrap px-4 pb-3 text-[11px] text-faint">{t('app.tagline')}</p>
      </nav>
    </aside>
  )
}

function MobileTabBar() {
  const { t } = useI18n()
  const badges = useBadges()
  const nav = useNavigate()
  const loc = useLocation()
  const main = NAV.filter((n) => ['/', '/timeline', '/todos', '/speakers'].includes(n.to))
  const more = NAV.filter((n) => ['/summaries', '/recorders', '/settings'].includes(n.to))
  const moreActive = more.some((m) => loc.pathname.startsWith(m.to))
  return (
    <nav className="safe-bottom z-30 flex shrink-0 border-t border-line bg-surface sm:hidden" aria-label={t('nav.main')}>
      {main.map((it) => {
        const b = badges[it.to]
        return (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.end}
            className={({ isActive }) => cn('relative flex h-[54px] flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium', isActive ? 'text-accent' : 'text-muted')}
          >
            <span className="relative">
              {it.icon}
              {b?.n ? <span className={cn('tabular absolute -right-2.5 -top-1.5 min-w-[16px] rounded-full px-1 text-center text-[10px] leading-4', b.tone === 'danger' ? 'bg-danger text-white dark:text-bg' : 'bg-subtle text-muted')}>{b.n}</span> : null}
            </span>
            {t(it.key)}
          </NavLink>
        )
      })}
      <Menu
        label={t('nav.more')}
        placement="top-end"
        className="flex-1"
        items={more.map((m) => ({ label: t(m.key), icon: m.icon, onSelect: () => nav(m.to) }))}
        trigger={
          <button type="button" className={cn('flex h-[54px] w-full flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium', moreActive ? 'text-accent' : 'text-muted')}>
            <MoreHorizontal className={icon} />
            {t('nav.more')}
          </button>
        }
      />
    </nav>
  )
}

function pageTitleKey(path: string): NavItem['key'] | null {
  if (path === '/') return 'nav.dashboard'
  const m = NAV.find((n) => n.to !== '/' && path.startsWith(n.to))
  return m?.key ?? null
}

function TopBar({ onOpenQueue, onShortcuts, onWhoAmI, onPassword }: { onOpenQueue: () => void; onShortcuts: () => void; onWhoAmI: () => void; onPassword: () => void }) {
  const { t, lang, setLang } = useI18n()
  const { pref, setPref } = useTheme()
  const { muted, setMuted, soundUnlocked } = useReminders()
  const loc = useLocation()
  const nav = useNavigate()
  const toast = useToast()
  const save = useSaveSettings()
  const [me] = useMe()
  const { label } = useSpeakerLookup()
  const key = pageTitleKey(loc.pathname)

  const switchLang = (l: 'zh' | 'en') => {
    setLang(l)
    save.mutate({ general: { ui_language: l } }, { onError: (e) => toast.error(e) })
  }
  const logout = async () => {
    try { await api.post('/auth/logout') } catch { /* already out */ }
    queryClient.clear()
    nav('/login', { replace: true })
  }
  const themes: { v: ThemePref; label: string; icon: ReactNode }[] = [
    { v: 'system', label: t('topbar.theme_system'), icon: <Monitor className="h-4 w-4" /> },
    { v: 'light', label: t('topbar.theme_light'), icon: <Sun className="h-4 w-4" /> },
    { v: 'dark', label: t('topbar.theme_dark'), icon: <Moon className="h-4 w-4" /> },
  ]
  const ThemeIcon = pref === 'dark' ? Moon : pref === 'light' ? Sun : Monitor
  const mark = (on: boolean) => (on ? <Check className="h-4 w-4 text-accent" /> : <span className="h-4 w-4" />)

  return (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line bg-surface/90 px-2.5 backdrop-blur sm:gap-2 sm:px-5">
      <div className="flex min-w-0 items-center gap-2 sm:hidden max-[400px]:hidden">
        <Logo className="h-6 w-6 shrink-0" />
      </div>
      <h1 className="hidden min-w-0 flex-1 truncate text-[15px] font-semibold sm:block">{key ? t(key) : 'Murmur'}</h1>
      <div className="flex-1 sm:hidden" />
      <StatusIndicators onOpenQueue={onOpenQueue} />
      <div className="hidden w-px self-stretch bg-line sm:mx-1 sm:my-3.5 sm:block" />
      {!soundUnlocked && !muted && (
        <button
          type="button"
          onClick={() => undefined}
          className="hidden h-7 items-center gap-1.5 rounded-full bg-accent-soft px-2.5 text-xs font-medium text-accent md:inline-flex"
        >
          <Volume2 className="h-3.5 w-3.5" /> {t('topbar.enable_sound')}
        </button>
      )}
      <IconButton aria-label={muted ? t('topbar.mute_on') : t('topbar.mute_off')} onClick={() => setMuted(!muted)} className="hidden sm:inline-flex">
        {muted ? <VolumeX className="h-[18px] w-[18px]" /> : <Volume2 className="h-[18px] w-[18px]" />}
      </IconButton>
      <Menu
        label={t('topbar.theme')}
        items={themes.map((x) => ({ label: x.label, icon: mark(pref === x.v), onSelect: () => setPref(x.v) }))}
        trigger={<IconButton aria-label={t('topbar.theme')}><ThemeIcon className="h-[18px] w-[18px]" /></IconButton>}
      />
      <Menu
        label={t('topbar.language')}
        items={[
          { label: t('common.lang_zh'), icon: mark(lang === 'zh'), onSelect: () => switchLang('zh') },
          { label: t('common.lang_en'), icon: mark(lang === 'en'), onSelect: () => switchLang('en') },
        ]}
        trigger={<IconButton aria-label={t('topbar.language')}><Languages className="h-[18px] w-[18px]" /></IconButton>}
      />
      <Menu
        label={t('topbar.user')}
        items={[
          { label: <span>{t('topbar.who_am_i')} <span className="text-muted">· {me != null ? label(me) : t('topbar.who_none')}</span></span>, icon: <UserRound />, onSelect: onWhoAmI },
          { label: t('topbar.shortcuts'), icon: <Keyboard />, onSelect: onShortcuts },
          { label: t('topbar.change_password'), icon: <Lock />, onSelect: onPassword, divider: true },
          { label: t('topbar.logout'), icon: <LogOut />, onSelect: () => void logout() },
        ]}
        trigger={<IconButton aria-label={t('topbar.user')}><UserRound className="h-[18px] w-[18px]" /></IconButton>}
      />
    </header>
  )
}

export function AppShell() {
  const { t } = useI18n()
  const settings = useSettings()
  const { lang, setLang } = useI18n()
  const [queueOpen, setQueueOpen] = useState(false)
  const [help, setHelp] = useState(false)
  const [who, setWho] = useState(false)
  const [pw, setPw] = useState(false)
  const connected = useSseConnected()
  const [netDown, setNetDown] = useState(false)
  useGlobalShortcuts(useCallback(() => setHelp(true), []))
  useEffect(() => onNetworkState(setNetDown), [])
  useEffect(() => { const h = () => setQueueOpen(true); window.addEventListener('murmur:open-queue', h); return () => window.removeEventListener('murmur:open-queue', h) }, [])
  useEffect(() => { try { sessionStorage.setItem('murmur.gate', '1') } catch { /* ignore */ } }, [])

  // Server-side UI language wins after login and is mirrored into localStorage.
  const serverLang = settings.data?.general.ui_language
  useEffect(() => { if (serverLang && serverLang !== lang) setLang(serverLang) }, [serverLang]) // eslint-disable-line react-hooks/exhaustive-deps

  const sys = useQuery({ queryKey: qk.system, queryFn: () => api.get<SystemInfo>('/system/info'), refetchInterval: 300_000, staleTime: 60_000 })
  const diskLow = diskTone(sys.data?.disk_free_bytes) === 'danger'

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg">
      <a href="#main" className="sr-only z-[100] rounded-md bg-surface px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:left-2 focus:top-2">{t('common.skip_to_content')}</a>
      <ReminderBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar onOpenQueue={() => setQueueOpen(true)} onShortcuts={() => setHelp(true)} onWhoAmI={() => setWho(true)} onPassword={() => setPw(true)} />
          {(!connected || netDown || diskLow) && (
            <div className="shrink-0 space-y-1 border-b border-line bg-surface px-4 py-1.5 sm:px-6">
              {netDown && <p className="flex items-center gap-2 text-xs text-danger"><WifiOff className="h-3.5 w-3.5" /> {t('status.network_down')}</p>}
              {!connected && !netDown && <p className="flex items-center gap-2 text-xs text-muted"><WifiOff className="h-3.5 w-3.5" /> {t('status.realtime_lost')}</p>}
              {diskLow && <Banner tone="danger" className="!py-1.5"><span className="flex items-center gap-1.5"><HardDrive className="h-3.5 w-3.5" /> {t('status.disk_low')}</span></Banner>}
            </div>
          )}
          <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
            <Outlet />
          </main>
          <MobileTabBar />
        </div>
      </div>
      <PipelineDrawer open={queueOpen} onClose={() => setQueueOpen(false)} />
      <ShortcutsDialog open={help} onClose={() => setHelp(false)} />
      <WhoAmIDialog open={who} onClose={() => setWho(false)} />
      <ChangePasswordDialog open={pw} onClose={() => setPw(false)} />
      <LiveSync />
    </div>
  )
}

export function ShellProviders({ children }: { children: ReactNode }) {
  return <SpeakerActionsProvider><UtteranceOpsProvider>{children}</UtteranceOpsProvider></SpeakerActionsProvider>
}
