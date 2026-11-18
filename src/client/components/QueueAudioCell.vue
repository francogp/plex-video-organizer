<script setup lang="ts">
import {
  AUDIO_LOUDNORM_TARGET_I,
  AUDIO_LOUDNORM_TARGET_TP,
  AUDIO_MEAN_QUIET_THRESHOLD_DB,
  AUDIO_NORMALIZATION_MODES,
  AUDIO_OUTPUT_CODECS,
  type AudioNormalizationMode,
  type AudioOutputCodec
} from '../../domain/constants.ts';
import type {
  AudioNormalizationConfig,
  AudioTrackAnalysis,
  ScannedItem
} from '../../domain/types.ts';

const AUDIO_MODE_LABELS: Readonly<Record<AudioNormalizationMode, string>> = {
  copy: 'Copy (original)',
  peak: 'Peak Gain',
  loudnorm: 'Loudnorm (2-pass)'
};

const AUDIO_CODEC_LABELS: Readonly<Record<AudioOutputCodec, string>> = {
  auto: 'Auto (original)',
  flac: 'FLAC (lossless)',
  ac3: 'AC3',
  aac: 'AAC'
};

export interface QueueAudioSummary {
  readonly codecText: string;
  readonly hasSurround: boolean;
  readonly analysis?: AudioTrackAnalysis;
}

const props = defineProps<{
  item: ScannedItem;
  disabled: boolean;
  summary: QueueAudioSummary;
  audioNorm: AudioNormalizationConfig;
}>();

const emit = defineEmits<{
  'change-audio-normalization': [audioNormalization: AudioNormalizationConfig];
}>();

type AudioTone = 'bad' | 'good' | 'neutral';

interface AudioComparisonRow {
  readonly icon: string;
  readonly label: string;
  readonly detail: string;
  readonly tone: AudioTone;
}

function getAudioComparisonRows(analysis: AudioTrackAnalysis): readonly AudioComparisonRow[] {
  const mean = analysis.meanVolumeDb.toFixed(1);
  const peak = analysis.maxVolumeDb.toFixed(1);
  const copyTone: AudioTone = analysis.suggestion === 'ok' ? 'good' : 'bad';
  const copyRow: AudioComparisonRow = {
    icon: copyTone === 'good' ? '✓' : '✗',
    label: 'Copy',
    detail: `Avg ${mean} · Peak ${peak} dB`,
    tone: copyTone
  };

  const gain = analysis.recommendedGainDb;
  let peakRow: AudioComparisonRow;
  if (gain <= 0) {
    peakRow = {
      icon: analysis.suggestion === 'ok' ? '•' : '✗',
      label: 'Peak',
      detail: 'No headroom (peak ~0 dB)',
      tone: analysis.suggestion === 'ok' ? 'neutral' : 'bad'
    };
  } else {
    const projMean = analysis.meanVolumeDb + gain;
    const projPeak = analysis.maxVolumeDb + gain;
    const peakEnough = projMean >= AUDIO_MEAN_QUIET_THRESHOLD_DB;
    peakRow = {
      icon: peakEnough ? '✓' : '⚠',
      label: `Peak +${gain.toFixed(1)}`,
      detail: peakEnough
        ? `Avg ${projMean.toFixed(1)} · Peak ${projPeak.toFixed(1)} dB`
        : `Avg ${projMean.toFixed(1)} dB (still quiet)`,
      tone: peakEnough ? 'good' : 'bad'
    };
  }

  const loudnormRow: AudioComparisonRow = {
    icon: analysis.suggestion === 'ok' ? '•' : '✓',
    label: 'Loudnorm',
    detail: `Avg ~${AUDIO_LOUDNORM_TARGET_I.toFixed(1)} · Peak ${AUDIO_LOUDNORM_TARGET_TP.toFixed(1)} dB`,
    tone: analysis.suggestion === 'ok' ? 'neutral' : 'good'
  };

  return [copyRow, peakRow, loudnormRow];
}

function formatAudioTooltip(analysis: AudioTrackAnalysis): string {
  const base = `volumedetect: mean ${String(analysis.meanVolumeDb)} dB, max ${String(analysis.maxVolumeDb)} dB.`;
  if (analysis.suggestion === 'peak-gain') {
    return `${base} Recommended: Peak Gain (+${String(analysis.recommendedGainDb)} dB) to raise volume cleanly without dynamic compression.`;
  }
  if (analysis.suggestion === 'loudnorm') {
    return `${base} Recommended: Loudnorm (2-pass EBU R128) to lift quiet dialogue and balance peaks.`;
  }
  return `${base} Audio levels are already well-balanced.`;
}

