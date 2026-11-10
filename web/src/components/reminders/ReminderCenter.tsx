import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { BellRing, Check, ChevronDown, Clock } from 'lucide-react'
import { api } from '../../lib/api'
import { qk } from '../../lib/queryClient'
import { LeaderElection } from '../../lib/leader'
import { isReminderDue } from '../../lib/status'
import { installUnlockListener, isSoundUnlocked, onSoundUnlock, playChime } from '../../lib/sound'
import { formatSpan, minutesUntilNextMorning } from '../../lib/time'
import { lsGet, lsSet } from '../../lib/storage'
import type { Todo } from '../../lib/types'
import { useEvent, useSseConnected } from '../../lib/events'
import { useFmt } from '../../hooks/useData'
import { useNow } from '../../hooks/useNow'
import { useToast } from '../ui/Toast'
import { Button } from '../ui/Button'
import { Menu } from '../ui/Popover'
import { useT } from '../../i18n'
import { cn } from '../../lib/cn'

interface ReminderCtx {
  items: Todo[]
  muted: boolean
  setMuted: (m: boolean) => void
  soundUnlocked: boolean
  done: (t: Todo) => void
  snooze: (t: Todo, minutes: number) => void
  ack: (t: Todo) => void
}
const Ctx = createContext<ReminderCtx | null>(null)
export function useReminders(): ReminderCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('ReminderProvider missing')
  return c
}

const MAX_REPEATS = 5

