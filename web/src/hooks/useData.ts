import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { qk } from '../lib/queryClient'
import type { AuthStatus, Dashboard, PipelineStatus, Recorder, Room, Settings, SettingsGroup, Speaker, SystemInfo } from '../lib/types'
import { allTimezones, browserTz, dateKey, dayRange, formatClock, formatDateTime, formatDayLabel, formatDuration, formatFull, friendlyDue, relativeTime, safeTz, type Lang } from '../lib/time'
import { useI18n } from '../i18n'
import { lsGet, lsSet } from '../lib/storage'
import { useSyncExternalStore } from 'react'

export function useAuthStatus() {
  return useQuery({ queryKey: qk.auth, queryFn: () => api.get<AuthStatus>('/auth/status', undefined, { quiet401: true }), staleTime: 60_000 })
}

export function useSettings(enabled = true) {
  return useQuery({ queryKey: qk.settings, queryFn: () => api.get<Settings>('/settings'), enabled, staleTime: 60_000 })
}

/** PUT one settings group (partial deep merge) and refresh the cache with the server's answer. */
export function useSaveSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<Record<SettingsGroup, unknown>>) => api.put<Settings>('/settings', patch),
    onSuccess: (data) => {
      qc.setQueryData(qk.settings, data)
      void qc.invalidateQueries({ queryKey: qk.pipeline })
    },
  })
}

export function useSpeakers(enabled = true) {
  return useQuery({ queryKey: qk.speakers, queryFn: () => api.get<Speaker[]>('/speakers'), enabled, staleTime: 20_000 })
}
export function useRooms() {
  return useQuery({ queryKey: qk.rooms, queryFn: () => api.get<Room[]>('/rooms'), staleTime: 60_000 })
}
export function useRecorders(refetchMs?: number | false) {
  return useQuery({ queryKey: qk.recorders, queryFn: () => api.get<Recorder[]>('/recorders'), refetchInterval: refetchMs || false, staleTime: 5_000 })
}
export function useDashboard() {
  return useQuery({ queryKey: qk.dashboard, queryFn: () => api.get<Dashboard>('/dashboard'), refetchInterval: 30_000 })
}
export function usePipeline(refetchMs: number | false = 15_000) {
  return useQuery({ queryKey: qk.pipeline, queryFn: () => api.get<PipelineStatus>('/pipeline/status'), refetchInterval: refetchMs, staleTime: 5_000 })
}
export function useSystemInfo(refetchMs: number | false = false) {
  return useQuery({ queryKey: qk.system, queryFn: () => api.get<SystemInfo>('/system/info'), refetchInterval: refetchMs, staleTime: 60_000 })
}

// ---- "Who am I" (browser-local personal view) ----
const meListeners = new Set<() => void>()
export function useMe(): [number | null, (id: number | null) => void] {
  const raw = useSyncExternalStore(
    (cb) => { meListeners.add(cb); return () => { meListeners.delete(cb) } },
    () => lsGet('murmur.me'),
  )
  const id = raw ? parseInt(raw, 10) : null
  return [Number.isFinite(id) ? id : null, (v) => { lsSet('murmur.me', v == null ? null : String(v)); meListeners.forEach((f) => f()) }]
}

// ---- Formatting bound to the server timezone and UI language ----
export interface Fmt {
  tz: string
  lang: Lang
  browserTz: string
  clock: (iso: string, seconds?: boolean) => string
  dateTime: (iso: string) => string
  full: (iso: string) => string
  due: (iso: string) => string
  relative: (iso: string, now?: number) => string
  duration: (s: number) => string
  day: (key: string, year?: boolean) => string
  dateKey: (iso: string | number) => string
  today: () => string
  range: (key: string) => { from: string; to: string }
}

export function useFmt(): Fmt {
  const { lang } = useI18n()
  const settings = useSettings(false)
  const tz = safeTz(settings.data?.general.timezone ?? browserTz())
  return useMemo<Fmt>(() => ({
    tz, lang, browserTz: browserTz(),
    clock: (iso, s) => formatClock(iso, tz, s),
    dateTime: (iso) => formatDateTime(iso, tz, lang),
    full: (iso) => formatFull(iso, tz),
    due: (iso) => friendlyDue(iso, tz, lang),
    relative: (iso, now = Date.now()) => relativeTime(iso, now, lang),
    duration: (s) => formatDuration(s, lang),
    day: (key, year) => formatDayLabel(key, lang, year),
    dateKey: (iso) => dateKey(iso, tz),
    today: () => dateKey(Date.now(), tz),
    range: (key) => dayRange(key, tz),
  }), [tz, lang])
}

export const timezoneList = allTimezones

// ---- Speaker naming ----
export function useSpeakerLookup() {
  const { t } = useI18n()
  const { data } = useSpeakers()
  return useMemo(() => {
    const map = new Map<number, Speaker>()
    for (const s of data ?? []) map.set(s.id, s)
    const label = (id: number | null | undefined, fallback?: string | null): string => {
      if (id == null) return t('speaker.unknown')
      const sp = map.get(id)
      if (sp) return sp.name?.trim() ? sp.name : t('speaker.unnamed', { id })
      return fallback || t('speaker.unnamed', { id })
    }
    return { map, label, list: data ?? [] }
  }, [data, t])
}
