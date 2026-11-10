import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '../../ui/Button'
import { Badge, ErrorBar, Skeleton } from '../../ui/Misc'
import { Section } from '../Fields'
import { useToast } from '../../ui/Toast'
import { usePipeline, useSettings, useSystemInfo } from '../../../hooks/useData'
import { diskTone, formatBytes } from '../../../lib/status'
import { buildDiagnostics } from '../../../lib/settingsForm'
import { useI18n } from '../../../i18n'

function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => false)
  const ta = document.createElement('textarea')
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
  document.body.appendChild(ta); ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  document.body.removeChild(ta)
  return Promise.resolve(ok)
}

function uptime(s: number, zh: boolean): string {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  if (zh) return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : `${m} 分钟`
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}

export default function SystemGroup() {
  const { t, lang } = useI18n()
  const toast = useToast()
  const sys = useSystemInfo(30_000)
  const settings = useSettings()
  const pipeline = usePipeline(false)
  const [copied, setCopied] = useState(false)
  if (sys.isLoading) return <Skeleton className="h-64 rounded-xl" />
  if (sys.isError || !sys.data) return <ErrorBar message={t('set.sys_failed')} onRetry={() => void sys.refetch()} retryLabel={t('common.retry')} />
  const s = sys.data
  const tone = diskTone(s.disk_free_bytes)
  const rows: [string, React.ReactNode][] = [
    [t('set.sys_version'), `Core ${s.version} · Web ${__WEB_VERSION__}`],
    [t('set.sys_role'), s.role],
    [t('set.sys_data_dir'), <code key="d" className="break-all font-mono text-[13px]">{s.data_dir}</code>],
    [t('set.sys_db'), <code key="b" className="break-all font-mono text-[13px]">{s.db_path}</code>],
    [t('set.sys_uptime'), uptime(s.uptime_seconds, lang === 'zh')],
    [t('set.sys_disk'), <span key="k" className="inline-flex items-center gap-2">{formatBytes(s.disk_free_bytes)}{tone !== 'ok' && <Badge tone={tone === 'danger' ? 'danger' : 'warn'}>{tone === 'danger' ? t('set.sys_disk_critical') : t('set.sys_disk_low')}</Badge>}</span>],
  ]
  const copy = async () => {
    const text = buildDiagnostics({ settings: settings.data, system: s, pipeline: pipeline.data, webVersion: __WEB_VERSION__, userAgent: navigator.userAgent, nowIso: new Date().toISOString() })
    if (await copyText(text)) { setCopied(true); setTimeout(() => setCopied(false), 2500) } else toast.error(new Error(t('common.copy_failed')))
  }
  return (
    <Section>
      <dl className="divide-y divide-line text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-4">
            <dt className="w-32 shrink-0 text-muted">{k}</dt>
            <dd className="min-w-0 flex-1">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-1.5 border-t border-line pt-4">
        <Button icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} onClick={() => void copy()}>{copied ? t('set.sys_copied') : t('set.sys_copy')}</Button>
        <p className="text-xs text-muted">{t('set.sys_copy_hint')}</p>
      </div>
    </Section>
  )
}
