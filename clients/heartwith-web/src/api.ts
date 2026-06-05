import type { LobbyEvent, LobbyResponse, SeriesResponse } from './types'

const API_BASE = '/api/v1'

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

export async function fetchParticipants(): Promise<LobbyResponse> {
  return parseJson<LobbyResponse>(
    await fetch(`${API_BASE}/lobby/participants`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    }),
  )
}

export async function fetchSeries(collectorId: string, windowSeconds: number): Promise<SeriesResponse> {
  const maxPoints = windowSeconds >= 21_600 ? 420 : 600
  const params = new URLSearchParams({
    window_seconds: String(windowSeconds),
    max_points: String(maxPoints),
  })
  return parseJson<SeriesResponse>(
    await fetch(`${API_BASE}/participants/${encodeURIComponent(collectorId)}/series?${params}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    }),
  )
}

export function openLobbyEvents(onEvent: (event: LobbyEvent) => void, onError: () => void): EventSource {
  const events = new EventSource(`${API_BASE}/lobby/events`)
  events.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as LobbyEvent)
    } catch {
      onError()
    }
  }
  events.onerror = onError
  return events
}
