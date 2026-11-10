import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '../lib/cn'

const SAFE = /^(https?:|mailto:|#|\/)/i

/** Summaries are model output: no raw HTML, links limited to http(s)/mailto and opened in a new tab. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('prose-murmur', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => (SAFE.test(url.trim()) ? url : '')}
        components={{
          a: ({ href, children: c }) => (href ? <a href={href} target="_blank" rel="noopener noreferrer nofollow">{c}</a> : <span>{c}</span>),
          img: ({ alt }) => <span className="text-muted">[{alt || 'image'}]</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
