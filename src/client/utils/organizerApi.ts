import { ensureValidAudioTrackSelection } from '../../domain/trackSelection.ts';
import type {
  OrganizerStatePayload,
  SseLogEvent,
  SseProgressEvent,
  TrackSelection
} from '../../domain/types.ts';

export interface ApiErrorEnvelope {
  readonly error?: string;
  readonly message?: string;
  readonly state?: OrganizerStatePayload;
}

export async function executeJsonFetch<T>(
  clientId: string,
  url: string,
  init: RequestInit = {}
): Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly data: T & ApiErrorEnvelope;
}> {
  const headers = new Headers(init.headers);
  headers.set('X-Client-Id', clientId);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const safeUrl = new URL(
    url,
    typeof globalThis.location !== 'undefined' ? globalThis.location.origin : 'http://localhost'
  ).toString();
  const res = await fetch(safeUrl, { ...init, headers });
  const data = (await res.json()) as T & ApiErrorEnvelope;
  return { ok: res.ok, status: res.status, data };
}

export interface OrganizerSseCallbacks {
  readonly onOpen: () => void;
  readonly onError: () => void;
  readonly onState: (payload: OrganizerStatePayload) => void;
  readonly onProgress: (progress: SseProgressEvent) => void;
  readonly onLog: (log: SseLogEvent) => void;
}

export interface OrganizerSseConnection {
  close(): void;
}

export function createOrganizerSseSource(
  callbacks: OrganizerSseCallbacks
): OrganizerSseConnection | null {
  if (typeof EventSource === 'undefined') {
    return null;
  }
  const source = new EventSource('/api/events');
  const onOpen = (): void => {
    callbacks.onOpen();
  };
  const onError = (): void => {
    callbacks.onError();
  };
  const onState = (evt: Event): void => {
    const payload = JSON.parse((evt as MessageEvent<string>).data) as OrganizerStatePayload;
    callbacks.onState(payload);
  };
  const onProgress = (evt: Event): void => {
    const prog = JSON.parse((evt as MessageEvent<string>).data) as SseProgressEvent;
    callbacks.onProgress(prog);
  };
  const onLog = (evt: Event): void => {
    const log = JSON.parse((evt as MessageEvent<string>).data) as SseLogEvent;
    callbacks.onLog(log);
  };
  source.addEventListener('open', onOpen);
  source.addEventListener('error', onError);
  source.addEventListener('state', onState);
  source.addEventListener('progress', onProgress);
  source.addEventListener('log', onLog);
  return {
    close(): void {
      if (typeof source.removeEventListener === 'function') {
        source.removeEventListener('open', onOpen);
        source.removeEventListener('error', onError);
        source.removeEventListener('state', onState);
        source.removeEventListener('progress', onProgress);
        source.removeEventListener('log', onLog);
      }
      source.close();
    }
  };
}

export function buildMergedTrackSelection(
  target: TrackSelection,
  template: TrackSelection
): TrackSelection {
  return {
    ...target,
    subtitleMergeMode: template.subtitleMergeMode,
    needsUserPrompt: false,
    audioFilterCustomized: true,
    audioTracks: ensureValidAudioTrackSelection(
      target.audioTracks.map((t, idx) => {
        const src = template.audioTracks[idx];
        return {
          ...t,
          include: src?.include ?? t.include,
          language: src?.language ?? t.language,
          isDefault: src?.isDefault ?? t.isDefault
        };
      })
    )
  };
}
