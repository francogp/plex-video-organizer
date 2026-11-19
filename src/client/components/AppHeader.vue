<script setup lang="ts">
import { computed, ref } from 'vue';

import {
  AUDIO_LANGUAGE_CODES,
  AUDIO_LANGUAGE_LABELS,
  METADATA_LANGUAGE_CODES,
  METADATA_LANGUAGE_LABELS
} from '../../domain/constants.ts';
import type {
  AudioLanguageCode,
  JobPhase,
  MetadataLanguageCode,
  MountPaths
} from '../../domain/types.ts';
import { formatPhaseLabel } from '../utils/formatters.ts';
import LanguageOrderBar from './LanguageOrderBar.vue';
import UiIcon, { type UiIconName } from './UiIcon.vue';

export type WorkspaceTab = 'organizer' | 'verifier';

const props = defineProps<{
  appSemver: string;
  ffmpegVersion?: string | null;
  phase: JobPhase;
  clientId: string;
  activeTab: WorkspaceTab;
  queueCount: number;
  verifierCount: number;
  theme: 'dark' | 'light';
  isInitializing: boolean;
  isLockedByOther: boolean;
  isBusy: boolean;
  canProcessQueue: boolean;
  hasUnresolvedConflicts: boolean;
  includedQueueCount: number;
  verifierScanning: boolean;
  verifierFixing: boolean;
  selectedVerifierCount: number;
  recalculateVerifierTags: boolean;
  mountPaths: MountPaths | null;
  preferredLanguages: readonly MetadataLanguageCode[];
  audioPreferredLanguages: readonly AudioLanguageCode[];
}>();

const emit = defineEmits<{
  'update:activeTab': [tab: WorkspaceTab];
  'update:recalculateVerifierTags': [value: boolean];
  'toggle-theme': [];
  'scan-input': [];
  'process-queue': [];
  'scan-verifier': [];
  'fix-verifier': [];
  'set-preferred-languages': [languages: readonly MetadataLanguageCode[]];
  'set-audio-preferred-languages': [languages: readonly AudioLanguageCode[]];
}>();

const mountsExpanded = ref(false);

const mountsVisible = computed<boolean>(() => mountsExpanded.value && Boolean(props.mountPaths));

const mountsToggle = computed<{ readonly icon: UiIconName; readonly label: string }>(() =>
  mountsExpanded.value
    ? { icon: 'folder-open', label: 'Hide Mounts' }
    : { icon: 'folder', label: 'Mounts' }
);

const themeToggle = computed<{ readonly icon: UiIconName; readonly label: string }>(() =>
  props.theme === 'dark'
    ? { icon: 'sun', label: 'Light Mode' }
    : { icon: 'moon', label: 'Dark Mode' }
);

const shortFfmpegVersion = computed<string | null>(() => {
  const raw = props.ffmpegVersion?.trim();
  if (!raw) {
    return null;
  }
  return /^([0-9]+(?:\.[0-9]+)*)/.exec(raw)?.[1] ?? raw;
});

const phaseBadgeTitle = computed<string | undefined>(() =>
  props.phase === 'PREFLIGHT_BLOCKED'
    ? 'Pre-flight check found destination conflicts or insufficient disk space'
    : undefined
);

const processQueueTitle = computed<string>(() => {
  if (props.hasUnresolvedConflicts) {
    return 'Resolve all output conflicts in the table first';
  }
  return props.canProcessQueue
    ? 'Process included items'
    : 'Resolve Match Candidate and Tracks for all included items first';
});

const controlsDisabled = computed<boolean>(
  () =>
    props.isInitializing ||
    props.isLockedByOther ||
    props.isBusy ||
    props.verifierScanning ||
    props.verifierFixing
);

const verifierScanButton = computed<{ readonly icon: UiIconName; readonly label: string }>(() =>
  props.verifierScanning
    ? { icon: 'spinner', label: 'Scanning Libraries...' }
    : { icon: 'search', label: 'Scan Libraries' }
);
</script>

