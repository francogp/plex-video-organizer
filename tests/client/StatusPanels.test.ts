// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vite-plus/test';

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
    await busyWrapper.find('.vo-progress__cancel').trigger('click');
    expect(busyWrapper.emitted('cancel')).toHaveLength(1);
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
    await wrapper.find('button').trigger('click');
    expect(wrapper.emitted('clear')).toHaveLength(1);
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

    const audioBar = wrapper.find('section[aria-label="Preferred Audio Language Order"]');
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

    const addSelect = audioBar.find('select');
    await addSelect.setValue('kor');
    expect(wrapper.emitted('set-audio-preferred-languages')?.[2]).toEqual([
      ['eng', 'spa', 'zho', 'jpn', 'und', 'kor']
    ]);
  });
});
