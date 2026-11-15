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
  <div class="vo-tracks-overview vo-mono">
    <span class="vo-tracks-overview__item">
      <strong>Audio:</strong> {{ summary.audioSummaryText }}
    </span>
    <span class="vo-tracks-overview__item">
      <strong>Subs:</strong> {{ summary.subsSummaryText }}
    </span>
  </div>
  <div
    v-if="summary.hasConflict || summary.addedCount > 0 || summary.missingSpanishSubs"
    class="vo-audio-panel"
    :class="
      summary.hasConflict
        ? 'vo-audio-panel--bad'
        : summary.missingSpanishSubs
          ? 'vo-audio-panel--warning'
          : 'vo-audio-panel--ok'
    "
    :title="
      summary.hasConflict
        ? summary.conflictText
        : summary.missingSpanishSubs
          ? 'No Spanish (spa) subtitles in external files or embedded streams'
          : `Adding external subtitles: ${summary.addedText}`
    "
  >
    <div class="vo-audio-panel-head">
      <span class="vo-path-label">SUBS</span>
      <span class="vo-path-pill vo-path-pill--folder vo-mono">{{
        summary.hasConflict
          ? 'Conflict'
          : summary.addedCount > 0
            ? `+${String(summary.addedCount)} new`
            : 'No spa'
      }}</span>
    </div>
    <div class="vo-audio-lines vo-mono">
      <div v-if="summary.hasConflict" class="vo-audio-option vo-audio-option--bad">
        <span class="vo-audio-option-icon" aria-hidden="true">✗</span>
        <span class="vo-audio-option-label">Conflict:</span>
        <span>{{ summary.conflictText }}</span>
      </div>
      <template v-else-if="summary.addedCount > 0">
        <div class="vo-audio-option vo-audio-option--good">
          <span class="vo-audio-option-icon" aria-hidden="true">+</span>
          <span class="vo-audio-option-label">Add:</span>
          <span>{{ summary.addedText }}</span>
        </div>
        <div v-if="summary.keptCount > 0" class="vo-audio-option vo-audio-option--neutral">
          <span class="vo-audio-option-icon" aria-hidden="true">✓</span>
          <span class="vo-audio-option-label">Keep:</span>
          <span>{{ summary.keptText }}</span>
        </div>
        <div v-else-if="summary.isReplace" class="vo-audio-option vo-audio-option--neutral">
          <span class="vo-audio-option-icon" aria-hidden="true">↺</span>
          <span class="vo-audio-option-label">Mode:</span>
          <span>Replace existing</span>
        </div>
      </template>
      <div v-if="summary.missingSpanishSubs" class="vo-audio-option vo-audio-option--warning">
        <span class="vo-audio-option-icon" aria-hidden="true">⚠</span>
        <span class="vo-audio-option-label">No spa:</span>
        <span>No Spanish subtitles (file or embedded)</span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.vo-tracks-overview {
  display: flex;
  flex-wrap: wrap;
  gap: var(--vo-space-1) var(--vo-space-3);
  padding: var(--vo-space-1) var(--vo-space-2);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background: var(--vo-surface-elevated);
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);

  strong {
    color: var(--vo-text);
  }
}
</style>