<template>
  <header class="vo-header vo-panel">
    <div class="vo-header-left">
      <div>
        <div class="vo-title-row">
          <img
            :src="'/favicon.svg'"
            alt=""
            width="28"
            height="28"
            decoding="async"
            class="vo-brand-icon"
          />
          <h1>Plex Video Organizer</h1>
          <span class="vo-badge vo-badge--compact vo-mono" title="Application version">
            {{ props.appSemver }}
          </span>
          <span class="vo-badge vo-phase-badge" :data-phase="props.phase" :title="phaseBadgeTitle">
            {{ formatPhaseLabel(props.phase) }}
          </span>
        </div>
        <p class="vo-subtitle vo-mono">
          Client: {{ props.clientId }} · TZ: Buenos Aires (ART)<template v-if="shortFfmpegVersion">
            ·
            <span class="vo-ffmpeg-chip" :title="props.ffmpegVersion ?? undefined">
              <span class="vo-status-dot" aria-hidden="true" />
              FFmpeg {{ shortFfmpegVersion }}
            </span>
          </template>
        </p>
      </div>
      <nav class="vo-tabs" role="tablist" aria-label="Workspace mode">
        <button
          type="button"
          role="tab"
          class="vo-tab"
          :aria-selected="props.activeTab === 'organizer'"
          :data-active="props.activeTab === 'organizer'"
          @click="emit('update:activeTab', 'organizer')"
        >
          Organizer
          <span v-if="props.queueCount > 0" class="vo-badge vo-badge--compact">
            {{ props.queueCount }}
          </span>
        </button>
        <button
          type="button"
          role="tab"
          class="vo-tab"
          :aria-selected="props.activeTab === 'verifier'"
          :data-active="props.activeTab === 'verifier'"
          @click="emit('update:activeTab', 'verifier')"
        >
          Verifier
          <span v-if="props.verifierCount > 0" class="vo-badge vo-badge--danger vo-badge--compact">
            {{ props.verifierCount }}
          </span>
        </button>
      </nav>
    </div>
    <div class="vo-header-actions">
      <button type="button" class="vo-btn" @click="mountsExpanded = !mountsExpanded">
        <UiIcon :name="mountsToggle.icon" />
        {{ mountsToggle.label }}
      </button>
      <button type="button" class="vo-btn" @click="emit('toggle-theme')">
        <UiIcon :name="themeToggle.icon" />
        {{ themeToggle.label }}
      </button>
      <template v-if="props.activeTab === 'organizer'">
        <button
          type="button"
          class="vo-btn vo-btn--scan"
          :disabled="controlsDisabled"
          @click="emit('scan-input')"
        >
          <UiIcon name="search" />
          Scan Input
        </button>
        <button
          type="button"
          class="vo-btn vo-btn--primary"
          :disabled="!props.canProcessQueue || props.hasUnresolvedConflicts"
          :title="processQueueTitle"
          @click="emit('process-queue')"
        >
          <UiIcon name="bolt" />
          <span>Process Queue</span>
          <span class="vo-badge vo-badge--compact">{{ props.includedQueueCount }}</span>
        </button>
      </template>
      <template v-else>
        <label
          class="vo-btn vo-toggle-pill"
          :data-active="props.recalculateVerifierTags"
          :aria-disabled="controlsDisabled"
          title="Run FFprobe on output movie files to recalculate Plex [tags] (DV, HDR10+, audio channels, Spanish Audio)"
        >
          <input
            :checked="props.recalculateVerifierTags"
            type="checkbox"
            :disabled="controlsDisabled"
            @change="
              emit('update:recalculateVerifierTags', ($event.target as HTMLInputElement).checked)
            "
          />
          <span>Recalculate [tags]</span>
        </label>
        <button
          type="button"
          class="vo-btn vo-btn--scan"
          :disabled="controlsDisabled"
          @click="emit('scan-verifier')"
        >
          <UiIcon :name="verifierScanButton.icon" />
          {{ verifierScanButton.label }}
        </button>
        <button
          type="button"
          class="vo-btn vo-btn--primary"
          :disabled="controlsDisabled || props.selectedVerifierCount === 0"
          @click="emit('fix-verifier')"
        >
          <template v-if="props.verifierFixing">
            <UiIcon name="spinner" />
            Renaming...
          </template>
          <template v-else>
            <UiIcon name="wrench" />
            <span>Fix Selected (Rename)</span>
            <span class="vo-badge vo-badge--compact">{{ props.selectedVerifierCount }}</span>
          </template>
        </button>
      </template>
    </div>
  </header>

  <section v-if="mountsVisible && props.mountPaths" class="vo-mounts vo-panel vo-mono">
    <div>config: {{ props.mountPaths.configDir }}</div>
    <div>input: {{ props.mountPaths.inputDir }}</div>
    <div>backup: {{ props.mountPaths.backupDir }}</div>
    <div>movies: {{ props.mountPaths.movies }}</div>
    <div>animated-movies: {{ props.mountPaths['animated-movies'] }}</div>
    <div>tv-shows: {{ props.mountPaths['tv-shows'] }}</div>
    <div>animated-series: {{ props.mountPaths['animated-series'] }}</div>
  </section>

  <div class="vo-lang-bars">
    <LanguageOrderBar
      label="Title Language Order"
      aria-label="Preferred Title Language Order"
      add-aria-label="Add preferred title language"
      :languages="props.preferredLanguages"
      :all-codes="METADATA_LANGUAGE_CODES"
      :labels-map="METADATA_LANGUAGE_LABELS"
      :locked-codes="['native']"
      :disabled="props.isInitializing"
      @update="emit('set-preferred-languages', $event)"
    />

    <LanguageOrderBar
      label="Audio Language Order"
      aria-label="Preferred Audio Language Order"
      add-aria-label="Add preferred audio language"
      :languages="props.audioPreferredLanguages"
      :all-codes="AUDIO_LANGUAGE_CODES"
      :labels-map="AUDIO_LANGUAGE_LABELS"
      :locked-codes="['und']"
      :disabled="props.isInitializing"
      @update="emit('set-audio-preferred-languages', $event)"
    />
  </div>
