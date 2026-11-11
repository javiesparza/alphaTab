import { ImportError } from './errors';
import { isRecord, readBoundedResponse, songsterrUrl } from './shared';

export const ACQUISITION_LIMITS = {
    pageBytes: 2 * 1024 * 1024,
    trackBytes: 4 * 1024 * 1024,
    totalBytes: 16 * 1024 * 1024,
    tracks: 16,
    requestMs: 8000
} as const;

const CDN = 'https://dqsljvtekg760.cloudfront.net';

export interface TrackMetadata {
    partId: number;
    instrumentId?: number;
    title?: string;
    name?: string;
    tuning?: number[];
    isDrums?: boolean;
}

export interface SongsterrSource {
    url: string;
    songId: number;
    revisionId: number;
    title: string;
    artist: string;
    tracks: { metadata: TrackMetadata; revision: Record<string, unknown> }[];
}

export function record(value: unknown, location: string): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new ImportError(`Invalid ${location}: expected an object.`);
    }
    return value;
}

export function integer(value: unknown, min: number, max: number, location: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
        throw new ImportError(`Invalid ${location}: expected an integer from ${min} to ${max}.`);
    }
    return value;
}

export function shortText(value: unknown, location: string, fallback = ''): string {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== 'string' || value.length > 500) {
        throw new ImportError(`Invalid ${location}: text is too long or malformed.`);
    }
    return value;
}

function tuning(value: unknown): number[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.length > 12) {
        throw new ImportError('Invalid track tuning.');
    }
    return value.map(note => integer(note, 0, 127, 'track tuning'));
}

function stateFromHtml(html: string): Record<string, unknown> {
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        if (!/(?:^|\s)id\s*=\s*(?:"state"|'state'|state)(?=\s|$)/i.test(match[1])) {
            continue;
        }
        let state: unknown;
        try {
            state = JSON.parse(match[2]);
        } catch {
            throw new ImportError('Songsterr returned malformed page state. No score was imported.', 502);
        }
        return record(record(record(state, 'page state').meta, 'page metadata').current, 'current revision');
    }
    throw new ImportError(
        'Songsterr did not provide public score metadata. Login, verification, or a changed upstream format may prevent import; use an authorized Guitar Pro file instead.',
        502
    );
}

