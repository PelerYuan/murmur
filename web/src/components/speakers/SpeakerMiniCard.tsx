import { Link } from 'react-router-dom'
import { Popover } from '../ui/Popover'
import { Overlay } from '../ui/Overlay'
import { useIsMobile } from '../../hooks/useMedia'
import { useSpeakerLookup } from '../../hooks/useData'
import { SampleList } from '../AudioPlayer'
import { SpeakerDot } from '../SpeakerChip'
import { SpeakerNameInput } from './SpeakerNameInput'
import { useT } from '../../i18n'

/** Quick card opened from a speaker chip: samples, a name box for unnamed voices, link to the detail page. */
export function SpeakerMiniCard({ speakerId, anchor, onClose }: { speakerId: number | null; anchor: HTMLElement | null; onClose: () => void }) {
  const t = useT()
  const mobile = useIsMobile()
  const { map, label } = useSpeakerLookup()
  const sp = speakerId != null ? map.get(speakerId) : undefined
  const open = !!sp && (mobile || !!anchor)
  if (!sp) return null
  const body = (
    <div className="space-y-3 p-3.5 sm:w-[300px]">
      <div className="flex items-center gap-2">
        <SpeakerDot color={sp.color} dashed={sp.state === 'unnamed'} className="h-3 w-3" />
        <span className={sp.state === 'unnamed' ? 'font-semibold italic' : 'font-semibold'}>{label(sp.id)}</span>
        <span className="tabular ml-auto text-xs text-muted">{t('common.sentences', { n: sp.utterance_count })}</span>
      </div>
      {sp.state !== 'ignored' && <SampleList speakerId={sp.id} samples={sp.samples} compact max={5} />}
      {sp.samples.length === 0 && sp.state !== 'ignored' && <p className="text-xs text-faint">{t('speakers.no_samples_new')}</p>}
      {sp.state === 'unnamed' && <SpeakerNameInput speaker={sp} autoFocus={!mobile} onSaved={onClose} />}
      <Link to={`/speakers/${sp.id}`} onClick={onClose} className="inline-block text-[13px] font-medium text-accent hover:underline">{t('utt.mini_view')} →</Link>
    </div>
  )
  return mobile ? (
    <Overlay open={open} onClose={onClose} title={label(sp.id)} size="sm">{body}</Overlay>
  ) : (
    <Popover open={open} onClose={onClose} anchor={anchor} placement="bottom-start" label={label(sp.id)} className="border border-line">{body}</Popover>
  )
}
