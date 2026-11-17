import { describe, expect, it } from 'vite-plus/test';

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
      predictor.initStageInventory('move_exdev', [{ profile: 'default', units: 1000 }], 1);
      expect(predictor.hasColdStartBuckets()).toBe(true);
      expect(predictor.getEstimate()).toEqual({ etaSeconds: undefined, etaState: 'calibrating' });

      // Start task 1 (total 100s audio)
      predictor.setActiveStage('loudnorm_p1');
      predictor.startTask('t1', 'loudnorm_p1', 'stereo', 100, { trackCount: 1 });
      // Before warm-up (<5s outTime and <2s elapsed)
      clockMs += 1_000;
      predictor.recordTaskProgress('t1', 2, 10, 2);
      expect(predictor.getEstimate()).toEqual({ etaSeconds: undefined, etaState: 'calibrating' });

      // After warm-up -> stage-scoped calibrating ETA (remaining in loudnorm_p1: 200 - 20 = 180s at 2x => 90s)
      clockMs += 9_000;
      predictor.recordTaskProgress('t1', 20, 2, 20);
      expect(predictor.getEstimate()).toEqual({ etaSeconds: 90, etaState: 'calibrating' });

      // Concurrent startTask on a downstream stage must not overwrite activeWorkType
      predictor.startTask('m1', 'move_exdev', 'default', 1000);
      expect(predictor.getEstimate()).toEqual({ etaSeconds: 90, etaState: 'calibrating' });

      // Reconciling stage dynamically adjusts pending units
      predictor.reconcileStage('loudnorm_p1', [{ profile: 'stereo', units: 260, taskCount: 2 }], 1);
      expect(predictor.getEstimate()).toEqual({ etaSeconds: 120, etaState: 'calibrating' });
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
      // Remaining in loudnorm_p1 is now 0!
      expect(predictor.getEstimate()).toEqual({ etaSeconds: undefined, etaState: 'calibrating' });

      predictor.flush();
      expect(db.getEtaSamples('env:nas-test', 'loudnorm_p1', 'stereo')).toEqual([2]);
      expect(db.getEtaSamples('env:nas-test', 'move_exdev', 'default')).toEqual([]);

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
});
