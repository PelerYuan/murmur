import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Compass } from 'lucide-react'
import { dicts } from '../i18n'
import { translate } from '../i18n/core'
import { lsGet } from '../lib/storage'
import { Button } from './ui/Button'
import { EmptyState } from './ui/Misc'
import { useT } from '../i18n'

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(error, info.componentStack) }
  render() {
    if (!this.state.error) return this.props.children
    const lang = lsGet('murmur.lang') === 'en' ? 'en' : 'zh'
    const tr = (k: string) => translate(dicts, lang, k)
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg p-6">
        <EmptyState
          icon={<AlertTriangle />}
          title={tr('boundary.title')}
          body={tr('boundary.body')}
          action={<Button variant="primary" onClick={() => location.reload()}>{tr('common.reload_page')}</Button>}
        />
      </div>
    )
  }
}

export function NotFound() {
  const t = useT()
  return (
    <EmptyState icon={<Compass />} title={t('notfound.title')} body={t('notfound.body')} className="py-24"
      action={<Link to="/" className="inline-flex h-9 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg">{t('notfound.home')}</Link>} />
  )
}
