<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SeriesSample, WindowSeconds } from '../types'

const props = defineProps<{
  samples: SeriesSample[]
  windowSeconds: WindowSeconds
  nowMs: number
}>()

type ChartRange = {
  startMs: number
  endMs: number
}

type SelectionState = {
  startX: number
  currentX: number
}

const canvasRef = ref<HTMLCanvasElement | null>(null)
const hover = ref<SeriesSample | null>(null)
const selectedRange = ref<ChartRange | null>(null)
const selection = ref<SelectionState | null>(null)
const lastPointer = ref<{ clientX: number; clientY: number } | null>(null)
let resizeObserver: ResizeObserver | null = null
let activePointerId: number | null = null
let canvasPixelWidth = 0
let canvasPixelHeight = 0

const fullRange = computed<ChartRange>(() => ({
  startMs: props.nowMs - props.windowSeconds * 1000,
  endMs: props.nowMs,
}))

const activeRange = computed<ChartRange>(() => {
  const full = fullRange.value
  const selected = selectedRange.value
  if (!selected) return full
  const startMs = Math.max(full.startMs, Math.min(selected.startMs, selected.endMs))
  const endMs = Math.min(full.endMs, Math.max(selected.startMs, selected.endMs))
  return endMs - startMs >= 1000 ? { startMs, endMs } : full
})

const visibleSamples = computed(() => {
  const range = activeRange.value
  const normalized = props.samples
    .filter((sample) => sample.t_ms >= range.startMs && sample.t_ms <= range.endMs + 5000 && sample.bpm > 0)
    .sort((a, b) => a.t_ms - b.t_ms)
  return smoothForWindow(normalized, Math.round((range.endMs - range.startMs) / 1000))
})

const stats = computed(() => {
  const values = visibleSamples.value.map((sample) => sample.bpm)
  if (!values.length) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const avg = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
  return { min, max, avg, count: values.length }
})

const windowLabel = computed(() => {
  if (selectedRange.value) return `${formatClock(activeRange.value.startMs)} - ${formatClock(activeRange.value.endMs)}`
  if (props.windowSeconds === 600) return '最近 10 分钟'
  if (props.windowSeconds === 3600) return '最近 1 小时'
  if (props.windowSeconds === 21600) return '最近 6 小时'
  return '最近 24 小时'
})

