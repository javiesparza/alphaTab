import { model } from '@coderline/alphatab';
import { useAlphaTabApi } from '@coderline/alphatab-react';
import type { ScoreDocumentState } from '@coderline/alphatab-ui';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { type LibraryDirectoryHandle, saveGuitarProFile } from '../library/browser-library';
import type { ScoreLibraryController } from '../library/ScoreLibraryPanel';
import {
    IMPORT_META_NAME,
    IMPORT_PATH,
    type ImportedSongsterrScore,
    isRecord,
    MAX_SCORE_BYTES,
    readBoundedResponse,
    readImportedScore,
    songsterrUrl
} from './shared';
import styles from '../player/import-panel.module.scss';

interface Notice {
    kind: 'status' | 'error';
    message: string;
}

interface ImportedInfo extends Pick<ImportedSongsterrScore, 'source' | 'warnings'> {
    saved?: { fileName: string; folderName: string };
}

export function useSongsterrImport(
    doc: ScoreDocumentState,
    library?: Pick<ScoreLibraryController, 'supported' | 'name' | 'authorize' | 'refresh'>
) {
    const api = useAlphaTabApi();
    const apiRef = useRef(api);
    apiRef.current = api;
    const enabled = document.querySelector(`meta[name="${IMPORT_META_NAME}"][content="enabled"]`) !== null;
    const [url, setUrl] = useState('');
    const [authorized, setAuthorized] = useState(false);
    const [saveToLibrary, setSaveToLibrary] = useState(library?.supported ?? false);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<Notice | null>(null);
    const [imported, setImported] = useState<ImportedInfo | null>(null);
    const generation = useRef(0);
    const request = useRef<AbortController | null>(null);
    const saving = useRef(false);
    const documentOpenFile = doc.openFile;
    const documentOpenSample = doc.openSample;

    useEffect(
        () => () => {
            ++generation.current;
            request.current?.abort();
        },
        []
    );

    const abort = useCallback(() => {
        ++generation.current;
        request.current?.abort();
        request.current = null;
        saving.current = false;
        setBusy(false);
    }, []);

    const cancel = useCallback(() => {
        const wasSaving = saving.current;
        abort();
        setNotice({
            kind: 'status',
            message: wasSaving
                ? 'Canceled. The previous score is unchanged; check the folder in case the save had already completed.'
                : 'Import canceled. The previous score is unchanged.'
        });
    }, [abort]);

    const cancelPending = useCallback(() => {
        abort();
        setNotice(null);
    }, [abort]);

    const openFile = useCallback(
        async (source: File | FileSystemFileHandle) => {
            abort();
            const token = generation.current;
            const controller = new AbortController();
            request.current = controller;
            setBusy(true);
            setNotice({ kind: 'status', message: `Opening ${source.name}...` });
            try {
                const file = source instanceof File ? source : await source.getFile();
                controller.signal.throwIfAborted();
                await documentOpenFile(file, controller.signal);
                if (generation.current === token) {
                    setImported(null);
                    setNotice(null);
                }
            } catch (error) {
                if (generation.current === token) {
                    setNotice({
                        kind: 'error',
                        message: error instanceof Error ? error.message : 'The local file could not be opened.'
                    });
                }
            } finally {
                if (generation.current === token) {
                    request.current = null;
                    setBusy(false);
                }
            }
        },
        [abort, documentOpenFile]
    );

    const submit = useCallback(async () => {
        abort();
        const token = generation.current;
        const controller = new AbortController();
        request.current = controller;
        let timeout: number | undefined;
        setBusy(true);
        setNotice({ kind: 'status', message: 'Preparing the import...' });
        try {
            if (!enabled) {
                throw new Error('Start npm run dev:imports to enable the local URL importer.');
            }
            if (!api) {
                throw new Error('Wait for the player to initialize before importing.');
            }
            if (!authorized) {
                throw new Error('Confirm that you own or have permission to use this score.');
            }
            const target = songsterrUrl(url);
            let saveDirectory: LibraryDirectoryHandle | undefined;
            if (saveToLibrary && library?.supported) {
                saveDirectory = await library.authorize();
                controller.signal.throwIfAborted();
            }
            timeout = window.setTimeout(
                () => controller.abort(new Error('The local import timed out. No score was imported.')),
                60000
            );
            setNotice({ kind: 'status', message: 'Importing the current revision and all tracks...' });
            const response = await fetch(IMPORT_PATH, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'omit',
                signal: controller.signal,
                body: JSON.stringify({
                    url: target.url,
                    authorized: true,
                    ...(saveDirectory ? { exportGuitarPro: true } : {})
                })
            });
            const bytes = await readBoundedResponse(
                response,
                MAX_SCORE_BYTES,
                'The converted score exceeds the 25 MB import limit.'
            );
            let body: unknown;
            try {
                body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            } catch {
                throw new Error(
                    'The local import service returned an invalid response. Start npm run dev:imports and try again.'
                );
            }
            if (!response.ok) {
                throw new Error(
                    isRecord(body) && typeof body.error === 'string'
                        ? body.error
                        : `The import failed (HTTP ${response.status}).`
                );
            }
            if (generation.current !== token) {
                return;
            }
            controller.signal.throwIfAborted();
            window.clearTimeout(timeout);
            timeout = undefined;
            if (apiRef.current !== api) {
                throw new Error('The player changed while importing. Please try again.');
            }
            const result = readImportedScore(body);
            if (result.source.url !== target.url) {
                throw new Error('The service returned a different score than the requested URL.');
            }
            const score = model.JsonConverter.jsonToScore(result.json, api.settings);
            if (!score.tracks.length || !score.masterBars.length) {
                throw new Error('The imported score contains no playable tracks or measures.');
            }
            let saved: ImportedInfo['saved'];
            if (saveDirectory) {
                if (!result.guitarPro) {
                    throw new Error('The import service did not return a Guitar Pro file. Nothing was saved.');
                }
                saving.current = true;
                setNotice({ kind: 'status', message: `Saving a Guitar Pro copy in ${saveDirectory.name}...` });
                let file: File | undefined;
                try {
                    const title = [score.artist, score.title || `Songsterr ${result.source.songId}`]
                        .filter(Boolean)
                        .join(' - ');
                    file = await saveGuitarProFile(
                        saveDirectory,
                        result.guitarPro,
                        `${title} [s${result.source.songId}-r${result.source.revisionId}]`,
                        controller.signal
                    );
                } finally {
                    if (generation.current === token) {
                        saving.current = false;
                    }
                    await library?.refresh(generation.current === token ? file?.name : undefined);
                }
                if (generation.current !== token) {
                    return;
                }
                controller.signal.throwIfAborted();
                if (!file) {
                    throw new Error('The saved Guitar Pro file is unavailable.');
                }
                await documentOpenFile(file, controller.signal);
                saved = { fileName: file.name, folderName: saveDirectory.name };
            } else {
                const fileName = `${score.title || `Songsterr ${result.source.songId}`}.json`;
                documentOpenSample({
                    id: `songsterr:${result.source.songId}:${result.source.revisionId}`,
                    fileName,
                    color: 'var(--at-track-blue)',
                    source: { json: result.json, name: fileName }
                });
            }
            if (generation.current !== token) {
                return;
            }
            setImported({ source: result.source, warnings: result.warnings, saved });
            setNotice({
                kind: 'status',
                message: `Imported ${score.tracks.length} ${score.tracks.length === 1 ? 'track' : 'tracks'} from revision ${result.source.revisionId}.${saved ? ` Saved a .gp copy in ${saved.folderName}.` : ''}`
            });
        } catch (error) {
            if (generation.current === token) {
                const reason = controller.signal.aborted ? controller.signal.reason : error;
                setNotice({
                    kind: 'error',
                    message:
                        reason instanceof Error
                            ? reason.message
                            : 'The URL import failed. The previous score is unchanged.'
                });
            }
        } finally {
            if (timeout !== undefined) {
                window.clearTimeout(timeout);
            }
            if (generation.current === token) {
                request.current = null;
                saving.current = false;
                setBusy(false);
            }
        }
    }, [abort, api, authorized, documentOpenFile, documentOpenSample, enabled, library, saveToLibrary, url]);

    return {
        enabled,
        url,
        setUrl,
        authorized,
        setAuthorized,
        saveToLibrary,
        setSaveToLibrary,
        folderSavingSupported: library?.supported ?? false,
        folderName: library?.name,
        busy,
        notice,
        imported,
        submit,
        cancel,
        cancelPending,
        openFile
    };
}

