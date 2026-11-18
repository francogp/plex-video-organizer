<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { EPISODE_ORDER_MODES } from '../../domain/constants.ts';
import { mergeDeduplicatedCandidates, parseProviderReference } from '../../domain/plexFormatter.ts';
import {
  asImdbId,
  asTvdbId,
  type EpisodeOrderMode,
  type MediaKind,
  type MetadataCandidate,
  type ScannedItem
} from '../../domain/types.ts';
import BaseModalShell from './BaseModalShell.vue';
import MetadataResultsList from './MetadataResultsList.vue';
import UiIcon from './UiIcon.vue';

const props = defineProps<{
  readonly item: ScannedItem | null;
  readonly bulkCount?: number;
  readonly searchFn: (params: {
    readonly query: string;
    readonly year?: number;
    readonly kind: MediaKind;
    readonly imdbId?: string;
    readonly tvdbId?: string;
    readonly episodeOrder?: EpisodeOrderMode;
  }) => Promise<readonly MetadataCandidate[]>;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (
    e: 'apply',
    candidate: MetadataCandidate,
    episodeOrder: EpisodeOrderMode,
    candidates: readonly MetadataCandidate[]
  ): void;
}>();

const query = ref('');
const yearInput = ref('');
const imdbInput = ref('');
const tvdbInput = ref('');
const episodeOrder = ref<EpisodeOrderMode>('aired');
const results = ref<readonly MetadataCandidate[]>([]);
const searching = ref(false);
const errorText = ref<string | null>(null);

watch(
  () => props.item,
  (next): void => {
    if (!next) {
      return;
    }
    query.value = next.selectedMetadata?.title ?? next.parsedTitle;
    yearInput.value = next.parsedYear ? String(next.parsedYear) : '';
    imdbInput.value = next.selectedMetadata?.imdbId ?? '';
    tvdbInput.value = next.selectedMetadata?.tvdbId ?? '';
    episodeOrder.value = next.episodeOrder;
    results.value = next.candidates;
    errorText.value = null;
  },
  { immediate: true }
);

function isSelectedCandidate(cand: MetadataCandidate): boolean {
  if ((props.bulkCount ?? 0) > 1) {
    return false;
  }
  const selected = props.item?.selectedMetadata;
  if (!selected) {
    return false;
  }
  return (
    selected.source === cand.source &&
    selected.title.toLowerCase() === cand.title.toLowerCase() &&
    selected.tvdbId === cand.tvdbId &&
    selected.imdbId === cand.imdbId
  );
}

async function handleSearch(): Promise<void> {
  if (!props.item) {
    return;
  }
  searching.value = true;
  errorText.value = null;
  try {
    const parsedYear = Number(yearInput.value);
    const fetched = await props.searchFn({
      query: query.value.trim(),
      year: yearInput.value.trim() && Number.isInteger(parsedYear) ? parsedYear : undefined,
      kind: props.item.mediaKind,
      imdbId: imdbInput.value.trim() || undefined,
      tvdbId: tvdbInput.value.trim() || undefined,
      episodeOrder: episodeOrder.value
    });
    results.value = mergeDeduplicatedCandidates(fetched, results.value);
  } catch (err: unknown) {
    errorText.value = err instanceof Error ? err.message : String(err);
  } finally {
    searching.value = false;
  }
}

function handleApplyManual(): void {
  if (!props.item) {
    return;
  }
  const rawImdb = imdbInput.value.trim();
  const rawTvdb = tvdbInput.value.trim();
  const cleanImdb = rawImdb ? (parseProviderReference(rawImdb).imdbId ?? rawImdb) : '';
  const cleanTvdb = rawTvdb ? (parseProviderReference(rawTvdb).tvdbId ?? rawTvdb) : '';
  if (cleanImdb && !/^tt\d+$/.test(cleanImdb)) {
    errorText.value = 'IMDb ID must match tt followed by digits (e.g. tt0816692).';
    return;
  }
  if (cleanTvdb && !/^\d+$/.test(cleanTvdb)) {
    errorText.value = 'TVDB ID must contain only digits.';
    return;
  }
  const parsedYear = Number(yearInput.value);
  const manualCandidate: MetadataCandidate = {
    title: query.value.trim() || props.item.parsedTitle,
    year: yearInput.value.trim() && Number.isInteger(parsedYear) ? parsedYear : undefined,
    imdbId: cleanImdb ? asImdbId(cleanImdb) : undefined,
    tvdbId: cleanTvdb ? asTvdbId(cleanTvdb) : undefined,
    source: 'manual'
  };
  emit(
    'apply',
    manualCandidate,
    episodeOrder.value,
    mergeDeduplicatedCandidates([manualCandidate], results.value)
  );
}

