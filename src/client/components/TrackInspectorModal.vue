<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue';

import {
  ISO_639_2_LABELS,
  ISO_639_2_PRESETS,
  SUBTITLE_MERGE_MODES
} from '../../domain/constants.ts';
import { ensureValidAudioTrackSelection } from '../../domain/trackSelection.ts';
import {
  asIso639_2Code,
  type ScannedItem,
  type SubtitleMergeMode,
  type TrackSelection
} from '../../domain/types.ts';
import BaseModalShell from './BaseModalShell.vue';

const props = defineProps<{
  readonly item: ScannedItem | null;
  readonly bulkCount?: number;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'save', selection: TrackSelection, applySeries: boolean): void;
}>();

const draft = ref<TrackSelection | null>(null);
const applyToSeries = ref(false);
const internalStreamsExpanded = ref(false);
const isBulkMode = computed<boolean>(() => (props.bulkCount ?? 0) > 1);
const canCollapseInternalStreams = computed<boolean>(
  () => draft.value?.subtitleMergeMode !== 'selected-only' && !draft.value?.promptReason
);
const showInternalSubtitles = computed<boolean>(
  () => !canCollapseInternalStreams.value || internalStreamsExpanded.value
);
const externalSubByPath = computed(() => {
  const map = new Map<string, ScannedItem['externalSubtitles'][number]>();
  for (const sub of props.item?.externalSubtitles ?? []) {
    map.set(sub.path, sub);
  }
  return map;
});

watch(
  () => props.item,
  (next): void => {
    draft.value = next ? structuredClone(toRaw(next.trackSelection)) : null;
    applyToSeries.value = false;
    internalStreamsExpanded.value = false;
  },
  { immediate: true }
);

function updateAudioLang(idx: number, raw: string): void {
  if (!draft.value) {
    return;
  }
  const clean = raw.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(clean)) {
    return;
  }
  const nextTracks = draft.value.audioTracks.map((t, i) =>
    i === idx ? { ...t, language: asIso639_2Code(clean) } : t
  );
  draft.value = { ...draft.value, audioTracks: nextTracks };
}

const includedAudioCount = computed(
  (): number => draft.value?.audioTracks.filter((t) => t.include).length ?? 0
);

function toggleAudioInclude(idx: number): void {
  if (!draft.value) {
    return;
  }
  const current = draft.value.audioTracks[idx];
  if (!current) {
    return;
  }
  if (current.include && includedAudioCount.value <= 1) {
    return;
  }
  const nextInclude = !current.include;
  const nextTracks = ensureValidAudioTrackSelection(
    draft.value.audioTracks.map((t, i) => (i === idx ? { ...t, include: nextInclude } : t))
  );
  draft.value = { ...draft.value, audioTracks: nextTracks };
}

function setDefaultAudio(idx: number): void {
  if (!draft.value) {
    return;
  }
  const nextTracks = draft.value.audioTracks.map((t, i) => ({
    ...t,
    isDefault: i === idx
  }));
  draft.value = { ...draft.value, audioTracks: nextTracks };
}

function formatAudioSummary(
  stream: ScannedItem['probe']['audioStreams'][number] | undefined
): string {
  if (!stream) {
    return 'audio';
  }
  const parts: string[] = [stream.codecName];
  if (stream.profile && stream.profile.toLowerCase() !== stream.codecName.toLowerCase()) {
    parts.push(stream.profile);
  }
  if (stream.channelLayout) {
    parts.push(stream.channelLayout);
  } else if (stream.channels) {
    parts.push(`${String(stream.channels)}ch`);
  }
  if (stream.bitrateBps && stream.bitrateBps > 0) {
    parts.push(`${String(Math.round(stream.bitrateBps / 1000))} kbps`);
  }
  if (stream.sampleRateHz && stream.sampleRateHz > 0) {
    parts.push(`${String(Number((stream.sampleRateHz / 1000).toFixed(1)))} kHz`);
  }
  return parts.join(' · ');
}

