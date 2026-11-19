import { describe, expect, it } from 'vite-plus/test';

import { buildEtaAttemptTaskId, buildEtaStageId, buildEtaStepId } from '../../src/domain/eta.ts';
import { asItemId } from '../../src/domain/types.ts';
import { EtaPredictor } from '../../src/server/services/etaPredictor.ts';
import { openScanCacheDb } from '../../src/server/services/scanCacheDb.ts';

describe('server/etaPredictor', () => {
  it('resolves explicit SERVER_ID or deterministic hw fingerprint', () => {
    expect(new EtaPredictor({ serverId: '  nas-main  ' }).hostKey).toBe('env:nas-main');
    const hw1 = new EtaPredictor({}).hostKey;
    const hw2 = new EtaPredictor({ serverId: '   ' }).hostKey;
    expect(hw1).toMatch(/^hw:[a-f0-9]{16}$/);
    expect(hw1).toBe(hw2);
  });

  it('persists eta_samples in ScanCacheDb with host isolation and max-per-key pruning', async () => {
    const db = await openScanCacheDb('', ':memory:');
    try {
      const now = 1_700_000_000_000;
      db.recordEtaSamplesBatch(
        [
          {
            hostKey: 'env:nas',
            workType: 'loudnorm_p1',
            profile: 'stereo',
            throughput: 1.2,
            workUnits: 120,
            durationMs: 100_000,
            createdAt: now
          },
          {
            hostKey: 'env:nas',
            workType: 'loudnorm_p1',
            profile: 'stereo',
            throughput: 1.4,
            workUnits: 140,
            durationMs: 100_000,
            createdAt: now
          },
          {
            hostKey: 'env:nas',
            workType: 'loudnorm_p1',
            profile: 'stereo',
            throughput: 1.6,
            workUnits: 160,
            durationMs: 100_000,
            createdAt: now
          },
          {
            hostKey: 'env:win-dev',
            workType: 'loudnorm_p1',
            profile: 'stereo',
            throughput: 15,
            workUnits: 150,
            durationMs: 10_000,
            createdAt: now
          },
          // Invalid sample rejected silently
          {
            hostKey: 'env:nas',
            workType: 'loudnorm_p1',
            profile: 'stereo',
            throughput: 0,
            workUnits: 10,
            durationMs: 10,
            createdAt: now
          }
        ],
        2,
        10_000,
        now
      );

      // Pruned to newest 2 for env:nas, and isolated from env:win-dev
      expect(db.getEtaSamples('env:nas', 'loudnorm_p1', 'stereo')).toEqual([1.6, 1.4]);
      expect(db.getEtaSamples('env:win-dev', 'loudnorm_p1', 'stereo')).toEqual([15]);

      // Orphan TTL prunes samples older than orphanTtlMs
      db.recordEtaSamplesBatch(
        [
          {
            hostKey: 'env:nas',
            workType: 'loudnorm_p1',
            profile: 'stereo',
            throughput: 2.0,
            workUnits: 100,
            durationMs: 50_000,
            createdAt: now + 20_000
          }
        ],
        10,
        5_000,
        now + 20_000
      );
      expect(db.getEtaSamples('env:nas', 'loudnorm_p1', 'stereo')).toEqual([2.0]);
      expect(db.getEtaSamples('env:win-dev', 'loudnorm_p1', 'stereo')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('tracks cold-start, warm live speed, in-flight deltas, skipTask, and batched flush', async () => {
    const db = await openScanCacheDb('', ':memory:');
    try {
      let clockMs = 1_000;
      const predictor = new EtaPredictor({
        db,
        serverId: 'nas-test',
        now: () => clockMs
      });

      predictor.initStageInventory('loudnorm_p1', [{ profile: 'stereo', units: 200 }], 1);
      predictor.initStageInventory('finalize_io', [{ profile: 'default', units: 1000 }], 1);
      expect(predictor.hasColdStartBuckets()).toBe(true);
      // Unified computeQueueEta projects cold-default ETA under 'calibrating'
      expect(predictor.getEstimate()).toMatchObject({
        etaState: 'calibrating',
        weightedFraction: 0
      });
      expect(predictor.getEstimate().etaSeconds).toBe(80);

      // Pending followup stage hides global numeric ETA while preserving slot simulation
      predictor.markStagePending('scan_probe');
      expect(predictor.getEstimate()).toMatchObject({
        etaSeconds: undefined,
        etaState: 'calibrating'
      });
      predictor.initStageInventory('scan_probe', [], 1);

      // Start task 1 (total 100s audio)
      predictor.setActiveStage('loudnorm_p1');
      predictor.startTask('t1', 'loudnorm_p1', 'stereo', 100, { trackCount: 1 });
      // Before warm-up (<5s outTime and <2s elapsed): stays calibrating
      clockMs += 1_000;
      predictor.recordTaskProgress('t1', 2, 10, 2);
      expect(predictor.getEstimate().etaState).toBe('calibrating');

      // After warm-up -> live blended ETA (remaining in loudnorm_p1: 200 - 20 = 180s at 2x => 90s)
      clockMs += 9_000;
      predictor.recordTaskProgress('t1', 20, 2, 20);
      expect(predictor.getEstimate()).toMatchObject({ etaSeconds: 90, etaState: 'live_blended' });

      // Concurrent startTask on a downstream stage must not overwrite activeWorkType
      predictor.startTask('m1', 'finalize_io', 'default', 1000);
      expect(predictor.getEstimate()).toMatchObject({ etaSeconds: 90, etaState: 'live_blended' });

      // Reconciling stage dynamically adjusts pending units
      predictor.reconcileStage('loudnorm_p1', [{ profile: 'stereo', units: 260, taskCount: 2 }], 1);
      expect(predictor.getEstimate()).toMatchObject({ etaSeconds: 120, etaState: 'live_blended' });
      predictor.reconcileStage('loudnorm_p1', [{ profile: 'stereo', units: 200, taskCount: 2 }], 1);

      // Complete task 1 at 50_000ms total -> rate = 100 / 50 = 2
      clockMs += 40_000;
      predictor.completeTask('t1');
      // Idempotent second call is ignored
      predictor.completeTask('t1');

      // Skip task 2 (100 units) without recording a sample
      predictor.startTask('t2', 'loudnorm_p1', 'stereo', 100, { trackCount: 1 });
      clockMs += 1_000;
      predictor.skipTask('t2');
      // Remaining in loudnorm_p1 is now 0; only finalize_io cold default remains (<50% or tiny)
      expect(predictor.getEstimate().weightedFraction).toBeCloseTo(1, 2);

      predictor.flush();
      expect(db.getEtaSamples('env:nas-test', 'loudnorm_p1', 'stereo')).toEqual([2]);
      expect(db.getEtaSamples('env:nas-test', 'finalize_io', 'default')).toEqual([]);
      expect(db.getAllEtaSamplesForHost('env:nas-test')).toEqual([
        { workType: 'loudnorm_p1', profile: 'stereo', samples: [2] }
      ]);

      // Also verify scanning simulation snapshot builds EtaStageId slots cleanly
      const scanSnap = predictor.getSimulationSnapshot('scanning', 1_700_000_000_000);
      expect(scanSnap.mode).toBe('scanning');
      expect(scanSnap.hostKey).toBe('env:nas-test');
      const stageIds = scanSnap.slots.flatMap((s) => s.items.map((it) => it.itemId));
      expect(stageIds).toContain(buildEtaStageId('finalize_io', 'default'));

      // New predictor on same DB reports loaded baseline counts
      const warmPredictor = new EtaPredictor({ db, serverId: 'nas-test' });
      warmPredictor.initStageInventory('loudnorm_p1', [{ profile: 'stereo', units: 100 }], 1);
      expect(warmPredictor.getBaselineSummary()).toEqual({
        hostKey: 'env:nas-test',
        coldStart: false,
        loadedBuckets: 1,
        totalBaselineSamples: 1
      });
    } finally {
      db.close();
    }
  });

  it('simulates full queue plans, multi-track step binding, retries, and snapshots', async () => {
    const db = await openScanCacheDb('', ':memory:');
    try {
      db.recordEtaSamplesBatch([
        {
          hostKey: 'env:sim-nas',
          workType: 'loudnorm_p1',
          profile: 'surround',
          throughput: 1,
          workUnits: 100,
          durationMs: 100_000
        },
        {
          hostKey: 'env:sim-nas',
          workType: 'remux_loudnorm',
          profile: 'surround',
          throughput: 2,
          workUnits: 200,
          durationMs: 100_000
        },
        {
          hostKey: 'env:sim-nas',
          workType: 'finalize_io',
          profile: 'default',
          throughput: 1000,
          workUnits: 10_000,
          durationMs: 10_000
        }
      ]);

      const item1 = asItemId('i1');
      const item2 = asItemId('i2');
      let nowMs = 10_000;
      const predictor = new EtaPredictor({ db, serverId: 'sim-nas', now: () => nowMs });
      predictor.initQueuePlan(
        [
          {
            itemId: item1,
            fileName: 'Ep1.mkv',
            steps: [
              {
                stepId: buildEtaStepId('p1', item1),
                workType: 'loudnorm_p1',
                profile: 'surround',
                totalUnits: 200,
                parallelTracks: 2
              },
              {
                stepId: buildEtaStepId('remux', item1),
                workType: 'remux_loudnorm',
                profile: 'surround',
                totalUnits: 200
              },
              {
                stepId: buildEtaStepId('finalize', item1),
                workType: 'finalize_io',
                profile: 'default',
                totalUnits: 5000
              }
            ]
          },
          {
            itemId: item2,
            fileName: 'Movie.mkv',
            steps: [
              {
                stepId: buildEtaStepId('remux', item2),
                workType: 'remux_peak_gain',
                profile: 'stereo',
                totalUnits: 300
              },
              {
                stepId: buildEtaStepId('finalize', item2),
                workType: 'finalize_io',
                profile: 'default',
                totalUnits: 5000
              }
            ]
          }
        ],
        2
      );

      const initialEst = predictor.getEstimate();
      expect(initialEst.etaState).toBe('estimated');
      expect(initialEst.etaSeconds).toBeGreaterThan(200);
      expect(initialEst.weightedFraction).toBe(0);

      const p1Attempt1 = buildEtaAttemptTaskId('p1', item1, 1, 0);
      predictor.startTask(
        p1Attempt1,
        'loudnorm_p1',
        'surround',
        100,
        { mediaDurationSec: 100, trackCount: 1 },
        { itemId: item1, stepId: buildEtaStepId('p1', item1), slot: 0 }
      );
      nowMs += 50_000;
      predictor.recordTaskProgress(p1Attempt1, 50, 1, 50);

      const snap = predictor.getSimulationSnapshot('processing', 1_700_000_000_000);
      expect(snap.mode).toBe('processing');
      expect(snap.workerCount).toBe(2);
      expect(snap.slots[0]?.items[0]?.status).toBe('active');
      expect(snap.etaState).toBe('live_blended');
      expect(snap.weightedFraction).toBeGreaterThan(0);

      predictor.completeTask(p1Attempt1);
      predictor.resetItemForRetry(item1);
      // After retry reset, Attempt 2 must re-bind slot, track in-flight progress, and progress through remux & finalize_io
      const p1Attempt2 = buildEtaAttemptTaskId('p1', item1, 2, 0);
      predictor.startTask(
        p1Attempt2,
        'loudnorm_p1',
        'surround',
        200,
        { mediaDurationSec: 200, trackCount: 1 },
        { itemId: item1, stepId: buildEtaStepId('p1', item1), slot: 1 }
      );
      predictor.recordTaskProgress(p1Attempt2, 100, 2, 100);
      const retrySnap = predictor.getSimulationSnapshot('processing', 1_700_000_010_000);
      expect(retrySnap.slots[1]?.items.some((item) => item.itemId === item1)).toBe(true);
      predictor.completeTask(p1Attempt2);

      const remuxAttempt2 = buildEtaAttemptTaskId('remux', item1, 2);
      predictor.startTask(
        remuxAttempt2,
        'remux_loudnorm',
        'surround',
        200,
        { mediaDurationSec: 200, trackCount: 1 },
        { itemId: item1, stepId: buildEtaStepId('remux', item1), slot: 1 }
      );
      predictor.recordTaskProgress(remuxAttempt2, 100, 2, 100);
      const remuxLiveSnap = predictor.getSimulationSnapshot('processing', 1_700_000_020_000);
      const item1RemuxStep = remuxLiveSnap.slots[1]?.items
        .find((it) => it.itemId === item1)
        ?.steps.find((st) => st.workType === 'remux_loudnorm');
      expect(item1RemuxStep?.completedUnits).toBe(100);
      predictor.completeTask(remuxAttempt2);

      const finalizeAttempt2 = buildEtaAttemptTaskId('finalize', item1, 2);
      predictor.startTask(
        finalizeAttempt2,
        'finalize_io',
        'default',
        5000,
        { itemSizeBytes: 5000 },
        { itemId: item1, stepId: buildEtaStepId('finalize', item1), slot: 1 }
      );
      predictor.recordTaskProgress(finalizeAttempt2, 2500);
      const finalizeLiveSnap = predictor.getSimulationSnapshot('processing', 1_700_000_025_000);
      const item1FinalizeStep = finalizeLiveSnap.slots[1]?.items
        .find((it) => it.itemId === item1)
        ?.steps.find((st) => st.workType === 'finalize_io');
      expect(item1FinalizeStep?.completedUnits).toBe(2500);

      // Skipping an item with active in-flight tasks drops its active units cleanly
      const remuxItem2 = buildEtaAttemptTaskId('remux', item2, 1);
      predictor.startTask(
        remuxItem2,
        'remux_peak_gain',
        'stereo',
        300,
        { mediaDurationSec: 300, trackCount: 1 },
        { itemId: item2, stepId: buildEtaStepId('remux', item2), slot: 0 }
      );
      predictor.recordTaskProgress(remuxItem2, 150, 2, 150);
      predictor.markItemSkipped(item2);
      predictor.markItemCompleted(item1);
      expect(predictor.getEstimate().etaSeconds).toBe(0);
    } finally {
      db.close();
    }
  });

  it('distributes mixed-profile active-stage slices across worker slots in stage simulation mode', async () => {
    const db = await openScanCacheDb('', ':memory:');
    try {
      const predictor = new EtaPredictor({ db, serverId: 'stage-slots' });
      predictor.initStageInventory(
        'volumedetect',
        [
          { profile: 'mono', units: 100, taskCount: 1 },
          { profile: 'stereo', units: 200, taskCount: 1 },
          { profile: 'surround', units: 300, taskCount: 1 }
        ],
        3
      );
      predictor.setActiveStage('volumedetect');
      predictor.startTask('vd:surround:1', 'volumedetect', 'surround', 300);

      const snap3 = predictor.getSimulationSnapshot('scanning', 1_700_000_030_000);
      expect(snap3.workerCount).toBe(3);
      expect(snap3.slots).toHaveLength(3);
      expect(snap3.slots.every((slot) => slot.items.length === 1)).toBe(true);
      expect(
        snap3.slots.every((slot) => slot.items.every((item) => item.status === 'active'))
      ).toBe(true);

      // When active slices exceed workerCount, only workerCount slots run 'active' items and overflow slices queue as 'pending'
      const predictor2 = new EtaPredictor({ db, serverId: 'stage-slots-overflow' });
      predictor2.initStageInventory(
        'volumedetect',
        [
          { profile: 'mono', units: 100, taskCount: 1 },
          { profile: 'stereo', units: 200, taskCount: 1 },
          { profile: 'surround', units: 300, taskCount: 1 }
        ],
        2
      );
      predictor2.setActiveStage('volumedetect');
      predictor2.startTask('vd:surround:1', 'volumedetect', 'surround', 300);

      const snap2 = predictor2.getSimulationSnapshot('scanning', 1_700_000_030_000);
      expect(snap2.workerCount).toBe(2);
      expect(snap2.slots).toHaveLength(2);
      const activeItems = snap2.slots.flatMap((slot) =>
        slot.items.filter((item) => item.status === 'active')
      );
      const pendingItems = snap2.slots.flatMap((slot) =>
        slot.items.filter((item) => item.status === 'pending')
      );
      expect(activeItems).toHaveLength(2);
      expect(pendingItems).toHaveLength(1);
      expect(snap2.slots.every((slot) => slot.items.length >= 1)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('restores bucket accounting cleanly on resetItemForRetry and clears unstarted steps on markItemSkipped', async () => {
    const db = await openScanCacheDb('', ':memory:');
    try {
      db.recordEtaSamplesBatch([
        {
          hostKey: 'env:retry-nas',
          workType: 'loudnorm_p1',
          profile: 'surround',
          throughput: 1,
          workUnits: 100,
          durationMs: 100_000
        },
        {
          hostKey: 'env:retry-nas',
          workType: 'remux_loudnorm',
          profile: 'surround',
          throughput: 1,
          workUnits: 100,
          durationMs: 100_000
        }
      ]);

      const item1 = asItemId('retry-1');
      const item2 = asItemId('skip-2');
      let nowMs = 1_000;
      const predictor = new EtaPredictor({ db, serverId: 'retry-nas', now: () => nowMs });
      predictor.initQueuePlan(
        [
          {
            itemId: item1,
            fileName: 'Ep1.mkv',
            steps: [
              {
                stepId: buildEtaStepId('p1', item1),
                workType: 'loudnorm_p1',
                profile: 'surround',
                totalUnits: 100
              },
              {
                stepId: buildEtaStepId('remux', item1),
                workType: 'remux_loudnorm',
                profile: 'surround',
                totalUnits: 100
              },
              {
                stepId: buildEtaStepId('finalize', item1),
                workType: 'finalize_io',
                profile: 'default',
                totalUnits: 5000
              }
            ]
          },
          {
            itemId: item2,
            fileName: 'Ep2.mkv',
            steps: [
              {
                stepId: buildEtaStepId('remux', item2),
                workType: 'remux_peak_gain',
                profile: 'stereo',
                totalUnits: 200
              },
              {
                stepId: buildEtaStepId('finalize', item2),
                workType: 'finalize_io',
                profile: 'default',
                totalUnits: 5000
              }
            ]
          }
        ],
        2
      );

      // Attempt 1: Pass 1 succeeds at 1x, Remux starts and fails -> skipTask -> resetItemForRetry
      const p1Attempt1 = buildEtaAttemptTaskId('p1', item1, 1, 0);
      predictor.startTask(
        p1Attempt1,
        'loudnorm_p1',
        'surround',
        100,
        { mediaDurationSec: 100, trackCount: 1 },
        { itemId: item1, stepId: buildEtaStepId('p1', item1), slot: 0 }
      );
      nowMs += 100_000;
      predictor.completeTask(p1Attempt1);

      const remuxAttempt1 = buildEtaAttemptTaskId('remux', item1, 1);
      predictor.startTask(
        remuxAttempt1,
        'remux_loudnorm',
        'surround',
        100,
        { mediaDurationSec: 100, trackCount: 1 },
        { itemId: item1, stepId: buildEtaStepId('remux', item1), slot: 0 }
      );
      nowMs += 5_000;
      predictor.skipTask(remuxAttempt1);
      predictor.resetItemForRetry(item1);

      // Attempt 2: Pass 1 liveRate becomes EMA(1, 3) = 1.6; at 50/100 units, observedFraction must be 0.5 (w = 0.35), NOT double-counted to 1.0 (w = 0.7)
      const p1Attempt2 = buildEtaAttemptTaskId('p1', item1, 2, 0);
      predictor.startTask(
        p1Attempt2,
        'loudnorm_p1',
        'surround',
        100,
        { mediaDurationSec: 100, trackCount: 1 },
        { itemId: item1, stepId: buildEtaStepId('p1', item1), slot: 1 }
      );
      nowMs += 10_000;
      predictor.recordTaskProgress(p1Attempt2, 50, 3, 50);
      const midP1Snap = predictor.getSimulationSnapshot('processing', 1_700_000_040_000);
      const p1Diag = midP1Snap.rates.find(
        (r) => r.workType === 'loudnorm_p1' && r.profile === 'surround'
      );
      expect(p1Diag?.effectiveRate).toBeCloseTo(1.21, 2);
      nowMs += 40_000;
      predictor.completeTask(p1Attempt2);

      // Attempt 2 Remux: bucket.totalUnits must be restored to 100 so 50 in-flight gives observedFraction = 0.5 (effectiveRate = 0.35 * 3 + 0.65 * 1 = 1.7)
      const remuxAttempt2 = buildEtaAttemptTaskId('remux', item1, 2);
      predictor.startTask(
        remuxAttempt2,
        'remux_loudnorm',
        'surround',
        100,
        { mediaDurationSec: 100, trackCount: 1 },
        { itemId: item1, stepId: buildEtaStepId('remux', item1), slot: 1 }
      );
      nowMs += 10_000;
      predictor.recordTaskProgress(remuxAttempt2, 50, 3, 50);
      const midRemuxSnap = predictor.getSimulationSnapshot('processing', 1_700_000_050_000);
      const remuxDiag = midRemuxSnap.rates.find(
        (r) => r.workType === 'remux_loudnorm' && r.profile === 'surround'
      );
      expect(remuxDiag?.effectiveRate).toBeCloseTo(1.7, 2);

      // Idempotent markItemSkipped decrements unstarted downstream steps cleanly without underflowing
      predictor.markItemSkipped(item2);
      predictor.markItemSkipped(item2);
      predictor.completeTask(remuxAttempt2);
      predictor.markItemCompleted(item1);
      expect(predictor.getEstimate().etaSeconds).toBe(0);
    } finally {
      db.close();
    }
  });
});
