<script setup lang="ts">
import type { ScannedItem } from '../../domain/types.ts';
import { useModalVars } from '../composables/useGsapMotion.ts';

const props = defineProps<{
  readonly item: ScannedItem | null;
}>();

const emit = defineEmits<{
  close: [];
}>();

const modalVars = useModalVars(1);
</script>

<template>
  <div
    v-if="props.item"
    class="vo-modal-backdrop"
    :style="modalVars"
    role="dialog"
    aria-modal="true"
    aria-label="Subtitle Sync Preview"
    tabindex="-1"
    @click.self="emit('close')"
    @keydown.esc="emit('close')"
  >
    <div class="vo-modal vo-panel vo-subtitle-preview-modal">
      <header class="vo-modal__head">
        <h2 class="vo-modal__title vo-mono">{{ props.item.fileName }}</h2>
        <button
          type="button"
          class="vo-btn"
          aria-label="Close subtitle preview"
          @click="emit('close')"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </header>
      <video
        controls
        preload="none"
        width="854"
        height="480"
        class="vo-subtitle-preview-video"
        :src="`/api/queue/items/${encodeURIComponent(props.item.id)}/stream`"
      >
        <track
          kind="subtitles"
          srclang="es"
          label="Español"
          default
          :src="`/api/queue/items/${encodeURIComponent(props.item.id)}/subtitles/preview.vtt`"
        />
      </video>
    </div>
  </div>
</template>

<style scoped lang="scss">
.vo-subtitle-preview-modal {
  inline-size: min(900px, 95dvw);
}

.vo-subtitle-preview-video {
  border-radius: var(--vo-radius-sm);
  background-color: var(--vo-bg);
  inline-size: 100%;
  max-block-size: 70dvh;
}
</style>
