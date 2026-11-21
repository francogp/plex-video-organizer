// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vite-plus/test';
import { defineComponent, h, nextTick, ref } from 'vue';

import AppHeader from '../../src/client/components/AppHeader.vue';
import OrganizerStatusBar from '../../src/client/components/OrganizerStatusBar.vue';
import ParallelTasksList from '../../src/client/components/ParallelTasksList.vue';
import ServerLogsPanel from '../../src/client/components/ServerLogsPanel.vue';
import { asItemId, asJobId } from '../../src/domain/types.ts';

describe('StatusPanels', () => {
  it('ParallelTasksList renders nothing when empty and renders task rows with percentages', () => {
    const emptyWrapper = mount(ParallelTasksList, { props: { tasks: [] } });
    expect(emptyWrapper.find('ul').exists()).toBe(false);

    const wrapper = mount(ParallelTasksList, {
      props: {
        tasks: [
          { slot: 0, fileName: 'Movie A.mkv', percent: 45 },
          { slot: 1, fileName: 'Movie B.mkv' }
        ]
      }
    });
    const rows = wrapper.findAll('.vo-progress__file');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain('Movie A.mkv');
    expect(rows[0]!.text()).toContain('45%');
    const firstRowSpans = rows[0]!.findAll('span');
    expect(firstRowSpans[0]!.classes()).toContain('vo-progress__file-pct');
    expect(firstRowSpans[1]!.classes()).toContain('vo-progress__file-name');
    expect(rows[1]!.text()).toContain('Movie B.mkv');
  });

  it('OrganizerStatusBar renders idle, error, and busy states and emits events', async () => {
    const idleWrapper = mount(OrganizerStatusBar, {
      props: {
        isBusy: false,
        activeJob: null,
        errorMessage: null,
        isLockedByOther: false,
        isCancellingJob: false,
        itemCount: 3,
        summaryText: '',
        phase: 'IDLE'
      }
    });
    expect(idleWrapper.text()).toContain('Ready · 3 item(s) in queue');
    const idleEtaBtn = idleWrapper.find('.vo-progress__eta-btn');
    expect(idleEtaBtn.exists()).toBe(true);
    await idleEtaBtn.trigger('click');
    expect(idleWrapper.emitted('open-eta-simulation')).toHaveLength(1);

    const noInspectWrapper = mount(OrganizerStatusBar, {
      props: {
        isBusy: false,
        activeJob: null,
        errorMessage: null,
        isLockedByOther: false,
        isCancellingJob: false,
        canInspectEta: false,
        itemCount: 3,
        summaryText: '',
        phase: 'IDLE'
      }
    });
    expect(noInspectWrapper.find('.vo-progress__eta-btn').exists()).toBe(false);

    const errorWrapper = mount(OrganizerStatusBar, {
      props: {
        isBusy: false,
        activeJob: null,
        errorMessage: 'Scan failed',
        isLockedByOther: false,
        isCancellingJob: false,
        itemCount: 0,
        summaryText: '',
        phase: 'IDLE'
      }
    });
    expect(errorWrapper.find('.vo-status-bar__error').text()).toBe('Scan failed');
    await errorWrapper.find('button').trigger('click');
    expect(errorWrapper.emitted('dismiss-error')).toHaveLength(1);

    const busyWrapper = mount(OrganizerStatusBar, {
      props: {
        isBusy: true,
        activeJob: {
          jobId: asJobId('job-1'),
          phase: 'PROCESSING',
          totalItems: 2,
          completedItems: 1,
          currentPercent: 50,
          activeTasks: [{ slot: 0, fileName: 'Clip.mkv', percent: 50 }]
        },
        errorMessage: null,
        isLockedByOther: false,
        isCancellingJob: false,
        itemCount: 2,
        summaryText: 'Processing 1/2',
        phase: 'PROCESSING'
      }
    });
    expect(busyWrapper.text()).toContain('Processing 1/2');
    expect(busyWrapper.text()).toContain('Clip.mkv');
    const actionButtons = busyWrapper.findAll('.vo-progress__cancel');
    expect(actionButtons).toHaveLength(2);
    await actionButtons[0]!.trigger('click');
    expect(busyWrapper.emitted('cancel')).toHaveLength(1);
    await actionButtons[1]!.trigger('click');
    expect(busyWrapper.emitted('drain')).toHaveLength(1);
    await busyWrapper.find('.vo-progress__eta-btn').trigger('click');
    expect(busyWrapper.emitted('open-eta-simulation')).toHaveLength(1);

    const drainingWrapper = mount(OrganizerStatusBar, {
      props: {
        isBusy: true,
        activeJob: {
          jobId: asJobId('job-1'),
          totalItems: 2,
          completedItems: 1,
          currentPercent: 50,
          activeTasks: [],
          drainRequested: true
        },
        errorMessage: null,
        isLockedByOther: false,
        isCancellingJob: false,
        itemCount: 2,
        summaryText: 'Processing 1/2',
        phase: 'PROCESSING'
      }
    });
    expect(drainingWrapper.text()).toContain('Stopping After Current...');
    expect(
      (drainingWrapper.findAll('.vo-progress__cancel')[1]!.element as HTMLButtonElement).disabled
    ).toBe(true);

    const desyncedProcessingWrapper = mount(OrganizerStatusBar, {
      props: {
        isBusy: true,
        activeJob: {
          jobId: asJobId('b04e90cd'),
          totalItems: 31,
          completedItems: 24,
          currentPercent: 84,
          activeTasks: []
        },
        errorMessage: null,
        isLockedByOther: false,
        isCancellingJob: false,
        itemCount: 7,
        summaryText: 'Processing',
        phase: 'PREFLIGHT_BLOCKED'
      }
    });
    expect(desyncedProcessingWrapper.findAll('.vo-progress__cancel')).toHaveLength(2);
    expect(desyncedProcessingWrapper.text()).toContain('Stop After Current');

    const scanWrapper = mount(OrganizerStatusBar, {
      props: {
        isBusy: true,
        activeJob: {
          jobId: asJobId('scan'),
          totalItems: 10,
          completedItems: 2,
          currentPercent: 20,
          activeTasks: []
        },
        errorMessage: null,
        isLockedByOther: false,
        isCancellingJob: false,
        itemCount: 10,
        summaryText: 'Scanning',
        phase: 'SCANNING'
      }
    });
    expect(scanWrapper.findAll('.vo-progress__cancel')).toHaveLength(1);
    expect(scanWrapper.text()).not.toContain('Stop After Current');
  });

  it('ServerLogsPanel renders empty state, log items, and emits clear', async () => {
    const emptyWrapper = mount(ServerLogsPanel, { props: { logs: [] } });
    expect(emptyWrapper.text()).toContain('No server logs yet');
    expect((emptyWrapper.find('button').element as HTMLButtonElement).disabled).toBe(true);

    const wrapper = mount(ServerLogsPanel, {
      props: {
        logs: [
          {
            timestamp: '2026-11-14T12:00:00.000Z',
            level: 'info',
            message: 'Scan started'
          }
        ]
      }
    });
    expect(wrapper.text()).toContain('[INFO]');
    expect(wrapper.text()).toContain('Scan started');
    const autoScrollCheckbox = wrapper.find<HTMLInputElement>('.vo-logs__checkbox');
    expect(autoScrollCheckbox.element.checked).toBe(true);
    await wrapper.find('button').trigger('click');
    expect(wrapper.emitted('clear')).toHaveLength(1);
  });

  it('ServerLogsPanel auto-scrolls to newest entry only while Auto-scroll checkbox is enabled and persists to localStorage', async () => {
    globalThis.localStorage.removeItem('vo_logs_auto_scroll_v1');
    const firstLog = {
      timestamp: '2026-11-14T12:00:00.000Z',
      level: 'info' as const,
      message: 'Entry 1'
    };
    const logs = ref([firstLog]);
    const Host = defineComponent({
      setup: () => () => h(ServerLogsPanel, { logs: logs.value })
    });
    const wrapper = mount(Host);
    const listEl = wrapper.find('.vo-logs__list').element as HTMLElement;
    Object.defineProperty(listEl, 'scrollHeight', { value: 420, configurable: true });
    const checkbox = wrapper.find<HTMLInputElement>('.vo-logs__checkbox');
    expect(checkbox.element.checked).toBe(true);

    // Disable auto-scroll, verify persistence, and append a new entry: scrollTop remains untouched.
    await checkbox.setValue(false);
    expect(globalThis.localStorage.getItem('vo_logs_auto_scroll_v1')).toBe('false');
    const secondWrapper = mount(Host);
    expect(secondWrapper.find<HTMLInputElement>('.vo-logs__checkbox').element.checked).toBe(false);

    listEl.scrollTop = 10;
    const secondLog = {
      timestamp: '2026-11-14T12:00:01.000Z',
      level: 'info' as const,
      message: 'Entry 2'
    };
    logs.value = [firstLog, secondLog];
    await nextTick();
    expect(listEl.scrollTop).toBe(10);

    // Re-enable auto-scroll: persists true and triggers smooth scroll toward the latest entry.
    await checkbox.setValue(true);
    await nextTick();
    expect(globalThis.localStorage.getItem('vo_logs_auto_scroll_v1')).toBe('true');
    expect(wrapper.findAll('.vo-logs__item')).toHaveLength(2);
  });

  it('ParallelTasksList renders Skip button when canSkip and itemId are present and emits skip', async () => {
    const wrapper = mount(ParallelTasksList, {
      props: {
        canSkip: true,
        tasks: [
          { slot: 0, itemId: asItemId('item-supergirl'), fileName: 'Supergirl.mp4', percent: 1 }
        ]
      }
    });
    const skipBtn = wrapper.find('.vo-progress__skip');
    expect(skipBtn.exists()).toBe(true);
    expect(skipBtn.text()).toBe('Skip');

    await skipBtn.trigger('click');
    expect(wrapper.emitted('skip')).toEqual([[asItemId('item-supergirl')]]);
    expect(skipBtn.text()).toBe('Skipping...');
    expect((skipBtn.element as HTMLButtonElement).disabled).toBe(true);
  });

  it('AppHeader renders Title Language Order and Audio Language Order bars and emits updates', async () => {
    const wrapper = mount(AppHeader, {
      props: {
        appSemver: '1.2.0',
        phase: 'READY',
        clientId: 'c1:t1',
        activeTab: 'organizer',
        queueCount: 0,
        verifierCount: 0,
        theme: 'dark',
        isInitializing: false,
        isLockedByOther: false,
        isBusy: false,
        canProcessQueue: false,
        hasUnresolvedConflicts: false,
        includedQueueCount: 0,
        verifierScanning: false,
        verifierFixing: false,
        selectedVerifierCount: 0,
        recalculateVerifierTags: false,
        mountPaths: null,
        preferredLanguages: ['eng', 'spa', 'native'],
        audioPreferredLanguages: ['eng', 'spa', 'zho', 'jpn', 'und']
      }
    });

    expect(wrapper.text()).toContain('Title Language Order');
    expect(wrapper.text()).toContain('Audio Language Order');

    const titleBar = wrapper.find('section[aria-label="Preferred Title Language Order"]');
    expect(titleBar.find('button[aria-label="Remove native"]').exists()).toBe(false);

    const audioBar = wrapper.find('section[aria-label="Preferred Audio Language Order"]');
    expect(audioBar.find('button[aria-label="Remove und"]').exists()).toBe(false);
    const removeEngBtn = audioBar.find('button[aria-label="Remove eng"]');
    await removeEngBtn.trigger('click');
    expect(wrapper.emitted('set-audio-preferred-languages')?.[0]).toEqual([
      ['spa', 'zho', 'jpn', 'und']
    ]);

    const moveSpaEarlierBtn = audioBar.find('button[aria-label="Move spa earlier"]');
    await moveSpaEarlierBtn.trigger('click');
    expect(wrapper.emitted('set-audio-preferred-languages')?.[1]).toEqual([
      ['spa', 'eng', 'zho', 'jpn', 'und']
    ]);

    const addBtn = audioBar.find('button[aria-label="Add preferred audio language"]');
    await addBtn.trigger('click');
    const searchInput = audioBar.find('input[type="search"]');
    await searchInput.setValue('kor');
    const korOption = audioBar.find('button[role="option"]');
    expect(korOption.text()).toContain('kor');
    await korOption.trigger('click');
    expect(wrapper.emitted('set-audio-preferred-languages')?.[2]).toEqual([
      ['eng', 'spa', 'zho', 'jpn', 'und', 'kor']
    ]);
  });

  it('AppHeader enforces cross-tab mutual exclusion on Scan Input and Verifier buttons', () => {
    const queueBusyVerifierWrapper = mount(AppHeader, {
      props: {
        appSemver: '1.2.0',
        phase: 'PROCESSING',
        clientId: 'c1:t1',
        activeTab: 'verifier',
        queueCount: 1,
        verifierCount: 1,
        theme: 'dark',
        isInitializing: false,
        isLockedByOther: false,
        isBusy: true,
        canProcessQueue: false,
        hasUnresolvedConflicts: false,
        includedQueueCount: 1,
        verifierScanning: false,
        verifierFixing: false,
        selectedVerifierCount: 1,
        recalculateVerifierTags: false,
        mountPaths: null,
        preferredLanguages: ['eng'],
        audioPreferredLanguages: ['eng']
      }
    });
    const scanLibsBtn = queueBusyVerifierWrapper
      .findAll('button')
      .find((b) => b.text().includes('Scan Libraries'));
    const fixLibsBtn = queueBusyVerifierWrapper
      .findAll('button')
      .find((b) => b.text().includes('Fix Selected (Rename)'));
    const recalcInput = queueBusyVerifierWrapper.find('input[type="checkbox"]');
    expect((scanLibsBtn!.element as HTMLButtonElement).disabled).toBe(true);
    expect((fixLibsBtn!.element as HTMLButtonElement).disabled).toBe(true);
    expect((recalcInput.element as HTMLInputElement).disabled).toBe(true);

    const verifierBusyOrganizerWrapper = mount(AppHeader, {
      props: {
        appSemver: '1.2.0',
        phase: 'READY',
        clientId: 'c1:t1',
        activeTab: 'organizer',
        queueCount: 1,
        verifierCount: 0,
        theme: 'dark',
        isInitializing: false,
        isLockedByOther: false,
        isBusy: false,
        canProcessQueue: false,
        hasUnresolvedConflicts: false,
        includedQueueCount: 1,
        verifierScanning: true,
        verifierFixing: false,
        selectedVerifierCount: 0,
        recalculateVerifierTags: false,
        mountPaths: null,
        preferredLanguages: ['eng'],
        audioPreferredLanguages: ['eng']
      }
    });
    const scanInputBtn = verifierBusyOrganizerWrapper
      .findAll('button')
      .find((b) => b.text().includes('Scan Input'));
    expect((scanInputBtn!.element as HTMLButtonElement).disabled).toBe(true);

    const initVerifierWrapper = mount(AppHeader, {
      props: {
        appSemver: '1.2.0',
        phase: 'READY',
        clientId: 'c1:t1',
        activeTab: 'verifier',
        queueCount: 0,
        verifierCount: 0,
        theme: 'dark',
        isInitializing: true,
        isLockedByOther: false,
        isBusy: false,
        canProcessQueue: false,
        hasUnresolvedConflicts: false,
        includedQueueCount: 0,
        verifierScanning: false,
        verifierFixing: false,
        selectedVerifierCount: 0,
        recalculateVerifierTags: false,
        mountPaths: null,
        preferredLanguages: ['eng'],
        audioPreferredLanguages: ['eng']
      }
    });
    expect(
      (initVerifierWrapper.find('input[type="checkbox"]').element as HTMLInputElement).disabled
    ).toBe(true);
    expect(initVerifierWrapper.find('label.vo-toggle-pill').attributes('aria-disabled')).toBe(
      'true'
    );
  });
});
