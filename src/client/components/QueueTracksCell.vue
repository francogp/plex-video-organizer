<script setup lang="ts">
import { computed } from 'vue';

import type { ItemId, ScannedItem } from '../../domain/types.ts';
import QueueTracksPanel, { type TracksSummary } from './QueueTracksPanel.vue';

export interface TracksSubtitlePickerState {
  readonly itemId: ItemId;
  readonly loading: boolean;
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
  'preview-subtitle': [];
}>();

const isPickerLoading = computed<boolean>(
  () => props.subtitlePicker?.itemId === props.item.id && Boolean(props.subtitlePicker.loading)
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
        @click="emit('search-subtitles')"
      >
        <span aria-hidden="true">{{ isPickerLoading ? '⏳' : '⬇' }}</span>
        {{ props.summary.missingSpanishSubs ? 'Find spa' : 'Sub spa' }}
      </button>
      <button
        v-if="props.item.externalSubtitles.length > 0"
        type="button"
        class="vo-btn"
        :disabled="props.disabled"
        title="Open in-browser subtitle sync preview with live audio & seek"
        @click="emit('preview-subtitle')"
      >
        <span aria-hidden="true">▶</span>
        Test
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.vo-tracks-cell {
  min-inline-size: 0;
}
</style>
