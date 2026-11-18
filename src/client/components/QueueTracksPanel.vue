<script setup lang="ts">
export interface TracksSummary {
  readonly audioSummaryText: string;
  readonly subsSummaryText: string;
  readonly addedCount: number;
  readonly addedText: string;
  readonly keptCount: number;
  readonly keptText: string;
  readonly isReplace: boolean;
  readonly hasConflict: boolean;
  readonly conflictText: string;
  readonly missingSpanishSubs: boolean;
}

defineProps<{
  readonly summary: TracksSummary;
}>();
</script>

<template>
  <div class="vo-tracks-compact vo-mono">
    <div class="vo-tracks-overview">
      <div class="vo-tracks-row">
        <span class="vo-tracks-key">Audio</span>
        <span class="vo-tracks-val" :title="summary.audioSummaryText">{{
          summary.audioSummaryText
        }}</span>
      </div>
      <div class="vo-tracks-row">
        <span class="vo-tracks-key">Subs</span>
        <span class="vo-tracks-val" :title="summary.subsSummaryText">{{
          summary.subsSummaryText
        }}</span>
        <span
          v-if="!summary.hasConflict && summary.addedCount > 0"
          class="vo-tracks-badge vo-tracks-badge--ok"
        >
          +{{ String(summary.addedCount) }} new
        </span>
      </div>
    </div>
    <div
      v-if="summary.hasConflict || summary.addedCount > 0 || summary.missingSpanishSubs"
      class="vo-tracks-inline-status"
      :title="
        summary.hasConflict
          ? summary.conflictText
          : summary.missingSpanishSubs
            ? 'No Spanish (spa) subtitles in external files or embedded streams'
            : `Adding external subtitles: ${summary.addedText}`
      "
    >
      <span v-if="summary.hasConflict" class="vo-audio-option vo-audio-option--bad">
        <span aria-hidden="true">✗</span>
        <span>{{ summary.conflictText }}</span>
      </span>
      <template v-else-if="summary.addedCount > 0">
        <span class="vo-audio-option vo-audio-option--good">
          <span aria-hidden="true">+</span>
          <span>Add: {{ summary.addedText }}</span>
        </span>
        <span v-if="summary.keptCount > 0" class="vo-audio-option vo-audio-option--neutral">
          <span aria-hidden="true">✓</span>
          <span>Keep: {{ summary.keptText }}</span>
        </span>
        <span v-else-if="summary.isReplace" class="vo-audio-option vo-audio-option--neutral">
          <span aria-hidden="true">↺</span>
          <span>Replace</span>
        </span>
      </template>
      <span v-if="summary.missingSpanishSubs" class="vo-audio-option vo-audio-option--warning">
        <span aria-hidden="true">⚠</span>
        <span>No spa</span>
      </span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.vo-tracks-compact {
  display: grid;
  gap: var(--vo-space-1);
  min-width: 0;
  font-size: var(--vo-text-xs);
}

.vo-tracks-overview {
  display: grid;
  gap: calc(var(--vo-space-1) / 2);
  min-width: 0;
}

.vo-tracks-row {
  display: flex;
  align-items: center;
  gap: var(--vo-space-2);
  min-width: 0;
}

.vo-tracks-key {
  min-width: 2.75rem;
  color: var(--vo-text-muted);
  font-size: var(--vo-text-2xs);
  font-weight: var(--vo-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.vo-tracks-val {
  min-width: 0;
  color: var(--vo-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vo-tracks-badge {
  padding: calc(var(--vo-space-1) / 4) var(--vo-space-1);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  flex-shrink: 0;
  margin-inline-start: auto;
  white-space: nowrap;
}

.vo-tracks-badge--bad {
  background-color: color-mix(in oklch, var(--vo-danger) 12%, transparent);
  color: var(--vo-danger);
  border-color: color-mix(in oklch, var(--vo-danger) 48%, var(--vo-border));
}

.vo-tracks-badge--ok {
  background-color: color-mix(in oklch, var(--vo-accent) 10%, transparent);
  color: var(--vo-accent);
  border-color: color-mix(in oklch, var(--vo-accent) 45%, var(--vo-border));
}

.vo-tracks-badge--warn {
  background-color: color-mix(in oklch, var(--vo-warning) 10%, transparent);
  color: var(--vo-warning);
  border-color: color-mix(in oklch, var(--vo-warning) 48%, var(--vo-border));
}

.vo-tracks-inline-status {
  display: flex;
  flex-wrap: wrap;
  gap: var(--vo-space-1) var(--vo-space-2);
}
</style>
