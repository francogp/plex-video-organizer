<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

import { formatTitleWithYear } from '../../domain/plexFormatter.ts';
import type { MediaKind, MetadataCandidate } from '../../domain/types.ts';
import { animateStaggerList } from '../composables/useGsapMotion.ts';
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

const listRef = ref<HTMLElement | null>(null);

watch(
  () => props.results,
  async (next) => {
    if (next.length === 0) {
      return;
    }
    await nextTick();
    animateStaggerList(listRef.value, '.vo-result-item');
  },
  { immediate: true }
);
</script>

<template>
  <div ref="listRef" class="vo-results-list vo-operator-list">
    <article
      v-for="(cand, idx) in props.results"
      :key="`${cand.source}-${String(idx)}`"
      class="vo-result-item vo-operator-row"
      :class="{ 'vo-operator-row--active': props.isSelected(cand) }"
    >
      <button
        type="button"
        class="vo-btn vo-result-item__btn"
        :class="{ 'vo-btn--primary': props.isSelected(cand) }"
        :disabled="props.isSelected(cand)"
        @click="emit('select', cand)"
      >
        {{ props.isSelected(cand) ? '✓ Selected' : 'Select' }}
      </button>
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
        <div class="vo-mono vo-muted vo-result-item__ids">
          <span v-if="cand.imdbId">{{ cand.imdbId }}</span>
          <span v-if="cand.imdbId && cand.tvdbId"> · </span>
          <span v-if="cand.tvdbId">tvdb-{{ cand.tvdbId }}</span>
        </div>
      </div>
    </article>
    <p v-if="props.results.length === 0" class="vo-muted">No metadata candidates yet.</p>
  </div>
</template>

<style scoped lang="scss">
.vo-results-list {
  overflow-x: hidden;
}

.vo-result-item {
  display: grid;
  align-items: center;
  gap: var(--vo-space-3);
  grid-template-columns: 6.25rem minmax(0, 1fr);
  min-inline-size: 0;

  @media (width <= 600px) {
    gap: var(--vo-space-2);
    grid-template-columns: minmax(0, 1fr);
  }
}

.vo-result-item__btn {
  justify-content: center;
  inline-size: 100%;

  @media (width <= 600px) {
    order: 2;
  }
}

.vo-result-item__meta {
  display: grid;
  gap: calc(var(--vo-space-1) / 2);
  min-width: 0;
}

.vo-result-item__ids {
  font-variant-numeric: tabular-nums;
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
