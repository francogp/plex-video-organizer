<script setup lang="ts">
import { computed } from 'vue';

import { formatTitleWithYear } from '../../domain/plexFormatter.ts';
import type { ScannedItem } from '../../domain/types.ts';
import {
  extractCandidateLinks,
  formatMetadataIds,
  type ExternalIdLink
} from '../utils/formatters.ts';
import ProviderLinks from './ProviderLinks.vue';

const props = defineProps<{
  item: ScannedItem;
  disabled: boolean;
}>();

const emit = defineEmits<{
  'change-candidate': [candidateIndex: number];
  'search-metadata': [];
}>();

function formatCandidateLabel(cand: ScannedItem['candidates'][number]): string {
  const titleWithYear = formatTitleWithYear(cand.title, cand.year);
  const idPart = cand.imdbId ? ` {${cand.imdbId}}` : cand.tvdbId ? ` {tvdb-${cand.tvdbId}}` : '';
  return `${titleWithYear}${idPart}`;
}

function getMetadataLinks(row: ScannedItem): readonly ExternalIdLink[] {
  if (!row.selectedMetadata) {
    return [];
  }
  return extractCandidateLinks(row.selectedMetadata, row.mediaKind);
}

const selectedCandidateIndex = computed((): number => {
  const selected = props.item.selectedMetadata;
  if (!selected) {
    return -1;
  }
  return props.item.candidates.findIndex(
    (cand) =>
      cand.source === selected.source &&
      cand.title === selected.title &&
      cand.year === selected.year &&
      cand.imdbId === selected.imdbId &&
      cand.tvdbId === selected.tvdbId &&
      cand.tmdbId === selected.tmdbId
  );
});
</script>

<template>
  <div class="vo-audio-cell">
    <div
      class="vo-audio-panel"
      :class="props.item.selectedMetadata ? 'vo-audio-panel--ok' : 'vo-audio-panel--bad'"
      :title="
        props.item.selectedMetadata
          ? formatCandidateLabel(props.item.selectedMetadata)
          : 'No metadata match selected — use Search to match this item'
      "
    >
      <div class="vo-audio-panel-head">
        <span class="vo-path-label">MATCH</span>
        <ProviderLinks
          v-if="getMetadataLinks(props.item).length > 0"
          :links="getMetadataLinks(props.item)"
        />
        <span v-else class="vo-path-pill vo-path-pill--folder vo-mono">{{
          props.item.selectedMetadata
            ? props.item.selectedMetadata.source.toUpperCase()
            : 'Unmatched'
        }}</span>
      </div>
      <div class="vo-audio-lines vo-mono">
        <template v-if="props.item.selectedMetadata">
          <div class="vo-audio-option vo-audio-option--good">
            <span class="vo-audio-option-icon" aria-hidden="true">✓</span>
            <span class="vo-audio-option-label">{{
              formatTitleWithYear(
                props.item.selectedMetadata.title,
                props.item.selectedMetadata.year
              )
            }}</span>
          </div>
          <div
            v-if="formatMetadataIds(props.item.selectedMetadata)"
            class="vo-audio-option vo-audio-option--neutral"
          >
            <span class="vo-audio-option-icon" aria-hidden="true">#</span>
            <span class="vo-audio-option-label">ID:</span>
            <span>{{ formatMetadataIds(props.item.selectedMetadata) }}</span>
          </div>
        </template>
        <div v-else class="vo-audio-option vo-audio-option--bad">
          <span class="vo-audio-option-icon" aria-hidden="true">✗</span>
          <span class="vo-audio-option-label">No match:</span>
          <span>Click Search to match</span>
        </div>
      </div>
    </div>
    <div class="vo-meta-controls">
      <label :for="`meta-${props.item.id}`" class="vo-sr-only"
        >Match for {{ props.item.fileName }}</label
      >
      <select
        :id="`meta-${props.item.id}`"
        class="vo-select vo-select--candidate"
        :value="selectedCandidateIndex"
        :title="
          props.item.selectedMetadata
            ? formatCandidateLabel(props.item.selectedMetadata)
            : undefined
        "
        :disabled="props.disabled || props.item.candidates.length === 0"
        @change="emit('change-candidate', Number(($event.target as HTMLSelectElement).value))"
      >
        <option v-if="props.item.candidates.length === 0" value="-1">No match found</option>
        <option
          v-for="(cand, idx) in props.item.candidates"
          :key="`${cand.source}-${String(idx)}`"
          :value="idx"
          :selected="idx === selectedCandidateIndex"
        >
          {{ formatCandidateLabel(cand) }}
        </option>
      </select>
      <button
        type="button"
        class="vo-btn vo-meta-search-btn"
        :disabled="props.disabled"
        @click="emit('search-metadata')"
      >
        <span aria-hidden="true">🔍</span> Search
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.vo-meta-controls {
  display: grid;
  gap: var(--vo-space-2);
  width: 100%;
  min-width: 0;
}

.vo-select--candidate {
  width: 100%;
  min-width: 0;
  max-width: 100%;
}

.vo-meta-search-btn {
  width: 100%;
}
</style>
