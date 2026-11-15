import { useCallback, useEffect, useId, useRef, useState } from 'react';
import styles from '../player/import-panel.module.scss';
import {
    authorizeLibrary,
    chooseLibraryDirectory,
    folderAccessSupported,
    isNamedError,
    type LibraryDirectoryHandle,
    type LibraryEntry,
    listLibraryScores,
    loadRememberedDirectory,
    rememberDirectory
} from './browser-library';

interface LibraryNotice {
    error: boolean;
    message: string;
}

export function useScoreLibrary() {
    const supported = folderAccessSupported();
    const directory = useRef<LibraryDirectoryHandle | null>(null);
    const generation = useRef(0);
    const scan = useRef<AbortController | null>(null);
    const [name, setName] = useState<string | null>(null);
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const [files, setFiles] = useState<LibraryEntry[]>([]);
    const [selectedName, setSelectedName] = useState('');
    const [notice, setNotice] = useState<LibraryNotice | null>(null);

    const begin = useCallback(() => {
        scan.current?.abort();
        const controller = new AbortController();
        scan.current = controller;
        const token = ++generation.current;
        setBusy(true);
        return { token, controller };
    }, []);

    const showFolder = useCallback(
        async (handle: LibraryDirectoryHandle, token: number, signal: AbortSignal, preferredName?: string) => {
            if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
                throw new Error('Reconnect the folder to grant browser access again.');
            }
            const entries = await listLibraryScores(handle, signal);
            if (generation.current !== token) {
                return;
            }
            setFiles(entries);
            setReady(true);
            setSelectedName(current =>
                preferredName && entries.some(entry => entry.name === preferredName)
                    ? preferredName
                    : entries.some(entry => entry.name === current)
                      ? current
                      : ''
            );
        },
        []
    );

    const report = useCallback((error: unknown) => {
        setReady(false);
        setFiles([]);
        setSelectedName('');
        setNotice({
            error: true,
            message: error instanceof Error ? error.message : 'The folder could not be read.'
        });
    }, []);

    useEffect(() => {
        if (!supported) {
            return;
        }
        const { token, controller } = begin();
        void (async () => {
            try {
                const handle = await loadRememberedDirectory();
                if (generation.current !== token || !handle) {
                    return;
                }
                directory.current = handle;
                setName(handle.name);
                await showFolder(handle, token, controller.signal);
            } catch (error) {
                if (generation.current === token) {
                    report(error);
                }
            } finally {
                if (generation.current === token) {
                    setBusy(false);
                }
            }
        })();
        return () => {
            ++generation.current;
            controller.abort();
            scan.current?.abort();
        };
    }, [begin, report, showFolder, supported]);

    const refresh = useCallback(
        async (preferredName?: string) => {
            const handle = directory.current;
            if (!handle) {
                setNotice({ error: true, message: 'Choose your Guitar Pro Tabs folder first.' });
                return;
            }
            const { token, controller } = begin();
            setNotice(null);
            try {
                await showFolder(handle, token, controller.signal, preferredName);
            } catch (error) {
                if (generation.current === token) {
                    report(error);
                }
            } finally {
                if (generation.current === token) {
                    setBusy(false);
                }
            }
        },
        [begin, report, showFolder]
    );

    const choose = useCallback(async () => {
        const { token, controller } = begin();
        setNotice(null);
        try {
            const handle = await chooseLibraryDirectory();
            if (generation.current !== token) {
                return;
            }
            directory.current = handle;
            setName(handle.name);
            await showFolder(handle, token, controller.signal);
            if (generation.current !== token) {
                return;
            }
            try {
                await rememberDirectory(handle);
            } catch (error) {
                if (generation.current === token) {
                    setNotice({
                        error: true,
                        message: `The folder is connected for this page, but could not be remembered: ${
                            error instanceof Error ? error.message : String(error)
                        }`
                    });
                }
            }
        } catch (error) {
            if (generation.current === token) {
                if (isNamedError(error, 'AbortError')) {
                    setNotice({ error: false, message: 'Folder selection was canceled or not allowed.' });
                } else {
                    report(error);
                }
            }
        } finally {
            if (generation.current === token) {
                setBusy(false);
            }
        }
    }, [begin, report, showFolder]);

    const authorize = useCallback(async (): Promise<LibraryDirectoryHandle> => {
        const handle = directory.current;
        if (!handle) {
            throw new Error('Choose your Music\\Guitar Pro Tabs folder first, or turn off automatic saving.');
        }
        await authorizeLibrary(handle);
        if (directory.current !== handle) {
            throw new Error('The selected folder changed. Please try again.');
        }
        setReady(true);
        return handle;
    }, []);

    const reconnect = useCallback(async () => {
        try {
            await authorize();
            await refresh();
        } catch (error) {
            report(error);
        }
    }, [authorize, refresh, report]);

    const disconnect = useCallback(async () => {
        ++generation.current;
        scan.current?.abort();
        directory.current = null;
        setName(null);
        setReady(false);
        setBusy(false);
        setFiles([]);
        setSelectedName('');
        setNotice(null);
        try {
            await rememberDirectory(null);
        } catch (error) {
            setNotice({
                error: true,
                message: `The folder is disconnected for this page, but the saved selection could not be removed: ${
                    error instanceof Error ? error.message : String(error)
                }`
            });
        }
    }, []);

    return {
        supported,
        name,
        ready,
        busy,
        files,
        selectedName,
        setSelectedName,
        notice,
        choose,
        reconnect,
        disconnect,
        authorize,
        refresh
    };
}

