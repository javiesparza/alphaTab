import { isScoreFileName } from '../player/score-file-types';
import { isRecord } from '../songsterr/shared';

export interface LibraryDirectoryHandle extends FileSystemDirectoryHandle {
    queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
    requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
}

export interface LibraryEntry {
    name: string;
    handle: FileSystemFileHandle;
}

export function folderAccessSupported(): boolean {
    return typeof window !== 'undefined' && typeof Reflect.get(window, 'showDirectoryPicker') === 'function';
}

function isDirectoryHandle(value: unknown): value is LibraryDirectoryHandle {
    return (
        isRecord(value) &&
        value.kind === 'directory' &&
        typeof value.name === 'string' &&
        typeof value.values === 'function' &&
        typeof value.getFileHandle === 'function' &&
        typeof value.removeEntry === 'function' &&
        typeof value.queryPermission === 'function' &&
        typeof value.requestPermission === 'function'
    );
}

export function isNamedError(error: unknown, name: string): boolean {
    return isRecord(error) && error.name === name;
}

export async function chooseLibraryDirectory(): Promise<LibraryDirectoryHandle> {
    const picker: unknown = Reflect.get(window, 'showDirectoryPicker');
    if (typeof picker !== 'function') {
        throw new Error(
            'This browser does not support folder access. Use Open File, or open the player in Chrome or Edge.'
        );
    }
    const directory: unknown = await picker.call(window, {
        id: 'alphatab-guitar-pro-library',
        mode: 'readwrite',
        startIn: 'music'
    });
    if (!isDirectoryHandle(directory)) {
        throw new Error('The browser did not return a usable folder handle.');
    }
    return directory;
}

export async function authorizeLibrary(directory: LibraryDirectoryHandle): Promise<void> {
    if ((await directory.queryPermission({ mode: 'readwrite' })) === 'granted') {
        return;
    }
    if ((await directory.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        throw new Error(
            'Folder permission was not granted. Reconnect the folder before saving or browsing its scores.'
        );
    }
}

export async function listLibraryScores(
    directory: LibraryDirectoryHandle,
    signal?: AbortSignal
): Promise<LibraryEntry[]> {
    signal?.throwIfAborted();
    const files = new Map<string, LibraryEntry>();
    for await (const entry of directory.values()) {
        signal?.throwIfAborted();
        if (entry.kind === 'file' && isScoreFileName(entry.name)) {
            files.set(entry.name, { name: entry.name, handle: entry });
        }
    }
    return [...files.values()].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    );
}

const DATABASE = 'alphatab-control-library';
const STORE = 'handles';
const KEY = 'score-folder';

function openBookmarks(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') {
        return Promise.reject(new Error('Folder selection cannot be remembered in this browser.'));
    }
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        let failed = false;
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE)) {
                request.result.createObjectStore(STORE);
            }
        };
        request.onblocked = () => {
            failed = true;
            reject(new Error('Folder storage is blocked by another tab. Close that tab and reconnect the folder.'));
        };
        request.onerror = () => {
            failed = true;
            reject(request.error ?? new Error('Folder storage could not be opened.'));
        };
        request.onsuccess = () => {
            if (failed) {
                request.result.close();
            } else {
                resolve(request.result);
            }
        };
    });
}

async function bookmarkTransaction<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
    const database = await openBookmarks();
    try {
        return await new Promise<T>((resolve, reject) => {
            const transaction = database.transaction(STORE, mode);
            const request = operation(transaction.objectStore(STORE));
            transaction.oncomplete = () => resolve(request.result);
            transaction.onabort = () =>
                reject(transaction.error ?? request.error ?? new Error('The folder selection could not be stored.'));
            transaction.onerror = () =>
                reject(transaction.error ?? request.error ?? new Error('Folder storage failed.'));
        });
    } finally {
        database.close();
    }
}

export async function loadRememberedDirectory(): Promise<LibraryDirectoryHandle | null> {
    const value: unknown = await bookmarkTransaction('readonly', store => store.get(KEY));
    if (value === undefined) {
        return null;
    }
    if (!isDirectoryHandle(value)) {
        throw new Error('The saved folder selection is unavailable. Choose the folder again.');
    }
    return value;
}

export async function rememberDirectory(directory: LibraryDirectoryHandle | null): Promise<void> {
    if (directory) {
        await bookmarkTransaction('readwrite', store => store.put(directory, KEY));
    } else {
        await bookmarkTransaction('readwrite', store => store.delete(KEY));
    }
}