function getAudioDispositions(
  stream: ScannedItem['probe']['audioStreams'][number] | undefined
): readonly { readonly label: string; readonly title: string }[] {
  if (!stream) {
    return [];
  }
  const flags: {
    readonly flag: boolean | undefined;
    readonly label: string;
    readonly title: string;
  }[] = [
    { flag: stream.isAudioDescription, label: 'AD', title: 'Audio Description (Visual Impaired)' },
    { flag: stream.isCommentary, label: 'Commentary', title: 'Director / Cast Commentary' },
    { flag: stream.isHearingImpaired, label: 'HI', title: 'Hearing Impaired' },
    { flag: stream.isOriginal, label: 'Original', title: 'Original Audio' },
    { flag: stream.isDub, label: 'Dub', title: 'Dubbed Audio' }
  ];
  return flags.filter((entry) => Boolean(entry.flag)).map(({ label, title }) => ({ label, title }));
}

function setMergeMode(mode: SubtitleMergeMode): void {
  if (!draft.value) {
    return;
  }
  draft.value = { ...draft.value, subtitleMergeMode: mode, needsUserPrompt: false };
}

function toggleInternalSubtitle(streamOrder: number, checked: boolean): void {
  if (!draft.value) {
    return;
  }
  const current = new Set(draft.value.includedInternalSubtitles);
  if (checked) {
    current.add(streamOrder);
  } else {
    current.delete(streamOrder);
  }
  draft.value = {
    ...draft.value,
    includedInternalSubtitles: [...current].sort((a, b): number => a - b)
  };
}

function moveExternalSubtitle(idx: number, delta: -1 | 1): void {
  if (!draft.value) {
    return;
  }
  const nextIdx = idx + delta;
  const list = [...draft.value.externalSubtitleOrder];
  if (nextIdx < 0 || nextIdx >= list.length) {
    return;
  }
  const current = list[idx]!;
  list[idx] = list[nextIdx]!;
  list[nextIdx] = current;
  draft.value = { ...draft.value, externalSubtitleOrder: list };
}

function mergeModeDescription(mode: SubtitleMergeMode): string {
  switch (mode) {
    case 'keep-and-add': {
      return 'Preserves embedded container subtitles and muxes external subtitle files.';
    }
    case 'replace': {
      return 'Replaces embedded subtitles with external subtitle files when available.';
    }
    case 'selected-only': {
      return 'Includes only the embedded subtitles you check below plus external files.';
    }
  }
}

function handleSave(): void {
  if (!draft.value) {
    return;
  }
  emit(
    'save',
    { ...draft.value, needsUserPrompt: false, audioFilterCustomized: true },
    applyToSeries.value
  );
}
</script>

