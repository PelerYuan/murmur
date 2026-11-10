import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pause, Play } from 'lucide-react'
import { cn } from '../lib/cn'
import { sampleAudioUrl } from '../lib/api'
import type { SpeakerSample } from '../lib/types'
import { useT } from '../i18n'

// One shared <audio> element for the whole app: starting a sample stops whichever other one is playing.

interface Ctx {
  playingKey: string | null
  progress: number
  failed: ReadonlySet<string>
  toggle: (key: string, url: string) => void
}
const AudioContextX = createContext<Ctx | null>(null)

export function AudioProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [playingKey, setPlayingKey] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  const keyRef = useRef<string | null>(null)

  useEffect(() => {
    const a = new Audio()
    a.preload = 'none'
    audio.current = a
    a.ontimeupdate = () => setProgress(a.duration ? a.currentTime / a.duration : 0)
    a.onended = () => { keyRef.current = null; setPlayingKey(null); setProgress(0) }
    a.onerror = () => {
      const k = keyRef.current
      if (k) setFailed((f) => new Set(f).add(k))
      keyRef.current = null
      setPlayingKey(null)
      setProgress(0)
    }
    return () => { a.pause(); a.src = '' }
  }, [])

  const toggle = useCallback((key: string, url: string) => {
    const a = audio.current
    if (!a) return
    if (keyRef.current === key && !a.paused) {
      a.pause()
      keyRef.current = null
      setPlayingKey(null)
      setProgress(0)
      return
    }
    a.pause()
    a.src = url
    keyRef.current = key
    setPlayingKey(key)
    setProgress(0)
    a.play().catch(() => {
      setFailed((f) => new Set(f).add(key))
      keyRef.current = null
      setPlayingKey(null)
    })
  }, [])

  // Space toggles the current sample from anywhere (unless the user is on a control that uses Space itself).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ' ' || !keyRef.current) return
      const el = e.target as HTMLElement
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(el.tagName) || el.isContentEditable) return
      e.preventDefault()
      audio.current?.pause()
      keyRef.current = null
      setPlayingKey(null)
      setProgress(0)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const value = useMemo(() => ({ playingKey, progress, failed, toggle }), [playingKey, progress, failed, toggle])
  return <AudioContextX.Provider value={value}>{children}</AudioContextX.Provider>
}

export function useAudio(): Ctx {
  const c = useContext(AudioContextX)
  if (!c) throw new Error('AudioProvider missing')
  return c
}

export function SampleButton({ speakerId, sample, index, compact }: { speakerId: number; sample: SpeakerSample; index: number; compact?: boolean }) {
  const t = useT()
  const { playingKey, progress, failed, toggle } = useAudio()
  const key = `${speakerId}:${sample.id}`
  const playing = playingKey === key
  const bad = failed.has(key)
  const dur = `${Math.max(1, Math.round(sample.duration))}s`
  const R = 9, C = 2 * Math.PI * R
  return (
    <button
      type="button"
      disabled={bad}
      onClick={(e) => { e.stopPropagation(); toggle(key, sampleAudioUrl(speakerId, sample.id)) }}
      title={bad ? t('speakers.sample_unavailable') : sample.text ? `“${sample.text}”` : undefined}
      aria-label={`${playing ? t('speakers.pause_sample') : t('speakers.play_sample')} ${index}${sample.text ? `: ${sample.text}` : ''}`}
      aria-pressed={playing}
      className={cn(
        'group inline-flex items-center gap-1.5 rounded-full border text-[12px] font-medium transition-colors',
        compact ? 'h-7 pl-1 pr-2.5' : 'h-8 pl-1 pr-3 max-sm:h-10',
        bad ? 'cursor-not-allowed border-line bg-subtle text-faint' : playing ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong bg-surface text-muted hover:border-accent/50 hover:text-fg',
      )}
    >
      <span className="relative inline-flex h-6 w-6 items-center justify-center">
        <svg viewBox="0 0 24 24" className="absolute inset-0 -rotate-90" aria-hidden>
          <circle cx="12" cy="12" r={R} fill="none" stroke="currentColor" strokeOpacity={playing ? 0.2 : 0} strokeWidth="2" />
          {playing && <circle cx="12" cy="12" r={R} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - progress)} />}
        </svg>
        {playing ? <Pause className="h-3 w-3 fill-current" /> : <Play className="ml-px h-3 w-3 fill-current" />}
      </span>
      <span className="tabular">{index} · {dur}</span>
    </button>
  )
}

export function SampleList({ speakerId, samples, compact, max }: { speakerId: number; samples: SpeakerSample[]; compact?: boolean; max?: number }) {
  const t = useT()
  if (samples.length === 0) return <span className="text-xs text-faint">{t('speakers.no_samples')}</span>
  return (
    <div className="flex flex-wrap gap-1.5">
      {samples.slice(0, max ?? 99).map((s, i) => (
        <SampleButton key={s.id} speakerId={speakerId} sample={s} index={i + 1} compact={compact} />
      ))}
    </div>
  )
}
