<script setup lang="ts">
import { computed } from 'vue';

import type { ItemId, ScannedItem } from '../../domain/types.ts';
import QueueTracksPanel, { type TracksSummary } from './QueueTracksPanel.vue';
import UiIcon from './UiIcon.vue';

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
  <div class="vo-dual-rail vo-tracks-cell">
    <div class="vo-dual-rail__top">
      <QueueTracksPanel :summary="props.summary" />
    </div>
    <div class="vo-dual-rail__bottom vo-tracks-actions">
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
        <UiIcon :name="isPickerLoading ? 'spinner' : 'download'" />
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

.vo-tracks-actions {
  flex-wrap: nowrap;

  :deep(.vo-btn) {
    justify-content: center;
    padding: calc(var(--vo-space-1) / 2) var(--vo-space-1);
    font-size: var(--vo-text-xs);
    flex: 1 1 auto;
    white-space: nowrap;
  }
}
</style>
