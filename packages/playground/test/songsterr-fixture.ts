import type { SongsterrSource, TrackMetadata } from '../src/songsterr/acquire';

// Original synthetic practice data, dedicated to CC0. No downloaded song data.
export function originalRevision(songId = 700001) {
    const metadata: TrackMetadata[] = [
        { partId: 0, instrumentId: 25, title: 'Study guitar', tuning: [64, 59, 55, 50, 45, 40] },
        { partId: 1, instrumentId: 34, title: 'Study bass', tuning: [43, 38, 33, 28] },
        { partId: 2, instrumentId: 1024, title: 'Study drums', isDrums: true }
    ];
    const quarter = (fret: number, string = 0) => ({ duration: [1, 4], type: 4, notes: [{ fret, string }] });
    const beats = [
        [quarter(0), quarter(2), quarter(3), quarter(5)],
        [quarter(0, 3), quarter(0, 3), quarter(2, 2), quarter(2, 2)],
        [quarter(36), quarter(38), quarter(42), quarter(38)]
    ];
    return {
        url: `https://www.songsterr.com/a/wsa/original-import-study-tab-s${songId}`,
        songId,
        revisionId: 12345,
        title: 'Original import study',
        artist: 'Original CC0 study',
        tracks: metadata.map((track, index) => ({
            metadata: track,
            revision: {
                songId,
                revisionId: 12345,
                partId: track.partId,
                name: track.title,
                instrumentId: track.instrumentId,
                tuning: track.tuning ?? [],
                automations: { tempo: [{ measure: 0, position: 0, type: 4, bpm: 96 }] },
                measures: [
                    { signature: [4, 4], marker: 'Original study', voices: [{ beats: structuredClone(beats[index]) }] },
                    { voices: [{ beats: structuredClone(beats[index]).reverse() }] }
                ]
            }
        }))
    };
}

export function pageState(source: SongsterrSource): string {
    return `<html><script type="application/json" id="state">${JSON.stringify({
        meta: {
            current: {
                songId: source.songId,
                revisionId: source.revisionId,
                image: 'self-authored-fixture',
                title: source.title,
                artist: source.artist,
                tracks: source.tracks.map(track => track.metadata)
            }
        }
    })}</script></html>`;
}

export function mockSongsterr(
    source: SongsterrSource = originalRevision(),
    override?: (url: string, init?: RequestInit) => Response | undefined | Promise<Response | undefined>
) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        const custom = await override?.(url, init);
        if (custom) {
            return custom;
        }
        if (url === source.url) {
            return new Response(pageState(source), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        for (const track of source.tracks) {
            if (
                url ===
                `https://dqsljvtekg760.cloudfront.net/${source.songId}/${source.revisionId}/self-authored-fixture/${track.metadata.partId}.json`
            ) {
                return Response.json(track.revision);
            }
        }
        throw new Error(`Unexpected mock upstream URL: ${url}`);
    };
    return { fetcher, calls };
}
