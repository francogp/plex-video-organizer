<script setup lang="ts">
import { computed } from 'vue';

export type UiIconName =
  | 'search'
  | 'bolt'
  | 'wrench'
  | 'spinner'
  | 'scale'
  | 'folder'
  | 'folder-open'
  | 'sun'
  | 'moon'
  | 'download';

interface IconSpec {
  readonly d: string;
  readonly filled?: boolean;
  readonly spin?: boolean;
}

const ICON_SPECS: Readonly<Record<UiIconName, IconSpec>> = {
  search: { d: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-3.5-3.5' },
  bolt: { d: 'M13 2 4 14h7l-1 8 10-12h-7l0-8Z', filled: true },
  wrench: {
    d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z'
  },
  spinner: { d: 'M21 12a9 9 0 1 1-6.219-8.56', spin: true },
  scale: {
    d: 'M16 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1ZM2 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1ZM7 21h10M12 3v18M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2'
  },
  folder: {
    d: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z'
  },
  'folder-open': {
    d: 'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2'
  },
  sun: {
    d: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41'
  },
  moon: { d: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z' },
  download: { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3' }
};

const props = defineProps<{
  name: UiIconName;
}>();

const spec = computed<IconSpec>(() => ICON_SPECS[props.name]);
</script>

<template>
  <svg
    class="vo-icon"
    :class="{ 'vo-icon--spin': spec.spin }"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    :fill="spec.filled ? 'currentColor' : 'none'"
    :stroke="spec.filled ? 'none' : 'currentColor'"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="spec.d" />
  </svg>
</template>

<style scoped lang="scss">
.vo-icon {
  display: inline-block;
  flex: none;
  vertical-align: middle;
}

.vo-icon--spin {
  animation: vo-spin 0.9s linear infinite;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
}

@keyframes vo-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