<template>
  <BaseModalShell
    :open="Boolean(item && draft)"
    title="Track Inspector"
    :badge="item?.mediaKind === 'tv' ? 'Series' : 'Movie'"
    :subtitle="
      item
        ? isBulkMode
          ? `Template: ${item.fileName} (audio tracks and subtitle merge mode apply to all selected)`
          : item.fileName
        : undefined
    "
    :z-offset="1"
    @close="emit('close')"
  >
    <template v-if="isBulkMode" #header-meta>
      <span class="vo-badge">Applying to {{ bulkCount }} selected items</span>
    </template>

    <template v-if="item && draft">
      <div v-if="draft.promptReason" class="vo-alert">
        {{ draft.promptReason }}
      </div>

      <section class="vo-section">
        <div class="vo-section-head">
          <h3>Audio Tracks</h3>
          <span class="vo-hint">
            {{ includedAudioCount }}/{{ draft.audioTracks.length }} included
          </span>
        </div>

        <div class="vo-operator-list vo-track-list">
          <div
            v-for="(track, idx) in draft.audioTracks"
            :key="track.streamOrder"
            class="vo-operator-row vo-track-card"
            :class="{
              'vo-track-card--skipped': !track.include,
              'vo-operator-row--active': track.isDefault && track.include
            }"
          >
            <div class="vo-track-main">
              <div class="vo-track-identity">
                <span class="vo-badge vo-mono">#{{ track.streamOrder }}</span>
                <span class="vo-mono vo-track-codec">
                  {{ formatAudioSummary(item.probe.audioStreams[idx]) }}
                </span>
                <span
                  v-for="flag in getAudioDispositions(item.probe.audioStreams[idx])"
                  :key="flag.label"
                  class="vo-badge"
                  :title="flag.title"
                >
                  {{ flag.label }}
                </span>
                <span v-if="!track.include" class="vo-badge vo-badge--danger">Skipped</span>
                <span v-if="item.probe.audioStreams[idx]?.title" class="vo-hint">
                  {{ item.probe.audioStreams[idx]?.title }}
                </span>
              </div>

              <div class="vo-lang-inputs">
                <label :for="`aud-lang-${String(idx)}`" class="vo-control-label">Language</label>
                <select
                  :id="`aud-lang-${String(idx)}`"
                  class="vo-input"
                  :disabled="!track.include"
                  :value="
                    ISO_639_2_PRESETS.includes(track.language as (typeof ISO_639_2_PRESETS)[number])
                      ? track.language
                      : ''
                  "
                  @change="updateAudioLang(idx, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="" disabled>Custom</option>
                  <option v-for="code in ISO_639_2_PRESETS" :key="code" :value="code">
                    {{ code }} — {{ ISO_639_2_LABELS[code] }}
                  </option>
                </select>
                <input
                  type="text"
                  maxlength="3"
                  class="vo-input vo-code-input vo-mono"
                  :disabled="!track.include"
                  :value="track.language"
                  :aria-label="`Custom ISO 639-2 code for stream ${String(track.streamOrder)}`"
                  @change="updateAudioLang(idx, ($event.target as HTMLInputElement).value)"
                />
              </div>
            </div>

            <div class="vo-track-actions">
              <label :for="`aud-def-${String(idx)}`" class="vo-radio-pill">
                <input
                  :id="`aud-def-${String(idx)}`"
                  type="radio"
                  name="defaultAudio"
                  :checked="track.isDefault"
                  :disabled="!track.include"
                  @change="setDefaultAudio(idx)"
                />
                Default
              </label>
              <button
                type="button"
                class="vo-btn vo-btn--xs"
                :class="{ 'vo-btn--danger': !track.include }"
                :disabled="track.include && includedAudioCount <= 1"
                :title="
                  track.include && includedAudioCount <= 1
                    ? 'At least one audio track must remain included'
                    : track.include
                      ? 'Mark track as Skip to remove it from output'
                      : 'Include this audio track in output'
                "
                @click="toggleAudioInclude(idx)"
              >
                <span aria-hidden="true">{{ track.include ? '⏭️' : '✅' }}</span>
                {{ track.include ? 'Skip' : 'Include' }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="vo-section">
        <div class="vo-section-head">
          <h3>Subtitle Merge Strategy</h3>
          <div class="vo-sub-counts">
            <span class="vo-badge">Internal: {{ item.probe.subtitleStreams.length }}</span>
            <span class="vo-badge">External: {{ item.externalSubtitles.length }}</span>
          </div>
        </div>

        <div v-if="item.trackSelection.needsUserPrompt" class="vo-sub-conflict-banner">
          <div class="vo-sub-conflict-banner__text">
            <strong>⚠ Subtitle Conflict</strong>
            <span>{{
              item.trackSelection.promptReason ||
              'External and embedded subtitles share the same language and flags.'
            }}</span>
          </div>
          <div class="vo-sub-conflict-banner__actions">
            <button
              type="button"
              class="vo-btn"
              :class="{ 'vo-sub-conflict-btn--active': draft.subtitleMergeMode === 'keep-and-add' }"
              @click="setMergeMode('keep-and-add')"
            >
              Keep both
            </button>
            <button
              type="button"
              class="vo-btn"
              :class="{ 'vo-sub-conflict-btn--active': draft.subtitleMergeMode === 'replace' }"
              @click="setMergeMode('replace')"
            >
              Replace embedded
            </button>
            <button
              type="button"
              class="vo-btn"
              :class="{
                'vo-sub-conflict-btn--active': draft.subtitleMergeMode === 'selected-only'
              }"
              @click="setMergeMode('selected-only')"
            >
              Pick manually
            </button>
          </div>
        </div>

        <div class="vo-operator-list">
          <div class="vo-operator-row vo-sub-merge-top">
            <div class="vo-merge-row">
              <label for="sub-merge-mode" class="vo-control-label">Merge Mode</label>
              <select
                id="sub-merge-mode"
                class="vo-input vo-merge-select"
                :value="draft.subtitleMergeMode"
                @change="
                  setMergeMode(($event.target as HTMLSelectElement).value as SubtitleMergeMode)
                "
              >
                <option v-for="mode in SUBTITLE_MERGE_MODES" :key="mode" :value="mode">
                  {{ mode }}
                </option>
              </select>
            </div>
            <p class="vo-hint">{{ mergeModeDescription(draft.subtitleMergeMode) }}</p>
          </div>

          <div
            v-if="item.probe.subtitleStreams.length > 0 || draft.externalSubtitleOrder.length > 0"
            class="vo-operator-row vo-sub-rail-body"
          >
            <div
              v-if="item.probe.subtitleStreams.length > 0 && canCollapseInternalStreams"
              class="vo-sub-streams-bar"
            >
              <button
                type="button"
                class="vo-btn vo-sub-toggle"
                :aria-expanded="showInternalSubtitles"
                @click="internalStreamsExpanded = !internalStreamsExpanded"
              >
                Streams ({{ item.probe.subtitleStreams.length }})
                <span aria-hidden="true">{{ showInternalSubtitles ? '▴' : '▾' }}</span>
              </button>
            </div>

            <div
              v-if="item.probe.subtitleStreams.length > 0 && showInternalSubtitles"
              class="vo-sub-list"
            >
              <label
                v-for="sub in item.probe.subtitleStreams"
                :key="sub.streamOrder"
                class="vo-sub-check"
              >
                <input
                  v-if="draft.subtitleMergeMode === 'selected-only'"
                  type="checkbox"
                  :checked="draft.includedInternalSubtitles.includes(sub.streamOrder)"
                  :aria-label="`Include internal subtitle stream ${String(sub.streamOrder)}`"
                  @change="
                    toggleInternalSubtitle(
                      sub.streamOrder,
                      ($event.target as HTMLInputElement).checked
                    )
                  "
                />
                <span class="vo-mono vo-sub-meta">
                  #{{ sub.streamOrder }} · {{ sub.language }} ({{ sub.codecName }})
                  <template v-if="sub.title"> · {{ sub.title }}</template>
                </span>
                <span class="vo-sub-flags">
                  <span v-if="sub.isDefault" class="vo-badge vo-badge--ok">default</span>
                  <span v-if="sub.isForced" class="vo-badge vo-badge--warn">forced</span>
                </span>
              </label>
            </div>

            <div v-if="draft.externalSubtitleOrder.length > 0" class="vo-sub-list">
              <div
                v-for="(extPath, idx) in draft.externalSubtitleOrder"
                :key="extPath"
                class="vo-ext-row"
              >
                <div class="vo-actions vo-ext-actions">
                  <button
                    type="button"
                    class="vo-btn vo-btn--xs"
                    :disabled="idx === 0"
                    title="Move up"
                    @click="moveExternalSubtitle(idx, -1)"
                  >
                    <span aria-hidden="true">↑</span> Up
                  </button>
                  <button
                    type="button"
                    class="vo-btn vo-btn--xs"
                    :disabled="idx === draft.externalSubtitleOrder.length - 1"
                    title="Move down"
                    @click="moveExternalSubtitle(idx, 1)"
                  >
                    <span aria-hidden="true">↓</span> Down
                  </button>
                </div>
                <span class="vo-mono vo-ext-path">
                  {{ idx + 1 }}.
                  <span v-if="externalSubByPath.get(extPath)" class="vo-badge vo-mono">{{
                    externalSubByPath.get(extPath)!.language
                  }}</span>
                  {{ extPath }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </template>

    <template v-if="item && draft" #footer>
      <label v-if="item.mediaKind === 'tv' && !isBulkMode" class="vo-series-check">
        <input
          id="apply-series"
          v-model="applyToSeries"
          type="checkbox"
          aria-label="Apply track setup to entire series"
        />
        Apply track setup to entire series
      </label>
      <div class="vo-actions vo-inspector-actions">
        <button type="button" class="vo-btn" @click="emit('close')">
          <span aria-hidden="true">✖️</span> Cancel
        </button>
        <button type="button" class="vo-btn vo-btn--primary" @click="handleSave">
          <span aria-hidden="true">💾</span> Save Tracks
        </button>
      </div>
    </template>
  </BaseModalShell>
</template>

<style scoped lang="scss">
.vo-sub-merge-top {
  display: grid;
  gap: var(--vo-space-1);
}

.vo-sub-rail-body {
  display: grid;
  gap: var(--vo-space-2);
}

.vo-ext-actions {
  flex-shrink: 0;
}

.vo-section {
  display: grid;
  gap: var(--vo-space-2);
}

.vo-section-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-2);

  h3 {
    margin: 0;
    font-size: var(--vo-text-md);
  }
}

