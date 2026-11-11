import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Settings, midi, model, importer } from '@coderline/alphatab';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACQUISITION_LIMITS, acquireSongsterr } from '../src/songsterr/acquire';
import { CONVERSION_LIMITS, convertSongsterr } from '../src/songsterr/convert';
import { convertInWorker, createSongsterrMiddleware } from '../src/songsterr/middleware';
import {
    IMPORT_FORMAT,
    IMPORT_PATH,
    readBoundedResponse,
    readImportedScore,
    songsterrUrl
} from '../src/songsterr/shared';
import { mockSongsterr, originalRevision } from './songsterr-fixture';

const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(
        servers.splice(0).map(
            server =>
                new Promise<void>((resolve, reject) => {
                    server.close(error => (error ? reject(error) : resolve()));
                    server.closeAllConnections();
                })
        )
    );
});

async function serve(options: Parameters<typeof createSongsterrMiddleware>[0] = {}): Promise<string> {
    const middleware = createSongsterrMiddleware(options);
    const server = createServer((request, response) =>
        middleware(request, response, () => {
            response.writeHead(404);
            response.end();
        })
    );
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('The test server has no loopback address.');
    }
    return `http://127.0.0.1:${address.port}`;
}

function post(origin: string, body: unknown, init: RequestInit = {}) {
    return fetch(`${origin}${IMPORT_PATH}`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...init
    });
}

describe('Songsterr import acquisition', () => {
    it('normalizes only HTTPS Songsterr tab URLs and removes selectors', () => {
        const source = originalRevision();
        expect(songsterrUrl(`${source.url.replace('www.songsterr', 'songsterr')}/?track=2#measure-3`)).toEqual({
            url: source.url,
            songId: source.songId
        });
        for (const url of [
            'http://www.songsterr.com/a/wsa/test-s1',
            'https://songsterr.com.evil.example/a/wsa/test-s1',
            'https://user:password@www.songsterr.com/a/wsa/test-s1',
            'https://www.songsterr.com:1234/a/wsa/test-s1',
            'https://127.0.0.1/a/wsa/test-s1',
            'https://www.songsterr.com/a/wsa/test%2fpart-s1',
            'https://www.songsterr.com/a/wsa/test-s9007199254740993',
            'file:///score.gp'
        ]) {
            expect(() => songsterrUrl(url)).toThrow('HTTPS Songsterr');
        }
    });

    it('acquires the current revision and every track without credentials or redirects', async () => {
        const source = originalRevision();
        const mock = mockSongsterr(source);
        const acquired = await acquireSongsterr(source.url, new AbortController().signal, mock.fetcher);
        expect(acquired.tracks).toHaveLength(3);
        expect(acquired.revisionId).toBe(source.revisionId);
        expect(mock.calls).toHaveLength(4);
        for (const call of mock.calls) {
            expect(call.init?.redirect).toBe('manual');
            expect(call.init?.credentials).toBe('omit');
        }
    });

    it.each([401, 403, 404, 429])('refuses HTTP %i rather than returning a partial score', async status => {
        const source = originalRevision();
        const mock = mockSongsterr(source, url =>
            url.endsWith('/1.json') ? new Response('unavailable', { status }) : undefined
        );
        await expect(acquireSongsterr(source.url, new AbortController().signal, mock.fetcher)).rejects.toThrow(
            `HTTP ${status}`
        );
        expect(mock.calls).toHaveLength(3);
    });

    it('refuses redirects and does not request their destination', async () => {
        const source = originalRevision();
        const mock = mockSongsterr(
            source,
            () =>
                new Response(null, {
                    status: 302,
                    headers: { Location: 'http://127.0.0.1/private' }
                })
        );
        await expect(acquireSongsterr(source.url, new AbortController().signal, mock.fetcher)).rejects.toThrow(
            'Redirects, login and verification'
        );
        expect(mock.calls).toHaveLength(1);
    });

    it('rejects missing state, changed identities and excessive track counts', async () => {
        const source = originalRevision();
        const missing = mockSongsterr(
            source,
            () =>
                new Response('<html>Verification</html>', {
                    headers: { 'Content-Type': 'text/html' }
                })
        );
        await expect(acquireSongsterr(source.url, new AbortController().signal, missing.fetcher)).rejects.toThrow(
            'did not provide public score metadata'
        );
        const changed = structuredClone(source);
        changed.songId++;
        await expect(
            acquireSongsterr(
                source.url,
                new AbortController().signal,
                mockSongsterr(changed, url =>
                    url === source.url
                        ? new Response(
                              `<script id="state">${JSON.stringify({ meta: { current: { songId: changed.songId } } })}</script>`,
                              { headers: { 'Content-Type': 'text/html' } }
                          )
                        : undefined
                ).fetcher
            )
        ).rejects.toThrow('different song');
        const oversized = originalRevision();
        oversized.tracks = Array.from({ length: ACQUISITION_LIMITS.tracks + 1 }, () => oversized.tracks[0]);
        await expect(
            acquireSongsterr(oversized.url, new AbortController().signal, mockSongsterr(oversized).fetcher)
        ).rejects.toThrow('1-16 complete tracks');
    });

    it('enforces advertised and streamed byte limits including the exact boundary', async () => {
        await expect(readBoundedResponse(new Response(new Uint8Array(4)), 4, 'too large')).resolves.toHaveLength(4);
        await expect(readBoundedResponse(new Response(new Uint8Array(5)), 4, 'too large')).rejects.toThrow('too large');
        await expect(
            readBoundedResponse(
                new Response('x', {
                    headers: { 'Content-Length': '5' }
                }),
                4,
                'too large'
            )
        ).rejects.toThrow('too large');
        const source = originalRevision();
        const mock = mockSongsterr(
            source,
            () =>
                new Response('x', {
                    headers: { 'Content-Type': 'text/html', 'Content-Length': String(ACQUISITION_LIMITS.pageBytes + 1) }
                })
        );
        await expect(acquireSongsterr(source.url, new AbortController().signal, mock.fetcher)).rejects.toThrow(
            'resource limit'
        );
    });
});

