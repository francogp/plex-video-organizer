import { fitTvEpisodeTitleToBudget, sanitizePlexSegment } from '../../domain/constants.ts';
import { formatTitleWithYear } from '../../domain/plexFormatter.ts';
import type {
  EtaState,
  JobPhase,
  MediaKind,
  MediaProbeSummary,
  MetadataCandidate,
  ScannedItem
} from '../../domain/types.ts';

const PHASE_LABELS: ReadonlyMap<JobPhase, string> = new Map([
  ['IDLE', 'Idle'],
  ['SCANNING', 'Scanning'],
  ['READY', 'Ready'],
  ['PREFLIGHT_BLOCKED', 'Action Required'],
  ['PROCESSING', 'Processing'],
  ['ERROR', 'Error']
]);

/** Formats a JobPhase enum into a human-readable badge label. */
export function formatPhaseLabel(phase: JobPhase): string {
  return PHASE_LABELS.get(phase) ?? phase;
}

const BYTES_PER_MB = 1024 * 1024;
const BUENOS_AIRES_TZ = 'America/Argentina/Buenos_Aires';
const PAD_TWO = 2;

const mbNumberFormatter = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});

const baFormatter = new Intl.DateTimeFormat('es-AR', {
  timeZone: BUENOS_AIRES_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

/** Formats a byte count into a human-readable megabytes label using Argentine (`es-AR`) notation. */
export function formatSizeMb(bytes: number): string {
  return `${mbNumberFormatter.format(bytes / BYTES_PER_MB)} MB`;
}

/** Formats a byte-size difference into a signed megabytes label using Argentine (`es-AR`) notation. */
export function formatSizeDeltaMb(incomingBytes: number, existingBytes: number): string {
  const diffMb = (incomingBytes - existingBytes) / BYTES_PER_MB;
  const sign = diffMb >= 0 ? '+' : '';
  return `${sign}${mbNumberFormatter.format(diffMb)} MB`;
}

/** Formats an ISO-8601 UTC timestamp into `America/Argentina/Buenos_Aires` local time. */
export function formatBuenosAiresTimestamp(iso: string): string {
  try {
    if (typeof Temporal !== 'undefined') {
      const zoned = Temporal.Instant.from(iso).toZonedDateTimeISO(BUENOS_AIRES_TZ);
      return zoned.toLocaleString('es-AR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
    }
    const epochMs = Date.parse(iso);
    if (Number.isNaN(epochMs)) {
      return iso;
    }
    return baFormatter.format(epochMs);
  } catch {
    return iso;
  }
}

export interface PathSegments {
  readonly folders: readonly string[];
  readonly fileName: string;
}

/** Splits a source relative path into folder pills and final filename. */
export function splitRelativePathSegments(relativePath: string): PathSegments {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 1) {
    return { folders: [], fileName: parts[0] ?? relativePath };
  }
  return {
    folders: parts.slice(0, -1),
    fileName: parts[parts.length - 1] ?? relativePath
  };
}

/** Builds structured Plex destination folder and filename segments for UI pills. */
export function formatPlexOutputSegments(item: ScannedItem): PathSegments | null {
  const meta = item.selectedMetadata;
  const cleanTitle = meta?.title ? sanitizePlexSegment(meta.title) : '';
  if (!cleanTitle) {
    return null;
  }
  const cleanEdition = item.edition?.trim() ? sanitizePlexSegment(item.edition.trim()) : '';
  const editionTag = cleanEdition ? `{edition-${cleanEdition}}` : undefined;
  if (item.mediaKind === 'movie') {
    const parts = [formatTitleWithYear(cleanTitle, meta?.year)];
    if (meta?.imdbId) {
      parts.push(`{imdb-${meta.imdbId}}`);
    } else if (meta?.tmdbId) {
      parts.push(`{tmdb-${meta.tmdbId}}`);
    }
    if (editionTag) {
      parts.push(editionTag);
    }
    if (item.tags.length > 0) {
      parts.push(`[${item.tags.join(', ')}]`);
    }
    const base = sanitizePlexSegment(parts.join(' '));
    const file = sanitizePlexSegment(
      item.splitPart ? `${base} - ${item.splitPart}.mkv` : `${base}.mkv`
    );
    return { folders: [base], fileName: file };
  }

  const showDisplay = formatTitleWithYear(cleanTitle, meta?.year);
  const showParts = [showDisplay];
  if (meta?.tvdbId) {
    showParts.push(`{tvdb-${meta.tvdbId}}`);
  } else if (meta?.tmdbId) {
    showParts.push(`{tmdb-${meta.tmdbId}}`);
  }
  if (editionTag) {
    showParts.push(editionTag);
  }
  const showFolder = sanitizePlexSegment(showParts.join(' '));
  const ep = item.episode ?? { seasonNumber: 1, episodeStart: 1 };
  const seasonLabel = `Season ${String(ep.seasonNumber).padStart(PAD_TWO, '0')}`;
  const startCode = `s${String(ep.seasonNumber).padStart(PAD_TWO, '0')}e${String(ep.episodeStart).padStart(PAD_TWO, '0')}`;
  const epCode =
    ep.episodeEnd && ep.episodeEnd > ep.episodeStart
      ? `${startCode}-e${String(ep.episodeEnd).padStart(PAD_TWO, '0')}`
      : startCode;
  const baseFileName = sanitizePlexSegment(`${showDisplay} - ${epCode}.mkv`);
  const baseRelLength = [showFolder, seasonLabel, baseFileName].join('/').length;
  const fittedEpTitle = ep.episodeTitle
    ? fitTvEpisodeTitleToBudget(baseRelLength, ep.episodeTitle)
    : '';
  const epTitle = fittedEpTitle ? ` - ${fittedEpTitle}` : '';
  return {
    folders: [showFolder, seasonLabel],
    fileName: sanitizePlexSegment(`${showDisplay} - ${epCode}${epTitle}.mkv`)
  };
}

const KBPS_DIVISOR = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const BYTES_PER_GIB = BYTES_PER_MIB * BYTES_PER_KIB;
const BYTES_PER_TIB = BYTES_PER_GIB * BYTES_PER_KIB;
const MS_PER_SECOND = 1000;
const MARCH_MONTH_INDEX = 3;
const ERA_YEARS = 400;
const DAYS_PER_ERA = 146_097;
const DAYS_PER_COMMON_YEAR = 365;
const DOY_MONTH_COEFF = 153;
const DOY_MONTH_ADD = 2;
const DOY_MONTH_DIV = 5;
const MONTH_APRIL_TO_FEB_SHIFT = 9;
const LEAP_PERIOD_FOUR = 4;
const LEAP_PERIOD_HUNDRED = 100;

/** Formats byte counts into readable `MB`, `GB`, or `TB` labels. */
export function formatBytesHuman(bytes: number): string {
  if (bytes >= BYTES_PER_TIB) {
    return `${(bytes / BYTES_PER_TIB).toFixed(2)} TB`;
  }
  if (bytes >= BYTES_PER_GIB) {
    return `${(bytes / BYTES_PER_GIB).toFixed(1)} GB`;
  }
  return `${(bytes / BYTES_PER_MIB).toFixed(1)} MB`;
}

/** Formats a bitrate in bits/sec as rounded `kbps`. */
function formatKbps(bps: number): string {
  return `${String(Math.round(bps / KBPS_DIVISOR))} kbps`;
}

/** Formats a duration in seconds as `Xm YYs`. */
function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const mins = Math.floor(rounded / SECONDS_PER_MINUTE);
  const secs = rounded % SECONDS_PER_MINUTE;
  return `${String(mins)}m ${String(secs).padStart(PAD_TWO, '0')}s`;
}

export interface ProbeSpecRow {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}

/** Formats a probed stream summary into structured key-value rows for comparison cards. */
export function formatProbeSpecRows(probe: MediaProbeSummary): readonly ProbeSpecRow[] {
  const video = probe.videoStreams[0];
  const resText = video
    ? `${String(video.width)}×${String(video.height)}${video.codecName ? ` (${video.codecName})` : ''}`
    : 'No video';
  const audioLangs =
    probe.audioStreams.length > 0 ? probe.audioStreams.map((a) => a.language).join(', ') : 'None';
  const subLangs =
    probe.subtitleStreams.length > 0
      ? `${String(probe.subtitleStreams.length)} (${probe.subtitleStreams.map((s) => s.language).join(', ')})`
      : 'None';
  return [
    { label: 'Size', value: formatSizeMb(probe.sizeBytes), mono: true },
    { label: 'Resolution', value: resText, mono: true },
    { label: 'Bitrate', value: formatKbps(probe.bitrateBps), mono: true },
    { label: 'Duration', value: formatDuration(probe.durationSeconds), mono: true },
    { label: 'Container', value: probe.formatName, mono: true },
    { label: 'Audio', value: audioLangs, mono: false },
    { label: 'Subtitles', value: subLangs, mono: false }
  ];
}

/** Formats a rounded seconds duration concisely (`42s`, `2m 5s`, or `5h 58m`). */
export function formatDurationCompact(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < SECONDS_PER_MINUTE) {
    return `${String(total)}s`;
  }
  if (total < SECONDS_PER_HOUR) {
    const mins = Math.floor(total / SECONDS_PER_MINUTE);
    const secs = total % SECONDS_PER_MINUTE;
    return `${String(mins)}m ${String(secs)}s`;
  }
  const hours = Math.floor(total / SECONDS_PER_HOUR);
  const mins = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  return `${String(hours)}h ${String(mins)}m`;
}

