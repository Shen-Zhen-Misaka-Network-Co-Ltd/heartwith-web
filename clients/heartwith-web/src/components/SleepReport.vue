<script setup lang="ts">
import { computed } from 'vue'
import type { SleepSegment, SleepStatus } from '../types'
import { formatClock, formatDateTime, formatDuration, sleepLabel, sleepTimes } from '../utils'

const props = defineProps<{
  sleep?: SleepStatus | null
}>()

const times = computed(() => sleepTimes(props.sleep))

const durationMinutes = computed(() => {
  if (props.sleep?.duration_minutes) return props.sleep.duration_minutes
  const start = times.value.deviceBed ?? times.value.goBed
  const end = times.value.wake
  if (!start || !end || end <= start) return null
  return Math.round((end - start) / 60_000)
})

const timeline = computed(() => {
  const points = [
    { key: 'goBed', label: '上床', time: times.value.goBed },
    { key: 'deviceBed', label: '入睡', time: times.value.deviceBed },
    { key: 'wake', label: '清醒', time: times.value.wake },
  ].filter((point) => point.time) as Array<{ key: string; label: string; time: number }>
  if (!points.length) return []
  const min = Math.min(...points.map((point) => point.time))
  const max = Math.max(...points.map((point) => point.time))
  const span = Math.max(1, max - min)
  const positioned = points.map((point, index) => {
    const raw = ((point.time - min) / span) * 100
    const position = points.length === 1 ? 50 : Math.min(92, Math.max(8, raw))
    return { ...point, position, index }
  })
  const minGap = points.length >= 3 ? 18 : 24
  for (let i = 1; i < positioned.length; i++) {
    positioned[i].position = Math.max(positioned[i].position, positioned[i - 1].position + minGap)
  }
  const overflow = positioned[positioned.length - 1].position - 92
  if (overflow > 0) {
    for (let i = 0; i < positioned.length; i++) {
      positioned[i].position -= overflow
    }
  }
  for (let i = positioned.length - 2; i >= 0; i--) {
    positioned[i].position = Math.min(positioned[i].position, positioned[i + 1].position - minGap)
  }
  for (const point of positioned) {
    point.position = Math.min(92, Math.max(8, point.position))
  }
  return positioned
})

const segments = computed(() => {
  const items = props.sleep?.segments ?? []
  return items
    .map((segment) => {
      const start = segment.bed_at_ms ?? segment.device_bed_at_ms ?? null
      const end = segment.wake_at_ms ?? segment.device_wake_at_ms ?? null
      const duration = segment.duration_minutes ?? (start && end && end > start ? Math.round((end - start) / 60_000) : null)
      return { ...segment, start, end, duration }
    })
    .filter((segment) => segment.start || segment.end || segment.duration)
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
})

function segmentDetails(segment: SleepSegment): string[] {
  return [
    ['深睡', segment.deep_minutes],
    ['浅睡', segment.light_minutes],
    ['REM', segment.rem_minutes],
    ['清醒', segment.awake_minutes],
  ]
    .filter((item): item is [string, number] => typeof item[1] === 'number' && item[1] > 0)
    .map(([label, minutes]) => `${label} ${formatDuration(minutes)}`)
}
</script>