const filePillLabel = computed<string>(() => {
  if (!props.item) {
    return '';
  }
  if ((props.bulkCount ?? 0) > 1) {
    return `Applying match to ${String(props.bulkCount)} selected items (seed: ${props.item.fileName})`;
  }
  return props.item.fileName;
});
</script>

<template>
  <BaseModalShell
    :open="Boolean(item)"
    title="Metadata Lookup"
    :badge="item?.mediaKind === 'tv' ? 'Series' : 'Movie'"
    :subtitle="filePillLabel"
    :z-offset="1"
    @close="emit('close')"
  >
    <template v-if="(bulkCount ?? 0) > 1" #header-meta>
      <span class="vo-badge">{{ bulkCount }} selected</span>
    </template>

    <template v-if="item">
      <div class="vo-search-panel">
        <section class="vo-search-grid">
          <div class="vo-field vo-field--title">
            <label for="meta-query">Title</label>
            <input id="meta-query" v-model="query" type="text" class="vo-input" />
          </div>
          <div class="vo-field">
            <label for="meta-year">Year</label>
            <input id="meta-year" v-model="yearInput" type="text" class="vo-input" />
          </div>
          <div class="vo-field">
            <label for="meta-imdb">IMDb ID</label>
            <input
              id="meta-imdb"
              v-model="imdbInput"
              type="text"
              placeholder="tt0816692"
              class="vo-input"
            />
          </div>
          <div class="vo-field">
            <label for="meta-tvdb">TVDB ID</label>
            <input
              id="meta-tvdb"
              v-model="tvdbInput"
              type="text"
              placeholder="416744"
              class="vo-input"
            />
          </div>
          <div v-if="item.mediaKind === 'tv'" class="vo-field">
            <label for="meta-order">Episode Order</label>
            <select id="meta-order" v-model="episodeOrder" class="vo-input">
              <option v-for="ord in EPISODE_ORDER_MODES" :key="ord" :value="ord">{{ ord }}</option>
            </select>
          </div>
        </section>

        <div class="vo-search-actions">
          <button
            type="button"
            class="vo-btn vo-btn--primary"
            :disabled="searching"
            @click="handleSearch"
          >
            <UiIcon :name="searching ? 'spinner' : 'search'" />
            {{ searching ? 'Searching...' : 'Search Providers' }}
          </button>
          <button type="button" class="vo-btn" @click="handleApplyManual">
            <span aria-hidden="true">✏️</span> Apply Manual Values
          </button>
        </div>
      </div>

      <p v-if="errorText" class="vo-alert">{{ errorText }}</p>

      <MetadataResultsList
        :results="results"
        :media-kind="item.mediaKind"
        :is-selected="isSelectedCandidate"
        @select="emit('apply', $event, episodeOrder, results)"
      />
    </template>
  </BaseModalShell>
</template>

<style scoped lang="scss">
.vo-search-panel {
  display: grid;
  gap: var(--vo-space-2);
}

.vo-search-grid {
  display: grid;
  gap: var(--vo-space-2);
  grid-template-columns: repeat(12, minmax(0, 1fr));

  @media (width <= 600px) {
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  }
}

.vo-field {
  display: grid;
  gap: calc(var(--vo-space-1) / 2);
  min-width: 0;
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  grid-column: span 2;

  &--title {
    grid-column: span 4;
  }

  @media (width <= 600px) {
    grid-column: auto;
  }

  .vo-input {
    width: 100%;
    font-variant-numeric: tabular-nums;
  }
}

.vo-search-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--vo-space-2);
}

.vo-alert {
  margin: 0;
  padding: var(--vo-space-2) var(--vo-space-3);
  border: 1px solid var(--vo-danger);
  border-radius: var(--vo-radius-sm);
  color: var(--vo-danger);
  font-size: var(--vo-text-xs);
}

.vo-muted {
  margin: 0;
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
}
</style>
