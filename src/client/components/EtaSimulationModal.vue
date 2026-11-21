<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import { getWorkUnitKind } from '../../domain/eta.ts';
import type {
  EtaRateDiagnostic,
  EtaSimulationMode,
  EtaSimulationSnapshot,
  EtaSimulatedSlotItem,
  EtaSimulatedStep,
  EtaWorkType
} from '../../domain/types.ts';
import {
  animateGanttSegments,
  animatePanelEnter,
  animatePanelLeave
} from '../composables/useGsapMotion.ts';
import {
  formatDurationCompact,
  formatFinishClockTime,
  formatLocalTimeWithSeconds
} from '../utils/formatters.ts';
import BaseModalShell from './BaseModalShell.vue';
import UiIcon from './UiIcon.vue';

const PERCENT_SCALE = 100;
const BYTES_PER_MIB = 1024 * 1024;

const MODE_LABELS: Readonly<Record<EtaSimulationMode, string>> = {
  processing: 'Live Job',
  scanning: 'Scanning',
  preview: 'Queue Preview'
};

const WORK_TYPE_SHORT_LABELS: Readonly<Record<EtaWorkType, string>> = {
  loudnorm_p1: 'Pass 1',
  remux_loudnorm: 'Pass 2',
  remux_peak_gain: 'Peak',
  remux_copy: 'Copy',
  finalize_io: 'Move+Backup',
  scan_probe: 'Probe',
  volumedetect: 'Volumedetect',
  verifier_scan_fs: 'FS Scan',
  verifier_scan_probe: 'Verify Probe'
};

const WORK_TYPE_KIND_CLASS: Readonly<Record<EtaWorkType, string>> = {
  loudnorm_p1: 'p1',
  remux_loudnorm: 'p2',
  remux_peak_gain: 'peak',
  remux_copy: 'peak',
  finalize_io: 'io',
  scan_probe: 'scan',
  volumedetect: 'scan',
  verifier_scan_fs: 'scan',
  verifier_scan_probe: 'scan'
};

const props = defineProps<{
  readonly open: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly data: EtaSimulationSnapshot | null;
}>();

const emit = defineEmits<{
  close: [];
  refresh: [];
}>();

const ratesExpanded = ref(false);
const slotListRef = ref<HTMLElement | null>(null);

watch(
  () => props.data?.generatedAtMs,
  async (ts) => {
    if (!ts || !props.open) {
      return;
    }
    await nextTick();
    animateGanttSegments(slotListRef.value);
  },
  { immediate: true }
);

const modeBadge = computed<string | undefined>(() =>
  props.data ? MODE_LABELS[props.data.mode] : undefined
);

const hostSubtitle = computed<string | undefined>(() => {
  if (!props.data) {
    return undefined;
  }
  return `host=${props.data.hostKey} · ${String(props.data.workerCount)} worker slot(s)`;
});

const updatedClockLabel = computed<string>(() =>
  props.data ? formatLocalTimeWithSeconds(props.data.generatedAtMs) : ''
);

const maxSlotSeconds = computed<number>(() => {
  if (!props.data || props.data.slots.length === 0) {
    return 1;
  }
  return Math.max(1, ...props.data.slots.map((s) => s.totalSeconds));
});

interface FlatSimulatedItem {
  readonly slotIndex: number;
  readonly item: EtaSimulatedSlotItem;
}

const flatItems = computed<readonly FlatSimulatedItem[]>(() => {
  if (!props.data) {
    return [];
  }
  const rows: FlatSimulatedItem[] = [];
  for (const slot of props.data.slots) {
    for (const item of slot.items) {
      rows.push({ slotIndex: slot.slotIndex, item });
    }
  }
  return rows.toSorted((a, b) => {
    const aActive = a.item.status === 'active' ? 0 : 1;
    const bActive = b.item.status === 'active' ? 0 : 1;
    if (aActive !== bActive) {
      return aActive - bActive;
    }
    return a.slotIndex - b.slotIndex;
  });
});

interface GanttSegment {
  readonly key: string;
  readonly widthPercent: number;
  readonly kindClass: string;
  readonly tooltip: string;
}

