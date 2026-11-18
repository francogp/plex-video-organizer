<script setup lang="ts">
import { computed } from 'vue';

import { OUTPUT_CATEGORY_LABELS } from '../../domain/constants.ts';
import { formatTitleWithYear } from '../../domain/plexFormatter.ts';
import type { ScannedItem } from '../../domain/types.ts';
import {
  extractCandidateLinks,
  formatMetadataIds,
  type ExternalIdLink
} from '../utils/formatters.ts';
import MountBadge from './MountBadge.vue';
import ProviderLinks from './ProviderLinks.vue';
import UiIcon from './UiIcon.vue';

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
  const mountPrefix = cand.presentInLibrary ? '💾 ' : '';
  return `${mountPrefix}${titleWithYear}${idPart}`;
}

function formatCandidateTooltip(cand: ScannedItem['candidates'][number]): string {
  const label = formatCandidateLabel(cand);
  return cand.presentInLibrary
    ? `Already present in ${OUTPUT_CATEGORY_LABELS[cand.presentInLibrary]} mount on disk — ${label}`
    : label;
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
  <div class="vo-dual-rail">
    <div
      class="vo-dual-rail__top"
      :title="
        props.item.selectedMetadata
          ? formatCandidateLabel(props.item.selectedMetadata)
          : 'No metadata match selected — use Search to match this item'
      "
    >
      <div class="vo-audio-panel-head">
        <span
          v-if="props.item.selectedMetadata"
          class="vo-audio-option vo-audio-option--good vo-mono"
        >
          <span aria-hidden="true">✓</span>
          <span>{{
            formatTitleWithYear(props.item.selectedMetadata.title, props.item.selectedMetadata.year)
          }}</span>
        </span>
        <span v-else class="vo-audio-option vo-audio-option--bad vo-mono">
          <span aria-hidden="true">✗</span>
          <span>Unmatched</span>
        </span>
        <div class="vo-meta-badges">
          <ProviderLinks
            v-if="getMetadataLinks(props.item).length > 0"
            :links="getMetadataLinks(props.item)"
          />
          <MountBadge
            v-if="props.item.selectedMetadata?.presentInLibrary"
            :category="props.item.selectedMetadata.presentInLibrary"
          />
        </div>
      </div>
      <div
        v-if="props.item.selectedMetadata && formatMetadataIds(props.item.selectedMetadata)"
        class="vo-meta-id vo-mono"
      >
        {{ formatMetadataIds(props.item.selectedMetadata) }}
      </div>
    </div>
    <div class="vo-dual-rail__bottom">
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
          :title="formatCandidateTooltip(cand)"
        >
          {{ formatCandidateLabel(cand) }}
        </option>
      </select>
      <button
        type="button"
        class="vo-btn vo-meta-search-btn"
        :disabled="props.disabled"
        title="Search metadata"
        aria-label="Search metadata"
        @click="emit('search-metadata')"
      >
        <UiIcon name="search" />
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.vo-meta-badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-1);
}

.vo-meta-id {
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  overflow-wrap: anywhere;
}

.vo-select--candidate {
  min-width: 0;
  max-width: 100%;
  flex: 1;
}

.vo-meta-search-btn {
  flex-shrink: 0;
}
</style>
