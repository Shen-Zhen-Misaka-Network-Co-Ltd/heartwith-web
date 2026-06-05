<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { MiuixButton } from 'miuix-vue'
import HeartRateChart from './components/HeartRateChart.vue'
import SleepReport from './components/SleepReport.vue'
import { fetchParticipants, fetchSeries, openLobbyEvents } from './api'
import type { DetailTab, LobbyEvent, Participant, SeriesSample, WindowSeconds } from './types'
import {
  applyManualOrder,
  effectiveStatus,
  moveIdToIndex,
  readOrder,
  sleepLabel,
  writeOrder,
} from './utils'

const participantsById = reactive(new Map<string, Participant>())
const nowMs = ref(Date.now())
const manualOrder = ref<string[]>(readOrder())
const viewportWidth = ref(typeof window === 'undefined' ? 1200 : window.innerWidth)
const participantGridEl = ref<HTMLElement | null>(null)
const participantGridWidth = ref(typeof window === 'undefined' ? 1200 : window.innerWidth)
const expandedIds = ref<Set<string>>(new Set())
const activeTabs = reactive(new Map<string, DetailTab>())
const windows = reactive(new Map<string, WindowSeconds>())
const seriesCache = reactive(new Map<string, { windowSeconds: WindowSeconds; samples: SeriesSample[]; loadedAt: number }>())
const loadingSeries = reactive(new Set<string>())
const filterWindowMs = ref(60 * 60_000)
const eventError = ref(false)
const isRefreshing = ref(false)
let eventSource: EventSource | null = null
let clockTimer = 0
let gridResizeObserver: ResizeObserver | null = null

type DragState = {
  activeId: string
  sourceIds: string[]
  targetIndex: number
  pointerId: number
  x: number
  y: number
  offsetX: number
  offsetY: number
  width: number
  height: number
  rects: Array<{ id: string; left: number; top: number; width: number; height: number; midX: number; midY: number }>
}

const drag = ref<DragState | null>(null)
let pressTimer = 0
let pendingPress:
  | {
      id: string
      pointerId: number
      x: number
      y: number
      target: HTMLElement
    }
  | null = null

const participants = computed(() => [...participantsById.values()])

const filteredParticipants = computed(() => {
  const maxOfflineMs = filterWindowMs.value
  return participants.value.filter((participant) => {
    if (!Number.isFinite(maxOfflineMs)) return true
    if (effectiveStatus(participant, nowMs.value) !== 'offline') return true
    const lastSeen = participant.last_seen_ms ?? participant.updated_at_ms
    return Boolean(lastSeen && nowMs.value - lastSeen <= maxOfflineMs)
  })
})

const orderedParticipants = computed(() => applyManualOrder(filteredParticipants.value, manualOrder.value, nowMs.value))
const renderIds = computed(() => {
  const state = drag.value
  if (!state) return orderedParticipants.value.map((participant) => participant.collector_id)
  return moveIdToIndex(state.sourceIds, state.activeId, state.targetIndex)
})
const renderParticipants = computed(() =>
  renderIds.value
    .map((id) => participantsById.get(id))
    .filter((participant): participant is Participant => Boolean(participant)),
)

const onlineCount = computed(
  () => participants.value.filter((participant) => effectiveStatus(participant, nowMs.value) !== 'offline').length,
)

const gridColumns = computed(() => {
  const count = renderParticipants.value.length
  if (count <= 1) return 1
  const width = participantGridWidth.value || viewportWidth.value
  const maxColumns = width >= 720 ? Math.min(count, 4) : 1
  const minReadableCardWidth = Math.max(...renderParticipants.value.map(estimateParticipantCardWidth), 320)
  for (let columns = maxColumns; columns > 1; columns -= 1) {
    const columnWidth = (width - (columns - 1) * 14) / columns
    if (columnWidth >= minReadableCardWidth) return columns
  }
  return 1
})

const activeOverlay = computed(() => {
  const state = drag.value
  if (!state) return null
  return participantsById.get(state.activeId) ?? null
})

const filterOptions = [
  { label: '10 分钟', value: 10 * 60_000 },
  { label: '1 小时', value: 60 * 60_000 },
  { label: '6 小时', value: 6 * 60 * 60_000 },
  { label: '显示全部', value: Number.POSITIVE_INFINITY },
]

const windowOptions: Array<{ label: string; value: WindowSeconds }> = [
  { label: '10 分钟', value: 600 },
  { label: '1 小时', value: 3600 },
  { label: '6 小时', value: 21_600 },
  { label: '24 小时', value: 86_400 },
]

