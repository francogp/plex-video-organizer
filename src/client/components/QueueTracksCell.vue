<script setup lang="ts">
import { computed } from 'vue';

import type { ItemId, ScannedItem, SubtitleCandidate } from '../../domain/types.ts';
import QueueTracksPanel, { type TracksSummary } from './QueueTracksPanel.vue';

export interface TracksSubtitlePickerState {
  readonly itemId: ItemId;
  readonly loading: boolean;
  readonly downloadingId: string | null;
  readonly error: string | null;
  readonly candidates: readonly SubtitleCandidate[];
}

const props = defineProps<{
  item: ScannedItem;
  disabled: boolean;
  summary: TracksSummary;
  subtitlePicker?: TracksSubtitlePickerState | null;
}>();

const emit = defineEmits<{
  'inspect-tracks': [];
  'search-subtitles': [];
  'close-subtitle-picker': [];
  'download-subtitle': [candidate: SubtitleCandidate];
  'preview-subtitle': [];
}>();

const isPickerOpen = computed<boolean>(() => props.subtitlePicker?.itemId === props.item.id);
const isPickerLoading = computed<boolean>(
  () => isPickerOpen.value && Boolean(props.subtitlePicker?.loading)
);
</script>

<template>
  <div class="vo-audio-cell vo-tracks-cell">
    <QueueTracksPanel :summary="props.summary" />
    <div class="vo-audio-controls">
      <button
        type="button"
        class="vo-btn"
        :class="{ 'vo-btn--danger': props.item.trackSelection.needsUserPrompt }"
        :disabled="props.disabled"
        @click="emit('inspect-tracks')"
      >
        <span aria-hidden="true">{{
          props.item.trackSelection.needsUserPrompt ? '⚠️' : '🎛️'
        }}</span>
        {{ props.item.trackSelection.needsUserPrompt ? 'Resolve Subs' : 'Tracks' }}
      </button>
      <button
        type="button"
        class="vo-btn"
        :disabled="props.disabled || isPickerLoading"
        :title="
          props.summary.missingSpanishSubs
            ? 'Search & download Spanish (spa) subtitles'
            : 'Search another Spanish (spa) subtitle'
        "
        @click="isPickerOpen ? emit('close-subtitle-picker') : emit('search-subtitles')"
      >
        <span aria-hidden="true">{{ isPickerLoading ? '⏳' : '⬇' }}</span>
        {{ props.summary.missingSpanishSubs ? 'Find spa' : 'Sub spa' }}
      </button>
      <button
        v-if="props.item.externalSubtitles.length > 0"
        type="button"
        class="vo-btn"
        :disabled="props.disabled"
        title="Open video + external subtitle in OS default player (or browser preview) to verify sync before remuxing"
        @click="emit('preview-subtitle')"
      >
        <span aria-hidden="true">▶</span>
        Test
      </button>
    </div>
    <div
      v-if="isPickerOpen && props.subtitlePicker"
      class="vo-audio-panel vo-audio-panel--neutral vo-mono"
    >
      <div class="vo-audio-panel-head">
        <span class="vo-path-label">SPA SUBS</span>
        <button
          type="button"
          class="vo-btn vo-btn--compact"
          aria-label="Close subtitle picker"
          @click="emit('close-subtitle-picker')"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      <div v-if="props.subtitlePicker.loading" class="vo-audio-option vo-audio-option--neutral">
        Searching providers...
      </div>
      <div v-else-if="props.subtitlePicker.error" class="vo-audio-option vo-audio-option--warning">
        {{ props.subtitlePicker.error }}
      </div>
      <div v-else class="vo-audio-lines">
        <button
          v-for="cand in props.subtitlePicker.candidates.slice(0, 5)"
          :key="cand.id"
          type="button"
          class="vo-btn vo-btn--compact"
          :disabled="props.subtitlePicker.downloadingId === cand.id"
          :title="`${cand.provider} · ${cand.variant} · ${cand.releaseName}`"
          @click="emit('download-subtitle', cand)"
        >
          <span>{{ cand.hashMatch ? '✓Hash' : cand.variant }}</span>
          <span>{{ cand.releaseName.slice(0, 26) }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.vo-tracks-cell {
  min-width: 0;
}
</style>
