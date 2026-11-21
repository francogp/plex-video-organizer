<script setup lang="ts">
import { animateToastEnter, animateToastLeave } from '../composables/useGsapMotion.ts';
import type { ErrorToastState } from '../types.ts';

const props = defineProps<{
  readonly state: ErrorToastState;
}>();

const emit = defineEmits<{
  dismiss: [];
  'view-logs': [];
}>();
</script>

<template>
  <Transition :css="false" @enter="animateToastEnter" @leave="animateToastLeave">
    <aside
      v-if="props.state.visible"
      class="vo-error-toast"
      role="alert"
      aria-live="assertive"
      aria-label="Processing error notification"
    >
      <div class="vo-error-toast__body">
        <div class="vo-error-toast__head">
          <span class="vo-error-toast__title">
            <span aria-hidden="true">⚠</span>
            Errors occurred ({{ String(props.state.count) }})
          </span>
          <button
            type="button"
            class="vo-error-toast__close"
            aria-label="Close error notification"
            title="Close notification"
            @click="emit('dismiss')"
          >
            ×
          </button>
        </div>
        <p class="vo-error-toast__hint">Check <strong>Server Logs</strong> for details.</p>
        <p
          v-if="props.state.latestMessage"
          class="vo-error-toast__msg vo-mono"
          :title="props.state.latestMessage"
        >
          {{ props.state.latestMessage }}
        </p>
        <div class="vo-error-toast__actions">
          <button type="button" class="vo-btn vo-btn--compact" @click="emit('view-logs')">
            View logs
          </button>
          <button type="button" class="vo-btn vo-btn--compact" @click="emit('dismiss')">
            Dismiss
          </button>
        </div>
      </div>
    </aside>
  </Transition>
</template>

<style scoped lang="scss">
.vo-error-toast {
  position: fixed;
  z-index: var(--vo-z-toast);
  padding: var(--vo-space-3);
  border: 1px solid color-mix(in oklch, var(--vo-danger) 55%, transparent);
  border-radius: var(--vo-radius-md);
  background: color-mix(in oklch, var(--vo-surface-elevated) 96%, var(--vo-danger) 4%);
  inset-block-start: var(--vo-space-3);
  inset-inline-end: var(--vo-space-3);
  inline-size: min(24rem, calc(100dvw - 2 * var(--vo-space-3)));
  border-inline-start: var(--vo-space-1) solid var(--vo-danger);
  box-shadow: var(--vo-shadow-panel);
  backdrop-filter: blur(8px);
}

.vo-error-toast__body {
  display: grid;
  gap: var(--vo-space-1);
}

.vo-error-toast__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-2);
}

.vo-error-toast__title {
  color: var(--vo-danger);
  font-size: var(--vo-text-sm);
  font-weight: var(--vo-weight-semibold);
}

.vo-error-toast__close {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  border: 1px solid transparent;
  border-radius: var(--vo-radius-sm);
  background: transparent;
  color: var(--vo-text-muted);
  font-size: var(--vo-text-md);
  line-height: 1;
  inline-size: 1.5rem;
  block-size: 1.5rem;
  cursor: pointer;

  &:hover {
    color: var(--vo-text);
    border-color: var(--vo-border);
  }
}

.vo-error-toast__hint {
  margin: 0;
  color: var(--vo-text);
  font-size: var(--vo-text-xs);
}

.vo-error-toast__msg {
  margin: 0;
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vo-error-toast__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--vo-space-2);
  padding-block-start: var(--vo-space-1);
}
</style>