function buildSlotSegments(items: readonly EtaSimulatedSlotItem[]): readonly GanttSegment[] {
  const scale = maxSlotSeconds.value;
  const segments: GanttSegment[] = [];
  for (const item of items) {
    for (let idx = 0; idx < item.steps.length; idx += 1) {
      const step = item.steps[idx]!;
      if (step.remainingSeconds <= 0) {
        continue;
      }
      const label = WORK_TYPE_SHORT_LABELS[step.workType];
      segments.push({
        key: `${item.itemId}-${step.workType}-${String(idx)}`,
        widthPercent: (step.remainingSeconds / scale) * PERCENT_SCALE,
        kindClass: `vo-slot-seg--${WORK_TYPE_KIND_CLASS[step.workType]}`,
        tooltip: `${item.fileName} · ${label}: ${formatDurationCompact(step.remainingSeconds)} (${formatRate(step.workType, step.rateUsed)}, ${step.rateSource})`
      });
    }
  }
  return segments;
}

function formatRate(workType: EtaWorkType, rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) {
    return '—';
  }
  const kind = getWorkUnitKind(workType);
  if (kind === 'bytes') {
    return `${(rate / BYTES_PER_MIB).toFixed(1)} MB/s`;
  }
  if (kind === 'entries') {
    return `${rate.toFixed(2)} items/s`;
  }
  return `${rate.toFixed(2)}x`;
}

function formatStepSummary(step: EtaSimulatedStep, isActiveItem: boolean): string {
  const label = WORK_TYPE_SHORT_LABELS[step.workType];
  if (isActiveItem && step.totalUnits > 0 && step.completedUnits > 0) {
    if (step.remainingUnits <= 0) {
      return `${label} (${String(PERCENT_SCALE)}%)`;
    }
    const pct = Math.min(
      PERCENT_SCALE,
      Math.max(0, Math.round((step.completedUnits / step.totalUnits) * PERCENT_SCALE))
    );
    return `${label} (${String(pct)}%): ${formatDurationCompact(step.remainingSeconds)}`;
  }
  return `${label}: ${formatDurationCompact(step.remainingSeconds)}`;
}

function formatRateTuple(diag: EtaRateDiagnostic): string {
  return `eff ${formatRate(diag.workType, diag.effectiveRate)} · base ${formatRate(diag.workType, diag.baselineRate)} · live ${formatRate(diag.workType, diag.liveRate)}`;
}
</script>

