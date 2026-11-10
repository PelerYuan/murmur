import { highlightParts } from '../lib/pagination'

export function Highlight({ text, q }: { text: string; q?: string }) {
  if (!q || !q.trim()) return <>{text}</>
  return (
    <>
      {highlightParts(text, q).map((p, i) => p.hit
        ? <mark key={i} className="rounded-sm bg-warn/25 px-0.5 text-inherit">{p.text}</mark>
        : <span key={i}>{p.text}</span>)}
    </>
  )
}
