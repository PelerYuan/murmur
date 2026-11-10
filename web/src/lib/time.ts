// Timezone-aware date helpers. Everything is rendered in the *server's* configured timezone
// (settings.general.timezone), never the browser's. Implemented on top of Intl, no date library.

export type Lang = 'zh' | 'en'

const dtfCache = new Map<string, Intl.DateTimeFormat>()

export function safeTz(tz: string | undefined | null): string {
  if (!tz) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return 'UTC'
  }
}

function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    dtfCache.set(tz, f)
  }
  return f
}

export interface Parts { year: number; month: number; day: number; hour: number; minute: number; second: number }

export function toMs(v: string | number | Date): number {
  return v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v)
}

export function localParts(v: string | number | Date, tz: string): Parts {
  const out: Record<string, number> = {}
  for (const p of dtf(safeTz(tz)).formatToParts(new Date(toMs(v)))) {
    if (p.type !== 'literal') out[p.type] = parseInt(p.value, 10)
  }
  // Some engines report midnight as 24 even with h23.
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second }
}

/** Offset (ms) of `tz` from UTC at the given instant. */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = localParts(ms, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(ms / 1000) * 1000
}

/** Convert a wall-clock time in `tz` to a UTC instant (ms). Handles DST gaps/overlaps. */
export function zonedToUtcMs(p: Parts, tz: string): number {
  const guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  const o1 = tzOffsetMs(guess, tz)
  let t = guess - o1
  const o2 = tzOffsetMs(t, tz)
  if (o2 !== o1) t = guess - o2
  return t
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** 'YYYY-MM-DD' of the instant in tz. */
export function dateKey(v: string | number | Date, tz: string): string {
  const p = localParts(v, tz)
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`
}

export function parseKey(key: string): { year: number; month: number; day: number } {
  const [y, m, d] = key.split('-').map((x) => parseInt(x, 10))
  return { year: y, month: m, day: d }
}

export function addDaysKey(key: string, n: number): string {
  const { year, month, day } = parseKey(key)
  const d = new Date(Date.UTC(year, month - 1, day + n))
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export function dayDiff(a: string, b: string): number {
  const pa = parseKey(a), pb = parseKey(b)
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / 86400000)
}

/** UTC [from, to) range of a local calendar day. 23/25-hour days on DST changes are handled. */
export function dayRange(key: string, tz: string): { from: string; to: string; fromMs: number; toMs: number } {
  const a = parseKey(key)
  const b = parseKey(addDaysKey(key, 1))
  const fromMs = zonedToUtcMs({ ...a, hour: 0, minute: 0, second: 0 }, tz)
  const toMsV = zonedToUtcMs({ ...b, hour: 0, minute: 0, second: 0 }, tz)
  return { from: new Date(fromMs).toISOString(), to: new Date(toMsV).toISOString(), fromMs, toMs: toMsV }
}

export function todayKey(nowMs: number, tz: string): string {
  return dateKey(nowMs, tz)
}

export function formatClock(v: string | number | Date, tz: string, seconds = false): string {
  const p = localParts(v, tz)
  return seconds ? `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` : `${pad(p.hour)}:${pad(p.minute)}`
}

const locale = (lang: Lang) => (lang === 'zh' ? 'zh-CN' : 'en-US')

/** e.g. zh "11月11日 周三", en "Wed, Nov 11". `key` is a local calendar date. */
export function formatDayLabel(key: string, lang: Lang, withYear = false): string {
  const { year, month, day } = parseKey(key)
  const d = new Date(Date.UTC(year, month - 1, day, 12))
  return new Intl.DateTimeFormat(locale(lang), {
    timeZone: 'UTC',
    ...(withYear ? { year: 'numeric' } : {}),
    month: lang === 'zh' ? 'long' : 'short',
    day: 'numeric',
    weekday: lang === 'zh' ? 'short' : 'short',
  }).format(d)
}

/** Short month/day, e.g. "11月11日" / "Nov 11". */
export function formatMonthDay(key: string, lang: Lang): string {
  const { year, month, day } = parseKey(key)
  return new Intl.DateTimeFormat(locale(lang), { timeZone: 'UTC', month: lang === 'zh' ? 'long' : 'short', day: 'numeric' }).format(new Date(Date.UTC(year, month - 1, day, 12)))
}

/** "14:02" for today, "11月10日 14:02" for other days, with the year when it differs from now. */
export function formatDateTime(v: string | number | Date, tz: string, lang: Lang, nowMs: number = Date.now()): string {
  const k = dateKey(v, tz)
  const nk = dateKey(nowMs, tz)
  const clock = formatClock(v, tz)
  if (k === nk) return clock
  const sameYear = k.slice(0, 4) === nk.slice(0, 4)
  return `${sameYear ? formatMonthDay(k, lang) : k} ${clock}`
}

/** "2026-11-11 14:02:11 (Asia/Shanghai)" — for hover titles. */
export function formatFull(v: string | number | Date, tz: string): string {
  return `${dateKey(v, tz)} ${formatClock(v, tz, true)} (${safeTz(tz)})`
}

export function relativeTime(v: string | number | Date, nowMs: number, lang: Lang): string {
  const diff = Math.round((toMs(v) - nowMs) / 1000)
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat(locale(lang), { numeric: 'auto' })
  if (abs < 45) return lang === 'zh' ? '刚刚' : 'just now'
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day')
  return rtf.format(Math.round(diff / (86400 * 30)), 'month')
}

/** Compact duration: "45 秒", "18 分钟", "3 小时 12 分钟" / "45 s", "18 min", "3 h 12 min". */
export function formatDuration(seconds: number, lang: Lang): string {
  const s = Math.max(0, Math.round(seconds))
  const u = lang === 'zh' ? { s: ' 秒', m: ' 分钟', h: ' 小时' } : { s: ' s', m: ' min', h: ' h' }
  if (s < 60) return `${s}${u.s}`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}${u.m}`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem ? `${h}${u.h} ${rem}${u.m}` : `${h}${u.h}`
}

/** Short duration for overdue labels: minutes / hours / days. */
export function formatSpan(ms: number, lang: Lang): string {
  const m = Math.max(1, Math.round(ms / 60000))
  if (m < 60) return lang === 'zh' ? `${m} 分钟` : `${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return lang === 'zh' ? `${h} 小时` : `${h} h`
  const d = Math.round(h / 24)
  return lang === 'zh' ? `${d} 天` : `${d} d`
}

/** Friendly due label: "今天 15:00", "明天 09:00", "昨天 18:00", "11月20日 09:00". */
export function friendlyDue(v: string | number | Date, tz: string, lang: Lang, nowMs: number = Date.now()): string {
  const k = dateKey(v, tz)
  const diff = dayDiff(dateKey(nowMs, tz), k)
  const clock = formatClock(v, tz)
  const words: Record<number, [string, string]> = { 0: ['今天', 'Today'], 1: ['明天', 'Tomorrow'], [-1]: ['昨天', 'Yesterday'] }
  const w = words[diff]
  if (w) return `${lang === 'zh' ? w[0] : w[1]} ${clock}`
  const sameYear = k.slice(0, 4) === dateKey(nowMs, tz).slice(0, 4)
  return `${sameYear ? formatMonthDay(k, lang) : k} ${clock}`
}

/** Value for <input type="datetime-local"> showing `iso` in tz. */
export function toLocalInput(iso: string | null | undefined, tz: string): string {
  if (!iso) return ''
  const p = localParts(iso, tz)
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}

/** Parse a <input type="datetime-local"> value as wall-clock time in tz -> ISO UTC (or null). */
export function fromLocalInput(value: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!m) return null
  const ms = zonedToUtcMs({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: m[6] ? +m[6] : 0 }, tz)
  return new Date(ms).toISOString()
}

/** Minutes from now until the next 09:00 in tz (tomorrow if it is already past 09:00). */
export function minutesUntilNextMorning(nowMs: number, tz: string, hour = 9): number {
  const key = dateKey(nowMs, tz)
  const p = parseKey(key)
  let target = zonedToUtcMs({ ...p, hour, minute: 0, second: 0 }, tz)
  if (target <= nowMs + 60_000) {
    const n = parseKey(addDaysKey(key, 1))
    target = zonedToUtcMs({ ...n, hour, minute: 0, second: 0 }, tz)
  }
  return Math.max(1, Math.round((target - nowMs) / 60000))
}

/** Next occurrence of HH:mm (in tz) after now — used for "next daily summary" hints. */
export function nextDailyRun(nowMs: number, tz: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10))
  const key = dateKey(nowMs, tz)
  let t = zonedToUtcMs({ ...parseKey(key), hour: h || 0, minute: m || 0, second: 0 }, tz)
  if (t <= nowMs) t = zonedToUtcMs({ ...parseKey(addDaysKey(key, 1)), hour: h || 0, minute: m || 0, second: 0 }, tz)
  return t
}

export function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

export function allTimezones(): string[] {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf
    if (f) {
      const list = f('timeZone')
      return list.includes('UTC') ? list : ['UTC', ...list]
    }
  } catch { /* fall through */ }
  return ['UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles']
}