.vo-track-list {
  gap: 0;
}

.vo-sub-conflict-banner {
  display: grid;
  gap: var(--vo-space-2);
  padding: var(--vo-space-2) var(--vo-space-3);
  border: 1px solid color-mix(in oklch, var(--vo-danger) 48%, var(--vo-border));
  border-radius: var(--vo-radius-md);
  background-color: color-mix(in oklch, var(--vo-danger) 10%, var(--vo-surface-elevated));
}

.vo-sub-conflict-banner__text {
  display: grid;
  gap: calc(var(--vo-space-1) / 2);
  color: var(--vo-text);
  font-size: var(--vo-text-xs);

  strong {
    color: var(--vo-danger);
  }
}

.vo-sub-conflict-banner__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--vo-space-1);
}

.vo-sub-conflict-btn--active {
  background-color: color-mix(in oklch, var(--vo-accent) 16%, transparent);
  color: var(--vo-text);
  border-color: var(--vo-accent);
}

.vo-track-card {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-3);
}

.vo-track-main {
  display: grid;
  gap: var(--vo-space-2);
  min-width: 0;
  flex: 1 1 260px;
}

.vo-track-card--skipped {
  background-color: color-mix(in oklch, var(--vo-danger) 10%, var(--vo-surface));
  opacity: 0.85;
}

