// "Which browser tab should play the reminder sound?" — the most recently focused tab wins.
// Pure election logic (tested) + a thin BroadcastChannel wrapper.

export interface Peer { focusedAt: number; seenAt: number }

/** Peers not heard from within `ttl` ms are considered closed. Ties break on id so everyone agrees. */
export function pickLeader(selfId: string, self: Peer, peers: Record<string, Peer>, now: number, ttl = 15_000): string {
  let best = selfId
  let bestAt = self.focusedAt
  for (const [id, p] of Object.entries(peers)) {
    if (id === selfId || now - p.seenAt > ttl) continue
    if (p.focusedAt > bestAt || (p.focusedAt === bestAt && id < best)) {
      best = id
      bestAt = p.focusedAt
    }
  }
  return best
}

export class LeaderElection {
  readonly id = Math.random().toString(36).slice(2)
  private peers: Record<string, Peer> = {}
  private self: Peer
  private ch: BroadcastChannel | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private onFocus = () => this.markFocused()

  constructor(name = 'murmur-reminders') {
    const now = Date.now()
    this.self = { focusedAt: typeof document !== 'undefined' && document.hasFocus() ? now : 0, seenAt: now }
    if (typeof BroadcastChannel !== 'undefined') {
      this.ch = new BroadcastChannel(name)
      this.ch.onmessage = (e: MessageEvent) => {
        const m = e.data as { id: string; focusedAt: number; bye?: boolean }
        if (!m || m.id === this.id) return
        if (m.bye) delete this.peers[m.id]
        else this.peers[m.id] = { focusedAt: m.focusedAt, seenAt: Date.now() }
      }
    }
  }

  start() {
    window.addEventListener('focus', this.onFocus)
    document.addEventListener('visibilitychange', this.onFocus)
    this.announce()
    this.timer = setInterval(() => this.announce(), 5000)
  }

  stop() {
    window.removeEventListener('focus', this.onFocus)
    document.removeEventListener('visibilitychange', this.onFocus)
    if (this.timer) clearInterval(this.timer)
    this.ch?.postMessage({ id: this.id, focusedAt: 0, bye: true })
    this.ch?.close()
  }

  private markFocused() {
    if (document.visibilityState === 'visible') {
      this.self.focusedAt = Date.now()
      this.announce()
    }
  }

  private announce() {
    this.ch?.postMessage({ id: this.id, focusedAt: this.self.focusedAt })
  }

  isLeader(): boolean {
    return pickLeader(this.id, this.self, this.peers, Date.now()) === this.id
  }
}
