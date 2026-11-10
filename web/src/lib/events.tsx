import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, triggerUnauthorized } from './api'
import type { AuthStatus } from './types'

const NAMES = ['reminder.due', 'todo.created', 'todo.updated', 'utterances.new', 'summary.created', 'recorder.status', 'ping'] as const
export type EventName = (typeof NAMES)[number] | 'open'
type Handler = (data: any) => void // eslint-disable-line @typescript-eslint/no-explicit-any

interface Ctx { connected: boolean; subscribe: (name: EventName, h: Handler) => () => void }
const EventsContext = createContext<Ctx | null>(null)

/** One shared EventSource for the whole app, with exponential-backoff reconnect (1 s → 30 s). */
export function EventsProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Map<EventName, Set<Handler>>())
  const [connected, setConnected] = useState(true)

  const subscribe = useMemo(() => (name: EventName, h: Handler) => {
    let set = listeners.current.get(name)
    if (!set) { set = new Set(); listeners.current.set(name, set) }
    set.add(h)
    return () => { set!.delete(h) }
  }, [])

  useEffect(() => {
    let es: EventSource | null = null
    let stopped = false
    let backoff = 1000
    let retry: ReturnType<typeof setTimeout> | undefined
    let watchdog: ReturnType<typeof setInterval> | undefined
    let lastSeen = Date.now()
    const emit = (name: EventName, data: unknown) => listeners.current.get(name)?.forEach((h) => { try { h(data) } catch (e) { console.error(e) } })

    const connect = () => {
      if (stopped) return
      es = new EventSource('/api/v1/events')
      es.onopen = () => {
        backoff = 1000
        lastSeen = Date.now()
        setConnected(true)
        emit('open', null)
      }
      for (const n of NAMES) {
        es.addEventListener(n, (e) => {
          lastSeen = Date.now()
          let data: unknown = null
          try { data = JSON.parse((e as MessageEvent).data) } catch { /* ping etc. */ }
          emit(n, data)
        })
      }
      es.onerror = () => {
        es?.close()
        es = null
        setConnected(false)
        // A 401 on the stream surfaces only as a generic error; find out whether the session is gone.
        api.get<AuthStatus>('/auth/status', undefined, { quiet401: true })
          .then((s) => { if (!s.authenticated && !s.setup_required) triggerUnauthorized() })
          .catch(() => undefined)
        if (!stopped) retry = setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 30000)
      }
    }
    connect()
    // The server pings every 25 s; if we hear nothing for 70 s the connection is a zombie.
    watchdog = setInterval(() => {
      if (es && Date.now() - lastSeen > 70_000) { es.close(); es = null; setConnected(false); connect() }
    }, 10_000)
    return () => {
      stopped = true
      clearTimeout(retry)
      clearInterval(watchdog)
      es?.close()
    }
  }, [])

  const value = useMemo(() => ({ connected, subscribe }), [connected, subscribe])
  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>
}

export function useSseConnected(): boolean {
  return useContext(EventsContext)?.connected ?? true
}

/** Subscribe to one or more SSE events; `open` fires on every (re)connect. */
export function useEvent(names: EventName | EventName[], handler: Handler) {
  const ctx = useContext(EventsContext)
  const ref = useRef(handler)
  ref.current = handler
  const key = Array.isArray(names) ? names.join('|') : names
  useEffect(() => {
    if (!ctx) return
    const list = key.split('|') as EventName[]
    const offs = list.map((n) => ctx.subscribe(n, (d) => ref.current(d)))
    return () => offs.forEach((f) => f())
  }, [ctx, key])
}
