<script setup lang="ts" generic="T extends string">
import { computed, useId } from 'vue';

const props = defineProps<{
  label: string;
  ariaLabel: string;
  addAriaLabel: string;
  languages: readonly T[];
  allCodes: readonly T[];
  labelsMap: Readonly<Partial<Record<T, string>>>;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  update: [languages: readonly T[]];
}>();

const selectId = useId();

const availableExtraLanguages = computed<readonly T[]>(() =>
  props.allCodes.filter((code) => !props.languages.includes(code))
);

function moveLanguage(index: number, delta: -1 | 1): void {
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= props.languages.length) {
    return;
  }
  const next = [...props.languages];
  const current = next[index];
  const target = next[nextIndex];
  if (!current || !target) {
    return;
  }
  next[index] = target;
  next[nextIndex] = current;
  emit('update', next);
}

function removeLanguage(code: T): void {
  if (props.languages.length <= 1) {
    return;
  }
  emit(
    'update',
    props.languages.filter((c) => c !== code)
  );
}

function handleAddLanguage(evt: Event): void {
  const select = evt.target as HTMLSelectElement;
  const value = select.value as T | '';
  if (!value || props.languages.includes(value)) {
    select.value = '';
    return;
  }
  emit('update', [...props.languages, value]);
  select.value = '';
}
</script>

<template>
  <section class="vo-lang-bar vo-panel" :aria-label="props.ariaLabel">
    <span class="vo-lang-bar__label">{{ props.label }}</span>
    <div class="vo-lang-bar__chips">
      <span v-for="(lang, idx) in props.languages" :key="lang" class="vo-lang-chip vo-mono">
        <span class="vo-lang-chip__rank">{{ idx + 1 }}.</span>
        <span>{{ props.labelsMap[lang] ?? lang }}</span>
        <button
          type="button"
          class="vo-lang-chip__btn"
          :disabled="Boolean(props.disabled) || idx === 0"
          :aria-label="`Move ${lang} earlier`"
          @click="moveLanguage(idx, -1)"
        >
          ←
        </button>
        <button
          type="button"
          class="vo-lang-chip__btn"
          :disabled="Boolean(props.disabled) || idx === props.languages.length - 1"
          :aria-label="`Move ${lang} later`"
          @click="moveLanguage(idx, 1)"
        >
          →
        </button>
        <button
          v-if="props.languages.length > 1"
          type="button"
          class="vo-lang-chip__btn vo-lang-chip__btn--remove"
          :disabled="Boolean(props.disabled)"
          :aria-label="`Remove ${lang}`"
          @click="removeLanguage(lang)"
        >
          ×
        </button>
      </span>
      <template v-if="availableExtraLanguages.length > 0">
        <label :for="selectId" class="vo-sr-only">{{ props.addAriaLabel }}</label>
        <select
          :id="selectId"
          class="vo-lang-bar__select"
          :aria-label="props.addAriaLabel"
          :disabled="props.disabled"
          @change="handleAddLanguage"
        >
          <option value="">+ Add language</option>
          <option v-for="code in availableExtraLanguages" :key="code" :value="code">
            {{ props.labelsMap[code] ?? code }}
          </option>
        </select>
      </template>
    </div>
  </section>
</template>

<style scoped lang="scss">
.vo-lang-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
  padding: var(--vo-space-2) var(--vo-space-3);
}

.vo-lang-bar__label {
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  font-weight: var(--vo-weight-semibold);
}

.vo-lang-bar__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
}

.vo-lang-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--vo-space-1);
  padding: 2px var(--vo-space-2);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background: color-mix(in oklch, var(--vo-accent) 8%, var(--vo-surface));
  font-size: var(--vo-text-xs);
}

.vo-lang-chip__rank {
  color: var(--vo-text-muted);
}

.vo-lang-chip__btn {
  padding: 0 3px;
  border: none;
  background: transparent;
  color: var(--vo-text-muted);
  cursor: pointer;

  &:disabled {
    opacity: 0.35;
    cursor: default;
  }

  &:hover:not(:disabled) {
    color: var(--vo-text);
  }
}

.vo-lang-chip__btn--remove:hover:not(:disabled) {
  color: var(--vo-danger);
}

.vo-lang-bar__select {
  padding: 2px var(--vo-space-2);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background: var(--vo-surface);
  color: var(--vo-text);
  font-size: var(--vo-text-xs);
}
</style>
