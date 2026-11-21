<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';

import OrganizerWorkspace from './components/OrganizerWorkspace.vue';
import { useGsapMotion } from './composables/useGsapMotion.ts';
import { useOrganizerStore } from './stores/organizerStore.ts';

declare const __APP_SEMVER__: string;

const store = useOrganizerStore();
const appSemver = typeof __APP_SEMVER__ === 'string' ? __APP_SEMVER__ : 'v1.0.0';
const rootRef = ref<HTMLElement | null>(null);
const { animateShellTimeline, animateEntrance, attachInteractiveMotion } = useGsapMotion(rootRef);

onMounted(async (): Promise<void> => {
  animateShellTimeline();
  attachInteractiveMotion();
  await store.bootstrapConnection();
});

watch(
  () => store.phase,
  (nextPhase, prevPhase): void => {
    if (prevPhase === 'SCANNING' && nextPhase === 'READY') {
      void store.refreshPreflightSafely();
    }
  }
);

watch(
  (): number => store.items.length,
  (nextLen, prevLen): void => {
    if (nextLen > 0 && nextLen !== prevLen) {
      animateEntrance('.vo-queue-row');
    }
  }
);

onUnmounted((): void => {
  store.disconnectSse();
});
</script>

<template>
  <main ref="rootRef" class="vo-shell">
    <OrganizerWorkspace :app-semver="appSemver" :store="store" />
  </main>
</template>

<style scoped lang="scss">
.vo-shell {
  display: grid;
  gap: var(--vo-space-3);
  grid-template-columns: minmax(0, 1fr);
  width: 100%;
  padding: var(--vo-space-2);
}
</style>
