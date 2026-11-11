// Revision mappings adapted from Metaphysics0/songsterr-downloader (MIT).
// Copyright 2026 Ryan Roberts. See ../../licenses/songsterr-downloader-MIT.txt.
import { Settings, model, midi, exporter } from '@coderline/alphatab';
import { PercussionMapper } from '@coderline/alphatab/model/PercussionMapper';
import { integer, record, shortText, type SongsterrSource } from './acquire';
import { ImportError } from './errors';
import { IMPORT_FORMAT, MAX_SCORE_BYTES } from './shared';

export const CONVERSION_LIMITS = {
    bars: 2048,
    voices: 4,
    beatsPerVoice: 256,
    beats: 20000,
    midiEvents: 100000
} as const;
const durations = [
    model.Duration.Whole,
    model.Duration.Half,
    model.Duration.Quarter,
    model.Duration.Eighth,
    model.Duration.Sixteenth,
    model.Duration.ThirtySecond,
    model.Duration.SixtyFourth,
    model.Duration.OneHundredTwentyEighth,
    model.Duration.TwoHundredFiftySixth
];
const dynamics = new Map([
    ['ppp', model.DynamicValue.PPP],
    ['pp', model.DynamicValue.PP],
    ['p', model.DynamicValue.P],
    ['mp', model.DynamicValue.MP],
    ['mf', model.DynamicValue.MF],
    ['f', model.DynamicValue.F],
    ['ff', model.DynamicValue.FF],
    ['fff', model.DynamicValue.FFF]
]);
const harmonics = new Map([
    ['natural', model.HarmonicType.Natural],
    ['artificial', model.HarmonicType.Artificial],
    ['pinch', model.HarmonicType.Pinch],
    ['tap', model.HarmonicType.Tap],
    ['semi', model.HarmonicType.Semi],
    ['feedback', model.HarmonicType.Feedback]
]);
const tuplets = new Map([
    [3, 2],
    [5, 4],
    [6, 4],
    [7, 4],
    [9, 8],
    [10, 8],
    [12, 8]
]);

function array(value: unknown, min: number, max: number, location: string): unknown[] {
    if (!Array.isArray(value) || value.length < min || value.length > max) {
        throw new ImportError(`Invalid ${location}: expected ${min}-${max} entries. No tracks were imported.`);
    }
    return value;
}

function flag(value: unknown, location: string): boolean {
    if (value === undefined) {
        return false;
    }
    if (typeof value !== 'boolean') {
        throw new ImportError(`Invalid ${location}: expected a boolean.`);
    }
    return value;
}

function finite(value: unknown, min: number, max: number, location: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new ImportError(`Invalid ${location}: number is out of range.`);
    }
    return value;
}

function text(value: unknown, location: string): string {
    return shortText(typeof value === 'string' || value === undefined ? value : record(value, location).text, location);
}

function duration(value: unknown, location: string): { duration: model.Duration; dots: number } {
    const pair = array(value, 2, 2, `${location} duration`);
    const fraction =
        integer(pair[0], 1, 1024, `${location} duration numerator`) /
        integer(pair[1], 1, 4096, `${location} duration denominator`);
    for (const candidate of durations) {
        for (let dots = 0; dots <= 3; dots++) {
            if (Math.abs((2 - 1 / 2 ** dots) / candidate - fraction) < 0.000001) {
                return { duration: candidate, dots };
            }
        }
    }
    throw new ImportError(
        `Unsupported duration at ${location}. Timing was not approximated; use an authorized Guitar Pro file instead.`
    );
}

