// Two soft chime notes generated with Web Audio — no audio files needed.
let ctx: AudioContext | null = null
let unlocked = false
const listeners = new Set<() => void>()

function ensure(): AudioContext | null {
  if (ctx) return ctx
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  ctx = new AC()
  return ctx
}

export function isSoundUnlocked(): boolean {
  return unlocked
}
export function onSoundUnlock(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }

/** Any user gesture unlocks audio (browser autoplay policy). Call once at startup. */
export function installUnlockListener() {
  const unlock = () => {
    const c = ensure()
    if (!c) return
    void c.resume().then(() => {
      if (c.state === 'running' && !unlocked) {
        unlocked = true
        listeners.forEach((f) => f())
      }
    })
    if (unlocked) cleanup()
  }
  const cleanup = () => {
    window.removeEventListener('pointerdown', unlock, true)
    window.removeEventListener('keydown', unlock, true)
  }
  window.addEventListener('pointerdown', unlock, true)
  window.addEventListener('keydown', unlock, true)
}

export function playChime() {
  const c = ensure()
  if (!c || c.state !== 'running') return
  const now = c.currentTime
  ;[[880, 0], [1174.66, 0.22]].forEach(([freq, delay]) => {
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0.0001, now + delay)
    gain.gain.exponentialRampToValueAtTime(0.16, now + delay + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.7)
    osc.connect(gain).connect(c.destination)
    osc.start(now + delay)
    osc.stop(now + delay + 0.75)
  })
}
