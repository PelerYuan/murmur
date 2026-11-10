// localStorage wrappers that never throw (private windows, blocked storage).
export function lsGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
export function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* ignore */ }
}
export function ssGet(key: string): string | null {
  try { return sessionStorage.getItem(key) } catch { return null }
}
export function ssSet(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, value)
  } catch { /* ignore */ }
}
