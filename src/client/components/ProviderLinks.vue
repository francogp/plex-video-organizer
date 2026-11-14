<script setup lang="ts">
import type { ExternalIdLink } from '../utils/formatters.ts';

const props = defineProps<{
  readonly links: readonly ExternalIdLink[];
}>();
</script>

<template>
  <a
    v-for="link in props.links"
    :key="`${link.provider}-${link.id}`"
    :href="link.url"
    target="_blank"
    rel="noopener noreferrer"
    class="vo-badge vo-provider-link"
    :class="`vo-provider-link--${link.provider}`"
    :title="`Open ${link.label} (${link.id}) in new tab`"
  >
    <svg
      v-if="link.provider === 'tvdb'"
      class="vo-provider-link__icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <rect
        x="1.5"
        y="4"
        width="13"
        height="9.5"
        rx="2"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
      />
      <path
        d="M5.5 1.5L8 4l2.5-2.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle cx="8" cy="8.75" r="1.6" fill="currentColor" />
    </svg>
    <svg
      v-else-if="link.provider === 'imdb'"
      class="vo-provider-link__icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <rect x="1" y="3" width="14" height="10" rx="2" fill="currentColor" />
      <path
        d="M3.4 5.5v5M5.3 10.5V5.5l1.2 2.9 1.2-2.9v5M9.3 5.5h1.1a1.3 1.3 0 0 1 0 5H9.3zm2.6 0v5h1.2a1.1 1.1 0 0 0 0-2.2 1.1 1.1 0 0 0-1.2 0"
        fill="none"
        stroke="#111"
        stroke-width="1"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <svg v-else class="vo-provider-link__icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
      />
      <circle cx="6" cy="8" r="1.8" fill="currentColor" />
      <path
        d="M9.5 6.2h3M9.5 9.8h3"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
    <span>{{ link.label }}</span>
    <span class="vo-provider-link__ext" aria-hidden="true">↗</span>
  </a>
</template>

<style scoped lang="scss">
.vo-provider-link {
  display: inline-flex;
  align-items: center;
  gap: var(--vo-space-1);
  color: var(--vo-text);
  transition:
    border-color 140ms ease,
    background-color 140ms ease;
  text-decoration: none;
  cursor: pointer;
}

.vo-provider-link__icon {
  width: var(--vo-space-3);
  height: var(--vo-space-3);
  flex-shrink: 0;
}

.vo-provider-link__ext {
  font-size: var(--vo-text-xs);
  opacity: 0.75;
}

.vo-provider-link--tvdb {
  background: color-mix(in oklch, var(--vo-success) 14%, transparent);
  color: var(--vo-success);
  border-color: color-mix(in oklch, var(--vo-success) 55%, var(--vo-border));
}

.vo-provider-link--tvdb:hover {
  background: color-mix(in oklch, var(--vo-success) 24%, transparent);
  border-color: var(--vo-success);
}

.vo-provider-link--imdb {
  background: color-mix(in oklch, var(--vo-warning) 14%, transparent);
  color: var(--vo-warning);
  border-color: color-mix(in oklch, var(--vo-warning) 55%, var(--vo-border));
}

.vo-provider-link--imdb:hover {
  background: color-mix(in oklch, var(--vo-warning) 24%, transparent);
  border-color: var(--vo-warning);
}

.vo-provider-link--tmdb {
  background: color-mix(in oklch, var(--vo-accent) 14%, transparent);
  color: var(--vo-accent);
  border-color: color-mix(in oklch, var(--vo-accent) 55%, var(--vo-border));
}

.vo-provider-link--tmdb:hover {
  background: color-mix(in oklch, var(--vo-accent) 24%, transparent);
  border-color: var(--vo-accent);
}
</style>
