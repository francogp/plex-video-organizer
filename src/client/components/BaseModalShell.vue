<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

import { useModalVars } from '../composables/useGsapMotion.ts';

const props = defineProps<{
  readonly open: boolean;
  readonly title: string;
  readonly badge?: string;
  readonly subtitle?: string;
  readonly ariaLabel?: string;
  readonly closeAriaLabel?: string;
  readonly cardClass?: string;
  readonly maxWidth?: string;
  readonly zOffset?: number;
}>();

const emit = defineEmits<{
  close: [];
}>();

const modalVars = useModalVars(props.zOffset ?? 0);
const dialogRef = ref<HTMLElement | null>(null);

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) {
      return;
    }
    await nextTick();
    dialogRef.value?.focus({ preventScroll: true });
  },
  { immediate: true }
);
</script>

<template>
  <div
    v-if="props.open"
    ref="dialogRef"
    class="vo-modal-backdrop"
    :style="modalVars"
    role="dialog"
    aria-modal="true"
    :aria-label="props.ariaLabel ?? props.title"
    tabindex="-1"
    @click.self="emit('close')"
    @keydown.esc.stop="emit('close')"
  >
    <div
      class="vo-modal-card vo-operator-modal"
      :class="props.cardClass"
      :style="props.maxWidth ? { maxInlineSize: props.maxWidth } : undefined"
    >
      <header class="vo-modal-header vo-operator-modal__header">
        <div class="vo-operator-modal__heading">
          <div class="vo-operator-modal__title-row">
            <h2 class="vo-modal__title">{{ props.title }}</h2>
            <span v-if="props.badge" class="vo-badge vo-mono">{{ props.badge }}</span>
            <slot name="header-meta" />
          </div>
          <p v-if="props.subtitle" class="vo-operator-modal__sub vo-mono" :title="props.subtitle">
            {{ props.subtitle }}
          </p>
        </div>
        <div class="vo-operator-modal__header-actions">
          <slot name="header-actions" />
          <button
            type="button"
            class="vo-btn vo-operator-modal__close"
            :aria-label="props.closeAriaLabel ?? `Close ${props.title}`"
            title="Close (Esc)"
            @click="emit('close')"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      </header>

      <div class="vo-operator-modal__body">
        <slot />
      </div>

      <footer v-if="$slots.footer" class="vo-modal-footer vo-operator-modal__footer">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>

<style scoped lang="scss">
.vo-operator-modal {
  display: grid;
  gap: 0;
  grid-template-rows: auto minmax(0, 1fr) auto;
  padding: 0;
  overflow: hidden;
}

.vo-operator-modal__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--vo-space-3);
  padding: var(--vo-space-3) var(--vo-space-4);
  background-color: var(--vo-surface-elevated);
  border-block-end: 1px solid var(--vo-border);
}

.vo-operator-modal__heading {
  display: grid;
  gap: calc(var(--vo-space-1) / 2);
  min-inline-size: 0;
  flex: 1 1 auto;
}

.vo-operator-modal__title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);

  h2 {
    margin: 0;
    font-size: var(--vo-text-md);
    font-weight: var(--vo-weight-semibold);
  }
}

.vo-operator-modal__sub {
  margin: 0;
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vo-operator-modal__header-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--vo-space-2);
  flex-shrink: 0;
}

.vo-operator-modal__close {
  padding: var(--vo-space-1) var(--vo-space-2);
  line-height: 1;
}

.vo-operator-modal__body {
  display: grid;
  align-content: start;
  gap: var(--vo-space-3);
  padding: var(--vo-space-3) var(--vo-space-4);
  grid-auto-rows: max-content;
  min-block-size: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.vo-operator-modal__footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: var(--vo-space-2);
  padding: var(--vo-space-3) var(--vo-space-4);
  background-color: var(--vo-surface-elevated);
  border-block-start: 1px solid var(--vo-border);
}
</style>
