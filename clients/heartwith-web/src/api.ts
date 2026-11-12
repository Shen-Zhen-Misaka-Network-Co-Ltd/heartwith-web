import type { LobbyEvent, LobbyResponse, SeriesResponse } from './types'

const API_BASE = '/api/v1'

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

export async function fetchParticipants(signal?: AbortSignal): Promise<LobbyResponse> {
  return parseJson<LobbyResponse>(
    await fetch(`${API_BASE}/lobby/participants`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal,
    }),
  )
}

export function seriesMaxPoints(windowSeconds: number): number {
  return windowSeconds >= 21_600 ? 420 : 600
}

export async function fetchSeries(collectorId: string, windowSeconds: number): Promise<SeriesResponse> {
  const maxPoints = seriesMaxPoints(windowSeconds)
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

export function openLobbyEvents(
  onEvent: (event: LobbyEvent) => void,
  onError: () => void,
  onOpen: () => void,
): EventSource {
  const events = new EventSource(`${API_BASE}/lobby/events`)
  const fail = () => {
    events.close()
    onError()
  }
  events.onopen = () => {
    onOpen()
  }
  events.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as LobbyEvent)
    } catch {
      fail()
    }
  }
  events.onerror = fail
  return events
}
