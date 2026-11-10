import { describe, expect, it } from 'vitest'
import { advError, applyStatus, bufferTone, buildSnippet, configInvalid, diffConfig, isLocalhostUrl, levelFraction, versionMismatch } from './recorderConfig'
import type { RecorderConfig } from './types'

const cfg: RecorderConfig = { enabled: true, device: null, gain_db: 0, vad_aggressiveness: 2, min_speech_ms: 300, end_silence_ms: 1200, max_chunk_seconds: 60, pre_roll_ms: 300 }

describe('config diff and validation', () => {
  it('sends only the changed keys', () => expect(diffConfig(cfg, { ...cfg, gain_db: 6, device: 'hw:1,0' })).toEqual({ gain_db: 6, device: 'hw:1,0' }))
  it('nothing changed means an empty patch', () => expect(diffConfig(cfg, { ...cfg })).toEqual({}))
  it('advanced ranges', () => {
    expect(advError('min_speech_ms', 99)).toBe(true)
    expect(advError('min_speech_ms', 100)).toBe(false)
    expect(advError('max_chunk_seconds', 121)).toBe(true)
    expect(advError('pre_roll_ms', 0)).toBe(false)
    expect(advError('end_silence_ms', NaN)).toBe(true)
    expect(advError('end_silence_ms', 1200.5)).toBe(true)
  })
  it('gain outside -20..30 invalidates the form', () => {
    expect(configInvalid(cfg)).toBe(false)
    expect(configInvalid({ ...cfg, gain_db: 31 })).toBe(true)
    expect(configInvalid({ ...cfg, gain_db: -21 })).toBe(true)
  })
})

describe('applyStatus (waiting for the recorder to confirm)', () => {
  const sent = { lastSeen: '2026-11-11T10:00:00Z', device: 'hw:1,0', deviceChanged: true }
  const rec = (o: object) => ({ online: true, last_seen: '2026-11-11T10:00:00Z', status: {}, ...o }) as Parameters<typeof applyStatus>[1]
  it('idle when nothing was sent', () => expect(applyStatus(null, rec({}))).toBe('idle'))
  it('waits until a newer heartbeat arrives', () => expect(applyStatus(sent, rec({}))).toBe('waiting'))
  it('offline recorders are reported as such', () => expect(applyStatus(sent, rec({ online: false }))).toBe('offline'))
  it('a newer heartbeat that still reports the old device keeps waiting', () => {
    expect(applyStatus(sent, rec({ last_seen: '2026-11-11T10:00:10Z', status: { active_device: 'hw:0,0' } }))).toBe('waiting')
  })
  it('applied once the heartbeat is newer and the device matches', () => {
    expect(applyStatus(sent, rec({ last_seen: '2026-11-11T10:00:10Z', status: { active_device: 'hw:1,0' } }))).toBe('applied')
  })
  it('a gain-only change is applied by any newer heartbeat', () => {
    expect(applyStatus({ lastSeen: sent.lastSeen, device: null, deviceChanged: false }, rec({ last_seen: '2026-11-11T10:00:10Z' }))).toBe('applied')
  })
})

describe('small helpers', () => {
  it('bufferTone thresholds', () => {
    expect(bufferTone(0)).toBe('ok'); expect(bufferTone(undefined)).toBe('ok')
    expect(bufferTone(1)).toBe('warn'); expect(bufferTone(20)).toBe('warn'); expect(bufferTone(21)).toBe('danger')
  })
  it('levelFraction maps -60..0 dB onto 0..1 and clamps', () => {
    expect(levelFraction(-60)).toBe(0); expect(levelFraction(0)).toBe(1); expect(levelFraction(-30)).toBe(0.5)
    expect(levelFraction(-90)).toBe(0); expect(levelFraction(5)).toBe(1); expect(levelFraction(null)).toBe(0)
  })
  it('versionMismatch compares major.minor only', () => {
    expect(versionMismatch('0.1.2', '0.1.9')).toBe(false)
    expect(versionMismatch('0.1.2', '0.2.0')).toBe(true)
    expect(versionMismatch(null, '0.2.0')).toBe(false)
  })
  it('detects localhost addresses', () => {
    expect(isLocalhostUrl('http://localhost:8000')).toBe(true)
    expect(isLocalhostUrl('127.0.0.1:8000')).toBe(true)
    expect(isLocalhostUrl('http://192.168.1.5:8000')).toBe(false)
    expect(isLocalhostUrl('not a url')).toBe(false)
  })
  it('snippets embed the address and token', () => {
    for (const k of ['docker', 'cli', 'env'] as const) {
      const s = buildSnippet(k, 'http://192.168.1.5:8000', 'tok123')
      expect(s).toContain('http://192.168.1.5:8000')
      expect(s).toContain('tok123')
    }
    expect(buildSnippet('docker', 'x', 't')).toContain('/dev/snd')
  })
})
