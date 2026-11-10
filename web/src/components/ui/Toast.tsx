import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, Check, Copy, X } from 'lucide-react'
import { ApiError, NetworkError } from '../../lib/api'
import { cn } from '../../lib/cn'
import { useT } from '../../i18n'

interface ToastItem {
  id: number
  kind: 'success' | 'undo' | 'error'
  message: ReactNode
  code?: string
  count: number
  onUndo?: () => void
  copyText?: string
}

interface ToastApi {
  success: (message: ReactNode, ttl?: number) => void
  undo: (message: ReactNode, onUndo: () => void) => void
  error: (err: unknown, fallback?: string) => void
}

const Ctx = createContext<ToastApi | null>(null)
let seq = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT()
  const [items, setItems] = useState<ToastItem[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    setItems((l) => l.filter((x) => x.id !== id))
    const tm = timers.current.get(id)
    if (tm) { clearTimeout(tm); timers.current.delete(id) }
  }, [])

  const push = useCallback((item: Omit<ToastItem, 'id' | 'count'>, ttl: number | null) => {
    const id = seq++
    setItems((l) => {
      // Merge identical error codes into one toast with a counter.
      if (item.kind === 'error' && item.code) {
        const ex = l.find((x) => x.kind === 'error' && x.code === item.code && x.message === item.message)
        if (ex) return l.map((x) => (x === ex ? { ...x, count: x.count + 1 } : x))
      }
      return [...l.slice(-4), { ...item, id, count: 1 }]
    })
    if (ttl) timers.current.set(id, setTimeout(() => dismiss(id), ttl))
  }, [dismiss])

  const api = useMemo<ToastApi>(() => ({
    success: (message, ttl = 3000) => push({ kind: 'success', message }, ttl),
    undo: (message, onUndo) => push({ kind: 'undo', message, onUndo }, 6000),
    error: (err, fallback) => {
      if (err instanceof NetworkError) {
        push({ kind: 'error', message: t('common.error_network'), code: 'network' }, null)
        return
      }
      const detail = err instanceof ApiError ? err.detail : err instanceof Error ? err.message : fallback ?? t('common.error_generic')
      const code = err instanceof ApiError ? err.code : undefined
      push({ kind: 'error', message: detail, code, copyText: [detail, code].filter(Boolean).join(' · ') }, null)
    },
  }), [push, t])

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 z-[85] flex flex-col gap-2 px-4 max-sm:top-[calc(env(safe-area-inset-top)+var(--banner-h,0px)+8px)] sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[380px] sm:px-0"
        role="region"
        aria-label="Notifications"
        aria-live="polite"
      >
        {items.map((it) => (
          <div
            key={it.id}
            role={it.kind === 'error' ? 'alert' : 'status'}
            className={cn(
              'pointer-events-auto flex animate-toast-in items-start gap-2.5 rounded-xl border bg-surface px-3.5 py-3 text-[13.5px] shadow-pop',
              it.kind === 'error' ? 'border-danger/40' : 'border-line',
            )}
          >
            <span className={cn('mt-0.5 shrink-0', it.kind === 'error' ? 'text-danger' : 'text-ok')}>
              {it.kind === 'error' ? <AlertCircle className="h-4 w-4" /> : <Check className="h-4 w-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="break-words leading-5">
                {it.message}
                {it.count > 1 && <span className="ml-1.5 text-xs text-muted">{t('toast.error_count', { n: it.count })}</span>}
              </p>
              {it.kind === 'error' && it.code && <p className="mt-0.5 font-mono text-[11px] text-faint">{it.code}</p>}
              {it.kind === 'error' && it.copyText && (
                <button
                  className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
                  onClick={() => { void navigator.clipboard?.writeText(it.copyText!) }}
                >
                  <Copy className="h-3 w-3" /> {t('common.copy_details')}
                </button>
              )}
            </div>
            {it.kind === 'undo' && it.onUndo && (
              <button
                className="shrink-0 rounded-md px-2 py-0.5 text-[13px] font-medium text-accent hover:bg-accent-soft"
                onClick={() => { it.onUndo?.(); dismiss(it.id) }}
              >
                {t('common.undo')}
              </button>
            )}
            {it.kind === 'error' && (
              <button className="shrink-0 rounded-md p-0.5 text-muted hover:bg-hover hover:text-fg" onClick={() => dismiss(it.id)} aria-label={t('common.close')}>
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export function useToast(): ToastApi {
  const c = useContext(Ctx)
  if (!c) throw new Error('ToastProvider missing')
  return c
}