export function convertSongsterr(source: SongsterrSource, exportGuitarPro = false): string {
    const warnings = new Set<string>();
    const warn = (message: string): void => {
        if (warnings.size < 30) {
            warnings.add(message);
        } else {
            warnings.add(
                'Additional unsupported fields were not imported. Use the original Guitar Pro file for full fidelity.'
            );
        }
    };
    function fields(data: Record<string, unknown>, known: string[], kind: string): void {
        for (const key of Object.keys(data)) {
            if (!known.includes(key)) {
                warn(`Unsupported ${kind} field "${key.slice(0, 60)}" was not imported.`);
            }
        }
    }
    let beatCount = 0;
    function newBeat(): model.Beat {
        if (++beatCount > CONVERSION_LIMITS.beats) {
            throw new ImportError(`The score exceeds the ${CONVERSION_LIMITS.beats}-beat URL import limit.`);
        }
        return new model.Beat();
    }
    const entries = source.tracks.map(entry => ({
        ...entry,
        measures: array(entry.revision.measures, 1, CONVERSION_LIMITS.bars, 'track measures').map((value, i) =>
            record(value, `measure ${i + 1}`)
        )
    }));
    if (!entries.length || entries.length > 16) {
        throw new ImportError('URL import requires 1-16 complete tracks.');
    }
    const barCount = entries[0].measures.length;
    if (entries.some(entry => entry.measures.length !== barCount)) {
        throw new ImportError(
            'The revision has inconsistent track lengths. No tracks were omitted or padded; use an authorized Guitar Pro file.'
        );
    }
    const score = new model.Score();
    const tiedNotes: model.Note[] = [];
    score.title = source.title;
    score.artist = source.artist;
    score.tab = 'Imported locally by alphaTab';
    score.notices = `Source: ${source.url}\nSongsterr revision: ${source.revisionId}`;
    let numerator = 4;
    let denominator = 4;
    for (let index = 0; index < barCount; index++) {
        const measures = entries.map(entry => entry.measures[index]);
        for (const measure of measures) {
            fields(
                measure,
                [
                    'voices',
                    'signature',
                    'marker',
                    'repeatStart',
                    'repeat',
                    'repeatCount',
                    'alternateEnding',
                    'doubleBarline',
                    'rest'
                ],
                'measure'
            );
        }
        function globalValue(key: string): unknown {
            const values = measures.map(measure => measure[key]).filter(value => value !== undefined);
            if (values.some(value => JSON.stringify(value) !== JSON.stringify(values[0]))) {
                throw new ImportError(`Conflicting ${key} across tracks in measure ${index + 1}.`);
            }
            return values[0];
        }
        const signature = globalValue('signature');
        if (signature !== undefined) {
            const pair = array(signature, 2, 2, 'time signature');
            numerator = integer(pair[0], 1, 32, 'time signature numerator');
            denominator = integer(pair[1], 1, 64, 'time signature denominator');
            if (!durations.includes(denominator)) {
                throw new ImportError('Unsupported time signature denominator.');
            }
        } else if (index === 0) {
            throw new ImportError('The score has no initial time signature. Timing was not guessed.');
        }
        const bar = new model.MasterBar();
        bar.timeSignatureNumerator = numerator;
        bar.timeSignatureDenominator = denominator;
        bar.isRepeatStart = flag(globalValue('repeatStart'), 'repeat start');
        const repeats = globalValue('repeat') ?? globalValue('repeatCount');
        if (repeats !== undefined) {
            bar.repeatCount = integer(repeats, 0, 8, 'repeat count');
        }
        const ending = globalValue('alternateEnding');
        if (Array.isArray(ending)) {
            for (const value of array(ending, 0, 8, 'alternate endings')) {
                bar.alternateEndings |= 1 << (integer(value, 1, 8, 'alternate ending') - 1);
            }
        } else if (ending !== undefined) {
            bar.alternateEndings = integer(ending, 0, 255, 'alternate endings');
        }
        bar.isDoubleBar = flag(globalValue('doubleBarline'), 'double barline');
        const marker = globalValue('marker');
        if (marker !== undefined) {
            bar.section = new model.Section();
            bar.section.text = text(marker, 'section marker');
        }
        score.addMasterBar(bar);
    }

    const tempos = new Map<string, { measure: number; position: number; bpm: number }>();
    for (const { revision } of entries) {
        if (revision.automations === undefined) {
            continue;
        }
        const automations = record(revision.automations, 'automations');
        fields(automations, ['tempo'], 'automation');
        if (automations.tempo === undefined) {
            continue;
        }
        for (const raw of array(automations.tempo, 0, 4096, 'tempo automations')) {
            const point = record(raw, 'tempo automation');
            fields(point, ['measure', 'position', 'type', 'bpm'], 'tempo');
            const measure = integer(point.measure, 0, barCount - 1, 'tempo measure');
            const bar = score.masterBars[measure];
            const wholeNotes =
                finite(point.position, 0, 64, 'tempo position') / integer(point.type, 1, 256, 'tempo unit');
            const position = wholeNotes / (bar.timeSignatureNumerator / bar.timeSignatureDenominator);
            if (position > 1) {
                throw new ImportError('A tempo change lies outside its measure.');
            }
            const bpm = finite(point.bpm, 20, 400, 'tempo');
            const key = `${measure}:${position}`;
            const prior = tempos.get(key);
            if (prior && prior.bpm !== bpm) {
                throw new ImportError('Tracks disagree on the tempo. No tracks were imported.');
            }
            tempos.set(key, { measure, position, bpm });
        }
    }
    if (!tempos.has('0:0')) {
        throw new ImportError('The score has no initial tempo. Playback speed was not guessed.');
    }
    for (const point of [...tempos.values()].sort((a, b) => a.measure - b.measure || a.position - b.position)) {
        score.masterBars[point.measure].tempoAutomations.push(
            model.Automation.buildTempoAutomation(false, point.position, point.bpm, 2, true)
        );
    }

    function mapNote(
        data: Record<string, unknown>,
        beatData: Record<string, unknown>,
        track: model.Track,
        tuning: number[],
        drums: boolean,
        location: string
    ): model.Note {
        fields(
            data,
            [
                'fret',
                'string',
                'tie',
                'slide',
                'rest',
                'dead',
                'ghost',
                'hp',
                'staccato',
                'accentuated',
                'vibrato',
                'wideVibrato',
                'leftHandVibrato',
                'harmonic',
                'harmonicFret',
                'bend'
            ],
            'note'
        );
        const note = new model.Note();
        const tied = flag(data.tie, 'tie');
        const dead = flag(data.dead, 'dead note');
        const fret =
            data.fret === undefined && (tied || dead) && !drums ? 0 : integer(data.fret, 0, 127, `${location} fret`);
        if (drums) {
            // Percussion carries an articulation ID, not a string fret.
            note.string = -1;
            const articulation = PercussionMapper.getArticulationById(fret);
            if (!articulation) {
                throw new ImportError(`Unsupported percussion articulation ${fret} at ${location}.`);
            }
            // GP files reference track-local articulation indices, not the legacy global IDs.
            note.percussionArticulation = track.getOrRegisterPercussionArticulation(articulation);
        } else {
            note.fret = fret;
            const string = integer(data.string, 0, tuning.length - 1, `${location} string`);
            if (tuning[string] + note.fret > 127) {
                throw new ImportError(`Pitch exceeds MIDI range at ${location}.`);
            }
            note.string = tuning.length - string;
        }
        note.isTieDestination = tied;
        if (tied) {
            tiedNotes.push(note);
        }
        note.isDead = dead;
        note.isGhost = flag(data.ghost, 'ghost note');
        note.isHammerPullOrigin = flag(data.hp, 'hammer-on/pull-off');
        note.isStaccato = flag(data.staccato, 'staccato');
        note.isPalmMute = flag(beatData.palmMute, 'palm mute');
        note.isLetRing = flag(beatData.letRing, 'let ring');
        const accentValue =
            data.accentuated === undefined || data.accentuated === false
                ? 0
                : data.accentuated === true
                  ? 1
                  : data.accentuated;
        const accent = integer(accentValue, 0, 2, 'accentuation level');
        note.accentuated =
            accent === 2
                ? model.AccentuationType.Heavy
                : accent === 1
                  ? model.AccentuationType.Normal
                  : model.AccentuationType.None;
        let leftHandVibrato = model.VibratoType.None;
        if (data.leftHandVibrato !== undefined) {
            switch (shortText(data.leftHandVibrato, 'left-hand vibrato').toLowerCase()) {
                case 'slight':
                    leftHandVibrato = model.VibratoType.Slight;
                    break;
                case 'wide':
                    leftHandVibrato = model.VibratoType.Wide;
                    break;
                case 'none':
                    break;
                default:
                    throw new ImportError(`Unsupported left-hand vibrato at ${location}.`);
            }
        }
        note.vibrato =
            flag(data.wideVibrato, 'wide vibrato') || leftHandVibrato === model.VibratoType.Wide
                ? model.VibratoType.Wide
                : flag(data.vibrato, 'vibrato') || leftHandVibrato === model.VibratoType.Slight
                  ? model.VibratoType.Slight
                  : model.VibratoType.None;
        if (data.slide !== undefined) {
            switch (shortText(data.slide, 'slide').toLowerCase()) {
                case 'shift':
                    note.slideOutType = model.SlideOutType.Shift;
                    break;
                case 'legato':
                    note.slideOutType = model.SlideOutType.Legato;
                    break;
                case 'below':
                case 'into_from_below':
                    note.slideInType = model.SlideInType.IntoFromBelow;
                    break;
                case 'into_from_above':
                    note.slideInType = model.SlideInType.IntoFromAbove;
                    break;
                case 'out_up':
                    note.slideOutType = model.SlideOutType.OutUp;
                    break;
                case 'downwards':
                case 'out_down':
                    note.slideOutType = model.SlideOutType.OutDown;
                    break;
                default:
                    throw new ImportError(`Unsupported slide at ${location}.`);
            }
        }
        if (data.harmonic !== undefined) {
            const type = harmonics.get(shortText(data.harmonic, 'harmonic').toLowerCase());
            if (type === undefined) {
                throw new ImportError(`Unsupported harmonic at ${location}.`);
            }
            note.harmonicType = type;
            note.harmonicValue =
                data.harmonicFret === undefined && type === model.HarmonicType.Natural
                    ? note.fret
                    : finite(data.harmonicFret, 0.1, 48, 'harmonic fret');
        }
        if (data.bend !== undefined) {
            const bend = record(data.bend, 'bend');
            fields(bend, ['tone', 'points'], 'bend');
            note.bendType = model.BendType.Custom;
            let priorOffset = -1;
            for (const raw of array(bend.points, 1, 32, 'bend points')) {
                const point = record(raw, 'bend point');
                const offset = finite(point.position, 0, 60, 'bend position');
                const value = finite(point.tone, 0, 600, 'bend tone') / 25;
                if (offset < priorOffset || !Number.isInteger(offset) || !Number.isInteger(value)) {
                    throw new ImportError(`Unsupported bend precision at ${location}.`);
                }
                priorOffset = offset;
                note.addBendPoint(new model.BendPoint(offset, value));
            }
        }
        return note;
    }

    function mapBeat(
        data: Record<string, unknown>,
        track: model.Track,
        tuning: number[],
        drums: boolean,
        location: string
    ): model.Beat {
        fields(
            data,
            [
                'notes',
                'type',
                'duration',
                'dots',
                'text',
                'velocity',
                'rest',
                'palmMute',
                'letRing',
                'slapping',
                'popping',
                'tapping',
                'tremolo',
                'gradualVelocity',
                'vibrato',
                'wideVibrato',
                'vibratoWithTremoloBar',
                'pickStroke',
                'tuplet',
                'tupletStart',
                'tupletStop',
                'graceNote'
            ],
            'beat'
        );
        const beat = newBeat();
        beat.slap = flag(data.slapping, 'slapping');
        beat.pop = flag(data.popping, 'popping');
        beat.tap = flag(data.tapping, 'tapping');
        const tuplet = data.tuplet === undefined ? 1 : integer(data.tuplet, 1, 12, 'tuplet');
        const mapped = duration(
            tuplet > 1 ? [1, integer(data.type, 1, 256, 'tuplet note type')] : data.duration,
            location
        );
        beat.duration = mapped.duration;
        beat.dots = data.dots === undefined ? mapped.dots : integer(data.dots, 0, 3, 'dots');
        if (data.tremolo !== undefined) {
            const subdivision = duration(data.tremolo, `${location} tremolo`);
            const marks = Math.log2(subdivision.duration / beat.duration);
            if (
                subdivision.dots !== 0 ||
                !Number.isInteger(marks) ||
                marks < 1 ||
                marks > model.TremoloPickingEffect.maxMarks
            ) {
                throw new ImportError(`Unsupported tremolo subdivision at ${location}. Timing was not approximated.`);
            }
            beat.tremoloPicking = new model.TremoloPickingEffect();
            beat.tremoloPicking.marks = marks;
        }
        if (data.gradualVelocity !== undefined) {
            switch (shortText(data.gradualVelocity, 'gradual dynamics').toLowerCase()) {
                case 'crescendo':
                    beat.crescendo = model.CrescendoType.Crescendo;
                    break;
                case 'decrescendo':
                    beat.crescendo = model.CrescendoType.Decrescendo;
                    break;
                default:
                    throw new ImportError(`Unsupported gradual dynamics at ${location}.`);
            }
        }
        if (tuplet > 1) {
            const denominator = tuplets.get(tuplet);
            if (!denominator) {
                throw new ImportError(`Unsupported tuplet at ${location}.`);
            }
            beat.tupletNumerator = tuplet;
            beat.tupletDenominator = denominator;
        }
        if (data.graceNote !== undefined) {
            const grace = shortText(data.graceNote, 'grace note').toLowerCase();
            if (grace !== 'beforebeat' && grace !== 'onbeat') {
                throw new ImportError(`Unsupported grace note at ${location}.`);
            }
            beat.graceType = grace === 'beforebeat' ? model.GraceType.BeforeBeat : model.GraceType.OnBeat;
        }
        if (data.velocity !== undefined) {
            const dynamic = dynamics.get(shortText(data.velocity, 'velocity').toLowerCase());
            if (dynamic === undefined) {
                throw new ImportError(`Unsupported dynamics at ${location}.`);
            }
            beat.dynamics = dynamic;
        }
        if (data.pickStroke !== undefined) {
            const pick = shortText(data.pickStroke, 'pick stroke').toLowerCase();
            if (pick !== 'up' && pick !== 'down') {
                throw new ImportError(`Unsupported pick stroke at ${location}.`);
            }
            beat.pickStroke = pick === 'up' ? model.PickStroke.Up : model.PickStroke.Down;
        }
        beat.text = data.text === undefined ? null : text(data.text, 'beat text');
        beat.vibrato = flag(data.wideVibrato, 'wide vibrato')
            ? model.VibratoType.Wide
            : flag(data.vibrato, 'vibrato')
              ? model.VibratoType.Slight
              : model.VibratoType.None;
        if (flag(data.vibratoWithTremoloBar, 'tremolo-bar vibrato')) {
            throw new ImportError(
                `Tremolo-bar vibrato is not supported at ${location}. Use an authorized Guitar Pro file.`
            );
        }
        if (data.notes === undefined && !flag(data.rest, 'rest')) {
            throw new ImportError(`Missing notes or explicit rest at ${location}.`);
        }
        const notes = array(data.notes === undefined ? [] : data.notes, 0, 12, `${location} notes`).map(value =>
            record(value, 'note')
        );
        if (flag(data.rest, 'rest') && notes.some(note => !flag(note.rest, 'note rest'))) {
            throw new ImportError(`A rest contains sounding notes at ${location}.`);
        }
        for (const note of notes) {
            if (!flag(note.rest, 'note rest')) {
                beat.addNote(mapNote(note, data, track, tuning, drums, location));
            }
        }
        return beat;
    }

    let nextChannel = 0;
    for (const { metadata, revision, measures } of entries) {
        fields(
            revision,
            ['name', 'instrumentId', 'tuning', 'strings', 'measures', 'automations', 'songId', 'revisionId', 'partId'],
            'track'
        );
        const instrument = integer(metadata.instrumentId ?? revision.instrumentId, 0, 1024, 'instrument');
        const drums = instrument === 1024 || metadata.isDrums === true;
        if (!drums && instrument > 127) {
            throw new ImportError('Unsupported MIDI instrument. No instrument was silently replaced.');
        }
        const tuning = array(revision.tuning ?? metadata.tuning ?? [], drums ? 0 : 1, 12, 'tuning').map(value =>
            integer(value, 0, 127, 'tuning pitch')
        );
        const track = new model.Track();
        track.name =
            metadata.title || metadata.name || shortText(revision.name, 'track name', `Track ${metadata.partId + 1}`);
        track.shortName = track.name.slice(0, 20);
        if (nextChannel === 9) {
            nextChannel++;
        }
        if (!drums && nextChannel > 15) {
            throw new ImportError('URL import supports at most 15 melodic tracks plus percussion.');
        }
        const channel = drums ? 9 : nextChannel++;
        track.playbackInfo.primaryChannel = channel;
        track.playbackInfo.secondaryChannel = channel;
        track.playbackInfo.program = drums ? 0 : instrument;
        const staff = new model.Staff();
        staff.isPercussion = drums;
        if (!drums) {
            staff.stringTuning = new model.Tuning('Imported tuning', tuning, false);
        }
        const restMeasures = measures.map(measure => flag(measure.rest, 'measure rest'));
        const voices = measures.map((measure, index) => {
            const values = array(measure.voices ?? [], 0, CONVERSION_LIMITS.voices, `measure ${index + 1} voices`);
            if (!values.length && !restMeasures[index]) {
                throw new ImportError(`Track ${metadata.partId}, measure ${index + 1} has no voices or explicit rest.`);
            }
            return values.map(value => record(value, 'voice'));
        });
        const maxVoices = Math.max(1, ...voices.map(value => value.length));
        for (let measureIndex = 0; measureIndex < barCount; measureIndex++) {
            const bar = new model.Bar();
            for (let voiceIndex = 0; voiceIndex < maxVoices; voiceIndex++) {
                const voice = new model.Voice();
                const data = voices[measureIndex][voiceIndex];
                if (data) {
                    fields(data, ['beats', 'rest'], 'voice');
                }
                const restVoice = data ? flag(data.rest, 'voice rest') : true;
                const beats = data ? array(data.beats ?? [], 0, CONVERSION_LIMITS.beatsPerVoice, 'voice beats') : [];
                if (data && !beats.length && !restVoice) {
                    throw new ImportError(
                        `Track ${metadata.partId}, measure ${measureIndex + 1} contains an empty voice.`
                    );
                }
                if (!beats.length) {
                    const rest = newBeat();
                    rest.duration = model.Duration.Whole;
                    voice.addBeat(rest);
                } else {
                    for (const [beatIndex, value] of beats.entries()) {
                        const beat = mapBeat(
                            record(value, 'beat'),
                            track,
                            tuning,
                            drums,
                            `track ${metadata.partId}, measure ${measureIndex + 1}, voice ${voiceIndex + 1}, beat ${beatIndex + 1}`
                        );
                        if ((restMeasures[measureIndex] || restVoice) && beat.notes.length > 0) {
                            throw new ImportError('A rest marker contains sounding notes; no notes were discarded.');
                        }
                        voice.addBeat(beat);
                    }
                }
                bar.addVoice(voice);
            }
            staff.addBar(bar);
        }
        track.addStaff(staff);
        score.addTrack(track);
    }
    const settings = new Settings();
    score.finish(settings);
    if (tiedNotes.some(note => !note.tieOrigin)) {
        throw new ImportError('A tied note has no matching origin. Its pitch was not guessed.');
    }
    for (const track of score.tracks) {
        for (const bar of track.staves[0].bars) {
            const expected = score.masterBars[bar.index].calculateDuration();
            for (const voice of bar.voices) {
                const actual = voice.beats
                    .filter(beat => beat.graceType === model.GraceType.None)
                    .reduce((sum, beat) => sum + beat.playbackDuration, 0);
                if (actual > expected + 1) {
                    throw new ImportError(
                        `Track "${track.name}", measure ${bar.index + 1} exceeds its time signature. Timing was not truncated.`
                    );
                }
                if (actual < expected - 1) {
                    warn('Some voices are shorter than their time signature; the remaining measure time is silent.');
                }
            }
        }
    }
    const file = new midi.MidiFile();
    new midi.MidiFileGenerator(score, settings, new midi.AlphaSynthMidiFileHandler(file, true)).generate();
    if (file.tracks.some(track => track.events.some(event => !Number.isFinite(event.tick) || event.tick < 0))) {
        throw new ImportError('The converted score has an invalid playback timeline. No score was imported.');
    }
    if (file.tracks.reduce((total, track) => total + track.events.length, 0) > CONVERSION_LIMITS.midiEvents) {
        throw new ImportError('The expanded playback timeline exceeds the URL import resource limit.');
    }
    const guitarPro = exportGuitarPro ? new exporter.Gp7Exporter().export(score, settings) : undefined;
    if (guitarPro && guitarPro.byteLength > MAX_SCORE_BYTES) {
        throw new ImportError('The Guitar Pro export exceeds the 25 MB import limit.');
    }
    const body = JSON.stringify({
        format: IMPORT_FORMAT,
        source: { url: source.url, songId: source.songId, revisionId: source.revisionId },
        score: JSON.parse(model.JsonConverter.scoreToJson(score)),
        warnings: [...warnings],
        guitarPro: guitarPro
            ? Buffer.from(guitarPro.buffer, guitarPro.byteOffset, guitarPro.byteLength).toString('base64')
            : undefined
    });
    if (Buffer.byteLength(body) > MAX_SCORE_BYTES) {
        throw new ImportError('The converted score exceeds the 25 MB import limit.');
    }
    return body;
}
