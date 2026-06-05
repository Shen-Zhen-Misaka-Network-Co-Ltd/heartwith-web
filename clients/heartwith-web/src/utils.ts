import type { Participant, SleepStatus } from './types'

const ORDER_KEY = 'heartwith.participant.order.v2'

export function readOrder(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function writeOrder(ids: string[]): void {
  localStorage.setItem(ORDER_KEY, JSON.stringify([...new Set(ids)]))
}

export function moveIdToIndex(ids: string[], activeId: string, targetIndex: number): string[] {
  const without = ids.filter((id) => id !== activeId)
  const nextIndex = Math.max(0, Math.min(targetIndex, without.length))
  without.splice(nextIndex, 0, activeId)
  return without
}

export function statusRank(status: string): number {
  if (status === 'online') return 0
  if (status === 'stale') return 0
  return 2
}

export function effectiveStatus(participant: Participant, nowMs: number): string {
  const lastSeen = participant.last_seen_ms ?? participant.updated_at_ms
  if (!lastSeen) return participant.status || 'offline'
  const age = nowMs - lastSeen
  if (age <= 20_000) return 'online'
  if (age <= 120_000) return 'stale'
  return 'offline'
}

export function sortParticipants(participants: Participant[], nowMs: number): Participant[] {
  return [...participants].sort((a, b) => {
    const status = statusRank(effectiveStatus(a, nowMs)) - statusRank(effectiveStatus(b, nowMs))
    if (status !== 0) return status
    const left = (a.display_name || a.device_model || a.collector_id).toLocaleLowerCase()
    const right = (b.display_name || b.device_model || b.collector_id).toLocaleLowerCase()
    return left.localeCompare(right, 'zh-Hans-CN')
  })
}

export function applyManualOrder(participants: Participant[], order: string[], nowMs: number): Participant[] {
  const byId = new Map(participants.map((item) => [item.collector_id, item]))
  const placed = order.map((id) => byId.get(id)).filter((item): item is Participant => Boolean(item))
  const placedIds = new Set(placed.map((item) => item.collector_id))
  const missing = sortParticipants(
    participants.filter((item) => !placedIds.has(item.collector_id)),
    nowMs,
  )
  return [...placed, ...missing]
}

export function formatAge(ms: number | null | undefined, nowMs: number): string {
  if (!ms) return 'unknown'
  const seconds = Math.max(0, Math.round((nowMs - ms) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function formatClock(ms: number | null | undefined): string {
  if (!ms) return '-'
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
}

export function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return '-'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms))
}

export function formatDuration(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return '-'
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h <= 0) return `${m} 分钟`
  if (m <= 0) return `${h} 小时`
  return `${h} 小时 ${m} 分钟`
}

export function sleepLabel(sleep: SleepStatus | null | undefined): string {
  if (!sleep) return '未上报'
  if (sleep.state === 'in_bed') return '已上床 🛏'
  if (sleep.state === 'asleep') return '睡眠中 💤'
  if (sleep.state === 'awake') return '清醒'
  return sleep.state || '未知'
}

export function sleepTimes(sleep: SleepStatus | null | undefined) {
  return {
    goBed: sleep?.go_bed_at_ms ?? sleep?.bed_at_ms ?? null,
    deviceBed: sleep?.device_bed_at_ms ?? sleep?.sleep_at_ms ?? null,
    wake: sleep?.device_wake_at_ms ?? sleep?.wake_at_ms ?? sleep?.leave_bed_at_ms ?? null,
    observed: sleep?.observed_at_ms ?? sleep?.updated_at_ms ?? null,
  }
}
