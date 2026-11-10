import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { qk } from '../lib/queryClient'
import { addDaysKey, parseKey } from '../lib/time'
import type { DayCount } from '../lib/types'
import { useFmt } from '../hooks/useData'
import { cn } from '../lib/cn'
import { useI18n } from '../i18n'

const pad = (n: number) => String(n).padStart(2, '0')

/** Month grid; dots mark days that have utterances (GET /utterances/days). Works purely on YYYY-MM-DD keys. */
export function DayPicker({ value, onPick, max }: { value: string; onPick: (key: string) => void; max: string }) {
  const { lang, t } = useI18n()
  const fmt = useFmt()
  const init = parseKey(value)
  const [view, setView] = useState({ y: init.year, m: init.month })
  useEffect(() => { const p = parseKey(value); setView({ y: p.year, m: p.month }) }, [value])
  const first = `${view.y}-${pad(view.m)}-01`
  const next = view.m === 12 ? `${view.y + 1}-01-01` : `${view.y}-${pad(view.m + 1)}-01`
  const range = { from: fmt.range(first).from, to: fmt.range(addDaysKey(next, 0)).from }
  const days = useQuery({
    queryKey: [...qk.days, range.from, range.to],
    queryFn: () => api.get<DayCount[]>('/utterances/days', { from: range.from, to: range.to }),
    staleTime: 60_000,
  })
  const counts = useMemo(() => new Map((days.data ?? []).map((d) => [d.date, d.count])), [days.data])
  const lead = new Date(Date.UTC(view.y, view.m - 1, 1)).getUTCDay()
  const total = new Date(Date.UTC(view.y, view.m, 0)).getUTCDate()
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: total }, (_, i) => `${view.y}-${pad(view.m)}-${pad(i + 1)}`)]
  const title = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(view.y, view.m - 1, 1)))
  const wd = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + i))))
  const shift = (d: number) => setView((v) => { const n = v.y * 12 + (v.m - 1) + d; return { y: Math.floor(n / 12), m: (n % 12) + 1 } })
  return (
    <div className="w-[280px] p-3">
      <div className="mb-2 flex items-center justify-between">
        <button type="button" onClick={() => shift(-1)} aria-label={t('common.prev')} className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-hover"><ChevronLeft className="h-4 w-4" /></button>
        <span className="text-sm font-medium" aria-live="polite">{title}</span>
        <button type="button" onClick={() => shift(1)} aria-label={t('common.next')} className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-hover"><ChevronRight className="h-4 w-4" /></button>
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] text-faint">{wd.map((w, i) => <span key={i} className="py-1">{w}</span>)}</div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center">
        {cells.map((k, i) => {
          if (!k) return <span key={`e${i}`} />
          const has = counts.has(k)
          const sel = k === value
          const disabled = k > max
          return (
            <button
              key={k}
              type="button"
              disabled={disabled}
              onClick={() => onPick(k)}
              aria-label={`${fmt.day(k, true)}${has ? ` · ${t('timeline.has_data')}` : ''}`}
              aria-pressed={sel}
              className={cn(
                'relative mx-auto flex h-9 w-9 items-center justify-center rounded-full text-[13px] tabular transition-colors',
                sel ? 'bg-accent text-accent-fg' : k === max ? 'font-semibold text-accent hover:bg-hover' : 'hover:bg-hover',
                disabled && 'cursor-not-allowed text-faint/50 hover:bg-transparent',
              )}
            >
              {Number(k.slice(8))}
              {has && <span className={cn('absolute bottom-1 h-1 w-1 rounded-full', sel ? 'bg-accent-fg' : 'bg-accent')} />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
