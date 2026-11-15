<script setup lang="ts">
import type { VerifierEntryId, VerifierRenameStep } from '../../domain/types.ts';
import { splitRelativePathSegments } from '../utils/formatters.ts';

const props = defineProps<{
  entryId: VerifierEntryId;
  steps: readonly VerifierRenameStep[];
}>();

interface FileComparisonItem {
  readonly fromName: string;
  readonly toName: string;
}

interface FilePlanGroup {
  readonly kind: 'files';
  readonly key: string;
  readonly fromFolders: readonly string[];
  readonly toFolders: readonly string[];
  readonly sameFolder: boolean;
  readonly items: readonly FileComparisonItem[];
}

interface DirPlanItem {
  readonly stepKind: 'season-dir' | 'root-dir';
  readonly fromPath: string;
  readonly toPath: string;
}

interface DirPlanGroup {
  readonly kind: 'dirs';
  readonly key: string;
  readonly items: readonly DirPlanItem[];
}

type RenamePlanGroup = FilePlanGroup | DirPlanGroup;

function buildRenamePlanGroups(steps: readonly VerifierRenameStep[]): readonly RenamePlanGroup[] {
  const fileGroups = new Map<
    string,
    {
      readonly kind: 'files';
      readonly key: string;
      readonly fromFolders: readonly string[];
      readonly toFolders: readonly string[];
      readonly sameFolder: boolean;
      readonly items: FileComparisonItem[];
    }
  >();
  const dirItems: DirPlanItem[] = [];

  for (const step of steps) {
    if (step.kind === 'file') {
      const fromSegs = splitRelativePathSegments(step.fromRelative);
      const toSegs = splitRelativePathSegments(step.toRelative);
      const fromKey = fromSegs.folders.join('/');
      const toKey = toSegs.folders.join('/');
      const groupKey = `${fromKey}::${toKey}`;
      let group = fileGroups.get(groupKey);
      if (!group) {
        group = {
          kind: 'files',
          key: groupKey,
          fromFolders: fromSegs.folders,
          toFolders: toSegs.folders,
          sameFolder: fromKey === toKey,
          items: []
        };
        fileGroups.set(groupKey, group);
      }
      group.items.push({
        fromName: fromSegs.fileName ?? step.fromRelative,
        toName: toSegs.fileName ?? step.toRelative
      });
      continue;
    }

    dirItems.push({
      stepKind: step.kind,
      fromPath: step.fromRelative.replace(/\\/g, '/'),
      toPath: step.toRelative.replace(/\\/g, '/')
    });
  }

  const groups: RenamePlanGroup[] = [...fileGroups.values()];
  if (dirItems.length > 0) {
    groups.push({ kind: 'dirs', key: 'dirs', items: dirItems });
  }
  return groups;
}
</script>

<template>
  <div v-if="props.steps.length > 0" class="vo-plan-panels vo-mono">
    <details
      v-for="group in buildRenamePlanGroups(props.steps)"
      :key="`${props.entryId}-${group.key}`"
      class="vo-plan-panel"
      open
    >
      <summary class="vo-plan-panel__summary">
        <template v-if="group.kind === 'files'">
          <span class="vo-plan-panel__title">
            <span class="vo-badge vo-badge--accent">files</span>
            <span v-if="group.fromFolders.length > 0" class="vo-plan-panel__path">
              {{ group.fromFolders.join(' / ') }}
              <template v-if="!group.sameFolder"> -> {{ group.toFolders.join(' / ') }} </template>
            </span>
            <span v-else class="vo-muted">root</span>
          </span>
        </template>
        <template v-else>
          <span class="vo-plan-panel__title">
            <span class="vo-badge vo-badge--accent">folders</span>
            <span class="vo-muted">Directory renames</span>
          </span>
        </template>
        <span class="vo-badge vo-badge--compact">{{ group.items.length }}</span>
      </summary>

      <ul v-if="group.kind === 'files'" class="vo-plan-panel__list">
        <li
          v-for="(item, idx) in group.items"
          :key="`${group.key}-${idx}`"
          class="vo-plan-diff-row"
        >
          <span class="vo-plan-diff-cell vo-plan-diff-cell--from">
            {{ item.fromName }}
          </span>
          <span class="vo-step-arrow" aria-hidden="true">-></span>
          <span class="vo-plan-diff-cell vo-plan-diff-cell--to">
            {{ item.toName }}
          </span>
        </li>
      </ul>

      <ul v-else class="vo-plan-panel__list">
        <li v-for="(item, idx) in group.items" :key="`${group.key}-${idx}`" class="vo-plan-dir-row">
          <span class="vo-badge vo-badge--compact vo-badge--accent">{{ item.stepKind }}</span>
          <span class="vo-plan-diff-cell vo-plan-diff-cell--from">
            {{ item.fromPath }}
          </span>
          <span class="vo-step-arrow" aria-hidden="true">-></span>
          <span class="vo-plan-diff-cell vo-plan-diff-cell--to">
            {{ item.toPath }}
          </span>
        </li>
      </ul>
    </details>
  </div>
  <span v-else class="vo-muted vo-mono"> Manual metadata resolution required before rename. </span>
</template>

<style scoped lang="scss">
.vo-muted {
  color: var(--vo-text-muted);
}

.vo-plan-panels {
  display: grid;
  gap: var(--vo-space-2);
  min-width: 0;
  max-width: 100%;
  max-height: 16rem;
  padding-right: var(--vo-space-1);
  overflow-y: auto;
}

.vo-plan-panel {
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background: color-mix(in oklch, var(--vo-bg) 45%, transparent);
  overflow: hidden;
}

.vo-plan-panel__summary {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-2);
  padding: var(--vo-space-1) var(--vo-space-2);
  background: color-mix(in oklch, var(--vo-border) 24%, transparent);
  font-size: var(--vo-text-xs);
  cursor: pointer;
  user-select: none;
}

.vo-plan-panel__title {
  display: inline-flex;
  align-items: center;
  gap: var(--vo-space-2);
  min-width: 0;
}

.vo-plan-panel__path {
  color: var(--vo-text);
  overflow-wrap: anywhere;
}

.vo-plan-panel__list {
  display: grid;
  gap: var(--vo-space-1);
  margin: 0;
  padding: var(--vo-space-1) var(--vo-space-2);
  list-style: none;
}

%vo-plan-row-base {
  display: grid;
  align-items: center;
  gap: var(--vo-space-2);
  padding-block: var(--vo-space-1);
  border-bottom: 1px solid color-mix(in oklch, var(--vo-border) 40%, transparent);

  &:last-child {
    border-bottom: none;
  }
}

.vo-plan-diff-row {
  @extend %vo-plan-row-base;

  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
}

.vo-plan-dir-row {
  @extend %vo-plan-row-base;

  grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr);
}

.vo-plan-diff-cell {
  min-width: 0;
  padding: var(--vo-space-1) var(--vo-space-2);
  border-radius: var(--vo-radius-sm);
  font-size: var(--vo-text-xs);
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.vo-plan-diff-cell--from {
  border: 1px solid color-mix(in oklch, var(--vo-danger) 38%, transparent);
  background: color-mix(in oklch, var(--vo-danger) 9%, transparent);
  color: var(--vo-text);
}

.vo-plan-diff-cell--to {
  border: 1px solid color-mix(in oklch, var(--vo-success) 42%, transparent);
  background: color-mix(in oklch, var(--vo-success) 10%, transparent);
  color: var(--vo-text);
}

.vo-step-arrow {
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
}
</style>
