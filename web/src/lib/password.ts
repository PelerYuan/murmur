export function passwordStrength(pw: string): 0 | 1 | 2 | 3 {
  if (pw.length < 6) return 0
  let score = 0
  if (pw.length >= 10) score++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++
  else if (/\d/.test(pw) || /[^A-Za-z0-9]/.test(pw)) score += pw.length >= 8 ? 1 : 0
  return (Math.min(score, 2) + 1) as 1 | 2 | 3
}
