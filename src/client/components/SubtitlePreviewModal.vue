<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import type { ScannedItem } from '../../domain/types.ts';
import BaseModalShell from './BaseModalShell.vue';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const PAD_TWO = 2;
const QUICK_SEEK_STEPS = [-30, -10, 10, 30] as const;

const props = defineProps<{
  readonly item: ScannedItem | null;
}>();

const emit = defineEmits<{
  close: [];
}>();

const videoRef = ref<HTMLVideoElement | null>(null);
const seekOffsetSeconds = ref(0);
const streamElapsedSeconds = ref(0);
const scrubberPreviewSeconds = ref<number | null>(null);
const isBuffering = ref(false);
const isPlaying = ref(false);
const isMuted = ref(false);
const subtitlesEnabled = ref(true);
const fastMode = ref(false);
const streamError = ref<string | null>(null);

const totalDurationSeconds = computed((): number => {
  const raw = props.item?.probe.durationSeconds ?? 0;
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
});

const absoluteCurrentSeconds = computed((): number => {
  const combined = seekOffsetSeconds.value + streamElapsedSeconds.value;
  if (totalDurationSeconds.value > 0) {
    return Math.min(totalDurationSeconds.value, Math.max(0, combined));
  }
  return Math.max(0, combined);
});

const sliderValueSeconds = computed((): number =>
  scrubberPreviewSeconds.value !== null
    ? scrubberPreviewSeconds.value
    : Math.floor(absoluteCurrentSeconds.value)
);

type PreviewQueryKey = 't' | 'fast' | 'offset';

function buildPreviewEndpointUrl(
  endpoint: 'stream' | 'subtitles/preview.vtt',
  queryEntries: readonly (readonly [PreviewQueryKey, string | undefined])[] = []
): string {
  if (!props.item) {
    return '';
  }
  const base = `/api/queue/items/${encodeURIComponent(props.item.id)}/${endpoint}`;
  const params = new URLSearchParams();
  for (const [key, value] of queryEntries) {
    if (value !== undefined) {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query.length > 0 ? `${base}?${query}` : base;
}

const videoSrc = computed((): string =>
  buildPreviewEndpointUrl('stream', [
    ['t', seekOffsetSeconds.value > 0 ? String(seekOffsetSeconds.value) : undefined],
    ['fast', fastMode.value ? '1' : undefined]
  ])
);
const vttSrc = computed((): string =>
  buildPreviewEndpointUrl('subtitles/preview.vtt', [
    ['offset', seekOffsetSeconds.value > 0 ? String(seekOffsetSeconds.value) : undefined]
  ])
);
const bufferingStatusLabel = computed((): string =>
  fastMode.value ? 'Transcoding 480p Fast (Low CPU) + AAC...' : 'Transcoding 480p + AAC...'
);

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / SECONDS_PER_HOUR);
  const minutes = Math.floor((safe % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = safe % SECONDS_PER_MINUTE;
  const hh = hours > 0 ? `${String(hours).padStart(PAD_TWO, '0')}:` : '';
  return `${hh}${String(minutes).padStart(PAD_TWO, '0')}:${String(seconds).padStart(PAD_TWO, '0')}`;
}

function clampTargetSeconds(target: number): number {
  const floored = Math.max(0, Math.floor(target));
  if (totalDurationSeconds.value <= 1) {
    return floored;
  }
  return Math.min(totalDurationSeconds.value - 1, floored);
}

function syncTrackMode(): void {
  const tracks = videoRef.value?.textTracks;
  if (!tracks) {
    return;
  }
  const desiredMode: TextTrackMode = subtitlesEnabled.value ? 'showing' : 'hidden';
  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i];
    if (track) {
      track.mode = i === tracks.length - 1 ? desiredMode : 'disabled';
    }
  }
}

async function playVideo(): Promise<void> {
  const el = videoRef.value;
  if (!el) {
    return;
  }
  try {
    await el.play();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return;
    }
    console.warn('Preview playback deferred:', err);
  }
}

function releaseVideoStream(): void {
  const el = videoRef.value;
  if (!el) {
    return;
  }
  el.pause();
  el.removeAttribute('src');
  el.load();
}

