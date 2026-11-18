<script setup lang="ts">
import { formatTitleWithYear } from '../../domain/plexFormatter.ts';
import type { MediaKind, MetadataCandidate } from '../../domain/types.ts';
import { extractCandidateLinks } from '../utils/formatters.ts';
import MountBadge from './MountBadge.vue';
import ProviderLinks from './ProviderLinks.vue';

const props = defineProps<{
  readonly results: readonly MetadataCandidate[];
  readonly mediaKind: MediaKind;
  readonly isSelected: (cand: MetadataCandidate) => boolean;
}>();

const emit = defineEmits<{
  select: [candidate: MetadataCandidate];
}>();
</script>

<template>
  <div class="vo-results-list">
    <article
      v-for="(cand, idx) in props.results"
      :key="`${cand.source}-${String(idx)}`"
      class="vo-result-item"
      :class="{ 'vo-result-item--selected': props.isSelected(cand) }"
    >
      <div class="vo-result-item__meta">
        <div class="vo-result-item__title-row">
          <strong>{{ formatTitleWithYear(cand.title, cand.year) }}</strong>
          <ProviderLinks
            v-if="extractCandidateLinks(cand, props.mediaKind).length > 0"
            :links="extractCandidateLinks(cand, props.mediaKind)"
          />
          <span v-else class="vo-mono vo-muted"> · {{ cand.source }}</span>
          <MountBadge v-if="cand.presentInLibrary" :category="cand.presentInLibrary" />
        </div>
        <div class="vo-mono vo-muted">
          <span v-if="cand.imdbId">{{ cand.imdbId }}</span>
          <span v-if="cand.imdbId && cand.tvdbId"> · </span>
          <span v-if="cand.tvdbId">tvdb-{{ cand.tvdbId }}</span>
        </div>
      </div>
      <button
        type="button"
        class="vo-btn"
        :class="{ 'vo-btn--primary': props.isSelected(cand) }"
        :disabled="props.isSelected(cand)"
        @click="emit('select', cand)"
      >
        {{ props.isSelected(cand) ? '✓ Selected' : 'Select' }}
      </button>
    </article>
    <p v-if="props.results.length === 0" class="vo-muted">No metadata candidates yet.</p>
  </div>
</template>

<style scoped lang="scss">
.vo-results-list {
  display: grid;
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background-color: color-mix(in oklch, var(--vo-surface-elevated) 55%, transparent);
  overflow: hidden;
}

.vo-result-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-2);
  padding: var(--vo-space-2) var(--vo-space-3);

  & + & {
    border-block-start: 1px solid var(--vo-border);
  }

  &--selected {
    background-color: color-mix(in oklch, var(--vo-accent) 10%, var(--vo-surface-elevated));
    border-inline-start: var(--vo-space-1) solid var(--vo-accent);
  }
}

.vo-result-item__meta {
  display: grid;
  gap: var(--vo-space-1);
  min-width: 0;
}

.vo-result-item__title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
}

.vo-muted {
  margin: 0;
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
}
</style>