export function SongsterrImportPanel({ importer }: { importer: ReturnType<typeof useSongsterrImport> }) {
    const id = useId();
    return (
        <section className={styles.panel} aria-label="Songsterr import">
            <details>
                <summary>Import a Songsterr URL</summary>
                {importer.enabled ? (
                    <form
                        onSubmit={event => {
                            event.preventDefault();
                            void importer.submit();
                        }}
                        className={styles.form}
                        aria-busy={importer.busy}>
                        <label htmlFor={`${id}-url`}>Songsterr tab URL</label>
                        <div className={styles.row}>
                            <input
                                id={`${id}-url`}
                                type="url"
                                required
                                maxLength={2048}
                                value={importer.url}
                                onChange={event => {
                                    importer.setUrl(event.target.value);
                                    importer.setAuthorized(false);
                                }}
                                disabled={importer.busy}
                                placeholder="https://www.songsterr.com/a/wsa/your-score-tab-s123"
                                aria-describedby={`${id}-help`}
                            />
                            <button type="submit" className={styles.primary} disabled={importer.busy}>
                                {importer.busy ? 'Importing...' : 'Import score'}
                            </button>
                            {importer.busy && (
                                <button type="button" onClick={importer.cancel}>
                                    Cancel
                                </button>
                            )}
                        </div>
                        <label className={styles.permission}>
                            <input
                                type="checkbox"
                                required
                                checked={importer.authorized}
                                onChange={event => importer.setAuthorized(event.target.checked)}
                                disabled={importer.busy}
                            />
                            I own or have permission to use this score.
                        </label>
                        {importer.folderSavingSupported && (
                            <label className={styles.permission}>
                                <input
                                    type="checkbox"
                                    checked={importer.saveToLibrary}
                                    onChange={event => importer.setSaveToLibrary(event.target.checked)}
                                    disabled={importer.busy}
                                />
                                Save a .gp copy in {importer.folderName ?? 'the connected folder'}.
                            </label>
                        )}
                        <p id={`${id}-help`} className={styles.help}>
                            The local server contacts Songsterr. No sign-in, paid access, rate limit or verification is
                            bypassed. Local files are never uploaded. URL conversion may not preserve every notation
                            detail; use an authorized Guitar Pro file for full fidelity.
                        </p>
                    </form>
                ) : (
                    <p className={styles.help}>
                        Start <code>npm run dev:imports</code> to enable the optional loopback-only importer. File
                        upload and drag-and-drop work without it.
                    </p>
                )}
            </details>
            {importer.notice && (
                <p
                    className={importer.notice.kind === 'error' ? styles.error : styles.notice}
                    role={importer.notice.kind === 'error' ? 'alert' : 'status'}>
                    {importer.notice.message}
                </p>
            )}
            {importer.imported && (
                <div className={styles.provenance}>
                    <a href={importer.imported.source.url} target="_blank" rel="noopener noreferrer">
                        Source on Songsterr
                    </a>{' '}
                    (revision {importer.imported.source.revisionId}).
                    {importer.imported.saved ? (
                        <>
                            {' '}
                            Saved as <strong>{importer.imported.saved.fileName}</strong> in{' '}
                            {importer.imported.saved.folderName}.
                        </>
                    ) : (
                        ' The converted score stays in this page only.'
                    )}
                    {importer.imported.warnings.length > 0 && (
                        <details>
                            <summary>Conversion limitations ({importer.imported.warnings.length})</summary>
                            <ul>
                                {importer.imported.warnings.map(warning => (
                                    <li key={warning}>{warning}</li>
                                ))}
                            </ul>
                        </details>
                    )}
                </div>
            )}
        </section>
    );
}
