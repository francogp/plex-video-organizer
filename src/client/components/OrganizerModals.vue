<script setup lang="ts">
import type { OrganizerWorkflow, WorkflowStorePort } from '../composables/useOrganizerWorkflow.ts';
import ConflictResolutionModal from './ConflictResolutionModal.vue';
import MetadataSearchModal from './MetadataSearchModal.vue';
import SubtitlePickerModal from './SubtitlePickerModal.vue';
import SubtitlePreviewModal from './SubtitlePreviewModal.vue';
import TrackInspectorModal from './TrackInspectorModal.vue';

defineProps<{
  readonly store: WorkflowStorePort;
  readonly workflow: OrganizerWorkflow;
}>();
</script>

<template>
  <MetadataSearchModal
    :item="workflow.searchingItem.value"
    :bulk-count="workflow.bulkSearchingItems.value?.length"
    :search-fn="store.searchMetadata"
    @close="workflow.closeSearchModal"
    @apply="workflow.handleApplyMetadata"
  />

  <TrackInspectorModal
    :item="workflow.inspectingItem.value"
    :bulk-count="workflow.bulkTrackItems.value?.length"
    @close="workflow.closeTrackModal"
    @save="workflow.handleSaveTracks"
  />

  <SubtitlePreviewModal
    :item="workflow.previewingSubtitleItem.value"
    @close="workflow.closePreviewModal"
  />

  <SubtitlePickerModal
    :picker="workflow.subtitlePicker.value"
    :item="workflow.subtitlePickerItem.value"
    @close="workflow.closeSubtitlePicker"
    @download="workflow.handleDownloadSubtitle"
  />

  <ConflictResolutionModal
    :open="workflow.conflictsOpen.value"
    :conflicts="workflow.organizerModalConflicts.value"
    :disk-space="store.preflightDiskSpace"
    :initial-resolutions="store.savedConflictResolutions"
    :mode="workflow.isSingleOrganizerConflict.value ? 'save-only' : 'confirm'"
    @close="workflow.closeOrganizerConflicts"
    @save="workflow.handleSaveOrganizerConflicts"
    @confirm="workflow.handleConfirmConflicts"
  />

  <ConflictResolutionModal
    :open="workflow.verifierConflictsOpen.value"
    title="Destination Conflicts"
    :conflicts="workflow.verifierConflictComparisons.value"
    :initial-resolutions="workflow.verifierConflictResolutions.value"
    :mode="workflow.verifierFixAfterResolve.value ? 'save-and-confirm' : 'save-only'"
    @close="workflow.closeVerifierConflicts"
    @save="workflow.handleSaveVerifierConflicts"
    @confirm="workflow.handleConfirmVerifierConflicts"
  />
</template>
