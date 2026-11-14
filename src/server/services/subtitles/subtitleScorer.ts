import type { SubtitleCandidate, SubtitleVariant } from '../../../domain/types.ts';

const SCORE_HASH_MATCH = 1000;
const SCORE_RELEASE_TOKEN = 40;
const SCORE_MAX_RELEASE_BONUS = 240;
const SCORE_LATAM_VARIANT = 80;
const SCORE_NEUTRAL_VARIANT = 60;
const SCORE_SPAIN_VARIANT = 30;
const SCORE_DOWNLOAD_LOG_WEIGHT = 10;
const SCORE_MAX_DOWNLOAD_BONUS = 60;

const LATAM_REGEX = /\b(?:latino|latam|latin[\s._-]*america|es-419|la|l\.a\.?)\b/i;
const SPAIN_REGEX = /\b(?:castellano|espa[nñ]a|spain|ib[eé]rico|es-es)\b/i;

/** Infers Spanish subtitle regional variant from release title or language hint. */
export function detectSpanishVariant(text: string): SubtitleVariant {
  if (LATAM_REGEX.test(text)) {
    return 'latam';
  }
  if (SPAIN_REGEX.test(text)) {
    return 'spain';
  }
  return 'neutral';
}

function tokenizeRelease(raw: string): Set<string> {
  return new Set(
    raw
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 2)
  );
}

/** Computes a deterministic quality score for a Spanish subtitle candidate. */
function scoreSubtitleCandidate(
  candidate: Omit<SubtitleCandidate, 'score'>,
  sourceFileName: string
): number {
  let score = 0;
  if (candidate.hashMatch) {
    score += SCORE_HASH_MATCH;
  }

  const sourceTokens = tokenizeRelease(sourceFileName);
  const releaseTokens = tokenizeRelease(candidate.releaseName);
  let overlapCount = 0;
  for (const token of releaseTokens) {
    if (sourceTokens.has(token)) {
      overlapCount += 1;
    }
  }
  score += Math.min(SCORE_MAX_RELEASE_BONUS, overlapCount * SCORE_RELEASE_TOKEN);

  if (candidate.variant === 'latam') {
    score += SCORE_LATAM_VARIANT;
  } else if (candidate.variant === 'neutral') {
    score += SCORE_NEUTRAL_VARIANT;
  } else {
    score += SCORE_SPAIN_VARIANT;
  }

  if (candidate.downloadCount && candidate.downloadCount > 0) {
    score += Math.min(
      SCORE_MAX_DOWNLOAD_BONUS,
      Math.round(Math.log10(candidate.downloadCount + 1) * SCORE_DOWNLOAD_LOG_WEIGHT)
    );
  }

  return score;
}

/** Scores and sorts subtitle candidates in descending order of relevance. */
export function rankSubtitleCandidates(
  candidates: readonly Omit<SubtitleCandidate, 'score'>[],
  sourceFileName: string
): readonly SubtitleCandidate[] {
  const seenUrls = new Set<string>();
  const scored: SubtitleCandidate[] = [];

  for (const item of candidates) {
    if (!item.downloadUrl || seenUrls.has(item.downloadUrl)) {
      continue;
    }
    seenUrls.add(item.downloadUrl);
    scored.push({
      ...item,
      score: scoreSubtitleCandidate(item, sourceFileName)
    });
  }

  return scored.sort((a, b) => b.score - a.score);
}
