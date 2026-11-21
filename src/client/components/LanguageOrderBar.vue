<script setup lang="ts" generic="T extends string">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';

import {
  animatePanelEnter,
  animatePanelLeave,
  captureFlipState,
  playFlip
} from '../composables/useGsapMotion.ts';

const MENU_MIN_WIDTH_PX = 228;

const props = defineProps<{
  label: string;
  ariaLabel: string;
  addAriaLabel: string;
  languages: readonly T[];
  allCodes: readonly T[];
  labelsMap: Readonly<Partial<Record<T, string>>>;
  lockedCodes?: readonly T[];
  disabled?: boolean;
}>();

const emit = defineEmits<{
  update: [languages: readonly T[]];
}>();

const searchInputId = useId();
const menuOpen = ref(false);
const alignEnd = ref(false);
const searchQuery = ref('');
const chipsContainerRef = ref<HTMLElement | null>(null);
const pickerRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);

watch(
  () => props.languages,
  async (next, prev) => {
    if (!chipsContainerRef.value || next.join(',') === prev.join(',')) {
      return;
    }
    const chips = Array.from(
      chipsContainerRef.value.querySelectorAll<HTMLElement>('.vo-lang-chip')
    );
    const state = captureFlipState(chips);
    await nextTick();
    playFlip(state);
  },
  { flush: 'pre' }
);

const availableExtraLanguages = computed<readonly T[]>(() =>
  props.allCodes.filter((code) => !props.languages.includes(code))
);

const filteredExtraLanguages = computed<readonly T[]>(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) {
    return availableExtraLanguages.value;
  }
  return availableExtraLanguages.value.filter((code) => {
    const label = (props.labelsMap[code] ?? code).toLowerCase();
    return code.toLowerCase().includes(query) || label.includes(query);
  });
});

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

const lockedCodeSet = computed<ReadonlySet<T>>(() => new Set(props.lockedCodes ?? []));

function canRemove(code: T): boolean {
  return props.languages.length > 1 && !lockedCodeSet.value.has(code);
}

function removeLanguage(code: T): void {
  if (!canRemove(code)) {
    return;
  }
  emit(
    'update',
    props.languages.filter((c) => c !== code)
  );
}

function closeMenu(): void {
  menuOpen.value = false;
  searchQuery.value = '';
}

async function toggleMenu(): Promise<void> {
  if (props.disabled) {
    return;
  }
  if (menuOpen.value) {
    closeMenu();
    return;
  }
  searchQuery.value = '';
  const rect = pickerRef.value?.getBoundingClientRect();
  alignEnd.value = Boolean(
    rect && typeof window !== 'undefined' && rect.left + MENU_MIN_WIDTH_PX > window.innerWidth
  );
  menuOpen.value = true;
  await nextTick();
  searchInputRef.value?.focus();
}

function selectLanguage(code: T): void {
  if (!props.languages.includes(code)) {
    emit('update', [...props.languages, code]);
  }
  closeMenu();
}

function selectFirstMatch(): void {
  const first = filteredExtraLanguages.value[0];
  if (first) {
    selectLanguage(first);
  }
}

function handleOutsidePointerDown(evt: PointerEvent): void {
  if (!menuOpen.value) {
    return;
  }
  const root = pickerRef.value;
  if (root && evt.target instanceof Node && !root.contains(evt.target)) {
    closeMenu();
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', handleOutsidePointerDown);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleOutsidePointerDown);
});
</script>