async function togglePlayPause(): Promise<void> {
  const el = videoRef.value;
  if (!el) {
    return;
  }
  if (el.paused) {
    isBuffering.value = el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
    await playVideo();
  } else {
    el.pause();
  }
}

function toggleMute(): void {
  const el = videoRef.value;
  isMuted.value = !isMuted.value;
  if (el) {
    el.muted = isMuted.value;
  }
}

function toggleSubtitles(): void {
  subtitlesEnabled.value = !subtitlesEnabled.value;
  syncTrackMode();
}

function toggleFastMode(): void {
  fastMode.value = !fastMode.value;
  const el = videoRef.value;
  if (isPlaying.value || isBuffering.value || (el?.readyState ?? 0) > 0) {
    void seekTo(absoluteCurrentSeconds.value);
  }
}

async function toggleFullscreen(): Promise<void> {
  const el = videoRef.value;
  if (!el) {
    return;
  }
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  if (typeof el.requestFullscreen === 'function') {
    await el.requestFullscreen();
  }
}

async function seekTo(targetSeconds: number): Promise<void> {
  const nextOffset = clampTargetSeconds(targetSeconds);
  seekOffsetSeconds.value = nextOffset;
  streamElapsedSeconds.value = 0;
  scrubberPreviewSeconds.value = null;
  streamError.value = null;
  isBuffering.value = true;
  await nextTick();
  const el = videoRef.value;
  if (el) {
    el.muted = isMuted.value;
    el.load();
    syncTrackMode();
    await playVideo();
  }
}

function handleTimeUpdate(event: Event): void {
  const target = event.target as HTMLVideoElement | null;
  if (target) {
    streamElapsedSeconds.value = target.currentTime;
  }
}

function handleScrubberInput(event: Event): void {
  const target = event.target as HTMLInputElement | null;
  if (target) {
    scrubberPreviewSeconds.value = Number(target.value);
  }
}

function handleScrubberChange(event: Event): void {
  const target = event.target as HTMLInputElement | null;
  if (target) {
    void seekTo(Number(target.value));
  }
}

function handleRelativeSeek(deltaSeconds: number): void {
  void seekTo(absoluteCurrentSeconds.value + deltaSeconds);
}

function handleVideoError(): void {
  isBuffering.value = false;
  isPlaying.value = false;
  streamError.value =
    'Unable to load preview stream. Verify the source file is accessible and run Scan Input if needed.';
}

watch(
  () => props.item?.id,
  (nextId, prevId) => {
    if (!nextId || (prevId && nextId !== prevId)) {
      releaseVideoStream();
    }
    seekOffsetSeconds.value = 0;
    streamElapsedSeconds.value = 0;
    scrubberPreviewSeconds.value = null;
    isBuffering.value = false;
    isPlaying.value = false;
    subtitlesEnabled.value = true;
    fastMode.value = false;
    streamError.value = null;
  }
);

onBeforeUnmount(() => {
  releaseVideoStream();
});
</script>