describe('Songsterr conversion with the fork engine', () => {
    it('preserves explicit ringing, bass techniques, vibrato, dynamics and tremolo subdivisions', () => {
        const source = originalRevision();
        const beats = source.tracks[0].revision.measures[0].voices[0].beats;
        Object.assign(beats[0], { letRing: true, slapping: true, gradualVelocity: 'crescendo' });
        Object.assign(beats[0].notes[0], { leftHandVibrato: 'slight' });
        Object.assign(beats[1], { popping: true });
        Object.assign(beats[1].notes[0], { leftHandVibrato: 'wide' });
        Object.assign(beats[2], { tapping: true, tremolo: [1, 32], vibratoWithTremoloBar: false });
        const result = readImportedScore(JSON.parse(convertSongsterr(source, true)));
        if (!result.guitarPro) {
            throw new Error('GP export is missing.');
        }
        for (const score of [
            model.JsonConverter.jsonToScore(result.json),
            importer.ScoreLoader.loadScoreFromBytes(result.guitarPro)
        ]) {
            const actual = score.tracks[0].staves[0].bars[0].voices[0].beats;
            expect(actual[0].notes[0].isLetRing).toBe(true);
            expect(actual[0].notes[0].vibrato).toBe(model.VibratoType.Slight);
            expect(actual[0].slap).toBe(true);
            expect(actual[0].crescendo).toBe(model.CrescendoType.Crescendo);
            expect(actual[1].pop).toBe(true);
            expect(actual[1].notes[0].vibrato).toBe(model.VibratoType.Wide);
            expect(actual[2].tap).toBe(true);
            expect(actual[2].tremoloPicking?.getDurationAsTicks(actual[2].duration)).toBe(120);
        }
        expect(result.warnings).toEqual([]);
    });

    it('keeps extended Guitar Pro percussion IDs distinct from MIDI keys and file indices', () => {
        const source = originalRevision();
        const beats = source.tracks[2].revision.measures[0].voices[0].beats;
        beats[0].notes[0].fret = 91;
        beats[1].notes[0].fret = 92;
        const result = readImportedScore(JSON.parse(convertSongsterr(source, true)));
        if (!result.guitarPro) {
            throw new Error('GP export is missing.');
        }
        for (const score of [
            model.JsonConverter.jsonToScore(result.json),
            importer.ScoreLoader.loadScoreFromBytes(result.guitarPro)
        ]) {
            const notes = score.tracks[2].staves[0].bars[0].voices[0].beats;
            expect(notes[0].notes[0].realValue).toBe(38);
            expect(notes[1].notes[0].realValue).toBe(46);
        }
        beats[0].notes[0].fret = 0;
        expect(() => convertSongsterr(source)).toThrow('Unsupported percussion articulation');
    });

    it.each([
        [false, model.AccentuationType.None],
        [0, model.AccentuationType.None],
        [true, model.AccentuationType.Normal],
        [1, model.AccentuationType.Normal],
        [2, model.AccentuationType.Heavy]
    ])('preserves accent level %s', (value, expected) => {
        const source = originalRevision();
        Object.assign(source.tracks[0].revision.measures[0].voices[0].beats[0].notes[0], { accentuated: value });
        const result = readImportedScore(JSON.parse(convertSongsterr(source, true)));
        const score = model.JsonConverter.jsonToScore(result.json);
        expect(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].accentuated).toBe(expected);
        if (!result.guitarPro) {
            throw new Error('GP export is missing.');
        }
        const reopened = importer.ScoreLoader.loadScoreFromBytes(result.guitarPro);
        expect(reopened.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].accentuated).toBe(expected);
    });

    it('uses the engine dead-note representation when a muted string has no pitched fret', () => {
        const source = originalRevision();
        Object.assign(source.tracks[0].revision.measures[0].voices[0].beats[0], {
            notes: [{ dead: true, string: 0 }]
        });
        const result = readImportedScore(JSON.parse(convertSongsterr(source, true)));
        if (!result.guitarPro) {
            throw new Error('GP export is missing.');
        }
        for (const score of [
            model.JsonConverter.jsonToScore(result.json),
            importer.ScoreLoader.loadScoreFromBytes(result.guitarPro)
        ]) {
            const note = score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
            expect(note.isDead).toBe(true);
            expect(note.fret).toBe(0);
            expect(note.string).toBe(6);
        }
        Object.assign(source.tracks[0].revision.measures[0].voices[0].beats[0], {
            notes: [{ string: 0 }]
        });
        expect(() => convertSongsterr(source)).toThrow('fret');
    });

    it('preserves explicit rest beats when their voice and measure also have rest markers', () => {
        const source = originalRevision();
        Object.assign(source.tracks[0].revision.measures[0], {
            rest: true,
            voices: [{ rest: true, beats: [{ rest: true, notes: [{ rest: true }], type: 1, duration: [1, 1] }] }]
        });
        const result = readImportedScore(JSON.parse(convertSongsterr(source)));
        const score = model.JsonConverter.jsonToScore(result.json);
        const bars = score.tracks[0].staves[0].bars;
        expect(bars[0].voices[0].beats).toHaveLength(1);
        expect(bars[0].voices[0].beats[0].isRest).toBe(true);
        expect(bars[0].voices[0].beats[0].playbackDuration).toBe(3840);
        expect(bars[1].voices[0].beats).toHaveLength(4);
    });

    it.each(['measure', 'voice'])('still rejects sounding notes under a %s rest marker', marker => {
        const source = originalRevision();
        const measure = source.tracks[0].revision.measures[0];
        Object.assign(marker === 'measure' ? measure : measure.voices[0], { rest: true });
        expect(() => convertSongsterr(source)).toThrow('rest marker contains sounding notes');
    });

    it('exports a real GP7 file without changing percussion, pitches, timing or provenance', async () => {
        const source = originalRevision();
        const result = readImportedScore(JSON.parse(await convertInWorker(source, new AbortController().signal, true)));
        const data = result.guitarPro;
        if (!data) {
            throw new Error('The worker did not return a Guitar Pro file.');
        }
        expect([...data.subarray(0, 4)]).toEqual([80, 75, 3, 4]);
        const original = model.JsonConverter.jsonToScore(result.json);
        const reopened = importer.ScoreLoader.loadScoreFromBytes(data);
        expect(reopened.title).toBe(source.title);
        expect(reopened.notices).toContain(source.url);
        expect(reopened.notices).toContain(String(source.revisionId));
        expect(reopened.masterBars.length).toBe(original.masterBars.length);
        const events = (score: model.Score) => {
            const file = new midi.MidiFile();
            new midi.MidiFileGenerator(
                score,
                new Settings(),
                new midi.AlphaSynthMidiFileHandler(file, true)
            ).generate();
            return file.tracks
                .flatMap(track => track.events)
                .filter((event): event is midi.NoteOnEvent => event instanceof midi.NoteOnEvent)
                .map(event => [event.track, event.tick, event.noteKey, event.noteVelocity]);
        };
        expect(events(reopened)).toEqual(events(original));
        expect(reopened.tracks[2].percussionArticulations).toHaveLength(3);
    });

    it('does not accept JSON relabeled as a Guitar Pro file', () => {
        const value = JSON.parse(convertSongsterr(originalRevision()));
        value.guitarPro = btoa('{}');
        expect(() => readImportedScore(value)).toThrow('Guitar Pro archive');
    });

    it('round-trips all tracks through score JSON with correct pitches and finite MIDI timing', () => {
        const source = originalRevision();
        const result = readImportedScore(JSON.parse(convertSongsterr(source)));
        const settings = new Settings();
        const score = model.JsonConverter.jsonToScore(result.json, settings);
        expect(score.title).toBe(source.title);
        expect(score.tracks.map(track => track.name)).toEqual(['Study guitar', 'Study bass', 'Study drums']);
        expect(score.masterBars).toHaveLength(2);
        expect(score.tracks.map(track => track.staves[0].bars[0].voices[0].beats.length)).toEqual([4, 4, 4]);
        expect(score.tracks[2].staves[0].isPercussion).toBe(true);
        const file = new midi.MidiFile();
        new midi.MidiFileGenerator(score, settings, new midi.AlphaSynthMidiFileHandler(file, true)).generate();
        const events = file.tracks.flatMap(track => track.events);
        expect(events.every(event => Number.isFinite(event.tick) && event.tick >= 0)).toBe(true);
        const notes = events.filter((event): event is midi.NoteOnEvent => event instanceof midi.NoteOnEvent);
        expect(notes.length).toBeGreaterThanOrEqual(24);
        expect(new Set(notes.filter(note => note.channel === 0).map(note => note.noteKey))).toEqual(
            new Set([64, 66, 67, 69])
        );
        expect(new Set(notes.filter(note => note.channel === 1).map(note => note.noteKey))).toEqual(new Set([28, 35]));
        expect(new Set(notes.filter(note => note.channel === 9).map(note => note.noteKey))).toEqual(
            new Set([36, 38, 42])
        );
        expect(result.warnings).toEqual([]);
    });

    it('reports unsupported fields and refuses unsupported timing or incomplete tracks', () => {
        const warning = originalRevision();
        Object.assign(warning.tracks[0].revision.measures[0].voices[0].beats[0], { futureEffect: true });
        expect(readImportedScore(JSON.parse(convertSongsterr(warning))).warnings).toContain(
            'Unsupported beat field "futureEffect" was not imported.'
        );
        const timing = originalRevision();
        timing.tracks[0].revision.measures[0].voices[0].beats[0].duration = [1, 7];
        expect(() => convertSongsterr(timing)).toThrow('Timing was not approximated');
        const incomplete = originalRevision();
        incomplete.tracks[1].revision.measures.pop();
        expect(() => convertSongsterr(incomplete)).toThrow('inconsistent track lengths');
        const tooManyBars = originalRevision();
        tooManyBars.tracks[0].revision.measures = Array.from(
            { length: CONVERSION_LIMITS.bars + 1 },
            () => tooManyBars.tracks[0].revision.measures[0]
        );
        expect(() => convertSongsterr(tooManyBars)).toThrow('track measures');
    });

    it('runs in the isolated worker against the same source version', async () => {
        const source = originalRevision();
        const result = readImportedScore(JSON.parse(await convertInWorker(source, new AbortController().signal)));
        expect(result.source.revisionId).toBe(source.revisionId);
        expect(model.JsonConverter.jsonToScore(result.json).tracks).toHaveLength(3);
        await expect(convertInWorker(source, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    });
});

