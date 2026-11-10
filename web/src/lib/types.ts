// Types mirroring docs/API.md (v1). Times are ISO-8601 UTC strings.

export interface Room { id: number; name: string; created_at: string }

export interface RecorderConfig {
  enabled: boolean
  device: string | null
  gain_db: number
  vad_aggressiveness: number
  min_speech_ms: number
  end_silence_ms: number
  max_chunk_seconds: number
  pre_roll_ms: number
}
export interface AudioDevice { id: string; name: string; channels?: number; default_samplerate?: number; is_default?: boolean }
export interface RecorderStatus {
  state?: 'recording' | 'paused' | 'error' | 'starting'
  level_db?: number | null
  buffered_chunks?: number
  active_device?: string | null
  error?: string | null
}
export interface Recorder {
  id: number
  name: string
  room_id: number | null
  created_at: string
  last_seen: string | null
  online: boolean
  version: string | null
  devices: AudioDevice[]
  status: RecorderStatus
  config: RecorderConfig
  token?: string
}

export type ChunkStatus = 'pending' | 'processing' | 'done' | 'failed' | 'skipped'
export interface Chunk {
  id: number; recorder_id: number; room_id: number | null; started_at: string; duration: number
  status: ChunkStatus; attempts: number; error: string | null; utterance_count: number; audio_deleted: boolean
}
export interface PipelineStatus {
  counts: Record<ChunkStatus, number>
  oldest_pending_at: string | null
  last_done_at: string | null
  asr_ok: boolean | null
  llm_configured: boolean
  errors: { chunk_id: number; error: string; at: string }[]
}

export interface Utterance {
  id: number
  chunk_id: number | null
  room_id: number | null
  started_at: string
  ended_at: string
  text: string
  lang: string | null
  speaker_id: number | null
  speaker_name: string | null
  confidence: number | null
  text_edited: boolean
}

export type SpeakerState = 'unnamed' | 'named' | 'ignored'
export interface SpeakerSample { id: number; duration: number; text: string | null }
export interface Speaker {
  id: number
  name: string | null
  display_name: string
  state: SpeakerState
  color: string
  utterance_count: number
  total_seconds: number
  first_seen: string | null
  last_seen: string | null
  samples: SpeakerSample[]
}

export type SummaryLevel = 'incremental' | 'hourly' | 'daily' | 'custom'
export interface Summary {
  id: number; level: SummaryLevel; range_start: string; range_end: string; room_id: number | null
  title: string; content: string; model: string | null; utterance_count: number; created_at: string
}
export interface SummaryJob {
  id: number; level: SummaryLevel; range_start: string; range_end: string; room_id: number | null
  status: 'queued' | 'running' | 'done' | 'failed'; error: string | null; summary_id: number | null
}

export type TodoStatus = 'open' | 'done' | 'dismissed'
export type ReminderState = 'none' | 'pending' | 'fired' | 'acked'
export interface Todo {
  id: number
  text: string
  status: TodoStatus
  assignee_speaker_id: number | null
  assignee_name: string | null
  due_at: string | null
  remind_at: string | null
  reminder_state: ReminderState
  confidence: number | null
  source: 'auto' | 'manual'
  source_utterance_id: number | null
  source_excerpt: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface Dashboard {
  date: string
  today: {
    utterance_count: number
    speech_seconds: number
    by_speaker: { speaker_id: number | null; display_name: string; color: string | null; seconds: number; utterances: number }[]
  }
  open_todos: number
  due_reminders: number
  latest_summary: Summary | null
  recorders: { id: number; name: string; online: boolean; state: string | null }[]
  pipeline: { pending: number; failed: number }
}

export interface Settings {
  general: { timezone: string; ui_language: 'zh' | 'en'; output_language: string }
  asr: { mode: 'murmur' | 'openai'; base_url: string; api_key: string; model: string; language: string; timeout_seconds: number; concurrency: number }
  llm: {
    base_url: string; api_key: string; model: string; temperature: number; max_input_chars: number; timeout_seconds: number
    prompts: { summary: string; daily: string; todos: string }
  }
  speakers: { match_threshold: number; cluster_threshold: number; sample_count: number; sample_seconds: number; min_utterance_seconds: number }
  filters: { drop_non_speech: boolean; drop_hallucinations: boolean; min_confidence: number; min_text_chars: number }
  retention: { delete_audio_after_transcribe: boolean; failed_audio_days: number; utterance_embedding_days: number }
  schedule: {
    incremental: { enabled: boolean; every_minutes: number; min_utterances: number }
    hourly: { enabled: boolean }
    daily: { enabled: boolean; time: string }
    idle: { enabled: boolean; idle_minutes: number }
  }
  todos: { enabled: boolean; every_minutes: number; min_confidence: number; default_remind_before_minutes: number }
}
export type SettingsGroup = keyof Settings

export interface SystemInfo { version: string; role: string; data_dir: string; db_path: string; uptime_seconds: number; disk_free_bytes: number }
export interface AuthStatus { setup_required: boolean; authenticated: boolean }
export interface AsrTestResult {
  ok: boolean; detail?: string; latency_ms?: number
  info?: { asr_model?: string; embedding_dim?: number; features?: { speaker_embedding?: boolean } } | null
}
export interface LlmTestResult { ok: boolean; detail?: string; latency_ms?: number }
export interface Page<T> { items: T[]; next_cursor: string | null }
export interface DayCount { date: string; count: number }