<template>
  <section class="vo-lang-bar vo-panel" :aria-label="props.ariaLabel">
    <span class="vo-lang-bar__label">{{ props.label }}</span>
    <div ref="chipsContainerRef" class="vo-lang-bar__chips">
      <span
        v-for="(lang, idx) in props.languages"
        :key="lang"
        class="vo-lang-chip vo-mono"
        :title="props.labelsMap[lang] ?? lang"
      >
        <span class="vo-lang-chip__rank">{{ idx + 1 }}</span>
        <span>{{ lang }}</span>
        <button
          type="button"
          class="vo-lang-chip__btn"
          :disabled="Boolean(props.disabled) || idx === 0"
          :aria-label="`Move ${lang} earlier`"
          @click="moveLanguage(idx, -1)"
        >
          ‹
        </button>
        <button
          type="button"
          class="vo-lang-chip__btn"
          :disabled="Boolean(props.disabled) || idx === props.languages.length - 1"
          :aria-label="`Move ${lang} later`"
          @click="moveLanguage(idx, 1)"
        >
          ›
        </button>
        <button
          v-if="canRemove(lang)"
          type="button"
          class="vo-lang-chip__btn vo-lang-chip__btn--remove"
          :disabled="Boolean(props.disabled)"
          :aria-label="`Remove ${lang}`"
          @click="removeLanguage(lang)"
        >
          ×
        </button>
      </span>
      <div v-if="availableExtraLanguages.length > 0" ref="pickerRef" class="vo-lang-picker">
        <button
          type="button"
          class="vo-lang-bar__add-btn"
          :aria-label="props.addAriaLabel"
          :aria-expanded="menuOpen"
          :disabled="props.disabled"
          @click="void toggleMenu()"
        >
          + Add
        </button>
        <Transition :css="false" @enter="animatePanelEnter" @leave="animatePanelLeave">
          <div
            v-if="menuOpen"
            class="vo-lang-picker__menu"
            :class="{ 'vo-lang-picker__menu--end': alignEnd }"
          >
            <label :for="searchInputId" class="vo-sr-only">Filter languages</label>
            <input
              :id="searchInputId"
              ref="searchInputRef"
              v-model="searchQuery"
              type="search"
              class="vo-lang-picker__search"
              placeholder="Filter (e.g. kor, spanish)..."
              @keydown.enter.prevent="selectFirstMatch"
              @keydown.escape.prevent="closeMenu"
            />
            <div class="vo-lang-picker__list" role="listbox" :aria-label="props.addAriaLabel">
              <button
                v-for="code in filteredExtraLanguages"
                :key="code"
                type="button"
                role="option"
                aria-selected="false"
                class="vo-lang-picker__option"
                @click="selectLanguage(code)"
              >
                {{ props.labelsMap[code] ?? code }}
              </button>
              <div v-if="filteredExtraLanguages.length === 0" class="vo-lang-picker__empty">
                No matching languages
              </div>
            </div>
          </div>
        </Transition>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.vo-lang-bar {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
  padding: var(--vo-space-1) var(--vo-space-3);
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
  gap: var(--vo-space-1);
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

.vo-lang-picker {
  position: relative;
}

.vo-lang-bar__add-btn {
  padding: 2px var(--vo-space-2);
  border: 1px dashed var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background: var(--vo-surface);
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  cursor: pointer;

  &:hover:not(:disabled) {
    color: var(--vo-text);
    border-color: var(--vo-border-highlight);
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.vo-lang-picker__menu {
  position: absolute;
  z-index: var(--vo-z-dropdown, 20);
  display: flex;
  flex-direction: column;
  gap: var(--vo-space-1);
  padding: var(--vo-space-2);
  border: 1px solid var(--vo-border-highlight);
  border-radius: var(--vo-radius-md);
  background: var(--vo-surface-elevated);
  inset-block-start: calc(100% + var(--vo-space-1));
  inset-inline-start: 0;
  min-inline-size: 220px;
  max-inline-size: calc(100dvw - 2rem);
  box-shadow: var(--vo-shadow-panel);
}

.vo-lang-picker__menu--end {
  inset-inline: auto 0;
}

@media (width <= 600px) {
  .vo-lang-picker {
    position: static;
  }

  .vo-lang-picker__menu {
    inset-block-start: calc(100% + var(--vo-space-1));
    inset-inline: 0;
    inline-size: 100%;
    min-inline-size: 0;
    max-inline-size: none;
  }
}

.vo-lang-picker__search {
  padding: var(--vo-space-1) var(--vo-space-2);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background: var(--vo-surface);
  color: var(--vo-text);
  font-size: var(--vo-text-xs);
  inline-size: 100%;

  &:focus {
    outline: 2px solid var(--vo-accent);
    outline-offset: -1px;
  }
}

.vo-lang-picker__list {
  display: flex;
  flex-direction: column;
  max-block-size: 220px;
  overflow-y: auto;
}

.vo-lang-picker__option {
  padding: var(--vo-space-1) var(--vo-space-2);
  border: 0;
  border-radius: var(--vo-radius-sm);
  background: transparent;
  color: var(--vo-text);
  font-size: var(--vo-text-xs);
  text-align: start;
  cursor: pointer;

  &:hover {
    background: color-mix(in oklch, var(--vo-accent) 16%, transparent);
  }
}

.vo-lang-picker__empty {
  padding: var(--vo-space-2);
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  text-align: center;
}
</style>
