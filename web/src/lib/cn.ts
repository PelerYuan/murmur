export function cn(...parts: (string | number | false | null | undefined)[]): string {
  return parts.filter((p) => p !== false && p != null && p !== '' && p !== 0).join(' ')
}