describe('local import API', () => {
    it.each(['development', 'songsterr-import'])('wires the actual Control Vite server in %s mode', async mode => {
        const { createServer: createViteServer } = await import('vite');
        const cacheDir = await mkdtemp(path.join(tmpdir(), 'alphatab-import-vite-'));
        const root = fileURLToPath(new URL('../', import.meta.url));
        const nativeFetch = fetch;
        const source = originalRevision();
        const mock = mockSongsterr(source);
        const enabled = mode === 'songsterr-import';
        let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
        vi.stubGlobal('fetch', mock.fetcher);
        try {
            server = await createViteServer({
                root,
                configFile: path.join(root, 'vite.config.ts'),
                mode,
                cacheDir,
                logLevel: 'error',
                server: { host: '127.0.0.1', port: 0, strictPort: true, open: false }
            });
            await server.listen();
            const address = server.httpServer?.address();
            if (!address || typeof address === 'string') {
                throw new Error('The Control test server has no loopback address.');
            }
            const origin = `http://127.0.0.1:${address.port}`;
            const page = await nativeFetch(`${origin}/demos/control/`);
            expect(page.status).toBe(200);
            expect((await page.text()).includes('name="alphatab-songsterr-import" content="enabled"')).toBe(enabled);
            const response = await nativeFetch(`${origin}${IMPORT_PATH}`, {
                method: 'POST',
                headers: { Origin: origin, 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: source.url, authorized: true })
            });
            const body = await response.text();
            expect(response.status, body.slice(0, 1000)).toBe(enabled ? 200 : 404);
            if (enabled) {
                const result = readImportedScore(JSON.parse(body));
                expect(model.JsonConverter.jsonToScore(result.json).tracks).toHaveLength(3);
            }
            expect(mock.calls).toHaveLength(enabled ? 4 : 0);
        } finally {
            vi.unstubAllGlobals();
            try {
                await server?.close();
            } finally {
                await rm(cacheDir, { recursive: true, force: true });
            }
        }
    });

    it('uses the real worker and returns the versioned model without changing other routes', async () => {
        const source = originalRevision();
        const mock = mockSongsterr(source);
        const origin = await serve({ fetcher: mock.fetcher });
        const response = await post(origin, { url: source.url, authorized: true });
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.format).toBe(IMPORT_FORMAT);
        expect(readImportedScore(result).source.url).toBe(source.url);
        expect(mock.calls).toHaveLength(4);
        expect((await fetch(`${origin}/another-route`)).status).toBe(404);
    });

    it('requires same-origin POST, explicit permission, JSON and a bounded request body', async () => {
        const mock = mockSongsterr();
        const origin = await serve({ fetcher: mock.fetcher });
        expect((await fetch(`${origin}${IMPORT_PATH}`, { headers: { Origin: origin } })).status).toBe(405);
        expect(
            (
                await post(
                    origin,
                    { url: originalRevision().url, authorized: true },
                    {
                        headers: { Origin: 'https://unrelated.example', 'Content-Type': 'application/json' }
                    }
                )
            ).status
        ).toBe(403);
        const invalidHost = await new Promise<number>((resolve, reject) => {
            const request = httpRequest(
                `${origin}${IMPORT_PATH}`,
                {
                    method: 'POST',
                    headers: { Origin: origin, 'Content-Type': 'application/json', Host: 'unrelated.example' }
                },
                response => {
                    response.on('error', reject);
                    response.on('end', () => {
                        if (response.statusCode === undefined) {
                            reject(new Error('The server did not send an HTTP status.'));
                        } else {
                            resolve(response.statusCode);
                        }
                    });
                    response.resume();
                }
            );
            request.on('error', reject);
            request.end(JSON.stringify({ url: originalRevision().url, authorized: true }));
        });
        expect(invalidHost).toBe(403);
        expect((await post(origin, { url: originalRevision().url })).status).toBe(400);
        expect(
            (await post(origin, { url: originalRevision().url, authorized: true, exportGuitarPro: 'yes' })).status
        ).toBe(400);
        expect(
            (
                await post(
                    origin,
                    {},
                    {
                        headers: { Origin: origin, 'Content-Type': 'text/plain' }
                    }
                )
            ).status
        ).toBe(415);
        expect((await post(origin, { padding: 'x'.repeat(4096) })).status).toBe(413);
        expect(mock.calls).toHaveLength(0);
    });

    it('rejects concurrent imports and cancels acquisition when the client disconnects', async () => {
        const source = originalRevision();
        let started!: () => void;
        let aborted!: () => void;
        const startedPromise = new Promise<void>(resolve => {
            started = resolve;
        });
        const abortedPromise = new Promise<void>(resolve => {
            aborted = resolve;
        });
        let hold = true;
        const mock = mockSongsterr(source, async (_url, init) => {
            if (!hold) {
                return undefined;
            }
            started();
            return await new Promise<Response>((_resolve, reject) => {
                const abort = () => {
                    aborted();
                    reject(new Error('Mock acquisition aborted.'));
                };
                init?.signal?.addEventListener('abort', abort, { once: true });
                if (init?.signal?.aborted) {
                    abort();
                }
            });
        });
        const origin = await serve({ fetcher: mock.fetcher, convert: async () => '{}' });
        const controller = new AbortController();
        const pending = post(origin, { url: source.url, authorized: true }, { signal: controller.signal });
        const pendingAssertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await startedPromise;
        expect((await post(origin, { url: source.url, authorized: true })).status).toBe(429);
        controller.abort();
        await pendingAssertion;
        await abortedPromise;
        hold = false;
        expect((await post(origin, { url: source.url, authorized: true })).status).toBe(200);
    });
});