function updateAudioNorm(partial: Partial<AudioNormalizationConfig>): void {
  emit('change-audio-normalization', { ...props.audioNorm, ...partial });
}

function formatAudioModeOptionLabel(mode: AudioNormalizationMode): string {
  const gain = props.summary.analysis?.recommendedGainDb ?? 0;
  if (mode === 'peak' && gain > 0) {
    return `Peak (+${gain.toFixed(1)} dB)`;
  }
  return AUDIO_MODE_LABELS[mode];
}
</script>

<template>
  <div class="vo-dual-rail">
    <div
      class="vo-dual-rail__top"
      :title="
        props.summary.analysis
          ? formatAudioTooltip(props.summary.analysis)
          : 'Click Scan Input to run volumedetect analysis'
      "
    >
      <div class="vo-audio-panel-head">
        <span class="vo-path-label">AUDIO</span>
        <span class="vo-path-pill vo-path-pill--folder vo-mono">{{ props.summary.codecText }}</span>
      </div>
      <div v-if="props.summary.analysis" class="vo-audio-lines vo-mono">
        <div
          v-for="aRow in getAudioComparisonRows(props.summary.analysis)"
          :key="aRow.label"
          class="vo-audio-option"
          :class="`vo-audio-option--${aRow.tone}`"
        >
          <span class="vo-audio-option-icon" aria-hidden="true">{{ aRow.icon }}</span>
          <span class="vo-audio-option-label">{{ aRow.label }}:</span>
          <span>{{ aRow.detail }}</span>
        </div>
      </div>
      <div v-else class="vo-audio-status vo-audio-status--pending vo-mono">
        <span>Not analyzed · click Scan Input</span>
      </div>
    </div>
    <div class="vo-dual-rail__bottom">
      <label :for="`aud-mode-${props.item.id}`" class="vo-sr-only"
        >Audio normalization for {{ props.item.fileName }}</label
      >
      <select
        :id="`aud-mode-${props.item.id}`"
        class="vo-select vo-select--audio"
        :value="props.audioNorm.mode"
        :disabled="props.disabled || props.item.probe.audioStreams.length === 0"
        @change="
          updateAudioNorm({
            mode: ($event.target as HTMLSelectElement).value as AudioNormalizationMode
          })
        "
      >
        <option v-for="mode in AUDIO_NORMALIZATION_MODES" :key="mode" :value="mode">
          {{ formatAudioModeOptionLabel(mode) }}
        </option>
      </select>
      <template v-if="props.audioNorm.mode !== 'copy'">
        <label :for="`aud-codec-${props.item.id}`" class="vo-sr-only"
          >Audio codec for {{ props.item.fileName }}</label
        >
        <select
          :id="`aud-codec-${props.item.id}`"
          class="vo-select vo-select--audio"
          :value="props.audioNorm.codec"
          :disabled="props.disabled"
          @change="
            updateAudioNorm({
              codec: ($event.target as HTMLSelectElement).value as AudioOutputCodec
            })
          "
        >
          <option v-for="codec in AUDIO_OUTPUT_CODECS" :key="codec" :value="codec">
            {{ AUDIO_CODEC_LABELS[codec] }}
          </option>
        </select>
      </template>
      <label
        v-if="props.summary.hasSurround"
        class="vo-audio-downmix vo-mono"
        title="Downmix 5.1/7.1 surround to 2.0 stereo (-ac 2)"
      >
        <input
          type="checkbox"
          :checked="props.audioNorm.downmixStereo"
          :disabled="props.disabled"
          @change="
            updateAudioNorm({
              downmixStereo: ($event.target as HTMLInputElement).checked
            })
          "
        />
        <span>2.0</span>
      </label>
    </div>
  </div>
</template>

<style scoped lang="scss">
.vo-audio-status {
  display: flex;
  align-items: flex-start;
  gap: var(--vo-space-1);
  color: var(--vo-text);
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.vo-audio-status--pending {
  color: var(--vo-text-muted);
}

.vo-select--audio {
  max-width: 100%;
  font-size: var(--vo-text-xs);
  flex: 1;
}

.vo-audio-downmix {
  display: inline-flex;
  align-items: center;
  gap: var(--vo-space-1);
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  cursor: pointer;
}
</style>
