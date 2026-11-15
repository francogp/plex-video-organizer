<script setup lang="ts" generic="TId extends ItemId | VerifierEntryId = ItemId">
import { computed, ref, watch } from 'vue';

import type {
  ConflictComparison,
  ConflictDecision,
  ConflictModalMode,
  DiskSpaceCheck,
  ItemId,
  VerifierEntryId
} from '../../domain/types.ts';
import { useModalVars } from '../composables/useGsapMotion.ts';
import { formatBytesHuman, formatProbeSpecRows, formatSizeDeltaMb } from '../utils/formatters.ts';

const props = withDefaults(
  defineProps<{
    readonly open: boolean;
    readonly conflicts: readonly ConflictComparison<TId>[];
    readonly title?: string;
    readonly diskSpace?: readonly DiskSpaceCheck[];
    readonly initialResolutions?: Readonly<Partial<Record<TId, ConflictDecision>>>;
    readonly mode?: ConflictModalMode;
  }>(),
  {
    title: 'Pre-Flight Conflicts',
    mode: 'confirm'
  }
);

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'save', resolutions: Partial<Record<TId, ConflictDecision>>): void;
  (e: 'confirm', resolutions: Partial<Record<TId, ConflictDecision>>): void;
}>();

const decisions = ref<Partial<Record<TId, ConflictDecision>>>({}) as {
  value: Partial<Record<TId, ConflictDecision>>;
};
const modalVars = useModalVars(1);

watch(
  [() => props.conflicts, () => props.open],
  (): void => {
    const next: Partial<Record<TId, ConflictDecision>> = {};
    const initial = (props.initialResolutions ?? {}) as Readonly<
      Partial<Record<TId, ConflictDecision>>
    >;
    for (const conflict of props.conflicts) {
      const saved = initial[conflict.itemId];
      if (saved === 'overwrite' || saved === 'ignore') {
        next[conflict.itemId] = saved;
      }
    }
    decisions.value = next;
  },
  { immediate: true }
);

function setDecision(itemId: TId, decision: ConflictDecision): void {
  decisions.value = {
    ...decisions.value,
    [itemId]: decision
  };
}

function applyToAll(decision: ConflictDecision): void {
  const next: Partial<Record<TId, ConflictDecision>> = {};
  for (const conflict of props.conflicts) {
    next[conflict.itemId] = decision;
  }
  decisions.value = next;
}

const resolvedCount = computed(
  (): number =>
    props.conflicts.filter(
      (c): boolean =>
        decisions.value[c.itemId] === 'overwrite' || decisions.value[c.itemId] === 'ignore'
    ).length
);

interface ComparisonSideView {
  readonly key: 'incoming' | 'existing';
  readonly title: string;
  readonly cardClass: string;
  readonly badgeText?: string;
  readonly badgeClass?: string;
  readonly subtitle?: string;
  readonly rows: ReturnType<typeof formatProbeSpecRows>;
}

function getComparisonSides(conflict: ConflictComparison<TId>): readonly ComparisonSideView[] {
  const incomingSide: ComparisonSideView = {
    key: 'incoming',
    title: 'Incoming',
    cardClass: 'vo-spec-card--incoming',
    ...(conflict.existing
      ? {
          badgeText: formatSizeDeltaMb(conflict.incoming.sizeBytes, conflict.existing.sizeBytes),
          badgeClass:
            conflict.incoming.sizeBytes >= conflict.existing.sizeBytes
              ? 'vo-delta-pill vo-mono vo-delta-pill--up'
              : 'vo-delta-pill vo-mono vo-delta-pill--down'
        }
      : {}),
    rows: formatProbeSpecRows(conflict.incoming)
  };
  if (!conflict.existing) {
    return [incomingSide];
  }
  return [
    incomingSide,
    {
      key: 'existing',
      title: 'Existing',
      cardClass: 'vo-spec-card--existing',
      subtitle: 'At destination',
      rows: formatProbeSpecRows(conflict.existing)
    }
  ];
}

const FULL_PERCENT = 100;
const MIN_VISIBLE_BAR_PERCENT = 1;
const PERCENT_TENTH_SCALE = 1000;
const PERCENT_TENTH_DIVISOR = 10;

