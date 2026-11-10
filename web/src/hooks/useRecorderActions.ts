import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { qk } from '../lib/queryClient'
import type { Recorder, RecorderConfig, Room } from '../lib/types'

/** Replace one recorder inside the cached list with the server's answer. */
function putRecorder(qc: ReturnType<typeof useQueryClient>, r: Recorder) {
  qc.setQueryData<Recorder[]>(qk.recorders, (list) => (list ? list.map((x) => (x.id === r.id ? { ...x, ...r, token: undefined } : x)) : list))
}

export function usePatchRecorder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: { name?: string; room_id?: number | null; config?: Partial<RecorderConfig> } }) =>
      api.patch<Recorder>(`/recorders/${id}`, body),
    onSuccess: (r) => { putRecorder(qc, r); void qc.invalidateQueries({ queryKey: qk.dashboard }) },
  })
}

export function useCreateRecorder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; room_id: number | null }) => api.post<Recorder>('/recorders', body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.recorders }); void qc.invalidateQueries({ queryKey: qk.dashboard }) },
  })
}

export function useRotateToken() {
  return useMutation({ mutationFn: (id: number) => api.post<{ token: string } & Partial<Recorder>>(`/recorders/${id}/rotate-token`) })
}

export function useDeleteRecorder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.del(`/recorders/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.recorders }); void qc.invalidateQueries({ queryKey: qk.dashboard }) },
  })
}

export function useRoomActions() {
  const qc = useQueryClient()
  const refresh = () => { void qc.invalidateQueries({ queryKey: qk.rooms }); void qc.invalidateQueries({ queryKey: qk.recorders }) }
  return {
    create: useMutation({ mutationFn: (name: string) => api.post<Room>('/rooms', { name }), onSuccess: refresh }),
    rename: useMutation({ mutationFn: ({ id, name }: { id: number; name: string }) => api.patch<Room>(`/rooms/${id}`, { name }), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (id: number) => api.del(`/rooms/${id}`), onSuccess: refresh }),
  }
}
