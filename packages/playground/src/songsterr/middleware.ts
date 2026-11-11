import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { acquireSongsterr, type SongsterrSource } from './acquire';
import { ImportError } from './errors';
import { IMPORT_PATH, isRecord, MAX_SCORE_BYTES } from './shared';

export async function convertInWorker(
    source: SongsterrSource,
    signal: AbortSignal,
    exportGuitarPro = false
): Promise<string> {
    signal.throwIfAborted();
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
        workerData: { source, exportGuitarPro },
        execArgv: ['--import', 'tsx'],
        env: {
            ...process.env,
            TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.json', import.meta.url))
        },
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 }
    });
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
    let onAbort = () => {};
    try {
        return await new Promise<string>((resolve, reject) => {
            onAbort = () =>
                reject(new ImportError('Score conversion was canceled or exceeded its 10-second limit.', 504));
            deadline.addEventListener('abort', onAbort, { once: true });
            if (deadline.aborted) {
                onAbort();
            }
            worker.once('message', (message: unknown) => {
                if (isRecord(message) && typeof message.body === 'string') {
                    if (Buffer.byteLength(message.body) > MAX_SCORE_BYTES) {
                        reject(new ImportError('The converted score exceeds the 25 MB import limit.'));
                    } else {
                        resolve(message.body);
                    }
                } else if (isRecord(message) && typeof message.error === 'string') {
                    const status = message.status === 500 ? 500 : 422;
                    reject(new ImportError(message.error, status));
                } else {
                    reject(new ImportError('The converter returned an invalid result.', 500));
                }
            });
            worker.once('error', error => {
                console.error('Songsterr import worker failed.', error);
                reject(
                    new ImportError('Score conversion failed or exceeded its memory limit. No tracks were imported.')
                );
            });
            worker.once('exit', () =>
                reject(new ImportError('The converter stopped before producing a complete score.'))
            );
        });
    } finally {
        deadline.removeEventListener('abort', onAbort);
        await worker.terminate();
    }
}

function requestJson(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return Promise.reject(new ImportError('URL imports require an application/json request.', 415));
    }
    if (Number(request.headers['content-length']) > 4096) {
        return Promise.reject(new ImportError('The URL import request is too large.', 413));
    }
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let length = 0;
        const cleanup = () => {
            request.off('data', onData);
            request.off('end', onEnd);
            request.off('error', onError);
            signal.removeEventListener('abort', onAbort);
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const onAbort = () => onError(new ImportError('The URL import request timed out or was canceled.', 408));
        const onData = (chunk: Buffer) => {
            length += chunk.length;
            if (length > 4096) {
                onError(new ImportError('The URL import request is too large.', 413));
            } else {
                chunks.push(chunk);
            }
        };
        const onEnd = () => {
            cleanup();
            try {
                resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
            } catch {
                reject(new ImportError('The URL import request is not valid JSON.', 400));
            }
        };
        request.on('data', onData);
        request.once('end', onEnd);
        request.once('error', onError);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
        }
    });
}

export function createSongsterrMiddleware(
    options: { fetcher?: typeof fetch; convert?: typeof convertInWorker; logError?: (error: unknown) => void } = {}
) {
    let importing = false;
    return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
        if (request.url?.split('?')[0] !== IMPORT_PATH) {
            next();
            return;
        }
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Connection', 'close');
        const controller = new AbortController();
        const onAborted = () => controller.abort();
        request.once('aborted', onAborted);
        response.once('close', () => {
            request.off('aborted', onAborted);
            if (!response.writableEnded) {
                controller.abort();
            }
        });
        async function handle(): Promise<void> {
            const origin = `http://127.0.0.1:${request.socket.localPort}`;
            if (
                request.headers.host !== new URL(origin).host ||
                request.headers.origin !== origin ||
                (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')
            ) {
                throw new ImportError('A same-origin browser request to the loopback import service is required.', 403);
            }
            if (request.method !== 'POST') {
                response.setHeader('Allow', 'POST');
                throw new ImportError('Use POST for URL imports.', 405);
            }
            if (importing) {
                throw new ImportError(
                    'Another URL import is in progress. Wait for it to finish or cancel it first.',
                    429
                );
            }
            importing = true;
            try {
                const body = await requestJson(
                    request,
                    AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
                );
                if (!isRecord(body) || body.authorized !== true) {
                    throw new ImportError(
                        'Confirm that you own or have permission to use this score before importing.',
                        400
                    );
                }
                if (body.exportGuitarPro !== undefined && typeof body.exportGuitarPro !== 'boolean') {
                    throw new ImportError('The Guitar Pro export option must be a boolean.', 400);
                }
                const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
                const source = await acquireSongsterr(body.url, signal, options.fetcher);
                const result = await (options.convert ?? convertInWorker)(
                    source,
                    signal,
                    body.exportGuitarPro === true
                );
                response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                response.end(result);
            } finally {
                importing = false;
            }
        }
        void handle().catch((error: unknown) => {
            if (response.destroyed || controller.signal.aborted) {
                return;
            }
            if (!(error instanceof ImportError)) {
                (options.logError ?? console.error)(error);
            }
            if (response.headersSent) {
                response.destroy();
            } else {
                response.writeHead(error instanceof ImportError ? error.status : 500, {
                    'Content-Type': 'application/json; charset=utf-8'
                });
                response.end(
                    JSON.stringify({
                        error:
                            error instanceof ImportError
                                ? error.message
                                : 'The local import service failed. No score was imported.'
                    })
                );
            }
        });
    };
}