function participantName(participant: Participant): string {
  return participant.display_name || participant.collector_id
}

function participantWindow(id: string): WindowSeconds {
  return windows.get(id) ?? 600
}

function setParticipantWindow(id: string, value: WindowSeconds) {
  windows.set(id, value)
  void ensureSeries(id, value, true)
}

function participantTab(id: string): number {
  return (activeTabs.get(id) ?? 'heart') === 'heart' ? 0 : 1
}

function setParticipantTab(id: string, index: number) {
  activeTabs.set(id, index === 0 ? 'heart' : 'sleep')
  if (index === 0) void ensureSeries(id, participantWindow(id), false)
}

function toggleExpanded(id: string) {
  if (drag.value) return
  const next = new Set(expandedIds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
    activeTabs.set(id, activeTabs.get(id) ?? 'heart')
    void ensureSeries(id, participantWindow(id), false)
  }
  expandedIds.value = next
}

function updateParticipant(participant: Participant) {
  const previous = participantsById.get(participant.collector_id)
  participantsById.set(participant.collector_id, { ...previous, ...participant })
  const latest = participant.last_seen_ms ?? participant.updated_at_ms
  if (participant.last_bpm && latest) appendLiveSample(participant.collector_id, { t_ms: latest, bpm: participant.last_bpm })
}

function applyLobbyEvent(event: LobbyEvent) {
  eventError.value = false
  if (event.type === 'snapshot') {
    participantsById.clear()
    event.participants.forEach(updateParticipant)
    nowMs.value = event.server_time_ms || Date.now()
  } else if (event.type === 'participant_update') {
    updateParticipant(event.participant)
  }
}

async function refreshParticipants() {
  isRefreshing.value = true
  try {
    const lobby = await fetchParticipants()
    participantsById.clear()
    lobby.participants.forEach(updateParticipant)
    nowMs.value = lobby.server_time_ms || Date.now()
    eventError.value = false
  } finally {
    isRefreshing.value = false
  }
}

async function ensureSeries(id: string, windowSeconds: WindowSeconds, force: boolean) {
  const key = `${id}:${windowSeconds}`
  const existing = seriesCache.get(key)
  if (!force && existing && Date.now() - existing.loadedAt < 30_000) return
  if (loadingSeries.has(key)) return
  loadingSeries.add(key)
  try {
    const response = await fetchSeries(id, windowSeconds)
    seriesCache.set(key, { windowSeconds, samples: response.samples, loadedAt: Date.now() })
  } finally {
    loadingSeries.delete(key)
  }
}

function seriesFor(id: string, windowSeconds: WindowSeconds): SeriesSample[] {
  return seriesCache.get(`${id}:${windowSeconds}`)?.samples ?? []
}

function appendLiveSample(id: string, sample: SeriesSample) {
  for (const [key, entry] of seriesCache) {
    if (!key.startsWith(`${id}:`)) continue
    const last = entry.samples[entry.samples.length - 1]
    if (last && sample.t_ms <= last.t_ms) continue
    entry.samples = [...entry.samples.slice(-900), sample]
  }
}

function statusText(participant: Participant): string {
  const status = effectiveStatus(participant, nowMs.value)
  if (status === 'online') return 'online'
  if (status === 'stale') return 'online'
  return 'offline'
}

function statusClass(participant: Participant): string {
  return `status-${statusText(participant)}`
}

function onPointerDown(participant: Participant, event: PointerEvent) {
  if (event.button !== 0) return
  clearPress()
  const target = event.currentTarget as HTMLElement
  pendingPress = { id: participant.collector_id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, target }
  pressTimer = window.setTimeout(() => startDrag(event), isTouchLike(event) ? 420 : 260)
}

function onPointerMove(event: PointerEvent) {
  if (pendingPress && !drag.value) {
    const distance = Math.hypot(event.clientX - pendingPress.x, event.clientY - pendingPress.y)
    if (distance > 9) clearPress()
  }
  const state = drag.value
  if (!state || event.pointerId !== state.pointerId) return
  event.preventDefault()
  state.x = event.clientX
  state.y = event.clientY
  state.targetIndex = indexForPointer(state, event.clientX - state.offsetX + state.width / 2, event.clientY - state.offsetY + state.height / 2)
}

function onPointerUp(event: PointerEvent) {
  const state = drag.value
  if (state && event.pointerId === state.pointerId) {
    const committed = moveIdToIndex(state.sourceIds, state.activeId, state.targetIndex)
    const rest = manualOrder.value.filter((id) => !committed.includes(id))
    const nextOrder = [...committed, ...rest]
    manualOrder.value = nextOrder
    writeOrder(nextOrder)
    drag.value = null
    document.body.classList.remove('is-dragging')
    event.preventDefault()
    return
  }
  clearPress()
}