export function guitarProFileName(label: string): string {
    const clean = label.normalize('NFC').trim();
    let stem = '';
    const encoder = new TextEncoder();
    for (const original of clean) {
        const code = original.charCodeAt(0);
        const character =
            code < 32 ||
            code === 127 ||
            (code >= 0x2028 && code <= 0x202e) ||
            (code >= 0x2066 && code <= 0x2069) ||
            '<>:"/\\|?*'.includes(original)
                ? '_'
                : original;
        if (encoder.encode(stem + character).length > 120) {
            break;
        }
        stem += character;
    }
    stem = stem.replace(/^[. ]+|[. ]+$/g, '') || 'Songsterr score';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[. ]|$)/i.test(stem)) {
        stem = `_${stem}`;
    }
    return `${stem} - ${crypto.randomUUID()}.gp`;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function saveGuitarProFile(
    directory: LibraryDirectoryHandle,
    bytes: Uint8Array<ArrayBuffer>,
    label: string,
    signal: AbortSignal
): Promise<File> {
    signal.throwIfAborted();
    if (bytes.length < 4 || bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4) {
        throw new Error('No Guitar Pro archive was returned. Nothing was saved.');
    }
    if ((await directory.queryPermission({ mode: 'readwrite' })) !== 'granted') {
        throw new Error('Folder permission expired. Reconnect the folder and try again; nothing was saved.');
    }
    const expectedHash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let handle: FileSystemFileHandle | undefined;
    let initial: File | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
        signal.throwIfAborted();
        const name = guitarProFileName(label);
        try {
            await directory.getFileHandle(name);
            continue;
        } catch (error) {
            if (isNamedError(error, 'TypeMismatchError')) {
                continue;
            }
            if (!isNamedError(error, 'NotFoundError')) {
                throw error;
            }
        }
        const candidate = await directory.getFileHandle(name, { create: true });
        if (candidate.name !== name) {
            throw new Error('The browser returned an unexpected file name. No file was written.');
        }
        let file: File;
        try {
            file = await candidate.getFile();
        } catch (error) {
            throw new Error(`The new file "${name}" could not be verified and may remain in "${directory.name}".`, {
                cause: error
            });
        }
        if (file.size !== 0) {
            continue;
        }
        handle = candidate;
        initial = file;
        break;
    }
    if (!handle || !initial) {
        throw new Error('A new file name could not be reserved. Existing files were not overwritten.');
    }

    let writer: WritableStreamDefaultWriter<FileSystemWriteChunkType> | undefined;
    let committed = false;
    let committing = false;
    let abortAttempt: Promise<void> | undefined;
    let abortFailure: unknown;
    const onAbort = () => {
        if (writer && !committing) {
            abortAttempt = writer.abort(signal.reason).catch(error => {
                abortFailure = error;
            });
        }
    };
    try {
        // A unique name avoids replacement; an exclusive swap-file writer commits only on close.
        const options = { keepExistingData: false, mode: 'exclusive' };
        const stream = await handle.createWritable(options);
        writer = stream.getWriter();
        signal.addEventListener('abort', onAbort, { once: true });
        signal.throwIfAborted();
        await writer.write(bytes);
        signal.throwIfAborted();
        committing = true;
        signal.removeEventListener('abort', onAbort);
        await writer.close();
        committed = true;
        const file = await handle.getFile();
        if (file.size !== bytes.length) {
            throw new Error(`Saved file "${file.name}" could not be verified. It was kept for inspection.`);
        }
        const actualHash = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
        if (!actualHash.every((value, index) => value === expectedHash[index])) {
            throw new Error(`Saved file "${file.name}" could not be verified. It was kept for inspection.`);
        }
        return file;
    } catch (error) {
        if (committed) {
            console.error('The saved score could not be verified.', error);
        }
        if (!committed) {
            if (writer && !abortAttempt) {
                abortAttempt = writer.abort(error).catch(failure => {
                    abortFailure = failure;
                });
            }
            await abortAttempt;
            if (abortFailure) {
                console.error('Could not abort the incomplete score write.', abortFailure);
            }
            try {
                const current = await handle.getFile();
                if (
                    current.size !== 0 ||
                    current.lastModified !== initial.lastModified ||
                    isNamedError(error, 'NoModificationAllowedError')
                ) {
                    throw new Error('The new file changed or is in use; it was not removed.');
                }
                await directory.removeEntry(handle.name);
            } catch (cleanupError) {
                console.error('Could not remove the incomplete score file.', cleanupError);
                throw new Error(
                    `${describeError(error)} An incomplete file named "${handle.name}" may remain in "${directory.name}".`,
                    { cause: error }
                );
            }
        }
        throw error;
    } finally {
        signal.removeEventListener('abort', onAbort);
        writer?.releaseLock();
    }
}
