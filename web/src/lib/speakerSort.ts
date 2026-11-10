import type { Speaker } from './types'

export type SpeakerSort = 'default' | 'recent' | 'count' | 'seconds' | 'name'

export function sortSpeakers(list: Speaker[], sort: SpeakerSort, label: (id: number) => string): Speaker[] {
  const arr = [...list]
  const ts = (s: Speaker) => (s.last_seen ? Date.parse(s.last_seen) : 0)
  switch (sort) {
    case 'recent': return arr.sort((a, b) => ts(b) - ts(a))
    case 'count': return arr.sort((a, b) => b.utterance_count - a.utterance_count)
    case 'seconds': return arr.sort((a, b) => b.total_seconds - a.total_seconds)
    case 'name': return arr.sort((a, b) => label(a.id).localeCompare(label(b.id)))
    default: return arr.sort((a, b) => b.utterance_count - a.utterance_count || ts(b) - ts(a))
  }
}
