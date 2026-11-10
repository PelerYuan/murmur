import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Banner } from '../ui/Misc'
import { Button } from '../ui/Button'
import { Input, Checkbox } from '../ui/Form'
import { Tabs } from '../ui/Misc'
import { buildSnippet, isLocalhostUrl, type SnippetKind } from '../../lib/recorderConfig'
import { useToast } from '../ui/Toast'
import { useT } from '../../i18n'

function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT()
  const toast = useToast()
  const [done, setDone] = useState(false)
  return (
    <Button
      size="sm"
      icon={done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      onClick={() => {
        const ok = () => { setDone(true); setTimeout(() => setDone(false), 2000) }
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(ok, () => toast.error(new Error(t('common.copy_failed'))))
        else {
          // Insecure origins (plain http on the LAN) have no async clipboard API.
          const ta = document.createElement('textarea')
          ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
          document.body.appendChild(ta); ta.select()
          try { document.execCommand('copy') ? ok() : toast.error(new Error(t('common.copy_failed'))) } catch { toast.error(new Error(t('common.copy_failed'))) }
          document.body.removeChild(ta)
        }
      }}
    >
      {done ? t('rec.token_copied') : label ?? t('rec.token_copy')}
    </Button>
  )
}

/** One-time token + launch snippets (Docker / CLI / .env) with an editable Core address. */
export function TokenPanel({ token, saved, onSaved }: { token: string; saved?: boolean; onSaved?: (v: boolean) => void }) {
  const t = useT()
  const [kind, setKind] = useState<SnippetKind>('docker')
  const [core, setCore] = useState(() => window.location.origin)
  const snippet = buildSnippet(kind, core, token)
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-[13px] font-medium">{t('rec.token')}</p>
        <div className="flex items-stretch gap-2">
          <code className="min-w-0 flex-1 select-all break-all rounded-lg border border-line-strong bg-subtle px-3 py-2 font-mono text-[13px] leading-5" data-testid="token">{token}</code>
          <CopyButton text={token} />
        </div>
        <Banner tone="danger" className="mt-2" role="status">{t('rec.token_once')}</Banner>
      </div>
      <div>
        <label htmlFor="core-url" className="mb-1.5 block text-[13px] font-medium">{t('rec.core_url')}</label>
        <Input id="core-url" value={core} onChange={(e) => setCore(e.target.value)} spellCheck={false} inputClassName="font-mono text-[13px]" />
        <p className="mt-1 text-xs text-muted">{t('rec.core_url_hint')}</p>
        {isLocalhostUrl(core) && <Banner tone="warn" className="mt-2">{t('rec.localhost_warn')}</Banner>}
      </div>
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <Tabs
            label={t('rec.token')}
            value={kind}
            onChange={setKind}
            items={[{ value: 'docker', label: t('rec.snippet_docker') }, { value: 'cli', label: t('rec.snippet_cli') }, { value: 'env', label: t('rec.snippet_env') }]}
          />
          <CopyButton text={snippet} label={t('rec.snippet_copy')} />
        </div>
        <pre className="max-w-full overflow-x-auto whitespace-pre rounded-lg border border-line bg-subtle p-3 font-mono text-xs leading-5" tabIndex={0}>{snippet}</pre>
      </div>
      {onSaved && <Checkbox checked={!!saved} onChange={onSaved} label={t('rec.token_saved_check')} />}
    </div>
  )
}