function smoothForWindow(samples: SeriesSample[], windowSeconds: number): SeriesSample[] {
  if (windowSeconds < 21_600 || samples.length < 300) return samples
  const bucketMs = windowSeconds >= 86_400 ? 180_000 : 60_000
  const buckets = new Map<number, { t: number; sum: number; count: number }>()
  for (const sample of samples) {
    const bucket = Math.floor(sample.t_ms / bucketMs) * bucketMs
    const item = buckets.get(bucket) || { t: 0, sum: 0, count: 0 }
    item.t += sample.t_ms
    item.sum += sample.bpm
    item.count += 1
    buckets.set(bucket, item)
  }
  return [...buckets.values()]
    .map((item) => ({ t_ms: Math.round(item.t / item.count), bpm: Math.round(item.sum / item.count) }))
    .sort((a, b) => a.t_ms - b.t_ms)
}

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const ratio = window.devicePixelRatio || 1
  const nextPixelWidth = Math.max(1, Math.floor(rect.width * ratio))
  const nextPixelHeight = Math.max(1, Math.floor(rect.height * ratio))
  if (canvasPixelWidth !== nextPixelWidth || canvasPixelHeight !== nextPixelHeight) {
    canvas.width = nextPixelWidth
    canvas.height = nextPixelHeight
    canvasPixelWidth = nextPixelWidth
    canvasPixelHeight = nextPixelHeight
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, rect.width, rect.height)

  const samples = visibleSamples.value
  const left = 56
  const right = 16
  const top = 14
  const bottom = 30
  const width = Math.max(1, rect.width - left - right)
  const height = Math.max(1, rect.height - top - bottom)
  const range = activeRange.value
  const minTime = range.startMs
  const maxTime = range.endMs
  const rangeMs = Math.max(1, maxTime - minTime)
  const values = samples.map((sample) => sample.bpm)
  const minValue = values.length ? Math.max(30, Math.min(...values) - 8) : 50
  const maxValue = values.length ? Math.max(...values) + 8 : 120
  const yMin = minValue === maxValue ? minValue - 10 : minValue
  const yMax = minValue === maxValue ? maxValue + 10 : maxValue

  ctx.fillStyle = 'rgba(255,255,255,0.035)'
  roundRect(ctx, left, top, width, height, 10)
  ctx.fill()

  ctx.strokeStyle = 'rgba(255,255,255,0.09)'
  ctx.lineWidth = 1
  ctx.font = '12px MiSans, system-ui, sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < 4; i++) {
    const y = top + (height * i) / 3
    const value = Math.round(yMax - ((yMax - yMin) * i) / 3)
    ctx.beginPath()
    ctx.moveTo(left, y)
    ctx.lineTo(left + width, y)
    ctx.stroke()
    ctx.fillText(String(value), left - 10, y)
  }

  if (samples.length >= 2) {
    const segments = splitSegments(samples, gapThresholdMs(Math.round((maxTime - minTime) / 1000)))
    for (const segment of segments) {
      if (segment.length < 2) continue
      const points = segment.map((sample) => ({
        x: left + ((sample.t_ms - minTime) / rangeMs) * width,
        y: top + (1 - (sample.bpm - yMin) / (yMax - yMin)) * height,
      }))

      const fill = ctx.createLinearGradient(0, top, 0, top + height)
      fill.addColorStop(0, 'rgba(10, 132, 255, 0.30)')
      fill.addColorStop(1, 'rgba(10, 132, 255, 0.05)')
      ctx.beginPath()
      ctx.moveTo(points[0].x, top + height)
      points.forEach((point) => ctx.lineTo(point.x, point.y))
      ctx.lineTo(points[points.length - 1].x, top + height)
      ctx.closePath()
      ctx.fillStyle = fill
      ctx.fill()

      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) {
        const previous = points[i - 1]
        const current = points[i]
        const midX = (previous.x + current.x) / 2
        ctx.bezierCurveTo(midX, previous.y, midX, current.y, current.x, current.y)
      }
      ctx.strokeStyle = '#0a84ff'
      ctx.lineWidth = 3
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.stroke()
    }
  }

  if (selection.value) {
    const startX = clamp(selection.value.startX, left, left + width)
    const currentX = clamp(selection.value.currentX, left, left + width)
    const x = Math.min(startX, currentX)
    const selectionWidth = Math.abs(currentX - startX)
    ctx.fillStyle = 'rgba(10, 132, 255, 0.18)'
    roundRect(ctx, x, top, selectionWidth, height, 8)
    ctx.fill()
    ctx.strokeStyle = 'rgba(10, 132, 255, 0.9)'
    ctx.lineWidth = 1.5
    roundRect(ctx, x, top, selectionWidth, height, 8)
    ctx.stroke()
  }

  const currentHover = hover.value
  const activeHover = currentHover && currentHover.t_ms >= minTime && currentHover.t_ms <= maxTime ? currentHover : null
  if (activeHover) {
    const x = left + ((activeHover.t_ms - minTime) / rangeMs) * width
    const y = top + (1 - (activeHover.bpm - yMin) / (yMax - yMin)) * height
    ctx.strokeStyle = 'rgba(10, 132, 255, 0.65)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, top)
    ctx.lineTo(x, top + height)
    ctx.stroke()
    ctx.fillStyle = '#0a84ff'
    ctx.beginPath()
    ctx.arc(x, y, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 3
    ctx.stroke()

    const label = `${formatClock(activeHover.t_ms)}  ${activeHover.bpm} BPM`
    ctx.font = '12px MiSans, system-ui, sans-serif'
    const labelWidth = Math.ceil(ctx.measureText(label).width)
    const labelHeight = 28
    const labelX = clamp(x + 12, left + 8, left + width - labelWidth - 20)
    const labelY = clamp(y - 42, top + 8, top + height - labelHeight - 8)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.78)'
    roundRect(ctx, labelX, labelY, labelWidth + 20, labelHeight, 10)
    ctx.fill()
    ctx.strokeStyle = 'rgba(10, 132, 255, 0.55)'
    ctx.lineWidth = 1
    roundRect(ctx, labelX, labelY, labelWidth + 20, labelHeight, 10)
    ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.92)'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, labelX + 10, labelY + labelHeight / 2)
  }

  ctx.font = '13px MiSans, system-ui, sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.62)'
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.fillText(startLabel(props.windowSeconds), left, top + height + 12)
  ctx.textAlign = 'right'
  ctx.fillText('now', left + width, top + height + 12)
}

