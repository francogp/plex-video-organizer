<script setup lang="ts">
import type { ConflictComparison, ConflictDecision, ScannedItem } from '../../domain/types.ts';
import { formatPlexOutputSegments, splitRelativePathSegments } from '../utils/formatters.ts';
import QueueConflictAlert from './QueueConflictAlert.vue';

const props = defineProps<{
  item: ScannedItem;
  disabled: boolean;
  conflict?: ConflictComparison;
  decision?: ConflictDecision;
}>();

const emit = defineEmits<{
  'change-edition': [edition: string];
  'open-conflict-modal': [];
}>();
</script>

<template>
  <div class="vo-file-cell">
    <div class="vo-file-header">
      <span class="vo-file-title">{{ props.item.parsedTitle }}</span>
      <span v-if="props.item.parsedYear" class="vo-badge vo-mono">
        {{ props.item.parsedYear }}
      </span>
      <span v-if="props.item.episode" class="vo-badge vo-mono">
        s{{ String(props.item.episode.seasonNumber).padStart(2, '0') }}e{{
          String(props.item.episode.episodeStart).padStart(2, '0')
        }}
      </span>
      <span v-if="props.item.extraType" class="vo-badge vo-badge--warn">
        Extra: {{ props.item.extraType }}
      </span>
      <span v-for="tag in props.item.tags" :key="tag" class="vo-badge vo-mono">
        {{ tag }}
      </span>
    </div>
    <div class="vo-path-panels vo-mono">
      <div class="vo-path-panel vo-path-panel--source">
        <span class="vo-path-label">Source</span>
        <div class="vo-path-chain">
          <template
            v-for="(folder, fIdx) in splitRelativePathSegments(props.item.relativePath).folders"
            :key="`sf-${String(fIdx)}`"
          >
            <span class="vo-path-pill vo-path-pill--folder" title="Source Folder">
              {{ folder }}
            </span>
            <span class="vo-path-sep" aria-hidden="true">›</span>
          </template>
          <span class="vo-path-pill vo-path-pill--file" title="Source File">
            {{ splitRelativePathSegments(props.item.relativePath).fileName }}
          </span>
        </div>
      </div>

      <div v-if="formatPlexOutputSegments(props.item)" class="vo-path-panel vo-path-panel--output">
        <span class="vo-path-label vo-path-label--output">Output</span>
        <div class="vo-path-chain">
          <template
            v-for="(folder, oIdx) in formatPlexOutputSegments(props.item)!.folders"
            :key="`of-${String(oIdx)}`"
          >
            <span class="vo-path-pill vo-path-pill--out-folder" title="Destination Folder">
              {{ folder }}
            </span>
            <span class="vo-path-sep" aria-hidden="true">›</span>
          </template>
          <span class="vo-path-pill vo-path-pill--out-file" title="Destination File">
            {{ formatPlexOutputSegments(props.item)!.fileName }}
          </span>
        </div>
      </div>

      <div v-else class="vo-path-panel vo-path-panel--unresolved">
        <span class="vo-path-label vo-path-label--unresolved">Output</span>
        <span class="vo-file-output--unresolved">
          Unresolved — select or search a Match Candidate
        </span>
      </div>
    </div>
    <div class="vo-edition-wrap">
      <label :for="`ed-${props.item.id}`" class="vo-sr-only"
        >Edition for {{ props.item.fileName }}</label
      >
      <input
        :id="`ed-${props.item.id}`"
        type="text"
        class="vo-edition-input"
        :value="props.item.edition ?? ''"
        :disabled="props.disabled"
        placeholder="Edition (optional)"
        title="Optional Plex edition tag (e.g. Director's Cut, Extended, IMAX, Unrated). Adds {edition-...} so Plex keeps multiple editions distinct."
        @change="emit('change-edition', ($event.target as HTMLInputElement).value.trim())"
      />
      <span
        class="vo-help-tip vo-mono"
        title="Plex Edition guide: Leave empty for standard releases. Enter a short tag like 'Director's Cut', 'Extended', 'IMAX', or 'Unrated' to append {edition-...} to the Plex folder/filename."
        >?</span
      >
    </div>
    <QueueConflictAlert
      :conflict="props.conflict"
      :decision="props.decision"
      :disabled="props.disabled"
      @open="emit('open-conflict-modal')"
    />
    <div v-if="props.item.warnings.length > 0" class="vo-badge vo-badge--warn">
      {{ props.item.warnings[0] }}
    </div>
  </div>
</template>

<style scoped lang="scss">
.vo-file-cell {
  width: 100%;
  min-width: 0;
  max-width: 100%;
}

.vo-file-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
}

.vo-file-title {
  font-weight: var(--vo-weight-semibold);
}

.vo-path-panels {
  display: grid;
  gap: var(--vo-space-2);
  font-size: var(--vo-text-xs);
  margin-top: var(--vo-space-2);
}

.vo-path-panel {
  display: grid;
  gap: var(--vo-space-1);
  padding: var(--vo-space-2);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-md);
}

.vo-path-panel--source {
  background-color: var(--vo-surface-elevated);
}

.vo-path-panel--output {
  background-color: color-mix(in oklch, var(--vo-success) 7%, var(--vo-surface));
  border-color: color-mix(in oklch, var(--vo-success) 38%, var(--vo-border));
}

.vo-path-panel--unresolved {
  background-color: color-mix(in oklch, var(--vo-danger) 7%, var(--vo-surface));
  border-color: color-mix(in oklch, var(--vo-danger) 38%, var(--vo-border));
}

.vo-path-chain {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-1);
}

.vo-path-label--output {
  color: var(--vo-success);
}

.vo-path-label--unresolved {
  color: var(--vo-danger);
}

.vo-path-sep {
  color: var(--vo-text-muted);
  opacity: 0.7;
}

.vo-file-output--unresolved {
  color: var(--vo-danger);
}

.vo-edition-wrap {
  display: flex;
  align-items: center;
  gap: var(--vo-space-2);
  width: 100%;
  margin-block-start: var(--vo-space-2);
}

.vo-edition-input {
  min-width: 0;
  max-width: none;
  padding: var(--vo-space-1) var(--vo-space-2);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background-color: var(--vo-surface-elevated);
  color: var(--vo-text);
  font-size: var(--vo-text-xs);
  flex: 1;
}

.vo-help-tip {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  width: 1.25rem;
  height: 1.25rem;
  border: 1px solid var(--vo-border);
  border-radius: 50%;
  background-color: var(--vo-surface-elevated);
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  flex-shrink: 0;
  cursor: help;
}
</style>