function onPointerCancel(event: PointerEvent) {
  if (drag.value?.pointerId === event.pointerId) {
    drag.value = null
    document.body.classList.remove('is-dragging')
  }
  clearPress()
}

function startDrag(event: PointerEvent) {
  const pending = pendingPress
  if (!pending) return
  const cell = pending.target.closest<HTMLElement>('.participant-cell')
  if (!cell) return
  const card = cell.querySelector<HTMLElement>('.participant-card')
  if (!card) return
  const activeRect = card.getBoundingClientRect()
  const sourceIds = orderedParticipants.value.map((participant) => participant.collector_id)
  const rects = sourceIds
    .map((id) => {
      const node = document.querySelector<HTMLElement>(`.participant-cell[data-id="${CSS.escape(id)}"] .participant-card`)
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return {
        id,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        midX: rect.left + rect.width / 2,
        midY: rect.top + rect.height / 2,
      }
    })
    .filter((item): item is DragState['rects'][number] => Boolean(item))
  drag.value = {
    activeId: pending.id,
    sourceIds,
    targetIndex: sourceIds.indexOf(pending.id),
    pointerId: pending.pointerId,
    x: pending.x,
    y: pending.y,
    offsetX: pending.x - activeRect.left,
    offsetY: pending.y - activeRect.top,
    width: activeRect.width,
    height: activeRect.height,
    rects,
  }
  pending.target.setPointerCapture?.(pending.pointerId)
  document.body.classList.add('is-dragging')
  pendingPress = null
  event.preventDefault()
}

function indexForPointer(state: DragState, centerX: number, centerY: number): number {
  const orderedRects = state.sourceIds
    .map((id) => state.rects.find((rect) => rect.id === id))
    .filter((rect): rect is DragState['rects'][number] => Boolean(rect))
  const rowTolerance = Math.max(24, state.height * 0.38)
  for (let index = 0; index < orderedRects.length; index++) {
    const rect = orderedRects[index]
    if (centerY < rect.midY - rowTolerance) return index
    if (Math.abs(centerY - rect.midY) <= rowTolerance && centerX < rect.midX) return index
  }
  return orderedRects.length - 1
}

function clearPress() {
  if (pressTimer) window.clearTimeout(pressTimer)
  pressTimer = 0
  pendingPress = null
}

function isTouchLike(event: PointerEvent) {
  return event.pointerType === 'touch' || event.pointerType === 'pen'
}

watch(expandedIds, (ids) => {
  ids.forEach((id) => {
    if ((activeTabs.get(id) ?? 'heart') === 'heart') void ensureSeries(id, participantWindow(id), false)
  })
})

onMounted(() => {
  void refreshParticipants()
  eventSource = openLobbyEvents(applyLobbyEvent, () => {
    eventError.value = true
  })
  clockTimer = window.setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
  window.addEventListener('pointermove', onPointerMove, { passive: false })
  window.addEventListener('pointerup', onPointerUp, { passive: false })
  window.addEventListener('pointercancel', onPointerCancel, { passive: false })
  window.addEventListener('resize', onResize)
  nextTick(() => {
    updateParticipantGridWidth()
    if (participantGridEl.value && typeof ResizeObserver !== 'undefined') {
      gridResizeObserver = new ResizeObserver(updateParticipantGridWidth)
      gridResizeObserver.observe(participantGridEl.value)
    }
    document.documentElement.dataset.heartwithReady = '1'
  })
})

onBeforeUnmount(() => {
  eventSource?.close()
  if (clockTimer) window.clearInterval(clockTimer)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerCancel)
  window.removeEventListener('resize', onResize)
  gridResizeObserver?.disconnect()
})

function onResize() {
  viewportWidth.value = window.innerWidth
  updateParticipantGridWidth()
}

function updateParticipantGridWidth() {
  participantGridWidth.value = participantGridEl.value?.clientWidth || window.innerWidth
}

function estimateTextWidth(text: string) {
  let width = 0
  for (const char of text) {
    width += /[\u2E80-\u9FFF]/.test(char) ? 17 : /[A-Z0-9]/.test(char) ? 10 : 8
  }
  return width
}

function estimateParticipantCardWidth(participant: Participant) {
  const titleWidth = estimateTextWidth(participantName(participant))
  const subtitleWidth = estimateTextWidth(participant.device_model || 'Unknown device')
  const copyWidth = Math.max(titleWidth, subtitleWidth)
  return Math.ceil(copyWidth + 168)
}
</script>