function splitSegments(samples: SeriesSample[], thresholdMs: number): SeriesSample[][] {
  const segments: SeriesSample[][] = []
  let current: SeriesSample[] = []
  for (const sample of samples) {
    const previous = current[current.length - 1]
    if (previous && sample.t_ms - previous.t_ms > thresholdMs) {
      segments.push(current)
      current = []
    }
    current.push(sample)
  }
  if (current.length) segments.push(current)
  return segments
}

function gapThresholdMs(windowSeconds: number): number {
  if (windowSeconds <= 600) return 45_000
  if (windowSeconds <= 3600) return 120_000
  if (windowSeconds <= 21_600) return 8 * 60_000
  return 20 * 60_000
}

function startLabel(windowSeconds: number): string {
  if (windowSeconds === 600) return '10m ago'
  if (windowSeconds === 3600) return '1h ago'
  if (windowSeconds === 21600) return '6h ago'
  return '24h ago'
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + width, y, x + width, y + height, radius)
  ctx.arcTo(x + width, y + height, x, y + height, radius)
  ctx.arcTo(x, y + height, x, y, radius)
  ctx.arcTo(x, y, x + width, y, radius)
  ctx.closePath()
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function chartBounds(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect()
  const left = 56
  const right = 16
  const top = 14
  const bottom = 30
  return {
    rect,
    left,
    right,
    top,
    bottom,
    width: Math.max(1, rect.width - left - right),
    height: Math.max(1, rect.height - top - bottom),
  }
}

function timeForCanvasX(canvasX: number, range: ChartRange) {
  const canvas = canvasRef.value
  if (!canvas) return range.startMs
  const bounds = chartBounds(canvas)
  const x = clamp(canvasX, bounds.left, bounds.left + bounds.width)
  return range.startMs + ((x - bounds.left) / bounds.width) * Math.max(1, range.endMs - range.startMs)
}

function formatClock(ms: number): string {
  const date = new Date(ms)
  const now = new Date(props.nowMs)
  const time = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return time
  }
  const day = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
  }).format(date)
  return `${day} ${time}`
}

function updateHover(clientX: number, clientY: number) {
  lastPointer.value = { clientX, clientY }
  const canvas = canvasRef.value
  const samples = visibleSamples.value
  if (!canvas) return
  if (!samples.length) {
    hover.value = null
    draw()
    return
  }
  const bounds = chartBounds(canvas)
  const x = clientX - bounds.rect.left
  const range = activeRange.value
  const t = timeForCanvasX(x, range)
  let nearest = samples[0]
  let nearestDistance = Math.abs(samples[0].t_ms - t)
  for (const sample of samples) {
    const distance = Math.abs(sample.t_ms - t)
    if (distance < nearestDistance) {
      nearest = sample
      nearestDistance = distance
    }
  }
  hover.value = nearest
  draw()
  void clientY
}

function clearHover() {
  if (activePointerId !== null) return
  lastPointer.value = null
  hover.value = null
  draw()
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  const canvas = canvasRef.value
  if (!canvas) return
  event.preventDefault()
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  activePointerId = event.pointerId
  const bounds = chartBounds(canvas)
  const x = clamp(event.clientX - bounds.rect.left, bounds.left, bounds.left + bounds.width)
  selection.value = { startX: x, currentX: x }
  updateHover(event.clientX, event.clientY)
  draw()
}

function onPointerMove(event: PointerEvent) {
  if (activePointerId === event.pointerId && selection.value) {
    const canvas = canvasRef.value
    if (!canvas) return
    event.preventDefault()
    const bounds = chartBounds(canvas)
    selection.value.currentX = clamp(event.clientX - bounds.rect.left, bounds.left, bounds.left + bounds.width)
    updateHover(event.clientX, event.clientY)
    draw()
    return
  }
  updateHover(event.clientX, event.clientY)
}