<template>
  <BaseModalShell
    :open="props.open"
    title="ETA Simulation"
    :badge="modeBadge"
    :subtitle="hostSubtitle"
    max-width="58rem"
    :z-offset="1"
    @close="emit('close')"
  >
    <template #header-meta>
      <span v-if="updatedClockLabel" class="vo-hint vo-mono vo-eta-updated">
        Updated {{ updatedClockLabel }}
      </span>
    </template>

    <template #header-actions>
      <button
        type="button"
        class="vo-btn vo-eta-refresh"
        :disabled="props.loading"
        @click="emit('refresh')"
      >
        <UiIcon :name="props.loading ? 'spinner' : 'refresh'" />
        {{ props.loading ? 'Refreshing...' : 'Refresh' }}
      </button>
    </template>

    <div v-if="props.error" class="vo-alert">{{ props.error }}</div>

    <div v-else-if="!props.data && props.loading" class="vo-muted">
      Calculating live queue ETA simulation...
    </div>

    <template v-else-if="props.data">
      <div class="vo-kpi-grid">
        <div class="vo-kpi-card">
          <span class="vo-kpi-label">Estimated Completion</span>
          <strong class="vo-kpi-value vo-mono">
            {{
              props.data.etaSeconds !== undefined
                ? `${props.data.etaState === 'calibrating' ? '~' : ''}${formatDurationCompact(props.data.etaSeconds)}`
                : flatItems.length > 0 || props.data.mode === 'scanning'
                  ? 'Calibrating...'
                  : 'No pending work'
            }}
          </strong>
          <span v-if="props.data.etaSeconds !== undefined" class="vo-hint vo-mono">
            Finish at
            {{ formatFinishClockTime(props.data.etaSeconds, props.data.generatedAtMs) }}
          </span>
        </div>

        <div class="vo-kpi-card">
          <span class="vo-kpi-label">Weighted Progress</span>
          <strong class="vo-kpi-value vo-mono">
            {{ Math.round(props.data.weightedFraction * PERCENT_SCALE) }}%
          </strong>
          <span class="vo-hint">By estimated step duration</span>
        </div>

        <div class="vo-kpi-card">
          <span class="vo-kpi-label">Parallel Slots</span>
          <strong class="vo-kpi-value vo-mono">
            {{ props.data.workerCount }} worker{{ props.data.workerCount === 1 ? '' : 's' }}
          </strong>
          <span class="vo-hint vo-mono">{{ flatItems.length }} pending/active item(s)</span>
        </div>

        <div class="vo-kpi-card">
          <span class="vo-kpi-label">Calibration</span>
          <strong class="vo-kpi-value vo-mono">{{ props.data.etaState }}</strong>
          <span class="vo-hint vo-mono">
            {{ Math.round(props.data.fallbackShare * PERCENT_SCALE) }}% fallback
          </span>
        </div>
      </div>

      <section v-if="props.data.slots.length > 0 && flatItems.length > 0" class="vo-eta-section">
        <div class="vo-section-head">
          <h3>Slot Schedule (Makespan)</h3>
          <div class="vo-legend">
            <span class="vo-legend-item">
              <span class="vo-legend-swatch vo-slot-seg--p1" /> Pass 1
            </span>
            <span class="vo-legend-item">
              <span class="vo-legend-swatch vo-slot-seg--p2" /> Pass 2
            </span>
            <span class="vo-legend-item">
              <span class="vo-legend-swatch vo-slot-seg--peak" /> Peak / Copy
            </span>
            <span class="vo-legend-item">
              <span class="vo-legend-swatch vo-slot-seg--io" /> Move+Backup
            </span>
          </div>
        </div>

        <div ref="slotListRef" class="vo-slot-list">
          <div v-for="slot in props.data.slots" :key="slot.slotIndex" class="vo-slot-row">
            <span class="vo-slot-label vo-mono">Slot {{ slot.slotIndex + 1 }}</span>
            <div class="vo-slot-track">
              <div
                v-for="seg in buildSlotSegments(slot.items)"
                :key="seg.key"
                class="vo-slot-seg"
                :class="seg.kindClass"
                :style="{ width: `${seg.widthPercent.toFixed(2)}%` }"
                :title="seg.tooltip"
              />
            </div>
            <span class="vo-slot-total vo-mono">
              {{ formatDurationCompact(slot.totalSeconds) }}
            </span>
          </div>
        </div>
      </section>

      <section v-else class="vo-muted">No pending or active items in this simulation.</section>

      <section v-if="flatItems.length > 0" class="vo-eta-section">
        <div class="vo-section-head">
          <h3>Queue Step Breakdown ({{ flatItems.length }})</h3>
        </div>
        <div class="vo-operator-list vo-eta-items-list">
          <div
            v-for="row in flatItems"
            :key="`${String(row.slotIndex)}-${row.item.itemId}`"
            class="vo-operator-row vo-eta-item-row"
            :class="{ 'vo-operator-row--active': row.item.status === 'active' }"
          >
            <div class="vo-eta-item-main">
              <div class="vo-eta-item-head">
                <span
                  class="vo-badge vo-mono"
                  :class="{ 'vo-badge--ok': row.item.status === 'active' }"
                >
                  Slot {{ row.slotIndex + 1 }}{{ row.item.status === 'active' ? ' · Active' : '' }}
                </span>
                <strong class="vo-eta-item-name" :title="row.item.fileName">
                  {{ row.item.fileName }}
                </strong>
              </div>
              <div class="vo-eta-step-chips">
                <span
                  v-for="(step, sIdx) in row.item.steps"
                  :key="`${row.item.itemId}-${step.workType}-${String(sIdx)}`"
                  class="vo-badge vo-mono vo-eta-step-chip"
                  :class="{ 'vo-badge--warn': step.rateSource === 'cold_default' }"
                  :title="`${step.workType} (${step.profile}) · ${formatRate(step.workType, step.rateUsed)} [${step.rateSource}]`"
                >
                  {{ formatStepSummary(step, row.item.status === 'active') }}
                </span>
              </div>
            </div>
            <span class="vo-eta-item-total vo-mono">
              {{ formatDurationCompact(row.item.remainingSeconds) }}
            </span>
          </div>
        </div>
      </section>

      <section v-if="props.data.rates.length > 0" class="vo-eta-section">
        <div class="vo-section-head">
          <button
            type="button"
            class="vo-btn vo-rates-toggle"
            :aria-expanded="ratesExpanded"
            @click="ratesExpanded = !ratesExpanded"
          >
            Calibrator Rates ({{ props.data.rates.length }})
            <span aria-hidden="true">{{ ratesExpanded ? '▴' : '▾' }}</span>
          </button>
        </div>

        <Transition :css="false" @enter="animatePanelEnter" @leave="animatePanelLeave">
          <div v-if="ratesExpanded" class="vo-operator-list">
            <div
              v-for="diag in props.data.rates"
              :key="`${diag.workType}:${diag.profile}`"
              class="vo-operator-row vo-rate-row"
            >
              <div class="vo-rate-identity">
                <span class="vo-mono">{{ diag.workType }}:{{ diag.profile }}</span>
                <span class="vo-badge vo-mono">{{ diag.source }} ({{ diag.sampleCount }})</span>
              </div>
              <span class="vo-hint vo-mono vo-rate-values">{{ formatRateTuple(diag) }}</span>
            </div>
          </div>
        </Transition>
      </section>
    </template>
  </BaseModalShell>
