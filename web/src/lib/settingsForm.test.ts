import { describe, expect, it } from 'vitest'
import { buildDiagnostics, classifyTestFailure, deepEqual, diffObject, getPath, isLlmConfigured, limitError, nextHourStart, parseFieldError, setPath, validateGroup } from './settingsForm'
import type { Settings } from './types'

describe('diffObject', () => {
  const saved = { a: 1, b: { c: 2, d: 'x' }, e: true }
  it('returns only changed leaves, nested', () => expect(diffObject(saved, { a: 1, b: { c: 3, d: 'x' }, e: true })).toEqual({ b: { c: 3 } }))
  it('returns undefined when nothing changed', () => expect(diffObject(saved, { ...saved, b: { ...saved.b } })).toBeUndefined())
  it('keeps the secret placeholder out of the patch only when untouched', () => {
    expect(diffObject({ api_key: '***', model: 'm' }, { api_key: '***', model: 'n' })).toEqual({ model: 'n' })
    expect(diffObject({ api_key: '***' }, { api_key: 'sk-new' })).toEqual({ api_key: 'sk-new' })
  })
})

describe('path helpers', () => {
  it('setPath is immutable and creates missing levels', () => {
    const o = { prompts: { summary: '' } }
    const n = setPath(o, 'prompts.summary', 'x')
    expect(n.prompts.summary).toBe('x')
    expect(o.prompts.summary).toBe('')
    expect(getPath(setPath({}, 'a.b.c', 1), 'a.b.c')).toBe(1)
  })
  it('deepEqual', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(deepEqual(NaN, NaN)).toBe(true)
  })
})

describe('parseFieldError', () => {
  it('splits "group.path: message" and strips the group prefix', () => {
    expect(parseFieldError('asr.timeout_seconds: Input should be greater than or equal to 5', 'asr')).toEqual({ path: 'timeout_seconds', message: 'Input should be greater than or equal to 5' })
    expect(parseFieldError('schedule.daily.time: Value error, schedule.daily.time must be HH:MM', 'schedule')).toEqual({ path: 'daily.time', message: 'schedule.daily.time must be HH:MM' })
  })
  it('returns null for another group or unstructured text', () => {
    expect(parseFieldError('llm.model: bad', 'asr')).toBeNull()
    expect(parseFieldError('Something broke', 'asr')).toBeNull()
  })
})

describe('numeric validation', () => {
  it('flags empty, out of range and non-integers', () => {
    expect(limitError('asr.timeout_seconds', NaN)).toBe('required')
    expect(limitError('asr.timeout_seconds', 2)).toBe('range')
    expect(limitError('asr.concurrency', 1.5)).toBe('int')
    expect(limitError('asr.timeout_seconds', 300)).toBeNull()
    expect(limitError('unknown.field', 5)).toBeNull()
  })
  it('validateGroup walks nested objects with relative paths', () => {
    expect(validateGroup('schedule', { incremental: { every_minutes: 0, min_utterances: 5 }, idle: { idle_minutes: 10 } })).toEqual({ 'incremental.every_minutes': 'range' })
    expect(validateGroup('filters', { min_confidence: 1.5, drop_non_speech: true })).toEqual({ min_confidence: 'range' })
  })
})

describe('test failure classification', () => {
  it('maps common failures to fixed suggestions', () => {
    expect(classifyTestFailure('Client error 401 Unauthorized')).toBe('auth')
    expect(classifyTestFailure('HTTP 404 Not Found')).toBe('not_found')
    expect(classifyTestFailure('Read timed out')).toBe('timeout')
    expect(classifyTestFailure('[Errno 111] Connection refused')).toBe('refused')
    expect(classifyTestFailure('getaddrinfo failed')).toBe('dns')
    expect(classifyTestFailure('weird')).toBe('unknown')
    expect(classifyTestFailure(undefined)).toBe('unknown')
  })
})

describe('misc settings helpers', () => {
  it('isLlmConfigured needs both base url and model', () => {
    expect(isLlmConfigured({ base_url: 'http://x', model: '' })).toBe(false)
    expect(isLlmConfigured({ base_url: ' http://x ', model: 'm' })).toBe(true)
  })
  it('nextHourStart is the next local hour boundary', () => {
    expect(new Date(nextHourStart(Date.parse('2026-11-11T06:30:00Z'), 'Asia/Shanghai')).toISOString()).toBe('2026-11-11T07:00:00.000Z')
    // 05:45 UTC is 11:15 in India (+5:30): the next local hour starts at 06:30 UTC
    expect(new Date(nextHourStart(Date.parse('2026-11-11T05:45:00Z'), 'Asia/Kolkata')).toISOString()).toBe('2026-11-11T06:30:00.000Z')
  })
})

describe('buildDiagnostics', () => {
  it('never contains a plaintext secret or a custom prompt body', () => {
    const settings = {
      general: { timezone: 'UTC', ui_language: 'zh', output_language: 'zh' },
      asr: { mode: 'openai', base_url: 'http://a', api_key: 'sk-secret-asr', model: '', language: 'auto', timeout_seconds: 5, concurrency: 1 },
      llm: { base_url: 'http://l', api_key: 'sk-secret-llm', model: 'm', temperature: 0.3, max_input_chars: 1, timeout_seconds: 5, prompts: { summary: 'PRIVATE PROMPT TEXT', daily: '', todos: '' } },
    } as unknown as Settings
    const out = buildDiagnostics({ settings, webVersion: '0.1.0', userAgent: 'ua', nowIso: '2026-11-11T00:00:00Z' })
    expect(out).not.toContain('sk-secret')
    expect(out).not.toContain('PRIVATE PROMPT TEXT')
    expect(out).toContain('"api_key": "***"')
    expect(out).toContain('<custom 19 chars>')
  })
})