.vo-track-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--vo-space-3);
}

.vo-track-card-top {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-2);
}

.vo-track-identity {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
  min-width: 0;
}

.vo-track-codec {
  color: var(--vo-text);
  font-size: var(--vo-text-xs);
  font-variant-numeric: tabular-nums;
}

.vo-radio-pill,
.vo-series-check {
  display: inline-flex;
  align-items: center;
  gap: var(--vo-space-2);
  font-size: var(--vo-text-sm);
  cursor: pointer;
}

.vo-track-controls,
.vo-merge-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-3);
}

.vo-control-label {
  color: var(--vo-text-muted);
  font-size: var(--vo-text-sm);
}

.vo-lang-inputs {
  display: inline-flex;
  align-items: center;
  gap: var(--vo-space-2);
}

.vo-merge-select {
  min-width: 12rem;
}

.vo-sub-counts {
  display: inline-flex;
  align-items: center;
  gap: var(--vo-space-2);
}

.vo-alert {
  padding: var(--vo-space-3);
  border: 1px solid var(--vo-warning);
  border-radius: var(--vo-radius-sm);
  color: var(--vo-warning);
}

.vo-hint {
  margin: 0;
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
}

.vo-actions {
  display: flex;
  gap: var(--vo-space-2);
}

.vo-code-input {
  width: 4.5rem;
  text-align: center;
}

.vo-sub-streams-bar {
  display: flex;
  align-items: center;
}

.vo-sub-toggle {
  gap: var(--vo-space-2);
  padding: var(--vo-space-1) var(--vo-space-2);
  font-size: var(--vo-text-xs);
  font-variant-numeric: tabular-nums;
}

.vo-sub-list {
  display: grid;
  gap: var(--vo-space-2);
  max-block-size: 13rem;
  overflow-y: auto;
}

.vo-sub-check,
.vo-ext-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-2);
}

.vo-sub-meta {
  font-size: var(--vo-text-xs);
  flex: 1 1 200px;
  overflow-wrap: anywhere;
}

.vo-sub-flags {
  display: inline-flex;
  align-items: center;
  gap: var(--vo-space-1);
}

.vo-ext-path {
  font-size: var(--vo-text-xs);
  flex: 1 1 200px;
  overflow-wrap: anywhere;
}

.vo-inspector-footer {
  padding-top: var(--vo-space-4);
  border-top: 1px solid var(--vo-border);
  margin-top: var(--vo-space-2);

  .vo-actions {
    margin-left: auto;
  }
}
</style>
