import { PlayerProvider, useScoreDocument } from '@coderline/alphatab-ui';
import { ScoreLibraryPanel, useScoreLibrary } from '../library/ScoreLibraryPanel';
import { DemoPlayerView } from '../player/DemoPlayerView';
import { playerSettings, singleSampleDocuments } from '../player/environment';
import { DevGlobals } from '../player/mount';
import { SongsterrImportPanel, useSongsterrImport } from '../songsterr/SongsterrImportPanel';
import { Paths } from '../util/Paths';

const SETTINGS = playerSettings();

const DOCUMENTS = singleSampleDocuments(
    {
        id: 'default',
        fileName: Paths.defaultScore.split('/').pop()!,
        color: 'var(--at-track-indigo)',
        source: { url: Paths.defaultScore }
    },
    { tracks: [0] }
);

/** The full player: tracks, transport, settings, downloads and drag-drop loading. */
export function ControlApp() {
    return (
        <PlayerProvider fonts="noto" settings={SETTINGS}>
            <DevGlobals />
            <ControlView />
        </PlayerProvider>
    );
}

function ControlView() {
    const doc = useScoreDocument(DOCUMENTS);
    const library = useScoreLibrary();
    const importer = useSongsterrImport(doc, library);
    return (
        <DemoPlayerView
            demo="control"
            doc={doc}
            onOpenFile={importer.openFile}
            beforeWorkspace={
                <>
                    <ScoreLibraryPanel
                        library={library}
                        onOpenFile={importer.openFile}
                        onBeforeChange={importer.cancelPending}
                    />
                    <SongsterrImportPanel importer={importer} />
                </>
            }
        />
    );
}
