/**
 * Ensures at least one audio track remains included and exactly one included track is marked default.
 */
export function ensureValidAudioTrackSelection<
  T extends { readonly include: boolean; readonly isDefault: boolean }
>(tracks: readonly T[]): T[] {
  if (tracks.length === 0) {
    return [];
  }

  let targetIdx = tracks.findIndex((track) => track.include && track.isDefault);
  if (targetIdx < 0) {
    targetIdx = tracks.findIndex((track) => track.include);
  }
  const forceIncludeFirst = targetIdx < 0;
  if (forceIncludeFirst) {
    targetIdx = 0;
  }

  return tracks.map((track, idx) => ({
    ...track,
    include: forceIncludeFirst && idx === 0 ? true : track.include,
    isDefault: idx === targetIdx
  }));
}