const H23_CLOCK_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

function getCurrentEpochMs(): number {
  return typeof Temporal !== 'undefined'
    ? Temporal.Now.instant().epochMilliseconds
    : Math.trunc(performance.timeOrigin + performance.now());
}

interface LocalDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
}

function getLocalDateTimeParts(epochMs: number): LocalDateTimeParts {
  const safeMs = Math.trunc(epochMs);
  if (typeof Temporal !== 'undefined') {
    const zoned = Temporal.Instant.fromEpochMilliseconds(safeMs).toZonedDateTimeISO(
      Temporal.Now.timeZoneId()
    );
    return {
      year: zoned.year,
      month: zoned.month,
      day: zoned.day,
      hour: String(zoned.hour).padStart(PAD_TWO, '0'),
      minute: String(zoned.minute).padStart(PAD_TWO, '0'),
      second: String(zoned.second).padStart(PAD_TWO, '0')
    };
  }
  const partMap = new Map(H23_CLOCK_FORMATTER.formatToParts(safeMs).map((p) => [p.type, p.value]));
  return {
    year: Number(partMap.get('year') ?? 0),
    month: Number(partMap.get('month') ?? 1),
    day: Number(partMap.get('day') ?? 1),
    hour: (partMap.get('hour') ?? '00').padStart(PAD_TWO, '0'),
    minute: (partMap.get('minute') ?? '00').padStart(PAD_TWO, '0'),
    second: (partMap.get('second') ?? '00').padStart(PAD_TWO, '0')
  };
}

