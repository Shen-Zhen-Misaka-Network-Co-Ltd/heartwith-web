export type ParticipantStatus = 'online' | 'stale' | 'offline' | string

export interface Participant {
  collector_id: string
  display_name: string
  device_model: string
  status: ParticipantStatus
  last_bpm?: number | null
  last_seen_ms?: number | null
  updated_at_ms?: number | null
  sleep?: SleepStatus | null
}

export interface LobbyResponse {
  server_time_ms: number
  participants: Participant[]
}

export interface SeriesSample {
  t_ms: number
  bpm: number
}

export interface SeriesResponse {
  collector_id: string
  window_seconds: number
  samples: SeriesSample[]
}

export interface SleepStatus {
  state: 'in_bed' | 'asleep' | 'awake' | string
  observed_at_ms?: number | null
  bed_at_ms?: number | null
  sleep_at_ms?: number | null
  wake_at_ms?: number | null
  go_bed_at_ms?: number | null
  device_bed_at_ms?: number | null
  leave_bed_at_ms?: number | null
  device_wake_at_ms?: number | null
  duration_minutes?: number | null
  segments?: SleepSegment[] | null
  updated_at_ms?: number | null
}

export interface SleepSegment {
  bed_at_ms?: number | null
  wake_at_ms?: number | null
  device_bed_at_ms?: number | null
  device_wake_at_ms?: number | null
  duration_minutes?: number | null
  deep_minutes?: number | null
  light_minutes?: number | null
  rem_minutes?: number | null
  awake_minutes?: number | null
  awake_count?: number | null
  score?: number | null
}

export interface LobbyEventSnapshot {
  type: 'snapshot'
  server_time_ms: number
  participants: Participant[]
}

export interface LobbyEventParticipantUpdate {
  type: 'participant_update'
  participant: Participant
}

export type LobbyEvent = LobbyEventSnapshot | LobbyEventParticipantUpdate

export type DetailTab = 'heart' | 'sleep'

export type WindowSeconds = 600 | 3600 | 21600 | 86400
