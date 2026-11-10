import type { PipelineStatus, Settings, SystemInfo } from './types'
import { localParts, zonedToUtcMs } from './time'

export const SECRET = '***'

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** Nested object holding only the leaves where `draft` differs from `saved`; undefined when nothing changed. */
export function diffObject(saved: unknown, draft: unknown): Record<string, unknown> | undefined {
  if (typeof draft !== 'object' || draft === null || typeof saved !== 'object' || saved === null) return undefined
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(draft as object)) {
    const d = (draft as Record<string, unknown>)[k]
    const s = (saved as Record<string, unknown>)[k]
    if (typeof d === 'object' && d !== null && !Array.isArray(d)) {
      const sub = diffObject(s, d)
      if (sub) out[k] = sub
    } else if (!deepEqual(s, d)) out[k] = d
  }
  return Object.keys(out).length ? out : undefined
}

/** Immutable set by dotted path ("llm.prompts.summary" relative to the group: "prompts.summary"). */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.')
  const cur = obj as unknown as Record<string, unknown>
  return { ...cur, [head]: rest.length ? setPath(cur[head] ?? {}, rest.join('.'), value) : value } as unknown as T
}

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj)
}

/** Server validation detail is "group.path.to.field: message"; split it so it can sit under the field. */
export function parseFieldError(detail: string, group: string): { path: string; message: string } | null {
  const m = /^([a-z_]+(?:\.[a-z_]+)*):\s*(.+)$/s.exec(detail)
  if (!m) return null
  const [, full, message] = m
  const prefix = `${group}.`
  if (!full.startsWith(prefix)) return null
  return { path: full.slice(prefix.length), message: message.replace(/^Value error,\s*/, '') }
}

/** Client-side numeric limits (the server is still the authority; these catch typos before the round-trip). */
export const LIMITS: Record<string, { min: number; max?: number; int?: boolean }> = {
  'asr.timeout_seconds': { min: 5, max: 3600, int: true },
  'asr.concurrency': { min: 1, max: 16, int: true },
  'llm.temperature': { min: 0, max: 2 },
  'llm.max_input_chars': { min: 1000, int: true },
  'llm.timeout_seconds': { min: 5, max: 3600, int: true },
  'speakers.match_threshold': { min: 0, max: 1 },
  'speakers.cluster_threshold': { min: 0, max: 1 },
  'speakers.sample_count': { min: 1, max: 20, int: true },
  'speakers.sample_seconds': { min: 1, max: 30 },
  'speakers.min_utterance_seconds': { min: 0, max: 10 },
  'filters.min_confidence': { min: 0, max: 1 },
  'filters.min_text_chars': { min: 0, max: 100, int: true },
  'retention.failed_audio_days': { min: 0, max: 3650, int: true },
  'retention.utterance_embedding_days': { min: 0, max: 3650, int: true },
  'schedule.incremental.every_minutes': { min: 1, max: 1440, int: true },
  'schedule.incremental.min_utterances': { min: 1, max: 1000, int: true },
  'schedule.idle.idle_minutes': { min: 1, max: 1440, int: true },
  'todos.every_minutes': { min: 1, max: 1440, int: true },
  'todos.min_confidence': { min: 0, max: 1 },
  'todos.default_remind_before_minutes': { min: 0, max: 10080, int: true },
}

export function limitError(fullPath: string, v: number): 'required' | 'range' | 'int' | null {
  if (!Number.isFinite(v)) return 'required'
  const l = LIMITS[fullPath]
  if (!l) return null
  if (l.int && !Number.isInteger(v)) return 'int'
  if (v < l.min || (l.max != null && v > l.max)) return 'range'
  return null
}

/** Validate every known numeric leaf of one group; returns { "path": 'range' | ... } relative to the group. */
export function validateGroup(group: string, draft: unknown): Record<string, 'required' | 'range' | 'int'> {
  const errs: Record<string, 'required' | 'range' | 'int'> = {}
  const walk = (o: unknown, path: string) => {
    if (typeof o === 'number') {
      const e = limitError(`${group}.${path}`, o)
      if (e) errs[path] = e
    } else if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k)
    }
  }
  walk(draft, '')
  return errs
}

export type TestFailure = 'refused' | 'timeout' | 'auth' | 'not_found' | 'dns' | 'unknown'

/** Map a raw failure detail from the test endpoints to one of the fixed suggestions. */
export function classifyTestFailure(detail: string | null | undefined): TestFailure {
  const d = (detail ?? '').toLowerCase()
  if (/\b(401|403)\b|unauthor|forbidden|invalid.*key|api key/.test(d)) return 'auth'
  if (/\b404\b|not found/.test(d)) return 'not_found'
  if (/timed? ?out|timeout/.test(d)) return 'timeout'
  if (/refused|errno 111|connect call failed|all connection attempts failed/.test(d)) return 'refused'
  if (/name or service not known|nodename|getaddrinfo|resolve/.test(d)) return 'dns'
  return 'unknown'
}

export function isLlmConfigured(s: Pick<Settings['llm'], 'base_url' | 'model'>): boolean {
  return s.base_url.trim() !== '' && s.model.trim() !== ''
}

/** Start of the next full hour in tz (hour boundaries only differ from UTC on :30/:45 zones). */
export function nextHourStart(nowMs: number, tz: string): number {
  const p = localParts(nowMs, tz)
  return zonedToUtcMs({ ...p, minute: 0, second: 0 }, tz) + 3_600_000
}

function redact(v: unknown, key = ''): unknown {
  if (typeof v === 'string' && /key|token|secret|password/i.test(key)) return v === '' ? '' : '***'
  if (Array.isArray(v)) return v.map((x) => redact(x, key))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]))
  return v
}

/** Text the user can paste into a bug report: versions, redacted settings, pipeline counters. */
export function buildDiagnostics(input: { settings?: Settings; system?: SystemInfo; pipeline?: PipelineStatus; webVersion: string; userAgent: string; nowIso: string }): string {
  const s = input.settings ? (redact(input.settings) as Settings) : undefined
  if (s) s.llm.prompts = Object.fromEntries(Object.entries(s.llm.prompts).map(([k, v]) => [k, v ? `<custom ${v.length} chars>` : ''])) as Settings['llm']['prompts']
  const lines = [
    `murmur web ${input.webVersion}`,
    `core ${input.system?.version ?? '?'} role=${input.system?.role ?? '?'} uptime=${input.system?.uptime_seconds ?? '?'}s disk_free=${input.system?.disk_free_bytes ?? '?'}`,
    `time ${input.nowIso}`,
    `ua ${input.userAgent}`,
    '',
    '## pipeline',
    JSON.stringify(input.pipeline ?? null, null, 2),
    '',
    '## settings (secrets redacted)',
    JSON.stringify(s ?? null, null, 2),
  ]
  return lines.join('\n')
}

export type { Json }
