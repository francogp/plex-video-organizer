<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import type { ScannedItem, SubtitleCandidate } from '../../domain/types.ts';
import { animateStaggerList } from '../composables/useGsapMotion.ts';
import BaseModalShell from './BaseModalShell.vue';
import type { SubtitlePickerViewState } from './QueueTable.vue';
import UiIcon from './UiIcon.vue';

const props = defineProps<{
  readonly picker: SubtitlePickerViewState | null;
  readonly item: ScannedItem | null;
}>();

const emit = defineEmits<{
  close: [];
  download: [item: ScannedItem, candidate: SubtitleCandidate];
}>();

const filterQuery = ref('');
const listRef = ref<HTMLElement | null>(null);

const filteredCandidates = computed((): readonly SubtitleCandidate[] => {
  const sorted = (props.picker?.candidates ?? []).toSorted(
    (a, b) => Number(b.hashMatch) - Number(a.hashMatch) || b.score - a.score
  );
  const q = filterQuery.value.trim().toLowerCase();
  if (!q) {
    return sorted;
  }
  return sorted.filter(
    (cand) =>
      cand.releaseName.toLowerCase().includes(q) ||
      cand.provider.toLowerCase().includes(q) ||
      cand.variant.toLowerCase().includes(q)
  );
});

watch(
  () => props.picker?.itemId,
  () => {
    filterQuery.value = '';
  }
);

watch(
  () => filteredCandidates.value.length,
  async (len) => {
    if (len === 0) {
      return;
    }
    await nextTick();
    animateStaggerList(listRef.value, '.vo-subtitle-picker__row');
  },
  { immediate: true }
);
</script>

<template>
  <BaseModalShell
    :open="Boolean(props.picker && props.item)"
    title="Spanish Subtitles"
    :subtitle="props.item?.fileName"
    aria-label="Spanish Subtitle Candidates"
    close-aria-label="Close subtitle picker"
    :z-offset="1"
    @close="emit('close')"
  >
    <div v-if="props.picker?.loading" class="vo-subtitle-picker__status vo-mono">
      Searching subtitle providers...
    </div>
    <div v-else-if="props.picker?.error" class="vo-subtitle-picker__error vo-mono">
      {{ props.picker.error }}
    </div>
    <template v-else-if="props.picker && props.item">
      <div class="vo-subtitle-picker__toolbar">
        <label for="vo-subtitle-filter" class="vo-sr-only">Filter subtitle candidates</label>
        <input
          id="vo-subtitle-filter"
          v-model="filterQuery"
          type="search"
          class="vo-input vo-subtitle-picker__search"
          placeholder="Filter release, provider, or variant..."
        />
        <span class="vo-mono vo-subtitle-picker__count">
          {{ filteredCandidates.length }} / {{ props.picker.candidates.length }}
        </span>
      </div>

      <div ref="listRef" class="vo-subtitle-picker__list vo-operator-list">
        <div
          v-for="(cand, idx) in filteredCandidates"
          :key="cand.id"
          class="vo-subtitle-picker__row vo-operator-row"
          :class="{ 'vo-operator-row--active': cand.hashMatch || idx === 0 }"
        >
          <button
            type="button"
            class="vo-btn vo-subtitle-picker__dl"
            :class="{ 'vo-btn--primary': cand.hashMatch || idx === 0 }"
            :disabled="props.picker.downloadingId === cand.id"
            @click="emit('download', props.item, cand)"
          >
            <UiIcon :name="props.picker.downloadingId === cand.id ? 'spinner' : 'download'" />
            {{ props.picker.downloadingId === cand.id ? 'Downloading' : 'Download' }}
          </button>
          <div class="vo-subtitle-picker__info">
            <div class="vo-subtitle-picker__release vo-mono" :title="cand.releaseName">
              {{ cand.releaseName }}
            </div>
            <div class="vo-subtitle-picker__meta vo-mono">
              <span class="vo-badge" :class="cand.hashMatch ? 'vo-badge--ok' : 'vo-badge--neutral'">
                {{ cand.hashMatch ? 'Hash match' : cand.variant }}
              </span>
              <span>{{ cand.provider }}</span>
              <span v-if="cand.downloadCount !== undefined">{{ cand.downloadCount }} dl</span>
              <span class="vo-subtitle-picker__score">score {{ cand.score }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </BaseModalShell>
</template>

<style scoped lang="scss">
.vo-subtitle-picker__status {
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
}

.vo-subtitle-picker__error {
  color: var(--vo-danger);
  font-size: var(--vo-text-xs);
}

.vo-subtitle-picker__toolbar {
  display: flex;
  align-items: center;
  gap: var(--vo-space-2);
}

.vo-subtitle-picker__search {
  flex: 1;
}

.vo-subtitle-picker__count {
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.vo-subtitle-picker__list {
  max-block-size: 58dvh;
  overflow: hidden auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.vo-subtitle-picker__row {
  display: grid;
  align-items: center;
  gap: var(--vo-space-3);
  grid-template-columns: 7.25rem minmax(0, 1fr);
  min-inline-size: 0;

  @media (width <= 600px) {
    gap: var(--vo-space-2);
    grid-template-columns: minmax(0, 1fr);
  }
}

.vo-subtitle-picker__info {
  display: flex;
  flex-direction: column;
  gap: calc(var(--vo-space-1) / 2);
  min-inline-size: 0;
  overflow: hidden;
}

.vo-subtitle-picker__release {
  font-size: var(--vo-text-xs);
  font-weight: var(--vo-weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  @media (width <= 600px) {
    white-space: normal;
    overflow-wrap: anywhere;
  }
}

.vo-subtitle-picker__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
  color: var(--vo-text-muted);
  font-size: var(--vo-text-2xs);
  font-variant-numeric: tabular-nums;
}

.vo-subtitle-picker__score {
  color: var(--vo-success);
  font-weight: var(--vo-weight-medium);
}

.vo-subtitle-picker__dl {
  justify-content: center;
  inline-size: 100%;

  @media (width <= 600px) {
    order: 2;
  }
}
</style>