function getDiskUsagePercent(disk: DiskSpaceCheck): number {
  if (disk.availableBytes <= 0) {
    return FULL_PERCENT;
  }
  if (disk.requiredBytes <= 0) {
    return 0;
  }
  const raw =
    Math.round((disk.requiredBytes / disk.availableBytes) * PERCENT_TENTH_SCALE) /
    PERCENT_TENTH_DIVISOR;
  return Math.min(FULL_PERCENT, Math.max(MIN_VISIBLE_BAR_PERCENT, raw));
}

const diskSpaceRows = computed(() =>
  (props.diskSpace ?? []).map((disk) => ({
    disk,
    usagePercent: getDiskUsagePercent(disk)
  }))
);

const allResolved = computed((): boolean => resolvedCount.value === props.conflicts.length);
</script>

<template>
  <div v-if="open" class="vo-modal-backdrop" :style="modalVars" role="dialog" aria-modal="true">
    <div class="vo-modal-card vo-conflict-modal">
      <header class="vo-modal-header">
        <div class="vo-modal-title-group">
          <h2>
            {{ title }}
            <span class="vo-badge vo-badge--warn vo-badge--compact">{{ conflicts.length }}</span>
          </h2>
          <span class="vo-conflict-progress vo-mono">
            {{ resolvedCount }}/{{ conflicts.length }} resolved
          </span>
        </div>
        <button type="button" class="vo-btn" @click="emit('close')">
          <span aria-hidden="true">✖️</span> Cancel
        </button>
      </header>

      <div v-if="diskSpaceRows.length > 0" class="vo-disk-list">
        <div
          v-for="{ disk, usagePercent } in diskSpaceRows"
          :key="disk.category"
          class="vo-disk-item"
          :class="{ 'vo-disk-item--low': !disk.sufficient }"
        >
          <div class="vo-disk-item__head vo-mono">
            <span class="vo-disk-item__category">{{ disk.category }}</span>
            <span class="vo-disk-item__metrics">
              {{ formatBytesHuman(disk.requiredBytes) }} required /
              {{ formatBytesHuman(disk.availableBytes) }} free ({{ usagePercent }}%)
            </span>
          </div>
          <div
            class="vo-disk-bar"
            role="progressbar"
            :aria-valuenow="usagePercent"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div
              class="vo-disk-bar__fill"
              :class="{ 'vo-disk-bar__fill--low': !disk.sufficient }"
              :style="{ width: `${usagePercent}%` }"
            />
          </div>
        </div>
      </div>

      <div v-if="conflicts.length > 1" class="vo-conflict-bulk-actions">
        <span class="vo-bulk-label">Apply to all:</span>
        <button type="button" class="vo-btn" @click="applyToAll('overwrite')">
          <span aria-hidden="true">✅</span> Overwrite All
        </button>
        <button type="button" class="vo-btn" @click="applyToAll('ignore')">
          <span aria-hidden="true">⏭️</span> Ignore All
        </button>
      </div>

      <div class="vo-conflict-list">
        <article v-for="conflict in conflicts" :key="conflict.itemId" class="vo-conflict-item">
          <div class="vo-path-panel">
            <div v-if="conflict.sourceFileName" class="vo-path-row">
              <span class="vo-path-tag vo-path-tag--incoming">Source</span>
              <span class="vo-path-value vo-mono">{{ conflict.sourceFileName }}</span>
            </div>
            <div class="vo-path-row">
              <span class="vo-path-tag vo-path-tag--target">Target</span>
              <span class="vo-path-value vo-mono">{{ conflict.destinationPath }}</span>
            </div>
            <div
              v-if="conflict.existingPath && conflict.existingPath !== conflict.destinationPath"
              class="vo-path-row"
            >
              <span class="vo-path-tag vo-path-tag--warn">Existing</span>
              <span class="vo-path-value vo-mono">{{ conflict.existingPath }}</span>
            </div>
          </div>

          <div class="vo-compare-grid">
            <section
              v-for="side in getComparisonSides(conflict)"
              :key="side.key"
              class="vo-spec-card"
              :class="side.cardClass"
            >
              <header class="vo-spec-card-header">
                <span class="vo-spec-title">{{ side.title }}</span>
                <span v-if="side.badgeText" :class="side.badgeClass">{{ side.badgeText }}</span>
                <span v-else-if="side.subtitle" class="vo-existing-tag">{{ side.subtitle }}</span>
              </header>
              <dl class="vo-spec-dl">
                <div v-for="row in side.rows" :key="row.label" class="vo-spec-row">
                  <dt class="vo-spec-dt">{{ row.label }}</dt>
                  <dd class="vo-spec-dd" :class="{ 'vo-mono': row.mono }">{{ row.value }}</dd>
                </div>
              </dl>
            </section>

            <section v-if="!conflict.existing" class="vo-spec-card vo-spec-card--existing">
              <header class="vo-spec-card-header">
                <span class="vo-spec-title">Intra-batch collision</span>
              </header>
              <p class="vo-batch-note">Multiple queue items map to the same destination.</p>
            </section>
          </div>

          <div class="vo-decision-bar">
            <span class="vo-decision-label">Resolution</span>
            <div class="vo-decision-group" role="group" aria-label="Conflict resolution decision">
              <button
                type="button"
                class="vo-decision-btn vo-decision-btn--overwrite"
                :class="{ 'is-active': decisions[conflict.itemId] === 'overwrite' }"
                :aria-pressed="decisions[conflict.itemId] === 'overwrite'"
                data-decision="overwrite"
                @click="setDecision(conflict.itemId, 'overwrite')"
              >
                Overwrite destination
              </button>
              <button
                type="button"
                class="vo-decision-btn vo-decision-btn--ignore"
                :class="{ 'is-active': decisions[conflict.itemId] === 'ignore' }"
                :aria-pressed="decisions[conflict.itemId] === 'ignore'"
                data-decision="ignore"
                @click="setDecision(conflict.itemId, 'ignore')"
              >
                Ignore (keep existing)
              </button>
            </div>
          </div>
        </article>
      </div>

      <footer class="vo-modal-footer">
        <button type="button" class="vo-btn" @click="emit('close')">
          <span aria-hidden="true">⬅️</span> Back
        </button>
        <div class="vo-modal-footer-actions">
          <button
            v-if="mode !== 'confirm'"
            type="button"
            class="vo-btn"
            :class="{ 'vo-btn--primary': mode === 'save-only' }"
            :disabled="!allResolved"
            @click="emit('save', decisions)"
          >
            <span aria-hidden="true">💾</span>
            {{ conflicts.length === 1 ? 'Save Decision' : 'Save Decisions' }}
          </button>
          <button
            v-if="mode !== 'save-only'"
            type="button"
            class="vo-btn vo-btn--primary"
            :disabled="!allResolved"
            @click="emit('confirm', decisions)"
          >
            <span aria-hidden="true">⚡</span>
            {{ mode === 'save-and-confirm' ? 'Confirm & Apply' : 'Confirm & Process' }}
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped lang="scss">
.vo-conflict-modal {
  display: flex;
  flex-direction: column;
  max-height: 88dvh;
}

