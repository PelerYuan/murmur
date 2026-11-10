import type { Recorder, RecorderConfig } from './types'

export type AdvKey = 'min_speech_ms' | 'end_silence_ms' | 'max_chunk_seconds' | 'pre_roll_ms'

export const ADV: Record<AdvKey, { min: number; max: number; def: number; unit: 'ms' | 's' }> = {
  min_speech_ms: { min: 100, max: 2000, def: 300, unit: 'ms' },
  end_silence_ms: { min: 300, max: 5000, def: 1200, unit: 'ms' },
  max_chunk_seconds: { min: 10, max: 120, def: 60, unit: 's' },
  pre_roll_ms: { min: 0, max: 1000, def: 300, unit: 'ms' },
}
export const GAIN = { min: -20, max: 30 }

/** Return the keys whose draft value differs from the saved one. */
export function diffConfig(saved: RecorderConfig, draft: RecorderConfig): Partial<RecorderConfig> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(draft) as (keyof RecorderConfig)[]) if (draft[k] !== saved[k]) out[k] = draft[k]
  return out as Partial<RecorderConfig>
}

export function advError(key: AdvKey, value: number): boolean {
  const r = ADV[key]
  return !Number.isFinite(value) || value < r.min || value > r.max || !Number.isInteger(value)
}

export function configInvalid(c: RecorderConfig): boolean {
  if (c.gain_db < GAIN.min || c.gain_db > GAIN.max) return true
  return (Object.keys(ADV) as AdvKey[]).some((k) => advError(k, c[k]))
}

export type ApplyStatus = 'idle' | 'waiting' | 'applied' | 'offline'

/**
 * Has the recorder confirmed a saved config? Confirmation = a heartbeat newer than the one we saw when saving,
 * and (when a device was chosen) the reported active device matches.
 */
export function applyStatus(sent: { lastSeen: string | null; device: string | null; deviceChanged: boolean } | null, r: Pick<Recorder, 'online' | 'last_seen' | 'status'>): ApplyStatus {
  if (!sent) return 'idle'
  if (!r.online) return 'offline'
  const newer = !!r.last_seen && (!sent.lastSeen || Date.parse(r.last_seen) > Date.parse(sent.lastSeen))
  if (!newer) return 'waiting'
  if (sent.deviceChanged && sent.device != null && r.status.active_device && r.status.active_device !== sent.device) return 'waiting'
  return 'applied'
}

export function bufferTone(n: number | undefined): 'ok' | 'warn' | 'danger' {
  const v = n ?? 0
  return v === 0 ? 'ok' : v <= 20 ? 'warn' : 'danger'
}

/** Map dB (-60..0) to 0..1 for the level bar. */
export function levelFraction(db: number | null | undefined): number {
  if (db == null || !Number.isFinite(db)) return 0
  return Math.max(0, Math.min(1, (db + 60) / 60))
}

/** "0.1.2" vs "0.2.0": mismatch when major or minor differ. */
export function versionMismatch(recorder: string | null | undefined, core: string | null | undefined): boolean {
  if (!recorder || !core) return false
  const a = recorder.split('.').slice(0, 2).join('.')
  const b = core.split('.').slice(0, 2).join('.')
  return a !== b
}

export type SnippetKind = 'docker' | 'cli' | 'env'
export function buildSnippet(kind: SnippetKind, coreUrl: string, token: string): string {
  const url = coreUrl.trim() || 'http://core.lan:8000'
  if (kind === 'docker') {
    return [
      'docker run -d --name murmur-recorder --restart unless-stopped \\',
      '  --device /dev/snd --group-add "$(getent group audio | cut -d: -f3)" \\',
      `  -e MURMUR_CORE_URL=${url} -e MURMUR_TOKEN=${token} \\`,
      '  -v murmur-buffer:/buffer \\',
      '  murmur-recorder',
    ].join('\n')
  }
  if (kind === 'cli') {
    return [`export MURMUR_CORE_URL=${url}`, `export MURMUR_TOKEN=${token}`, 'murmur-recorder run'].join('\n')
  }
  return [`MURMUR_CORE_URL=${url}`, `MURMUR_TOKEN=${token}`, 'MURMUR_BUFFER_DIR=/var/lib/murmur-recorder/buffer'].join('\n')
}

export function isLocalhostUrl(url: string): boolean {
  try {
    const h = new URL(url.includes('://') ? url : `http://${url}`).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost')
  } catch { return false }
}