</template>

<style scoped lang="scss">
.vo-eta-updated {
  line-height: 1;
  white-space: nowrap;
}

.vo-eta-refresh {
  flex-shrink: 0;
}

.vo-kpi-grid {
  display: grid;
  gap: var(--vo-space-2);
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.vo-kpi-card {
  display: grid;
  align-content: start;
  gap: calc(var(--vo-space-1) / 2);
  padding: var(--vo-space-2) var(--vo-space-3);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background-color: var(--vo-surface-elevated);
  min-inline-size: 0;
}

@media (width <= 680px) {
  .vo-kpi-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (width <= 420px) {
  .vo-kpi-grid {
    grid-template-columns: 1fr;
  }
}

.vo-kpi-label {
  color: var(--vo-text-muted);
  font-size: var(--vo-text-2xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.vo-kpi-value {
  font-size: var(--vo-text-sm);
  font-variant-numeric: tabular-nums;
}

.vo-eta-section {
  display: grid;
  gap: var(--vo-space-2);
}

.vo-section-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-2);

  h3 {
    margin: 0;
    color: var(--vo-text-muted);
    font-size: var(--vo-text-xs);
    font-weight: var(--vo-weight-semibold);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
}

.vo-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-3);
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
}

.vo-legend-item {
  display: inline-flex;
  align-items: center;
  gap: var(--vo-space-1);
}

.vo-legend-swatch {
  display: inline-block;
  border-radius: calc(var(--vo-radius-sm) / 2);
  inline-size: 0.625rem;
  block-size: 0.625rem;
}

.vo-slot-list {
  display: grid;
  gap: var(--vo-space-2);
}

.vo-slot-row {
  display: grid;
  align-items: center;
  gap: var(--vo-space-2);
  grid-template-columns: 3.75rem minmax(0, 1fr) 4.75rem;
}

.vo-slot-label {
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
}

.vo-slot-track {
  display: flex;
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background-color: var(--vo-surface-elevated);
  overflow: hidden;
  block-size: 1.125rem;
}

.vo-slot-seg {
  border-inline-end: 1px solid var(--vo-segment-divider);
  block-size: 100%;

  &--p1 {
    background-color: var(--vo-accent);
  }

  &--p2 {
    background-color: var(--vo-warning);
  }

  &--peak {
    background-color: var(--vo-success);
  }

  &--io {
    background-color: color-mix(in oklch, var(--vo-text-muted) 65%, transparent);
  }

  &--scan {
    background-color: var(--vo-accent);
  }
}

.vo-slot-total {
  font-size: var(--vo-text-xs);
  text-align: end;
  font-variant-numeric: tabular-nums;
}

.vo-eta-items-list {
  max-block-size: 16rem;
  overflow-y: auto;
}

.vo-eta-item-row {
  display: grid;
  align-items: center;
  gap: var(--vo-space-3);
  grid-template-columns: minmax(0, 1fr) auto;
}

.vo-eta-item-main {
  display: grid;
  gap: var(--vo-space-1);
  min-inline-size: 0;
}

.vo-eta-item-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
  min-inline-size: 0;
}

.vo-eta-item-name {
  font-size: var(--vo-text-xs);
  min-inline-size: 0;
  overflow-wrap: anywhere;
}

.vo-eta-step-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--vo-space-1);
}

.vo-eta-step-chip {
  font-variant-numeric: tabular-nums;
}

.vo-eta-item-total {
  font-size: var(--vo-text-sm);
  font-weight: var(--vo-weight-semibold);
  text-align: end;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.vo-rates-toggle {
  gap: var(--vo-space-2);
  padding: var(--vo-space-1) var(--vo-space-2);
  font-size: var(--vo-text-xs);
  font-variant-numeric: tabular-nums;
}

.vo-rate-row {
  display: grid;
  align-items: center;
  gap: var(--vo-space-2);
  grid-template-columns: minmax(0, 1fr) auto;
}

.vo-rate-values {
  text-align: end;
  white-space: nowrap;
}

@media (width <= 640px) {
  .vo-rate-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .vo-rate-values {
    text-align: start;
    white-space: normal;
  }
}

.vo-rate-identity {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
  font-size: var(--vo-text-xs);
}
</style>
