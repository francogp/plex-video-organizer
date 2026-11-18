<script setup lang="ts">
import { computed, ref } from 'vue';

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

interface PathRail {
  readonly key: 'src' | 'out';
  readonly segments: ReturnType<typeof splitRelativePathSegments>;
}

const editionExpanded = ref(false);
const showEditionInput = computed<boolean>(
  () => editionExpanded.value || Boolean(props.item.edition?.trim())
);
const pathRails = computed<readonly PathRail[]>(() => {
  const srcSegments = splitRelativePathSegments(props.item.relativePath);
  const outSegments = formatPlexOutputSegments(props.item);
  const rails: PathRail[] = [{ key: 'src', segments: srcSegments }];
  if (outSegments) {
    rails.push({ key: 'out', segments: outSegments });
  }
  return rails;
});
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
      <button
        v-if="!showEditionInput"
        type="button"
        class="vo-edition-toggle vo-mono"
        :disabled="props.disabled"
        title="Add optional Plex {edition-...} tag"
        @click="editionExpanded = true"
      >
        + Edition
      </button>
    </div>

    <div v-if="showEditionInput" class="vo-edition-wrap">
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

    <div class="vo-dual-rail vo-mono">
      <div v-for="rail in pathRails" :key="rail.key" class="vo-dual-rail__line">
        <span :class="`vo-path-label vo-rail-tag vo-rail-tag--${rail.key}`">{{
          rail.key.toUpperCase()
        }}</span>
        <div class="vo-path-tree">
          <div
            v-if="rail.segments.folders.length > 0"
            class="vo-path-tree__dirs"
            :title="rail.segments.folders.join(' / ')"
          >
            <span aria-hidden="true">📁</span>
            <template
              v-for="(folder, fIdx) in rail.segments.folders"
              :key="`${rail.key}-f-${String(fIdx)}`"
            >
              <span
                v-if="fIdx > 0"
                :class="`vo-path-sep vo-path-sep--${rail.key}`"
                aria-hidden="true"
                >/</span
              >
              <span class="vo-path-seg vo-path-seg--muted">{{ folder }}</span>
            </template>
          </div>
          <div
            :class="`vo-path-tree__file vo-path-seg--${rail.key}`"
            :title="rail.segments.fileName"
          >
            <span :class="`vo-path-arrow vo-path-arrow--${rail.key}`" aria-hidden="true">↳</span>
            <span>{{ rail.segments.fileName }}</span>
          </div>
        </div>
      </div>

      <div v-if="pathRails.length < 2" class="vo-dual-rail__line">
        <span class="vo-path-label vo-rail-tag vo-rail-tag--err">OUT</span>
        <span class="vo-file-output--unresolved">
          Unresolved — select or search a Match Candidate
        </span>
      </div>
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
  display: grid;
  gap: var(--vo-space-1);
  width: 100%;
  min-width: 0;
  max-width: 100%;
}

.vo-edition-toggle {
  padding: calc(var(--vo-space-1) / 4) var(--vo-space-2);
  border: 1px dashed var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background: transparent;
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  margin-inline-start: auto;
  cursor: pointer;

  &:hover:not(:disabled) {
    color: var(--vo-text);
    border-color: var(--vo-accent);
  }
}

.vo-rail-tag {
  padding: calc(var(--vo-space-1) / 4) var(--vo-space-1);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  flex-shrink: 0;
}

.vo-rail-tag--src {
  color: var(--vo-accent);
  border-color: color-mix(in oklch, var(--vo-accent) 40%, var(--vo-border));
}

.vo-rail-tag--out {
  color: var(--vo-success);
  border-color: color-mix(in oklch, var(--vo-success) 40%, var(--vo-border));
}

.vo-rail-tag--err {
  color: var(--vo-danger);
  border-color: color-mix(in oklch, var(--vo-danger) 40%, var(--vo-border));
}

.vo-path-tree {
  display: grid;
  gap: calc(var(--vo-space-1) / 4);
  min-width: 0;
}

.vo-path-tree__dirs {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: calc(var(--vo-space-1) / 2) var(--vo-space-1);
  min-width: 0;
  color: var(--vo-text-muted);
  line-height: 1.3;
}

.vo-path-tree__file {
  display: flex;
  align-items: baseline;
  gap: var(--vo-space-1);
  min-width: 0;
  line-height: 1.3;
  padding-inline-start: var(--vo-space-1);
  overflow-wrap: anywhere;
}

.vo-path-arrow {
  font-weight: var(--vo-weight-bold);
  flex-shrink: 0;
}

.vo-path-arrow--src,
.vo-path-sep--src {
  color: var(--vo-accent);
}

.vo-path-arrow--out,
.vo-path-sep--out {
  color: var(--vo-success);
}

.vo-path-seg {
  min-width: 0;
  overflow-wrap: anywhere;
}

.vo-path-seg--muted {
  color: var(--vo-text-muted);
}

.vo-path-seg--src {
  color: var(--vo-text);
  font-weight: var(--vo-weight-medium);
}

.vo-path-seg--out {
  color: var(--vo-success);
  font-weight: var(--vo-weight-medium);
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