.vo-modal-title-group {
  display: flex;
  align-items: center;
  gap: var(--vo-space-3);
}

.vo-conflict-progress {
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  font-variant-numeric: tabular-nums;
}

.vo-conflict-bulk-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
  font-size: var(--vo-text-xs);
  margin-top: var(--vo-space-3);
}

.vo-disk-list {
  display: grid;
  gap: var(--vo-space-2);
  margin-block-start: var(--vo-space-3);
}

.vo-disk-item {
  display: grid;
  gap: var(--vo-space-1);
  padding: var(--vo-space-2) var(--vo-space-3);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background: var(--vo-surface-elevated);
}

.vo-disk-item--low {
  background: color-mix(in oklch, var(--vo-danger) 8%, var(--vo-surface-elevated));
  border-color: var(--vo-danger);
}

.vo-disk-item__head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-2);
  font-size: var(--vo-text-xs);
}

.vo-disk-item__category {
  font-weight: var(--vo-weight-semibold);
}

.vo-disk-item__metrics {
  color: var(--vo-text-muted);
}

.vo-disk-bar {
  width: 100%;
  height: var(--vo-space-2);
  border-radius: var(--vo-radius-sm);
  background: color-mix(in oklch, var(--vo-border) 60%, transparent);
  overflow: hidden;
}

.vo-disk-bar__fill {
  height: 100%;
  border-radius: var(--vo-radius-sm);
  background: var(--vo-success);
}

.vo-disk-bar__fill--low {
  background: var(--vo-danger);
}

.vo-bulk-label {
  color: var(--vo-text-muted);
  font-weight: var(--vo-weight-semibold);
}

