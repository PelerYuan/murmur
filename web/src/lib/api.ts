import { ssSet } from './storage'

export class ApiError extends Error {
  status: number
  code: string
  detail: string
  retryAfter: number | null
  constructor(status: number, detail: string, code: string, retryAfter: number | null = null) {
    super(detail)
    this.status = status
    this.detail = detail
    this.code = code
    this.retryAfter = retryAfter
  }
}

/** Thrown when the server cannot be reached at all. */
export class NetworkError extends Error {
  constructor() {
    super('network')
  }
}

type Listener = () => void
const networkListeners = new Set<(down: boolean) => void>()
const unauthorizedListeners = new Set<Listener>()
export function onNetworkState(fn: (down: boolean) => void) { networkListeners.add(fn); return () => { networkListeners.delete(fn) } }
export function onUnauthorized(fn: Listener) { unauthorizedListeners.add(fn); return () => { unauthorizedListeners.delete(fn) } }
export function triggerUnauthorized() { unauthorizedListeners.forEach((fn) => fn()) }

const BASE = '/api/v1'
type Params = Record<string, string | number | boolean | null | undefined>

export function qs(params?: Params): string {
  if (!params) return ''
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

interface Opts { params?: Params; body?: unknown; signal?: AbortSignal; /** do not trigger the global 401 redirect */ quiet401?: boolean }

async function request<T>(method: string, path: string, opts: Opts = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(BASE + path + qs(opts.params), {
      method,
      credentials: 'same-origin',
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e
    networkListeners.forEach((fn) => fn(true))
    throw new NetworkError()
  }
  networkListeners.forEach((fn) => fn(false))
  if (res.status === 204) return undefined as T
  let data: unknown = null
  const text = await res.text()
  if (text) {
    try { data = JSON.parse(text) } catch { data = null }
  }
  if (!res.ok) {
    const d = (data ?? {}) as { detail?: unknown; code?: string }
    const detail = typeof d.detail === 'string' ? d.detail : Array.isArray(d.detail) ? String((d.detail[0] as { msg?: string })?.msg ?? res.statusText) : res.statusText || `HTTP ${res.status}`
    const ra = res.headers.get('Retry-After')
    const err = new ApiError(res.status, detail, d.code ?? `http_${res.status}`, ra ? parseInt(ra, 10) || null : null)
    if (res.status === 401 && !opts.quiet401) unauthorizedListeners.forEach((fn) => fn())
    throw err
  }
  return data as T
}

export const api = {
  get: <T>(path: string, params?: Params, o?: Omit<Opts, 'params' | 'body'>) => request<T>('GET', path, { params, ...o }),
  post: <T>(path: string, body?: unknown, o?: Omit<Opts, 'body'>) => request<T>('POST', path, { body: body ?? {}, ...o }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  del: <T = void>(path: string, params?: Params) => request<T>('DELETE', path, { params }),
}

export function sampleAudioUrl(speakerId: number, sampleId: number): string {
  return `${BASE}/speakers/${speakerId}/samples/${sampleId}/audio`
}

/** Remember where to return to after logging in. */
export function rememberNext(path: string) {
  ssSet('murmur.next', path)
}
