import { parentPort, workerData } from 'node:worker_threads';
import type { SongsterrSource } from './acquire';
import { convertSongsterr } from './convert';
import { ImportError } from './errors';

if (!parentPort) {
    throw new Error('The Songsterr converter must run in its import worker.');
}

try {
    const input: { source: SongsterrSource; exportGuitarPro: boolean } = workerData;
    parentPort.postMessage({ body: convertSongsterr(input.source, input.exportGuitarPro) });
} catch (error) {
    if (!(error instanceof ImportError)) {
        console.error('Songsterr conversion failed.', error);
    }
    parentPort.postMessage({
        error: error instanceof ImportError ? error.message : 'Score conversion failed. No tracks were imported.',
        status: error instanceof ImportError ? error.status : 500
    });
}