.vo-conflict-list {
  display: grid;
  gap: var(--vo-space-3);
  margin: var(--vo-space-4) 0;
  overflow-y: auto;
  padding-right: var(--vo-space-1);
}

.vo-conflict-item {
  display: grid;
  gap: var(--vo-space-3);
  padding: var(--vo-space-3);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-md);
  background-color: var(--vo-surface-elevated);
}

.vo-path-panel {
  display: grid;
  gap: var(--vo-space-2);
  padding: var(--vo-space-2) var(--vo-space-3);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background-color: var(--vo-surface);
}

.vo-path-row {
  display: grid;
  align-items: baseline;
  gap: var(--vo-space-2);
  grid-template-columns: auto minmax(0, 1fr);
}

.vo-path-tag {
  padding: var(--vo-space-1) var(--vo-space-2);
  border-radius: var(--vo-radius-sm);
  font-size: var(--vo-text-xs);
  font-weight: var(--vo-weight-semibold);
  text-align: center;
}

.vo-path-tag--incoming {
  background-color: color-mix(in oklch, var(--vo-accent) 16%, transparent);
  color: var(--vo-accent);
}

.vo-path-tag--target {
  background-color: color-mix(in oklch, var(--vo-warning) 16%, transparent);
  color: var(--vo-warning);
}

.vo-path-tag--warn {
  background-color: color-mix(in oklch, var(--vo-danger) 16%, transparent);
  color: var(--vo-danger);
}

.vo-path-value {
  color: var(--vo-text);
  font-size: var(--vo-text-xs);
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.vo-compare-grid {
  display: grid;
  gap: var(--vo-space-3);
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
}

.vo-spec-card {
  display: grid;
  align-content: start;
  gap: var(--vo-space-2);
  padding: var(--vo-space-3);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background-color: var(--vo-surface);
}

.vo-spec-card--incoming {
  border-top: 2px solid var(--vo-accent);
}

.vo-spec-card--existing {
  border-top: 2px solid var(--vo-warning);
}

.vo-spec-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-2);
}

.vo-spec-title {
  color: var(--vo-text);
  font-size: var(--vo-text-sm);
  font-weight: var(--vo-weight-semibold);
}

.vo-delta-pill {
  padding: var(--vo-space-1) var(--vo-space-2);
  border-radius: var(--vo-radius-pill);
  font-size: var(--vo-text-xs);
  font-variant-numeric: tabular-nums;
}

.vo-delta-pill--up {
  background-color: color-mix(in oklch, var(--vo-success) 16%, transparent);
  color: var(--vo-success);
}

.vo-delta-pill--down {
  background-color: color-mix(in oklch, var(--vo-warning) 16%, transparent);
  color: var(--vo-warning);
}

.vo-existing-tag {
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
}

.vo-spec-dl {
  display: grid;
  margin: 0;
}

.vo-spec-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--vo-space-3);
  padding: var(--vo-space-1) 0;
  border-top: 1px solid color-mix(in oklch, var(--vo-border) 55%, transparent);
}

.vo-spec-dt {
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  white-space: nowrap;
}

.vo-spec-dd {
  margin: 0;
  color: var(--vo-text);
  font-size: var(--vo-text-xs);
  text-align: right;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.vo-batch-note {
  margin: 0;
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
}

.vo-decision-bar {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-2);
  padding-top: var(--vo-space-2);
  border-top: 1px solid var(--vo-border);
}

.vo-decision-label {
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  font-weight: var(--vo-weight-semibold);
}

.vo-decision-group {
  display: flex;
  flex-wrap: wrap;
  gap: var(--vo-space-2);
}

.vo-decision-btn {
  padding: var(--vo-space-1) var(--vo-space-3);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background-color: var(--vo-surface);
  color: var(--vo-text);
  font-size: var(--vo-text-xs);
  font-weight: var(--vo-weight-semibold);
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
  cursor: pointer;

  &:hover {
    border-color: var(--vo-border-highlight);
  }
}

.vo-decision-btn--overwrite.is-active {
  background-color: color-mix(in oklch, var(--vo-warning) 18%, var(--vo-surface));
  color: var(--vo-warning);
  border-color: var(--vo-warning);
}

.vo-decision-btn--ignore.is-active {
  background-color: color-mix(in oklch, var(--vo-accent) 18%, var(--vo-surface));
  color: var(--vo-accent);
  border-color: var(--vo-accent);
}

.vo-modal-footer-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--vo-space-2);
}
</style>