<template>
  <div class="sleep-report">
    <div class="sleep-header">
      <div>
        <div class="sleep-label">{{ sleepLabel(sleep) }}</div>
        <div class="sleep-subtitle">睡眠状态</div>
      </div>
      <div class="sleep-duration">{{ formatDuration(durationMinutes) }}</div>
    </div>

    <div v-if="timeline.length" class="sleep-timeline">
      <div class="timeline-line" />
      <div
        v-for="point in timeline"
        :key="point.key"
        class="timeline-point"
        :style="{ left: `${point.position}%` }"
      >
        <span class="point-dot" />
        <span class="point-label">{{ point.label }}</span>
        <span class="point-time">{{ formatClock(point.time) }}</span>
      </div>
    </div>

    <div class="sleep-metrics">
      <div class="metric">
        <span>上床</span>
        <strong>{{ formatClock(times.goBed) }}</strong>
      </div>
      <div class="metric">
        <span>入睡</span>
        <strong>{{ formatClock(times.deviceBed) }}</strong>
      </div>
      <div class="metric">
        <span>清醒</span>
        <strong>{{ formatClock(times.wake) }}</strong>
      </div>
      <div class="metric">
        <span>更新</span>
        <strong>{{ formatDateTime(times.observed) }}</strong>
      </div>
    </div>

    <div v-if="segments.length" class="sleep-segments">
      <div class="section-title">睡眠片段</div>
      <div class="segment-list">
        <div v-for="(segment, index) in segments" :key="`${segment.start}-${segment.end}-${index}`" class="segment-item">
          <div class="segment-index">第 {{ index + 1 }} 段</div>
          <div class="segment-time">
            <strong>{{ formatClock(segment.start) }}</strong>
            <span>到</span>
            <strong>{{ formatClock(segment.end) }}</strong>
          </div>
          <div class="segment-duration">{{ formatDuration(segment.duration) }}</div>
          <div v-if="segmentDetails(segment).length" class="segment-detail">
            {{ segmentDetails(segment).join(' · ') }}
          </div>
        </div>
      </div>
    </div>

    <div v-if="!sleep" class="sleep-empty">当前用户还没有上报睡眠状态。</div>
  </div>
</template>

<style scoped>
.sleep-report {
  display: grid;
  gap: 20px;
}

.sleep-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.sleep-label {
  color: var(--text);
  font-size: clamp(24px, 4vw, 34px);
  font-weight: 700;
  line-height: 1.15;
}

.sleep-subtitle {
  margin-top: 6px;
  color: var(--muted);
  font-size: 14px;
}

.sleep-duration {
  color: var(--accent);
  font-size: clamp(20px, 3vw, 30px);
  font-weight: 700;
  white-space: nowrap;
}

.sleep-timeline {
  position: relative;
  height: 108px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.04);
  overflow: hidden;
}

.timeline-line {
  position: absolute;
  left: 6%;
  right: 6%;
  top: 44px;
  height: 3px;
  border-radius: 999px;
  background: linear-gradient(90deg, rgba(10, 132, 255, 0.25), rgba(10, 132, 255, 0.9));
}

.timeline-point {
  position: absolute;
  top: 24px;
  transform: translateX(-50%);
  display: grid;
  justify-items: center;
  min-width: 80px;
}

.point-dot {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: var(--accent);
  box-shadow: 0 0 0 6px rgba(10, 132, 255, 0.16);
}

.point-label {
  margin-top: 14px;
  color: var(--muted);
  font-size: 13px;
  white-space: nowrap;
}

.point-time {
  margin-top: 2px;
  color: var(--text);
  font-size: 18px;
  font-weight: 700;
  white-space: nowrap;
}

.sleep-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.metric {
  min-width: 0;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  padding: 14px;
}

.metric span {
  display: block;
  color: var(--muted);
  font-size: 13px;
}

.metric strong {
  display: block;
  margin-top: 8px;
  color: var(--text);
  font-size: 18px;
  line-height: 1.2;
}

.sleep-empty {
  color: var(--muted);
}

.sleep-segments {
  display: grid;
  gap: 10px;
}

.section-title {
  color: var(--muted);
  font-size: 14px;
  font-weight: 700;
}

.segment-list {
  display: grid;
  gap: 8px;
}

.segment-item {
  display: grid;
  grid-template-columns: minmax(56px, auto) minmax(150px, 1fr) auto;
  align-items: center;
  gap: 10px 14px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  padding: 12px 14px;
}

.segment-index {
  color: var(--muted);
  font-size: 13px;
  white-space: nowrap;
}

.segment-time {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--muted);
  min-width: 0;
}

.segment-time strong {
  color: var(--text);
  font-size: 18px;
  white-space: nowrap;
}

.segment-duration {
  color: var(--accent);
  font-size: 15px;
  font-weight: 700;
  white-space: nowrap;
}

.segment-detail {
  grid-column: 2 / -1;
  color: var(--muted);
  font-size: 13px;
  min-width: 0;
}

@media (max-width: 720px) {
  .sleep-header {
    flex-direction: column;
  }

  .sleep-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .segment-item {
    grid-template-columns: 1fr;
    align-items: start;
  }

  .segment-detail {
    grid-column: auto;
  }
}
</style>