export async function acquireSongsterr(
    input: unknown,
    signal: AbortSignal,
    fetcher: typeof fetch = fetch
): Promise<SongsterrSource> {
    let target: ReturnType<typeof songsterrUrl>;
    try {
        target = songsterrUrl(input);
    } catch (error) {
        throw new ImportError(error instanceof Error ? error.message : 'Invalid Songsterr URL.', 400);
    }
    let totalBytes = 0;
    async function get(url: string, contentType: string, limit: number): Promise<string> {
        const parsed = new URL(url);
        const allowed =
            parsed.origin === 'https://www.songsterr.com'
                ? songsterrUrl(url).url === url
                : parsed.origin === CDN && /^\/[1-9]\d*\/[1-9]\d*\/[a-zA-Z0-9_-]+\/\d+\.json$/.test(parsed.pathname);
        if (!allowed) {
            throw new ImportError('The score references an unsupported upstream address.');
        }
        let response: Response;
        try {
            response = await fetcher(url, {
                redirect: 'manual',
                credentials: 'omit',
                signal: AbortSignal.any([signal, AbortSignal.timeout(ACQUISITION_LIMITS.requestMs)]),
                headers: { Accept: contentType, 'User-Agent': 'alphaTab-playground-import/1.10' }
            });
        } catch (error) {
            if (signal.aborted) {
                throw new ImportError('The import was canceled or timed out.', 504);
            }
            const reason =
                error instanceof Error && error.name === 'TimeoutError'
                    ? 'The upstream request timed out.'
                    : 'Check your connection and try again later.';
            throw new ImportError(`Could not reach ${parsed.hostname}. ${reason}`, 502);
        }
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            throw new ImportError(
                'Songsterr redirected the request. Redirects, login and verification flows are not followed; use a direct public tab URL or an authorized local file.',
                502
            );
        }
        if (!response.ok) {
            await response.body?.cancel();
            const reason =
                response.status === 429
                    ? 'rate-limited this request'
                    : response.status === 401 || response.status === 403
                      ? 'denied access to this score'
                      : 'could not provide the complete score';
            throw new ImportError(
                `Songsterr ${reason} (HTTP ${response.status}). No tracks were imported. Access restrictions are not bypassed.`,
                502
            );
        }
        if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith(contentType)) {
            await response.body?.cancel();
            throw new ImportError('Songsterr returned an unexpected response instead of score data.', 502);
        }
        try {
            const bytes = await readBoundedResponse(
                response,
                Math.min(limit, ACQUISITION_LIMITS.totalBytes - totalBytes),
                'The upstream score exceeds the local import resource limit.'
            );
            totalBytes += bytes.length;
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch (error) {
            const reason = error instanceof Error ? `: ${error.message}` : '';
            throw new ImportError(`Could not read the upstream score${reason}`, 502);
        }
    }

    const meta = stateFromHtml(await get(target.url, 'text/html', ACQUISITION_LIMITS.pageBytes));
    const songId = integer(meta.songId, 1, Number.MAX_SAFE_INTEGER, 'song ID');
    if (songId !== target.songId) {
        throw new ImportError('Songsterr returned a different song than the requested URL.', 502);
    }
    const revisionId = integer(meta.revisionId, 1, Number.MAX_SAFE_INTEGER, 'revision ID');
    if (typeof meta.image !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(meta.image)) {
        throw new ImportError('Songsterr returned an unsupported revision address.', 502);
    }
    if (!Array.isArray(meta.tracks) || meta.tracks.length < 1 || meta.tracks.length > ACQUISITION_LIMITS.tracks) {
        throw new ImportError(
            `URL import requires 1-${ACQUISITION_LIMITS.tracks} complete tracks; none were imported.`
        );
    }
    const tracks: TrackMetadata[] = meta.tracks.map((value, index) => {
        const track = record(value, `track ${index + 1} metadata`);
        if (track.isDrums !== undefined && typeof track.isDrums !== 'boolean') {
            throw new ImportError('Invalid percussion metadata.');
        }
        return {
            partId: integer(track.partId, 0, 100000, 'part ID'),
            instrumentId:
                track.instrumentId === undefined ? undefined : integer(track.instrumentId, 0, 1024, 'instrument'),
            title: shortText(track.title, 'track title'),
            name: shortText(track.name, 'track name'),
            tuning: tuning(track.tuning),
            isDrums: track.isDrums
        };
    });
    if (new Set(tracks.map(track => track.partId)).size !== tracks.length) {
        throw new ImportError('Songsterr returned duplicate track IDs.');
    }
    const result: SongsterrSource = {
        url: target.url,
        songId,
        revisionId,
        title: shortText(meta.title, 'score title', `Songsterr score ${songId}`),
        artist: shortText(meta.artist, 'artist'),
        tracks: []
    };
    // Sequential requests avoid a CDN fan-out and keep the aggregate byte budget exact.
    for (const metadata of tracks) {
        signal.throwIfAborted();
        const body = await get(
            `${CDN}/${songId}/${revisionId}/${meta.image}/${metadata.partId}.json`,
            'application/json',
            ACQUISITION_LIMITS.trackBytes
        );
        let payload: unknown;
        try {
            payload = JSON.parse(body);
        } catch {
            throw new ImportError(
                `Track ${metadata.partId} contains malformed revision JSON. No tracks were imported.`,
                502
            );
        }
        const revision = record(payload, `track ${metadata.partId} revision`);
        for (const [key, expected] of [
            ['songId', songId],
            ['revisionId', revisionId],
            ['partId', metadata.partId]
        ] as const) {
            if (revision[key] !== undefined && revision[key] !== expected) {
                throw new ImportError(
                    `Track ${metadata.partId} belongs to a different revision. No tracks were imported.`,
                    502
                );
            }
        }
        result.tracks.push({ metadata, revision });
    }
    return result;
}