function onMouseMove(event: MouseEvent) {
  if (activePointerId !== null) return
  updateHover(event.clientX, event.clientY)
}

function onPointerUp(event: PointerEvent) {
  if (activePointerId !== event.pointerId) return
  const canvas = canvasRef.value
  const currentSelection = selection.value
  const target = event.currentTarget as HTMLElement
  target.releasePointerCapture(event.pointerId)
  activePointerId = null
  selection.value = null
  if (canvas && currentSelection) {
    const distance = Math.abs(currentSelection.currentX - currentSelection.startX)
    if (distance >= 18) {
      const sourceRange = activeRange.value
      const startMs = timeForCanvasX(Math.min(currentSelection.startX, currentSelection.currentX), sourceRange)
      const endMs = timeForCanvasX(Math.max(currentSelection.startX, currentSelection.currentX), sourceRange)
      if (endMs - startMs >= 5000) selectedRange.value = { startMs, endMs }
    }
  }
  requestAnimationFrame(() => {
    updateHover(event.clientX, event.clientY)
    draw()
  })
}

function onPointerCancel(event: PointerEvent) {
  if (activePointerId !== event.pointerId) return
  activePointerId = null
  selection.value = null
  clearHover()
}

function resetRange() {
  selectedRange.value = null
  requestAnimationFrame(() => {
    const pointer = lastPointer.value
    if (pointer) updateHover(pointer.clientX, pointer.clientY)
    draw()
  })
}

onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return
  resizeObserver = new ResizeObserver(draw)
  resizeObserver.observe(canvas)
  draw()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
})
watch(
  () => props.windowSeconds,
  () => {
    selectedRange.value = null
    selection.value = null
    hover.value = null
    lastPointer.value = null
  },
)
watch(visibleSamples, (samples) => {
  if (hover.value && !samples.some((sample) => sample.t_ms === hover.value?.t_ms && sample.bpm === hover.value.bpm)) {
    const pointer = lastPointer.value
    if (pointer) {
      requestAnimationFrame(() => updateHover(pointer.clientX, pointer.clientY))
    } else {
      hover.value = null
    }
  }
})
watch([visibleSamples, activeRange, () => props.nowMs], draw, { flush: 'post' })
</script>

<template>
  <div class="chart-shell">
    <div class="chart-stage">
      <canvas ref="canvasRef" class="heart-chart" />
      <div
        class="chart-hit-layer"
        @pointerenter="onPointerMove"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerCancel"
        @pointerleave="clearHover"
        @mouseenter="onMouseMove"
        @mousemove="onMouseMove"
        @mouseleave="clearHover"
      />
    </div>
    <div class="chart-meta">
      <span v-if="stats">最低 {{ stats.min }} · 最高 {{ stats.max }} · 平均 {{ stats.avg }} · {{ stats.count }} 个样本</span>
      <span v-else>等待更多样本</span>
      <span class="chart-range">
        {{ windowLabel }}
        <button v-if="selectedRange" type="button" @click="resetRange">还原</button>
      </span>
    </div>
    <div v-if="hover" class="chart-hover">
      {{ formatClock(hover.t_ms) }} · {{ hover.bpm }} BPM
    </div>
  </div>
</template>

<style scoped>
.chart-shell {
  min-width: 0;
}

.chart-stage {
  position: relative;
  width: 100%;
  height: clamp(150px, 16vw, 220px);
}

.heart-chart {
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.chart-hit-layer {
  position: absolute;
  inset: 0;
  cursor: crosshair;
  pointer-events: auto;
  touch-action: none;
}

.chart-meta {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-top: 8px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.45;
}

.chart-hover {
  margin-top: 6px;
  color: var(--accent);
  font-size: 13px;
  font-weight: 700;
}

.chart-range {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.chart-range button {
  border: 0;
  border-radius: 999px;
  padding: 3px 9px;
  background: rgba(10, 132, 255, 0.16);
  color: var(--accent);
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

@media (max-width: 720px) {
  .chart-stage {
    height: 190px;
  }

  .chart-meta {
    flex-direction: column;
    gap: 4px;
  }
}
</style>