/** Formats a local 24h `HH:mm:ss` timestamp without legacy `Date` globals. */
export function formatLocalTimeWithSeconds(epochMs: number): string {
  const { hour, minute, second } = getLocalDateTimeParts(epochMs);
  return `${hour}:${minute}:${second}`;
}

function civilDayNumber(year: number, month: number, day: number): number {
  const shiftedYear = year - (month < MARCH_MONTH_INDEX ? 1 : 0);
  const era = Math.floor(shiftedYear / ERA_YEARS);
  const yearOfEra = shiftedYear - era * ERA_YEARS;
  const monthShifted =
    month + (month >= MARCH_MONTH_INDEX ? -MARCH_MONTH_INDEX : MONTH_APRIL_TO_FEB_SHIFT);
  const dayOfYear =
    Math.floor((DOY_MONTH_COEFF * monthShifted + DOY_MONTH_ADD) / DOY_MONTH_DIV) + day - 1;
  const dayOfEra =
    yearOfEra * DAYS_PER_COMMON_YEAR +
    Math.floor(yearOfEra / LEAP_PERIOD_FOUR) -
    Math.floor(yearOfEra / LEAP_PERIOD_HUNDRED) +
    dayOfYear;
  return era * DAYS_PER_ERA + dayOfEra;
}

