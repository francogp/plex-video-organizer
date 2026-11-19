import { describe, expect, it } from 'vite-plus/test';

import { ETA_REMUX_LOUDNORM_FROM_P1_FACTOR } from '../../src/domain/constants.ts';
import {
  buildEtaBucketKey,
  buildEtaStepId,
  computeQueueEta,
  computeTrimmedMedian,
  convertFfmpegSpeedToRate,
  isFfmpegSpeedWarm,
  resolveChannelProfile,
  updateEmaRate,
  type EtaQueueItemState,
  type EtaRateEntry
} from '../../src/domain/eta.ts';
import { asItemId } from '../../src/domain/types.ts';

describe('domain/eta', () => {
  it('maps channel counts to finite profiles', () => {
    expect(resolveChannelProfile(undefined)).toBe('default');
    expect(resolveChannelProfile(0)).toBe('default');
    expect(resolveChannelProfile(1)).toBe('mono');
    expect(resolveChannelProfile(2)).toBe('stereo');
    expect(resolveChannelProfile(6)).toBe('surround');
    expect(resolveChannelProfile(8)).toBe('surround');
  });

  it('computes trimmed median with outlier trimming for >= 10 samples', () => {
    expect(computeTrimmedMedian([])).toBeUndefined();
    expect(computeTrimmedMedian([0, -1, Number.NaN])).toBeUndefined();
    expect(computeTrimmedMedian([10, 30, 20])).toBe(20);
    expect(computeTrimmedMedian([10, 20, 30, 40])).toBe(25);

    const withOutliers = [0.01, 10, 11, 12, 13, 14, 15, 16, 17, 9999];
    expect(computeTrimmedMedian(withOutliers)).toBe(13.5);
  });

  it('updates EMA symmetrically clamped against 3x spikes', () => {
    expect(updateEmaRate(undefined, 0)).toBeUndefined();
    expect(updateEmaRate(undefined, 2)).toBe(2);
    // Upward spike clamped to 2 * 3 = 6 -> 0.3 * 6 + 0.7 * 2 = 3.2
    expect(updateEmaRate(2, 100)).toBeCloseTo(3.2, 5);
    // Downward spike clamped to 2 / 3 -> 0.3 * (2/3) + 0.7 * 2 = 1.6
    expect(updateEmaRate(2, 0.01)).toBeCloseTo(1.6, 5);
  });

  it('blends baseline and live EMA rates with max 0.7 live weight via computeQueueEta', () => {
    // completed=500 / total=1000 => observed=0.5 => w=0.35 => blended = 0.35*2 + 0.65*4 = 3.3
    // remaining=500 => ETA = round(500 / 3.3) = 152s
    const itemId = asItemId('blend-1');
    const res = computeQueueEta({
      items: [
        {
          itemId,
          fileName: 'Blend.mkv',
          activeSlot: 0,
          completed: false,
          skipped: false,
          steps: [
            {
              stepId: buildEtaStepId('p1', itemId),
              workType: 'loudnorm_p1',
              profile: 'stereo',
              totalUnits: 1000,
              completedUnits: 500,
              inFlightUnits: 0,
              parallelTracks: 1
            }
          ]
        }
      ],
      workerCount: 1,
      rateIndex: new Map([
        [
          buildEtaBucketKey('loudnorm_p1', 'stereo'),
          {
            workType: 'loudnorm_p1',
            profile: 'stereo',
            baselineRate: 4,
            baselineSampleCount: 10,
            liveRate: 2,
            liveSamples: 1,
            observedFraction: 0.5
          }
        ]
      ])
    });
    expect(res.etaState).toBe('live_blended');
    expect(res.etaSeconds).toBe(152);
    expect(res.weightedFraction).toBeCloseTo(0.5, 4);
  });

  it('checks ffmpeg speed warm-up guard and converts speed to physical rates', () => {
    expect(isFfmpegSpeedWarm(undefined, 10, 10)).toBe(false);
    expect(isFfmpegSpeedWarm(2, undefined, 10)).toBe(false);
    expect(isFfmpegSpeedWarm(2, 2, 1)).toBe(false);
    expect(isFfmpegSpeedWarm(2, 5, 1)).toBe(true);
    expect(isFfmpegSpeedWarm(2, 1, 2)).toBe(true);

    expect(convertFfmpegSpeedToRate('loudnorm_p1', 1.5, { trackCount: 3 })).toBe(1.5);
    expect(convertFfmpegSpeedToRate('remux_loudnorm', 1.5, { trackCount: 3 })).toBe(4.5);
    expect(
      convertFfmpegSpeedToRate('remux_copy', 2, { mediaDurationSec: 100, itemSizeBytes: 5000 })
    ).toBe(100);
    expect(convertFfmpegSpeedToRate('remux_copy', 2, {})).toBeUndefined();
  });

  it('computes calibrating, estimated, and live_blended states cleanly in unified computeQueueEta', () => {
    const scanId = asItemId('scan-1');
    // 1. Followup stage pending forces calibrating with undefined etaSeconds while keeping slot breakdown
    const pendingRes = computeQueueEta({
      items: [
        {
          itemId: scanId,
          fileName: 'scan_probe (default)',
          activeSlot: 0,
          completed: false,
          skipped: false,
          steps: [
            {
              stepId: buildEtaStepId('p1', scanId),
              workType: 'scan_probe',
              profile: 'default',
              totalUnits: 10,
              completedUnits: 2,
              inFlightUnits: 0,
              parallelTracks: 1
            }
          ]
        }
      ],
      workerCount: 1,
      rateIndex: new Map([
        [
          buildEtaBucketKey('scan_probe', 'default'),
          {
            workType: 'scan_probe',
            profile: 'default',
            baselineRate: 2,
            baselineSampleCount: 5,
            liveSamples: 0,
            observedFraction: 0.2
          }
        ]
      ]),
      pendingFollowupStages: 1
    });
    expect(pendingRes.etaSeconds).toBeUndefined();
    expect(pendingRes.etaState).toBe('calibrating');
    expect(pendingRes.slots[0]?.items).toHaveLength(1);
    expect(pendingRes.weightedFraction).toBeCloseTo(0.2, 4);

    // 2. Cold fallback >= 50% of remaining work marks calibrating while still projecting hierarchical ETA
    const coldId = asItemId('cold-1');
    const coldRes = computeQueueEta({
      items: [
        {
          itemId: coldId,
          fileName: 'Cold.mkv',
          completed: false,
          skipped: false,
          steps: [
            {
              stepId: buildEtaStepId('p1', coldId),
              workType: 'loudnorm_p1',
              profile: 'surround',
              totalUnits: 400,
              completedUnits: 0,
              inFlightUnits: 0,
              parallelTracks: 1
            }
          ]
        }
      ],
      workerCount: 1,
      rateIndex: new Map()
    });
    expect(coldRes.etaState).toBe('calibrating');
    expect(coldRes.etaSeconds).toBe(400);

    // 3. All steps backed by historical baselines and no live samples -> estimated across slots
    const ep1 = asItemId('est-1');
    const ep2 = asItemId('est-2');
    const estRes = computeQueueEta({
      items: [ep1, ep2].map((id, idx) => ({
        itemId: id,
        fileName: `Ep${String(idx)}.mkv`,
        activeSlot: idx,
        completed: false,
        skipped: false,
        steps: [
          {
            stepId: buildEtaStepId('p1', id),
            workType: 'loudnorm_p1' as const,
            profile: 'stereo' as const,
            totalUnits: 200,
            completedUnits: 0,
            inFlightUnits: 0,
            parallelTracks: 1
          },
          {
            stepId: buildEtaStepId('finalize', id),
            workType: 'finalize_io' as const,
            profile: 'default' as const,
            totalUnits: 500,
            completedUnits: 0,
            inFlightUnits: 0,
            parallelTracks: 1
          }
        ]
      })),
      workerCount: 2,
      rateIndex: new Map([
        [
          buildEtaBucketKey('loudnorm_p1', 'stereo'),
          {
            workType: 'loudnorm_p1',
            profile: 'stereo',
            baselineRate: 2,
            baselineSampleCount: 10,
            liveSamples: 0,
            observedFraction: 0
          }
        ],
        [
          buildEtaBucketKey('finalize_io', 'default'),
          {
            workType: 'finalize_io',
            profile: 'default',
            baselineRate: 100,
            baselineSampleCount: 10,
            liveSamples: 0,
            observedFraction: 0
          }
        ]
      ])
    });
    expect(estRes.etaState).toBe('estimated');
    expect(estRes.etaSeconds).toBe(105);

    // 4. Live samples present -> live_blended subtracting inFlightUnits across parallel slots
    const liveA = asItemId('live-1');
    const liveB = asItemId('live-2');
    const liveRes = computeQueueEta({
      items: [liveA, liveB].map((id, idx) => ({
        itemId: id,
        fileName: `Live${String(idx)}.mkv`,
        activeSlot: idx,
        completed: false,
        skipped: false,
        steps: [
          {
            stepId: buildEtaStepId('p1', id),
            workType: 'loudnorm_p1' as const,
            profile: 'stereo' as const,
            totalUnits: 250,
            completedUnits: 50,
            inFlightUnits: 50,
            parallelTracks: 1
          }
        ]
      })),
      workerCount: 2,
      rateIndex: new Map([
        [
          buildEtaBucketKey('loudnorm_p1', 'stereo'),
          {
            workType: 'loudnorm_p1',
            profile: 'stereo',
            baselineRate: 1,
            baselineSampleCount: 5,
            liveRate: 1,
            liveSamples: 4,
            observedFraction: 0.4
          }
        ]
      ])
    });
    expect(liveRes.etaState).toBe('live_blended');
    expect(liveRes.etaSeconds).toBe(150);
  });

  it('resolves hierarchical rates via exact, sibling profile, related workType, and cold defaults', () => {
    const index = new Map<ReturnType<typeof buildEtaBucketKey>, EtaRateEntry>([
      [
        buildEtaBucketKey('loudnorm_p1', 'surround'),
        {
          workType: 'loudnorm_p1',
          profile: 'surround',
          baselineRate: 1,
          baselineSampleCount: 10,
          liveSamples: 0,
          observedFraction: 0
        }
      ],
      [
        buildEtaBucketKey('remux_loudnorm', 'surround'),
        {
          workType: 'remux_loudnorm',
          profile: 'surround',
          baselineRate: 2,
          baselineSampleCount: 10,
          liveRate: 1.5,
          liveSamples: 3,
          observedFraction: 0.5
        }
      ]
    ]);

    const probeHierarchy = (
      workType: Parameters<typeof buildEtaBucketKey>[0],
      profile: Parameters<typeof buildEtaBucketKey>[1]
    ) => {
      const id = asItemId(`hier-${workType}-${profile}`);
      return computeQueueEta({
        items: [
          {
            itemId: id,
            fileName: `${workType}.mkv`,
            completed: false,
            skipped: false,
            steps: [
              {
                stepId: buildEtaStepId('p1', id),
                workType,
                profile,
                totalUnits: 100,
                completedUnits: 0,
                inFlightUnits: 0,
                parallelTracks: 1
              }
            ]
          }
        ],
        workerCount: 1,
        rateIndex: index
      }).rates[0];
    };

    const exact = probeHierarchy('loudnorm_p1', 'surround');
    expect(exact?.source).toBe('baseline');
    expect(exact?.effectiveRate).toBe(1);

    const sibling = probeHierarchy('loudnorm_p1', 'stereo');
    expect(sibling?.source).toBe('sibling_profile');
    expect(sibling?.effectiveRate).toBe(2.5);

    const relatedPeak = probeHierarchy('remux_peak_gain', 'stereo');
    expect(relatedPeak?.source).toBe('related_work_type');
    expect(relatedPeak?.effectiveRate).toBeGreaterThan(2);

    const cold = probeHierarchy('remux_copy', 'default');
    expect(cold?.source).toBe('cold_default');
    expect(cold?.effectiveRate).toBeGreaterThan(0);
  });

  it('sums all remaining steps across slots even when a trailing item uses fallback rates (NAS regression)', () => {
    const bytesPerGb = 1024 ** 3;
    const nasRates = new Map<ReturnType<typeof buildEtaBucketKey>, EtaRateEntry>([
      [
        buildEtaBucketKey('loudnorm_p1', 'surround'),
        {
          workType: 'loudnorm_p1',
          profile: 'surround',
          baselineRate: 0.8835,
          baselineSampleCount: 23,
          liveRate: 0.65,
          liveSamples: 20,
          observedFraction: 0.77
        }
      ],
      [
        buildEtaBucketKey('remux_loudnorm', 'surround'),
        {
          workType: 'remux_loudnorm',
          profile: 'surround',
          baselineRate: 1.5721,
          baselineSampleCount: 23,
          liveRate: 1.4,
          liveSamples: 15,
          observedFraction: 0.72
        }
      ],
      [
        buildEtaBucketKey('finalize_io', 'default'),
        {
          workType: 'finalize_io',
          profile: 'default',
          baselineRate: 39 * 1024 * 1024,
          baselineSampleCount: 10,
          liveSamples: 0,
          observedFraction: 0.77
        }
      ]
    ]);

    const items: EtaQueueItemState[] = [];
    for (let i = 1; i <= 24; i += 1) {
      const tracks = i > 20 ? 2 : 1;
      const doneId = asItemId(`done-${String(i)}`);
      items.push({
        itemId: doneId,
        fileName: `Foundation Ep ${String(i)}`,
        completed: true,
        skipped: false,
        steps: [
          {
            stepId: buildEtaStepId('p1', doneId),
            workType: 'loudnorm_p1',
            profile: 'surround',
            totalUnits: 3100 * tracks,
            completedUnits: 3100 * tracks,
            inFlightUnits: 0,
            parallelTracks: tracks
          },
          {
            stepId: buildEtaStepId('remux', doneId),
            workType: 'remux_loudnorm',
            profile: 'surround',
            totalUnits: 3100 * tracks,
            completedUnits: 3100 * tracks,
            inFlightUnits: 0,
            parallelTracks: 1
          },
          {
            stepId: buildEtaStepId('finalize', doneId),
            workType: 'finalize_io',
            profile: 'default',
            totalUnits: 9.5 * bytesPerGb,
            completedUnits: 9.5 * bytesPerGb,
            inFlightUnits: 0,
            parallelTracks: 1
          }
        ]
      });
    }

    const remainingSpecs = [
      { id: '25', slot: 0, dur: 2794, gb: 8.7, p1Frac: 0.71 },
      { id: '26', slot: 1, dur: 2666, gb: 8.2, p1Frac: 0.44 },
      { id: '27', slot: undefined, dur: 3576, gb: 11.1, p1Frac: 0 },
      { id: '28', slot: undefined, dur: 2804, gb: 8.7, p1Frac: 0 },
      { id: '29', slot: undefined, dur: 2797, gb: 8.6, p1Frac: 0 },
      { id: '30', slot: undefined, dur: 3077, gb: 9.6, p1Frac: 0 }
    ];
    for (const sp of remainingSpecs) {
      const p1Total = sp.dur * 2;
      const epId = asItemId(`s3-${sp.id}`);
      items.push({
        itemId: epId,
        fileName: `Foundation S03E${sp.id}`,
        activeSlot: sp.slot,
        completed: false,
        skipped: false,
        steps: [
          {
            stepId: buildEtaStepId('p1', epId),
            workType: 'loudnorm_p1',
            profile: 'surround',
            totalUnits: p1Total,
            completedUnits: 0,
            inFlightUnits: p1Total * sp.p1Frac,
            parallelTracks: 2
          },
          {
            stepId: buildEtaStepId('remux', epId),
            workType: 'remux_loudnorm',
            profile: 'surround',
            totalUnits: p1Total,
            completedUnits: 0,
            inFlightUnits: 0,
            parallelTracks: 1
          },
          {
            stepId: buildEtaStepId('finalize', epId),
            workType: 'finalize_io',
            profile: 'default',
            totalUnits: sp.gb * bytesPerGb,
            completedUnits: 0,
            inFlightUnits: 0,
            parallelTracks: 1
          }
        ]
      });
    }

    const frameId = asItemId('frame-31');
    items.push({
      itemId: frameId,
      fileName: 'The Frame (2014)',
      completed: false,
      skipped: false,
      steps: [
        {
          stepId: buildEtaStepId('remux', frameId),
          workType: 'remux_peak_gain',
          profile: 'stereo',
          totalUnits: 7617,
          completedUnits: 0,
          inFlightUnits: 0,
          parallelTracks: 1
        },
        {
          stepId: buildEtaStepId('finalize', frameId),
          workType: 'finalize_io',
          profile: 'default',
          totalUnits: 3.8 * bytesPerGb,
          completedUnits: 0,
          inFlightUnits: 0,
          parallelTracks: 1
        }
      ]
    });

    const result = computeQueueEta({ items, workerCount: 2, rateIndex: nasRates });
    // Should include Pass 1 + Pass 2 + Peak (via related_work_type) + Finalize I/O (~5-7h), never calibrating!
    expect(result.etaState).toBe('live_blended');
    expect(result.etaSeconds).toBeGreaterThan(4.5 * 3600);
    expect(result.etaSeconds).toBeLessThan(7.5 * 3600);
    expect(result.weightedFraction).toBeGreaterThan(0.7);
    expect(result.weightedFraction).toBeLessThan(0.8);
    expect(result.slots).toHaveLength(2);
    const frameItem = result.slots.flatMap((s) => s.items).find((i) => i.itemId === frameId);
    expect(frameItem?.steps[0]?.rateSource).toBe('related_work_type');
  });

  it('handles empty queue cleanly, relates remux_loudnorm <-> loudnorm_p1 symmetrically, and keeps bucket diagnostics unscaled', () => {
    const empty = computeQueueEta({ items: [], workerCount: 2, rateIndex: new Map() });
    expect(empty.etaSeconds).toBeUndefined();
    expect(empty.etaState).toBe('calibrating');
    expect(empty.weightedFraction).toBe(0);
    expect(empty.slots.every((slot) => slot.items.length === 0 && slot.totalSeconds === 0)).toBe(
      true
    );

    const p1Only = new Map<ReturnType<typeof buildEtaBucketKey>, EtaRateEntry>([
      [
        buildEtaBucketKey('loudnorm_p1', 'surround'),
        {
          workType: 'loudnorm_p1',
          profile: 'surround',
          baselineRate: 1.0,
          baselineSampleCount: 10,
          liveSamples: 0,
          observedFraction: 0
        }
      ]
    ]);
    const remuxProbeId = asItemId('sym-remux');
    const relatedRemux = computeQueueEta({
      items: [
        {
          itemId: remuxProbeId,
          fileName: 'RemuxSym.mkv',
          completed: false,
          skipped: false,
          steps: [
            {
              stepId: buildEtaStepId('remux', remuxProbeId),
              workType: 'remux_loudnorm',
              profile: 'surround',
              totalUnits: 100,
              completedUnits: 0,
              inFlightUnits: 0,
              parallelTracks: 1
            }
          ]
        }
      ],
      workerCount: 1,
      rateIndex: p1Only
    }).rates[0];
    expect(relatedRemux?.source).toBe('related_work_type');
    expect(relatedRemux?.effectiveRate).toBeCloseTo(ETA_REMUX_LOUDNORM_FROM_P1_FACTOR, 4);

    const remuxOnly = new Map<ReturnType<typeof buildEtaBucketKey>, EtaRateEntry>([
      [
        buildEtaBucketKey('remux_loudnorm', 'surround'),
        {
          workType: 'remux_loudnorm',
          profile: 'surround',
          baselineRate: ETA_REMUX_LOUDNORM_FROM_P1_FACTOR,
          baselineSampleCount: 10,
          liveSamples: 0,
          observedFraction: 0
        }
      ]
    ]);
    const p1ProbeId = asItemId('sym-p1');
    const relatedP1 = computeQueueEta({
      items: [
        {
          itemId: p1ProbeId,
          fileName: 'P1Sym.mkv',
          completed: false,
          skipped: false,
          steps: [
            {
              stepId: buildEtaStepId('p1', p1ProbeId),
              workType: 'loudnorm_p1',
              profile: 'surround',
              totalUnits: 100,
              completedUnits: 0,
              inFlightUnits: 0,
              parallelTracks: 1
            }
          ]
        }
      ],
      workerCount: 1,
      rateIndex: remuxOnly
    }).rates[0];
    expect(relatedP1?.source).toBe('related_work_type');
    expect(relatedP1?.effectiveRate).toBeCloseTo(1.0, 4);

    const multiTrackId = asItemId('multi-track');
    const sim = computeQueueEta({
      items: [
        {
          itemId: multiTrackId,
          fileName: 'Multi.mkv',
          completed: false,
          skipped: false,
          steps: [
            {
              stepId: buildEtaStepId('p1', multiTrackId),
              workType: 'loudnorm_p1',
              profile: 'surround',
              totalUnits: 1000,
              completedUnits: 0,
              inFlightUnits: 0,
              parallelTracks: 2
            }
          ]
        }
      ],
      workerCount: 1,
      rateIndex: new Map([
        [
          buildEtaBucketKey('loudnorm_p1', 'surround'),
          {
            workType: 'loudnorm_p1',
            profile: 'surround',
            baselineRate: 1,
            baselineSampleCount: 10,
            liveSamples: 0,
            observedFraction: 0
          }
        ]
      ])
    });
    expect(sim.rates[0]?.effectiveRate).toBe(1);
    expect(sim.slots[0]?.items[0]?.steps[0]?.rateUsed).toBeCloseTo(1.7, 4);
  });
});