<template>
  <main class="app-shell">
    <div class="topbar">
      <div>
        <h1>Heartwith</h1>
        <p>公共心率大厅</p>
      </div>
      <MiuixButton class="refresh-button" :disabled="isRefreshing" @click="refreshParticipants">刷新</MiuixButton>
    </div>

    <section class="overview">
      <div class="live-card panel">
        <span class="badge">实时大厅</span>
        <p>已连接实时事件</p>
        <small v-if="eventError">SSE 连接异常，已保留手动刷新</small>
      </div>
      <div class="stat-card panel">
        <span>在线</span>
        <strong>{{ onlineCount }}</strong>
      </div>
      <div class="stat-card panel">
        <span>全部</span>
        <strong>{{ participants.length }}</strong>
      </div>
    </section>

    <section class="lobby-heading">
      <h2>大厅</h2>
      <div class="filter-row" aria-label="离线隐藏时间">
        <span>隐藏离线超过</span>
        <button
          v-for="option in filterOptions"
          :key="option.label"
          type="button"
          :class="{ active: filterWindowMs === option.value }"
          @click="filterWindowMs = option.value"
        >
          {{ option.label }}
        </button>
      </div>
    </section>

    <section ref="participantGridEl" class="participant-grid" :style="{ '--grid-columns': gridColumns }">
      <template v-for="participant in renderParticipants" :key="participant.collector_id">
        <div
          class="participant-cell"
          :class="{ hidden: drag?.activeId === participant.collector_id }"
          :data-id="participant.collector_id"
        >
          <div
            class="participant-card"
            :class="[statusClass(participant), { expanded: expandedIds.has(participant.collector_id) }]"
            @click="toggleExpanded(participant.collector_id)"
            @pointerdown="onPointerDown(participant, $event)"
          >
            <div class="participant-main">
              <div class="participant-copy">
                <strong>{{ participantName(participant) }}</strong>
                <span>
                  {{ participant.device_model || 'Unknown device' }}
                </span>
                <em v-if="participant.sleep">{{ sleepLabel(participant.sleep) }}</em>
              </div>
              <div class="participant-live">
                <span :class="statusClass(participant)">{{ statusText(participant) }}</span>
                <b>{{ participant.last_bpm ?? '-' }}</b>
              </div>
            </div>
          </div>

          <div v-if="expandedIds.has(participant.collector_id)" class="detail-card">
            <div class="detail-header">
              <div>
                <span class="section-label">详情</span>
                <h3>{{ participantName(participant) }}</h3>
              </div>
              <div class="detail-tabs" aria-label="详情类型">
                <button
                  type="button"
                  :class="{ active: participantTab(participant.collector_id) === 0 }"
                  @click="setParticipantTab(participant.collector_id, 0)"
                >
                  心率
                </button>
                <button
                  type="button"
                  :class="{ active: participantTab(participant.collector_id) === 1 }"
                  @click="setParticipantTab(participant.collector_id, 1)"
                >
                  睡眠
                </button>
              </div>
            </div>

            <template v-if="participantTab(participant.collector_id) === 0">
              <div class="range-row">
                <button
                  v-for="option in windowOptions"
                  :key="option.value"
                  type="button"
                  :class="{ active: participantWindow(participant.collector_id) === option.value }"
                  @click="setParticipantWindow(participant.collector_id, option.value)"
                >
                  {{ option.label }}
                </button>
              </div>
              <HeartRateChart
                :samples="seriesFor(participant.collector_id, participantWindow(participant.collector_id))"
                :window-seconds="participantWindow(participant.collector_id)"
                :now-ms="nowMs"
              />
            </template>
            <SleepReport v-else :sleep="participant.sleep" />
          </div>
        </div>
      </template>
    </section>

    <div
      v-if="activeOverlay && drag"
      class="participant-card drag-overlay"
      :class="statusClass(activeOverlay)"
      :style="{
        width: `${drag.width}px`,
        height: `${drag.height}px`,
        transform: `translate3d(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px, 0)`,
      }"
    >
      <div class="participant-main">
        <div class="participant-copy">
          <strong>{{ participantName(activeOverlay) }}</strong>
          <span>{{ activeOverlay.device_model || 'Unknown device' }} · {{ statusText(activeOverlay) }}</span>
        </div>
        <div class="participant-live">
          <span :class="statusClass(activeOverlay)">{{ statusText(activeOverlay) }}</span>
          <b>{{ activeOverlay.last_bpm ?? '-' }}</b>
        </div>
      </div>
    </div>
  </main>
</template>