<template>
  <BaseModalShell
    :open="Boolean(props.item)"
    title="Subtitle Sync Preview"
    :subtitle="props.item?.fileName"
    aria-label="Subtitle Sync Preview"
    close-aria-label="Close subtitle preview"
    max-width="min(900px, 95dvw)"
    :z-offset="1"
    @close="emit('close')"
  >
    <template v-if="props.item">
      <div class="vo-subtitle-preview-body">
        <video
          ref="videoRef"
          preload="none"
          width="854"
          height="480"
          class="vo-subtitle-preview-video"
          :src="videoSrc"
          @click="togglePlayPause"
          @timeupdate="handleTimeUpdate"
          @waiting="isBuffering = true"
          @canplay="
            isBuffering = false;
            syncTrackMode();
          "
          @playing="
            isBuffering = false;
            isPlaying = true;
            streamError = null;
          "
          @pause="isPlaying = false"
          @error="handleVideoError"
        >
          <track
            :key="vttSrc"
            kind="subtitles"
            srclang="es"
            label="Español"
            default
            :src="vttSrc"
          />
        </video>
        <p v-if="streamError" class="vo-preview-error vo-mono">{{ streamError }}</p>
        <div class="vo-preview-timeline">
          <div class="vo-preview-timeline__row">
            <span class="vo-mono vo-preview-timeline__clock">
              {{ formatClock(sliderValueSeconds) }} / {{ formatClock(totalDurationSeconds) }}
            </span>
            <span v-if="isBuffering" class="vo-preview-timeline__status vo-mono">
              {{ bufferingStatusLabel }}
            </span>
          </div>
          <div v-if="totalDurationSeconds > 0" class="vo-preview-timeline__scrubber">
            <label for="vo-preview-seek" class="vo-sr-only">Seek preview timeline</label>
            <input
              id="vo-preview-seek"
              type="range"
              min="0"
              :max="totalDurationSeconds"
              :value="sliderValueSeconds"
              class="vo-preview-timeline__range"
              @input="handleScrubberInput"
              @change="handleScrubberChange"
            />
          </div>
          <div class="vo-preview-timeline__actions">
            <button
              type="button"
              class="vo-btn vo-btn--primary"
              :aria-label="isPlaying ? 'Pause preview' : 'Play preview'"
              @click="togglePlayPause"
            >
              <span aria-hidden="true">{{ isPlaying ? '⏸' : '▶' }}</span>
              {{ isPlaying ? 'Pause' : 'Play' }}
            </button>
            <button
              v-for="step in QUICK_SEEK_STEPS"
              :key="step"
              type="button"
              class="vo-btn"
              @click="handleRelativeSeek(step)"
            >
              <span aria-hidden="true">{{ step < 0 ? '⏪' : '⏩' }}</span>
              {{ step > 0 ? `+${step}s` : `${step}s` }}
            </button>
            <div class="vo-preview-timeline__spacer" />
            <button
              type="button"
              class="vo-btn"
              :aria-pressed="subtitlesEnabled"
              aria-label="Toggle subtitles"
              @click="toggleSubtitles"
            >
              <span aria-hidden="true">💬</span>
              {{ subtitlesEnabled ? 'CC On' : 'CC Off' }}
            </button>
            <button
              type="button"
              class="vo-btn"
              :aria-pressed="isMuted"
              aria-label="Toggle mute"
              @click="toggleMute"
            >
              <span aria-hidden="true">{{ isMuted ? '🔇' : '🔊' }}</span>
              {{ isMuted ? 'Muted' : 'Audio' }}
            </button>
            <button
              type="button"
              class="vo-btn"
              :class="{ 'vo-btn--active': fastMode }"
              :aria-pressed="fastMode"
              aria-label="Toggle fast low-CPU preview mode"
              title="Skip non-reference frames (~8–12 fps) to halve NAS CPU usage"
              @click="toggleFastMode"
            >
              <span aria-hidden="true">⚡</span>
              Fast Mode
            </button>
            <button
              type="button"
              class="vo-btn"
              aria-label="Toggle fullscreen"
              @click="toggleFullscreen"
            >
              <span aria-hidden="true">⛶</span>
              Fullscreen
            </button>
          </div>
        </div>
      </div>
    </template>
  </BaseModalShell>
</template>

<style scoped lang="scss">
.vo-subtitle-preview-body {
  display: grid;
  gap: var(--vo-space-2);
}

.vo-subtitle-preview-video {
  border-radius: var(--vo-radius-sm);
  background-color: var(--vo-bg);
  inline-size: 100%;
  max-block-size: 65dvh;
  cursor: pointer;
}

.vo-preview-error {
  color: var(--vo-danger);
  font-size: var(--vo-text-xs);
}

.vo-preview-timeline {
  display: flex;
  flex-direction: column;
  gap: var(--vo-space-2);
}

.vo-preview-timeline__row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-2);
}

.vo-preview-timeline__clock {
  font-size: var(--vo-text-sm);
  font-variant-numeric: tabular-nums;
}

.vo-preview-timeline__status {
  color: var(--vo-accent);
  font-size: var(--vo-text-xs);
}

.vo-preview-timeline__range {
  inline-size: 100%;
  accent-color: var(--vo-accent);
  cursor: pointer;
}

.vo-preview-timeline__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
}

.vo-preview-timeline__spacer {
  flex: 1;
}
</style>
