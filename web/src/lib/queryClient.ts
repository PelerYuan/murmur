import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './api'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
})

export const qk = {
  auth: ['auth-status'] as const,
  settings: ['settings'] as const,
  defaults: ['settings-defaults'] as const,
  speakers: ['speakers'] as const,
  speaker: (id: number) => ['speaker', id] as const,
  rooms: ['rooms'] as const,
  recorders: ['recorders'] as const,
  dashboard: ['dashboard'] as const,
  pipeline: ['pipeline'] as const,
  system: ['system-info'] as const,
  failedChunks: ['chunks', 'failed'] as const,
  jobs: (status: string) => ['jobs', status] as const,
  todos: ['todos'] as const,
  reminders: ['reminders-due'] as const,
  summaries: ['summaries'] as const,
  days: ['utterance-days'] as const,
}
