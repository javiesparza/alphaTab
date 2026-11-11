export const MAX_SCORE_BYTES = 25 * 1024 * 1024;
export const IMPORT_FORMAT = 'alphatab-songsterr-v1';
export const IMPORT_PATH = '/api/import/songsterr';
export const IMPORT_META_NAME = 'alphatab-songsterr-import';

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function songsterrUrl(value: unknown): { url: string; songId: number } {
    const message = 'Paste an HTTPS Songsterr tab URL, such as https://www.songsterr.com/a/wsa/your-score-tab-s123.';
    if (typeof value !== 'string' || value.length > 2048) {
        throw new Error(message);
    }
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new Error(message);
    }
    const match = /^\/a\/wsa\/[^/\\]+-s([1-9]\d*)\/?$/.exec(url.pathname);
    if (
        url.protocol !== 'https:' ||
        !['songsterr.com', 'www.songsterr.com'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port ||
        !match ||
        !Number.isSafeInteger(Number(match[1])) ||
        /%2f|%5c|%00/i.test(url.pathname)
    ) {
        throw new Error(message);
    }
    url.hostname = 'www.songsterr.com';
    url.pathname = url.pathname.replace(/\/$/, '');
    url.search = '';
    url.hash = '';
    return { url: url.href, songId: Number(match[1]) };
}

export async function readBoundedResponse(response: Response, limit: number, message: string): Promise<Uint8Array> {
    const advertised = response.headers.get('content-length');
    if (advertised && Number(advertised) > limit) {
        await response.body?.cancel();
        throw new Error(message);
    }
    if (!response.body) {
        throw new Error('The response was empty.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            length += value.byteLength;
            if (length > limit) {
                await reader.cancel();
                throw new Error(message);
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

export interface ImportedSongsterrScore {
    source: { url: string; songId: number; revisionId: number };
    json: string;
    warnings: string[];
    guitarPro?: Uint8Array<ArrayBuffer>;
}

export function readImportedScore(value: unknown): ImportedSongsterrScore {
    if (
        !isRecord(value) ||
        value.format !== IMPORT_FORMAT ||
        !isRecord(value.source) ||
        !isRecord(value.score) ||
        !Array.isArray(value.warnings) ||
        value.warnings.length > 31 ||
        !value.warnings.every(warning => typeof warning === 'string' && warning.length <= 1000)
    ) {
        throw new Error('The local import service returned an invalid score.');
    }
    const source = songsterrUrl(value.source.url);
    const revisionId = value.source.revisionId;
    if (
        source.songId !== value.source.songId ||
        typeof revisionId !== 'number' ||
        !Number.isSafeInteger(revisionId) ||
        revisionId < 1
    ) {
        throw new Error('The imported score has invalid source information.');
    }
    let guitarPro: Uint8Array<ArrayBuffer> | undefined;
    if (value.guitarPro !== undefined) {
        if (
            typeof value.guitarPro !== 'string' ||
            value.guitarPro.length > Math.ceil(MAX_SCORE_BYTES / 3) * 4 ||
            value.guitarPro.length % 4 !== 0 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(value.guitarPro)
        ) {
            throw new Error('The local import service returned an invalid Guitar Pro file.');
        }
        let binary: string;
        try {
            binary = atob(value.guitarPro);
        } catch {
            throw new Error('The local import service returned an invalid Guitar Pro file.');
        }
        if (
            binary.length > MAX_SCORE_BYTES ||
            binary.length < 4 ||
            binary.charCodeAt(0) !== 80 ||
            binary.charCodeAt(1) !== 75 ||
            binary.charCodeAt(2) !== 3 ||
            binary.charCodeAt(3) !== 4
        ) {
            throw new Error('The local import service did not return a Guitar Pro archive.');
        }
        guitarPro = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            guitarPro[i] = binary.charCodeAt(i);
        }
    }
    return {
        source: { ...source, revisionId },
        json: JSON.stringify(value.score),
        warnings: value.warnings,
        guitarPro
    };
}
