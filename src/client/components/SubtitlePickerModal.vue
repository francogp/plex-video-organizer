<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { ScannedItem, SubtitleCandidate } from '../../domain/types.ts';
import { useModalVars } from '../composables/useGsapMotion.ts';
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

const modalVars = useModalVars(1);
const filterQuery = ref('');

const filteredCandidates = computed((): readonly SubtitleCandidate[] => {
  const sorted = [...(props.picker?.candidates ?? [])].sort(
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
</script>

<template>
  <div
    v-if="props.picker && props.item"
    class="vo-modal-backdrop"
    :style="modalVars"
    role="dialog"
    aria-modal="true"
    aria-label="Spanish Subtitle Candidates"
    tabindex="-1"
    @click.self="emit('close')"
    @keydown.esc="emit('close')"
  >
    <div class="vo-modal-card vo-subtitle-picker-modal">
      <header class="vo-modal-header">
        <div class="vo-subtitle-picker__heading">
          <h2 class="vo-modal__title vo-mono">Spanish Subtitles</h2>
          <p class="vo-subtitle-picker__file vo-mono">{{ props.item.fileName }}</p>
        </div>
        <button
          type="button"
          class="vo-btn"
          aria-label="Close subtitle picker"
          @click="emit('close')"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </header>

      <div class="vo-subtitle-picker__body">
        <div v-if="props.picker.loading" class="vo-subtitle-picker__status vo-mono">
          Searching subtitle providers...
        </div>
        <div v-else-if="props.picker.error" class="vo-subtitle-picker__error vo-mono">
          {{ props.picker.error }}
        </div>
        <template v-else>
          <div class="vo-subtitle-picker__toolbar">
            <label for="vo-subtitle-filter" class="vo-sr-only">Filter subtitle candidates</label>
            <input
              id="vo-subtitle-filter"
              v-model="filterQuery"
              type="search"
              class="vo-input vo-subtitle-picker__search"
              placeholder="Filter by release, provider, or variant (e.g. AMZ, BluRay, latam)..."
            />
            <span class="vo-mono vo-subtitle-picker__count">
              {{ filteredCandidates.length }} / {{ props.picker.candidates.length }}
            </span>
          </div>

          <div class="vo-subtitle-picker__list">
            <div v-for="cand in filteredCandidates" :key="cand.id" class="vo-subtitle-picker__row">
              <div class="vo-subtitle-picker__info">
                <div class="vo-subtitle-picker__release vo-mono">{{ cand.releaseName }}</div>
                <div class="vo-subtitle-picker__meta vo-mono">
                  <span
                    class="vo-badge"
                    :class="cand.hashMatch ? 'vo-badge--ok' : 'vo-badge--neutral'"
                  >
                    {{ cand.hashMatch ? 'Hash match' : cand.variant }}
                  </span>
                  <span>{{ cand.provider }}</span>
                  <span v-if="cand.downloadCount !== undefined"> {{ cand.downloadCount }} dl </span>
                  <span>score {{ cand.score }}</span>
                </div>
              </div>
              <button
                type="button"
                class="vo-btn vo-btn--primary vo-subtitle-picker__dl"
                :disabled="props.picker.downloadingId === cand.id"
                @click="emit('download', props.item, cand)"
              >
                <UiIcon :name="props.picker.downloadingId === cand.id ? 'spinner' : 'download'" />
                {{ props.picker.downloadingId === cand.id ? 'Downloading' : 'Download' }}
              </button>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.vo-subtitle-picker-modal {
  inline-size: min(820px, 95dvw);
}

.vo-subtitle-picker__heading {
  min-inline-size: 0;
}

.vo-subtitle-picker__file {
  color: var(--vo-muted);
  font-size: var(--vo-text-xs);
  margin-block-start: var(--vo-space-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vo-subtitle-picker__body {
  display: flex;
  flex-direction: column;
  gap: var(--vo-space-3);
  padding: var(--vo-space-4);
}

.vo-subtitle-picker__status {
  color: var(--vo-muted);
  font-size: var(--vo-text-sm);
}

.vo-subtitle-picker__error {
  color: var(--vo-danger);
  font-size: var(--vo-text-sm);
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
  color: var(--vo-muted);
  font-size: var(--vo-text-xs);
  white-space: nowrap;
}

.vo-subtitle-picker__list {
  display: flex;
  flex-direction: column;
  gap: var(--vo-space-2);
  max-block-size: 58dvh;
  overflow-y: auto;
  padding-inline-end: var(--vo-space-1);
}

.vo-subtitle-picker__row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-3);
  padding: var(--vo-space-2) var(--vo-space-3);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background-color: var(--vo-surface-alt, var(--vo-bg));
}

.vo-subtitle-picker__info {
  display: flex;
  flex-direction: column;
  gap: var(--vo-space-1);
  min-inline-size: 0;
}

.vo-subtitle-picker__release {
  font-size: var(--vo-text-sm);
  overflow-wrap: break-word;
}

.vo-subtitle-picker__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
  color: var(--vo-muted);
  font-size: var(--vo-text-xs);
}

.vo-subtitle-picker__dl {
  flex-shrink: 0;
}
</style>