</template>

<style scoped lang="scss">
.vo-panel {
  min-width: 0;
  max-width: 100%;
}

.vo-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-4);
  padding: var(--vo-space-4);
  border: 1px solid var(--vo-border-highlight);
  border-radius: var(--vo-radius-lg);
  background: var(--vo-surface-gradient);
  box-shadow: var(--vo-shadow-panel);
  will-change: transform;

  h1 {
    margin: 0;
    font-size: var(--vo-text-lg);
  }
}

.vo-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
}

.vo-brand-icon {
  border-radius: var(--vo-radius-sm);
  flex: none;
  inline-size: 1.75rem;
  block-size: 1.75rem;
}

.vo-phase-badge {
  &[data-phase='READY'],
  &[data-phase='DONE'] {
    background-color: color-mix(in oklch, var(--vo-success) 14%, var(--vo-surface));
    color: var(--vo-success);
    border-color: color-mix(in oklch, var(--vo-success) 50%, var(--vo-border));
  }

  &[data-phase='SCANNING'],
  &[data-phase='PROCESSING'] {
    background-color: color-mix(in oklch, var(--vo-accent) 14%, var(--vo-surface));
    color: var(--vo-accent);
    border-color: color-mix(in oklch, var(--vo-accent) 50%, var(--vo-border));
  }

  &[data-phase='PREFLIGHT_BLOCKED'] {
    background-color: color-mix(in oklch, var(--vo-warning) 14%, var(--vo-surface));
    color: var(--vo-warning);
    border-color: color-mix(in oklch, var(--vo-warning) 50%, var(--vo-border));
  }

  &[data-phase='ERROR'] {
    background-color: color-mix(in oklch, var(--vo-danger) 14%, var(--vo-surface));
    color: var(--vo-danger);
    border-color: color-mix(in oklch, var(--vo-danger) 50%, var(--vo-border));
  }
}

.vo-subtitle {
  margin: var(--vo-space-1) 0 0;
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
}

.vo-ffmpeg-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--vo-space-1);
}

.vo-status-dot {
  border-radius: var(--vo-radius-pill);
  background-color: var(--vo-success);
  inline-size: 6px;
  block-size: 6px;
  flex: none;
}

.vo-lang-bars {
  display: grid;
  gap: var(--vo-space-1);
  grid-template-columns: minmax(0, 1fr);

  @media (width >= 1024px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.vo-header-left {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-4);
}

.vo-header-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
  margin-inline-start: auto;
}

.vo-tabs {
  display: inline-flex;
  gap: var(--vo-space-1);
  padding: var(--vo-space-1);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-md);
  background: var(--vo-surface-elevated);
}

.vo-tab {
  display: inline-flex;
  align-items: center;
  gap: var(--vo-space-1);
  border: 1px solid transparent;
  border-radius: var(--vo-radius-sm);
  background: transparent;
  color: var(--vo-text-muted);
  font-size: var(--vo-text-sm);
  font-weight: var(--vo-weight-semibold);
  padding-block: var(--vo-space-1);
  padding-inline: var(--vo-space-3);
  cursor: pointer;

  &[data-active='true'] {
    background: var(--vo-accent-gradient);
    color: var(--vo-accent-contrast);
  }
}

.vo-mounts {
  display: grid;
  gap: var(--vo-space-2);
  padding: var(--vo-space-3) var(--vo-space-4);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-md);
  background-color: var(--vo-surface);
  font-size: var(--vo-text-xs);
}

.vo-toggle-pill {
  user-select: none;

  input[type='checkbox'] {
    margin: 0;
    accent-color: var(--vo-accent);
    cursor: inherit;
  }

  &[data-active='true'] {
    background-color: color-mix(in oklch, var(--vo-accent) 14%, var(--vo-surface-elevated));
    border-color: var(--vo-accent);
  }

  &[aria-disabled='true'] {
    color: var(--vo-text-muted);
    cursor: not-allowed;
  }
}
</style>
