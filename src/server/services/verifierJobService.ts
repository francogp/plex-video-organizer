import type {
  ConflictDecision,
  LogLevel,
  MetadataLanguageCode,
  VerifierEntry,
  VerifierEntryId,
  VerifierState
} from '../../domain/types.ts';
import type { AppConfig } from '../config.ts';
import { applyVerifierRenames, scanLibrariesForCompliance } from './libraryVerifierService.ts';

export async function executeVerifierScan(options: {
  readonly config: AppConfig;
  readonly preferredLanguages: readonly MetadataLanguageCode[];
  readonly recalculateTags: boolean;
  readonly onLog: (level: LogLevel, message: string) => void;
  readonly onProgress: (progress: NonNullable<VerifierState['progress']>) => void;
  readonly onComplete: (
    nextState: VerifierState,
    issueCount: number,
    roots: number,
    files: number
  ) => void;
  readonly onError: (msg: string) => void;
}): Promise<void> {
  try {
    const result = await scanLibrariesForCompliance(
      options.config,
      options.onLog,
      undefined,
      options.onProgress,
      options.preferredLanguages,
      options.recalculateTags
    );
    options.onComplete(
      {
        scanning: false,
        fixing: false,
        progress: null,
        summary: result.summary,
        entries: result.entries,
        lastFixResult: null
      },
      result.summary.issueCount,
      result.summary.totalRootsAnalyzed,
      result.summary.totalFilesAnalyzed
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    options.onError(msg);
  }
}

export async function executeVerifierFix(options: {
  readonly config: AppConfig;
  readonly preferredLanguages: readonly MetadataLanguageCode[];
  readonly selected: readonly VerifierEntry[];
  readonly conflictResolutions?: Readonly<Partial<Record<VerifierEntryId, ConflictDecision>>>;
  readonly onLog: (level: LogLevel, message: string) => void;
  readonly onProgress: (progress: NonNullable<VerifierState['progress']>) => void;
  readonly onComplete: (nextState: VerifierState) => void;
  readonly onError: (msg: string) => void;
}): Promise<void> {
  try {
    const fixResult = await applyVerifierRenames(
      options.config,
      options.selected,
      options.onLog,
      options.onProgress,
      options.conflictResolutions
    );
    options.onLog(
      fixResult.failures.length > 0 ? 'warn' : 'info',
      `Verifier fix finished: ${String(fixResult.fixedEntries)}/${String(options.selected.length)} fixed (${String(fixResult.renamedSteps)} rename steps).`
    );
    const rescan = await scanLibrariesForCompliance(
      options.config,
      options.onLog,
      undefined,
      (progress): void => {
        options.onProgress({
          ...progress,
          stageLabel: `Re-verifying · ${progress.stageLabel}`
        });
      },
      options.preferredLanguages
    );
    options.onComplete({
      scanning: false,
      fixing: false,
      progress: null,
      summary: rescan.summary,
      entries: rescan.entries,
      lastFixResult: {
        renamedFiles: fixResult.renamedFiles,
        renamedDirs: fixResult.renamedDirs,
        errors: fixResult.failures.map((f): string => `${f.currentRootName}: ${f.error}`)
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    options.onError(msg);
  }
}