export function ReminderProvider({ children }: { children: ReactNode }) {
  const t = useT()
  const fmt = useFmt()
  const qc = useQueryClient()
  const toast = useToast()
  const connected = useSseConnected()
  const [items, setItems] = useState<Map<number, Todo>>(new Map())
  const [muted, setMutedState] = useState(() => lsGet('murmur.reminder.mute') === '1')
  const [unlocked, setUnlocked] = useState(isSoundUnlocked)
  const leader = useRef<LeaderElection | null>(null)
  const seen = useRef(new Set<number>())
  const mutedRef = useRef(muted)
  mutedRef.current = muted

  useEffect(() => {
    installUnlockListener()
    return onSoundUnlock(() => setUnlocked(true))
  }, [])
  useEffect(() => {
    const l = new LeaderElection()
    l.start()
    leader.current = l
    return () => { l.stop(); leader.current = null }
  }, [])

  const setMuted = useCallback((m: boolean) => { lsSet('murmur.reminder.mute', m ? '1' : null); setMutedState(m) }, [])

  // ---- data flow: SSE primary + GET /reminders/due reconciliation ----
  const due = useQuery({
    queryKey: qk.reminders,
    queryFn: () => api.get<Todo[]>('/reminders/due'),
    refetchInterval: connected ? 60_000 : 30_000,
    staleTime: 0,
    refetchOnWindowFocus: true,
  })
  useEffect(() => {
    if (!due.data) return
    setItems(new Map(due.data.map((x) => [x.id, x])))
  }, [due.data])

  const reconcile = useCallback(() => { void qc.invalidateQueries({ queryKey: qk.reminders }) }, [qc])
  useEvent('open', reconcile)
  useEvent('reminder.due', (todo: Todo) => {
    setItems((m) => new Map(m).set(todo.id, todo))
  })
  useEvent(['todo.updated', 'todo.created'], (todo: Todo) => {
    setItems((m) => {
      const has = m.has(todo.id)
      if (!isReminderDue(todo, Date.now())) {
        if (!has) return m
        const n = new Map(m); n.delete(todo.id); return n
      }
      return has ? new Map(m).set(todo.id, todo) : m
    })
  })

  // ---- sound, repeats, system notifications ----
  const list = useMemo(() => [...items.values()].sort((a, b) => Date.parse(a.remind_at ?? '') - Date.parse(b.remind_at ?? '')), [items])
  const plays = useRef(0)
  useEffect(() => {
    const ids = list.map((x) => x.id)
    const fresh = list.filter((x) => !seen.current.has(x.id))
    ids.forEach((id) => seen.current.add(id))
    if (list.length === 0) { plays.current = 0; return }
    if (fresh.length > 0 && leader.current?.isLeader()) {
      if (!mutedRef.current && plays.current < MAX_REPEATS) { playChime(); plays.current++ }
      if (lsGet('murmur.reminder.notify') === '1' && window.isSecureContext && 'Notification' in window && Notification.permission === 'granted') {
        for (const f of fresh.slice(0, 3)) new Notification(t('reminder.title'), { body: f.text, tag: `murmur-${f.id}` })
      }
    }
  }, [list, t])
  useEffect(() => {
    if (list.length === 0) return
    const id = setInterval(() => {
      if (plays.current >= MAX_REPEATS) return
      if (!mutedRef.current && leader.current?.isLeader()) { playChime(); plays.current++ }
    }, 60_000)
    return () => clearInterval(id)
  }, [list.length])

  // ---- tab title flashing + favicon dot (always while something is due) ----
  useEffect(() => {
    if (list.length === 0) return
    const base = document.title
    const flash = t('reminder.title_flash', { n: list.length })
    const icon = document.querySelector<HTMLLinkElement>('link[rel~=icon]')
    const orig = icon?.href
    if (icon) icon.href = faviconWithDot()
    let on = false
    const tick = () => {
      if (document.hidden || !unlocked) { on = !on; document.title = on ? flash : base }
      else document.title = flash
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => { clearInterval(id); document.title = base; if (icon && orig) icon.href = orig }
  }, [list.length, unlocked, t])

  // ---- actions ----
  const remove = useCallback((id: number) => setItems((m) => { const n = new Map(m); n.delete(id); return n }), [])
  const finish = useCallback(() => {
    void qc.invalidateQueries({ queryKey: qk.todos })
    void qc.invalidateQueries({ queryKey: qk.dashboard })
    void qc.invalidateQueries({ queryKey: qk.reminders })
  }, [qc])
  const run = useCallback(async (todo: Todo, fn: () => Promise<unknown>, ok?: string) => {
    remove(todo.id)
    try { await fn(); if (ok) toast.success(ok) } catch (e) { setItems((m) => new Map(m).set(todo.id, todo)); toast.error(e) }
    finish()
  }, [remove, toast, finish])

  const value = useMemo<ReminderCtx>(() => ({
    items: list,
    muted,
    setMuted,
    soundUnlocked: unlocked,
    done: (todo) => void run(todo, () => api.patch(`/todos/${todo.id}`, { status: 'done' })),
    ack: (todo) => void run(todo, () => api.post(`/todos/${todo.id}/ack-reminder`), t('reminder.acked')),
    snooze: (todo, minutes) => void run(todo, () => api.post(`/todos/${todo.id}/snooze`, { minutes }), t('reminder.snoozed', { t: formatSpan(minutes * 60000, fmt.lang) })),
  }), [list, muted, setMuted, unlocked, run, t, fmt.lang])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

function faviconWithDot(): string {
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const g = c.getContext('2d')!
  g.fillStyle = '#4f46e5'
  g.beginPath(); g.roundRect(0, 0, 32, 32, 8); g.fill()
  g.fillStyle = '#fff'
  ;[[6, 13, 6], [11, 9, 14], [16, 6, 20], [21, 11, 10]].forEach(([x, y, h]) => { g.beginPath(); g.roundRect(x, y, 3, h, 1.5); g.fill() })
  g.fillStyle = '#ef4444'
  g.beginPath(); g.arc(25, 7, 7, 0, Math.PI * 2); g.fill()
  g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke()
  return c.toDataURL('image/png')
}

/** One reminder: text, due, assignee, excerpt, overdue marker and the three actions. */
export function ReminderCard({ todo, compact }: { todo: Todo; compact?: boolean }) {
  const t = useT()
  const fmt = useFmt()
  const now = useNow(30_000)
  const r = useReminders()
  const late = todo.remind_at ? now - Date.parse(todo.remind_at) : 0
  const snoozeItems = [
    { label: t('reminder.snooze_5'), onSelect: () => r.snooze(todo, 5) },
    { label: t('reminder.snooze_30'), onSelect: () => r.snooze(todo, 30) },
    { label: t('reminder.snooze_60'), onSelect: () => r.snooze(todo, 60) },
    { label: t('reminder.snooze_morning'), onSelect: () => r.snooze(todo, minutesUntilNextMorning(Date.now(), fmt.tz)) },
  ]
  return (
    <div className={cn('flex flex-wrap items-start gap-x-4 gap-y-2.5', compact ? 'py-2.5' : 'py-3')}>
      <Link to={`/todos?focus=${todo.id}`} className="min-w-0 flex-1 basis-60 rounded-md outline-offset-4">
        <p className="flex items-start gap-2 text-[14.5px] font-medium leading-6">
          <BellRing className="mt-1 h-4 w-4 shrink-0" aria-hidden />
          <span className="break-words">{todo.text}</span>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 pl-6 text-xs opacity-80">
          {todo.due_at && <span>{t('reminder.due', { t: fmt.due(todo.due_at) })}</span>}
          {todo.assignee_name && <span>· {todo.assignee_name}</span>}
          {late > 120_000 && <span className="font-medium">· {t('reminder.overdue', { t: formatSpan(late, fmt.lang) })}</span>}
        </p>
        {todo.source_excerpt && <p className={cn('mt-0.5 line-clamp-1 pl-6 text-xs italic opacity-70', compact && 'max-sm:hidden')}>“{todo.source_excerpt}”</p>}
      </Link>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} onClick={() => r.done(todo)}>{t('reminder.done')}</Button>
        <div className="inline-flex">
          <Button size="sm" className="rounded-r-none border-r-0" icon={<Clock className="h-3.5 w-3.5" />} onClick={() => r.snooze(todo, 10)}>{t('reminder.snooze10')}</Button>
          <Menu
            label={t('reminder.snooze_more')}
            items={snoozeItems}
            trigger={<button type="button" aria-label={t('reminder.snooze_more')} className="inline-flex h-8 w-7 items-center justify-center rounded-r-lg border border-line-strong bg-surface text-muted hover:bg-subtle max-sm:h-10"><ChevronDown className="h-3.5 w-3.5" /></button>}
          />
        </div>
        <Button size="sm" variant="ghost" onClick={() => r.ack(todo)}>{t('reminder.ack')}</Button>
      </div>
    </div>
  )
}

/** Fixed banner above every page. Shows 3 reminders, the rest folded. */
export function ReminderBanner() {
  const t = useT()
  const { items } = useReminders()
  const [expanded, setExpanded] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    const set = (h: number) => document.documentElement.style.setProperty('--banner-h', `${h}px`)
    if (!el) { set(0); return }
    const ro = new ResizeObserver(() => set(el.offsetHeight))
    ro.observe(el)
    set(el.offsetHeight)
    return () => { ro.disconnect(); set(0) }
  }, [items.length > 0])
  useEffect(() => { if (items.length <= 3) setExpanded(false) }, [items.length])
  if (items.length === 0) return null
  const shown = expanded ? items : items.slice(0, 3)
  return (
    <div ref={ref} role="alert" aria-live="assertive" className="z-[60] shrink-0 animate-fade-in border-b border-danger/30 bg-danger-soft text-fg">
      <div className="mx-auto max-w-6xl px-4 py-1 sm:px-6">
        <p className="pt-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-danger">{t('reminder.title_n', { n: items.length })}</p>
        <div className="divide-y divide-danger/15">
          {shown.map((x) => <ReminderCard key={x.id} todo={x} compact />)}
        </div>
        {items.length > 3 && (
          <button className="mb-1.5 text-xs font-medium text-danger hover:underline" onClick={() => setExpanded((e) => !e)}>
            {expanded ? t('reminder.collapse') : t('reminder.more', { n: items.length - 3 })}
          </button>
        )}
      </div>
    </div>
  )
}