/** Formats local 24h completion clock time (`HH:mm` or `+Nd HH:mm` when crossing midnight). */
export function formatFinishClockTime(etaSeconds: number, nowMs = getCurrentEpochMs()): string {
  const startMs = Math.trunc(nowMs);
  const endMs = startMs + Math.max(0, Math.round(etaSeconds)) * MS_PER_SECOND;
  const start = getLocalDateTimeParts(startMs);
  const end = getLocalDateTimeParts(endMs);
  const dayDiff = Math.max(
    0,
    civilDayNumber(end.year, end.month, end.day) -
      civilDayNumber(start.year, start.month, start.day)
  );
  return dayDiff > 0
    ? `+${String(dayDiff)}d ${end.hour}:${end.minute}`
    : `${end.hour}:${end.minute}`;
}

/** Formats remaining ETA seconds with local finish clock (`ETA 1h 2m (04:15)`, `~2m 5s (22:10)`, or `Calibrating...`). */
export function formatEta(
  etaSeconds?: number,
  etaState?: EtaState,
  nowMs = getCurrentEpochMs()
): string {
  if (etaSeconds === undefined || !Number.isFinite(etaSeconds) || etaSeconds < 0) {
    return etaState === 'calibrating' ? 'Calibrating...' : '';
  }
  const total = Math.round(etaSeconds);
  const durationText = formatDurationCompact(total);
  const finishText = formatFinishClockTime(total, nowMs);
  return etaState === 'calibrating'
    ? `~${durationText} (${finishText})`
    : `ETA ${durationText} (${finishText})`;
}

export type ExternalProviderKind = 'tvdb' | 'imdb' | 'tmdb';

export interface ExternalIdLink {
  readonly provider: ExternalProviderKind;
  readonly id: string;
  readonly label: string;
  readonly url: string;
}

const PROVIDER_TAG_REGEX = /\{(tvdb|imdb|tmdb)-([a-z0-9]+)\}/gi;

/** Extracts `{tvdb-...}`, `{imdb-...}`, and `{tmdb-...}` tags into external verification URLs. */
export function extractExternalIdLinks(
  rootName: string,
  mediaKind: MediaKind
): readonly ExternalIdLink[] {
  const links: ExternalIdLink[] = [];
  const seen = new Set<string>();
  for (const match of rootName.matchAll(PROVIDER_TAG_REGEX)) {
    const provider = match[1]?.toLowerCase() as ExternalProviderKind | undefined;
    const id = match[2];
    if (!provider || !id) {
      continue;
    }
    const dedupeKey = `${provider}:${id}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    if (provider === 'tvdb') {
      const segment = mediaKind === 'movie' ? 'movie' : 'series';
      links.push({
        provider,
        id,
        label: 'TVDB',
        url: `https://www.thetvdb.com/dereferrer/${segment}/${encodeURIComponent(id)}`
      });
    } else if (provider === 'imdb') {
      const imdbId = id.toLowerCase().startsWith('tt') ? id : `tt${id}`;
      links.push({
        provider,
        id: imdbId,
        label: 'IMDb',
        url: `https://www.imdb.com/title/${encodeURIComponent(imdbId)}/`
      });
    } else {
      const segment = mediaKind === 'movie' ? 'movie' : 'tv';
      links.push({
        provider,
        id,
        label: 'TMDB',
        url: `https://www.themoviedb.org/${segment}/${encodeURIComponent(id)}`
      });
    }
  }
  return links;
}

/** Formats candidate external IDs (`{imdb-...} {tvdb-...} {tmdb-...}`). */
export function formatMetadataIds(candidate: MetadataCandidate): string {
  const ids: string[] = [];
  if (candidate.imdbId) {
    ids.push(`{imdb-${candidate.imdbId}}`);
  }
  if (candidate.tvdbId) {
    ids.push(`{tvdb-${candidate.tvdbId}}`);
  }
  if (candidate.tmdbId) {
    ids.push(`{tmdb-${candidate.tmdbId}}`);
  }
  return ids.join(' ');
}

/** Builds clickable external provider links directly from a `MetadataCandidate`. */
export function extractCandidateLinks(
  candidate: MetadataCandidate,
  mediaKind: MediaKind
): readonly ExternalIdLink[] {
  const formatted = formatMetadataIds(candidate);
  return formatted ? extractExternalIdLinks(formatted, mediaKind) : [];
}