export type ScoreLibraryController = ReturnType<typeof useScoreLibrary>;

export function ScoreLibraryPanel({
    library,
    onOpenFile,
    onBeforeChange
}: {
    library: ScoreLibraryController;
    onOpenFile: (handle: FileSystemFileHandle) => Promise<void>;
    onBeforeChange: () => void;
}) {
    const id = useId();
    const [openError, setOpenError] = useState<string | null>(null);
    const open = async () => {
        const entry = library.files.find(file => file.name === library.selectedName);
        if (!entry) {
            setOpenError('Choose a score from the folder first.');
            return;
        }
        setOpenError(null);
        try {
            await onOpenFile(entry.handle);
        } catch (error) {
            setOpenError(error instanceof Error ? error.message : 'The selected score could not be opened.');
        }
    };
    return (
        <section className={styles.panel} aria-label="Score library">
            {library.supported ? (
                <>
                    <div className={styles.row}>
                        <label htmlFor={`${id}-files`} className={styles.libraryLabel}>
                            {library.name ?? 'Guitar Pro Tabs library'}
                        </label>
                        <select
                            id={`${id}-files`}
                            aria-label="Scores in connected folder"
                            value={library.selectedName}
                            onChange={event => {
                                library.setSelectedName(event.target.value);
                                setOpenError(null);
                            }}
                            disabled={!library.ready || library.busy}>
                            <option value="">{library.busy ? 'Reading folder...' : 'Choose a score'}</option>
                            {library.files.map(file => (
                                <option key={file.name} value={file.name}>
                                    {file.name}
                                </option>
                            ))}
                        </select>
                        <button
                            type="button"
                            onClick={() => {
                                void open();
                            }}
                            disabled={!library.ready || !library.selectedName || library.busy}>
                            Open
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                void library.refresh();
                            }}
                            disabled={!library.ready || library.busy}>
                            Refresh
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                onBeforeChange();
                                void library.choose();
                            }}
                            disabled={library.busy}>
                            {library.name ? 'Change folder' : 'Choose folder'}
                        </button>
                        {library.name && !library.ready && (
                            <button
                                type="button"
                                onClick={() => {
                                    onBeforeChange();
                                    void library.reconnect();
                                }}
                                disabled={library.busy}>
                                Reconnect
                            </button>
                        )}
                        {library.name && (
                            <button
                                type="button"
                                onClick={() => {
                                    onBeforeChange();
                                    void library.disconnect();
                                }}>
                                Disconnect
                            </button>
                        )}
                    </div>
                    <p className={styles.help}>
                        {library.ready
                            ? `${library.files.length} supported ${library.files.length === 1 ? 'score' : 'scores'} in this folder. Refresh after adding files.`
                            : 'Choose Music\\Guitar Pro Tabs and allow browser access. The selection is remembered; permission may need reconnection later.'}{' '}
                        Your folder and its files are not sent to the local server.
                    </p>
                </>
            ) : (
                <p className={styles.help}>
                    Folder browsing and automatic saving require a browser with File System Access support, such as
                    Chrome or Edge. Open File and drag-and-drop remain available.
                </p>
            )}
            {library.notice && (
                <p
                    role={library.notice.error ? 'alert' : 'status'}
                    className={library.notice.error ? styles.error : styles.notice}>
                    {library.notice.message}
                </p>
            )}
            {openError && (
                <p role="alert" className={styles.error}>
                    {openError}
                </p>
            )}
        </section>
    );
}
