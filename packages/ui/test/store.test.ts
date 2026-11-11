import { model } from '@coderline/alphatab';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPreferences, PlaybackPreferencesStore } from '../src/state/playback/preferences';
import { PlayerStore } from '../src/state/store';
import { asApi, createFakeApi, type FakeApi, scoreFromTex } from './fake-api';

const QUARTER_BAR = 3840;

// Two tracks, four 4/4 bars, a tempo change in bar 3 and a bar of 3/4 at the end.
const TEX = `
\\tempo 120
\\track "Lead"
\\staff
3.3.4 3.3.4 3.3.4 3.3.4 | 3.3.1 | \\tempo 90 3.3.1 | \\ts 3 4 3.3.2.
\\track "Bass"
\\staff
3.4.1 | 3.4.1 | 3.4.1 | \\ts 3 4 3.4.2.
`;

function createStore(api: FakeApi): PlayerStore {
    return new PlayerStore(asApi(api), {
        base: { theme: 'light', fonts: 'default', suppliedSoundFont: false },
        playback: {
            fixedSource: true,
            ownSoundFont: true,
            soundFonts: null,
            preferences: new PlaybackPreferencesStore(createMemoryPreferences(), null)
        }
    });
}

describe('PlayerStore', () => {
    let api: FakeApi;
    let store: PlayerStore;

    beforeEach(() => {
        api = createFakeApi();
        store = createStore(api);
        const score = scoreFromTex(TEX);
        api.score = score;
        api.tracks = [...score.tracks];
        api.scoreLoaded.trigger(score);
    });

    afterEach(() => {
        store.destroy();
    });

    it('derives the bar start ticks from the time signatures', () => {
        const state = store.getSnapshot();
        expect(state.totalBars).toBe(4);
        expect(state.barStartTicks).toEqual([0, QUARTER_BAR, 2 * QUARTER_BAR, 3 * QUARTER_BAR, 3.75 * QUARTER_BAR]);
    });

    it('lists a tempo marker per tempo change', () => {
        expect(store.getSnapshot().tempoMarkers).toEqual([
            { atBar: 0, bpm: 120 },
            { atBar: 2, bpm: 90 }
        ]);
    });

    it('maps the playback range to bars and back', () => {
        api.playbackRangeChanged.trigger({ playbackRange: { startTick: QUARTER_BAR, endTick: 3 * QUARTER_BAR } });
        expect(store.getSnapshot().loopRangeBars).toEqual({ from: 1, to: 3 });

        store.setLoopRangeBars(2, 0);
        expect(api.playbackRange).toEqual({ startTick: 0, endTick: 2 * QUARTER_BAR });
        expect(store.getSnapshot().loopRangeBars).toEqual({ from: 0, to: 2 });

        store.setLoopRangeBars(null, null);
        expect(api.playbackRange).toBeNull();
        expect(store.getSnapshot().loopRangeBars).toBeNull();
    });

    it('tracks the current bar from the playback position', () => {
        api.playerPositionChanged.trigger({ currentTick: 2.5 * QUARTER_BAR, currentTime: 4000, endTime: 9000 });
        const state = store.getSnapshot();
        expect(state.currentBar).toBe(2);
        expect(state.currentTime).toBe(4000);
        expect(state.endTime).toBe(9000);
    });

    it('applies the track mix to the synthesizer again after a MIDI load and a new player', () => {
        const [lead, bass] = api.score!.tracks;
        store.setTrackMute(bass, true);
        store.setTrackVolume(lead, 0.5);
        store.setTransposeAllTracks(2);

        for (const reload of [() => api.midiLoaded.trigger({}), () => api.playerReady.trigger()]) {
            api.changeTrackMute.mockClear();
            api.changeTrackVolume.mockClear();
            api.changeTrackTranspositionPitch.mockClear();
            reload();
            expect(api.changeTrackMute).toHaveBeenCalledWith([bass], true);
            expect(api.changeTrackMute).toHaveBeenCalledWith([lead], false);
            expect(api.changeTrackVolume).toHaveBeenCalledWith([lead], 0.5);
            expect(api.changeTrackTranspositionPitch).toHaveBeenCalledWith([bass], 2);
        }
    });

    it('keeps the mix when the same piece is parsed again and resets it for another one', () => {
        const bass = api.score!.tracks[1];
        store.setTrackMute(bass, true);

        const edited = scoreFromTex(TEX.replace('3.3.1 |', '5.3.1 |'));
        api.score = edited;
        api.scoreLoaded.trigger(edited);
        expect(store.getSnapshot().trackMix[1].mute).toBe(true);

        const other = scoreFromTex('\\track "Solo" \\staff 3.3.4 3.3.4 3.3.4 3.3.4');
        api.score = other;
        api.scoreLoaded.trigger(other);
        expect(store.getSnapshot().trackMix).toEqual({
            0: { mute: false, solo: false, volume: 1, transpose: 0, notationTranspose: 0, displayTranspose: 0 }
        });
    });

    it('renders alphaTex only without errors and reports where an error is', () => {
        api.renderScore.mockClear();
        const failed = store.loadTex('3.3.4 | x.y.z');
        expect(failed.rendered).toBe(false);
        const error = failed.diagnostics.find(d => d.severity === 'error')!;
        expect(error.code).toMatch(/^AT\d{3}$/);
        // `x.y.z` spans columns 9 to 13 of the first line.
        expect(error.start!.line).toBe(1);
        expect(error.start!.col).toBeGreaterThanOrEqual(9);
        expect(error.start!.col).toBeLessThanOrEqual(13);
        expect(api.renderScore).not.toHaveBeenCalled();

        const ok = store.loadTex('3.3.4 3.3.4 3.3.4 3.3.4', { reuseViewport: true });
        expect(ok.rendered).toBe(true);
        expect(api.renderScore).toHaveBeenCalledWith(expect.anything(), undefined, { reuseViewport: true });
    });

    it('loads score JSON through the normal player path and reparses it on reload', async () => {
        const source = { json: model.JsonConverter.scoreToJson(scoreFromTex(TEX)), name: 'converted.json' };
        api.renderScore.mockClear();
        await store.loadSource(source, { tracks: 'all' });
        const first = api.renderScore.mock.calls[0][0] as model.Score;
        expect(first.tracks.map(track => track.name)).toEqual(['Lead', 'Bass']);
        expect(api.renderScore.mock.calls[0][1]).toEqual([-1]);
        first.title = 'Changed in memory';
        await store.loadSource(source, { tracks: [1] });
        const second = api.renderScore.mock.calls[1][0] as model.Score;
        expect(second === first).toBe(false);
        expect(second.title).not.toBe('Changed in memory');
        expect(api.renderScore.mock.calls[1][1]).toEqual([1]);
    });

    it('keeps the previous score on malformed JSON and supersedes a pending URL', async () => {
        api.renderScore.mockClear();
        await expect(store.loadSource({ json: '{invalid' })).rejects.toThrow();
        expect(api.renderScore).not.toHaveBeenCalled();

        let resolveFetch!: (response: Response) => void;
        const pendingResponse = new Promise<Response>(resolve => { resolveFetch = resolve; });
        vi.stubGlobal('fetch', vi.fn(() => pendingResponse));
        try {
            const pending = store.loadSource({ url: '/older.gp' });
            await store.loadSource({ json: model.JsonConverter.scoreToJson(scoreFromTex(TEX)) });
            resolveFetch(new Response(new Uint8Array([0])));
            await pending;
            expect(api.renderScore).toHaveBeenCalledTimes(1);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
